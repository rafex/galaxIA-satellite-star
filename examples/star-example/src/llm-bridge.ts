import type {
  GenerateRequest,
  GenerateResponse,
  LlmMessage,
  ToolCall,
} from "@rafex/galaxia-fhs-protocol";
import { tryParseWithCatalog } from "./parser-profiles.js";

interface LlamaChoice {
  message?: LlmMessage;
  finish_reason?: string;
}

export interface LlmTimeouts {
  /**
   * Espera máxima hasta el primer byte de la respuesta. Incluye leer el
   * prompt, que en CPU viejo es lo lento (~16 tok/s en un i7 de 3ª gen: un
   * contexto RAG de 3000 tokens son ~3 min antes del primer token).
   */
  firstTokenMs: number;
  /** Silencio máximo entre fragmentos una vez que empezó a generar. */
  idleMs: number;
}

export const DEFAULT_LLM_TIMEOUTS: LlmTimeouts = { firstTokenMs: 300_000, idleMs: 60_000 };

interface StreamedToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export class LlmBridge {
  private llamaCppUrl: string;
  private timeouts: LlmTimeouts;

  constructor(llamaCppUrl: string, timeouts: LlmTimeouts = DEFAULT_LLM_TIMEOUTS) {
    this.llamaCppUrl = llamaCppUrl.replace(/\/$/, "");
    this.timeouts = timeouts;
  }

  async generate(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    const url = `${this.llamaCppUrl}/chat/completions`;
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      stream: false,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens,
    });

    const response = await this.post(url, body, signal);
    const data = JSON.parse(await response.text()) as {
      choices: LlamaChoice[];
    };

    const choice = data.choices[0];
    const message = choice?.message || {
      role: "assistant" as const,
      content: "",
    };
    let toolCalls = message.tool_calls || [];

    // Fallback: algunos modelos/templates de llama-server (ej. Qwen2.5 vía --jinja
    // en versiones que no soportan el parser nativo de tool_calls) devuelven la
    // llamada a la tool como JSON plano en `content` en vez de llenar `tool_calls`.
    // Sin este fallback, `toolCalls` queda vacío y el runtime nunca ejecuta la tool
    // aunque el modelo sí haya decidido usarla. El parseo tolerante ya no es
    // hardcodeado por modelo: usa el catálogo comunitario de perfiles
    // (SPEC-PARSER-0001/DEC-0050, https://github.com/rafex/galaxia-parser-catalog).
    if (toolCalls.length === 0 && request.tools?.length && message.content) {
      const parsed = tryParseWithCatalog(
        request.model || "unknown",
        message.content,
        request.tools
      );
      if (parsed) {
        toolCalls = [parsed];
        message.tool_calls = toolCalls;
        // Bug real encontrado probando el loop de Nova (nova-example) contra
        // hardware real (DEC-0055): dejar el JSON crudo en `content` además
        // de en `tool_calls` deja ese texto en el historial como si fuera
        // respuesta normal del asistente. Inofensivo en una sola llamada
        // (Star nunca relee su propio turno), pero corrompe cualquier
        // contexto de varias rondas — se corrige aquí también por
        // consistencia, aunque star-example no lo dispare hoy.
        message.content = "";
      }
    }

    return {
      message,
      toolCalls,
      model: request.model || "unknown",
      provider: "star-fhs",
    };
  }

  async *stream(
    request: GenerateRequest,
    signal?: AbortSignal
  ): AsyncGenerator<string, GenerateResponse, unknown> {
    const url = `${this.llamaCppUrl}/chat/completions`;
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      stream: true,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens,
    });

    // Streaming real: cada fragmento SSE se entrega en cuanto llega. Antes
    // curl bufferizaba la respuesta completa y los deltas salían todos al
    // final, así que el usuario no veía nada hasta que el LLM terminaba.
    const response = await this.post(url, body, signal);
    if (!response.body) throw new Error("llama.cpp respondió sin cuerpo");

    let fullContent = "";
    // Los tool_calls llegan en pedazos por índice (el nombre en uno, los
    // argumentos repartidos en varios); antes se quedaba solo el último.
    const partialCalls = new Map<number, StreamedToolCall>();
    let pending = "";
    const decoder = new TextDecoder();

    for await (const bytes of response.body as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === "[DONE]") continue;

        let parsed: {
          choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<StreamedToolCall & { index?: number }> } }>;
        };
        try {
          parsed = JSON.parse(dataStr) as typeof parsed;
        } catch {
          continue; // chunk SSE malformado
        }
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) {
          fullContent += delta.content;
          yield delta.content;
        }
        for (const piece of delta?.tool_calls ?? []) {
          const index = piece.index ?? 0;
          const call = partialCalls.get(index) ?? { function: { name: "", arguments: "" } };
          if (piece.id) call.id = piece.id;
          if (piece.type) call.type = piece.type;
          if (piece.function?.name) call.function!.name = piece.function.name;
          if (piece.function?.arguments) call.function!.arguments += piece.function.arguments;
          partialCalls.set(index, call);
        }
      }
    }

    const toolCalls: ToolCall[] | undefined = partialCalls.size > 0
      ? [...partialCalls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => ({
          id: call.id ?? `call_${index}`,
          type: "function",
          function: { name: call.function?.name ?? "", arguments: call.function?.arguments || "{}" },
        }))
      : undefined;

    return {
      message: {
        role: "assistant",
        content: fullContent,
        tool_calls: toolCalls,
      },
      toolCalls: toolCalls || [],
      model: request.model || "unknown",
      provider: "star-fhs",
    };
  }

  /**
   * POST a llama-server con dos plazos: hasta el primer byte (lectura del
   * prompt) y de silencio entre fragmentos. Un plazo total fijo (antes 300 s
   * con curl) corta respuestas largas que sí avanzan y no distingue "el LLM
   * está trabado" de "el LLM es lento pero va".
   */
  private async post(url: string, body: string, signal?: AbortSignal): Promise<Response> {
    const timeout = new AbortController();
    let reason = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, why: string): void => {
      if (timer) clearTimeout(timer);
      reason = why;
      timer = setTimeout(() => timeout.abort(new Error(reason)), ms);
    };
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const firstSeconds = Math.round(this.timeouts.firstTokenMs / 1_000);
    arm(this.timeouts.firstTokenMs, `llama.cpp no empezó a responder en ${firstSeconds} s (¿modelo trabado o prompt demasiado largo para este hardware?)`);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: combined,
      });
    } catch (error: unknown) {
      if (timer) clearTimeout(timer);
      throw this.describe(error, signal, timeout.signal, url);
    }
    if (!response.ok) {
      if (timer) clearTimeout(timer);
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`llama.cpp respondió HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    if (!response.body) {
      if (timer) clearTimeout(timer);
      return response;
    }

    // Reenvía el cuerpo reiniciando el plazo de silencio con cada fragmento.
    const idleMs = this.timeouts.idleMs;
    const idleSeconds = Math.round(idleMs / 1_000);
    const source = response.body.getReader();
    const describe = (error: unknown): Error => this.describe(error, signal, timeout.signal, url);
    const guarded = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await source.read();
          if (done) {
            if (timer) clearTimeout(timer);
            controller.close();
            return;
          }
          arm(idleMs, `llama.cpp dejó de enviar datos durante ${idleSeconds} s`);
          controller.enqueue(value);
        } catch (error: unknown) {
          if (timer) clearTimeout(timer);
          controller.error(describe(error));
        }
      },
      cancel(cause) {
        if (timer) clearTimeout(timer);
        return source.cancel(cause);
      },
    });
    return new Response(guarded, { status: response.status, headers: response.headers });
  }

  private describe(error: unknown, external: AbortSignal | undefined, timeout: AbortSignal, url: string): Error {
    // Cancelación pedida por el caller: se preserva AbortError para que
    // distinga cancelar de fallar.
    if (external?.aborted) {
      const abort = new Error("solicitud cancelada");
      abort.name = "AbortError";
      return abort;
    }
    if (timeout.aborted) return timeout.reason instanceof Error ? timeout.reason : new Error(String(timeout.reason));
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
    return new Error(`llama.cpp no disponible en ${url}: ${message}${cause}`);
  }
}

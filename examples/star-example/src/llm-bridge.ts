import { execFile } from "node:child_process";
import type {
  GenerateRequest,
  GenerateResponse,
  LlmMessage,
  ToolCall,
} from "@galaxia/fhs-protocol";

interface LlamaChoice {
  message?: LlmMessage;
  finish_reason?: string;
}

/**
 * Intenta reconocer una llamada a tool escrita como JSON plano en el texto de
 * respuesta, con forma `{"name": "...", "arguments": {...}}`. Solo se acepta
 * si el nombre coincide con una de las tools que realmente se ofrecieron en
 * la petición — evita falsos positivos con contenido conversacional normal
 * que por casualidad se parsea como JSON.
 */
function tryParseFallbackToolCall(
  content: string,
  requestedTools: NonNullable<GenerateRequest["tools"]>
): ToolCall | null {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  if (!trimmed.startsWith("{")) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const name = parsed?.name;
  if (typeof name !== "string") return null;

  const knownNames = new Set(requestedTools.map((t) => t.function.name));
  if (!knownNames.has(name)) return null;

  const args = parsed.arguments ?? {};

  return {
    id: `fallback_${Date.now()}`,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  };
}

export class LlmBridge {
  private llamaCppUrl: string;

  constructor(llamaCppUrl: string) {
    this.llamaCppUrl = llamaCppUrl.replace(/\/$/, "");
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const url = `${this.llamaCppUrl}/chat/completions`;
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      stream: false,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens,
    });

    const stdout = await this.curlPost(url, body);

    const data = JSON.parse(stdout) as {
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
    // aunque el modelo sí haya decidido usarla.
    if (toolCalls.length === 0 && request.tools?.length && message.content) {
      const parsed = tryParseFallbackToolCall(message.content, request.tools);
      if (parsed) {
        toolCalls = [parsed];
        message.tool_calls = toolCalls;
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
    request: GenerateRequest
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

    const stdout = await this.curlPost(url, body);

    const lines = stdout.split("\n");
    let fullContent = "";
    let toolCalls: ToolCall[] | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const dataStr = trimmed.slice(6);
      if (dataStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(dataStr) as {
          choices: Array<{
            delta: Partial<LlmMessage>;
            finish_reason: string | null;
          }>;
        };
        const delta = parsed.choices[0]?.delta;
        if (delta?.content) {
          fullContent += delta.content;
          yield delta.content;
        }
        if (delta?.tool_calls) {
          toolCalls = delta.tool_calls as ToolCall[];
        }
      } catch {
        // ignorar chunks SSE malformados
      }
    }

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

  private curlPost(url: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
      "curl",
      [
        "-sfS",
        "--max-time", "300",
        "-X", "POST",
        url,
        "-H", "Content-Type: application/json",
        "-d", body,
      ],
      {
        timeout: 310_000,
        maxBuffer: 16 * 1024 * 1024,
      },
        (err, stdout, stderr) => {
          if (err) {
            reject(
              new Error(
                `llama.cpp request failed: ${err.message}${stderr ? ` — ${stderr.slice(0, 200)}` : ""}`
              )
            );
            return;
          }
          resolve(stdout);
        }
      );

      child.on("error", reject);
    });
  }
}

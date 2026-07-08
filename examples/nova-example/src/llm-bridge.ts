import { execFile } from "node:child_process";
import type {
  GenerateRequest,
  GenerateResponse,
  LlmMessage,
} from "@rafex/galaxia-fhs-protocol";
import { tryParseWithCatalog } from "./parser-profiles.js";

interface LlamaChoice {
  message?: LlmMessage;
  finish_reason?: string;
}

/**
 * Cliente hacia llama-server — usado por cada ronda del loop de razonamiento
 * (`ReasoningLoop`). Idéntico al de `star-example`: el parseo tolerante
 * (DEC-0050) protege cada llamada individual, sin importar si la llamada es
 * la única (Star) o una de varias (Nova, DEC-0055).
 */
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

    if (toolCalls.length === 0 && request.tools?.length && message.content) {
      const parsed = tryParseWithCatalog(
        request.model || "unknown",
        message.content,
        request.tools
      );
      if (parsed) {
        toolCalls = [parsed];
        message.tool_calls = toolCalls;
        // Bug real encontrado probando el loop de Nova contra hardware real
        // (DEC-0055): dejar el JSON crudo en `content` además de en
        // `tool_calls` hace que ese texto quede en el historial como si
        // fuera una respuesta normal del asistente. En una sola llamada
        // (Star) es inofensivo porque nadie vuelve a leer ese turno; en un
        // loop (Nova) el turno siguiente sí lo relee, y el modelo tiende a
        // repetir/ecoar ese mismo JSON en vez de avanzar — se observó el
        // mismo tool call idéntico 3 veces seguidas sin esto.
        message.content = "";
      }
    }

    return {
      message,
      toolCalls,
      model: request.model || "unknown",
      provider: "nova-fhs",
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

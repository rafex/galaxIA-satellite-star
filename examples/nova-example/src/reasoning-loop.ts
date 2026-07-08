import type {
  GenerateRequest,
  GenerateResponse,
  LlmMessage,
  ToolDefinition,
} from "@rafex/galaxia-fhs-protocol";
import { LlmBridge } from "./llm-bridge.js";
import { evaluateExpression } from "./calculator.js";

/**
 * Loop de razonamiento acotado (SPEC-NOVA-0001, DEC-0055) — lo que
 * distingue a un Nova de un Star. Motor mínimo de referencia (DEC-0026,
 * no una recomendación): una sola tool de ejemplo (calculadora) para poder
 * probar el loop de punta a punta sin depender de otros providers FHS.
 *
 * Cada ronda reutiliza `LlmBridge.generate()` sin cambios — el parser
 * tolerante (DEC-0050) protege cada ronda igual que protegería la única
 * llamada de un Star. El riesgo de DEC-0016/DEC-0017 no desaparece por
 * tener varias rondas: sigue presente en cada una, por eso cada ronda pasa
 * por el mismo blindaje, nunca uno más débil "porque ya es la segunda vez".
 */

const CALCULATE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "calculate",
    description: "Evalúa una expresión aritmética (+ - * / paréntesis). Úsala para cualquier cálculo, no lo hagas de memoria.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: 'Ej. "(12 + 8) * 3"' },
      },
      required: ["expression"],
    },
  },
};

export class ReasoningLoop {
  constructor(
    private bridge: LlmBridge,
    /** Techo declarado por este Nova en su manifiesto (`reasoning.maxSteps`) — nunca se excede aunque lo pidan. */
    private hardMaxSteps: number
  ) {}

  async run(request: GenerateRequest): Promise<GenerateResponse> {
    // `maxReasoningSteps` es una sugerencia de quien pide (DEC-0055) — el
    // techo real de este Nova siempre gana si piden más de lo que soporta.
    const maxSteps = Math.max(1, Math.min(request.maxReasoningSteps ?? this.hardMaxSteps, this.hardMaxSteps));
    const messages: LlmMessage[] = [...request.messages];
    const tools = [...(request.tools || []), CALCULATE_TOOL];

    let lastResponse: GenerateResponse | null = null;

    for (let step = 1; step <= maxSteps; step++) {
      const response = await this.bridge.generate({ ...request, messages, tools });
      lastResponse = response;
      messages.push(response.message);

      if (response.toolCalls.length === 0) {
        // El modelo ya respondió sin pedir más herramientas — fin del loop,
        // no seguir gastando rondas que no pidió.
        return { ...response, reasoningSteps: step };
      }

      for (const call of response.toolCalls) {
        messages.push(this.executeToolCall(call));
      }

      if (step === maxSteps) {
        // Se acabó el presupuesto de pasos y el modelo seguía pidiendo
        // herramientas — una última llamada sin tools, para no dejar la
        // conversación colgada en una tool call sin respuesta final.
        const final = await this.bridge.generate({ ...request, messages, tools: undefined });
        return { ...final, reasoningSteps: step };
      }
    }

    // Inalcanzable en la práctica (maxSteps >= 1 siempre entra al loop al
    // menos una vez), pero TypeScript necesita un retorno exhaustivo.
    return { ...(lastResponse as GenerateResponse), reasoningSteps: maxSteps };
  }

  private executeToolCall(call: { id: string; function: { name: string; arguments: string } }): LlmMessage {
    if (call.function.name === "calculate") {
      let args: any = {};
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        // argumentos malformados — degradar a mensaje de error de tool,
        // nunca lanzar y romper el loop completo por un solo paso fallido.
      }
      const result = evaluateExpression(String(args.expression ?? ""));
      return { role: "tool", tool_call_id: call.id, name: "calculate", content: result };
    }
    return {
      role: "tool",
      tool_call_id: call.id,
      name: call.function.name,
      content: `Tool "${call.function.name}" no soportada por este Nova de referencia.`,
    };
  }
}

import type {
  FhsProto,
  LlmMessage,
  ToolCall,
  ToolDefinition,
  ToolParameterSchema,
} from "@rafex/galaxia-fhs-protocol";
import { dynamicValueToJson } from "@galaxia/fhs-wire";

// Conversión Protobuf FHS → formato OpenAI de llama-server.
//
// Antes se pasaban los objetos protobuf-es tal cual y JSON.stringify los
// serializaba con sus campos internos ("$typeName": "fhs.v1.Message") y con
// valores vacíos que en OpenAI significan otra cosa (toolCallId: "",
// toolCalls: []). llama-server los toleraba, pero no son parte del contrato.

const LLM_ROLES = new Set<LlmMessage["role"]>(["system", "user", "assistant", "tool"]);

export function toLlmMessages(messages: FhsProto.Message[]): LlmMessage[] {
  return messages.map((message, index) => {
    if (!LLM_ROLES.has(message.role as LlmMessage["role"])) {
      throw new Error(`mensaje ${index} con rol no soportado por el LLM: "${message.role}"`);
    }
    const out: LlmMessage = { role: message.role as LlmMessage["role"], content: message.content };
    if (message.toolCallId) out.tool_call_id = message.toolCallId;
    if (message.toolCalls.length > 0) out.tool_calls = message.toolCalls.map(toLlmToolCall);
    return out;
  });
}

export function toLlmTools(tools: FhsProto.ToolDefinition[]): ToolDefinition[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: toParameterSchema(tool.inputSchema),
    },
  }));
}

function toLlmToolCall(call: FhsProto.ToolCall): ToolCall {
  // OpenAI espera los argumentos como texto JSON, no como objeto.
  const args = dynamicValueToJson(call.function?.arguments);
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.function?.name ?? "",
      arguments: JSON.stringify(args ?? {}),
    },
  };
}

function toParameterSchema(schema: FhsProto.ToolInputSchema | undefined): ToolParameterSchema {
  if (!schema) return { type: "object", properties: {} };
  return toJsonSchema(schema) as unknown as ToolParameterSchema;
}

function toJsonSchema(schema: FhsProto.ToolInputSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: schema.type || "object" };
  if (schema.description) out.description = schema.description;
  const properties = Object.entries(schema.properties);
  if (properties.length > 0 || out.type === "object") {
    out.properties = Object.fromEntries(properties.map(([key, value]) => [key, toJsonSchema(value)]));
  }
  if (schema.required.length > 0) out.required = [...schema.required];
  if (schema.enumValues.length > 0) out.enum = [...schema.enumValues];
  return out;
}

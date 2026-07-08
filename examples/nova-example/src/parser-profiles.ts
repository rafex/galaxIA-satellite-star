import { createHash } from "node:crypto";
import type { GenerateRequest, ToolCall } from "@rafex/galaxia-fhs-protocol";

/**
 * Copia local mínima de un perfil del catálogo comunitario
 * (https://github.com/rafex/galaxia-parser-catalog, SPEC-PARSER-0001,
 * DEC-0050 en galaxIA). Un Nova necesita esto en cada ronda de su loop
 * interno igual que un Star lo necesita en su única llamada — el riesgo de
 * DEC-0016/DEC-0017 no desaparece por tener varias rondas, sigue presente
 * en cada una (DEC-0055).
 */
interface ParserProfile {
  id: string;
  modelPattern: string;
  strategy: string;
  rule: Record<string, unknown>;
}

const LOCAL_PROFILES: ParserProfile[] = [
  {
    id: "jinja-plain-json-toolcall-fallback-v1",
    modelPattern: "^qwen2\\.5-coder.*$",
    strategy: "plain-json-in-content",
    rule: {
      stripCodeFences: true,
      mustStartWith: "{",
      validateNameAgainst: "requestedTools[].function.name",
    },
  },
];

function matchProfile(modelId: string): ParserProfile | null {
  return LOCAL_PROFILES.find((p) => new RegExp(p.modelPattern).test(modelId)) ?? null;
}

function applyPlainJsonInContent(
  content: string,
  rule: Record<string, unknown>,
  requestedTools: NonNullable<GenerateRequest["tools"]>
): ToolCall | null {
  let trimmed = content.trim();
  if (rule.stripCodeFences) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }
  const mustStartWith = typeof rule.mustStartWith === "string" ? rule.mustStartWith : "{";
  if (!trimmed.startsWith(mustStartWith)) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const name = parsed?.name;
  if (typeof name !== "string") return null;

  if (rule.validateNameAgainst === "requestedTools[].function.name") {
    const known = new Set(requestedTools.map((t) => t.function.name));
    if (!known.has(name)) return null;
  }

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

const strategies: Record<string, typeof applyPlainJsonInContent> = {
  "plain-json-in-content": applyPlainJsonInContent,
};

function recordParseAttempt(entry: {
  modelId: string;
  parserId: string | null;
  matched: boolean;
  content: string;
}) {
  console.log(
    JSON.stringify({
      level: "trace",
      at: new Date().toISOString(),
      type: "parser_attempt",
      modelId: entry.modelId,
      parserId: entry.parserId,
      matched: entry.matched,
      // Nunca el contenido crudo (puede derivar de una pregunta de usuario) —
      // solo un hash, misma disciplina de retención que DEC-0013/DEC-0025.
      contentHash: createHash("sha256").update(entry.content).digest("hex"),
    })
  );
}

/**
 * Intenta reconocer una tool call escrita como texto plano en `content`
 * usando el perfil catalogado que coincida con `modelId` (fallback conocido
 * de comunidad para modelos como qwen2.5-coder-3b-instruct vía --jinja,
 * DEC-0016/DEC-0017/DEC-0050).
 */
export function tryParseWithCatalog(
  modelId: string,
  content: string,
  requestedTools: NonNullable<GenerateRequest["tools"]>
): ToolCall | null {
  const profile = matchProfile(modelId);
  if (!profile) {
    recordParseAttempt({ modelId, parserId: null, matched: false, content });
    return null;
  }

  const strategyFn = strategies[profile.strategy];
  const parsed = strategyFn ? strategyFn(content, profile.rule, requestedTools) : null;
  recordParseAttempt({ modelId, parserId: profile.id, matched: !!parsed, content });
  return parsed;
}

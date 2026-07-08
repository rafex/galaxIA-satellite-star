/**
 * Tool de ejemplo mínima para probar el loop de razonamiento (SPEC-NOVA-0001)
 * de punta a punta sin depender de otros providers FHS corriendo. Evaluador
 * recursivo-descendente propio — nunca `eval`/`Function` sobre texto que
 * viene de un LLM.
 */

export function evaluateExpression(expression: string): string {
  try {
    const tokens = tokenize(expression);
    const { value, rest } = parseExpression(tokens);
    if (rest.length > 0) throw new Error(`Token inesperado: ${rest[0]}`);
    return String(value);
  } catch (err: any) {
    return `Error evaluando "${expression}": ${err.message}`;
  }
}

function tokenize(expression: string): string[] {
  const matches = expression.match(/\d+(\.\d+)?|[+\-*/()]/g);
  if (!matches) throw new Error("expresión vacía o inválida");
  return matches;
}

function parseExpression(tokens: string[]): { value: number; rest: string[] } {
  let { value, rest } = parseTerm(tokens);
  while (rest[0] === "+" || rest[0] === "-") {
    const op = rest[0];
    const next = parseTerm(rest.slice(1));
    value = op === "+" ? value + next.value : value - next.value;
    rest = next.rest;
  }
  return { value, rest };
}

function parseTerm(tokens: string[]): { value: number; rest: string[] } {
  let { value, rest } = parseFactor(tokens);
  while (rest[0] === "*" || rest[0] === "/") {
    const op = rest[0];
    const next = parseFactor(rest.slice(1));
    if (op === "/" && next.value === 0) throw new Error("división por cero");
    value = op === "*" ? value * next.value : value / next.value;
    rest = next.rest;
  }
  return { value, rest };
}

function parseFactor(tokens: string[]): { value: number; rest: string[] } {
  const [first, ...rest] = tokens;
  if (first === undefined) throw new Error("expresión incompleta");
  if (first === "(") {
    const inner = parseExpression(rest);
    if (inner.rest[0] !== ")") throw new Error("falta paréntesis de cierre");
    return { value: inner.value, rest: inner.rest.slice(1) };
  }
  const num = Number(first);
  if (Number.isNaN(num)) throw new Error(`token no numérico: ${first}`);
  return { value: num, rest };
}

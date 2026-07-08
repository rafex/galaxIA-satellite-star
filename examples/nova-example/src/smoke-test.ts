/**
 * Prueba directa del loop de razonamiento contra un llama-server real
 * (SPEC-NOVA-0001) — sin pasar por Atlas/WebSocket, solo para validar el
 * mecanismo: ¿el loop llama la tool cuando hace falta, respeta el límite de
 * pasos, y reporta reasoningSteps correctamente?
 *
 * Uso: LLAMA_CPP_URL=http://localhost:43110/v1 npx tsx src/smoke-test.ts
 */
import { LlmBridge } from "./llm-bridge.js";
import { ReasoningLoop } from "./reasoning-loop.js";

const LLAMA_CPP_URL = process.env.LLAMA_CPP_URL || "http://localhost:43110/v1";
const MODEL_ID = process.env.MODEL_ID || "qwen2.5-coder-3b-instruct";

async function main() {
  const bridge = new LlmBridge(LLAMA_CPP_URL);
  const loop = new ReasoningLoop(bridge, 3);

  const cases = [
    {
      name: "requiere la tool de cálculo",
      question: "¿Cuánto es (37 + 15) * 2? Usa la herramienta de cálculo, no lo calcules de memoria.",
    },
    {
      name: "no requiere ninguna tool",
      question: "¿Qué es una galaxia, en una frase?",
    },
  ];

  for (const c of cases) {
    console.log(`\n=== Caso: ${c.name} ===`);
    console.log(`Pregunta: ${c.question}`);
    const start = Date.now();
    const response = await loop.run({
      model: MODEL_ID,
      messages: [
        { role: "system", content: "Eres un asistente útil. Responde en español, breve." },
        { role: "user", content: c.question },
      ],
    });
    console.log(`Tiempo: ${Date.now() - start}ms`);
    console.log(`reasoningSteps: ${response.reasoningSteps}`);
    console.log(`Respuesta: ${response.message.content}`);
  }
}

main().catch((err) => {
  console.error("Smoke test falló:", err);
  process.exit(1);
});

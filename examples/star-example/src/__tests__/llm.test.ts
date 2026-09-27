import { strict as assert } from "node:assert";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { FhsProto } from "@rafex/galaxia-fhs-protocol";
import { dynamicValueFromLocal } from "@galaxia/fhs-wire";
import { LlmBridge } from "../llm-bridge.js";
import { toLlmMessages, toLlmTools } from "../llm-request.js";

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const delta = (content: string): string => sse({ choices: [{ delta: { content } }] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Handler = (res: ServerResponse, body: string) => Promise<void> | void;

describe("toLlmMessages / toLlmTools", () => {
  it("no manda campos internos de protobuf ni valores vacíos", () => {
    const messages = [
      create(FhsProto.MessageSchema, { role: "system", content: "Responde en español." }),
      create(FhsProto.MessageSchema, { role: "user", content: "hola" }),
    ];
    const json = JSON.stringify(toLlmMessages(messages));
    assert.equal(json, '[{"role":"system","content":"Responde en español."},{"role":"user","content":"hola"}]');
    assert.equal(json.includes("$typeName"), false);
  });

  it("convierte tool calls y argumentos DynamicValue a texto JSON", () => {
    const [assistant] = toLlmMessages([
      create(FhsProto.MessageSchema, {
        role: "assistant",
        content: "",
        toolCalls: [create(FhsProto.ToolCallSchema, {
          id: "call_1",
          type: "function",
          function: create(FhsProto.ToolCallFunctionSchema, {
            name: "kb.query",
            arguments: dynamicValueFromLocal({ query: "reloj", topK: 2 }),
          }),
        })],
      }),
    ]);
    assert.deepEqual(assistant.tool_calls, [
      { id: "call_1", type: "function", function: { name: "kb.query", arguments: '{"query":"reloj","topK":2}' } },
    ]);
  });

  it("rechaza roles que el LLM no entiende", () => {
    assert.throws(() => toLlmMessages([create(FhsProto.MessageSchema, { role: "navigator", content: "x" })]), /rol no soportado/);
  });

  it("omite tools vacías y convierte el esquema de entrada a JSON Schema", () => {
    assert.equal(toLlmTools([]), undefined);
    const tools = toLlmTools([
      create(FhsProto.ToolDefinitionSchema, {
        name: "kb.query",
        description: "Busca en la base de conocimiento",
        inputSchema: create(FhsProto.ToolInputSchemaSchema, {
          type: "object",
          properties: { query: create(FhsProto.ToolInputSchemaSchema, { type: "string", description: "texto" }) },
          required: ["query"],
        }),
      }),
    ]);
    assert.deepEqual(tools, [{
      type: "function",
      function: {
        name: "kb.query",
        description: "Busca en la base de conocimiento",
        parameters: { type: "object", properties: { query: { type: "string", description: "texto" } }, required: ["query"] },
      },
    }]);
  });
});

describe("LlmBridge.stream contra un llama-server simulado", () => {
  let server: Server;
  let url = "";
  let handler: Handler = () => {};

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => { void handler(res, body); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const openStream = (res: ServerResponse) => res.writeHead(200, { "Content-Type": "text/event-stream" });

  it("entrega cada fragmento en cuanto llega, no al final", async () => {
    let finished = false;
    handler = async (res) => {
      openStream(res);
      res.write(delta("Hola"));
      await sleep(300);
      res.write(delta(", mundo"));
      res.end("data: [DONE]\n\n");
      finished = true;
    };
    const gen = new LlmBridge(url).stream({ messages: [{ role: "user", content: "hola" }] });
    const first = await gen.next();
    assert.equal(first.value, "Hola");
    assert.equal(finished, false, "el primer delta debe llegar antes de que el servidor termine");
    const rest: string[] = [];
    let step = await gen.next();
    while (!step.done) { rest.push(step.value); step = await gen.next(); }
    assert.deepEqual(rest, [", mundo"]);
    assert.equal(step.value.message.content, "Hola, mundo");
  });

  it("junta los tool_calls que llegan en pedazos", async () => {
    handler = (res) => {
      openStream(res);
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "kb.query", arguments: "" } }] } }] }));
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] }));
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"reloj"}' } }] } }] }));
      res.end("data: [DONE]\n\n");
    };
    const gen = new LlmBridge(url).stream({ messages: [{ role: "user", content: "x" }] });
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    assert.deepEqual(step.value.toolCalls, [
      { id: "call_9", type: "function", function: { name: "kb.query", arguments: '{"query":"reloj"}' } },
    ]);
  });

  it("corta con un mensaje claro si el LLM se queda callado a media respuesta", async () => {
    handler = (res) => {
      openStream(res);
      res.write(delta("empieza"));
      // y nunca termina
    };
    const gen = new LlmBridge(url, { firstTokenMs: 2_000, idleMs: 150 }).stream({ messages: [{ role: "user", content: "x" }] });
    assert.equal((await gen.next()).value, "empieza");
    await assert.rejects(gen.next(), /dejó de enviar datos durante/);
  });

  it("corta si el LLM no empieza a responder", async () => {
    handler = () => { /* nunca responde */ };
    const gen = new LlmBridge(url, { firstTokenMs: 150, idleMs: 5_000 }).stream({ messages: [{ role: "user", content: "x" }] });
    await assert.rejects(gen.next(), /no empezó a responder en/);
  });

  it("no confunde una respuesta lenta pero viva con un cuelgue", async () => {
    handler = async (res) => {
      openStream(res);
      for (const piece of ["a", "b", "c", "d"]) { res.write(delta(piece)); await sleep(80); }
      res.end("data: [DONE]\n\n");
    };
    // Total ~320 ms, por encima del plazo de silencio (150 ms): con un plazo
    // total fijo esto se habría cortado.
    const gen = new LlmBridge(url, { firstTokenMs: 1_000, idleMs: 150 }).stream({ messages: [{ role: "user", content: "x" }] });
    let text = "";
    let step = await gen.next();
    while (!step.done) { text += step.value; step = await gen.next(); }
    assert.equal(text, "abcd");
  });

  it("reporta el error HTTP de llama-server", async () => {
    handler = (res) => { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"context too long"}'); };
    const gen = new LlmBridge(url).stream({ messages: [{ role: "user", content: "x" }] });
    await assert.rejects(gen.next(), /HTTP 400: \{"error":"context too long"\}/);
  });

  it("una cancelación del caller sale como AbortError", async () => {
    handler = (res) => { openStream(res); res.write(delta("x")); };
    const abort = new AbortController();
    const gen = new LlmBridge(url).stream({ messages: [{ role: "user", content: "x" }] }, abort.signal);
    await gen.next();
    abort.abort();
    await assert.rejects(gen.next(), (error: Error) => error.name === "AbortError");
  });
});

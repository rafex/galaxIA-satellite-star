# TASKS.md — Rename requestId → missionId en galaxIA-satellite-star

## Metadata

- Iniciativa: `rename-requestid-missionid`
- DEC relacionada: DEC-0085 (rename de campo wire protocol)
- Owner: rafex
- Estado general: `done`
- Origen: trasladado desde galaxIA (repo IDL-only) — tareas originales #55, #56

## Contexto

El campo `requestId` en todos los mensajes del protocolo FHS fue renombrado a `missionId`
(DEC-0085). En este repo, el cambio afecta a los 5 providers de referencia.

Todos los providers tienen el mismo patrón mecánico:
- Destructuring del mensaje entrante: `{ type?, requestId? }` → `{ type?, missionId? }`
- Mapa `pending` indexado por `requestId` (get/set/delete) → indexado por `missionId`
- El campo en cada mensaje saliente: `requestId` → `missionId`
- Paso posicional a `invokeSignaturePayload(callerId, requestId, timestamp)` → `missionId`

---

## Tareas

### TASK-REN-STAR-001 — Rename en los 5 providers de referencia

- ID: TASK-REN-STAR-001
- State: `done`
- Owner: rafex
- Archivos modificados:
  - `examples/star-example/src/index.ts`
  - `examples/nova-example/src/index.ts`
  - `examples/satellite-ocr-example/src/index.ts`
  - `examples/rag-provider/src/index.ts`
  - `examples/kb-provider/src/index.ts`
- Validation: ✅ `grep -rn "requestId" examples/*/src/` devuelve 0 resultados.
  `grep -rn "missionId" examples/*/src/` devuelve ocurrencias en los 5 providers.
  Los archivos `dist/` aún contienen `requestId` — son build artifacts no comiteados,
  se regeneran con `npm run build` en cada provider.
- Commit: `d30b501 feat: renombrar requestId → missionId en los 5 providers (DEC-0085)`

---

### TASK-REN-STAR-002 — Commit y push

- ID: TASK-REN-STAR-002
- State: `done`
- Owner: rafex
- Dependencies: TASK-REN-STAR-001
- Validation: ✅ Ver commit `d30b501` en main branch.

---

## Notas de redeploy

Los providers en producción (Bastion y Raspi4B) deben reconstruirse y reiniciarse de forma
coordinada con Navigator (galaxIA-Core) para evitar la ventana de incompatibilidad de campo.

Orden recomendado:
1. Rebuild del provider en el host correspondiente (`npm run build`)
2. Restart del contenedor de forma simultánea con el restart del Navigator en Bastion
3. Verificar con el job `e2e-smoke` del CI de galaxIA-Core que el chat y OCR funcionan end-to-end

Los archivos `dist/` no se commitean — se regeneran en cada build del contenedor.

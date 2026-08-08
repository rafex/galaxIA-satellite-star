# SpecNative Context

Indice principal del contexto operativo del proyecto.

## Como usar esta carpeta

Si eres un agente o una persona entrando por primera vez:

1. Lee este archivo.
2. Si hay trabajo activo, revisa `SESSION.md` o llama `resume()` via MCP.
3. Abre solo el documento que corresponde a tu tarea.
4. Si trabajas sobre una spec concreta, ve a `specs/README.md`.
5. Si necesitas ejecutar trabajo, ve a `tasks/README.md`.
6. Si necesitas registrar una idea aun no especificada, ve a `intake/README.md`.
7. Si necesitas una vista calculada del backlog o la entrega, ve a
   `backlog/README.md`.
8. Si necesitas entender los gates de CI o el proceso de deploy,
   ve a `pipelines/README.md`.
9. Si necesitas el contrato del framework o el CLI, ve a
   `../.specnative/README.md`.

## Documentos base

- [`PRODUCT.md`](./PRODUCT.md):
  que problema resuelve el producto, para quien y con que objetivos.
- [`ROADMAP.md`](./ROADMAP.md):
  direccion y prioridades de mediano plazo.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md):
  estructura del sistema, modulos y limites.
- [`STACK.md`](./STACK.md):
  tecnologias, versiones y restricciones tecnicas.
- [`CONVENTIONS.md`](./CONVENTIONS.md):
  reglas de codigo, naming, testing y organizacion.
- [`COMMANDS.md`](./COMMANDS.md):
  comandos de desarrollo, test, lint y operaciones comunes.
- [`DECISIONS.md`](./DECISIONS.md):
  decisiones relevantes ya tomadas y su racional.
- [`TRACEABILITY.md`](./TRACEABILITY.md):
  enlaces entre iniciativas, tareas, decisiones y validacion.
- [`SESSION.md`](./SESSION.md):
  estado activo de trabajo — quien trabajo ultimo, que hizo,
  que viene a continuacion.
- [`specs/README.md`](./specs/README.md):
  indice de specs por iniciativa.
- [`tasks/README.md`](./tasks/README.md):
  indice del sistema de ejecucion y estado de tareas.
- [`intake/README.md`](./intake/README.md):
  ideas triadas que aun no son tareas ejecutables.
- [`backlog/README.md`](./backlog/README.md):
  vistas derivadas de backlog y tablero de entrega.
- [`workflows/README.md`](./workflows/README.md):
  procedimientos repetibles para planificar, implementar y validar.
- [`pipelines/README.md`](./pipelines/README.md):
  contexto de integracion continua y entrega continua.

## Ownership documental

- Producto y direccion: `PRODUCT.md` y `ROADMAP.md`
- Sistema y restricciones: `ARCHITECTURE.md`, `STACK.md`,
  `CONVENTIONS.md`, `COMMANDS.md`
- Ejecucion: specs en `specs/` y tareas en `tasks/`
- Memoria de decisiones: `DECISIONS.md`
- Trazabilidad: `TRACEABILITY.md`
- Estado de sesion activa: `SESSION.md`
- Contrato del framework: `.specnative/SCHEMA.md`

## Separacion importante

Los comandos y herramientas del framework no deben documentarse en
`COMMANDS.md`. Ese archivo queda reservado para comandos del proyecto
real que el agente debe usar para desarrollar, probar y construir.

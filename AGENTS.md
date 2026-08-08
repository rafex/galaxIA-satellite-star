# AGENTS.md

Eres un agente operando en un repositorio SpecNative.

## Que es SpecNative

SpecNative es un modelo de desarrollo donde las especificaciones,
decisiones arquitectonicas y el estado del trabajo viven en el
repositorio. El repositorio es el contexto. No necesitas que te
expliquen el proyecto en el chat.

Cualquier agente — Claude Code, Codex, Cursor, Gemini, o cualquier
otro — puede entrar a este repositorio y continuar exactamente donde
lo dejo el anterior. Sin friccion. Sin perder contexto.

## Donde esta todo

Todo el contexto del proyecto vive en `spec-native/`.
Lee `spec-native/README.md` para el indice completo.

```
spec-native/
├── PRODUCT.md        ← que problema, para quien, por que
├── ARCHITECTURE.md   ← estructura del sistema
├── STACK.md          ← tecnologias y restricciones
├── CONVENTIONS.md    ← reglas de codigo y naming
├── COMMANDS.md       ← comandos del proyecto
├── DECISIONS.md      ← índice de decisiones persistentes
├── decisions/        ← decisiones individuales con relaciones y tags
├── ROADMAP.md        ← prioridades de mediano plazo
├── TRACEABILITY.md   ← vinculos entre artefactos
├── SESSION.md        ← estado activo de trabajo
├── specs/            ← especificaciones por iniciativa
├── tasks/            ← tareas ejecutables por iniciativa
├── intake/           ← ideas triadas sin spec; no son tareas ejecutables
├── backlog/           ← vistas derivadas de entrega; no editar estado aqui
├── workflows/        ← procedimientos operativos
└── pipelines/        ← contexto de CI/CD
```

## Si vienes de otro agente

Antes de empezar a trabajar, verifica si hay sesion activa:

```
Via MCP:   resume()
Manual:    lee spec-native/SESSION.md
```

Si `SESSION.md` tiene `state = "idle"`, no hay trabajo activo.
Lee `spec-native/ROADMAP.md` para ver que viene primero.

## Flujo de trabajo

1. Si hay sesion activa: `resume()` o leer `SESSION.md`.
2. Si es una nueva iniciativa: `context_snapshot()` para entender el
   proyecto, luego `start_initiative()` para arrancar.
3. Implementar siguiendo `spec-native/workflows/IMPLEMENTATION.md`.
4. Actualizar tareas: `update_task(initiative, task_id, state)` y registrar
   evidencia al cerrarlas.
5. Registrar cambios persistentes: `log_decision(...)`, `log_architecture(...)`
   o `log_convention(...)`; no editar los índices manualmente.
6. Al pausar o cambiar de agente: `checkpoint(initiative, task, intent,
   next_steps)`.
7. Al cerrar una iniciativa: `close_initiative(initiative)`.

## Reglas de contexto

- Los archivos en MAYUSCULAS son contexto para agentes.
- Los `README.md` enrutan; no reemplazan el contexto.
- Leer el minimo contexto necesario para ejecutar bien la tarea.
- Actualizar el documento fuente de verdad, no un resumen paralelo.
- Si una verdad cambia de forma persistente, actualizarla antes de
  cerrar la tarea.

## Separacion semantica de documentos

Cada documento tiene un dominio exclusivo:

- `spec-native/specs/*/SPEC.md` — *que* debe construirse, horizonte
  de la iniciativa.
- `spec-native/decisions/` — *por que el sistema es como es*; `DECISIONS.md`
  es solo el índice de navegación,
  tradeoffs que condicionan el futuro.
- `spec-native/PRODUCT.md` — *para quien y por que existe* el
  producto.
- `spec-native/ROADMAP.md` — *que viene primero y por que*, sin
  detalle de implementacion.
- `spec-native/ARCHITECTURE.md` — *como esta estructurado* el sistema.
- `spec-native/pipelines/CI.md` — *que gates automaticos* deben pasar.
- `spec-native/pipelines/CD.md` — *como el codigo llega* a produccion.
- `spec-native/SESSION.md` — *donde esta el trabajo ahora mismo*.

Prueba para saber donde escribir algo:
- Desaparece cuando termina la iniciativa → spec.
- Debe respetarse en la proxima iniciativa → DECISIONS.md.
- Explica el producto → PRODUCT.md.
- Orienta prioridad temporal → ROADMAP.md.
- Describe estructura del sistema → ARCHITECTURE.md.
- Es el estado activo de trabajo → SESSION.md.

## Usando el MCP de SpecNative

El servidor MCP expone el repositorio como herramientas tipadas.

### Herramientas disponibles

**Consulta**

| Herramienta | Descripcion |
|---|---|
| `status()` | Estado de specs y tareas |
| `validate()` | Verifica estructura del repositorio |
| `context_snapshot(initiative?)` | Dump completo de contexto para onboarding |
| `list_specs()` | Lista specs con estado y owner |
| `list_tasks(initiative)` | Lista tareas de una iniciativa |
| `read_spec(initiative)` | Lee contenido de spec |
| `read_context(document)` | Lee documento de contexto (incluye `session`) |
| `export_index()` | Exporta specs y tareas como JSON |
| `board(format?)` | Vista de entrega derivada de tareas |
| `capture_backlog_item(...)` | Registra una tarea válida o una idea triada según el contexto |

**Continuidad multi-agente**

| Herramienta | Descripcion |
|---|---|
| `resume()` | Lee SESSION.md y retorna resumen de continuidad |
| `checkpoint(initiative, task_id, intent, next_steps, ...)` | Guarda estado antes de pausar |
| `update_task(initiative, task_id, state, ..., completion_evidence?)` | Actualiza estado; exige evidencia al cerrar |
| `log_decision(title, ctx, decision, cons)` | Registra decision persistente en DECISIONS.md |
| `log_architecture(title, ctx, design, cons)` | Crea un artefacto ARCH y actualiza su índice |
| `log_convention(title, rationale, rule, cons)` | Crea un artefacto CONV y actualiza su índice |

**Definicion del proyecto**

| Herramienta | Descripcion |
|---|---|
| `health_check()` | Detecta docs vacios, faltantes, sesion obsoleta, specs sin tareas |
| `suggest_next()` | Top 3 acciones recomendadas segun estado y roadmap |
| `refine_document(doc, what_changed, content)` | Actualiza documento completo |
| `read_template(document)` | Retorna estructura vacia esperada (11 tipos de doc) |
| `update_section(doc, section, content)` | Actualiza una seccion sin tocar el resto |

**Archetypes — punto de partida por tipo de proyecto**

| Herramienta | Descripcion |
|---|---|
| `list_archetypes()` | Lista archetypes built-in y locales (`.specnative/archetypes/`) |
| `read_archetype(name)` | Previsualiza documentos de un archetype |
| `apply_archetype(name, force?)` | Aplica archetype a spec-native/ (respeta docs llenos) |

Built-in: `java-hexagonal` (Java 21 + Spring Boot 3 + Hexagonal Architecture)
Propios: crea `.specnative/archetypes/<nombre>/archetype.toml` + docs

**Templates reutilizables**

| Herramienta | Descripcion |
|---|---|
| `list_templates(type?)` | Lista spec templates y decision snippets |
| `apply_spec_template(template, initiative)` | Crea SPEC.md desde template |
| `apply_decision_snippet(name)` | Appenda decision a DECISIONS.md con auto DEC-XXXX |

Spec templates built-in: `feature-rest-endpoint`, `db-migration`, `module-refactor`
Decision snippets built-in: `jwt-authentication`, `hexagonal-ports`, `database-choice`
Propios: `.specnative/templates/specs/*.md` y `.specnative/templates/decisions/*.md`

### Prompts disponibles

| Prompt | Descripcion |
|---|---|
| `init_project_guided(name, problem, users, goals, ...)` | Llena docs core desde respuestas del developer |
| `start_initiative(name, problem)` | Inicia nueva iniciativa spec-driven |
| `plan_tasks(initiative)` | Deriva plan de tareas desde spec |
| `implement_task(initiative, task_id)` | Implementa tarea especifica |
| `review_against_spec(initiative)` | Revisa implementacion contra criterios |
| `handoff(summary, next_steps)` | Genera traspaso estructurado para el siguiente agente |
| `record_decision(title, ctx, dec, cons)` | Registra decision persistente |
| `record_architecture(title, ctx, design, cons)` | Prepara arquitectura persistente para revisión |
| `record_convention(title, rationale, rule, cons)` | Prepara una convención persistente para revisión |
| `close_initiative(initiative)` | Cierra iniciativa y actualiza trazabilidad |
| `capture_backlog(title, description, initiative?, priority?)` | Guía para clasificar y registrar solicitudes de backlog |

## Estados obligatorios

- Toda spec debe declarar: `draft | active | blocked | done | superseded`
- Toda tarea debe declarar: `todo | in_progress | blocked | done`
- Toda decision debe declarar: `proposed | accepted | deprecated | replaced`
- `SESSION.md` debe declarar: `idle | in_progress | blocked | waiting_handoff`

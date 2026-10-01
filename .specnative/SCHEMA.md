# SCHEMA.md

Contrato minimo del framework SpecNative Development v0.9.

## Objetivo

Definir que documentos son obligatorios, que rol cumple cada uno y
que estados o campos minimos deben existir para reducir ambiguedad.

## Documentos obligatorios

- `AGENTS.md`
- `spec-native/README.md`
- `spec-native/PRODUCT.md`
- `spec-native/ARCHITECTURE.md`
- `spec-native/STACK.md`
- `spec-native/CONVENTIONS.md`
- `spec-native/COMMANDS.md`
- `spec-native/DECISIONS.md`
- `spec-native/decisions/` (índice y artefactos de decisión)
- `spec-native/ROADMAP.md`
- `spec-native/TRACEABILITY.md`
- `spec-native/SESSION.md`
- `spec-native/specs/` (al menos una spec)
- `spec-native/tasks/README.md`
- `spec-native/workflows/README.md`
- `spec-native/pipelines/README.md`

## Documentos opcionales

- `spec-native/tasks/<iniciativa>/TASKS.md`
- `spec-native/intake/IDEAS.md`
- `spec-native/backlog/README.md`
- `spec-native/workflows/PLANNING.md`
- `spec-native/workflows/REVIEW.md`
- specs separadas por iniciativa en `spec-native/specs/`
- `exports/*.json` generados por tooling externo

## Infraestructura del framework (`.specnative/`)

- `SCHEMA.md` — este archivo; contrato del framework
- `CLI.md` — referencia del CLI (`specnative.py`) y el servidor MCP
- `MCP.md` — configuracion del servidor MCP por agente (v0.5+)

## Ownership documental

- Problema y objetivos: `spec-native/PRODUCT.md`
- Direccion temporal: `spec-native/ROADMAP.md`
- Restricciones del sistema: `spec-native/ARCHITECTURE.md`, `spec-native/STACK.md`
- Reglas operativas: `spec-native/CONVENTIONS.md`, `spec-native/COMMANDS.md`
- Contrato del framework: `.specnative/SCHEMA.md`
- Cambio requerido: `spec-native/specs/**/SPEC.md`
- Idea no especificada: `spec-native/intake/IDEAS.md`
- Descomposicion ejecutable: `spec-native/tasks/**/TASKS.md`
- Índice de decisiones persistentes: `spec-native/DECISIONS.md`
- Decisiones canónicas: `spec-native/decisions/DEC-XXXX-<slug>.md`
- Arquitectura canónica: `spec-native/architecture/ARCH-XXXX-<slug>.md`
- Convenciones canónicas: `spec-native/conventions/CONV-XXXX-<slug>.md`
- Relaciones entre artefactos: `spec-native/TRACEABILITY.md`
- Gates de CI y proceso de CD: `spec-native/pipelines/CI.md`, `spec-native/pipelines/CD.md`
- Estado activo de trabajo: `spec-native/SESSION.md`
- Backlog y kanban derivados: `spec-native/backlog/` (no son fuente de verdad)

## Estados obligatorios

### Specs

Toda spec debe declarar:

- `ID`
- `Estado`
- `Owner`
- `Fecha de creacion`
- `Ultima actualizacion`

Estados permitidos:

- `draft`
- `active`
- `blocked`
- `done`
- `superseded`

### Tareas

Toda tarea debe declarar:

- `ID`
- `Title`
- `State`
- `Owner`
- `Criterio de cierre`
- `Priority` (`p0 | p1 | p2 | p3`; por defecto `p2`)

Estados permitidos:

- `todo`
- `in_progress`
- `blocked`
- `done`

Una tarea con estado `done` debe declarar `completion_evidence` no vacio.
`validation` describe la comprobacion prevista; `completion_evidence` registra
la prueba o resultado realmente obtenido.

### Decisiones

Toda decision debe declarar:

- `ID`
- `Fecha`
- `Estado`
- `Contexto`
- `Decision`
- `Consecuencias`

Estados permitidos:

- `proposed`
- `accepted`
- `deprecated`
- `replaced`

### Arquitectura y convenciones

Los artefactos persistentes de arquitectura y convenciones usan front matter
TOML con `doctype`, `id`, `title`, `status`, relaciones y `tags`. Sus índices
(`ARCHITECTURE.md` y `CONVENTIONS.md`) son derivados y no se editan a mano.

### SESSION.md

El archivo `spec-native/SESSION.md` usa TOML front matter con `+++` delimitadores.

Campos minimos:

- `state`       — `idle | in_progress | blocked | waiting_handoff`
- `agent`       — nombre o ID del agente que hizo el ultimo checkpoint
- `initiative`  — iniciativa activa
- `task`        — tarea activa
- `intent`      — que estaba haciendo el agente (una frase)
- `last_updated` — timestamp ISO 8601

## Reglas de trazabilidad

Toda iniciativa relevante deberia permitir navegar:

1. de la spec a sus tareas
2. de las tareas a la validacion
3. de la spec o tareas a decisiones persistentes
4. de los artefactos a los archivos o cambios principales

## Regla de validacion

Antes de cerrar una iniciativa, comprobar:

- estado final consistente
- validacion definida o ejecutada
- trazabilidad minima registrada
- ausencia de contradicciones entre spec, tareas y decisiones

## Metadata parseable (opcional)

Para proyectos que usan el CLI de SpecNative, specs y archivos de
tareas pueden incluir un bloque `toml` que permite validacion y
exportacion automatica del estado del proyecto.

Cuando se usa el CLI, los bloques `toml` deben aparecer cerca del
inicio del archivo y contener al menos los campos requeridos por el
comando `validate`. Ver `.specnative/CLI.md` para referencia completa de
campos y comandos disponibles.

### Gestion de trabajo derivada

El backlog y el kanban se calculan desde `spec-native/tasks/**/TASKS.md`.
No deben introducir un segundo estado editable. El tooling clasifica cada
tarea como `ready`, `in_progress`, `blocked`, `waiting` o `done` a partir de
su estado y dependencias. Una integracion externa, como GitHub Projects, es
una proyeccion y no puede sustituir la fuente de verdad del repositorio.

El TOML no es un requisito del contrato base. Los documentos son
validos sin el y pueden adoptarlo de forma incremental.

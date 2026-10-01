# MCP.md — SpecNative MCP Server v0.9

El servidor MCP de SpecNative expone el repositorio como **recursos**, **herramientas**
y **prompts** para que cualquier agente compatible con MCP pueda trabajar en modo
spec-first sin navegar manualmente el árbol de archivos.

**v0.9 define una superficie de comandos común para Claude Code, OpenCode y
Codex**, con operaciones canónicas para decisiones, arquitectura y
convenciones.

## Comandos por agente

Instalados automáticamente en tu repositorio. Disponibles desde el primer día.

### Comandos comunes

| Comando | Descripción |
|---------|-------------|
| `spec` | Enruta una solicitud por el flujo mínimo correcto |
| `spec-init`, `spec-update`, `spec-status` | Inicialización, refinamiento y salud del contexto |
| `spec-backlog [solicitud]` | Tablero derivado o captura canónica de trabajo |
| `spec-decision` | Registra una decisión persistente después de revisión |
| `spec-plan`, `spec-implement` | Planifica e implementa una tarea con evidencia de cierre |
| `spec-review`, `spec-close` | Revisa criterios y cierra con trazabilidad |
| `spec-context` | Carga el mínimo contexto por tag o ID `DEC`/`ARCH`/`CONV` |
| `spec-architecture`, `spec-convention` | Crea artefactos canónicos e índices derivados |
| `spec-handoff` | Guarda un traspaso para el siguiente agente |

`spec-backlog-add` se mantiene como alias compatible de `spec-backlog`.

La fuente de verdad es `.specnative/commands.json`. En el repositorio del
framework, `tools/sync_agent_commands.py --check` verifica que los adaptadores
generados no hayan quedado desactualizados.

### Claude Code — slash commands

Usa `/spec-*`; cada entrada de `.specnative/commands.json` genera un archivo
en `.claude/commands/`.

La skill `specnative-workflow` se instala en `.claude/skills/` y es detectada
por Claude Code y OpenCode. También se incluye en `.codex/skills/` para los
entornos Codex que cargan skills de proyecto; `codex.toml` conserva los prompts
como mecanismo de respaldo.

### OpenCode — comandos integrados

Disponibles en el menú de prompts de OpenCode (configurados en `opencode.json`):

Todos los comandos comunes se agregan bajo `command` en `opencode.json` desde
el manifiesto durante la instalación. Las configuraciones existentes se
preservan y solo se agregan claves ausentes.

### Codex CLI — prompts en codex.toml

```bash
codex --prompt spec-decision
codex --prompt spec-plan
codex --prompt spec-implement
codex --prompt spec-review
```

Todos los comandos comunes se instalan como prompts `spec-*`; si ya existe un
`codex.toml`, el instalador agrega solo los prompts faltantes.

### CLI sin agente

```bash
python3 specnative.py init              # wizard interactivo en terminal
python3 specnative.py update            # health check + refinamiento guiado
python3 specnative.py update --doc stack  # actualizar solo un documento
```

## Instalación

El instalador de SpecNative descarga el servidor MCP y crea un entorno virtual
aislado con todas sus dependencias automáticamente:

```
.specnative/specnative_mcp.py   ← servidor MCP
.specnative/.venv/              ← entorno virtual con mcp instalado
```

Si necesitas reinstalar o actualizar el servidor:

```bash
python3 install.py --reinstall --target /ruta/a/tu/repo
```

---

## Configuración por agente

El servidor usa el Python del venv aislado en `.specnative/.venv/`.
Reemplaza `/ruta/a/tu/proyecto` con la ruta absoluta real de tu repositorio.

### Claude Code

```bash
# Desde la raíz de tu proyecto:
claude mcp add specnative \
  "$(pwd)/.specnative/.venv/bin/python3" "$(pwd)/.specnative/specnative_mcp.py" \
  -- --repo "$(pwd)"
```

O agrega a `.claude/mcp_settings.json` (proyecto) o `~/.claude/mcp_settings.json` (global):

```json
{
  "mcpServers": {
    "specnative": {
      "command": "/ruta/a/tu/proyecto/.specnative/.venv/bin/python3",
      "args": [
        "/ruta/a/tu/proyecto/.specnative/specnative_mcp.py",
        "--repo", "/ruta/a/tu/proyecto"
      ]
    }
  }
}
```

### Claude Desktop

Agrega a `claude_desktop_config.json`
(`~/Library/Application Support/Claude/` en macOS,
`%APPDATA%\Claude\` en Windows):

```json
{
  "mcpServers": {
    "specnative": {
      "command": "/ruta/a/tu/proyecto/.specnative/.venv/bin/python3",
      "args": [
        "/ruta/a/tu/proyecto/.specnative/specnative_mcp.py",
        "--repo", "/ruta/a/tu/proyecto"
      ]
    }
  }
}
```

### OpenCode

Generado automáticamente en `opencode.json` durante la instalación.
Usa la clave `command` del schema de OpenCode (no `prompts` — esa clave no existe).
La clave `instructions` hace que OpenCode cargue `AGENTS.md` automáticamente en cada sesión.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": [
    "AGENTS.md",
    "spec-native/README.md"
  ],
  "mcp": {
    "specnative": {
      "type": "local",
      "enabled": true,
      "command": [
        "./.specnative/.venv/bin/python3",
        "./.specnative/specnative_mcp.py"
      ]
    }
  },
  "command": {
    "spec-init": {
      "description": "Initialize SpecNative — guided project setup",
      "template": "Use the specnative MCP server. Call health_check() to see which spec-native/ documents are empty. Interview the developer and fill PRODUCT.md, STACK.md, ARCHITECTURE.md, CONVENTIONS.md and COMMANDS.md using update_section() or refine_document(). Finish by suggesting start_initiative() for the first spec."
    },
    "spec-update": {
      "description": "Update SpecNative docs — detect gaps, refine iteratively",
      "template": "Use the specnative MCP server. Call health_check() and suggest_next() to identify gaps. Ask the developer what to refine today, then use update_section() or refine_document() to update the documents."
    },
    "spec-status": {
      "description": "Quick SpecNative project health check",
      "template": "Use the specnative MCP server. Call resume(), status() and health_check(). Summarize in 5 lines what is healthy and what needs attention."
    },
    "spec-handoff": {
      "description": "Generate structured handoff for next agent",
      "template": "Use the specnative MCP server. Ask the developer what they were doing and what the next step is. Call checkpoint() with the gathered info, then log_decision() for any unrecorded decisions. Confirm with read_context('session')."
    },
    "spec-backlog-add": {
      "description": "Capture a backlog request as a task or triaged intake idea",
      "template": "Use list_specs() and board() first. Call capture_backlog_item() with initiative only when an existing spec, close criteria and validation are known; otherwise call it without initiative to record triaged intake. Never edit a generated board."
    }
  }
}
```

> **Nota:** La clave `instructions` es exclusiva de OpenCode — le indica qué archivos
> incluir como contexto en cada sesión. `AGENTS.md` se carga automáticamente sin
> necesidad de pedírselo al agente.

### Codex CLI

Agrega a `~/.codex/config.toml` (global) o `codex.toml` (raíz del proyecto):

```toml
[mcp_servers.specnative]
command = "/ruta/a/tu/proyecto/.specnative/.venv/bin/python3"
args = [
  "/ruta/a/tu/proyecto/.specnative/specnative_mcp.py",
  "--repo", "/ruta/a/tu/proyecto"
]
type = "stdio"
```

### Variable de entorno (alternativa universal)

```bash
export SPECNATIVE_REPO=/ruta/a/tu/proyecto
.specnative/.venv/bin/python3 .specnative/specnative_mcp.py
```

### Transporte SSE (agentes remotos)

```bash
.specnative/.venv/bin/python3 .specnative/specnative_mcp.py \
  --repo /ruta/al/proyecto \
  --transport sse \
  --port 8765
```

---

## Recursos disponibles

| URI                          | Documento                              |
|------------------------------|----------------------------------------|
| `spec://agents`              | `AGENTS.md` — contrato operativo       |
| `spec://session`             | `spec-native/SESSION.md` — estado activo |
| `spec://context/product`     | `spec-native/PRODUCT.md`               |
| `spec://context/architecture`| `spec-native/ARCHITECTURE.md`          |
| `spec://context/stack`       | `spec-native/STACK.md`                 |
| `spec://context/conventions` | `spec-native/CONVENTIONS.md`           |
| `spec://context/commands`    | `spec-native/COMMANDS.md`              |
| `spec://context/decisions`   | `spec-native/DECISIONS.md`             |
| `spec://context/roadmap`     | `spec-native/ROADMAP.md`               |
| `spec://context/traceability`| `spec-native/TRACEABILITY.md`          |
| `spec://pipelines/ci`        | `spec-native/pipelines/CI.md`          |
| `spec://pipelines/cd`        | `spec-native/pipelines/CD.md`          |
| `spec://schema`              | `.specnative/SCHEMA.md`                |

---

## Herramientas disponibles

### Consulta

| Herramienta                  | Descripción                                                    |
|------------------------------|----------------------------------------------------------------|
| `status()`                   | Estado de cada spec y conteo de tareas por estado              |
| `validate()`                 | Verifica que existan todos los archivos obligatorios           |
| `list_specs()`               | Lista specs con ID, estado y owner                             |
| `list_tasks(initiative)`     | Lista tareas de una iniciativa con estados                     |
| `board(format?)`             | Tablero de entrega de solo lectura derivado de tareas           |
| `capture_backlog_item(...)`  | Crea tarea válida o idea triada según la información disponible |
| `read_spec(initiative)`      | Lee el contenido de una spec                                   |
| `read_context(document)`     | Lee un documento de contexto por nombre corto                  |
| `export_index()`             | Exporta specs y task files con metadata TOML como JSON         |
| `context_snapshot(initiative?)` | Dump completo de contexto para onboarding de nuevo agente  |

### Continuidad multi-agente (v0.5)

| Herramienta                               | Descripción                                                    |
|-------------------------------------------|----------------------------------------------------------------|
| `resume()`                                | Lee SESSION.md y genera resumen de continuidad                 |
| `checkpoint(initiative, task_id, intent, next_steps, context_notes?, agent_name?)` | Guarda estado antes de pausar |
| `update_task(initiative, task_id, state, notes?, completion_evidence?)` | Actualiza estado; cerrar exige evidencia |
| `log_decision(title, context, decision, consequences)` | Append rápido a DECISIONS.md              |
| `log_architecture(title, context, design, consequences)` | Crea `ARCH-*` y actualiza ARCHITECTURE.md |
| `log_convention(title, rationale, rule, consequences)` | Crea `CONV-*` y actualiza CONVENTIONS.md |

### Definición y salud del proyecto (v0.6)

| Herramienta                               | Descripción                                                    |
|-------------------------------------------|----------------------------------------------------------------|
| `health_check()`                          | Escanea spec-native/ y reporta vacíos, docs faltantes, sesión obsoleta |
| `suggest_next()`                          | Sugiere las 3 acciones más impactantes basado en estado actual |
| `refine_document(document, what_changed, new_content)` | Actualiza un documento con nuevo contenido     |
| `read_template(document)`                 | Retorna la estructura vacía esperada de cualquier doc (11 tipos) |
| `update_section(document, section, content)` | Actualiza una sola sección sin tocar el resto del archivo  |

### Archetypes (v0.7)

| Herramienta                               | Descripción                                                    |
|-------------------------------------------|----------------------------------------------------------------|
| `list_archetypes()`                       | Lista archetypes disponibles: built-in + locales en `.specnative/archetypes/` |
| `read_archetype(name)`                    | Previsualiza todos los documentos de un archetype antes de aplicarlo |
| `apply_archetype(name, force?)`           | Escribe docs del archetype en spec-native/ (respeta docs con contenido) |

**Built-in:** `java-hexagonal` — Java 21 + Spring Boot 3 + Hexagonal Architecture
Incluye: ARCHITECTURE, STACK, CONVENTIONS, COMMANDS, DECISIONS, ROADMAP

**Archetype propio:** crea `.specnative/archetypes/<nombre>/archetype.toml` + docs.
Ver `.specnative/archetypes/README.md` para el formato.

### Templates (v0.7)

| Herramienta                               | Descripción                                                    |
|-------------------------------------------|----------------------------------------------------------------|
| `list_templates(type?)`                   | Lista spec templates y decision snippets (`spec` \| `decision` \| vacío=ambos) |
| `apply_spec_template(template, initiative)` | Crea `spec-native/specs/{initiative}/SPEC.md` desde un template |
| `apply_decision_snippet(name)`            | Appenda snippet a DECISIONS.md con auto DEC-XXXX y fecha      |

**Spec templates built-in:** `feature-rest-endpoint`, `db-migration`, `module-refactor`

**Decision snippets built-in:** `jwt-authentication`, `hexagonal-ports`, `database-choice`

**Templates propios:** crea archivos `.md` en `.specnative/templates/specs/` o
`.specnative/templates/decisions/`. Ver los `README.md` de cada carpeta para el formato.

---

## Prompts disponibles

### Definición del proyecto (v0.6)

| Prompt                                    | Descripción                                              |
|-------------------------------------------|----------------------------------------------------------|
| `init_project_guided(name, problem, users, goals, non_goals, stack, arch, conv, cmds)` | Llena los documentos core con contenido real del proyecto |

### Flujo de iniciativas

| Prompt                                    | Descripción                                              |
|-------------------------------------------|----------------------------------------------------------|
| `start_initiative(name, problem)`         | Inicia una nueva iniciativa spec-driven                  |
| `plan_tasks(initiative)`                  | Deriva el plan de tareas desde una spec                  |
| `implement_task(initiative, task_id)`     | Implementa una tarea específica                          |
| `review_against_spec(initiative)`         | Revisa implementación contra criterios de aceptación     |
| `handoff(summary, next_steps, decisions?)` | Genera traspaso estructurado para el siguiente agente   |
| `record_decision(title, ctx, dec, cons)`  | Registra una decisión persistente en DECISIONS.md        |
| `record_architecture(title, ctx, design, cons)` | Prepara un artefacto ARCH para revisión |
| `record_convention(title, rationale, rule, cons)` | Prepara una convención para revisión |
| `close_initiative(initiative)`            | Cierra la iniciativa y actualiza trazabilidad            |
| `capture_backlog(title, description, initiative?, priority?)` | Clasifica y registra una solicitud de backlog |

---

## Flujo multi-agente

```
Agente A (Claude Code) implementa TASK-AUTH-0002:
  → update_task('authentication', 'TASK-AUTH-0002', 'in_progress')
  → ... trabaja ...
  → Se acaban los tokens. Llama checkpoint antes de cerrar:
  → checkpoint(
       initiative='authentication',
       task_id='TASK-AUTH-0002',
       intent='Implementando middleware JWT',
       next_steps='1. Agregar endpoint /refresh\n2. Escribir tests de integración',
       context_notes='JWT secret en env AUTH_SECRET. No hardcodear.'
     )

Agente B (Codex) entra al repo:
  → Lee AGENTS.md
  → resume()
  ← "Task TASK-AUTH-0002 in_progress. Intent: Implementando middleware JWT.
     Next: 1. Agregar endpoint /refresh..."
  → Continúa sin fricción
```

---

## Separación de responsabilidades

El servidor MCP es **infraestructura del framework**, no contenido del proyecto:

- Los documentos del proyecto viven en `spec-native/`.
- El servidor MCP lee y escribe esos documentos mediante herramientas tipadas.
- Las reglas de ownership siguen siendo las de `AGENTS.md` y `SCHEMA.md`.
- `.specnative/specnative_mcp.py` y `.specnative/.venv/` pueden agregarse a
  `.gitignore` si prefieres no versionarlos; o commitearlos si quieres que el
  equipo use exactamente la misma versión.

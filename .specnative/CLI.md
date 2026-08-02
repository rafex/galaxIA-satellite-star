# CLI.md

Referencia del CLI de SpecNative. El uso del CLI es opcional.
El contrato base del framework es documental y no requiere tooling.

## Ubicacion del CLI

El CLI vive en el repositorio SpecNative Development, no en tu proyecto:

```
https://github.com/rafex/SpecNative-Development
tools/specnative.py
```

Para usarlo, clona o descarga ese archivo y ejecutalo apuntando a la
raiz de tu proyecto.

## Comandos disponibles

### Estado del proyecto

```bash
python3 /path/to/SpecNative-Development/tools/specnative.py status --target /ruta/a/tu/proyecto
```

Muestra el estado actual de todas las specs y sus tareas asociadas.
Util para que el agente o el equipo tenga una vista rapida de que
iniciativas estan activas, bloqueadas o cerradas y cuantas tareas
quedan pendientes en cada una.

### Validacion

```bash
python3 /path/to/SpecNative-Development/tools/specnative.py validate --target /ruta/a/tu/proyecto
```

Verifica que los archivos obligatorios existan y que los bloques TOML
presentes en specs y tasks sean consistentes con los estados permitidos.

Si un archivo no tiene bloque TOML, no falla: el TOML es opcional.

### Exportar indice

```bash
python3 /path/to/SpecNative-Development/tools/specnative.py export-index --target /ruta/a/tu/proyecto --output exports/index.json
```

Genera un JSON con todas las specs y archivos de tareas encontrados.
Solo incluye artefactos que tengan bloque TOML.

### Exportar trazabilidad

```bash
python3 /path/to/SpecNative-Development/tools/specnative.py export-traceability --target /ruta/a/tu/proyecto --output exports/traceability.json
```

Genera un JSON de relaciones entre specs y tareas.
Los archivos de salida no deben commitearse como parte de la plantilla.

### Backlog y kanban derivados

```bash
python3 /path/to/SpecNative-Development/tools/specnative.py board --target /ruta/a/tu/proyecto
python3 /path/to/SpecNative-Development/tools/specnative.py board --target /ruta/a/tu/proyecto --format mermaid
python3 /path/to/SpecNative-Development/tools/specnative.py board --target /ruta/a/tu/proyecto --format json
```

Genera una vista de entrega desde las tareas canónicas. Las columnas son
`ready`, `in_progress`, `blocked`, `waiting` y `done`. La salida es de solo
lectura: cambia el estado en `TASKS.md` o mediante el MCP, nunca en el tablero.

### Plan de exportacion a GitHub Projects

```bash
cp .specnative/integrations/github-project.toml.example \
  .specnative/integrations/github-project.toml
python3 /path/to/SpecNative-Development/tools/specnative.py \
  github-project plan --target /ruta/a/tu/proyecto
```

El comando valida el mapeo de estados y emite JSON con operaciones de exportación
propuestas. Es un `dry run`: no realiza llamadas de red ni modifica GitHub.

### Instalar en otro repositorio

```bash
curl -sSL https://github.com/rafex/SpecNative-Development/releases/latest/download/install.py \
  | python3 - --target /ruta/al/repo --profile team
```

Copia la estructura de la plantilla en un repositorio existente de
forma segura, en una rama dedicada.

## Seguridad del instalador

Antes de copiar archivos, el CLI:

1. valida que el destino sea un repositorio git
2. valida que el worktree este limpio
3. crea una rama dedicada
4. copia solo la estructura seleccionada

## Perfiles

- `context`: contexto base, índices de navegación, sesión y configuración MCP.
- `spec`: `context` más templates de tareas y workflows completos.
- `team`: `spec` más documentación de CI/CD, schema, archetypes y templates.
- `platform`: `team` más README de referencia y ejemplo de autenticación.

Si un archivo ya existe y no se usa `--force`, el CLI lo omite.

## Servidor MCP

El servidor MCP expone el repositorio como recursos, herramientas y prompts
para agentes compatibles con MCP (Claude Desktop, Claude Code, OpenCode, etc.).

```
https://github.com/rafex/SpecNative-Development
tools/specnative_mcp.py
```

Requiere: `pip install mcp`

Consulta `.specnative/MCP.md` para la configuracion completa por agente y
la referencia de recursos, herramientas y prompts disponibles.

---

## Campos TOML para specs

Cuando se usa el CLI, cada `SPEC.md` puede incluir:

```toml
artifact_type = "spec"
id = "SPEC-0001"
state = "draft"
owner = "team-name"
created_at = "YYYY-MM-DD"
updated_at = "YYYY-MM-DD"
replaces = "none"
related_tasks = ["TASK-0001"]
related_decisions = ["DEC-0001"]
artifacts = ["src/example/*"]
validation = ["pytest", "manual walkthrough"]
```

## Campos TOML para archivos de tareas

Cabecera del archivo:

```toml
artifact_type = "task_file"
initiative = "initiative-name"
spec_id = "SPEC-0001"
owner = "team-name"
state = "todo"
```

Por cada tarea:

```toml
id = "TASK-0001"
title = "Titulo"
state = "todo"
owner = "team-name"
dependencies = []
expected_files = ["src/example/*"]
close_criteria = "Condicion observable de cierre"
validation = ["pytest tests/example_test.py"]
completion_evidence = [] # obligatorio y no vacio cuando state = "done"
```

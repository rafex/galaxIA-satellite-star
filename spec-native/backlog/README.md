# Backlog y tablero de entrega

SpecNative separa los artefactos de planificacion por autoridad:

- `intake/` es opcional y guarda ideas que aun no se convierten en una spec.
- `ROADMAP.md` establece la prioridad temporal de las iniciativas.
- `specs/**/SPEC.md` define trabajo aprobado.
- `tasks/**/TASKS.md` es la fuente de verdad ejecutable.
- Este backlog y tablero de entrega son proyecciones generadas de las tareas.

## Generar una vista

```bash
python3 /path/to/SpecNative-Development/tools/specnative.py board --target .
python3 /path/to/SpecNative-Development/tools/specnative.py board --target . --format mermaid
python3 /path/to/SpecNative-Development/tools/specnative.py board --target . --format json
```

Las columnas calculadas son `ready`, `in_progress`, `blocked`, `waiting` y
`done`. `waiting` significa que una o más dependencias declaradas no han
llegado a `done`.

No edites la salida generada para mover una tarjeta. Actualiza la metadata TOML
del archivo fuente de la tarea, preferiblemente mediante `update_task` del MCP.

## GitHub Projects

GitHub Projects es una vista externa opcional. Empieza con un plan de
exportacion sin efectos:

```bash
cp .specnative/integrations/github-project.toml.example \
  .specnative/integrations/github-project.toml
# Configura el ID de nodo de GitHub Project y los nombres de estado.
python3 /path/to/SpecNative-Development/tools/specnative.py \
  github-project plan --target .
```

El plan contiene operaciones de actualizacion identificadas por IDs inmutables
de tarea. No llama a GitHub ni convierte GitHub Projects en la fuente de verdad.

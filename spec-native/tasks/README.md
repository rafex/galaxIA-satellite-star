# Tasks

Indice del sistema de ejecucion del proyecto.

## Objetivo

Traducir specs en unidades ejecutables, con estado observable y
criterio de cierre verificable.

## Reglas

- Toda carpeta de iniciativa en `tasks/` debe corresponder a una spec.
- Toda tarea debe declarar: ID, titulo, estado, owner y criterio de
  cierre.
- El backlog y el kanban son vistas generadas desde este directorio; no
  editar tarjetas o tableros para cambiar el estado.
- Las tareas usan prioridad `p0` a `p3` (`p0` es la mayor). Si no se
  declara, el tooling asume `p2`.
- Una tarea en `done` debe registrar `completion_evidence`, no solo la
  validacion planificada.
- No usar `tasks/` como lista de ideas. Solo trabajo derivado de una
  spec vigente.
- Si una tarea se bloquea, registrar bloqueo y dependencia.

## Estructura sugerida

```text
spec-native/tasks/
  README.md
  TASKS.template.md
  authentication/
    README.md
    TASKS.md
```

## Flujo

1. Leer la spec asociada en `../specs/<iniciativa>/`.
2. Descomponer en tareas pequenas y validables.
3. Ejecutar segun prioridad y dependencias; una tarea `todo` solo esta
   `ready` cuando todas sus dependencias estan en `done`.
4. Actualizar estado real durante la ejecucion (via MCP: `update_task`).
5. Reflejar cierre y evidencia en `../TRACEABILITY.md`.

# IMPLEMENTATION.md

Procedimiento detallado para ejecutar una iniciativa.
El contrato operativo del agente esta en `../../AGENTS.md`.

## Antes de empezar

Si vienes de otro agente o continuando trabajo previo:
- Via MCP: llama `resume()` para ver el estado actual
- Manual: lee `../SESSION.md`

## Pasos

1. Leer la spec activa y confirmar que su estado es `active`.
   Spec en `../specs/<iniciativa>/SPEC.md`.
2. Leer el contexto tecnico relevante: `../ARCHITECTURE.md`,
   `../STACK.md`, `../CONVENTIONS.md` segun lo que la spec requiera.
3. Leer o crear las tareas en `../tasks/<iniciativa>/TASKS.md`.
4. Implementar en lotes pequenos siguiendo el orden de dependencias.
5. Actualizar el estado de cada tarea al completarla.
   Via MCP: llama `update_task(initiative, task_id, state)`.
6. Ejecutar la validacion definida en la spec o en cada tarea.
   Consultar `../pipelines/CI.md` para verificar que los gates
   obligatorios del proyecto estan cubiertos.
7. Si surge un tradeoff nuevo que debe persistir, registrarlo:
   Via MCP: llama `log_decision(title, context, decision, consequences)`.
   Manual: append a `../DECISIONS.md`.
8. Al pausar o cambiar de agente, hacer checkpoint:
   Via MCP: llama `checkpoint(initiative, task_id, intent, next_steps)`.
9. Al cerrar la iniciativa, actualizar `../TRACEABILITY.md`.
   Via MCP: el prompt `close_initiative` lo guia.

## Regla de cierre

No cerrar una iniciativa si falta alguno de estos puntos:

- spec con estado final consistente
- tareas con estado actualizado
- evidencia de validacion o bloqueo explicitado
- decisiones persistentes registradas si hubo tradeoffs nuevos

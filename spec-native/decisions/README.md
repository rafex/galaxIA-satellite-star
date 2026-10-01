# Decisions

Cada decisión persistente es un archivo con ID inmutable. `../DECISIONS.md` es
solo el índice de navegación.

```toml
+++
doctype = "decision"
id = "DEC-0001"
title = "Titulo de la decision"
status = "accepted"
created_at = "YYYY-MM-DD"
owners = ["team-name"]
related_specs = ["SPEC-0001"]
related_tasks = ["TASK-0001"]
related_architecture = ["ARCH-COMPONENT-0001"]
supersedes = []
tags = ["domain/authentication", "concern/security"]
+++
```

Los tags sirven para descubrir contexto; las relaciones tipadas son la
trazabilidad verificable. Usa el MCP `log_decision()` para crear archivos e
índices consistentes.

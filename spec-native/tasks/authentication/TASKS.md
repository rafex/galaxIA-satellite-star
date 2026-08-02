# TASKS.md

> Ejemplo de archivo de tareas con metadata parseable para proyectos
> que usan el CLI de SpecNative. Los bloques toml son opcionales; ver
> `.specnative/CLI.md`.

```toml
artifact_type = "task_file"
initiative = "authentication"
spec_id = "SPEC-AUTH-0001"
owner = "team-auth"
state = "in_progress"
```

## Metadata

- Iniciativa: authentication
- Spec relacionada: SPEC-AUTH-0001
- Owner: team-auth
- Estado general: `in_progress`

## Tareas

### TASK-AUTH-0001 - Definir modelo de sesion

```toml
id = "TASK-AUTH-0001"
title = "Definir modelo de sesion"
state = "done"
priority = "p1"
owner = "team-auth"
labels = ["domain", "authentication"]
dependencies = []
expected_files = ["src/auth/session.*"]
close_criteria = "Existe contrato de sesion y validacion unitaria"
validation = ["tests unitarios de creacion y expiracion"]
completion_evidence = ["Pruebas unitarias de sesion ejecutadas en CI"]
```

Implementa el contrato base de sesion sobre el que dependen las
rutas protegidas.

### TASK-AUTH-0002 - Implementar middleware de autorizacion

```toml
id = "TASK-AUTH-0002"
title = "Implementar middleware de autorizacion"
state = "in_progress"
priority = "p0"
owner = "team-auth"
labels = ["security", "authentication"]
dependencies = ["TASK-AUTH-0001"]
expected_files = ["src/auth/middleware.*"]
close_criteria = "Rutas protegidas rechazan requests no autenticadas"
validation = ["test de integracion sobre rutas protegidas"]
```

Extiende el flujo de request para exigir sesion valida en endpoints
privados.

### TASK-AUTH-0003 - Documentar setup operativo

```toml
id = "TASK-AUTH-0003"
title = "Documentar setup operativo"
state = "todo"
priority = "p2"
owner = "platform"
labels = ["documentation"]
dependencies = ["TASK-AUTH-0002"]
expected_files = ["spec-native/COMMANDS.md", "README.md"]
close_criteria = "El setup local y variables requeridas estan documentadas"
validation = ["walkthrough manual de bootstrap"]
```

Documenta variables requeridas, bootstrap local y secuencia de
validacion.

# CI.md

Integracion continua del proyecto.

## Objetivo

Describir que validaciones corren automaticamente, en que momento
y que debe pasar antes de que un cambio pueda mergearse.

## Cuando actualizar este archivo

Actualizar cuando cambie un gate, se agregue una nueva validacion
automatica o se modifique la plataforma de CI.

## Template

### Plataforma

- Plataforma de CI:
- Archivo de configuracion:
- Donde ver resultados:

### Triggers

| Evento | Pipeline que se ejecuta |
| --- | --- |
| Pull request abierto | |
| Push a rama principal | |
| Release publicado | |

### Gates obligatorios

Estos checks deben pasar antes de mergear cualquier cambio:

| Gate | Herramienta | Comando local |
| --- | --- | --- |
| Lint | | ver `../COMMANDS.md` |
| Tests unitarios | | ver `../COMMANDS.md` |
| Tests de integracion | | ver `../COMMANDS.md` |
| Build | | ver `../COMMANDS.md` |

### Gates opcionales o informativos

Checks que corren pero no bloquean el merge:

| Gate | Herramienta | Observaciones |
| --- | --- | --- |
| Cobertura de tests | | |
| Analisis de seguridad | | |

### Politica de falla

- Describe que ocurre cuando un gate falla.
- Quien es responsable de desbloquearlo.
- Si existe algun proceso de excepcion aprobado.

### Relacion con tareas

Un agente no debe marcar una tarea como `done` si los gates de CI
definidos en la seccion de validacion de esa tarea no pasan.

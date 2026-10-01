# Pipelines

Contexto de integracion continua y entrega continua del proyecto.

## Objetivo

Dar al agente y al equipo una fuente de verdad sobre que ocurre
automaticamente cuando se sube codigo, que gates deben pasar antes
de mergear y como se despliega el proyecto.

## Cuando leer esta carpeta

- Antes de cerrar una tarea: verificar que el trabajo satisface los
  gates de CI definidos en `CI.md`.
- Antes de proponer un merge o release: revisar los gates de CD en
  `CD.md`.
- Al agregar o modificar validaciones automaticas: actualizar el
  documento correspondiente.

## Documentos

- [`CI.md`](./CI.md):
  integracion continua — triggers, gates obligatorios y donde
  consultar resultados.
- [`CD.md`](./CD.md):
  entrega continua — ambientes, proceso de deploy, gates de release
  y procedimiento de rollback.

## Separacion importante

- Los comandos para correr CI localmente van en `../COMMANDS.md`.
- Los archivos de configuracion del pipeline (YAML, Jenkinsfile, etc.)
  viven en el repositorio del proyecto, no en esta carpeta.
- Esta carpeta describe el pipeline; no lo implementa.

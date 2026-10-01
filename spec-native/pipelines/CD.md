# CD.md

Entrega continua del proyecto.

## Objetivo

Describir como el codigo pasa de un cambio mergeado a produccion:
ambientes, gates de promocion, proceso de deploy y rollback.

## Cuando actualizar este archivo

Actualizar cuando cambie un ambiente, se modifiquen los gates de
promocion o cambie el proceso de release.

## Template

### Plataforma

- Plataforma de CD:
- Archivo de configuracion:
- Donde ver el estado de los deploys:

### Ambientes

| Ambiente | Rama o tag | Deploy automatico | Aprobacion requerida |
| --- | --- | --- | --- |
| Desarrollo | | | |
| Staging | | | |
| Produccion | | | |

### Proceso de release

Describe los pasos desde que un cambio esta en la rama principal
hasta que llega a produccion:

1. Paso
2. Paso
3. Paso

### Gates de promocion

Condiciones que deben cumplirse antes de promover a cada ambiente:

| De | A | Gates requeridos |
| --- | --- | --- |
| rama principal | staging | |
| staging | produccion | |

### Variables y secretos

- Donde se gestionan las variables de entorno por ambiente.
- Que variables son obligatorias para que el deploy funcione.
- No documentar valores; solo nombres y proposito.

### Rollback

- Como revertir un deploy fallido en cada ambiente.
- Criterio para activar un rollback.
- Quien tiene autoridad para hacerlo.

### Relacion con specs y tareas

Antes de considerar una iniciativa completamente entregada, verificar
que el cambio fue desplegado al ambiente objetivo y que los gates de
promocion definidos aqui fueron satisfechos.

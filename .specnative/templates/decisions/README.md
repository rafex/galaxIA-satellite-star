# templates/decisions/

Decision snippets del equipo. Cada archivo es una decisión arquitectónica
reutilizable lista para appendarse al `spec-native/DECISIONS.md` del proyecto.

## Formato

```markdown
+++
[snippet]
name        = "nombre-del-snippet"
description = "Qué decisión documenta"
tags        = ["tag1", "tag2"]
+++

### DEC-XXXX — Título de la decisión

- Fecha: {{date}}
- Estado: `proposed`
- Relacionado con specs:
- Contexto: Por qué fue necesaria esta decisión.
- Decisión: Qué se decidió exactamente.
- Consecuencias: Impacto, costos, beneficios.
- Reemplaza: none
```

## Notas

- `DEC-XXXX` se sustituye automáticamente con el siguiente número disponible
- `{{date}}` se sustituye con la fecha actual
- El snippet se appenda al final del archivo `DECISIONS.md`

## Ejemplo

Ver los built-ins como referencia: `list_templates('decision')`

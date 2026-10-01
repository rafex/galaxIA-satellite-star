# templates/specs/

Spec templates del equipo. Cada archivo es un punto de partida para un tipo
de iniciativa. El agente sustituye los placeholders `{{variable}}` con el
contenido real del proyecto.

## Formato

```markdown
+++
[template]
name        = "nombre-del-template"
description = "Para qué tipo de iniciativa"
tags        = ["tag1", "tag2"]
+++

# SPEC.md — {{initiative_name}}

## Resumen
{{summary}}

## Problema
...
```

## Placeholders disponibles

| Placeholder | Valor |
|-------------|-------|
| `{{initiative_name}}` | Nombre de la iniciativa |
| `{{date}}` | Fecha actual (YYYY-MM-DD) |
| `{{owner}}` | Owner de la spec |
| `{{summary}}` | Resumen breve (el agente lo rellena) |

## Ejemplo

Ver los built-ins como referencia: `list_templates('spec')`

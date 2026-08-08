# .specnative/archetypes/

Archetypes locales del equipo. Un archetype es un punto de partida completo
para un tipo de proyecto: documentos de `spec-native/` pre-rellenos con
contenido real del stack o patrón arquitectónico.

## Cuándo crear un archetype propio

- Tu equipo usa el mismo stack en múltiples proyectos
- Tienes convenciones, decisiones base y comandos que se repiten
- Quieres que los nuevos proyectos arranquen con documentación real, no placeholders

## Estructura de un archetype

```
.specnative/archetypes/
└── mi-archetype/
    ├── archetype.toml      ← metadatos (requerido)
    ├── ARCHITECTURE.md     ← pre-relleno (opcional)
    ├── STACK.md            ← pre-relleno (opcional)
    ├── CONVENTIONS.md      ← pre-relleno (opcional)
    ├── COMMANDS.md         ← pre-relleno (opcional)
    ├── DECISIONS.md        ← decisiones base (opcional)
    └── ROADMAP.md          ← dirección inicial (opcional)
```

## archetype.toml

```toml
[archetype]
name        = "mi-archetype"
description = "Descripción del tipo de proyecto"
author      = "tu-nombre"
tags        = ["tag1", "tag2"]
version     = "1.0.0"
language    = "java"        # java | python | typescript | go | rust | etc.
pattern     = "hexagonal"   # hexagonal | layered | microservices | monolith | etc.
```

## Cómo usarlo via MCP

```
list_archetypes()                    → ver todos (built-in + locales)
read_archetype('mi-archetype')       → revisar contenido antes de aplicar
apply_archetype('mi-archetype')      → aplicar a spec-native/ (respeta docs llenos)
apply_archetype('mi-archetype', force=True)  → sobreescribir todo
```

## Archetypes built-in disponibles

Los archetypes built-in están embebidos en el servidor MCP y no requieren archivos:

| Nombre | Stack | Patrón |
|--------|-------|--------|
| `java-hexagonal` | Java 21 + Spring Boot 3 | Hexagonal / Ports & Adapters |

Para ver el contenido de un built-in: `read_archetype('java-hexagonal')`

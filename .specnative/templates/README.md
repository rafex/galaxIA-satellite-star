# .specnative/templates/

Templates reutilizables para documentación SpecNative.

## Dos tipos

### `specs/` — Spec templates
Puntos de partida para tipos comunes de iniciativas.
El agente los usa al crear una nueva spec en lugar de empezar desde cero.

```
specs/
├── mi-feature-spec.md
└── mi-migration-spec.md
```

### `decisions/` — Decision snippets
Fragmentos de `DECISIONS.md` para decisiones arquitectónicas frecuentes.
El agente los appenda al `DECISIONS.md` del proyecto.

```
decisions/
├── mi-decision.md
└── mi-tecnologia.md
```

## Cómo usarlos via MCP

```
list_templates()                                 → ver todos (built-in + locales)
list_templates('spec')                           → solo spec templates
list_templates('decision')                       → solo decision snippets
apply_spec_template('mi-feature', 'user-auth')   → crea spec-native/specs/user-auth/SPEC.md
apply_decision_snippet('mi-decision')            → append a spec-native/DECISIONS.md
```

## Templates built-in disponibles

**Spec templates:**
| Nombre | Para qué |
|--------|----------|
| `feature-rest-endpoint` | Nueva ruta/endpoint REST |
| `db-migration` | Migración de base de datos |
| `module-refactor` | Refactoring de módulo |

**Decision snippets:**
| Nombre | Para qué |
|--------|----------|
| `jwt-authentication` | JWT para autenticación stateless |
| `hexagonal-ports` | Separación domain/infrastructure via puertos |
| `database-choice` | Elección de base de datos |

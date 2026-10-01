# Specs Index

Indice de iniciativas o capacidades definidas como specs separadas.

## Cuando crear una carpeta o archivo aqui

Crear una spec separada cuando:

- el cambio supera una sola sesion de trabajo
- participan varias areas del sistema
- hace falta conservar contexto historico de una iniciativa
- una sola `SPEC.md` ya no alcanza

## Estructura sugerida

Cada iniciativa puede vivir como carpeta o archivo. La opcion preferida
es una carpeta por iniciativa cuando hay mas de un documento.

### Opcion carpeta

```text
spec-native/specs/
  mi-iniciativa/
    README.md
    SPEC.md
```

### Opcion archivo unico

```text
spec-native/specs/
  mi-iniciativa.md
```

## Regla de navegacion

- Si entras a una iniciativa, abre primero su `README.md`.
- Si no existe `README.md`, abre su `SPEC.md`.
- Mantener los nombres de carpetas en kebab-case.
- Toda iniciativa relevante deberia tener tareas asociadas en
  `../tasks/<iniciativa>/`.

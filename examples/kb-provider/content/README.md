# Contenido de ejemplo — NO es un proceso de indexado recomendado

TASK-KB-0002 (SPEC-KB-0001) declara explícitamente que galaxIA no define ni
recomienda cómo un operador cura/indexa una KB — es responsabilidad
exclusiva de quien opera el nodo, fuera del protocolo.

Esta carpeta es el mecanismo más simple posible para tener contenido
consultable en este provider de referencia: cualquier archivo `.txt` que
pongas aquí se carga en memoria al arrancar el proceso. No hay API de
administración, no hay autenticación, no hay actualización en caliente —
adrede, para no confundir esto con una recomendación de diseño.

Un operador real puede reemplazar esto por lo que prefiera (una base de
datos, un CMS, un script de indexado con su propio motor de embeddings)
sin que eso cambie en nada el contrato FHS que expone `kb_query`.

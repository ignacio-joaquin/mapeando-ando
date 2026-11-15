---
name: linear-task
description: >
  Formato de issues en Linear para el proyecto "Mapa Marciano — Space Apps 2026" (equipo Mapeando Ando).
  Trigger: Cuando se pide crear, dividir o redactar una tarea, issue o ticket del proyecto.
metadata:
  author: mapeando-ando
  version: "1.0"
---

## Contexto

El plan y las tareas viven en **Linear**, proyecto *Mapa Marciano — Space Apps 2026*, equipo *Mapeando Ando*. No se usa Jira. Si hay MCP de Linear disponible, crear el issue con esa herramienta; si no, entregar el texto listo para pegar y decirlo.

Es un hackathon con fecha límite: una tarea que no se puede terminar en una sentada se divide.

---

## Formato

**Título**: `<área>: <qué queda hecho>` — imperativo, concreto, sin "mejorar" ni "revisar".

Áreas: `pipeline`, `api`, `web`, `datos`, `deploy`, `docs`.

```
✅ web: capa de pendiente con leyenda y toggle
✅ pipeline: precomputar sombras por hora para Jezero
❌ Mejorar el mapa
❌ Ver tema de los tiles
```

**Cuerpo**:

```markdown
## Qué
Una o dos frases: qué tiene que existir cuando esto esté listo.

## Por qué (para la EVA)
Qué decisión de supervivencia habilita. Si no habilita ninguna, probablemente no va ahora.

## Hecho cuando
- [ ] Criterio verificable 1
- [ ] Criterio verificable 2

## Datos / fuentes
Qué archivos de `sites/*.json` o salidas de `/data/output/` usa. Misión y resolución.

## Notas
Dependencias, riesgos, decisiones abiertas.
```

---

## Reglas

### Una tarea = un área

Si toca pipeline y web, son dos issues: el de datos primero, el de UI bloqueado por él. El contrato entre los dos (nombre del archivo de salida, forma del JSON, id de capa) se escribe en el issue del pipeline.

### Prioridad por valor para la EVA

El core value es que alguien en la superficie de Marte pueda decidir mejor. Una tarea que no mueve eso (refactor, pulido visual, abstracción) es `Low` y espera.

### Siempre citar la fuente de datos

Toda tarea que produzca un número o una capa dice de qué dato real de la NASA sale. Si no hay fuente, la primera tarea es encontrarla, no estimarla.

### Scope realista

Nada de tareas de varios días. Si no entra en una sentada, dividir y dejar las dependencias explícitas.

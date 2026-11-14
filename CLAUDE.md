# CLAUDE.md

Configuración de IA de **Mapa Marciano** (Mapeando Ando · NASA Space Apps 2026).
Este archivo lo lee Claude Code en cada sesión de forma automática.

## Leé esto primero, siempre

@docs/context.md

Ese archivo es la fuente única de contexto del proyecto: core value, arquitectura, stack, reglas duras, cómo trabajamos y decisiones abiertas. **No repitas su contenido acá**: si una decisión del proyecto cambia, se edita `docs/context.md`.

---

## Reglas de sesión

1. **Ramas.** Commiteá y pusheá a **`Dana`**. Nunca a `main`: cada push a `main` se auto-despliega al server en menos de un minuto. `main` se actualiza solo por PR aprobado.
2. **Secretos.** El repo es público. Nunca escribas en el repo claves, tokens, la IP del server ni el nombre del bucket, ni siquiera en un ejemplo o un comentario.
3. **Datos de la NASA.** Antes de escribir cualquier cosa que haga pedidos HTTP a servidores de la NASA/USGS/PDS, leé la skill `mapeando-geodata`. El `Crawl-delay` no es opcional.
4. **No inventes datos.** Si falta un valor científico, decí que falta. Jamás rellenes con una estimación presentada como medición.
5. **Contratos.** `files[].key` de `sites/*.json`, los ids de capa del mapa y las rutas `/api/*` los consume más de una pieza: si cambiás uno, actualizá todas las puntas en el mismo PR.
6. **Cambios de alcance.** Si lo que te piden implica una decisión de arquitectura o toca una de las "decisiones abiertas" de `docs/context.md`, pará y preguntá antes de escribir código.

## Idioma

Código, identificadores, endpoints y nombres de archivo en inglés. Comentarios, documentación, mensajes de commit, PRs y textos de la UI en español (rioplatense, sin solemnidad).

---

## Skills: cuál usar y cuándo

Viven en `.claude/skills/`, versionadas en el repo para que todo el equipo use las mismas.
Leé la skill **antes** de escribir código del área, no después.

### Propias del proyecto

| Skill | Cuándo |
|---|---|
| `mapeando-geodata` | `pipeline/`, descargas de PDS/USGS, rasterio/GDAL, SPICE, precómputo de capas |
| `mapeando-sites` | crear o editar cualquier cosa en `sites/` |
| `mapeando-api` | `api/`, endpoints, contratos que consume `web/` |
| `mapeando-maplibre` | el mapa de `web/`: capas, tiles, landmarks, planificador 4D |
| `mapeando-deploy` | `deploy/`, nginx, systemd, CI, entorno, y antes de mergear a `main` |
| `linear-task` | redactar o dividir tareas del proyecto en Linear |

### Externas (de [Gentleman-Skills](https://github.com/Gentleman-Programming/Gentleman-Skills), curated)

| Skill | Cuándo |
|---|---|
| `react-19` | componentes React (sin memoización manual: React Compiler) |
| `typescript` | cualquier `.ts` / `.tsx` |
| `tailwind-4` | estilos |
| `zustand-5` | estado del frontend |
| `zod-4` | validar lo que entra de la API o de un JSON de datos |
| `pytest` | tests de `api/` y `pipeline/` |
| `playwright` | E2E del mapa |
| `github-pr` | abrir PRs, conventional commits |
| `skill-creator` | crear o editar una skill de este repo |

Si el trabajo cruza áreas, aplican varias: tocar el mapa suele ser `mapeando-maplibre` + `react-19` + `typescript` + `tailwind-4`.

## Cómo mantener esto

- Skills externas: están **copiadas**, no linkeadas. Para actualizarlas, `bash .claude/update-skills.sh` y revisar el diff en un PR.
- Skill nueva o cambio en una propia: usá `skill-creator` y mandalo por PR. Nadie edita `.claude/skills/` solo en su máquina.
- Decisión nueva del proyecto: va a `docs/context.md`, no acá.

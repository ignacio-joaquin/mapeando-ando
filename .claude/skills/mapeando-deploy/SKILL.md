---
name: mapeando-deploy
description: >
  Server, auto-deploy, systemd, nginx y secretos de Mapa Marciano. Qué rompe producción y qué no.
  Trigger: Al tocar deploy/, nginx, systemd, CI, variables de entorno, o antes de mergear a main.
metadata:
  author: mapeando-ando
  version: "1.0"
---

## El hecho central

**Cada push a `main` se despliega solo en menos de un minuto.** Un timer de systemd corre `deploy/update.sh` cada minuto: `git fetch origin main` y, si hay commits nuevos, `git reset --hard origin/main`, reinstala requirements si cambiaron, reinicia `mapeando-api.service` y recarga nginx. Si cambió algo en `deploy/`, vuelve a correr `bootstrap.sh` completo.

Consecuencias que no se negocian:

- `main` es producción. No se commitea directo (ver `CLAUDE.md`): se trabaja en `Dana` y se mergea por PR revisado.
- `git reset --hard` borra cualquier cosa no commiteada que haya en `/opt/mapeando-ando`. **Nunca** escribir datos dentro del repo en el server: todo bajo `/data`.
- Un `deploy/*.sh` roto deja el server sin recuperación automática. El CI corre `bash -n deploy/*.sh`; eso solo valida sintaxis, no lógica.
- Cambiar `deploy/` relanza el bootstrap: tiene que ser **idempotente**.

---

## Mapa del server

| Qué | Dónde |
|---|---|
| Repo | `/opt/mapeando-ando` (lo pisa el auto-deploy) |
| Datos crudos | `/data/raw/<sitio>/` |
| Salidas precomputadas | `/data/output/<sitio>/` → servidas en `/tiles/` |
| Inventario | `/data/manifest.json` |
| Entorno / secretos | `/etc/mapeando.env` (fuera del repo) |
| Log de deploy | `/var/log/mapeando-deploy.log` |
| venvs | `.venv-api`, `.venv-pipeline` |
| Instancia | AWS EC2, us-east-2 (Ohio), Ubuntu 24.04. IP en Linear, no en el repo |

Servicios: `mapeando-api.service`, `mapeando-download.service`, `mapeando-autodeploy.timer`.

```bash
GET /api/health                         # qué commit corre y si hay datos
journalctl -u mapeando-api -f            # logs de la API
journalctl -u mapeando-download -f       # progreso de la descarga
tail -f /var/log/mapeando-deploy.log     # historial de deploys
```

---

## Secretos

El repo es **público**. Nunca commitear IPs del server, claves, tokens de NASA, credenciales de AWS ni nombres de bucket. Todo eso vive en `/etc/mapeando.env` o en el rol IAM de la instancia (`aws s3 ...` funciona sin credenciales propias). Si una URL necesita API key, se lee de entorno y el default es "sin key".

---

## Antes de mergear a main

- [ ] CI verde (sintaxis Python, JSON de sitios válidos, `bash -n deploy/*.sh`).
- [ ] Si cambió `deploy/`: probado en el server o revisado línea por línea, e idempotente.
- [ ] Si cambió `api/requirements.txt` o `pipeline/requirements.txt`: versiones pineadas (y NumPy sigue en 1.x).
- [ ] Nada escribe dentro del repo en runtime.
- [ ] Cero secretos en el diff.
- [ ] Alguien mirando `/api/health` y los logs justo después del merge.

## Anti-patrones

- ❌ Push directo a `main` "porque es chico".
- ❌ Mergear a `main` sin nadie disponible para revertir.
- ❌ `sudo systemctl stop mapeando-autodeploy.timer` y olvidarse: el server queda congelado y nadie se entera.
- ❌ Instalar paquetes a mano en el server en vez de ponerlos en `requirements.txt` o `bootstrap.sh`: el próximo bootstrap los borra.

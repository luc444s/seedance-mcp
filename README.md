# Seedance MCP

Servidor MCP (stdio) para generar video con **Seedance 2.0** de ByteDance/Ark, accesible desde OpenClaw como cualquier otra herramienta.

Cero dependencias: solo `node:crypto` y `fetch`. Requiere Node 20+.

## Instalación

```bash
git clone https://github.com/luc444s/seedance-mcp
cd seedance-mcp
cp .env.example .env      # rellena SEEDANCE_API_KEY
bash scripts/install.sh
```

El instalador busca las credenciales en, por orden:
1. Variables de entorno (`SEEDANCE_API_KEY`, `R2_*`)
2. `SEEDANCE_ENV_FILES="/a/.env /b/.env"`
3. `./.env`, `../../backend/.env`, `~/Proyectos/orquestador_ardi/backend/.env`

Después las persiste en `$OPENCLAW_STATE_DIR/seedance.env` con `chmod 600` y registra el server con `openclaw mcp add`.

Verifica con:

```bash
openclaw mcp probe seedance    # -> 5 tools
```

## Seguridad

**Ninguna credencial se versiona.** Para que no dependa de que me acuerde:

| Mecanismo | Qué hace |
|---|---|
| `.gitignore` | Ignora `.env*`, `seedance.env`, `state/`, `*.mp4`, `*.mov` |
| `.env.example` | Plantilla con los nombres de variable, todos vacíos |
| `scripts/audit-secrets.mjs` | Escanea el repo y **falla** si encuentra una clave |
| CI | Corre el auditor en cada push y PR |

Reglas que detecta el auditor: `oc_sk_*`, `ark-*`, `AKIA*`, firmas TOS, `Bearer <literal>`, claves privadas PEM, y cualquier valor asignado a una variable sensible que no sea un placeholder o una indirección (`$OTRA_VAR`).

```bash
npm run audit
```

## Herramientas

| Tool | Qué hace |
|---|---|
| `seedance_generate` | Crea un video (t2v / i2v / **v2v**). `wait:true` espera y devuelve la URL. |
| `seedance_status` | Consulta el estado de una tarea por id. |
| `seedance_wait` | Espera a que una tarea termine y devuelve la URL. |
| `seedance_archive` | Sube el video a Cloudflare R2 y devuelve una URL **permanente**. |
| `seedance_list` | Lista las tareas registradas localmente. |

## R2 (archivos permanentes)

Las URLs de ByteDance están firmadas por TOS y **expiran en 24h**. Para conservar un resultado o reutilizarlo como referencia de v2v hay que publicarlo en Cloudflare R2.

Dos formas:

```jsonc
// 1. Al generar, con archive:true → devuelve publicUrl además de videoUrl
{ "prompt": "...", "archive": true }

// 2. Después, sobre una tarea existente (o directamente una URL de video)
seedance_archive({ "taskId": "cgt-2026...", "key": "seedance/mi-video.mp4" })
```

Config (el instalador las lee de `backend/.env`):

```
R2_ENABLED=true
R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
R2_BUCKET=ai-hopper-assets
R2_PUBLIC_URL=https://aihopper.sihuen8.workers.dev
```

`scripts/r2.mjs` implementa el PUT con AWS SigV4 usando solo `node:crypto` — sin boto3 ni dependencias extra. Si R2 no está configurado, el server sigue funcionando y solo lo avisa en `archiveError`.

## Modos soportados

| Modo | Parámetro | Payload |
|---|---|---|
| text-to-video | solo `prompt` | `{type:"text"}` |
| image-to-video | `imageUrl` | + `{type:"image_url"}` |
| video-to-video | `videoUrls[]` | + `{type:"video_url", role:"reference_video"}` |

En v2v el `prompt` es una **instrucción de qué cambiar** (movimiento de cámara, transposición de estilo, etc.), no una descripción completa.

Restricciones de v2v (verificadas contra la API): máx **3 videos**, duración total **≤15s**, formatos **mp4/mov**. La URL debe ser pública y accesible para ByteDance.

## Tiempos reales medidos

| Modo | Duración |
|---|---|
| t2v 5s 480p | ~40s |
| v2v 5s 480p | ~6 min |

Por eso el server da **900s de presupuesto automático** cuando detecta `videoUrls`. Para v2v conviene `wait: false` y consultar después.

## Parámetros de `seedance_generate`

| Campo | Tipo | Default | Notas |
|---|---|---|---|
| `prompt` | string | — | Requerido. Inglés o chino. |
| `imageUrl` | string | — | URL pública → modo image-to-video |
| `videoUrls` | string[] | — | URLs públicas de videos de referencia → modo v2v. Máx 3, ≤15s total |
| `model` | string | `dreamina-seedance-2-0-260128` | |
| `resolution` | enum | `720p` | `480p` / `720p` / `1080p` |
| `duration` | number | `5` | 2–12s |
| `ratio` | string | — | `16:9`, `9:16`, `1:1`, `4:3`, `21:9` |
| `generateAudio` | boolean | `true` | Seedance 2.0 genera audio nativo |
| `watermark` | boolean | `false` | |
| `cameraFixed` | boolean | — | |
| `seed` | number | — | Reproducibilidad |
| `wait` | boolean | `true` | `false` devuelve solo el taskId |
| `pollInterval` | number | `5` | segundos entre polls |

## Formato de prompt recomendado

El prompt canónico de Seedance:

```
FORMAT: cinematic 8-second single shot.
SUBJECT: a lone lighthouse keeper walking across a rain-slicked pier.
ENVIRONMENT: stormy North Atlantic night, crashing waves, heavy fog.
MOOD: solitary, tense.
STYLE: anamorphic, shallow depth of field, teal-orange grade.
LOGIC RULE: camera moves slowly, subject stays centered.
NEGATIVE PROMPT: no text, no watermark, no distortion.
SHOT 1: slow dolly-in following him from behind.
```

Máximo recomendado: 800 caracteres.

## Notas importantes

- **Las URLs expiran en 24h** (firma TOS). Si necesitás el archivo permanente, descargalo y subilo a R2/CDN.
- El timeout de polling por defecto es 300s (`SEEDANCE_POLL_MAX`). Un video de 10s suele tardar 1–3 min.
- Seedance 2.0 es el único con soporte de audio nativo y refs multimodales; los modelos 1.x degradan a first/last frame.
- Los videos se registran en `$SEEDANCE_STATE_DIR` (default `/tmp/seedance-mcp`).

## Verificación manual

```bash
KEY=$(grep '^SEEDANCE_API_KEY=' ../../backend/.env | cut -d= -f2)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | SEEDANCE_API_KEY="$KEY" node scripts/seedance-mcp.mjs
```

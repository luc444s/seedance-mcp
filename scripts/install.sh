#!/bin/bash
# Registra el servidor MCP de Seedance en OpenClaw.
#
#   bash scripts/install.sh
#   OPENCLAW_BIN=/ruta/a/openclaw bash scripts/install.sh
#   SEEDANCE_ENV_FILES="/a/.env /b/.env" bash scripts/install.sh
#
# Las credenciales se leen del entorno o de archivos .env. Nunca se escriben
# dentro del repo: quedan en $OPENCLAW_STATE_DIR/seedance.env con permisos 600.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/seedance-mcp.mjs"

# --- binario de openclaw -----------------------------------------------------
if [ -z "${OPENCLAW_BIN:-}" ]; then
  for candidate in \
    "$ROOT_DIR/node_modules/.bin/openclaw" \
    "$ROOT_DIR/../lesnaclaw/runtime/node_modules/.bin/openclaw" \
    "$(command -v openclaw 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then OPENCLAW_BIN="$candidate"; break; fi
  done
fi
if [ -z "${OPENCLAW_BIN:-}" ] || [ ! -x "$OPENCLAW_BIN" ]; then
  echo "No encuentro el binario de openclaw. Define OPENCLAW_BIN=/ruta/a/openclaw" >&2
  exit 1
fi

# Estado de OpenClaw. Respeta el que el usuario ya tenga definido.
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
STATE_DIR="${SEEDANCE_STATE_DIR:-$OPENCLAW_STATE_DIR}"

# Donde OpenClaw deja los archivos que el usuario sube al chat. Permite que
# seedance_upload resuelva un id de media a un path real sin que el agente
# tenga que adivinar la ruta. Detecta el layout comun del gateway aislado.
if [ -z "${OPENCLAW_MEDIA_DIR:-}" ]; then
  for candidate in \
    "$OPENCLAW_STATE_DIR/media/inbound" \
    "$ROOT_DIR/../lesnaclaw/runtime/state/media/inbound" \
    "$HOME/.openclaw/media/inbound"; do
    if [ -d "$candidate" ]; then OPENCLAW_MEDIA_DIR="$candidate"; break; fi
  done
fi

# --- carga de .env -----------------------------------------------------------
# Lee una variable ignorando comentarios y comillas.
load_env() {
  local file="$1" var="$2" val
  [ -f "$file" ] || return 1
  val="$(grep -E "^[[:space:]]*${var}=" "$file" | tail -1 | cut -d= -f2- \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")"
  [ -n "$val" ] || return 1
  printf '%s' "$val"
}

# Candidatos en orden de prioridad. SEEDANCE_ENV_FILES separa con espacios.
ENV_FILES=()
if [ -n "${SEEDANCE_ENV_FILES:-}" ]; then
  # shellcheck disable=SC2206
  ENV_FILES+=($SEEDANCE_ENV_FILES)
fi
ENV_FILES+=(
  "$ROOT_DIR/.env"
  "$ROOT_DIR/../../backend/.env"
  "$HOME/Proyectos/orquestador_ardi/backend/.env"
)

env_get() {
  local var="$1" f val
  for f in "${ENV_FILES[@]}"; do
    val="$(load_env "$f" "$var" || true)"
    if [ -n "$val" ]; then printf '%s' "$val"; return 0; fi
  done
  return 1
}

[ -n "${SEEDANCE_API_KEY:-}" ] || SEEDANCE_API_KEY="$(env_get SEEDANCE_API_KEY || true)"
if [ -z "${SEEDANCE_API_KEY:-}" ]; then
  echo "Falta SEEDANCE_API_KEY (env, .env local, o define SEEDANCE_ENV_FILES)" >&2
  exit 1
fi
[ -n "${SEEDANCE_BASE_URL:-}" ] || SEEDANCE_BASE_URL="$(env_get SEEDANCE_BASE_URL || true)"
SEEDANCE_BASE_URL="${SEEDANCE_BASE_URL:-https://ark.ap-southeast.bytepluses.com}"

mkdir -p "$STATE_DIR"

# R2 es opcional: sin el, el server funciona pero los videos duran 24h.
R2_VARS=(R2_ENABLED R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_PUBLIC_URL)
MCP_ENV=(
  --env "SEEDANCE_API_KEY=$SEEDANCE_API_KEY"
  --env "SEEDANCE_BASE_URL=$SEEDANCE_BASE_URL"
  --env "SEEDANCE_STATE_DIR=$STATE_DIR"
)
[ -n "${OPENCLAW_MEDIA_DIR:-}" ] && MCP_ENV+=(--env "OPENCLAW_MEDIA_DIR=$OPENCLAW_MEDIA_DIR")

R2_BUCKET_RESOLVED=""
for var in "${R2_VARS[@]}"; do
  [ -n "${!var:-}" ] || continue
  MCP_ENV+=(--env "$var=${!var}")
  [ "$var" = "R2_BUCKET" ] && R2_BUCKET_RESOLVED="${!var}"
done
for var in "${R2_VARS[@]}"; do
  val="$(env_get "$var" || true)"
  [ -n "$val" ] || continue
  MCP_ENV+=(--env "$var=$val")
  [ "$var" = "R2_BUCKET" ] && R2_BUCKET_RESOLVED="$val"
done

if [ -n "${OPENCLAW_MEDIA_DIR:-}" ]; then
  echo "[seedance] media de OpenClaw: $OPENCLAW_MEDIA_DIR"
else
  echo "[seedance] sin OPENCLAW_MEDIA_DIR; seedance_upload necesitara rutas absolutas"
fi
if [ -n "$R2_BUCKET_RESOLVED" ]; then
  echo "[seedance] R2 habilitado: bucket=$R2_BUCKET_RESOLVED"
else
  echo "[seedance] R2 no configurado; los videos quedaran con URL temporal de 24h"
fi

# --- persistencia de credenciales -------------------------------------------
{
  echo "# Generado por seedance install.sh. No versionar. chmod 600."
  echo "SEEDANCE_API_KEY=$SEEDANCE_API_KEY"
  echo "SEEDANCE_BASE_URL=$SEEDANCE_BASE_URL"
  echo "SEEDANCE_STATE_DIR=$STATE_DIR"
  [ -n "${OPENCLAW_MEDIA_DIR:-}" ] && echo "OPENCLAW_MEDIA_DIR=$OPENCLAW_MEDIA_DIR"
  if [ -n "$R2_BUCKET_RESOLVED" ]; then
    for var in "${R2_VARS[@]}"; do
      val="$(env_get "$var" || true)"
      [ -n "${!var:-}" ] || [ -n "$val" ] || continue
      echo "$var=${!var:-$val}"
    done
  fi
} > "$STATE_DIR/seedance.env"
chmod 600 "$STATE_DIR/seedance.env"
echo "[seedance] credenciales en $STATE_DIR/seedance.env"

# --- registro MCP -------------------------------------------------------------
# `mcp add` falla si el nombre ya existe, asi que se limpia la entrada previa.
# Las credenciales viajan por --env, nunca como argumentos visibles en `ps`.
python3 - "$OPENCLAW_STATE_DIR/openclaw.json" <<'PY'
import json, os, sys

path = sys.argv[1]
if not os.path.exists(path):
    raise SystemExit(0)

with open(path) as fh:
    config = json.load(fh)

servers = config.get("mcp", {}).get("servers", {})
if servers.pop("seedance", None) is not None:
    with open(path, "w") as fh:
        json.dump(config, fh, indent=2, ensure_ascii=False)
    print("[seedance] entrada previa eliminada de mcp.servers")
PY

"$OPENCLAW_BIN" mcp add seedance \
  --command node \
  --arg "$SCRIPT" \
  "${MCP_ENV[@]}"

"$OPENCLAW_BIN" mcp list 2>&1 | grep -i seedance || true

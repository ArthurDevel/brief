#!/usr/bin/env bash

set -euo pipefail

# ============================================================================
# CONSTANTS
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
USE_QUICK_TUNNEL=false
SKIP_WEBHOOK=false
SHUTDOWN_IN_PROGRESS=false
TUNNEL_LOG=""
TUNNEL_PID=""
SERVER_PID=""


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

cleanup() {
  if [[ "$SHUTDOWN_IN_PROGRESS" == true ]]; then
    return
  fi

  SHUTDOWN_IN_PROGRESS=true

  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  if [[ -n "$TUNNEL_PID" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi

  if [[ -n "$TUNNEL_LOG" ]] && [[ -f "$TUNNEL_LOG" ]]; then
    rm -f "$TUNNEL_LOG"
  fi
}

handle_interrupt() {
  cleanup
  exit 130
}

load_environment() {
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
  fi
}

install_dependencies() {
  if [[ ! -d "$SCRIPT_DIR/.venv" ]]; then
    python3 -m venv "$SCRIPT_DIR/.venv"
  fi

  source "$SCRIPT_DIR/.venv/bin/activate"
  python -m pip install -r "$SCRIPT_DIR/requirements.txt"
}

start_quick_tunnel() {
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared is required for --quick-tunnel" >&2
    exit 1
  fi

  TUNNEL_LOG="$(mktemp)"
  cloudflared tunnel --url "http://localhost:$PORT" >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  for _ in $(seq 1 30); do
    PUBLIC_URL="$(grep -oE 'https://[a-zA-Z0-9._-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
    if [[ -n "${PUBLIC_URL:-}" ]]; then
      export PUBLIC_URL
      echo "Quick tunnel ready at $PUBLIC_URL"
      return
    fi
    sleep 1
  done

  echo "Could not determine Cloudflare quick tunnel URL." >&2
  cat "$TUNNEL_LOG" >&2
  exit 1
}

configure_twilio_webhook() {
  if [[ "$SKIP_WEBHOOK" == true ]]; then
    return
  fi

  if [[ -z "${PUBLIC_URL:-}" || -z "${TWILIO_PHONE_NUMBER:-}" ]]; then
    return
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to configure the Twilio webhook" >&2
    exit 1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    echo "jq is required to configure the Twilio webhook" >&2
    exit 1
  fi

  if [[ -z "${TWILIO_ACCOUNT_SID:-}" || -z "${TWILIO_AUTH_TOKEN:-}" ]]; then
    echo "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required to configure the webhook" >&2
    exit 1
  fi

  ENCODED_PHONE="$(python - <<PY
import urllib.parse
print(urllib.parse.quote("${TWILIO_PHONE_NUMBER}", safe=""))
PY
)"

  LOOKUP_URL="https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers.json?PhoneNumber=$ENCODED_PHONE"
  PHONE_SID="$(curl -s -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" "$LOOKUP_URL" | jq -r '.incoming_phone_numbers[0].sid // ""')"

  if [[ -z "$PHONE_SID" ]]; then
    echo "Could not find the Twilio phone number SID for $TWILIO_PHONE_NUMBER" >&2
    exit 1
  fi

  curl -s -X POST \
    "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/$PHONE_SID.json" \
    -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
    --data-urlencode "VoiceUrl=$PUBLIC_URL/twilio/voice" \
    --data-urlencode "VoiceMethod=POST" \
    >/dev/null

  echo "Twilio webhook configured: $PUBLIC_URL/twilio/voice"
}

start_server() {
  echo "Starting bridge server on http://localhost:$PORT"
  python "$SCRIPT_DIR/bridge_server.py" &
  SERVER_PID=$!
  wait "$SERVER_PID"
}


# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

for arg in "$@"; do
  case "$arg" in
    --quick-tunnel) USE_QUICK_TUNNEL=true ;;
    --skip-webhook) SKIP_WEBHOOK=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

trap cleanup EXIT
trap handle_interrupt INT TERM

install_dependencies
load_environment

PORT="${PORT:-8780}"

if [[ "$USE_QUICK_TUNNEL" == true ]]; then
  start_quick_tunnel
fi

configure_twilio_webhook
start_server

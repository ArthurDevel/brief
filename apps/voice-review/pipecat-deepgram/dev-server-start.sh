#!/usr/bin/env bash
#
# Start the voice-review Pipecat server locally, optionally fronted by a
# Cloudflare tunnel so Twilio can reach it.
#
# Usage:
#   ./dev-server-start.sh                # shared named dev tunnel (default)
#   ./dev-server-start.sh --quick-tunnel # disposable quick tunnel
#   ./dev-server-start.sh --named-tunnel # shared named dev tunnel
#   ./dev-server-start.sh --no-tunnel    # local only

set -euo pipefail

NO_TUNNEL=false
QUICK_TUNNEL=false
NAMED_TUNNEL=true
for arg in "$@"; do
  case "$arg" in
    --no-tunnel) NO_TUNNEL=true ;;
    --quick-tunnel) QUICK_TUNNEL=true; NAMED_TUNNEL=false ;;
    --named-tunnel) QUICK_TUNNEL=false; NAMED_TUNNEL=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ ! -d "$SCRIPT_DIR/.venv" ]]; then
  echo "Creating virtual environment..."
  python3 -m venv "$SCRIPT_DIR/.venv"
fi
source "$SCRIPT_DIR/.venv/bin/activate"
pip install -r "$SCRIPT_DIR/requirements.txt"

if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

PORT="${PORT:-7860}"

if [[ "$NO_TUNNEL" == true ]]; then
  echo "=== Starting without tunnel (local only) ==="
  echo "  http://localhost:$PORT"
  echo ""
  cd "$SCRIPT_DIR"
  exec python3 -m uvicorn server:app --host 0.0.0.0 --port "$PORT"
fi

if ! command -v cloudflared &>/dev/null; then
  echo "ERROR: cloudflared is not installed. brew install cloudflared" >&2
  exit 1
fi

TUNNEL_LOG="$SCRIPT_DIR/.cloudflared.log"
TUNNEL_PID=""

cleanup() {
  echo ""
  if [[ -n "$TUNNEL_PID" ]]; then
    echo "Shutting down tunnel (PID $TUNNEL_PID)..."
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

TUNNEL_URL=""

if [[ "$QUICK_TUNNEL" == true ]]; then
  MAX_TUNNEL_RETRIES=3
  for attempt in $(seq 1 $MAX_TUNNEL_RETRIES); do
    echo "Starting Cloudflare quick tunnel on port $PORT (attempt $attempt/$MAX_TUNNEL_RETRIES)..."
    echo "cloudflared log: $TUNNEL_LOG"

    > "$TUNNEL_LOG"
    cloudflared tunnel --url "http://localhost:$PORT" 2>"$TUNNEL_LOG" &
    TUNNEL_PID=$!

    for _ in $(seq 1 30); do
      TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9_-]+(-[a-zA-Z0-9_-]+)+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)
      if [[ -n "$TUNNEL_URL" ]]; then
        break 2
      fi
      if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
        break
      fi
      sleep 1
    done

    echo "Tunnel attempt $attempt failed."
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
    TUNNEL_PID=""

    if [[ $attempt -lt $MAX_TUNNEL_RETRIES ]]; then
      echo "Retrying in 5 seconds..."
      sleep 5
    fi
  done

  if [[ -z "$TUNNEL_URL" ]]; then
    echo "Failed to start quick tunnel after $MAX_TUNNEL_RETRIES attempts." >&2
    echo "--- cloudflared log ---" >&2
    cat "$TUNNEL_LOG" >&2
    echo "--- end log ---" >&2
    exit 1
  fi
else
  if [[ "$NAMED_TUNNEL" != true ]]; then
    echo "Internal error: expected named tunnel mode." >&2
    exit 1
  fi

  if [[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
    echo "ERROR: CLOUDFLARE_TUNNEL_TOKEN is not set." >&2
    echo "  Add it to .env or use the default quick tunnel." >&2
    exit 1
  fi

  if [[ -z "${CLOUDFLARE_TUNNEL_URL:-}" ]]; then
    echo "ERROR: CLOUDFLARE_TUNNEL_URL is not set." >&2
    echo "  Add it to .env or use the default quick tunnel." >&2
    exit 1
  fi

  echo "Starting named Cloudflare tunnel..."
  echo "Using shared dev tunnel; binding review server to port $PORT."
  echo "cloudflared log: $TUNNEL_LOG"
  cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" 2>"$TUNNEL_LOG" &
  TUNNEL_PID=$!

  sleep 3
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "ERROR: Named tunnel failed to start." >&2
    echo "--- cloudflared log ---" >&2
    cat "$TUNNEL_LOG" >&2
    echo "--- end log ---" >&2
    exit 1
  fi

  TUNNEL_URL="$CLOUDFLARE_TUNNEL_URL"
fi

export PUBLIC_URL="$TUNNEL_URL"

echo "Active public URL: $TUNNEL_URL"
echo "PUBLIC_URL overridden for this process."
echo "cloudflared log: $TUNNEL_LOG"
echo ""

cd "$SCRIPT_DIR"
exec python3 -m uvicorn server:app --host 0.0.0.0 --port "$PORT"

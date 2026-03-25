#!/usr/bin/env bash
#
# Start a Cloudflare tunnel and configure Twilio phone number webhooks
# to point at it, then start the voice pipeline server.
#
# By default, uses a named Cloudflare tunnel (requires a one-time setup in the
# Cloudflare Zero Trust dashboard). Use --quick-tunnel to fall back to a
# disposable quick tunnel (subject to rate limits).
#
# Phone numbers are fetched from the company_phone_numbers table (environment=dev).
# If no dev numbers are configured, the server starts without Twilio webhooks.
#
# Required env vars (from .env or exported):
#   TWILIO_ACCOUNT_SID         - Twilio account SID
#   TWILIO_AUTH_TOKEN           - Twilio auth token
#   SUPABASE_URL                - Supabase project URL
#   SUPABASE_SERVICE_ROLE_KEY   - Supabase service role key
#
# For named tunnel (default):
#   CLOUDFLARE_TUNNEL_TOKEN    - Tunnel token from Cloudflare Zero Trust dashboard
#   CLOUDFLARE_TUNNEL_URL      - Public URL of the tunnel (e.g. https://dev-voice.yourdomain.com)
#
# Usage:
#   ./dev-server-start.sh                # named tunnel (default)
#   ./dev-server-start.sh --quick-tunnel # disposable quick tunnel (rate limited)
#   ./dev-server-start.sh --no-tunnel    # local only, no tunnel or Twilio setup

set -euo pipefail

NO_TUNNEL=false
QUICK_TUNNEL=false
for arg in "$@"; do
  case "$arg" in
    --no-tunnel) NO_TUNNEL=true ;;
    --quick-tunnel) QUICK_TUNNEL=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Create venv and install dependencies if needed
if [[ ! -d "$SCRIPT_DIR/.venv" ]]; then
  echo "Creating virtual environment..."
  python3 -m venv "$SCRIPT_DIR/.venv"
fi
source "$SCRIPT_DIR/.venv/bin/activate"
pip install -r "$SCRIPT_DIR/requirements.txt"

# Load .env if present
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

PORT="${PORT:-7860}"
export APP_ENVIRONMENT=dev

# Type check -- catch type errors, bad method calls, missing args, etc.
echo "Running type check..."
cd "$SCRIPT_DIR"
if ! python3 -m pyright src/; then
  echo "ERROR: Type check failed. Fix the errors above before starting." >&2
  exit 1
fi
echo "Type check passed."

if [[ "$NO_TUNNEL" == true ]]; then
  echo "=== Starting without tunnel (local only) ==="
  echo "  http://localhost:$PORT"
  echo ""
  cd "$SCRIPT_DIR"
  exec python3 -m uvicorn src.server:app --host 0.0.0.0 --port "$PORT"
fi

# Validate Twilio credentials
for var in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is not set. Add it to .env or export it." >&2
    exit 1
  fi
done

# Check dependencies
if ! command -v cloudflared &>/dev/null; then
  echo "ERROR: cloudflared is not installed. brew install cloudflared" >&2
  exit 1
fi

if ! command -v curl &>/dev/null; then
  echo "ERROR: curl is not installed." >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is not installed. brew install jq" >&2
  exit 1
fi

TUNNEL_LOG=$(mktemp)
TUNNEL_PID=""

cleanup() {
  echo ""
  if [[ -n "$TUNNEL_PID" ]]; then
    echo "Shutting down tunnel (PID $TUNNEL_PID)..."
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
  rm -f "$TUNNEL_LOG"
}
trap cleanup EXIT

TUNNEL_URL=""

if [[ "$QUICK_TUNNEL" == true ]]; then
  # --- Quick tunnel (disposable, rate limited) ---
  MAX_TUNNEL_RETRIES=3
  for attempt in $(seq 1 $MAX_TUNNEL_RETRIES); do
    echo "Starting Cloudflare quick tunnel on port $PORT (attempt $attempt/$MAX_TUNNEL_RETRIES)..."

    > "$TUNNEL_LOG"
    cloudflared tunnel --url "http://localhost:$PORT" 2>"$TUNNEL_LOG" &
    TUNNEL_PID=$!

    for i in $(seq 1 30); do
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
  # --- Named tunnel (default) ---
  if [[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
    echo "ERROR: CLOUDFLARE_TUNNEL_TOKEN is not set." >&2
    echo "  Get it from: Cloudflare Zero Trust dashboard -> Networks -> Tunnels -> your tunnel -> Configure -> Token" >&2
    echo "  Add it to your .env file." >&2
    exit 1
  fi

  if [[ -z "${CLOUDFLARE_TUNNEL_URL:-}" ]]; then
    echo "ERROR: CLOUDFLARE_TUNNEL_URL is not set." >&2
    echo "  This is the public URL of your tunnel (e.g. https://dev-voice.yourdomain.com)." >&2
    echo "  Find it in: Cloudflare Zero Trust dashboard -> Networks -> Tunnels -> your tunnel -> Public Hostname" >&2
    echo "  Add it to your .env file." >&2
    exit 1
  fi

  echo "Starting named Cloudflare tunnel..."
  cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" 2>"$TUNNEL_LOG" &
  TUNNEL_PID=$!

  # Wait briefly to make sure cloudflared doesn't crash on startup
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

echo "Tunnel URL: $TUNNEL_URL"

# Fetch dev phone numbers from company_phone_numbers table
WEBHOOK_URL="$TUNNEL_URL/twilio/voice"
PHONE_NUMBERS_JSON=$(curl -s -X GET \
  "${SUPABASE_URL}/rest/v1/company_phone_numbers?environment=eq.dev&is_active=eq.true" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}")

PHONE_COUNT=$(echo "$PHONE_NUMBERS_JSON" | jq 'length')

if [[ "$PHONE_COUNT" -eq 0 ]]; then
  echo ""
  echo "WARNING: No dev phone numbers found in company_phone_numbers table."
  echo "  Add one with: ./scripts/add-company-phone.sh --phone \"+1...\" --country US --label \"United States\" --env dev --webhook-url \"$TUNNEL_URL\""
  echo "  Continuing without Twilio webhook setup."
  echo ""
else
  # Configure webhook for each dev phone number
  echo "Configuring webhooks for $PHONE_COUNT dev phone number(s)..."
  echo "$PHONE_NUMBERS_JSON" | jq -c '.[]' | while read -r row; do
    PHONE=$(echo "$row" | jq -r '.phone_number')
    LABEL=$(echo "$row" | jq -r '.label')

    # URL-encode the phone number (+ -> %2B)
    ENCODED_PHONE=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$PHONE', safe=''))")

    # Look up the phone number SID in Twilio
    PHONE_SID=$(curl -s -X GET \
      "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers.json?PhoneNumber=$ENCODED_PHONE" \
      -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
      | python3 -c "import sys,json; nums=json.load(sys.stdin).get('incoming_phone_numbers',[]); print(nums[0]['sid'] if nums else '')")

    if [[ -z "$PHONE_SID" ]]; then
      echo "  WARNING: Could not find $PHONE ($LABEL) in Twilio account, skipping."
      continue
    fi

    # Update the voice webhook URL
    curl -s -X POST \
      "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/$PHONE_SID.json" \
      -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
      --data-urlencode "VoiceUrl=$WEBHOOK_URL" \
      --data-urlencode "VoiceMethod=POST" \
      > /dev/null

    echo "  Configured $PHONE ($LABEL) -> $WEBHOOK_URL"
  done
  echo "Twilio webhooks configured."
fi

echo ""
echo "=== Ready ==="
echo "  Tunnel:  $TUNNEL_URL"
echo "  Webhook: $WEBHOOK_URL"
echo "  Stream:  wss://$(echo "$TUNNEL_URL" | sed 's|https://||')/twilio-stream"
echo ""

# Start the voice pipeline with PUBLIC_URL set to the tunnel
export PUBLIC_URL="$TUNNEL_URL"
cd "$SCRIPT_DIR"
python3 -m uvicorn src.server:app --host 0.0.0.0 --port "$PORT" &
SERVER_PID=$!

# Wait for the server to be ready locally
echo "Waiting for server to start on port $PORT..."
for i in $(seq 1 30); do
  if curl -s --max-time 2 "http://localhost:$PORT/health" > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: Server failed to start." >&2
    exit 1
  fi
  sleep 1
done

# Verify the tunnel routes to our server (catches port mismatches in the dashboard config)
if [[ "$QUICK_TUNNEL" == false ]]; then
  echo "Verifying tunnel connectivity..."
  TUNNEL_HEALTH=""
  for i in $(seq 1 10); do
    TUNNEL_HEALTH=$(curl -s --max-time 5 "$TUNNEL_URL/health" 2>/dev/null || echo "")
    if [[ "$TUNNEL_HEALTH" == *'"status"'*'"ok"'* ]]; then
      break
    fi
    echo "  Attempt $i/10: tunnel not ready ($TUNNEL_HEALTH)"
    sleep 2
  done

  if [[ "$TUNNEL_HEALTH" != *'"status"'*'"ok"'* ]]; then
    echo "" >&2
    echo "ERROR: Tunnel health check failed. The tunnel may be configured for a different port." >&2
    echo "  Response: $TUNNEL_HEALTH" >&2
    echo "  Your server is running on port $PORT." >&2
    echo "  Fix: Update the service URL in Cloudflare Zero Trust dashboard -> Networks -> Tunnels -> Configure -> Public Hostname" >&2
    echo "" >&2
    echo "  Possible causes:" >&2
    echo "    - Cloudflare WARP is running (conflicts with cloudflared)" >&2
    echo "    - The tunnel's public hostname is configured for a different port" >&2
    echo "" >&2
    echo "  Alternatively, restart with a different option:" >&2
    echo "    --quick-tunnel    Use a temporary Cloudflare quick tunnel instead" >&2
    echo "    --no-tunnel       Run without any tunnel (local only)" >&2
    echo "" >&2
    kill "$SERVER_PID" 2>/dev/null
    exit 1
  else
    echo "Tunnel health check passed."
  fi
fi

# Forward signals to the server so Ctrl+C shuts everything down
trap "kill $SERVER_PID 2>/dev/null; cleanup" EXIT
wait "$SERVER_PID"

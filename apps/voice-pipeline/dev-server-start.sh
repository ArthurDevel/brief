#!/usr/bin/env bash
#
# Start a Cloudflare quick tunnel and configure the Twilio phone number
# webhook to point at it, then start the voice pipeline server.
#
# Required env vars (from .env or exported):
#   TWILIO_ACCOUNT_SID   - Twilio account SID
#   TWILIO_AUTH_TOKEN     - Twilio auth token
#   TWILIO_PHONE_NUMBER   - Twilio phone number (E.164, e.g. +15551234567)
#
# Usage:
#   ./dev-server-start.sh

set -euo pipefail

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

# Type check — catch type errors, bad method calls, missing args, etc.
echo "Running type check..."
cd "$SCRIPT_DIR"
if ! python3 -m pyright src/; then
  echo "ERROR: Type check failed. Fix the errors above before starting." >&2
  exit 1
fi
echo "Type check passed."

# Validate Twilio credentials
for var in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_PHONE_NUMBER; do
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

# Start cloudflared quick tunnel in background, capture the URL from its log
TUNNEL_LOG=$(mktemp)
cloudflared tunnel --url "http://localhost:$PORT" 2>"$TUNNEL_LOG" &
TUNNEL_PID=$!

cleanup() {
  echo ""
  echo "Shutting down tunnel (PID $TUNNEL_PID)..."
  kill "$TUNNEL_PID" 2>/dev/null || true
  rm -f "$TUNNEL_LOG"
}
trap cleanup EXIT

# Wait for the tunnel URL to appear in the log
echo "Starting Cloudflare quick tunnel on port $PORT..."
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9_-]+(-[a-zA-Z0-9_-]+)+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)
  if [[ -n "$TUNNEL_URL" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$TUNNEL_URL" ]]; then
  echo "Failed to start Cloudflare tunnel (trycloudflare.com may be down)." >&2
  exit 1
fi

echo "Tunnel URL: $TUNNEL_URL"

# URL-encode the phone number (+ → %2B)
ENCODED_PHONE=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TWILIO_PHONE_NUMBER', safe=''))")

# Look up the phone number SID
PHONE_SID=$(curl -s -X GET \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers.json?PhoneNumber=$ENCODED_PHONE" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  | python3 -c "import sys,json; nums=json.load(sys.stdin).get('incoming_phone_numbers',[]); print(nums[0]['sid'] if nums else '')")

if [[ -z "$PHONE_SID" ]]; then
  echo "ERROR: Could not find phone number $TWILIO_PHONE_NUMBER in your Twilio account." >&2
  exit 1
fi

# Update the voice webhook URL
WEBHOOK_URL="$TUNNEL_URL/twilio/voice"
echo "Updating Twilio phone number $TWILIO_PHONE_NUMBER webhook to: $WEBHOOK_URL"

curl -s -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/$PHONE_SID.json" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  --data-urlencode "VoiceUrl=$WEBHOOK_URL" \
  --data-urlencode "VoiceMethod=POST" \
  > /dev/null

echo "Twilio webhook configured."
echo ""
echo "=== Ready ==="
echo "  Tunnel:  $TUNNEL_URL"
echo "  Webhook: $WEBHOOK_URL"
echo "  Stream:  wss://$(echo "$TUNNEL_URL" | sed 's|https://||')/twilio-stream"
echo ""

# Start the voice pipeline with PUBLIC_URL set to the tunnel
export PUBLIC_URL="$TUNNEL_URL"
cd "$SCRIPT_DIR"
exec python3 -m uvicorn src.server:app --host 0.0.0.0 --port "$PORT"

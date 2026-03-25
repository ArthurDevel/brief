#!/usr/bin/env bash
#
# Update Twilio voice webhooks for all active company phone numbers
# in a given environment to point to a new server URL.
#
# Fetches phone numbers from the company_phone_numbers table via Supabase,
# then updates each number's voice webhook in Twilio to <url>/twilio/voice.
#
# Usage:
#   ./scripts/update-twilio-webhooks.sh --url "https://new-server.com" --env prod
#   ./scripts/update-twilio-webhooks.sh --url "https://dev-tunnel.trycloudflare.com" --env dev
#
# Required env vars (loaded from apps/voice-pipeline/.env):
#   SUPABASE_URL               - Supabase project URL
#   SUPABASE_SERVICE_ROLE_KEY  - Supabase service role key
#   TWILIO_ACCOUNT_SID         - Twilio account SID
#   TWILIO_AUTH_TOKEN           - Twilio auth token
#
# Prerequisites: curl, jq

set -euo pipefail

# ============================================================================
# ARG PARSING
# ============================================================================

URL=""
ENV=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --env) ENV="$2"; shift 2 ;;
    *) echo "ERROR: Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ============================================================================
# VALIDATION
# ============================================================================

if [[ -z "$URL" ]]; then
  echo "ERROR: --url is required (e.g. \"https://my-server.com\")" >&2
  exit 1
fi

if [[ -z "$ENV" ]]; then
  echo "ERROR: --env is required (dev or prod)" >&2
  exit 1
fi

if [[ "$ENV" != "dev" && "$ENV" != "prod" ]]; then
  echo "ERROR: --env must be 'dev' or 'prod', got '$ENV'" >&2
  exit 1
fi

for cmd in curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is not installed." >&2
    exit 1
  fi
done

# ============================================================================
# LOAD ENV
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../apps/voice-pipeline/.env"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
else
  echo "ERROR: .env file not found at $ENV_FILE" >&2
  exit 1
fi

for var in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is not set. Add it to apps/voice-pipeline/.env or export it." >&2
    exit 1
  fi
done

# ============================================================================
# STEP 1: FETCH COMPANY PHONE NUMBERS
# ============================================================================

echo "Fetching active $ENV phone numbers from company_phone_numbers..."

PHONE_NUMBERS_JSON=$(curl -s -X GET \
  "${SUPABASE_URL}/rest/v1/company_phone_numbers?environment=eq.${ENV}&is_active=eq.true" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}")

PHONE_COUNT=$(echo "$PHONE_NUMBERS_JSON" | jq 'length')

if [[ "$PHONE_COUNT" -eq 0 ]]; then
  echo "No active phone numbers found for environment '$ENV'."
  exit 0
fi

echo "Found $PHONE_COUNT phone number(s)."

# ============================================================================
# STEP 2: UPDATE WEBHOOKS
# ============================================================================

VOICE_WEBHOOK="$URL/twilio/voice"
SUCCESS_COUNT=0
FAIL_COUNT=0

echo "Updating webhooks to: $VOICE_WEBHOOK"
echo ""

echo "$PHONE_NUMBERS_JSON" | jq -c '.[]' | while read -r row; do
  PHONE=$(echo "$row" | jq -r '.phone_number')
  LABEL=$(echo "$row" | jq -r '.label')

  # URL-encode the phone number (+ -> %2B)
  ENCODED_PHONE=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$PHONE', safe=''))")

  # Look up the phone number SID in Twilio
  PHONE_SID=$(curl -s -X GET \
    "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers.json?PhoneNumber=$ENCODED_PHONE" \
    -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
    | jq -r '.incoming_phone_numbers[0].sid // empty')

  if [[ -z "$PHONE_SID" ]]; then
    echo "  SKIP: $PHONE ($LABEL) -- not found in Twilio account"
    continue
  fi

  # Update the voice webhook URL
  curl -s -X POST \
    "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/$PHONE_SID.json" \
    -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
    --data-urlencode "VoiceUrl=$VOICE_WEBHOOK" \
    --data-urlencode "VoiceMethod=POST" \
    > /dev/null

  echo "  OK: $PHONE ($LABEL) -> $VOICE_WEBHOOK"
done

echo ""
echo "Done. Updated webhooks for $ENV phone numbers to $VOICE_WEBHOOK"

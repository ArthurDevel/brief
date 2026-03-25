#!/usr/bin/env bash
#
# Add a new company phone number to the database and optionally configure
# its Twilio voice webhook.
#
# Inserts a row into company_phone_numbers via Supabase REST API.
# If --webhook-url is provided, also looks up the phone SID in Twilio
# and sets the voice webhook.
#
# Usage:
#   ./scripts/add-company-phone.sh --phone "+32123456789" --country BE --label "Belgium" --env dev
#   ./scripts/add-company-phone.sh --phone "+32123456789" --country BE --label "Belgium" --env dev --webhook-url "https://my-server.com"
#   ./scripts/add-company-phone.sh --phone "+16505551234" --country US --label "United States" --env prod
#
# Required env vars (loaded from apps/voice-pipeline/.env):
#   SUPABASE_URL               - Supabase project URL
#   SUPABASE_SERVICE_ROLE_KEY  - Supabase service role key
#   TWILIO_ACCOUNT_SID         - Twilio account SID (only if --webhook-url is used)
#   TWILIO_AUTH_TOKEN           - Twilio auth token (only if --webhook-url is used)
#
# Prerequisites: curl, jq

set -euo pipefail

# ============================================================================
# ARG PARSING
# ============================================================================

PHONE=""
COUNTRY=""
LABEL=""
ENV=""
WEBHOOK_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phone)    PHONE="$2"; shift 2 ;;
    --country)  COUNTRY="$2"; shift 2 ;;
    --label)    LABEL="$2"; shift 2 ;;
    --env)      ENV="$2"; shift 2 ;;
    --webhook-url) WEBHOOK_URL="$2"; shift 2 ;;
    *) echo "ERROR: Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ============================================================================
# VALIDATION
# ============================================================================

if [[ -z "$PHONE" ]]; then
  echo "ERROR: --phone is required (e.g. \"+32123456789\")" >&2
  exit 1
fi

if [[ -z "$COUNTRY" ]]; then
  echo "ERROR: --country is required (e.g. \"BE\")" >&2
  exit 1
fi

if [[ -z "$LABEL" ]]; then
  echo "ERROR: --label is required (e.g. \"Belgium\")" >&2
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

for var in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is not set. Add it to apps/voice-pipeline/.env or export it." >&2
    exit 1
  fi
done

# ============================================================================
# STEP 1: INSERT INTO company_phone_numbers
# ============================================================================

echo "Inserting phone number $PHONE ($LABEL, $COUNTRY, $ENV)..."

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "${SUPABASE_URL}/rest/v1/company_phone_numbers" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "$(jq -n \
    --arg phone "$PHONE" \
    --arg country "$COUNTRY" \
    --arg label "$LABEL" \
    --arg env "$ENV" \
    '{
      phone_number: $phone,
      country_code: $country,
      label: $label,
      environment: $env,
      is_active: true
    }')")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" -lt 200 || "$HTTP_CODE" -ge 300 ]]; then
  echo "ERROR: Supabase insert failed (HTTP $HTTP_CODE):" >&2
  echo "$BODY" >&2
  exit 1
fi

echo "Inserted successfully:"
echo "$BODY" | jq '.[0]'

# ============================================================================
# STEP 2: CONFIGURE TWILIO WEBHOOK (optional)
# ============================================================================

if [[ -n "$WEBHOOK_URL" ]]; then
  for var in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN; do
    if [[ -z "${!var:-}" ]]; then
      echo "ERROR: $var is required for webhook configuration. Add it to .env or export it." >&2
      exit 1
    fi
  done

  VOICE_WEBHOOK="$WEBHOOK_URL/twilio/voice"
  echo ""
  echo "Configuring Twilio webhook for $PHONE -> $VOICE_WEBHOOK"

  # URL-encode the phone number (+ -> %2B)
  ENCODED_PHONE=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$PHONE', safe=''))")

  # Look up the phone number SID in Twilio
  PHONE_SID=$(curl -s -X GET \
    "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers.json?PhoneNumber=$ENCODED_PHONE" \
    -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
    | jq -r '.incoming_phone_numbers[0].sid // empty')

  if [[ -z "$PHONE_SID" ]]; then
    echo "ERROR: Could not find $PHONE in Twilio account." >&2
    exit 1
  fi

  # Update the voice webhook URL
  curl -s -X POST \
    "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/$PHONE_SID.json" \
    -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
    --data-urlencode "VoiceUrl=$VOICE_WEBHOOK" \
    --data-urlencode "VoiceMethod=POST" \
    > /dev/null

  echo "Twilio webhook configured: $PHONE -> $VOICE_WEBHOOK"
fi

echo ""
echo "Done."

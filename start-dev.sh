#!/usr/bin/env bash
#
# Start the local WhatsApp development stack:
# - apps/web
# - apps/whatsapp-server
# - apps/whatsapp-agent
# - apps/whatsapp-emulator
#
# Usage:
#   ./start-dev.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDS=()

check_dependencies() {
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "ERROR: pnpm is not installed." >&2
    exit 1
  fi
}

warn_for_missing_env_files() {
  local missing_file=false

  if [[ ! -f "$SCRIPT_DIR/apps/web/.env.local" && ! -f "$SCRIPT_DIR/apps/web/.env" ]]; then
    echo "WARNING: Missing apps/web/.env.local or apps/web/.env" >&2
    missing_file=true
  fi

  if [[ ! -f "$SCRIPT_DIR/apps/whatsapp-server/.env" ]]; then
    echo "WARNING: Missing apps/whatsapp-server/.env" >&2
    missing_file=true
  fi

  if [[ ! -f "$SCRIPT_DIR/apps/whatsapp-agent/.env" ]]; then
    echo "WARNING: Missing apps/whatsapp-agent/.env" >&2
    missing_file=true
  fi

  if [[ ! -f "$SCRIPT_DIR/apps/whatsapp-emulator/.env" ]]; then
    echo "WARNING: Missing apps/whatsapp-emulator/.env" >&2
    missing_file=true
  fi

  if [[ "$missing_file" == true ]]; then
    echo "Some services may fail to start until those env files exist." >&2
    echo "" >&2
  fi
}

start_service() {
  local service_name="$1"
  local command="$2"

  echo "Starting $service_name..."

  (
    cd "$SCRIPT_DIR"
    exec bash -lc "$command"
  ) > >(sed -u "s/^/[$service_name] /") \
    2> >(sed -u "s/^/[$service_name] /" >&2) &

  PIDS+=("$!")
}

cleanup() {
  local exit_code=$?

  trap - EXIT INT TERM

  echo ""
  echo "Shutting down local dev services..."

  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done

  wait "${PIDS[@]}" 2>/dev/null || true

  exit "$exit_code"
}

wait_for_any_service_exit() {
  while true; do
    for pid in "${PIDS[@]}"; do
      if ! kill -0 "$pid" 2>/dev/null; then
        return 0
      fi
    done

    sleep 1
  done
}

main() {
  check_dependencies
  warn_for_missing_env_files

  trap cleanup EXIT INT TERM

  start_service "web" "pnpm dev:web"
  start_service "whatsapp-server" "WHATSAPP_TRANSPORT_MODE=emulator WHATSAPP_EMULATOR_URL=http://localhost:3030 pnpm dev:whatsapp"
  start_service "whatsapp-agent" "pnpm dev:whatsapp-agent"
  start_service "whatsapp-emulator" "pnpm dev:whatsapp-emulator"

  echo ""
  echo "WhatsApp local dev stack is starting."
  echo "Press Ctrl+C to stop all services."
  echo ""

  wait_for_any_service_exit

  echo ""
  echo "One service exited. Stopping the remaining services."
}

main "$@"

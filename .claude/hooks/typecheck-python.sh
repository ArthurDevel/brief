#!/bin/bash
# Runs pyright on a single Python file after Claude edits or creates it.
# Exit code 2 = blocking error (fed back to Claude). 0 = success/skip.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Skip if not a Python file
if [[ -z "$FILE_PATH" || "$FILE_PATH" != *.py ]]; then
  exit 0
fi

# Skip if file no longer exists (e.g. was deleted)
if [[ ! -f "$FILE_PATH" ]]; then
  exit 0
fi

# Find the nearest directory with pyrightconfig.json and run pyright from there
SEARCH_DIR=$(dirname "$FILE_PATH")
while [[ "$SEARCH_DIR" != "/" ]]; do
  if [[ -f "$SEARCH_DIR/pyrightconfig.json" ]]; then
    break
  fi
  SEARCH_DIR=$(dirname "$SEARCH_DIR")
done

OUTPUT=$(cd "$SEARCH_DIR" && npx pyright "$FILE_PATH" 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -ne 0 ]]; then
  echo "$OUTPUT" >&2
  exit 2
fi

exit 0

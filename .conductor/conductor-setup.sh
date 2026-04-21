#!/bin/zsh

# Symlink all .env* files from repo root to workspace, preserving directory structure

# Symlink root-level .env* files (if any exist)
for f in "$CONDUCTOR_ROOT_PATH"/.env*(.N); do
    [[ "$f" == *.example ]] && continue
    ln -sf "$f" .
done

# Symlink .env* files from subdirectories
for dir in apps/voice-pipeline apps/web apps/whatsapp-server apps/whatsapp-agent apps/whatsapp-emulator apps/voice-review/livekit-review; do
    if [ -d "$CONDUCTOR_ROOT_PATH/$dir" ]; then
        mkdir -p "$dir"
        for f in "$CONDUCTOR_ROOT_PATH/$dir"/.env*(.N); do
            [[ "$f" == *.example ]] && continue
            ln -sf "$f" "$dir/"
        done
    fi
done

# Install workspace JS dependencies from the repo root
if [ -f "package.json" ] && [ -f "pnpm-lock.yaml" ]; then
    pnpm install
fi

# Install Python venv for voice-pipeline
if [ -d "apps/voice-pipeline" ]; then
    cd apps/voice-pipeline
    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt
    deactivate
    cd ../..
fi

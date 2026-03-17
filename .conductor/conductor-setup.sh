#!/bin/zsh

# Symlink all .env* files from repo root to workspace, preserving directory structure

# Symlink root-level .env* files (if any exist)
for f in "$CONDUCTOR_ROOT_PATH"/.env*(.N); do
    [[ "$f" == *.example ]] && continue
    ln -sf "$f" .
done

# Symlink .env* files from subdirectories (apps/voice-pipeline/, apps/web/)
for dir in apps/voice-pipeline apps/web; do
    if [ -d "$CONDUCTOR_ROOT_PATH/$dir" ]; then
        mkdir -p "$dir"
        for f in "$CONDUCTOR_ROOT_PATH/$dir"/.env*(.N); do
            [[ "$f" == *.example ]] && continue
            ln -sf "$f" "$dir/"
        done
    fi
done

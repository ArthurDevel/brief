#!/bin/zsh

# Symlink all .env* files from repo root to workspace, preserving directory structure

# Symlink root-level .env* files (if any exist)
for f in "$CONDUCTOR_ROOT_PATH"/.env*(.N); do
    ln -sf "$f" .
done

# Symlink .env* files from subdirectories (apps/voice-gateway/, apps/web/)
for dir in apps/voice-gateway apps/web; do
    if [ -d "$CONDUCTOR_ROOT_PATH/$dir" ]; then
        mkdir -p "$dir"
        for f in "$CONDUCTOR_ROOT_PATH/$dir"/.env*(.N); do
            ln -sf "$f" "$dir/"
        done
    fi
done

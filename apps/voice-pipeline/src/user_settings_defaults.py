"""Shared user-settings defaults loaded from the repo-level JSON source."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any, cast


def _build_defaults_path_candidates(module_path: Path) -> list[Path]:
    candidates: list[Path] = []

    configured_path = os.getenv("USER_SETTINGS_DEFAULTS_PATH")
    if configured_path:
        candidates.append(Path(configured_path).expanduser())

    resolved_path = module_path.resolve()

    for parent in (resolved_path.parent, *resolved_path.parents):
        candidates.append(parent / "shared" / "user-settings-defaults.json")
        candidates.append(parent / "user-settings-defaults.json")

    unique_candidates: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        unique_candidates.append(candidate)

    return unique_candidates


def _load_user_settings_defaults(module_path: Path | None = None) -> dict[str, Any]:
    candidates = _build_defaults_path_candidates(module_path or Path(__file__))

    for path in candidates:
        if not path.is_file():
            continue
        return cast(dict[str, Any], json.loads(path.read_text(encoding="utf-8")))

    candidate_list = ", ".join(str(path) for path in candidates)
    raise FileNotFoundError(
        "Could not find user-settings-defaults.json. "
        f"Tried: {candidate_list}"
    )


_USER_SETTINGS_DEFAULTS = _load_user_settings_defaults()

DEFAULT_VOICE = str(_USER_SETTINGS_DEFAULTS["voice_config"]["voice"])
DEFAULT_SPEED = float(_USER_SETTINGS_DEFAULTS["voice_config"]["speed"])


def get_user_settings_domain_defaults() -> dict[str, Any]:
    """Return a copy of the shared persisted-shape defaults."""
    return copy.deepcopy(_USER_SETTINGS_DEFAULTS)


def get_default_voice_config() -> dict[str, Any]:
    """Return a copy of the default voice settings."""
    return copy.deepcopy(cast(dict[str, Any], _USER_SETTINGS_DEFAULTS["voice_config"]))


def get_default_tool_approval_config() -> dict[str, str]:
    """Return a copy of the default tool approval config."""
    return copy.deepcopy(cast(dict[str, str], _USER_SETTINGS_DEFAULTS["tool_approval_config"]))

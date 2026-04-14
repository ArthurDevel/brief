"""Shared user-settings defaults loaded from the repo-level JSON source."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, cast


_DEFAULTS_PATH = Path(__file__).resolve().parents[3] / "shared" / "user-settings-defaults.json"
_USER_SETTINGS_DEFAULTS = cast(
    dict[str, Any],
    json.loads(_DEFAULTS_PATH.read_text(encoding="utf-8")),
)

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

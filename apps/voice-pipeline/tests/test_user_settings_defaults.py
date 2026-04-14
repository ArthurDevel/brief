from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.user_settings_defaults import _build_defaults_path_candidates, _load_user_settings_defaults


def test_vendored_defaults_match_shared_defaults():
    repo_root = Path(__file__).resolve().parents[3]
    shared_defaults = json.loads(
        (repo_root / "shared" / "user-settings-defaults.json").read_text(encoding="utf-8")
    )
    vendored_defaults = json.loads(
        (repo_root / "apps" / "voice-pipeline" / "user-settings-defaults.json").read_text(
            encoding="utf-8"
        )
    )

    assert vendored_defaults == shared_defaults


def test_defaults_candidates_include_app_local_copy_for_flat_container_layout():
    module_path = Path("/app/src/user_settings_defaults.py")

    candidates = _build_defaults_path_candidates(module_path)

    assert Path("/app/user-settings-defaults.json") in candidates


def test_missing_defaults_file_raises_instead_of_falling_back():
    with pytest.raises(FileNotFoundError, match="Could not find user-settings-defaults.json"):
        _load_user_settings_defaults(Path("/tmp/nonexistent/user_settings_defaults.py"))

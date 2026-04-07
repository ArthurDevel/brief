"""
Upload a local JSON eval dataset into Langfuse.

Syncs the dataset: upserts all items from the JSON file and deletes any
remote items that are no longer in the file. This keeps Langfuse in sync
with the local JSON as the single source of truth.

Usage:
    python3 langfuse/evals/upload_dataset.py langfuse/datasets/voice-behavior.json
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from langfuse import get_client


ENV_PATH = Path(__file__).resolve().parents[2] / "apps" / "voice-pipeline" / ".env"


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _load_env() -> None:
    load_dotenv(ENV_PATH)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload a local eval dataset into Langfuse.")
    parser.add_argument("dataset_path", help="Path to local dataset JSON file.")
    parser.add_argument(
        "--dataset-name",
        help="Override dataset name from JSON.",
    )
    parser.add_argument(
        "--description",
        help="Override dataset description from JSON.",
    )
    return parser.parse_args()


# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

def main() -> None:
    args = _parse_args()
    _load_env()

    dataset_path = Path(args.dataset_path).resolve()
    payload = _load_json(dataset_path)

    dataset_name = args.dataset_name or payload["dataset_name"]
    description = args.description or payload.get("description")
    items: list[dict[str, Any]] = payload["items"]

    langfuse = get_client()
    try:
        langfuse.create_dataset(
            name=dataset_name,
            description=description,
            metadata={
                "source_path": str(dataset_path),
            },
        )
    except Exception:
        pass

    # Step 1: Upsert all items from the JSON file
    local_ids: set[str] = set()
    for item in items:
        local_ids.add(item["id"])
        metadata = {
            "case_id": item["id"],
            "category": item.get("category"),
            "goal": item.get("goal"),
            "tags": item.get("tags", []),
        }
        langfuse.create_dataset_item(
            id=item["id"],
            dataset_name=dataset_name,
            input=item["input"],
            expected_output=item["expected_output"],
            metadata=metadata,
        )

    # Step 2: Delete remote items that are no longer in the JSON file
    dataset = langfuse.get_dataset(dataset_name)
    deleted = 0
    for remote_item in dataset.items:
        if remote_item.id not in local_ids:
            langfuse.api.dataset_items.delete(remote_item.id)
            deleted += 1

    langfuse.flush()
    print(f"Uploaded {len(items)} items to Langfuse dataset '{dataset_name}'.")
    if deleted:
        print(f"Deleted {deleted} stale items.")


if __name__ == "__main__":
    main()

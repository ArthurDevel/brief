"""
Evaluate voice pipeline tool-calling accuracy using Langfuse datasets.

Replays conversation history from dataset items through the LLM and checks
whether the tool calls in the response are correct.

Responsibilities:
- Load dataset items from Langfuse (each containing an OpenAI messages array)
- Send messages to the LLM via OpenRouter and capture the response + tool calls
- Evaluate whether the LLM's tool calls match the expected behavior
"""

from __future__ import annotations

import importlib
import json
import os
import sys
from typing import Any, cast

from dotenv import load_dotenv
from langfuse import Evaluation, get_client
from openai import OpenAI
from openai.types.chat import ChatCompletionMessageToolCall

# ============================================================================
# CONSTANTS
# ============================================================================

DATASET_NAME = "voice-tool-calling-accuracy"
LLM_MODEL = "google/gemini-3-flash-preview"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
VOICE_PIPELINE_PATH = os.path.join(os.path.dirname(__file__), "../../apps/voice-pipeline")
MAX_TOOL_ROUNDS = 10

# Load env vars from voice pipeline .env
ENV_PATH = os.path.join(os.path.dirname(__file__), "../../apps/voice-pipeline/.env")
load_dotenv(ENV_PATH)


# ============================================================================
# HELPERS
# ============================================================================

def _load_tool_definitions() -> list[dict[str, Any]]:
    """Dynamically import tool definitions from the voice pipeline."""
    sys.path.insert(0, VOICE_PIPELINE_PATH)
    module = importlib.import_module("src.tools.definitions")
    sys.path.pop(0)
    return module.get_tool_definitions()  # type: ignore[no-any-return]


def _stub_tool_result(tool_name: str) -> str:
    """Return a stub JSON result for a tool call so the LLM can continue its turn.

    @param tool_name: Name of the tool that was called
    @returns: JSON string with a plausible stub response
    """
    return json.dumps({"success": True, "tool": tool_name})


# ============================================================================
# ENTRY POINT
# ============================================================================

def main() -> None:
    """Run the tool-calling accuracy experiment."""
    langfuse = get_client()
    dataset = langfuse.get_dataset(DATASET_NAME)
    tools = _load_tool_definitions()

    openai_client = OpenAI(
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url=OPENROUTER_BASE_URL,
    )

    result = dataset.run_experiment(
        name="tool-calling-accuracy",
        description="Check if the LLM makes correct tool calls given conversation history",
        task=lambda *, item, **kwargs: run_task(openai_client, tools, item=item),  # type: ignore[arg-type]
        evaluators=[tool_call_evaluator],
    )

    print(result.format())
    langfuse.flush()


# ============================================================================
# TASK
# ============================================================================

def run_task(client: OpenAI, tools: list[dict[str, Any]], *, item: Any) -> dict[str, Any]:
    """Replay conversation history through the LLM in an agentic loop.

    Keeps calling the LLM until it stops requesting tool calls (i.e. returns
    content only). Tool results are stubbed with {"success": true} so the LLM
    can complete its full turn. Collects all tool calls across rounds.

    @param client: OpenAI client pointed at OpenRouter
    @param tools: Tool definitions in OpenAI function-calling format
    @param item: Langfuse DatasetItem with input.messages
    @returns: Dict with "content" (final text), "tool_calls" (all tool calls across rounds)
    """
    messages: list[dict[str, Any]] = list(item.input["messages"])
    all_tool_calls: list[dict[str, Any]] = []
    final_content = ""

    for _ in range(MAX_TOOL_ROUNDS):
        response = client.chat.completions.create(
            model=LLM_MODEL,
            messages=messages,  # type: ignore[arg-type]
            tools=tools,  # type: ignore[arg-type]
        )

        message = response.choices[0].message
        final_content = message.content or ""

        # No tool calls -- LLM is done
        if not message.tool_calls:
            break

        # Collect tool calls from this round
        assistant_tool_calls: list[dict[str, Any]] = []
        for tc in message.tool_calls:
            fn_call = cast(ChatCompletionMessageToolCall, tc)
            parsed = {
                "name": fn_call.function.name,
                "arguments": json.loads(fn_call.function.arguments) if fn_call.function.arguments else {},
            }
            all_tool_calls.append(parsed)
            assistant_tool_calls.append({
                "id": fn_call.id,
                "type": "function",
                "function": {"name": fn_call.function.name, "arguments": fn_call.function.arguments or "{}"},
            })

        # Append assistant message with tool_calls
        messages.append({"role": "assistant", "content": final_content, "tool_calls": assistant_tool_calls})

        # Append stub tool results so the LLM can continue
        for tc in assistant_tool_calls:
            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": _stub_tool_result(tc["function"]["name"]),
            })

    return {
        "content": final_content,
        "tool_calls": all_tool_calls,
    }


# ============================================================================
# EVALUATORS
# ============================================================================

def tool_call_evaluator(*, output: Any, expected_output: Any, **kwargs: Any) -> Evaluation:
    """Check if tool calls match the expected behavior.

    @param output: The LLM response dict with "content" and "tool_calls"
    @param expected_output: Expected behavior with "forbidden_tools", "expected_tools", etc.
    @returns: Evaluation with score 0 or 1 and a comment explaining the result
    """
    tool_calls: list[dict[str, Any]] = output.get("tool_calls", [])
    tool_names = [tc["name"] for tc in tool_calls]
    content: str = output.get("content", "")
    violation_type: str = expected_output.get("violation_type", "")
    issues: list[str] = []

    if violation_type == "claimed_action_without_tool_call":
        # Check if the LLM claims to do something without calling the tool
        action_keywords = ["i'll delete", "i'm deleting", "i will delete",
                          "i'll move", "i'm moving", "i will move",
                          "deleting", "moving"]
        claims_action = any(kw in content.lower() for kw in action_keywords)

        has_delete_tool = "batch_delete_emails" in tool_names or "delete_email" in tool_names
        has_move_tool = "move_to_folder" in tool_names

        if claims_action and not (has_delete_tool or has_move_tool):
            issues.append(
                f"LLM claimed to delete/move but did not call the tools. "
                f"Tools called: {tool_names or 'none'}"
            )

    elif violation_type == "ignored_user_instruction":
        forbidden = set(expected_output.get("forbidden_tools", []))
        expected = set(expected_output.get("expected_tools", []))

        # Check forbidden tools were not called
        called_forbidden = forbidden & set(tool_names)
        if called_forbidden:
            issues.append(
                f"Called forbidden tools: {sorted(called_forbidden)}. "
                f"User said to ignore these actions."
            )

        # Check expected tools were called
        missing_expected = expected - set(tool_names)
        if missing_expected:
            issues.append(
                f"Missing expected tools: {sorted(missing_expected)}"
            )

    if issues:
        return Evaluation(
            name="tool_call_accuracy",
            value=0.0,
            comment=" | ".join(issues),
        )

    return Evaluation(
        name="tool_call_accuracy",
        value=1.0,
        comment="Tool calls match expected behavior.",
    )


if __name__ == "__main__":
    main()

"""
LLM judge for voice behavior evals.

Calls an LLM to evaluate whether the assistant's response matches the expected
behavior defined in the dataset item. Returns a single pass/fail score.

Responsibilities:
- Define the judge prompt template
- Call the judge LLM and parse the result
- Provide an evaluator function compatible with Langfuse run_experiment
"""

from __future__ import annotations

import json
from typing import Any

from langfuse import Evaluation
from openai import OpenAI


# ============================================================================
# CONSTANTS
# ============================================================================

JUDGE_MODEL = "anthropic/claude-sonnet-4.6"

JUDGE_PROMPT = """You are evaluating a voice email assistant's response against expected behavior.

## Actual Output

Response:
{response_content}

Tool calls made:
{tool_calls}

## Expected Behavior

Required tools: {required_tools}
Forbidden tools: {forbidden_tools}
Response rules: {response_rules}
Style tags: {style_tags}
Notes: {notes}

## Instructions

Decide whether the assistant's response passes or fails. It passes only if ALL of the following are true:
- All required tools were called (and with reasonable arguments)
- No forbidden tools were called
- All response rules were followed
- The response fits the style tags (brief, phone-friendly, etc.)

IMPORTANT:
- The Expected Behavior section is authoritative. If a response rule forbids suggested actions, category guesses, extra tools, or a type of follow-up, fail outputs that violate that rule.
- Follow-up questions after completing a task are generally acceptable for a voice assistant, but only when they do not conflict with the explicit response rules for the dataset item.
- Asking a short confirmation like "should we start?" or "want to begin?" after proposing an action is acceptable unless the response rules say not to ask it.
- Minor wording differences that preserve the same intent are acceptable.
- Referencing facts (like email counts) that were established in earlier conversation turns is acceptable. The assistant may know things from prior messages that are not shown here as tool calls.

## Examples

PASS example 1 -- short confirmation after proposing triage:
  Response: "Hi Alex. You have 12 new emails since your last call. Want me to go through them one by one?"
  Required tools: []
  Reason: Proposing the triage flow and asking a focused yes/no confirmation is correct behavior, not an open-ended question.

PASS example 2 -- natural next step after reading an email:
  Response: "That email is from Vercel confirming your deployment succeeded. Want to reply, archive it, or move on to the next?"
  Required tools: [read_email]
  Reason: Offering reply/archive/next after reading is a natural follow-up, not an unsolicited action.

PASS example 3 -- follow-up after search results:
  Response: "I found 2 emails from Telnyx. One is an invoice, one is a feature alert. Would you like me to read the invoice or the feature alert?"
  Required tools: [search_emails]
  Reason: After listing search results, offering to read one of them is a natural next step -- not a needless question.

PASS example 5 -- referencing email count from prior conversation:
  Response: "Yesterday's newsletter covers AI model releases. Want to go through those 70 new emails one by one now?"
  Required tools: [get_newsletter_summary]
  Reason: The 70 email count was established in an earlier assistant message. Referencing it does not require a new tool call.

PASS example 4 -- mentioning dashboard approval after queuing a delete:
  Response: "Done, I've queued the delete. You'll need to approve it from the dashboard."
  Required tools: [delete_email]
  Reason: The delete tool was called and the response correctly tells the user to approve from the dashboard.

PASS example 6 -- similar email after delete:
  Response: "Queued. Next is also from HeyGen Notifications, subject Your Video is Ready. Delete this one too?"
  Response rules: ["The previous action deleted a near-identical email.", "A focused delete-this-one-too question is allowed."]
  Reason: The dataset explicitly allows this suggested action because it follows a delete of a near-identical email.

FAIL example 1 -- calling a forbidden tool:
  Response: "That email from Vercel is about your deployment."
  Required tools: [], Forbidden tools: [read_email], Tool calls made: [read_email]
  Reason: read_email was explicitly forbidden but was called.

FAIL example 2 -- missing a required tool:
  Response: "Sure, let me check your inbox."
  Required tools: [list_inbox], Tool calls made: []
  Reason: list_inbox was required but never called.

FAIL example 3 -- guessing instead of clarifying an ambiguous reference:
  Response: "The Vercel email says your deployment succeeded."
  Required tools: [], Response rules: ["ask for clarification"], Tool calls made: [read_email]
  Reason: The user's reference was ambiguous and the assistant guessed instead of asking which email they meant.

FAIL example 4 -- open-ended question instead of suggesting triage:
  Response: "Hi there! How can I help you today?"
  Required tools: [], Response rules: ["suggest going through emails one by one"]
  Reason: The greeting uses an open-ended question instead of suggesting the triage flow.

FAIL example 5 -- suggested action when neutral question is required:
  Response: "First one is from HeyGen Notifications. Subject: Your Video is Ready. Delete it?"
  Response rules: ["Ask neutrally what the user wants to do.", "Do not suggest delete, archive, read, or skip."]
  Reason: The dataset requires a neutral question, so suggesting delete violates the explicit response rules.

FAIL example 6 -- guessing folder/category:
  Response: "That email is in Promotions."
  Response rules: ["Do not mention a folder or category unless specific email metadata proves it."]
  Reason: The assistant guessed category membership not established by the provided context.

Respond with ONLY a JSON object. Do not include analysis before or after it. The first character must be `{{` and the last character must be `}}`. Keep the reason under 30 words:
{{"pass": true or false, "reason": "short explanation"}}"""


# ============================================================================
# MAIN LOGIC
# ============================================================================

def run_judge(
    client: OpenAI,
    output: dict[str, Any],
    expected_output: dict[str, Any],
) -> dict[str, Any]:
    """Call the judge LLM and return a pass/fail result.

    @param client: OpenAI client (pointed at OpenRouter)
    @param output: The assistant's response with "content" and "tool_calls"
    @param expected_output: The expected behavior from the dataset item
    @returns: Dict with "pass" (bool) and "reason" (str)
    """
    prompt = JUDGE_PROMPT.format(
        response_content=output.get("content", ""),
        tool_calls=json.dumps(output.get("tool_calls", []), indent=2),
        required_tools=json.dumps(expected_output.get("required_tools", []), indent=2),
        forbidden_tools=json.dumps(expected_output.get("forbidden_tools", []), indent=2),
        response_rules=json.dumps(expected_output.get("response_rules", []), indent=2),
        style_tags=json.dumps(expected_output.get("style_tags", []), indent=2),
        notes=expected_output.get("notes", "N/A"),
    )

    response = client.chat.completions.create(
        model=JUDGE_MODEL,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=150,
    )

    raw = response.choices[0].message.content or "{}"

    # Strip markdown fences if the model wraps the JSON
    stripped = raw.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else stripped
        if stripped.endswith("```"):
            stripped = stripped[: -len("```")]
        stripped = stripped.strip()

    try:
        result = json.loads(stripped)
    except json.JSONDecodeError:
        return {"pass": False, "reason": f"Judge returned unparseable response: {raw[:200]}"}

    return {
        "pass": bool(result.get("pass", False)),
        "reason": str(result.get("reason", "No reason provided")),
    }


def create_evaluator():
    """Create an evaluator function for Langfuse run_experiment.

    Extracts the pre-computed judge result from the task output.
    The judge is called once inside run_task, not here.

    @returns: Evaluator function compatible with Langfuse run_experiment
    """
    def evaluator(*, output: Any, expected_output: Any, **kwargs: Any) -> Evaluation:
        scores = output.get("judge_scores", {})
        passed = scores.get("pass", False)
        reason = scores.get("reason", "No judge result available")
        return Evaluation(
            name="voice_behavior",
            value=1.0 if passed else 0.0,
            comment=reason,
        )
    return evaluator

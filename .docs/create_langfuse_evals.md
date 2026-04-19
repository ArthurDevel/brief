# Creating Langfuse Evals

This repo keeps the local JSON dataset as the source of truth for Langfuse eval cases.

Relevant files:

- `langfuse/datasets/voice-behavior.json`
- `langfuse/evals/upload_dataset.py`
- `langfuse/evals/voice_behavior_eval.py`
- `langfuse/judges/voice_behavior_judge.py`

## Important Rule

Do not over-trim conversation context when adding eval cases.

This has caused repeated mistakes.

## System Prompt

Do not store the system prompt inside each dataset item.

The eval runner injects the system prompt automatically at runtime from either:

- the code prompt via `--use-code-prompt`, or
- a Langfuse-managed prompt via `--prompt-name`

That means the dataset item should contain the conversation and tool context that the assistant saw after the system prompt, not a duplicated system prompt blob.

## Conversation Context Requirements

When a case is derived from a real production conversation:

- include the start of the relevant conversation segment, not just the final turn
- include the assistant turn that set up the user expectation
- include prior tool calls and tool outputs that materially shaped the next response
- include prior user turns that anchor the assistant's behavior

For one-by-one inbox cases, this usually means:

- greeting or first user utterance
- the initial `list_inbox`
- any auto-actions triggered from memory before the assistant speaks
- the assistant's first spoken summary
- the user confirmation to continue

Do not jump straight to the last user turn unless the earlier turns are genuinely irrelevant.

## Tool Output Requirements

Use the real tool output.

In particular:

- do not shorten `list_inbox` returns by default
- do not reduce search results to a hand-picked subset unless the truncation is itself intentional and documented
- preserve real email IDs, senders, subjects, snippets, and action IDs

Cheap models are sensitive to missing anchor context. Full tool outputs help preserve realistic behavior.

If a tool output is extremely large and must be trimmed, document why in the case notes and keep all rows that affect the target behavior.

## Memory And Session Context

If the real interaction depended on user memories or tool classifications, include the full relevant block in `input.session_context`.

Do not silently reduce the memory list to only one or two items if the production behavior was conditioned by a larger memory set.

## Authoring Checklist

Before considering a new eval case done:

1. Confirm the system prompt is runtime-injected and not duplicated into the item.
2. Confirm the conversation starts early enough to anchor the behavior.
3. Confirm the full relevant tool output is present.
4. Confirm real IDs and metadata are preserved.
5. Validate JSON:

```bash
python3 -m json.tool langfuse/datasets/voice-behavior.json >/tmp/voice-behavior.validated.json
```

6. Run a targeted local eval before upload:

```bash
python3 langfuse/evals/voice_behavior_eval.py \
  --use-code-prompt \
  --dataset-path langfuse/datasets/voice-behavior.json \
  --item-id <case-id>
```

7. Upload and rerun the targeted remote eval:

```bash
python3 langfuse/evals/upload_dataset.py langfuse/datasets/voice-behavior.json

python3 langfuse/evals/voice_behavior_eval.py \
  --use-code-prompt \
  --item-id <case-id>
```

## Specific Past Mistake To Avoid

Do not create a case from the middle of a conversation while:

- omitting the opening assistant setup turns
- shortening the `list_inbox` output
- reducing the memory entries

That changes model behavior and makes the eval less trustworthy.

## Provider-Specific Fidelity

Keep the eval faithful to the provider-specific shape.

- For Gmail label bugs, keep both `name` and `path` exactly as returned.
- If the bug is about display name versus provider path, the eval must include the real folder list output.
- Preserve the exact sequence of state changes:
  - include the failed tool call before the corrective step
  - include the user correction that challenges the assistant
  - include the follow-up tool result that makes the right action possible

## Example To Preserve

For the `Dev/Github` label regression:

- do not write a compact example that starts only at `"But it does exist. Please check."`
- do not omit the greeting, inbox listing, auto-delete action, failed `move_to_folder`, or exact error text
- do not shorten the `list_inbox` or `list_folders` outputs

The correct eval should include:

- the full conversation from the start of the session
- the full `list_inbox` output
- the full failed `move_to_folder` output
- the full `list_folders` output
- the final successful `move_to_folder` step if the eval covers the recovery

## Practical Standard

If you are copying a case from Langfuse observations:

- copy each assistant and user turn verbatim
- copy each tool input verbatim
- copy each tool output verbatim

Default to fidelity over brevity.

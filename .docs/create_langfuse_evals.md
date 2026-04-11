# Creating Langfuse Evals

When creating Langfuse eval cases from real traces, preserve the real context. Do not compress the setup into a smaller synthetic example unless the point of the eval is specifically a minimal case.

## Rules

1. Include the full start of the conversation.
   - Include the initial system prompt or equivalent prompt context.
   - Include the greeting and all prior turns that anchor the behavior being tested.
   - If the failure happens late in the turn, keep the earlier tool calls and assistant replies that establish state.

2. Do not shorten tool outputs.
   - Copy the full tool response into the eval fixture.
   - Do not replace large `markdown` payloads with summaries.
   - Do not trim folder lists, search results, inbox results, or error messages.
   - Do not use placeholders like `...`, `truncated`, `omitted`, or "same as above".

3. Prefer real production payloads when the bug is context-sensitive.
   - This is especially important for long-context regressions.
   - Performance can degrade with larger context windows, so the eval should reflect the real size and shape of the conversation.
   - If the bug depends on a long inbox listing, a long folder list, or prior auto-actions, keep those exact payloads.

4. Preserve the exact sequence of state changes.
   - Include the failed tool call before the corrective step.
   - Include the user correction that challenges the assistant.
   - Include the follow-up tool result that makes the right action possible.

5. Keep the eval faithful to the provider-specific shape.
   - For Gmail label bugs, keep both `name` and `path` exactly as returned.
   - If the bug is about display name vs provider path, the eval must include the real folder list output.

## Specific Repeated Mistake To Avoid

For the `Dev/Github` label regression:

- Do not write a compact example that starts only at `"But it does exist. Please check."`
- Do not omit the original system prompt.
- Do not omit the initial greeting, inbox listing, auto-delete action, failed `move_to_folder`, or the exact error text.
- Do not shorten the `list_inbox` or `list_folders` outputs.

The correct eval should include:

- the full prompt context
- the full conversation from the start of the session
- the full `list_inbox` output
- the full failed `move_to_folder` output
- the full `list_folders` output
- the final successful `move_to_folder` step if the eval covers the recovery

## Practical Standard

If you are copying a case from Langfuse observations:

- copy the prompt verbatim
- copy each assistant/user turn verbatim
- copy each tool input verbatim
- copy each tool output verbatim

Default to fidelity over brevity.

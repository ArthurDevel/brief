# OpenPoke System

Short summary of the OpenPoke architecture and how this repo adapted it for WhatsApp text.

- Source article: https://www.shloked.com/writing/openpoke
- Related local plan: [.docs/plans/2026.04.22-whatsapp-text-execution-agent.md](/Users/Focus/conductor/workspaces/brief-v2/albuquerque-v1/.docs/plans/2026.04.22-whatsapp-text-execution-agent.md)

## High-Level Summary

OpenPoke is a multi-agent assistant architecture inspired by Poke.

At a high level:

- The Interaction Agent is the only agent that talks to the user.
- The Interaction Agent decides whether to reply directly, wait, show a draft, or delegate work.
- The Execution Agents do the actual task work with tools.
- Execution Agents can be reused for the same thread of work over time.
- Tools are mostly atomic operations.
- More complex workflows can be wrapped as higher-level tasks.
- Background systems can wake agents up again later, for example triggers and inbox monitoring.
- Memory is layered:
  recent conversation stays detailed, older history gets summarized, and external systems like email act as long-term memory.

## Main OpenPoke Components

### Interaction Agent

The article describes the Interaction Agent as the conductor:

- owns user conversation
- owns personality and UX
- can delegate to one or more execution agents
- can use a `wait` action to avoid repeating itself
- can show drafts before send actions

### Execution Agents

The article describes Execution Agents as specialized workers:

- each has its own prompt, history, and tool loop
- each owns a thread of work
- they persist and can be reused later
- they return status/results back to the Interaction Agent

### Tools, Tasks, Triggers, Monitoring

The article separates concerns like this:

- Tools: small atomic actions
- Tasks: larger orchestrated operations exposed to execution agents
- Triggers: scheduled reactivation of execution work
- Monitoring: background workers that proactively send notable events back into the interaction layer

### Memory

The article describes multiple memory layers:

- conversation memory for the Interaction Agent
- persistent per-agent execution history
- external systems like Gmail as durable memory

## What We Implemented In This Repo

This repo currently applies the OpenPoke idea to the WhatsApp text flow in `apps/whatsapp-server`.

Implemented pieces:

- an Interaction Agent for WhatsApp text
- an Execution Agent for delegated tool work
- tool-calling through OpenRouter
- Composio-backed execution tools
- WhatsApp auth-template custom tools inside the execution session
- `send_message_to_user`, `send_message_to_agent`, `send_draft`, and `wait`
- immediate user-visible action emission from the interaction loop

Relevant files:

- [apps/whatsapp-server/src/text/interactionAgent.ts](/Users/Focus/conductor/workspaces/brief-v2/albuquerque-v1/apps/whatsapp-server/src/text/interactionAgent.ts)
- [apps/whatsapp-server/src/text/executionAgent.ts](/Users/Focus/conductor/workspaces/brief-v2/albuquerque-v1/apps/whatsapp-server/src/text/executionAgent.ts)
- [apps/whatsapp-server/src/text/promptBuilder.ts](/Users/Focus/conductor/workspaces/brief-v2/albuquerque-v1/apps/whatsapp-server/src/text/promptBuilder.ts)
- [apps/whatsapp-server/src/text/openRouterClient.ts](/Users/Focus/conductor/workspaces/brief-v2/albuquerque-v1/apps/whatsapp-server/src/text/openRouterClient.ts)
- [apps/whatsapp-server/src/text/conversationStore.ts](/Users/Focus/conductor/workspaces/brief-v2/albuquerque-v1/apps/whatsapp-server/src/text/conversationStore.ts)
- [apps/whatsapp-server/src/text/whatsappTextCustomTools.ts](/Users/Focus/conductor/workspaces/brief-v2/albuquerque-v1/apps/whatsapp-server/src/text/whatsappTextCustomTools.ts)
- [apps/whatsapp-server/src/whatsAppBot.ts](/Users/Focus/conductor/workspaces/brief-v2/albuquerque-v1/apps/whatsapp-server/src/whatsAppBot.ts)

## Adaptations In This Repo

This section is intentionally explicit. These are the important ways this repo differs from the OpenPoke system described in the article.

### 1. Execution agents are not persistent workers

OpenPoke:

- execution agents persist over time
- the interaction layer can reuse an existing agent for the same thread of work

This repo:

- creates a fresh execution runtime per delegated text turn
- does not keep a persistent execution-agent roster
- does not preserve per-agent execution memory across turns

Effect:

- simpler implementation
- less continuity than OpenPoke

### 2. Execution is synchronous inside one WhatsApp turn

OpenPoke:

- supports more asynchronous behavior
- background systems can wake work back up later

This repo:

- runs delegated execution during the same inbound WhatsApp text handling flow
- waits for the execution result before the interaction loop continues

Effect:

- simpler control flow
- fewer moving parts
- no background continuation for normal text execution

### 3. No trigger system

OpenPoke:

- has trigger ownership and scheduled reactivation

This repo:

- does not implement trigger creation, updates, listing, or scheduled wakeups in the WhatsApp text runtime

Effect:

- reminders and recurring automations are not part of this text-agent layer

### 4. No inbox monitor / proactive background monitor

OpenPoke:

- has background inbox monitoring that can feed important events back to the Interaction Agent

This repo:

- only reacts to inbound WhatsApp messages and the current execution flow

Effect:

- no proactive “by the way, this important email arrived” behavior from this system

### 5. Tool surface is narrower and WhatsApp-specific

OpenPoke:

- presents a broader execution architecture with Gmail tools, tasks, triggers, and background systems

This repo:

- uses a narrower execution surface
- relies on Composio session tools for connected apps
- adds WhatsApp-specific auth-template tools for connector recovery/onboarding

Effect:

- more practical for the current WhatsApp integration
- less broad than the full OpenPoke system

### 6. Auth commands still bypass the agent flow

OpenPoke:

- the article focuses on the interaction/execution system as the main behavior

This repo:

- keeps explicit WhatsApp auth commands as a fast path outside the interaction/execution loop
- examples: `authenticate gmail`, `authenticate notion`, `authenticate overview`

Effect:

- preserves the existing connector flow
- intentionally keeps some product behavior outside the OpenPoke-style runtime

### 7. Channel-specific prompt and UX

OpenPoke:

- is described as a texting assistant with its own personality and product behavior

This repo:

- uses WhatsApp-text-specific prompts
- keeps messages concise for WhatsApp delivery
- renders drafts as WhatsApp text messages

Effect:

- same architectural idea
- different channel behavior and prompt wording

### 8. Memory is much simpler

OpenPoke:

- has layered memory, summarization, persistent per-agent history, and external-memory usage

This repo:

- uses `whatsapp_messages` conversation history
- uses `user_memory` entries from shared storage
- does not implement the full layered summarization system from the article
- does not implement persistent execution-agent histories

Effect:

- enough context for the WhatsApp flow
- much simpler than OpenPoke memory design

### 9. Failure fallback was adapted: summarize stuck execution runs

This is one of the clearest custom adaptations.

OpenPoke article:

- describes execution agents returning results back to the Interaction Agent
- does not describe this exact fallback

This repo:

- if the execution loop fails, including too many tool-call iterations, we do not just drop the entire turn
- we collect the recent execution trace
- we send that trace to a separate `google/gemini-3-flash-preview` summarizer
- that summarizer produces a short execution-style summary for the Interaction Agent
- the Interaction Agent can then continue the conversation naturally instead of only falling back to a generic transport-level failure

Relevant code:

- [apps/whatsapp-server/src/text/executionAgent.ts](/Users/Focus/conductor/workspaces/brief-v2/albuquerque-v1/apps/whatsapp-server/src/text/executionAgent.ts)
- [apps/whatsapp-server/src/text/promptBuilder.ts](/Users/Focus/conductor/workspaces/brief-v2/albuquerque-v1/apps/whatsapp-server/src/text/promptBuilder.ts)

Effect:

- better degraded behavior when execution gets stuck
- this is a repo-specific adaptation, not a direct OpenPoke copy

### 10. We added detailed server-side logs

OpenPoke article:

- explains the architecture
- does not prescribe this logging approach

This repo:

- adds logs around inbound turn prep, interaction iterations, execution session creation, tool calls, and outbound sends

Effect:

- easier to debug the new system while it is still evolving

## Practical Reading Of The System Here

If you want the shortest mental model for this repo:

- `whatsAppBot.ts` receives the WhatsApp text message
- `conversationStore.ts` stores inbound text and loads context
- `interactionAgent.ts` decides whether to message the user, wait, draft, or delegate
- `executionAgent.ts` runs Composio-backed work when delegation is needed
- the interaction layer sends final user-visible actions back to WhatsApp

This is OpenPoke-inspired orchestration, but it is intentionally a smaller, WhatsApp-specific adaptation rather than a full clone.

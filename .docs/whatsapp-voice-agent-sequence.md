# WhatsApp Voice Agent Sequence

Short summary of the current voice-agent handoff and the future narrator hook.

- Shows the main agents and runtime boundaries
- Shows where the interaction agent enters a waiting state
- Shows where a future narrator agent can attach without owning execution

## Overview

```mermaid
sequenceDiagram
    actor User
    participant Voice as Voice Runtime
    participant IA as Interaction Agent
    participant EA as Execution Agent
    participant NA as Narrator Agent (Future)

    User->>Voice: speaks
    Voice->>IA: request

    alt IA can answer immediately
        IA-->>Voice: reply
        Voice-->>User: spoken answer
    else IA needs work done
        IA->>EA: delegate task
        Note over IA,EA: IA is waiting
        par narrator runs independently
            loop while EA is active
                NA->>EA: read recent executor context
                NA->>NA: generate and buffer latest narration
            end
        and execution continues
            Note over EA: working on delegated task
        end

        opt silence during waiting
            Voice->>NA: request latest buffered narration
            NA-->>Voice: latest narration from buffer
            Voice-->>User: "Still working on it..."
        end

        EA-->>IA: final result
        Note over Voice: If narration is still playing, let it finish first
        IA-->>Voice: final outcome
        Voice-->>User: spoken answer or WhatsApp action
    end
```

## Detailed Sequence

```mermaid
sequenceDiagram
    autonumber

    actor User
    participant Voice as LiveKit Voice Runtime
    participant IA as Interaction Agent
    participant EA as Execution Agent
    participant Tools as Connected App Tools
    participant NA as Narrator Agent (Future)

    Note over Voice: State: listening
    Voice->>IA: conversation_start
    IA-->>Voice: greet user
    Voice-->>User: spoken greeting

    User->>Voice: speaks request
    Voice->>IA: finalized user turn

    alt Interaction can answer directly
        IA-->>Voice: user-visible reply
        Voice-->>User: spoken answer
        Note over Voice: State: listening
    else Interaction delegates work
        IA-->>Voice: short status update
        Voice-->>User: "One moment..."

        IA->>EA: delegated task in plain English
        Note over IA,EA: State: IA waiting for EA

        par Narrator runs independently while EA is active
            loop Every few seconds
                NA->>EA: read recent messages and current progress
                NA->>NA: generate one short narration sentence
                NA->>NA: store latest sentence in buffer
            end
        and Execution steps
            loop Execution steps
                EA->>Tools: run tool / lookup / app action
                Tools-->>EA: result
                Note over EA: State: working
            end
        end

        opt Silence needs filling
            Voice->>NA: request latest buffered narration
            NA-->>Voice: latest sentence from buffer
            Voice-->>User: "Checking your calendar..."
        end

        EA-->>IA: final result in plain English
        Note over IA,EA: State: waiting finished

        opt Narration still in progress
            Note over Voice: Wait for short narration playout to finish
        end

        alt User reply needed
            IA-->>Voice: final user-visible message
            Voice-->>User: spoken answer
        else Auth / reconnect needed
            IA-->>Voice: send WhatsApp auth or overview action
            Voice-->>User: template and/or spoken guidance
        else No reply needed
            IA-->>Voice: wait
            Note over Voice: State: listening
        end
    end
```

## State Summary

- `listening`
  Voice runtime is idle and waiting for the next finalized user turn.

- `interaction active`
  The interaction agent is deciding whether to answer directly, delegate, or wait.

- `waiting for execution`
  The interaction agent has handed off work to the execution agent and is blocked on the result.

- `execution working`
  The execution agent is using connected app tools and building a final result for the interaction agent.

- `narration active` (future)
  A separate narrator agent continuously reads recent executor context, generates short narration candidates, and keeps the latest one in a buffer while the interaction agent is in `waiting for execution`.

- `final reply queued behind narration` (future)
  If a short narration is still playing when execution finishes, the final interaction reply waits for that narration playout to complete.

- `narration buffered` (future)
  The narrator agent may already have a fresh sentence ready before the voice runtime asks for one.

## Important Boundary

The interaction agent remains the only agent that owns the user conversation outcome:

- it decides when to delegate
- it decides whether the final outcome is a spoken reply, a WhatsApp auth action, or `wait`
- the narrator agent, if added later, only fills silence during the waiting period

The execution agent does not talk to the user directly. It only returns progress and a final result back into the interaction layer.

The narrator agent does not execute tools or decide outcomes. It continuously watches recent execution context, keeps a latest sentence in a buffer, and returns that buffered sentence when the voice runtime asks for one.

The narrator agent only generates text. The voice runtime decides whether to speak that text and is responsible for TTS playback.

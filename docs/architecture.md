# Architecture

## Principle

Hermes Agent owns Hermes semantics and durable state. DeepSeek Harness owns the outer DSH agent loop and presentation. The bridge translates protocol and schema boundaries only.

```text
DeepSeek Harness
  ├─ system prompt sections ─────────────┐
  ├─ hermes_* tool registrations ────────┼─ Node bridge client
  ├─ /hermes-learn command ──────────────┤    JSON Lines / stdio
  └─ optional review subagent ───────────┘           │
                                                     ▼
                                            Python adapter process
                                              ├─ Hermes memory/skills
                                              ├─ Hermes tool registry
                                              ├─ Hermes tool dispatcher
                                              └─ documented AIAgent API
                                                     │
                                                     ▼
                                                HERMES_HOME
```

## Lanes

### Shared-state lane

The adapter imports the installed Hermes memory and skill implementations. DSH reads one frozen memory snapshot per session so later writes never mutate an existing model-prefix cache. Tool writes go through Hermes' own bounds, locks, atomic operations, provenance, security checks, and curator policy.

When `syncSkills` is explicitly enabled, user-managed Hermes skills under `$HERMES_HOME/skills` are additively linked into `$DSH_HOME/skills`. Only valid skill directories containing `SKILL.md` are linked. Existing paths are never replaced or deleted, directory ownership/permissions are checked, and the option defaults off.

### Tool-mirroring lane

On activation, the adapter asks Hermes for the live tool definitions resolved for the configured toolsets. DSH registers one `hermes_<name>` tool for every non-agent-loop definition. JSON Schema is projected into DSH's supported schema DSL; unsupported validation annotations are deliberately omitted rather than guessed. Execution returns to Hermes' central dispatcher, preserving tool middleware, plugin hooks, capability gates, and result normalization.

Hermes agent-loop tools (`memory`, `session_search`, `delegate_task`, `todo`, `clarify`) are not blindly mirrored because Hermes rejects them outside its loop. Memory has a native adapter; full-loop behavior is available through delegation.

### Full-agent lane

`hermes_delegate` creates one documented `run_agent.AIAgent` per request. It uses the selected Hermes profile, providers, toolsets, plugins, MCP servers, memory, skills, and safety configuration. Instances are never shared concurrently. DSH cancellation terminates the bridge child because the embedded Hermes API does not expose a universal cooperative cancellation primitive for every provider/tool path.

### Adaptive-learning lane

`/hermes-learn` uses Hermes' own prompt builder. Optional background review runs as a restricted DSH fork that can only call namespaced Hermes memory and skill tools. Host-only read provenance is carried between isolated `skill_view` and `skill_manage` calls, then re-applied through Hermes' own background-write guard; internal source paths are not returned to the model. The curator calls Hermes' due-check and implementation. Both features default off for cost and mutation safety.

## Process and lifecycle

- Every request gets an isolated, one-shot Python child and exactly one JSON response envelope. Cancellation or timeout cannot affect a sibling request or contaminate later framing.
- DSH `AbortSignal` cancellation and operation timeouts terminate only the request-owned child, escalating from SIGTERM to SIGKILL based on observed process exit.
- Requests/responses and stderr buffers are bounded; protocol IDs and envelope shape are validated.
- Every DSH registration and child belongs to the active Cordis fiber; update, stop, or uninstall removes it.
- The Python bridge validates the checkout and private-state ownership before importing it. The child receives a minimal base environment plus only explicitly allowlisted variables.
- Stateful, delegated, and dynamically mirrored tools return DSH's `ask` pre-execute decision by default, so missing approval support fails closed.

## Compatibility strategy

Hermes' documented `AIAgent` embedding API is used for full delegation. Dynamic tool mirroring currently uses Hermes implementation modules (`model_tools` and `tools.registry`) because Hermes does not publish a standalone registry protocol. Startup feature probes fail loud when those contracts move. CI pins the reviewed Hermes 0.20.5 baseline; releases state the exact tested commit.

No Hermes source is copied into this package.

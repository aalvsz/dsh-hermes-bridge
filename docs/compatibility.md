# Compatibility Contract

Tested baseline:

- Hermes Agent 0.20.5, Python 3.11
- DeepSeek Harness 0.1.1-rc.2
- Node.js 22.19+ and 24+

| Hermes surface | Bridge level | DSH exposure | Notes |
|---|---|---|---|
| Personal/user memory | Native shared state | prompt snapshot + `hermes_memory` | Same `HERMES_HOME`; Hermes bounds, locks, atomic writes, and provenance apply. |
| User skills | Native shared state | namespaced tools; optional DSH catalog links | Link creation is opt-in and additive only; existing paths are never replaced or deleted. |
| Bundled/optional/plugin skills | Full through Hermes | namespaced skill tools + `hermes_delegate` | Not copied into DSH; resolved by Hermes discovery. |
| `/learn` | Native workflow | `/hermes-learn` | Hermes builds the learning prompt; DSH steers it as a user turn. |
| Background review | Orchestration adapter | restricted DSH fork | Off by default; Hermes prompts and write policy. |
| Curator | Native call | due-check after completed turns | Off by default. |
| Built-in registry tools | Dynamic mirror | `hermes_<tool>` | Capability-gated by Hermes. |
| Python plugins registering tools | Dynamic mirror | `hermes_<tool>` | Loaded by the selected Hermes profile. |
| MCP tools | Dynamic mirror | `hermes_mcp_<server>_<tool>` | Server remains configured/operated by Hermes. |
| Browser, file, terminal, web | Dynamic mirror + delegation | namespaced tools / `hermes_delegate` | High-impact; preserve Hermes checks and approvals. |
| Vision, image, video, TTS, media | Dynamic mirror + delegation | namespaced tools / `hermes_delegate` | Availability depends on platform, providers, and optional dependencies. |
| Cron and automation | Dynamic mirror + delegation | `hermes_cronjob` when available | Hermes owns scheduler persistence and daemon lifecycle. |
| Messaging platform tools | Dynamic mirror + delegation | namespaced tools when platform context permits | Hermes gateway owns credentials, routing, and delivery. |
| Inbound/outbound webhooks | Hermes-operated | delegate/tool effects only | Listener/queue is not re-hosted inside DSH. |
| Providers/models/fallback/MoA | Full-agent lane | `hermes_delegate` | DSH's own model route remains independent. |
| Hermes sessions | Full-agent lane | delegated run session ID | Hermes persistence remains canonical; DSH transcript is separate. |
| Delegation/subagents | Full-agent lane | `hermes_delegate` | Hermes child tree lives inside the delegated run. |
| Profiles/config/secrets | Selected runtime | environment/configured Hermes home | No credentials are copied. |
| Checkpoints/worktrees/backends | Full-agent lane | delegated run | Depends on Hermes configuration and working directory. |
| Desktop widgets/TUI widgets | UI-only boundary | not copied | They require Hermes' Electron/Ink host. |
| Dashboard pages/native notifications | UI-only boundary | not copied | Operate the Hermes dashboard/desktop separately. |
| API server/ACP/TUI gateway | External protocols | not required by default | Future alternate transports can be added without changing shared-state semantics. |

## Degraded behavior

Activation fails with an actionable diagnostic if the Hermes checkout, Python runtime, required implementation modules, or initial tool catalog cannot be loaded. Individual capability gates remain visible through `hermes_status`; the bridge never fabricates availability.

## Versioning

- Patch releases: bridge fixes with unchanged compatibility contract.
- Minor releases: new mapped Hermes/DSH surfaces or optional transports.
- Major releases: configuration, naming, or durable-state contract changes.

Hermes implementation-module drift may require a bridge patch even when Hermes' user-facing version change is minor. CI against Hermes `main` provides advance warning; released packages should pin a tested compatibility range in their release notes.

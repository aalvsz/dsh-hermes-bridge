# dsh-hermes-bridge

[![CI](https://github.com/aalvsz/dsh-hermes-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/aalvsz/dsh-hermes-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Use Hermes Agent from DeepSeek Harness without forking, copying, or reimplementing Hermes.**

`dsh-hermes-bridge` mounts the user's real Hermes installation into DSH through four complementary lanes:

1. **Shared state:** Hermes memory and skills remain the source of truth and are available from both agents.
2. **Live tool mirroring:** every currently available Hermes registry tool—including plugin and MCP tools—is projected into DSH under `hermes_*` names.
3. **Full-agent delegation:** `hermes_delegate` runs the documented Hermes `AIAgent` with its models, providers, toolsets, memory, skills, MCP, and automation.
4. **Adaptive learning:** Hermes `/learn`, frozen memory snapshots, optional background review, curator checks, and skill provenance remain Hermes-owned.

This is an independent community project. It is not endorsed by Nous Research or DeepSeek AI.

## What appears in DSH

| Hermes capability | DSH surface |
|---|---|
| `MEMORY.md` / `USER.md` | frozen system-prompt snapshot + `hermes_memory` |
| Skills | `hermes_skills_list`, `hermes_skill_view`, `hermes_skill_manage`; optional additive-only links in the DSH skill catalog |
| All available built-in tools | `hermes_<tool>` |
| Hermes plugins and MCP tools | dynamically mirrored when present in Hermes' live registry |
| Full Hermes agent loop | `hermes_delegate` |
| Learning workflow | `/hermes-learn` |
| Capability/compatibility diagnostics | `hermes_status` |
| Background memory/skill review | optional DSH subagent fork using only Hermes memory/skill tools |
| Curator | optional, due-checked through the real Hermes curator |

Tool availability remains capability-gated by Hermes. A missing credential, gateway, browser, MCP server, platform, or optional dependency stays unavailable instead of being simulated.

## Requirements

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) 0.20.5 or newer, installed as a checkout with its Python environment
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 0.1.1-rc.2 or compatible
- Node.js 22.19+ or 24+
- Python 3.11–3.13

Hermes currently documents checkout-based embedding rather than a standalone library wheel. The bridge therefore discovers the installed checkout and Python environment; it never vendors Hermes source.

## Install

Until an npm release is published, install directly from GitHub:

```sh
dsh plugin --profile web add github:aalvsz/dsh-hermes-bridge
```

After the npm release:

```sh
dsh plugin --profile web add @aalvsz/dsh-hermes-bridge
```

Restart DSH after installation. The included bundle enables the bridge with safe defaults.

If Hermes is in its default installer location (`~/.hermes/hermes-agent`), no path configuration is required. Otherwise set:

```sh
export HERMES_HOME=/path/to/profile-home
export HERMES_AGENT_ROOT=/path/to/hermes-agent
export HERMES_PYTHON=/path/to/hermes-agent/venv/bin/python
```

Windows uses the corresponding `venv\\Scripts\\python.exe` path.

## Configure

Override the package row in the active profile's `cordis.patch.yml`:

```yaml
- id: dsh/hermes-bridge
  config:
    enabled: true
    namespace: hermes
    toolsets:
      - all
    disabledToolsets:
      - terminal       # example hardening for a shared deployment
    mirrorTools: true
    delegateAgent: true
    requireApproval: true
    envAllowlist: []             # explicit ambient variables passed to Hermes
    delegateRoots:
      - /path/to/workspace       # allowed initial cwd roots for delegation
    syncSkills: false            # opt-in additive-only DSH catalog links
    backgroundReview: false
    curator: false
    operationTimeoutMs: 120000
    delegateTimeoutMs: 900000
    maxResponseBytes: 8388608
```

### Important defaults

- `backgroundReview`, `curator`, and DSH skill-catalog linking are **off** until explicitly enabled.
- Tool mirroring and full delegation are available, but `requireApproval: true` asks through DSH before every stateful, delegated, or dynamically mirrored call. Read-only status/skill discovery remains immediate.
- Only basic process variables cross into Python. Ambient credentials cross only when their variable names are explicitly listed in `envAllowlist`; Hermes may also load credentials from its own separately managed configuration.
- Delegation starts only inside `delegateRoots` (the DSH process working directory by default).
- All mirrored names are prefixed with `hermes_`; the bridge never shadows native DSH tools.
- Hermes and DSH share the selected `HERMES_HOME`. Changes are intentionally visible on both sides.

## Examples

Ask DSH to use a concrete Hermes tool:

```text
Use hermes_web_search to research the current Hermes Agent release.
```

Delegate a complete task to Hermes:

```text
Use hermes_delegate to inspect this repository with Hermes' coding toolset and return a verified test plan.
```

Create a skill once and use it from either agent:

```text
Run /hermes-learn release verification for this repository.
```

Inspect what is actually available:

```text
Call hermes_status and summarize unavailable Hermes toolsets.
```

## “Everything” and honest boundaries

The bridge automatically imports **every capability represented in Hermes' live tool registry** and can run a **complete Hermes agent** for capabilities that belong to its agent loop. Memory and user skills are shared natively.

Some Hermes features are host applications rather than agent capabilities. Hermes Desktop widgets, TUI widgets, dashboard pages, and native notification UI remain in their Hermes host; copying their interface into DSH would not be a runtime bridge. Gateway daemons, messaging platform connections, webhook listeners, cron scheduling, browser controllers, and MCP servers continue to be operated by Hermes, while their configured agent-facing tools are usable from DSH.

See [`docs/compatibility.md`](docs/compatibility.md) for the complete contract and [`docs/architecture.md`](docs/architecture.md) for lifecycle and security design.

## Development

```sh
npm install
npm test
npm run verify
```

Tests use temporary Hermes homes and never write the user's real memory or skills. Integration tests run when a Hermes checkout is discoverable and otherwise report as skipped. CI pins the documented Hermes 0.20.5 baseline and every third-party Action to immutable commits.

## Security

Hermes tools may access terminals, files, browsers, messages, cron, models, and external MCP servers. Namespacing prevents collisions; it does not reduce authority. Review [`SECURITY.md`](SECURITY.md), restrict toolsets for shared profiles, and configure only trusted Hermes checkouts and plugins.

## License

MIT. Hermes Agent and DeepSeek Harness are separate MIT-licensed projects; see [`NOTICE`](NOTICE).

# dsh-hermes-bridge

[![CI](https://github.com/aalvsz/dsh-hermes-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/aalvsz/dsh-hermes-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Native adaptive intelligence for DeepSeek Harness — no Hermes or Python dependency.**

`dsh-hermes-bridge` reimplements Hermes's adaptive intelligence layer as a
standalone DSH plugin in JavaScript. It provides what Hermes provides on top
of the base agent loop — persistent memory, reusable skills, skill authoring,
background review, and curator — without requiring a separate Hermes installation.

## What appears in DSH

| Capability | DSH surface |
|---|---|
| Persistent memory (MEMORY.md / USER.md) | `hermes_memory` + frozen system-prompt snapshot |
| Reusable skills (SKILL.md catalog) | `hermes_skills_list`, `hermes_skill_view`, `hermes_skill_manage` |
| Skill authoring | `/hermes-learn` |
| Background memory/skill review | optional DSH subagent fork |
| Curator | optional due-checked integration |
| Capability diagnostics | `hermes_status` |

DSH already provides the agent loop, tool calling, providers, subagents,
sessions, approvals, file/bash/web tools, and model routing. This plugin adds
the adaptive layer that DSH lacks natively.

## Differences from v0.1.0 (bridge)

v0.1.0 was a **bridge** that connected to a real Hermes Python installation.
v0.2.0 is a **native reimplementation** — no Hermes, no Python, no subprocess.
Memory and skills are pure JavaScript with standard `fs` operations.

## Install

```sh
dsh plugin --profile web add github:aalvsz/dsh-hermes-bridge
```

## Configure

Override the package row in your profile's `cordis.patch.yml`:

```yaml
- id: dsh/hermes-bridge
  config:
    enabled: true
    namespace: hermes
    backgroundReview: false
    curator: false
    memoryCharLimit: 2200
    userCharLimit: 1375
    memoryNudgeInterval: 10
    skillNudgeInterval: 10
```

### Defaults

- `backgroundReview` and `curator` are **off** until explicitly enabled.
- Memory and skill files use mode `0600`; directories use `0700`.
- All tools are namespaced `hermes_*` to avoid collisions with native DSH tools.

## Development

```sh
npm install
npm test
npm run verify
```

## License

MIT.

# Architecture

## Principle

DSH provides the agent loop, tool system, model routing, subagents, sessions,
and approvals. This plugin adds Hermes's adaptive intelligence patterns:
persistent memory, reusable skills, skill authoring, background review, and
curator. Everything is native JavaScript — no Python, no subprocess, no Hermes.

```
DeepSeek Harness
  ├─ system prompt sections (memory snapshot, skills, capabilities)
  ├─ hermes_memory tool ───────────── MEMORY.md / USER.md
  ├─ hermes_skills_list/view/manage ─ skills/ directory
  ├─ /hermes-learn command ────────── skill authoring prompt
  ├─ optional review subagent ─────── background memory/skill review
  └─ optional curator ─────────────── due-checked skill consolidation
```

## Memory

`MemoryStore` persists `MEMORY.md` and `USER.md` under `<root>/memories/`.
A frozen snapshot per session is injected into the system prompt so writes
during a turn do not invalidate model prompt caching.

## Skills

`SkillCatalog` manages `SKILL.md` files under `<root>/skills/`. Skills have
YAML frontmatter (name, description) and markdown bodies. Categories are
optional. File operations are constrained to `references/`, `templates/`,
`scripts/`, and `assets/` subdirectories.

## Background review

When enabled, a DSH subagent fork reviews memory and skills at configurable
intervals. The fork can only call `hermes_memory` and `hermes_skill_*` tools.
Disabled by default for cost safety.

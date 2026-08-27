# Architecture

## Principle

DSH provides the agent loop, tool system, model routing, subagents, sessions,
and approvals. This plugin adds Hermes's adaptive intelligence patterns:
persistent memory, reusable skills, skill authoring, background review,
curator, and RL trajectory collection. Everything is native JavaScript —
no Python, no subprocess, no Hermes.

```
DeepSeek Harness
  ├─ system prompt sections (memory snapshot, skills, capabilities)
  ├─ hermes_memory tool ───────────── MEMORY.md / USER.md
  ├─ hermes_skills_list/view/manage ─ skills/ directory
  ├─ /hermes-learn command ────────── skill authoring prompt
  ├─ optional review subagent ─────── background memory/skill review
  ├─ optional curator ─────────────── due-checked skill consolidation
  ├─ hermes_trajectory_save ───────── trajectory_samples.jsonl
  └─ hermes_trajectory_compress ───── compressed JSONL for fine-tuning
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

## RL trajectory pipeline

`TrajectoryRecorder` converts OpenAI-format messages to ShareGPT trajectory
format (`{from, value}`) using the same conversion as Hermes's
`convert_to_trajectory_format`:

- System message includes tool definitions in `<tools>` tags
- Tool calls wrapped in `<execute>` / `</execute>` tags
- Tool responses wrapped in `<result>` / `</result>` tags
- Assistant reasoning wrapped in think tags
- `<REASONING_SCRATCHPAD>` converted to think tags
- Every gpt turn gets a think block (empty if no reasoning)

`TrajectoryCompressor` compresses trajectories to fit within a token budget,
mirroring Hermes's `trajectory_compressor.py`:

1. Protected head: first system, human, gpt, and tool turns
2. Protected tail: last N turns
3. Compressible middle: accumulated until enough token savings
4. Boundary snapping: no `tool` turn without its preceding `gpt` turn
5. Compressed region replaced with a single human summary message
6. LLM summarization with retry and fallback

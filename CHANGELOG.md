# Changelog

## 0.2.1 - 2026-08-27

- RL trajectory capture: converts DSH conversation turns to ShareGPT format with execute/result/think XML tags.
- Automatic trajectory save on turn/end when saveTrajectories: true.
- Trajectory compression pipeline: protected region detection, boundary snapping, LLM summarization, token budget.
- hermes_trajectory_save and hermes_trajectory_compress tools.
- 9 new tests covering trajectory recording and compression (18 total, all passing).

## 0.2.0 - 2026-08-27

- Native JavaScript reimplementation: no Hermes or Python dependency.
- Persistent memory (MEMORY.md/USER.md) with bounded limits, atomic operations, and per-session frozen snapshots.
- Skill catalog with create/read/patch/delete, categories, and restricted file operations.
- `/hermes-learn` skill authoring workflow.
- Optional background review and curator as DSH-native subagent orchestration.
- Capability diagnostics and status tool.

## 0.1.0 - 2026-08-27

- Bridge to real Hermes Python runtime via subprocess JSON-lines protocol.
- Dynamic tool mirroring, full-agent delegation, approval gates.
- Superseded by native v0.2.0.

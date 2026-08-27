# Security Policy

## Supported versions

Security fixes are applied to the latest release on the default branch.

## Data handling

Memory (`MEMORY.md`, `USER.md`) and skill files are written with mode `0600`
under the configured DSH home. Skill file operations are constrained to
`references/`, `templates/`, `scripts/`, and `assets/` subdirectories.

No telemetry, no network calls, no credentials stored or transmitted.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository.

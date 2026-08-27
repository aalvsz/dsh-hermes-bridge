# Security Policy

## Supported versions

Security fixes are applied to the latest release on the default branch.

## Trust model

`dsh-hermes-bridge` executes code from a separately installed Hermes Agent checkout. Installing the bridge means you trust that checkout, its configured plugins, MCP servers, tools, and credentials. The bridge does not download Hermes, copy credentials, or enable Hermes YOLO mode.

The Python child receives only a small base process environment (`PATH`, home/user, locale, temporary-directory, terminal, and platform variables). Ambient provider credentials or other variables cross only when their names are explicitly configured in `envAllowlist`. Hermes may separately load credentials from its own configuration. Configure `HERMES_AGENT_ROOT` only to a checkout you trust.

Mirrored tools keep their Hermes runtime checks and hooks. Namespacing prevents accidental DSH tool-name collisions; it is not a sandbox. Toolsets such as `terminal`, `browser`, messaging, cron, and MCP can have high impact. By default, every delegated, stateful, or dynamically mirrored call also requires DSH approval and fails closed if no approval channel exists. Keep `requireApproval` enabled and restrict `toolsets` or `disabledToolsets` for shared deployments.

Background review and the curator are disabled by default because they can consume model credits and mutate durable memory or skills. They require an explicit configuration opt-in.

## Data handling

The bridge shares the selected `HERMES_HOME` with Hermes Agent. Memory and skills written from DSH are immediately durable in Hermes state. Optional user-skill links are disabled by default and additive only. Existing DSH paths are never replaced or deleted. Both state roots must be owned by the current user and not writable by group or other users.

Each call runs in an isolated child process. Requests and responses are bounded by `maxResponseBytes`, cancellation affects only that call, protocol envelopes are identity-checked, and bridge stderr is bounded and redacted before diagnostics. Delegated initial working directories must remain inside `delegateRoots`. No telemetry is added by this project.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not include API keys, OAuth tokens, private transcripts, memory files, or proprietary skills in a report. Include a minimal sanitized reproduction and affected versions.

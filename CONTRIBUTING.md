# Contributing

Contributions are welcome.

## Development

Requirements:

- Node.js 22.19+ or 24+
- Python 3.11–3.13
- a separate Hermes Agent checkout with its environment installed
- DeepSeek Harness packages resolved by `npm install`

```sh
npm install
npm test
npm run verify
```

Set these variables when Hermes is not in its default location:

```sh
export HERMES_AGENT_ROOT=/path/to/hermes-agent
export HERMES_PYTHON=/path/to/hermes-agent/venv/bin/python
export HERMES_HOME=/tmp/hermes-bridge-test-home
```

## Change requirements

1. Add a failing behavior-level test first.
2. Keep Hermes as the source of truth; do not reimplement Hermes memory, skills, tools, providers, or agent semantics in JavaScript.
3. Keep every DSH side effect fiber-owned and disposable.
4. Preserve namespacing, path containment, request bounds, cancellation, and fail-closed capability checks.
5. Update the compatibility matrix and architecture documentation with behavior changes.
6. Never commit credentials, local state, transcripts, personal memory, private skills, or absolute machine paths.

## Scope

Direct adapters are preferred for documented Hermes APIs and protocols. Imports from Hermes implementation modules require a feature probe and an honest compatibility note. Visual Hermes Desktop/TUI widgets belong in their native host and should not be copied into DSH.

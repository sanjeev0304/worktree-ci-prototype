# Safety Guardrails

These guardrails protect production. The CI gate
(`.github/workflows/worktree-ci-gate.yml`) enforces them automatically on every pull
request to `main`.

## Guardrail 1: the core layer is off limits

- `src/core-engine.js` must **NEVER** be modified by Person B or Person C.
- Only the Lead Architect (Person A) may change it.
- If a fix seems to need a core change, stop and raise it with the Lead Architect
  instead of editing the file.
- **CI:** any pull request that touches `src/core-engine.js` is marked
  **VIOLATION** and fails.

## Guardrail 2: small blast radius

- Any single bug-fix PR must change **fewer than 80 lines of code** in total
  (lines added + lines removed).
- Split larger work into several small PRs.
- **CI:** a pull request with more than 80 changed lines fails.

## Guardrail 3: nothing ships broken

- `node tests/verify-app.js` must pass before merging.
- **CI:** a failing smoke test fails the pull request.

## For Claude in any worktree

- Check these guardrails before proposing or making a change.
- If a request would break a guardrail, say so and suggest a compliant alternative.

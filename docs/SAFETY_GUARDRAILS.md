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
- Generated evidence in `qa-evidence/` does not count toward this limit.
- **CI:** a pull request with more than 80 changed lines fails.

## Guardrail 3: nothing ships broken

- `node tests/verify-app.js` must pass before merging.
- **CI:** a failing smoke test fails the pull request.

## Guardrail 4: Mandatory 4-Step Pre-PR Protocol

Every pull request must go through these four steps, in order.

| Rule | Requirement |
|---|---|
| **RULE 1** | Never create a PR immediately after editing code. |
| **RULE 2** | Always run `node scripts/run-pre-pr-audit.js` first to log API flight times, responses, and capture UI screenshots. |
| **RULE 3** | Start the local server on `http://localhost:3456` and PAUSE to let the user manually test the application in their browser. Wait for the user to confirm ("Manual check passed") and record their manual observation notes with `node scripts/run-pre-pr-audit.js --manual-passed "<notes>"`. |
| **RULE 4** | When creating the PR via `gh pr create`, inject the full contents of `qa-evidence/PR_AUDIT_REPORT.md` (API flight-time logs, manual check confirmation, embedded screenshot) into the PR description: `gh pr create --body-file qa-evidence/PR_AUDIT_REPORT.md`. |

- **CI:** a pull request that does not update both `qa-evidence/PR_AUDIT_REPORT.md`
  and `qa-evidence/latest-ui-proof.png` fails. Opening a PR without running the
  Pre-PR Audit is blocked automatically.

## For Claude in any worktree

- Check these guardrails before proposing or making a change.
- If a request would break a guardrail, say so and suggest a compliant alternative.

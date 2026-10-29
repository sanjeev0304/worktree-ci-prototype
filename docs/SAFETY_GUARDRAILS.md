# Safety Guardrails

> **Prompts are guardrails; CI is the law.** Every rule below is enforced in code
> (CI jobs, CODEOWNERS, ESLint, Git hooks), not only by Claude following instructions.

## 📋 Guardrail 0: every change starts as a GitHub Project task, on its own branch

**Before editing code or running any test in a worktree**, Claude must run:

```bash
node scripts/manage-project-task.js create --title "<Task Name>" --type "<Task|Issue|Bug>" --severity "<Low|Medium|High|Critical>"
```

Severity defaults to `Low`. The task lives on the **Enterprise Worktree Task Tracker**
GitHub Project (fields: Task Name, Severity, Type, Status), mirrored as `severity:*`,
`type:*` and `status:*` labels on the issue.

| When | Status | Set by |
|---|---|---|
| Issue created | `Todo` | `manage-project-task.js create` |
| Branch `<type>/<issue-id>-<short-description>` created | `In Progress` | `manage-project-task.js create` |
| Pull request opened | `In Review` | CI: `task-lifecycle.yml` |
| Pull request **merged** | `Done` | CI: `task-lifecycle.yml`; GitHub closes the issue via `Closes #<issue>` |
| PR closed without merging | `In Progress` | CI: `task-lifecycle.yml` |
| Work on hold | `Blocked` | `manage-project-task.js status --set Blocked` |

A task is never closed before its code lands: `Done` cannot be set by hand, and the CI
gate fails a PR whose linked issue is already closed.

- **CI:** the PR body must contain `Closes #<issue>`, the issue must exist and be open,
  and it must match the issue id in the branch name.

## 🌿 Guardrail 0b: branch naming

Branches are named `<type>/<issue-id>-<short-description>`, e.g. `fix/104-login-timeout`.
`<type>` is one of `feat fix chore docs refactor test ci perf hotfix`; the description is
lowercase words joined by `-`; the whole name is at most 60 characters.

- **Local:** `.githooks/pre-commit` and `.githooks/pre-push` refuse other names.
- **CI:** the safety gate fails a PR from a badly named branch.

## ⛔ DEFINITION OF DONE FOR ANY CODE EDIT

A code change is **not done** when the file is saved. For every bug fix or code
change, even when the request doesn't mention testing or PRs, Claude must do all of
this **in the same turn** as the edit:

1. Run `npm run check` (lint, typecheck, unit, e2e, smoke).
2. Run `node scripts/run-pre-pr-audit.js` to test the API, log flight times and
   capture the screenshot.
3. Make sure the local server is running on `http://localhost:3456`.
4. Show the API flight-time results in the chat and ask: *"I have tested the API and
   started the local server on http://localhost:3456. Please check it manually and
   reply APPROVED before I commit or create a PR."*
5. **Not run `git commit`** until the user confirms their manual check.

**Enforced by Git:** `.githooks/pre-commit` refuses any commit that changes `src/`
unless this branch's local `qa-evidence/PR_AUDIT_REPORT.md` contains
"✅ Manual check passed". Turn the hooks on once per clone with
`node scripts/install-hooks.js` (sets `git config core.hooksPath .githooks`).

**Fresh worktrees:** `.githooks/post-checkout` runs whenever a worktree is created.
It fetches `origin/main` and moves the new worktree onto it, so every task starts from
the latest code and rules. If the branch already has its own commits, it warns you to
run `git merge origin/main` instead.

---

These guardrails protect production. The CI gate
(`.github/workflows/worktree-ci-gate.yml`) enforces them automatically on every pull
request to `main`.

## Guardrail 1: the core layer is off limits

- `src/core-engine.js` must **NEVER** be modified by Person B or Person C.
- Only the Lead Architect (Person A, GitHub `sanjeev0304`) may change it.
- If a fix seems to need a core change, stop and raise it with the Lead Architect
  instead of editing the file.
- **CODEOWNERS:** `.github/CODEOWNERS` makes the Lead Architect the required reviewer
  for the core file and for every governance file (CI, hooks, scripts, lint config,
  docs). Turn on "Require review from Code Owners" for `main` so this is enforced.
- **ESLint boundary rules** (`eslint.config.js`): the core may not `require` the UI
  layer or the server; the UI layer may not touch core internals
  (`USERS`, `CUSTOMERS`, `connection`).
- **CI:** a PR that touches `src/core-engine.js` fails unless its author is the Lead
  Architect.

## Guardrail 2: small blast radius

- Any single PR may change **at most 80 lines of application code** (`src/` + `tests/`,
  lines added + lines removed).
- Governance files (`.github/`, `.githooks/`, `scripts/`, config, docs) do not count;
  they are gated by CODEOWNERS review instead.
- Split larger work into several small PRs.
- **CI:** a PR with more than 80 changed app-code lines fails.

## Guardrail 3: nothing ships broken (review layer 1, deterministic)

- `npm run check` must pass: ESLint, `tsc --checkJs` typecheck, unit tests
  (`tests/unit/`), e2e tests (`tests/e2e/`) and the smoke test (`tests/verify-app.js`).
- **CI:** the `checks` job runs all of them; any failure fails the PR.

## Guardrail 4: Mandatory 4-Step Pre-PR Protocol

Every pull request must go through these four steps, in order.

| Rule | Requirement |
|---|---|
| **RULE 1** | Never create a PR immediately after editing code. |
| **RULE 2** | Always run `node scripts/run-pre-pr-audit.js` first to log API flight times, responses, and capture UI screenshots. |
| **RULE 3** | Start the local server on `http://localhost:3456` and PAUSE to let the user manually test the application in their browser. Wait for the user to confirm (APPROVED or "Manual check passed") and record their manual observation notes with `node scripts/run-pre-pr-audit.js --manual-passed "<notes>"`. |
| **RULE 4** | Create the PR with the report as its description: `gh pr create --body-file qa-evidence/PR_AUDIT_REPORT.md`. |

- **No evidence in Git:** `qa-evidence/` is git-ignored. CI re-runs the audit, uploads
  the screenshot and report as the `qa-evidence` GitHub Actions artifact
  (`gh run download <run-id> -n qa-evidence`) and posts the telemetry as a PR comment.
  **CI** fails a PR that commits anything under `qa-evidence/`.
- **CI:** a PR whose body does not contain "Manual check passed" fails.

## Guardrail 5: AI code review (review layer 2, advisory)

- `.github/workflows/claude-code-review.yml` runs Claude on every PR. It reads these
  docs and posts inline comments on bugs, business-rule and architecture breaks,
  security issues, and weakened gates.
- It is advisory: it never blocks a merge. Layer 1 is the gate.
- Needs the `ANTHROPIC_API_KEY` repository secret; without it the job skips with a notice.

## For Claude in any worktree

- Check these guardrails before proposing or making a change.
- If a request would break a guardrail, say so and suggest a compliant alternative.

# CLAUDE.md — Master Context Router

## 📋 STEP 0: CREATE THE GITHUB PROJECT TASK FIRST

**BEFORE editing any code or running any test in a worktree, you MUST create the task on the "Enterprise Worktree Task Tracker" GitHub Project:**

```bash
node scripts/manage-project-task.js create --title "<Task Name>" --type "<Task|Issue|Bug>" --severity "<Low|Medium|High|Critical>"
```

- **Task Name:** a short title for the work. **Type:** `Task`, `Issue` or `Bug`.
  **Severity:** `Low` (the default if the user doesn't say), `Medium`, `High`, `Critical`.
- Pick Type and Severity from the user's request; if unclear, use `Bug` for fixes,
  `Task` for new work, and `Low` severity. Tell the user the issue number you created.
- This creates the GitHub Issue (**Todo**), then creates and checks out the branch
  `<type>/<issue-id>-<short-description>` (e.g. `fix/104-login-timeout`) and moves the
  task to **In Progress**. Use `--branch-type <feat|fix|chore|docs|refactor|test|ci|perf|hotfix>`
  to override the default (`Bug`/`Issue` → `fix`, `Task` → `feat`).
- **Status lifecycle: `Todo → In Progress → In Review → Done → Deployed`**
  - `Todo`: issue created. `In Progress`: branch created (both by `create`).
  - `In Review`: set by CI (`.github/workflows/task-lifecycle.yml`) when the PR opens.
  - `Done`: set by CI when the PR **merges**; GitHub closes the issue via `Closes #<issue>`.
    Nothing closes a task before its PR merges, and `Done` cannot be set by hand.
  - `Deployed`: set by CI (`chatops-cicd.yml`) when a merged PR is released to prod
    with a `release: <name>` comment. Cannot be set by hand either.
  - **One-time setup, or the board never leaves `In Progress`:** CI can only move cards
    with a `PROJECT_TOKEN` repo secret (classic PAT, scopes `repo` + `project`). The
    built-in `GITHUB_TOKEN` cannot see a user-owned Project, so without it only the
    `status:*` label changes. Create the PAT on GitHub, then run `gh secret set PROJECT_TOKEN`.
    Backup: in the board's **Workflows** menu, turn on **Item closed** and **Pull request
    merged**, both set to Status `Done`.
  - If the `Task Lifecycle` check is red, the board was not updated. After fixing the
    token, backfill: `node scripts/manage-project-task.js sync --issue <N> --set Done`.
  - `Blocked`: set by hand if the work is on hold:
    `node scripts/manage-project-task.js status --set Blocked --note "<why>"`.

## ⛔ DEFINITION OF DONE FOR ANY CODE EDIT

**CRITICAL WORKFLOW RULE: Whenever a user asks you to fix a bug or change any code (even if they do NOT mention testing or PRs in their prompt), you are FORBIDDEN from ending your turn right after editing the file. In the exact same turn, immediately after editing the code, you MUST:**

1. **Run `npm run check` (lint, typecheck, unit, e2e, smoke) and fix anything it reports.**
2. **Run `node scripts/run-pre-pr-audit.js` to test the API, log flight times, and capture the screenshot.**
3. **Ensure the local server is running on `http://localhost:3456`.**
4. **Show the user the API flight-time results in the chat and ask: 'I have tested the API and started the local server on http://localhost:3456. Please check it manually and reply APPROVED before I commit or create a PR.'**
5. **Do NOT run `git commit` until the user replies confirming their manual check!**

How to do it:

- Start `node src/server.js` **in the background first**, then run the audit. The audit
  reuses a running server and leaves it up; a server the audit starts itself is
  stopped when the audit ends.
- Show the API Flight-Time Telemetry table and the RULE #404 result from
  `qa-evidence/PR_AUDIT_REPORT.md` in the chat.
- When the user replies APPROVED (or "Manual check passed"), record it with
  `node scripts/run-pre-pr-audit.js --manual-passed "<user's notes>"`, then commit the code.
- **Never commit `qa-evidence/`.** It is git-ignored. The report becomes the PR body and
  CI uploads the screenshot as the `qa-evidence` GitHub Actions artifact.
- Git hooks enforce this (run `node scripts/install-hooks.js` once per clone):
  `pre-commit` blocks commits on badly named branches, commits of `qa-evidence/`, and
  `src/` commits without "✅ Manual check passed" in this branch's local report;
  `pre-push` blocks pushing badly named branches; `post-checkout` starts new worktrees
  from the latest `origin/main`.

---

This file is loaded automatically by Claude in every session and every Git worktree
created from this repository. It pulls in the full application context through the
`@` imports below, so each team member's isolated worktree starts with the same
knowledge of the system.

## Project

**worktree-ci-prototype** is a proof of concept showing how several team members can
work in parallel, isolated Claude Desktop Git worktrees while:

1. Sharing one consistent application "brain" (the docs imported below).
2. Protecting production with GitHub Actions CI gates on every pull request to `main`.

## Required context (always read)

- Architecture and ownership: @docs/ARCHITECTURE.md
- Business rules: @docs/BUSINESS_RULES.md
- Safety guardrails: @docs/SAFETY_GUARDRAILS.md

## Working rules for Claude

- Before changing any code, check which layer it belongs to (see ARCHITECTURE.md).
- Never edit `src/core-engine.js` unless the person asking is the Lead Architect (Person A).
- Keep every PR under 80 changed lines of application code (`src/` + `tests/`).
- Business rules in BUSINESS_RULES.md override any value found in the code.
- Run `npm run check` before committing.

Prompts are guardrails; CI is the law. Every rule above is also enforced in code:
CODEOWNERS, ESLint boundary rules, the diff-size check and the Git hooks.

## 🚦 MANDATORY 4-Step Pre-PR Protocol

Follow these steps, in order, every time you are about to open a pull request.
Do not skip or reorder them, even if the user asks for a quick PR.

1. **RULE 1: Never create a PR immediately after editing code.**
   Finish the change, run `npm run check`, then go to step 2.

2. **RULE 2: Always run `node scripts/run-pre-pr-audit.js` first.**
   It logs API flight times, status codes and responses, checks RULE #404, and
   captures `qa-evidence/latest-ui-proof.png`. The report leads with the evidence for
   what changed (screenshot for UI changes, API flight times + RULE #404 for
   calculation/API changes) and folds the common checks into one line. Read the report
   and tell the user what it found, including any RULE #404 failures.

3. **RULE 3: Start the server and PAUSE for a manual check.**
   - Start `node src/server.js` (in the background) so the app runs on http://localhost:3456.
   - Ask the user to test it in their browser, then **stop and wait**. Do not continue
     until the user replies APPROVED (or "Manual check passed").
   - Ask for their observation notes, then record them:
     `node scripts/run-pre-pr-audit.js --manual-passed "<user's notes>"`
   - Stop the server afterwards.

4. **RULE 4: Use the audit report as the PR description.**
   Commit the code (not `qa-evidence/`), push the branch, then:
   `gh pr create --base main --title "<title>" --body-file qa-evidence/PR_AUDIT_REPORT.md`
   The body carries the change's evidence, the manual check confirmation and
   `Closes #<issue>`. CI then posts the evidence comment (screenshot inline for UI
   changes) and uploads the `qa-evidence` Actions artifact, moves the
   task to In Review, and runs both review layers.

## Pull request review (two layers)

1. **Deterministic CI, blocking** (`.github/workflows/worktree-ci-gate.yml`): ESLint
   (with architecture boundary rules), `tsc --checkJs` typecheck, unit tests, e2e tests,
   smoke test, audit evidence artifact, and the safety gate (core-layer ownership,
   app-code diff size, branch name, `Closes #N` on an open issue, manual check).
2. **Claude code review, advisory** (`.github/workflows/claude-code-review.yml`):
   inline review comments on every PR. Needs the `ANTHROPIC_API_KEY` repo secret.

## 🌐 Environments (Phase 4: ChatOps on GitHub Pages)

One `main` branch, four environments on the `gh-pages` branch, driven by PR comments
(`.github/workflows/chatops-cicd.yml`, built by `scripts/build-gh-pages.js`):

| Command / event | Environment | URL |
|---|---|---|
| Comment `deploy: true` or `deploy: test` on an open PR | DEV | `https://sanjeev0304.github.io/worktree-ci-prototype/dev/<taskId>/` |
| Comment `deploy: <tag>` on an **approved** PR (or approve a PR that has one) | QA, tags the PR head | `.../qa/` |
| PR merged to `main` | PRE-PROD | `.../pre-prod/` |
| Comment `release: <name>` on a **merged** PR | PROD, GitHub Release, task `Deployed` | `.../prod/` |

- The portal at `https://sanjeev0304.github.io/worktree-ci-prototype/` lists every live environment.
- Only the repo owner, members and collaborators can run these commands.
- QA needs an approving review on the PR's latest commit. GitHub blocks approving your own
  PR, so a `deploy: <tag>` from the repo **owner** is accepted as a logged self-check.
- Each deploy rewrites only its own folder, plus the portal. Nothing is ever built from
  a PR's scripts: the builder runs from `main` and reads the PR's `src/` as data.

## Commands

```bash
node scripts/install-hooks.js               # once per clone: turn on the Git hooks
npm ci                                      # install lint/typecheck tooling
node scripts/manage-project-task.js create --title "..." --type Bug --severity Low   # STEP 0 (+ branch)
node scripts/manage-project-task.js status --set Blocked --note "..."   # manual status change
node scripts/manage-project-task.js show    # show the active task for this branch
node scripts/manage-project-task.js setup   # (re)create the project board, fields and labels
gh secret set PROJECT_TOKEN                 # once per repo: lets CI move board cards (PAT: repo + project)
node scripts/manage-project-task.js sync --issue 12 --set Done   # backfill a merged task the board missed
npm run check                               # lint + typecheck + unit + e2e + smoke
node src/server.js                          # run the app on http://localhost:3456
node scripts/run-pre-pr-audit.js            # RULE 2: API telemetry + UI screenshot + report
node scripts/run-pre-pr-audit.js --manual-passed "notes"   # RULE 3: record the user's manual check
node scripts/build-gh-pages.js --env dev --task 22 --version local   # preview a Pages build in gh-pages-build/
```

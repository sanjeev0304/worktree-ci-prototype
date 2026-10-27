# CLAUDE.md — Master Context Router

## ⛔ DEFINITION OF DONE FOR ANY CODE EDIT

**CRITICAL WORKFLOW RULE: Whenever a user asks you to fix a bug or change any code (even if they do NOT mention testing or PRs in their prompt), you are FORBIDDEN from ending your turn right after editing the file. In the exact same turn, immediately after editing the code, you MUST:**

1. **Run `node scripts/run-pre-pr-audit.js` to test the API, log flight times, and capture the screenshot.**
2. **Ensure the local server is running on `http://localhost:3456`.**
3. **Show the user the API flight-time results in the chat and ask: 'I have tested the API and started the local server on http://localhost:3456. Please check it manually and reply APPROVED before I commit or create a PR.'**
4. **Do NOT run `git commit` until the user replies confirming their manual check!**

How to do it:

- Start `node src/server.js` **in the background first**, then run the audit. The audit
  reuses a running server and leaves it up; a server the audit starts itself is
  stopped when the audit ends.
- Show the API Flight-Time Telemetry table and the RULE #404 result from
  `qa-evidence/PR_AUDIT_REPORT.md` in the chat.
- When the user replies APPROVED (or "Manual check passed"), record it with
  `node scripts/run-pre-pr-audit.js --manual-passed "<user's notes>"`, then commit the
  code together with everything in `qa-evidence/`.
- A Git pre-commit hook (`.githooks/pre-commit`) enforces this: a commit that changes
  `src/` is refused unless the staged audit report contains "✅ Manual check passed".
  Run `node scripts/install-hooks.js` once per clone to turn it on.

---

This file is loaded automatically by Claude in every session and every Git worktree
created from this repository. It pulls in the full application context through the
`@` imports below, so each team member's isolated worktree starts with the same
knowledge of the system.

## Project

**worktree-ci-prototype** is a proof of concept showing how several team members can
work in parallel, isolated Claude Desktop Git worktrees while:

1. Sharing one consistent application "brain" (the docs imported below).
2. Protecting production with a GitHub Actions CI gate on every pull request to `main`.

## Required context (always read)

- Architecture and ownership: @docs/ARCHITECTURE.md
- Business rules: @docs/BUSINESS_RULES.md
- Safety guardrails: @docs/SAFETY_GUARDRAILS.md

## Working rules for Claude

- Before changing any code, check which layer it belongs to (see ARCHITECTURE.md).
- Never edit `src/core-engine.js` unless the person asking is the Lead Architect (Person A).
- Keep every bug-fix PR under 80 changed lines (added + removed).
- Business rules in BUSINESS_RULES.md override any value found in the code.
- Run `node tests/verify-app.js` before committing.

## 🚦 MANDATORY 4-Step Pre-PR Protocol

Follow these steps, in order, every time you are about to open a pull request.
Do not skip or reorder them, even if the user asks for a quick PR. CI fails any PR
that lacks fresh evidence in `qa-evidence/`.

1. **RULE 1: Never create a PR immediately after editing code.**
   Finish the change, run `node tests/verify-app.js`, then go to step 2.

2. **RULE 2: Always run `node scripts/run-pre-pr-audit.js` first.**
   It logs API flight times, status codes and responses, checks RULE #404, and
   captures `qa-evidence/latest-ui-proof.png`. Read the report and tell the user what
   it found, including any RULE #404 failures.

3. **RULE 3: Start the server and PAUSE for a manual check.**
   - Start `node src/server.js` (in the background) so the app runs on http://localhost:3456.
   - Ask the user to test it in their browser, then **stop and wait**. Do not continue
     until the user replies APPROVED (or "Manual check passed").
   - Ask for their observation notes, then record them:
     `node scripts/run-pre-pr-audit.js --manual-passed "<user's notes>"`
   - Stop the server afterwards.

4. **RULE 4: Use the audit report as the PR description.**
   Commit the code together with `qa-evidence/PR_AUDIT_REPORT.md` and
   `qa-evidence/latest-ui-proof.png`, push the branch, then:
   `gh pr create --base main --title "<title>" --body-file qa-evidence/PR_AUDIT_REPORT.md`
   The body must contain the full report: API flight-time logs, the manual check
   confirmation and the embedded screenshot.

## Commands

```bash
node scripts/install-hooks.js               # once per clone: turn on the pre-commit hook
node tests/verify-app.js                    # smoke test: modules load and run without crashing
node src/server.js                          # run the app on http://localhost:3456
node scripts/run-pre-pr-audit.js            # RULE 2: API telemetry + UI screenshot + report
node scripts/run-pre-pr-audit.js --manual-passed "notes"   # RULE 3: record the user's manual check
```

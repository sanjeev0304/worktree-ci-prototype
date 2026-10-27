# CLAUDE.md — Master Context Router

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

## Commands

```bash
node tests/verify-app.js   # smoke test: both modules load and run without crashing
```

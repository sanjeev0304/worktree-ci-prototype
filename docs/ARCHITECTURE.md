# Architecture

This enterprise invoicing application has **two layers** with strict ownership.

```
┌──────────────────────────────────────────────┐
│  src/invoice-dashboard.js                    │  UI & Calculation Layer
│  - calculateInvoice()                        │  Owners: Person B, Person C
│  - renderInvoiceSummary()                    │  (bug fixes allowed)
└───────────────────────┬──────────────────────┘
                        │ require('./core-engine')
┌───────────────────────▼──────────────────────┐
│  src/core-engine.js                          │  Restricted Core Layer
│  - authenticate()                            │  Owner: Lead Architect (Person A) ONLY
│  - connectDatabase() / getCustomer()         │
└──────────────────────────────────────────────┘
```

## Branches

- `main`: production. Only the release PR from `qa` merges here.
- `qa`: integration and PRE-PROD. Every task PR targets `qa`.
- `<type>/<issue-id>-<slug>`: one task, cut from `qa`.
- `gh-pages`: the deployed environments (never merged).

## Layer 1: `src/core-engine.js` (Restricted Core Auth & Database Layer)

- **Owner:** Lead Architect, **Person A only**.
- **Responsibilities:** user authentication, session tokens, database connection,
  and customer record lookups.
- **Status:** restricted. Any change here is an architectural change and needs the
  Lead Architect. The CI gate fails any pull request that touches this file.

## Layer 2: `src/invoice-dashboard.js` (UI & Calculation Layer)

- **Owners:** **Person B and Person C** (Person A may also edit).
- **Responsibilities:** invoice math (subtotal, discounts, GST, totals) and
  formatting results for the dashboard.
- **Status:** open for bug fixes, within the limits in SAFETY_GUARDRAILS.md.
- Depends on `core-engine.js` through its public functions only. It must never
  reach into core internals.

## Web server: `src/server.js`

- Zero-dependency Node.js HTTP server on http://localhost:3456 (`node src/server.js`).
- `GET /` serves the Enterprise Invoice Dashboard web UI.
- `POST /api/calculate-invoice` takes `{ customerType: "VIP" | "STANDARD", amount }`
  and returns the itemized invoice, using both layers above.
- Part of the UI layer: Person B and C may fix bugs here.

## Pre-PR audit: `scripts/run-pre-pr-audit.js`

- Starts the server if needed, times real API calls, captures a UI screenshot and
  writes `qa-evidence/PR_AUDIT_REPORT.md` (git-ignored; used as the PR body).
  The report shows only the evidence the change needs (`scripts/lib/evidence-scope.js`).
  See Guardrail 4 in SAFETY_GUARDRAILS.md.

## GitHub Pages builder: `scripts/build-gh-pages.js`

- Builds one environment (`stage/<taskId>/`, `qa/`, `pre-prod/`, `prod/`) of the static
  calculator into a `gh-pages` checkout, then regenerates the root Environment Dashboard
  (the pipeline plus a card per live environment). `dev/<taskId>/` redirects to stage.
- Bundles `src/invoice-dashboard.js` verbatim, so the page runs the real RULE #404 math.
  The core layer (auth, sessions, database) is never shipped to the public site: the
  bundle gets a stub `./core-engine`.

## Tests

- `tests/unit/`: unit tests (`node --test`) for the invoice math and branch names.
- `tests/e2e/`: starts the HTTP server and exercises the API and UI routes.
- `tests/verify-app.js`: smoke test that loads every module and runs it end to end.
- `npm run check` runs lint, typecheck and all three.

## Static analysis

- `eslint.config.js`: lint rules plus **architecture boundary rules** for the two layers.
- `jsconfig.json`: `tsc --checkJs` typecheck of `src/`, `scripts/` and `tests/`.
- `.github/CODEOWNERS`: the Lead Architect reviews the core layer and all governance files.

## CI

- `.github/workflows/worktree-ci-gate.yml` (blocking): lint, typecheck, unit, e2e and
  smoke tests; the audit evidence artifact; and the safety gate (core ownership, app-code
  diff size, branch name, linked open issue, manual check).
- `.github/workflows/claude-code-review.yml` (advisory): Claude reviews every PR.
- `.github/workflows/deployment-pipeline.yml`: the 2-PR pipeline. Branch push → `stage/`,
  PR → `qa` with `deploy: qa-*` → tag + `qa/`, merge into `qa` → `pre-prod/`, release PR
  `qa` → `main` with `release: release-*` → GitHub Release + `prod/` + tasks Deployed.
- `.github/workflows/task-lifecycle.yml`: moves the task to In Review when its PR → `qa`
  opens and to Done (closing the issue) when it merges into `qa`. Needs the `PROJECT_TOKEN` secret to move the board card; fails if it cannot.

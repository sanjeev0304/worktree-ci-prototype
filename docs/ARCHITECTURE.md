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
  writes `qa-evidence/PR_AUDIT_REPORT.md`. See Guardrail 4 in SAFETY_GUARDRAILS.md.

## Tests

- `tests/verify-app.js`: zero-dependency Node.js smoke test that loads both modules
  and runs them end to end to catch syntax and runtime crashes.

## CI

- `.github/workflows/worktree-ci-gate.yml` runs on every pull request to `main`. It
  runs the smoke test, measures the blast radius of the change, and writes an
  "Executive Safety & Blast Radius Report" to the job summary.

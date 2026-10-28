# 🧪 Pre-PR Audit Report

| | |
|---|---|
| **Branch** | `feature/currency-selector` |
| **Audited commit** | `5c1d034` + uncommitted changes |
| **Generated** | 2026-10-28T16:26:35.135Z |
| **Run by** | sanjeev0304 · Node v26.0.0 · darwin |
| **Target** | http://localhost:3456 |

## 1. API Flight-Time Telemetry

| # | Endpoint | Method | Params Sent | Status Code | Flight Time (ms) | Response Body | Result |
|---|---|---|---|---:|---:|---|---|
| 1 | `/api/calculate-invoice` | POST | `{"customerType":"VIP","amount":1000}` | 200 | 0.69 | `{"subtotal":1000,"discount":500,"taxable":500,"gst":25,"total":525}` | ⚠️ RULE #404 FAIL |
| 2 | `/api/calculate-invoice` | POST | `{"customerType":"SUPER_IMPORTANT","amount":1000}` | 200 | 0.37 | `{"subtotal":1000,"discount":0,"taxable":1000,"gst":50,"total":1050}` | ⚠️ RULE #404 FAIL |
| 3 | `/api/calculate-invoice` | POST | `{"customerType":"IMPORTANT","amount":1000}` | 200 | 0.41 | `{"subtotal":1000,"discount":0,"taxable":1000,"gst":50,"total":1050}` | ⚠️ RULE #404 FAIL |
| 4 | `/api/calculate-invoice` | POST | `{"customerType":"STANDARD","amount":1000}` | 200 | 0.37 | `{"subtotal":1000,"discount":0,"taxable":1000,"gst":50,"total":1050}` | ⚠️ RULE #404 FAIL |
| 5 | `/api/calculate-invoice` | POST | `{"customerType":"GOLD","amount":1000}` | 400 | 0.43 | `{   "error": "customerType must be one of VIP, SUPER_IMPORTANT, IMPORTANT, STANDARD" }` | ✅ OK |

Average flight time: **0.45 ms** · slowest: **0.69 ms**

<details><summary>Full response #1: VIP invoice (primary)</summary>

```json
{
  "customer": {
    "id": "C001",
    "name": "Acme Industries",
    "type": "VIP",
    "isVip": true
  },
  "items": [
    {
      "description": "Enterprise services",
      "quantity": 1,
      "unitPrice": 1000
    }
  ],
  "currency": "INR",
  "rates": {
    "gstRate": 0.05,
    "vipDiscount": 0.5
  },
  "invoice": {
    "subtotal": 1000,
    "discount": 500,
    "taxable": 500,
    "gst": 25,
    "total": 525
  },
  "generatedAt": "2026-10-28T16:26:33.708Z"
}
```

</details>
<details><summary>Full response #2: Super important invoice</summary>

```json
{
  "customer": {
    "id": "C002",
    "name": "Globex Retail",
    "type": "SUPER_IMPORTANT",
    "isVip": false
  },
  "items": [
    {
      "description": "Enterprise services",
      "quantity": 1,
      "unitPrice": 1000
    }
  ],
  "currency": "INR",
  "rates": {
    "gstRate": 0.05,
    "vipDiscount": 0
  },
  "invoice": {
    "subtotal": 1000,
    "discount": 0,
    "taxable": 1000,
    "gst": 50,
    "total": 1050
  },
  "generatedAt": "2026-10-28T16:26:33.709Z"
}
```

</details>
<details><summary>Full response #3: Important invoice</summary>

```json
{
  "customer": {
    "id": "C002",
    "name": "Globex Retail",
    "type": "IMPORTANT",
    "isVip": false
  },
  "items": [
    {
      "description": "Enterprise services",
      "quantity": 1,
      "unitPrice": 1000
    }
  ],
  "currency": "INR",
  "rates": {
    "gstRate": 0.05,
    "vipDiscount": 0
  },
  "invoice": {
    "subtotal": 1000,
    "discount": 0,
    "taxable": 1000,
    "gst": 50,
    "total": 1050
  },
  "generatedAt": "2026-10-28T16:26:33.709Z"
}
```

</details>
<details><summary>Full response #4: Standard invoice</summary>

```json
{
  "customer": {
    "id": "C002",
    "name": "Globex Retail",
    "type": "STANDARD",
    "isVip": false
  },
  "items": [
    {
      "description": "Enterprise services",
      "quantity": 1,
      "unitPrice": 1000
    }
  ],
  "currency": "INR",
  "rates": {
    "gstRate": 0.05,
    "vipDiscount": 0
  },
  "invoice": {
    "subtotal": 1000,
    "discount": 0,
    "taxable": 1000,
    "gst": 50,
    "total": 1050
  },
  "generatedAt": "2026-10-28T16:26:33.710Z"
}
```

</details>
<details><summary>Full response #5: Invalid customer type</summary>

```json
{
  "error": "customerType must be one of VIP, SUPER_IMPORTANT, IMPORTANT, STANDARD"
}
```

</details>

## 2. Business Rule Check (RULE #404)

Primary case: `{ customerType: "VIP", amount: 1000 }`

| Field | Expected (18% GST, 10% VIP cap) | Actual | |
|---|---:|---:|---|
| subtotal | 1000.00 | 1000.00 | ✅ |
| discount | 100.00 | 500.00 | ❌ |
| taxable | 900.00 | 500.00 | ❌ |
| gst | 162.00 | 25.00 | ❌ |
| total | 1062.00 | 525.00 | ❌ |

**RULE #404: ❌ VIOLATED** — the app does not follow the business rules yet.

## 3. Automated UI Test Logs

```text
[2026-10-28T16:26:33.698Z] Pre-PR audit started on branch feature/currency-selector (5c1d034).
[2026-10-28T16:26:33.708Z] Server already running at http://localhost:3456; reusing it.
[2026-10-28T16:26:33.708Z] API VIP invoice (primary): POST /api/calculate-invoice {"customerType":"VIP","amount":1000} → 200 in 0.69 ms · RULE #404 FAIL
[2026-10-28T16:26:33.709Z] API Super important invoice: POST /api/calculate-invoice {"customerType":"SUPER_IMPORTANT","amount":1000} → 200 in 0.37 ms · RULE #404 FAIL
[2026-10-28T16:26:33.709Z] API Important invoice: POST /api/calculate-invoice {"customerType":"IMPORTANT","amount":1000} → 200 in 0.41 ms · RULE #404 FAIL
[2026-10-28T16:26:33.710Z] API Standard invoice: POST /api/calculate-invoice {"customerType":"STANDARD","amount":1000} → 200 in 0.37 ms · RULE #404 FAIL
[2026-10-28T16:26:33.710Z] API Invalid customer type: POST /api/calculate-invoice {"customerType":"GOLD","amount":1000} → 400 in 0.43 ms
[2026-10-28T16:26:33.710Z] Playwright not installed; trying headless Chrome.
[2026-10-28T16:26:33.710Z] Using headless Chrome: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
[2026-10-28T16:26:34.637Z] UI: page loaded, form auto-submitted (VIP, 1000); ready=true.
[2026-10-28T16:26:34.637Z] UI: dashboard shows total ₹525.00.
[2026-10-28T16:26:34.637Z] UI: total matches API (525): yes
[2026-10-28T16:26:35.135Z] Screenshot saved: qa-evidence/latest-ui-proof.png (54338 bytes) via Headless Chrome.
[2026-10-28T16:26:35.135Z] Manual check recorded as PASSED by sanjeev0304.
[2026-10-28T16:26:35.135Z] Audit finished: evidence complete.
```

## 4. UI Screenshot Proof

Captured with: **Headless Chrome**

![Enterprise Invoice Dashboard: latest UI proof](https://github.com/sanjeev0304/worktree-ci-prototype/blob/feature%2Fcurrency-selector/qa-evidence/latest-ui-proof.png?raw=true)

## 5. Manual Verification (Protocol RULE 3)

**✅ Manual check passed** — confirmed by sanjeev0304 on 2026-10-28T16:26:35.135Z

Observation notes:

> Dropdown lists VIP, Super important, Important, Standard. New types calculate with 0% discount. Currency switch works. RULE #404 still shows Violated (existing GST/VIP bug).

## 6. Pre-PR Protocol Checklist

- [x] RULE 1: PR not opened straight after editing code
- [x] RULE 2: Pre-PR audit run (API telemetry + screenshot)
- [x] RULE 3: Manual check on http://localhost:3456 confirmed by the user
- [x] RULE 4: This report is the PR description (`gh pr create --body-file qa-evidence/PR_AUDIT_REPORT.md`)

---
_Generated by `scripts/run-pre-pr-audit.js`._

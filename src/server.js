/**
 * server.js — zero-dependency HTTP server for the Enterprise Invoice Dashboard.
 *
 *   GET  /                        Web UI (invoice form + result)
 *   POST /api/calculate-invoice   { customerType: "VIP" | "STANDARD", amount: number }
 *   GET  /health                  { ok: true }
 *
 * Run: node src/server.js        (default port 3456, override with PORT)
 */
'use strict';

const http = require('http');
const core = require('./core-engine');
const dashboard = require('./invoice-dashboard');

const DEFAULT_PORT = 3456;

// Service account the API uses to talk to the core layer.
const SERVICE_EMAIL = 'bob@enterprise.com';
const SERVICE_PASSWORD = 'finance123';

// Demo customer used for each customer type.
const CUSTOMER_BY_TYPE = { VIP: 'C001', STANDARD: 'C002' };

/** Validates input and returns the itemized invoice. Throws { status, message } on bad input. */
function buildInvoice(body) {
  const customerType = String((body && body.customerType) || '').toUpperCase();
  const amount = Number(body && body.amount);

  if (!CUSTOMER_BY_TYPE[customerType]) {
    throw { status: 400, message: 'customerType must be "VIP" or "STANDARD"' };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw { status: 400, message: 'amount must be a positive number' };
  }

  core.connectDatabase();
  const session = core.authenticate(SERVICE_EMAIL, SERVICE_PASSWORD);
  const customer = core.getCustomer(session, CUSTOMER_BY_TYPE[customerType]);
  const items = [{ description: 'Enterprise services', quantity: 1, unitPrice: amount }];
  const invoice = dashboard.calculateInvoice(items, customer);

  return {
    customer: { id: customer.id, name: customer.name, type: customerType, isVip: customer.isVip },
    items,
    rates: { gstRate: dashboard.GST_RATE, vipDiscount: customer.isVip ? dashboard.VIP_DISCOUNT : 0 },
    invoice,
    generatedAt: new Date().toISOString(),
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject({ status: 413, message: 'Payload too large' });
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject({ status: 400, message: 'Body must be valid JSON' });
      }
    });
    req.on('error', reject);
  });
}

function renderPage() {
  const renderedAt = new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enterprise Invoice Dashboard</title>
<style>
  :root { --bg:#eef1f8; --card:#fff; --ink:#14182b; --muted:#5d6782; --line:#e2e6f0; --accent:#4f46e5; --accent2:#0ea5a4;
    --total-bg:#eef2ff; --bad:#b91c1c; --bad-bg:#fee2e2; --good:#047857; --good-bg:#d1fae5; --shadow:0 1px 2px rgba(20,24,43,.06), 0 8px 24px rgba(20,24,43,.08); }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d1020; --card:#171b31; --ink:#e7e9f5; --muted:#9aa3c0; --line:#2a3050; --accent:#818cf8; --accent2:#2dd4bf;
      --total-bg:#1f2547; --bad:#fca5a5; --bad-bg:#3b1518; --good:#6ee7b7; --good-bg:#0f2f26; --shadow:0 8px 24px rgba(0,0,0,.35); }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--ink); }
  header { background:linear-gradient(120deg, #312e81 0%, #4f46e5 55%, #0ea5a4 100%); color:#fff; padding:28px 24px 32px; }
  header .wrap { max-width:760px; margin:0 auto; display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  header h1 { margin:0; font-size:22px; letter-spacing:-.01em; }
  header p { margin:4px 0 0; color:#dfe3ff; font-size:13px; }
  .badge { font-size:12px; font-weight:600; padding:5px 12px; border-radius:999px; background:rgba(255,255,255,.16); border:1px solid rgba(255,255,255,.3); }
  main { max-width:760px; margin:-16px auto 24px; padding:0 16px; display:grid; gap:18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:22px; box-shadow:var(--shadow); border-top:3px solid var(--accent); }
  #result-card { border-top-color:var(--accent2); }
  .card h2 { margin:0 0 14px; font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  form { display:flex; flex-wrap:wrap; gap:14px; align-items:flex-end; }
  label { display:grid; gap:6px; font-size:13px; font-weight:600; color:var(--muted); }
  select, input { font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:8px; min-width:180px; background:var(--card); color:var(--ink); }
  select:focus, input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(79,70,229,.2); }
  button { font:inherit; font-weight:600; padding:10px 22px; background:linear-gradient(120deg, var(--accent), var(--accent2)); color:#fff; border:0; border-radius:8px; cursor:pointer; transition:transform .1s, box-shadow .1s; }
  button:hover { transform:translateY(-1px); box-shadow:0 6px 16px rgba(79,70,229,.35); }
  table { width:100%; border-collapse:collapse; }
  td { padding:11px 4px; border-bottom:1px solid var(--line); }
  td:first-child { color:var(--muted); }
  td:last-child { text-align:right; font-variant-numeric:tabular-nums; font-weight:500; }
  tr.total td { font-weight:700; font-size:19px; border-bottom:0; background:var(--total-bg); color:var(--accent); padding:14px 12px; }
  tr.total td:first-child { border-radius:8px 0 0 8px; } tr.total td:last-child { border-radius:0 8px 8px 0; }
  .rule { font-size:13px; color:var(--muted); margin:16px 0 0; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
  .status { font-weight:600; font-size:12px; padding:4px 12px; border-radius:999px; }
  .status:empty { display:none; }
  .status.bad { color:var(--bad); background:var(--bad-bg); } .status.good { color:var(--good); background:var(--good-bg); }
  footer { text-align:center; color:var(--muted); font-size:12px; padding-bottom:28px; }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div>
      <h1>Enterprise Invoice Dashboard</h1>
      <p>worktree-ci-prototype · UI &amp; Calculation Layer</p>
    </div>
    <span class="badge">GST 18% · VIP discount ≤ 10%</span>
  </div>
</header>
<main>
  <section class="card">
    <h2>Calculate invoice</h2>
    <form id="invoice-form">
      <label>Customer type
        <select id="customerType" name="customerType">
          <option value="VIP" selected>VIP</option>
          <option value="STANDARD">Standard</option>
        </select>
      </label>
      <label>Amount (₹)
        <input id="amount" name="amount" type="number" min="1" step="0.01" value="1000">
      </label>
      <button id="calculate" type="submit">Calculate</button>
    </form>
  </section>
  <section class="card" id="result-card">
    <h2>Invoice</h2>
    <table id="result">
      <tr><td>Customer</td><td id="r-customer">—</td></tr>
      <tr><td>Subtotal</td><td id="r-subtotal">—</td></tr>
      <tr><td>Discount</td><td id="r-discount">—</td></tr>
      <tr><td>GST</td><td id="r-gst">—</td></tr>
      <tr class="total"><td>Total</td><td id="r-total">—</td></tr>
    </table>
    <p class="rule">RULE #404: GST must be exactly 18%; VIP discount capped at 10%.
      <span id="r-rule" class="status"></span></p>
  </section>
</main>
<footer>Rendered at ${renderedAt}</footer>
<script>
  const fmt = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const $ = (id) => document.getElementById(id);
  async function calculate(event) {
    if (event) event.preventDefault();
    const body = { customerType: $('customerType').value, amount: Number($('amount').value) };
    const res = await fetch('/api/calculate-invoice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { $('r-customer').textContent = 'Error: ' + data.error; return; }
    const inv = data.invoice;
    $('r-customer').textContent = data.customer.name + ' (' + data.customer.type + ')';
    $('r-subtotal').textContent = fmt(inv.subtotal);
    $('r-discount').textContent = '−' + fmt(inv.discount) + ' (' + Math.round(data.rates.vipDiscount * 100) + '%)';
    $('r-gst').textContent = fmt(inv.gst) + ' (' + Math.round(data.rates.gstRate * 100) + '%)';
    $('r-total').textContent = fmt(inv.total);
    const ok = data.rates.gstRate === 0.18 && data.rates.vipDiscount <= 0.10;
    $('r-rule').textContent = ok ? '✔ Compliant' : '✖ Violated';
    $('r-rule').className = 'status ' + (ok ? 'good' : 'bad');
    document.body.dataset.ready = 'true';
  }
  $('invoice-form').addEventListener('submit', calculate);
  calculate();
</script>
</body>
</html>`;
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderPage());
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === '/api/calculate-invoice') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
        const body = await readJson(req);
        return sendJson(res, 200, buildInvoice(body));
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const message = err && err.message ? err.message : 'Internal server error';
      return sendJson(res, status, { error: message });
    }
  });
}

module.exports = { createServer, buildInvoice, DEFAULT_PORT };

if (require.main === module) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  createServer().listen(port, () => {
    console.log(`Enterprise Invoice Dashboard running at http://localhost:${port}`);
  });
}

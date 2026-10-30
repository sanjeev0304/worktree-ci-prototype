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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap">
<style>
  :root { --bg:#eef1fb; --card:#fff; --ink:#1b2333; --muted:#5b6578; --line:#e3e7ef; --accent:#4f46e5; --accent-2:#7c3aed;
    --bad:#c62828; --bad-bg:#fdecec; --good:#1b7f3b; --good-bg:#e6f6ec; --warn:#b45309; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 "Inter", system-ui, sans-serif; color:var(--ink);
    background:radial-gradient(circle at top right, #e0e7ff, transparent 45%), var(--bg); min-height:100vh; }
  header { background:linear-gradient(120deg, #1e1b4b, var(--accent) 60%, var(--accent-2)); color:#fff; padding:28px 24px;
    box-shadow:0 4px 18px rgba(79,70,229,.25); }
  header h1 { margin:0; font-size:22px; letter-spacing:-.01em; }
  header p { margin:4px 0 0; color:#c7d2fe; font-size:13px; }
  main { max-width:760px; margin:28px auto; padding:0 16px; display:grid; gap:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-top:4px solid var(--accent); border-radius:12px;
    padding:22px; box-shadow:0 6px 20px rgba(27,35,51,.06); }
  #result-card { border-top-color:var(--accent-2); }
  .card h2 { margin:0 0 14px; font-size:16px; color:var(--accent); }
  form { display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end; }
  label { display:grid; gap:4px; font-size:13px; font-weight:600; color:var(--muted); }
  select, input { font:inherit; padding:9px 11px; border:1px solid var(--line); border-radius:8px; min-width:160px; background:#f9fafe; }
  select:focus, input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(79,70,229,.18); background:#fff; }
  button { font:inherit; font-weight:600; padding:10px 22px; background:linear-gradient(120deg, var(--accent), var(--accent-2));
    color:#fff; border:0; border-radius:8px; cursor:pointer; box-shadow:0 4px 12px rgba(79,70,229,.3); transition:transform .1s, box-shadow .1s; }
  button:hover { transform:translateY(-1px); box-shadow:0 6px 16px rgba(79,70,229,.4); }
  table { width:100%; border-collapse:collapse; }
  td { padding:10px 12px; border-bottom:1px solid var(--line); }
  td:first-child { color:var(--muted); }
  td:last-child { text-align:right; font-variant-numeric:tabular-nums; }
  #r-discount { color:var(--good); } #r-gst { color:var(--warn); }
  tr.total td { font-weight:700; font-size:18px; border-bottom:0; color:#fff; background:var(--accent); }
  tr.total td:first-child { border-radius:8px 0 0 8px; } tr.total td:last-child { border-radius:0 8px 8px 0; }
  .rule { font-size:13px; color:var(--muted); margin:16px 0 0; }
  .status { font-weight:600; padding:2px 10px; border-radius:999px; margin-left:6px; }
  .status.bad { color:var(--bad); background:var(--bad-bg); } .status.good { color:var(--good); background:var(--good-bg); }
  footer { text-align:center; color:var(--muted); font-size:12px; padding-bottom:24px; }
</style>
</head>
<body>
<header>
  <h1>Enterprise Invoice Dashboard</h1>
  <p>worktree-ci-prototype · UI &amp; Calculation Layer</p>
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

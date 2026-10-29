'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../../src/server');

test('invoice API end to end over HTTP', async (t) => {
  const server = createServer().listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://localhost:${/** @type {import('net').AddressInfo} */ (server.address()).port}`;
  const post = (body) =>
    fetch(`${base}/api/calculate-invoice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

  const ok = await post(JSON.stringify({ customerType: 'VIP', amount: 1000 }));
  assert.strictEqual(ok.status, 200);
  const data = await ok.json();
  assert.strictEqual(data.customer.isVip, true);
  assert.ok(Number.isFinite(data.invoice.total));

  assert.strictEqual((await post(JSON.stringify({ customerType: 'GOLD', amount: 1 }))).status, 400);
  assert.strictEqual((await post('{bad json')).status, 400);
  assert.strictEqual((await fetch(`${base}/api/calculate-invoice`)).status, 405);
  assert.strictEqual((await fetch(`${base}/health`)).status, 200);
  assert.match(await (await fetch(base)).text(), /Enterprise Invoice Dashboard/);
});

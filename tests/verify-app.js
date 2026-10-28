#!/usr/bin/env node
/**
 * verify-app.js — zero-dependency smoke test.
 *
 * Checks that src/core-engine.js and src/invoice-dashboard.js load and run without
 * syntax or runtime crashes. It does not check business-rule values.
 *
 * Usage: node tests/verify-app.js
 */
'use strict';

const assert = require('assert');
const path = require('path');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err && err.stack ? err.stack : err}`);
  }
}

console.log('Verifying application modules...\n');

let core;
let dashboard;

check('core-engine.js loads', () => {
  core = require(path.join(__dirname, '..', 'src', 'core-engine.js'));
  for (const fn of ['connectDatabase', 'authenticate', 'getCustomer', 'disconnectDatabase']) {
    assert.strictEqual(typeof core[fn], 'function', `missing export: ${fn}`);
  }
});

check('invoice-dashboard.js loads', () => {
  dashboard = require(path.join(__dirname, '..', 'src', 'invoice-dashboard.js'));
  for (const fn of ['calculateInvoice', 'renderInvoiceSummary', 'generateInvoiceForCustomer']) {
    assert.strictEqual(typeof dashboard[fn], 'function', `missing export: ${fn}`);
  }
});

check('core-engine: connect, authenticate, fetch customer', () => {
  core.connectDatabase();
  assert.ok(core.isConnected(), 'database should be connected');
  const session = core.authenticate('alice@enterprise.com', 'admin123');
  assert.strictEqual(typeof session.token, 'string');
  const customer = core.getCustomer(session, 'C001');
  assert.strictEqual(customer.id, 'C001');
});

check('core-engine: rejects bad credentials', () => {
  assert.throws(() => core.authenticate('alice@enterprise.com', 'wrong'));
});

check('invoice-dashboard: calculateInvoice returns finite numbers', () => {
  const items = [
    { description: 'Widget', quantity: 3, unitPrice: 250 },
    { description: 'Support', quantity: 1, unitPrice: 250 },
  ];
  for (const customer of [{ isVip: true }, { isVip: false }]) {
    const inv = dashboard.calculateInvoice(items, customer);
    for (const key of ['subtotal', 'discount', 'taxable', 'gst', 'total']) {
      assert.ok(Number.isFinite(inv[key]), `${key} should be a finite number`);
    }
  }
});

check('invoice-dashboard: end-to-end invoice generation', () => {
  const result = dashboard.generateInvoiceForCustomer(
    'bob@enterprise.com',
    'finance123',
    'C002',
    [{ description: 'Licence', quantity: 2, unitPrice: 500 }]
  );
  assert.ok(result.summary.includes('Globex Retail'));
  core.disconnectDatabase();
});

check('server.js loads and builds an API invoice', () => {
  const server = require(path.join(__dirname, '..', 'src', 'server.js'));
  assert.strictEqual(typeof server.createServer, 'function');
  const out = server.buildInvoice({ customerType: 'VIP', amount: 1000 });
  assert.ok(Number.isFinite(out.invoice.total), 'total should be a finite number');
  assert.throws(() => server.buildInvoice({ customerType: 'GOLD', amount: 1000 }));
  for (const customerType of ['SUPER_IMPORTANT', 'important']) {
    const tier = server.buildInvoice({ customerType, amount: 1000 });
    assert.strictEqual(tier.invoice.discount, 0, `${customerType} must get no discount (non-VIP)`);
  }
  assert.strictEqual(out.currency, 'INR', 'currency should default to INR');
  assert.strictEqual(server.buildInvoice({ customerType: 'VIP', amount: 1000, currency: 'usd' }).currency, 'USD');
  assert.throws(() => server.buildInvoice({ customerType: 'VIP', amount: 1000, currency: 'XYZ' }));
  core.disconnectDatabase();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

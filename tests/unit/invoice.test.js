'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { calculateInvoice, GST_RATE, VIP_DISCOUNT } = require('../../src/invoice-dashboard');
const { parseBranch, buildBranch } = require('../../scripts/lib/branch-name');

const items = [{ description: 'Widget', quantity: 4, unitPrice: 250 }];
const round2 = (n) => Math.round(n * 100) / 100;

test('calculateInvoice follows the documented calculation order', () => {
  const inv = calculateInvoice(items, { isVip: true });
  assert.strictEqual(inv.subtotal, 1000);
  assert.strictEqual(inv.discount, round2(1000 * VIP_DISCOUNT));
  assert.strictEqual(inv.taxable, round2(1000 - inv.discount));
  assert.strictEqual(inv.gst, round2(inv.taxable * GST_RATE));
  assert.strictEqual(inv.total, round2(inv.taxable + inv.gst));
});

test('non-VIP customers get no discount', () => {
  assert.strictEqual(calculateInvoice(items, { isVip: false }).discount, 0);
});

test('calculateInvoice rejects non-array items', () => {
  assert.throws(() => calculateInvoice(/** @type {any} */ ('x'), { isVip: false }), TypeError);
});

test('branch names follow <type>/<issue-id>-<short-description>', () => {
  assert.deepStrictEqual(parseBranch('fix/104-login-timeout'), { type: 'fix', issue: 104, slug: 'login-timeout' });
  for (const bad of ['claude/x', 'fix/login', 'Fix/1-a', 'fix/0-a', 'fix/1-Bad_Name']) assert.strictEqual(parseBranch(bad), null);
  assert.strictEqual(buildBranch('feat', 12, 'Export CSV!'), 'feat/12-export-csv');
});

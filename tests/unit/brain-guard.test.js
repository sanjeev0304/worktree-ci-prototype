'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseRules, checkRules } = require('../../scripts/brain-guard.cjs');

const GUARD = path.join(__dirname, '..', '..', 'scripts', 'brain-guard.cjs');
const run = (...args) => spawnSync(process.execPath, [GUARD, ...args], { encoding: 'utf8' });

test('brain-guard refuses to dump, print or export the vault', () => {
  for (const flag of ['--dump', '--print', '--export']) {
    const r = run(flag);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /ACCESS DENIED/);
  }
});

test('the probe runs the invoice math without opening the vault', () => {
  const r = run('--probe');
  assert.strictEqual(r.status, 0);
  assert.ok(JSON.parse(r.stdout).every((c) => typeof c.invoice.total === 'number'));
});

test('the rule check flags invoices that use other rates', () => {
  const rules = parseRules('- GST: `0.2`\n- VIP discount: at most `0.05`');
  const results = [{ isVip: true, subtotal: 100, invoice: { discount: 5, gst: 19, total: 114 } }];
  assert.ok(checkRules(rules, results).ok);
  assert.ok(!checkRules({ ...rules, gstRate: 0.3 }, results).ok);
});

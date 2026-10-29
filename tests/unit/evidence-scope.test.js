'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scopeFromDiff } = require('../../scripts/lib/evidence-scope');

const hunk = (file, context = '') => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@ ${context}\n-a\n+b`;

test('a change inside renderPage() needs only the screenshot', () => {
  const scope = scopeFromDiff(hunk('src/server.js', 'function renderPage() {'));
  assert.deepStrictEqual({ ui: scope.ui, api: scope.api }, { ui: true, api: false });
});

test('invoice math or API handler changes need the API evidence', () => {
  assert.strictEqual(scopeFromDiff(hunk('src/invoice-dashboard.js')).api, true);
  const handler = scopeFromDiff(hunk('src/server.js', 'function buildInvoice(body) {'));
  assert.deepStrictEqual({ ui: handler.ui, api: handler.api }, { ui: false, api: true });
});

test('scripts, docs, CI and tests need no app evidence', () => {
  const diff = ['scripts/x.js', 'docs/A.md', '.github/workflows/ci.yml', 'tests/unit/a.test.js'].map((f) => hunk(f)).join('\n');
  const scope = scopeFromDiff(diff);
  assert.deepStrictEqual(scope, { ui: false, api: false, files: ['scripts/x.js', 'docs/A.md', '.github/workflows/ci.yml', 'tests/unit/a.test.js'] });
});

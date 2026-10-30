'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { build, subpathFor } = require('../../scripts/build-gh-pages');

/** Runs a built app.js against a tiny fake DOM and returns the rendered text by id. */
function runBundle(dir, customerType, amount) {
  const el = {};
  const get = (id) => (el[id] ||= { value: { customerType, amount: String(amount) }[id], textContent: '', addEventListener() {} });
  const document = { getElementById: get, body: { dataset: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), { document });
  return (id) => el[id].textContent;
}

test('static build runs the real RULE #404 math in the browser bundle', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-pages-'));
  build({ env: 'qa', version: 'v1.0.1-qa', commit: 'abc1234def', task: '22', out });
  const vip = runBundle(path.join(out, 'qa'), 'VIP', 1000);
  assert.match(vip('r-total'), /1,062\.00/);
  assert.match(vip('r-rule'), /Compliant/);
  assert.match(runBundle(path.join(out, 'qa'), 'STANDARD', 1000)('r-total'), /1,180\.00/);
});

test('each environment only rewrites its own folder and the dashboard lists them all', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-pages-'));
  build({ env: 'stage', version: 'abc1234', task: '23', out });
  build({ env: 'prod', version: 'release-v1.2.0', task: '23,24', taskStatus: 'Deployed', out });
  assert.ok(fs.existsSync(path.join(out, 'stage/23/deploy.json')), 'stage build survives a prod deploy');
  assert.match(fs.readFileSync(path.join(out, 'dev/23/index.html'), 'utf8'), /url=\.\.\/\.\.\/stage\/23\//);
  const portal = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(portal, /href="prod\/"/);
  assert.match(portal, /href="stage\/23\/"/);
  assert.match(portal, /PR qa → main/);
  assert.match(fs.readFileSync(path.join(out, 'prod/index.html'), 'utf8'), />MAIN \/ PROD</);
});

test('stage folders are keyed by task id, else by a URL-safe branch name', () => {
  assert.strictEqual(subpathFor('dev', '23'), 'stage/23');
  assert.strictEqual(subpathFor('stage', '', 'Feat/My_Branch'), 'stage/feat-my-branch');
  assert.strictEqual(subpathFor('stage', '', '../x'), 'stage/x');
  assert.throws(() => subpathFor('stage', '', ''), /--task/);
});

test('static build ships the same page styles as the app in src/server.js', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-pages-src-'));
  fs.copyFileSync(path.join(__dirname, '../../src/invoice-dashboard.js'), path.join(src, 'invoice-dashboard.js'));
  fs.writeFileSync(path.join(src, 'server.js'), 'const page = `<style>\n  body { background:#000; color:#fff; }\n</style>`;\n');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-pages-'));
  build({ env: 'stage', version: 'local', task: '29', out, src });
  const css = fs.readFileSync(path.join(out, 'stage', '29', 'styles.css'), 'utf8');
  assert.match(css, /^body \{ background:#000; color:#fff; \}/);
  assert.match(css, /\.env-bar \{/);
  assert.match(css, /\.rule, \.muted \{/);
});

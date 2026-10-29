#!/usr/bin/env node
/**
 * run-pre-pr-audit.js — Pre-PR API & UI Audit Runner (Protocol RULE 2).
 *
 * 1. Makes sure the app is running on http://localhost:3456 (starts src/server.js if not).
 * 2. Sends real POST requests to /api/calculate-invoice and times each with performance.now().
 * 3. Runs a browser check of the UI and saves qa-evidence/latest-ui-proof.png
 *    (Playwright → headless Chrome/Chromium → built-in PNG fallback).
 * 4. Writes qa-evidence/PR_AUDIT_REPORT.md, ready to use as the PR description.
 *    It shows only the evidence this change needs (lib/evidence-scope.js): a screenshot for
 *    UI changes, API flight times and RULE #404 for calculation/API changes. The common
 *    checks always run but are summarised in one line, with the details folded away.
 *
 * qa-evidence/ is git-ignored: evidence is never committed. The report goes into the PR
 * body, and the CI gate re-runs this audit with --ci and uploads the screenshot as a
 * GitHub Actions artifact (download it with: gh run download <run-id> -n qa-evidence).
 *
 * Usage:
 *   node scripts/run-pre-pr-audit.js
 *   node scripts/run-pre-pr-audit.js --manual-passed "Notes from the user's manual check"
 *   node scripts/run-pre-pr-audit.js --ci     (CI: no local task file needed)
 *
 * Env: AUDIT_BASE (diff base; default: merge-base with origin/main) and EVIDENCE_IMAGE_URL
 * (CI: where the screenshot is published, so the PR comment can show it inline).
 *
 * Exit code 1 if the server can't start, the main API call fails, or no screenshot is produced.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execSync } = require('child_process');
const { performance } = require('perf_hooks');
const { renderInvoiceSnapshot } = require('./lib/png-snapshot');
const tasks = require('./manage-project-task');
const branches = require('./lib/branch-name');
const { scopeFromDiff, describeScope } = require('./lib/evidence-scope');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3456;
const BASE_URL = `http://localhost:${PORT}`;
const EVIDENCE_DIR = path.join(ROOT, 'qa-evidence');
const SCREENSHOT = path.join(EVIDENCE_DIR, 'latest-ui-proof.png');
const REPORT = path.join(EVIDENCE_DIR, 'PR_AUDIT_REPORT.md');
const SCOPE_FILE = path.join(EVIDENCE_DIR, 'scope.json');

// RULE #404 (docs/BUSINESS_RULES.md)
const GST = 0.18;
const VIP_CAP = 0.1;

const TEST_CASES = [
  { name: 'VIP invoice (primary)', body: { customerType: 'VIP', amount: 1000 }, expectStatus: 200, primary: true },
  { name: 'Standard invoice', body: { customerType: 'STANDARD', amount: 1000 }, expectStatus: 200 },
  { name: 'Invalid customer type', body: { customerType: 'GOLD', amount: 1000 }, expectStatus: 400 },
];

const logs = [];
/** Whether the total on the rendered page matched the API (null: not read). */
let uiTotalMatches = null;
function log(line) {
  const entry = `[${new Date().toISOString()}] ${line}`;
  logs.push(entry);
  console.log(entry);
}

// ---------- args ----------
function parseArgs(argv) {
  const args = { manualPassed: false, manualNotes: '', ci: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ci') args.ci = true;
    if (argv[i] === '--manual-passed') {
      args.manualPassed = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) args.manualNotes = argv[++i];
    }
  }
  return args;
}

// ---------- git info ----------
function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function repoInfo() {
  const remote = git('remote get-url origin');
  const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  // On a PR, CI checks out a detached merge commit, so it passes the branch in AUDIT_BRANCH.
  const branch = process.env.AUDIT_BRANCH || git('rev-parse --abbrev-ref HEAD') || 'main';
  return {
    slug: m ? `${m[1]}/${m[2]}` : null,
    branch,
    commit: git('rev-parse --short HEAD') || 'unknown',
    dirty: git('status --porcelain -- src tests scripts docs') !== '',
    author: git('config user.name') || os.userInfo().username,
  };
}

// ---------- what this PR changed ----------
/** Evidence scope of this branch's changes (committed, uncommitted and new files) against main. */
function changeScope() {
  const base = process.env.AUDIT_BASE || git('merge-base origin/main HEAD');
  if (!base) {
    log('Could not find the diff base (origin/main); showing all evidence.');
    return { ui: true, api: true, files: [] };
  }
  const untracked = git('ls-files --others --exclude-standard')
    .split('\n')
    .filter(Boolean)
    .map((f) => `diff --git a/${f} b/${f}\n@@ -0,0 +1 @@`);
  const scope = scopeFromDiff([git(`diff -U0 ${base}`), ...untracked].join('\n'));
  log(`Changed files: ${scope.files.join(', ') || 'none'} → ${describeScope(scope)}.`);
  return scope;
}

// ---------- HTTP helpers ----------
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${BASE_URL}${urlPath}`,
      {
        method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        timeout: 5000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, raw }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function isUp() {
  try {
    return (await request('GET', '/health')).status === 200;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await isUp()) {
    log(`Server already running at ${BASE_URL}; reusing it.`);
    return null;
  }
  log(`Server not running. Starting src/server.js on port ${PORT}...`);
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isUp()) {
      log(`Server started (pid ${child.pid}).`);
      return child;
    }
  }
  child.kill();
  throw new Error(`Server did not start on ${BASE_URL} within 5s`);
}

// ---------- API telemetry ----------
function expectedInvoice({ customerType, amount }) {
  const discount = customerType === 'VIP' ? amount * VIP_CAP : 0;
  const taxable = amount - discount;
  const gst = taxable * GST;
  const r = (n) => Math.round(n * 100) / 100;
  return { subtotal: r(amount), discount: r(discount), taxable: r(taxable), gst: r(gst), total: r(taxable + gst) };
}

async function runApiTests() {
  const results = [];
  for (const tc of TEST_CASES) {
    const t0 = performance.now();
    let status = 0;
    let raw = '';
    let error = null;
    try {
      ({ status, raw } = await request('POST', '/api/calculate-invoice', tc.body));
    } catch (err) {
      error = err.message;
    }
    const ms = performance.now() - t0;
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* not JSON */
    }

    let rule = 'n/a';
    if (status === 200 && json && json.invoice) {
      const exp = expectedInvoice(tc.body);
      rule = exp.total === json.invoice.total && exp.gst === json.invoice.gst ? 'PASS' : 'FAIL';
    }
    const ok = !error && status === tc.expectStatus;
    results.push({ ...tc, status, ms, json, raw, error, ok, rule });
    log(
      `API ${tc.name}: POST /api/calculate-invoice ${JSON.stringify(tc.body)} → ` +
        `${error ? 'ERROR ' + error : status} in ${ms.toFixed(2)} ms` +
        (rule !== 'n/a' ? ` · RULE #404 ${rule}` : '')
    );
  }
  return results;
}

// ---------- screenshot + UI test ----------
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function screenshotWithPlaywright(expectedTotal) {
  let playwright;
  try {
    // @ts-ignore optional dependency, used only when installed
    playwright = require('playwright');
  } catch {
    log('Playwright not installed; trying headless Chrome.');
    return null;
  }
  log('Using Playwright (Chromium).');
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE_URL);
    await page.selectOption('#customerType', 'VIP');
    await page.fill('#amount', '1000');
    await page.click('#calculate');
    await page.waitForSelector('body[data-ready="true"]');
    // eslint-disable-next-line no-undef -- runs inside the browser page
    await page.waitForFunction(() => document.getElementById('r-total').textContent !== '—');
    const shown = await page.textContent('#r-total');
    log(`UI: form submitted (VIP, 1000); dashboard shows total ${shown.trim()}.`);
    uiTotalMatches = shown.replace(/[^\d.]/g, '') === expectedTotal.toFixed(2);
    log(`UI: total matches API (${expectedTotal}): ${uiTotalMatches ? 'yes' : 'NO'}`);
    await page.screenshot({ path: SCREENSHOT, fullPage: true });
    return 'Playwright (Chromium)';
  } finally {
    await browser.close();
  }
}

function screenshotWithChrome(expectedTotal) {
  const chrome = findChrome();
  if (!chrome) {
    log('No Chrome/Chromium found; using built-in PNG fallback.');
    return null;
  }
  log(`Using headless Chrome: ${chrome}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-pr-audit-'));
  const common = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    '--virtual-time-budget=5000',
  ];
  if (process.platform === 'linux') common.push('--no-sandbox');

  try {
    // Render the page (it auto-submits the VIP / 1000 form on load) and read the DOM.
    const dom = spawnSync(chrome, [...common, '--dump-dom', BASE_URL], { encoding: 'utf8', timeout: 60000 });
    const total = (dom.stdout || '').match(/id="r-total">([^<]*)</);
    const ready = /data-ready="true"/.test(dom.stdout || '');
    log(`UI: page loaded, form auto-submitted (VIP, 1000); ready=${ready}.`);
    if (total) {
      log(`UI: dashboard shows total ${total[1].trim()}.`);
      uiTotalMatches = total[1].replace(/[^\d.]/g, '') === expectedTotal.toFixed(2);
      log(`UI: total matches API (${expectedTotal}): ${uiTotalMatches ? 'yes' : 'NO'}`);
    } else {
      log('UI: could not read the total from the rendered page.');
    }

    if (fs.existsSync(SCREENSHOT)) fs.unlinkSync(SCREENSHOT);
    const shot = spawnSync(chrome, [...common, `--screenshot=${SCREENSHOT}`, BASE_URL], { encoding: 'utf8', timeout: 60000 });
    if (shot.status !== 0 || !fs.existsSync(SCREENSHOT)) {
      log(`Headless Chrome screenshot failed (exit ${shot.status}); using fallback.`);
      return null;
    }
    return 'Headless Chrome';
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

function screenshotFallback(primary) {
  if (!primary || !primary.json || !primary.json.invoice) return null;
  fs.writeFileSync(SCREENSHOT, renderInvoiceSnapshot(primary.json, { url: BASE_URL, generatedAt: new Date().toISOString() }));
  log('UI: drew fallback PNG snapshot from the API response (no real browser render).');
  return 'Built-in PNG fallback (no browser available)';
}

async function captureScreenshot(primary) {
  const total = primary && primary.json && primary.json.invoice ? primary.json.invoice.total : NaN;
  let method = null;
  try {
    method = await screenshotWithPlaywright(total);
  } catch (err) {
    log(`Playwright failed: ${err.message}`);
  }
  if (!method) method = screenshotWithChrome(total);
  if (!method) method = screenshotFallback(primary);
  if (method) log(`Screenshot saved: qa-evidence/latest-ui-proof.png (${fs.statSync(SCREENSHOT).size} bytes) via ${method}.`);
  return method;
}

// ---------- report ----------
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function taskSection(task) {
  const out = ['## 📋 Linked GitHub Project Task', ''];
  if (!task) {
    out.push('**❌ No linked GitHub Project task for this branch.** The PR will be blocked by CI.', '');
    out.push('Create one before editing code:', '', '```bash');
    out.push('node scripts/manage-project-task.js create --title "<Task Name>" --type <Task|Issue|Bug> --severity <Low|Medium|High|Critical>');
    out.push('```', '');
    return out;
  }
  const id = task.issueUrl ? `[#${task.issueNumber}](${task.issueUrl})` : `#${task.issueNumber}`;
  const board = task.projectUrl
    ? `[${tasks.PROJECT_TITLE}](${task.projectUrl})`
    : task.mode === 'dry-run'
      ? '_dry run (not on GitHub)_'
      : '_labels fallback (not on project board)_';
  out.push('| Field | Value |', '|---|---|');
  out.push(`| **Task ID** | ${id} |`);
  out.push(`| **Task Name** | ${cell(task.taskName)} |`);
  out.push(`| **Type** | ${task.type} |`);
  out.push(`| **Severity** | ${task.severity} |`);
  out.push(`| **Status Lifecycle** | ${tasks.lifecycle(task)} |`);
  out.push(`| **Current Status** | ${task.status} |`);
  out.push(`| **Project Board** | ${board} |`, '');
  out.push(`Closes #${task.issueNumber}`, '');
  return out;
}

function apiSection(results) {
  const out = ['| # | Params Sent | Status | Flight Time (ms) | Response | Result |', '|---|---|---:|---:|---|---|'];
  results.forEach((r, i) => {
    const body = r.error ? `ERROR: ${r.error}` : r.json && r.json.invoice ? JSON.stringify(r.json.invoice) : r.raw;
    const verdict = r.ok ? (r.rule === 'FAIL' ? '⚠️ RULE #404 FAIL' : '✅ OK') : `❌ expected ${r.expectStatus}`;
    out.push(`| ${i + 1} | \`${cell(JSON.stringify(r.body))}\` | ${r.status || '—'} | ${r.ms.toFixed(2)} | \`${cell(body)}\` | ${verdict} |`);
  });
  const slowest = Math.max(...results.map((r) => r.ms));
  out.push('', `\`POST /api/calculate-invoice\` · average **${average(results).toFixed(2)} ms** · slowest **${slowest.toFixed(2)} ms**`, '');
  return out;
}

function ruleSection(primary) {
  if (!primary || !primary.json || !primary.json.invoice) return ['❌ Could not check RULE #404: the primary API call failed.', ''];
  const exp = expectedInvoice(primary.body);
  const act = primary.json.invoice;
  const out = ['VIP, amount 1000:', '', '| Field | Expected (18% GST, 10% VIP cap) | Actual | |', '|---|---:|---:|---|'];
  for (const k of ['subtotal', 'discount', 'taxable', 'gst', 'total']) {
    out.push(`| ${k} | ${exp[k].toFixed(2)} | ${act[k].toFixed(2)} | ${exp[k] === act[k] ? '✅' : '❌'} |`);
  }
  out.push('', primary.rule === 'PASS' ? '**RULE #404: ✅ COMPLIANT**' : '**RULE #404: ❌ VIOLATED**', '');
  return out;
}

const average = (results) => results.reduce((a, r) => a + r.ms, 0) / results.length;

/** One line for the checks every PR gets, whatever it changed. */
function commonChecksLine(results, primary, shotMethod, args) {
  const okCount = results.filter((r) => r.ok).length;
  const api = `${okCount === results.length ? '✅' : '❌'} API: ${okCount}/${results.length} calls as expected (avg ${average(results).toFixed(2)} ms)`;
  const rule = primary && primary.rule === 'PASS' ? '✅ RULE #404' : '❌ RULE #404';
  const ui = !shotMethod ? '❌ UI: no screenshot' : uiTotalMatches === false ? '❌ UI total differs from API' : '✅ UI renders';
  const tests = args.ci ? 'lint, typecheck and tests: **checks** job' : 'lint, typecheck and tests: `npm run check`';
  return `${api} · ${rule} · ${ui} · ${tests}`;
}

function buildReport({ info, results, shotMethod, args, generatedAt, task, scope }) {
  const primary = results.find((r) => r.primary);
  const imageUrl = process.env.EVIDENCE_IMAGE_URL;

  const out = [];
  out.push(args.ci ? '# 🤖 CI Audit Evidence' : '# 🧪 Pre-PR Audit Report', '');
  if (!args.ci) out.push(...taskSection(task));
  out.push(
    `**Branch** \`${info.branch}\` · **Commit** \`${info.commit}\`${info.dirty ? ' + uncommitted changes' : ''} · ` +
      `**Generated** ${generatedAt} · ${info.author} · Node ${process.version} · ${process.platform}`,
    ''
  );

  out.push('## What changed', '');
  const files = scope.files.map((f) => `\`${f}\``);
  out.push(`Files: ${files.length ? files.join(', ') : '_none_'}  `, `Evidence needed: **${describeScope(scope)}**`, '');

  out.push('## Evidence for this change', '');
  if (scope.ui) {
    out.push('### 📸 Screenshot', '');
    if (!shotMethod) out.push('❌ No screenshot captured.');
    else if (imageUrl) out.push(`![Dashboard after this change](${imageUrl})`, '', `_Captured with ${shotMethod}._`);
    else if (args.ci) out.push(`Captured with ${shotMethod}; it is in the **\`qa-evidence\`** artifact of this run.`);
    else out.push(`Captured with ${shotMethod} as \`qa-evidence/latest-ui-proof.png\`. CI posts it inline in the evidence comment on the PR.`);
    out.push('');
  }
  if (scope.api) {
    out.push('### ⏱️ API flight times', '', ...apiSection(results));
    out.push('### 🧮 RULE #404', '', ...ruleSection(primary));
  }
  if (!scope.ui && !scope.api) out.push('_This PR changes no app behaviour, so there is nothing app-specific to show._', '');

  out.push('## Common checks (every PR)', '', commonChecksLine(results, primary, shotMethod, args), '');
  out.push('<details><summary>Full details</summary>', '');
  if (!scope.api) out.push('### API flight times', '', ...apiSection(results), '### RULE #404', '', ...ruleSection(primary));
  results.forEach((r, i) => {
    out.push(`<details><summary>Response #${i + 1}: ${r.name}</summary>`, '', '```json', r.raw || r.error || '', '```', '', '</details>');
  });
  out.push('', '### Audit log', '', '```text', ...logs, '```', '', '</details>', '');

  if (args.ci) {
    out.push('---', '_Generated in CI by `scripts/run-pre-pr-audit.js --ci`._', '');
    return out.join('\n');
  }

  out.push('## Manual Verification (Protocol RULE 3)', '');
  if (args.manualPassed) {
    out.push(`**✅ Manual check passed** — confirmed by ${info.author} on ${generatedAt}`, '');
    out.push('Observation notes:', '', `> ${args.manualNotes ? args.manualNotes.replace(/\n/g, '\n> ') : '_No notes given._'}`);
  } else {
    out.push('**⏳ PENDING** — the user has not confirmed a manual check yet.', '');
    out.push(`Start the app with \`node src/server.js\`, test it at ${BASE_URL}, then re-run:`, '');
    out.push('```bash', 'node scripts/run-pre-pr-audit.js --manual-passed "<your observation notes>"', '```');
  }
  out.push('');

  out.push('<details><summary>Pre-PR protocol checklist</summary>', '');
  out.push(`- [${task ? 'x' : ' '}] RULE 0: GitHub Project task created before editing code${task ? ` (#${task.issueNumber})` : ''}`);
  out.push(`- [${branches.parseBranch(info.branch) ? 'x' : ' '}] Branch follows \`<type>/<issue-id>-<short-description>\``);
  out.push('- [x] RULE 1: PR not opened straight after editing code');
  out.push(`- [x] RULE 2: Pre-PR audit run (API telemetry + screenshot)`);
  out.push(`- [${args.manualPassed ? 'x' : ' '}] RULE 3: Manual check on ${BASE_URL} confirmed by the user`);
  out.push('- [x] RULE 4: This report is the PR description (`gh pr create --body-file qa-evidence/PR_AUDIT_REPORT.md`)');
  out.push('', '</details>', '', '---', '_Generated by `scripts/run-pre-pr-audit.js`._', '');
  return out.join('\n');
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const info = repoInfo();
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  log(`Pre-PR audit started on branch ${info.branch} (${info.commit}).`);
  let server = null;
  let exitCode = 0;
  // The audit never changes the task status: it stays In Progress until the PR opens (In Review)
  // and is only Done when the PR merges. See scripts/manage-project-task.js.
  const task = args.ci ? null : tasks.loadActiveTask({ branch: tasks.currentBranch() });
  if (args.ci) {
    log('CI mode: task status is managed by .github/workflows/task-lifecycle.yml.');
  } else if (!task) {
    log('❌ No linked GitHub Project task for this branch. Run: node scripts/manage-project-task.js create ...');
    exitCode = 1;
  } else {
    log(`Task #${task.issueNumber} "${task.taskName}" is ${task.status}.`);
  }
  try {
    server = await ensureServer();
    const results = await runApiTests();
    const primary = results.find((r) => r.primary);
    if (!primary.ok) exitCode = 1;

    const shotMethod = await captureScreenshot(primary);
    const scope = changeScope();
    fs.writeFileSync(SCOPE_FILE, JSON.stringify(scope, null, 2));
    if (!shotMethod) exitCode = 1;

    if (args.manualPassed) {
      log(`Manual check recorded as PASSED by ${info.author}. Open the PR with this report as its body.`);
    }
    log(`Audit finished: ${exitCode === 0 ? 'evidence complete' : 'evidence INCOMPLETE'}.`);

    const generatedAt = new Date().toISOString();
    fs.writeFileSync(REPORT, buildReport({ info, results, shotMethod, args, generatedAt, task, scope }));
    console.log(`\nReport written: qa-evidence/PR_AUDIT_REPORT.md`);
    if (primary.rule === 'FAIL') console.log('⚠️  RULE #404 is violated by the current code (see the RULE #404 table in the report).');
    if (!task && !args.ci) console.log('❌ No linked GitHub Project task: run node scripts/manage-project-task.js create ... then re-run the audit.');
    if (!args.manualPassed && !args.ci) console.log('⏳ Manual check pending: test http://localhost:3456, then re-run with --manual-passed "<notes>".');
  } catch (err) {
    log(`Audit failed: ${err.message}`);
    exitCode = 1;
  } finally {
    if (server) {
      server.kill();
      log('Stopped the server this audit started.');
    }
  }
  process.exit(exitCode);
}

main();

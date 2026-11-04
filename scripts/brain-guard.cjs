#!/usr/bin/env node
/**
 * brain-guard.cjs — Code-In, Verdict-Out validator for the Brain Vault (Phase 5).
 *
 * The business rules and architecture docs are AES-256-GCM encrypted in docs/brain.vault.enc.
 * This script decrypts them in RAM only, checks the code against them and prints pass/fail
 * verdicts. It never writes or prints the plain text, and zeroes the decrypted buffers.
 *
 * Vault layout (envelope encryption: one data key, wrapped twice):
 *   "BVLT1" | local slot | master slot | data
 *   slot = salt(16) | iv(12) | tag(16) | wrapped data key(32)
 *   data = iv(12) | tag(16) | ciphertext   (AAD: "BVLT1")
 *   local KEK  = pbkdf2(internal salt + SHA-256 of scripts/run-pre-pr-audit.js, slot salt)
 *   master KEK = pbkdf2(BRAIN_MASTER_KEY, slot salt)   (GitHub Actions and re-sealing)
 *
 * Editing scripts/run-pre-pr-audit.js changes its checksum, so the local key no longer
 * derives: TAMPER DETECTED. The Lead Architect re-seals after a legitimate change.
 *
 * Usage:
 *   node scripts/run-pre-pr-audit.js                  (normal: the audit calls --verify)
 *   node scripts/brain-guard.cjs --verify             (authorized verification, verdicts only)
 *   node scripts/brain-guard.cjs --probe              (invoice math as JSON, no vault access)
 *   BRAIN_MASTER_KEY=... node scripts/brain-guard.cjs --seal [--source <dir>]   (Lead Architect)
 *   BRAIN_MASTER_KEY=... node scripts/brain-guard.cjs --reseal                  (Lead Architect)
 *   CI: --verify --root <pr checkout> --probe-file <json>   (key from BRAIN_MASTER_KEY)
 *
 * Exit codes: 0 verified, 1 rule violation or error, 2 access denied, 3 tamper detected.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VAULT = path.join(ROOT, 'docs', 'brain.vault.enc');
const RUNNER = path.join(ROOT, 'scripts', 'run-pre-pr-audit.js');
const TASK_FILE = path.join(ROOT, 'qa-evidence', 'active-task.json');
const SOURCES = ['BUSINESS_RULES.md', 'ARCHITECTURE.md'];
const STUB_MARK = 'PROPRIETARY BRAIN VAULT ACTIVE';
const IN_CI = process.env.GITHUB_ACTIONS === 'true';

// SHA-256 of scripts/run-pre-pr-audit.js when the vault was sealed (rewritten by --seal/--reseal).
const AUDIT_RUNNER_SHA256 = '66681676d3f344465ec9385d8fc1ae6c288a563bb93848d8eb75e6882901135e';

const MAGIC = Buffer.from('BVLT1');
const SLOT = 16 + 12 + 16 + 32;
const ITERATIONS = 210000;
// Statuses that count as an active task ("Open" / "Testing" on the board).
const ACTIVE_STATUSES = ['Todo', 'In Progress', 'In Review'];
const ALLOWED_FLAGS = ['--verify', '--probe', '--seal', '--reseal', '--root', '--probe-file', '--source'];

// Internal salt, XOR-masked so it is not a plain string in the source.
const SALT_MASK = 0x5a;
const SALT_BYTES = [0x1f, 0x8c, 0x33, 0xd0, 0x6e, 0xa1, 0x47, 0x92, 0x0b, 0xf5, 0x5d, 0x28, 0xc7, 0x74, 0x39, 0xe6, 0x12, 0xab, 0x60, 0x9d, 0x2e, 0xf1, 0x84, 0x57];

// Invoices the probe runs through calculateInvoice() (inputs only: no rule values here).
const PROBE_CASES = [
  { isVip: true, subtotal: 1000 },
  { isVip: false, subtotal: 1000 },
  { isVip: true, subtotal: 2499.99 },
  { isVip: false, subtotal: 0.5 },
];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const internalSalt = () => Buffer.from(SALT_BYTES.map((b) => b ^ SALT_MASK));

function deny(reason) {
  console.error(`🔒 ACCESS DENIED: ${reason}`);
  process.exit(2);
}

function tamper(detail) {
  console.error(`🚨 TAMPER DETECTED: Audit runner checksum mismatch! (${detail})`);
  process.exit(3);
}

// ---------- args ----------
function parseArgs(argv) {
  const args = { mode: null, root: null, probeFile: null, source: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!ALLOWED_FLAGS.includes(a)) deny(`"${a}" is not a permitted operation. The vault is never dumped, printed or exported.`);
    if (a === '--root') args.root = argv[++i];
    else if (a === '--probe-file') args.probeFile = argv[++i];
    else if (a === '--source') args.source = argv[++i];
    else if (args.mode) deny('only one operation per run.');
    else args.mode = a.slice(2);
  }
  if (!args.mode) deny('no operation given. Run node scripts/run-pre-pr-audit.js (or --verify).');
  return args;
}

// ---------- crypto ----------
function gcmEncrypt(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function gcmDecrypt(key, blob, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  if (aad) d.setAAD(aad);
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

const kdf = (secret, salt) => crypto.pbkdf2Sync(secret, salt, ITERATIONS, 32, 'sha256');
const localSecret = (runnerHash) => Buffer.concat([internalSalt(), Buffer.from(runnerHash, 'hex')]);

function masterSecret() {
  if (!process.env.BRAIN_MASTER_KEY) throw new Error('BRAIN_MASTER_KEY is not set');
  return Buffer.from(process.env.BRAIN_MASTER_KEY, 'utf8');
}

function wrap(secret, dek) {
  const salt = crypto.randomBytes(16);
  const kek = kdf(secret, salt);
  try {
    return Buffer.concat([salt, gcmEncrypt(kek, dek)]);
  } finally {
    kek.fill(0);
  }
}

function unwrap(secret, slot) {
  const kek = kdf(secret, slot.subarray(0, 16));
  try {
    return gcmDecrypt(kek, slot.subarray(16));
  } finally {
    kek.fill(0);
  }
}

function readVault() {
  const raw = fs.readFileSync(VAULT);
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('docs/brain.vault.enc is not a Brain Vault file');
  const o = MAGIC.length;
  return { local: raw.subarray(o, o + SLOT), master: raw.subarray(o + SLOT, o + 2 * SLOT), data: raw.subarray(o + 2 * SLOT) };
}

/** Decrypts the vault into a buffer the caller must zero. */
function openVault(runnerHash) {
  const v = readVault();
  let dek;
  if (IN_CI) {
    try {
      dek = unwrap(masterSecret(), v.master);
    } catch (err) {
      throw new Error(`the vault does not open with BRAIN_MASTER_KEY (${err.message})`);
    }
  } else {
    try {
      dek = unwrap(localSecret(runnerHash), v.local);
    } catch {
      tamper('local key derivation failed');
    }
  }
  try {
    return gcmDecrypt(dek, v.data, MAGIC);
  } finally {
    dek.fill(0);
  }
}

// ---------- sealing (Lead Architect) ----------
function lockRunnerHash(hash) {
  const self = fs.readFileSync(__filename, 'utf8');
  fs.writeFileSync(__filename, self.replace(/const AUDIT_RUNNER_SHA256 = '[^']*';/, `const AUDIT_RUNNER_SHA256 = '${hash}';`));
}

/** Writes the vault (ciphertext only) and locks the current audit runner checksum. */
function writeVault(dek, data) {
  const runnerHash = sha256(fs.readFileSync(RUNNER));
  fs.writeFileSync(VAULT, Buffer.concat([MAGIC, wrap(localSecret(runnerHash), dek), wrap(masterSecret(), dek), data]));
  lockRunnerHash(runnerHash);
  return runnerHash;
}

function parseRules(md) {
  const num = (re, label) => {
    const m = md.match(re);
    if (!m) throw new Error(`could not find the ${label} in BUSINESS_RULES.md`);
    return Number(m[1]);
  };
  return { gstRate: num(/GST:\s*`([\d.]+)`/, 'GST rate'), vipDiscountMax: num(/VIP discount:[^`]*`([\d.]+)`/, 'VIP discount cap') };
}

function seal(sourceDir) {
  masterSecret();
  const docs = {};
  for (const name of SOURCES) {
    const text = fs.readFileSync(path.join(sourceDir, name), 'utf8');
    if (text.includes(STUB_MARK)) throw new Error(`${name} is already a vault stub: pass --source <dir> with the plain-text originals`);
    docs[name] = text;
  }
  const payload = {
    docs,
    rules: parseRules(docs['BUSINESS_RULES.md']),
    architecture: { coreMustNotRequire: ['invoice-dashboard', 'server'], coreInternals: ['USERS', 'CUSTOMERS', 'connection'] },
  };
  const plain = Buffer.from(JSON.stringify(payload));
  const dek = crypto.randomBytes(32);
  try {
    return writeVault(dek, gcmEncrypt(dek, plain, MAGIC));
  } finally {
    dek.fill(0);
    plain.fill(0);
  }
}

/** Re-wraps the data key for the current audit runner. The rules are never decrypted. */
function reseal() {
  const v = readVault();
  const dek = unwrap(masterSecret(), v.master);
  try {
    return writeVault(dek, Buffer.from(v.data));
  } finally {
    dek.fill(0);
  }
}

// ---------- the 4 factors ----------
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** Factor 1: who is calling. A run from the audit carries a token signed with its checksum. */
function callerCheck() {
  const token = process.env.BRAIN_GUARD_TOKEN;
  if (!token) return 'direct --verify (authorized verification flag)';
  const [nonce, pid, mac] = token.split('.');
  const key = Buffer.from(sha256(fs.readFileSync(RUNNER)), 'hex');
  const expected = crypto.createHmac('sha256', key).update(`${nonce}.${pid}`).digest('hex');
  const signed = mac && mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  if (Number(pid) !== process.ppid || !signed) deny('the caller token is not signed by scripts/run-pre-pr-audit.js.');
  return 'scripts/run-pre-pr-audit.js (signed token)';
}

/** Factor 2: an active GitHub task for this branch. */
function taskCheck() {
  if (!fs.existsSync(TASK_FILE)) deny('no active GitHub task (qa-evidence/active-task.json). Run node scripts/manage-project-task.js create ...');
  const task = JSON.parse(fs.readFileSync(TASK_FILE, 'utf8'));
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!task.issueNumber || !ACTIVE_STATUSES.includes(task.status)) deny(`task #${task.issueNumber || '?'} is "${task.status}", not active.`);
  if (task.branch && branch && task.branch !== branch) deny(`the active task belongs to ${task.branch}, not ${branch}.`);
  return `#${task.issueNumber} (${task.status})`;
}

/** Runs calculateInvoice() on the probe invoices. Needs no vault access. */
function probe() {
  const { calculateInvoice } = require(path.join(ROOT, 'src', 'invoice-dashboard.js'));
  return PROBE_CASES.map((c) => ({
    ...c,
    invoice: calculateInvoice([{ description: 'probe', quantity: 1, unitPrice: c.subtotal }], { isVip: c.isVip }),
  }));
}

/** The probe runs in a child process that never sees the master key or the plain text. */
function runProbe() {
  const env = { ...process.env };
  delete env.BRAIN_MASTER_KEY;
  delete env.BRAIN_GUARD_TOKEN;
  const r = spawnSync(process.execPath, [__filename, '--probe'], { cwd: ROOT, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`the probe failed: ${(r.stderr || '').trim()}`);
  return JSON.parse(r.stdout);
}

/** Factor 3a: invoice math against the business rules. */
function checkRules(rules, results) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const wrong = results.filter(({ isVip, subtotal, invoice }) => {
    const discount = isVip ? subtotal * rules.vipDiscountMax : 0;
    const gst = (subtotal - discount) * rules.gstRate;
    return invoice.discount !== r2(discount) || invoice.gst !== r2(gst) || invoice.total !== r2(subtotal - discount + gst);
  });
  const pct = (n) => `${Math.round(n * 100)}%`;
  return wrong.length
    ? { ok: false, line: `❌ RULE #404 Violation on VIP/GST calculation (${wrong.length} of ${results.length} probe invoices)` }
    : { ok: true, line: `✅ RULE #404 Verified: VIP discount ${pct(rules.vipDiscountMax)}, GST ${pct(rules.gstRate)}` };
}

/** Factor 3b: layer boundaries in src/core-engine.js and src/invoice-dashboard.js. */
function checkArchitecture(arch, root) {
  const core = fs.readFileSync(path.join(root, 'src', 'core-engine.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'src', 'invoice-dashboard.js'), 'utf8');
  const upward = new RegExp(`require\\(\\s*['"][^'"]*(${arch.coreMustNotRequire.join('|')})['"]`).test(core);
  const internals = new RegExp(`\\bcore\\.(${arch.coreInternals.join('|')})\\b`).test(ui);
  if (upward) return { ok: false, line: '❌ Architecture Violation: the core layer depends on the UI layer or the server' };
  if (internals) return { ok: false, line: '❌ Architecture Violation: the UI layer reaches into core internals' };
  return { ok: true, line: '✅ Architecture Verified: core and UI layer boundaries hold' };
}

function currentUser() {
  if (IN_CI) return process.env.PR_AUTHOR || process.env.GITHUB_ACTOR || 'github-actions';
  const r = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 8000 });
  return (r.status === 0 && r.stdout.trim()) || git(['config', 'user.name']) || 'unknown';
}

/** Factor 4: the audit trail line, signed with a key derived from the vault contents. */
function signedLine(user, payload) {
  const line = `🔐 Brain Vault Verified | Checksum: OK | User: ${user} | Timestamp: ${new Date().toISOString()}`;
  const key = crypto.createHash('sha256').update(payload).digest();
  try {
    return `${line} | Sig: ${crypto.createHmac('sha256', key).update(line).digest('hex').slice(0, 16)}`;
  } finally {
    key.fill(0);
  }
}

function verify(args) {
  const root = args.root ? path.resolve(args.root) : ROOT;
  console.log(`Caller: ${IN_CI ? 'GitHub Actions (BRAIN_MASTER_KEY)' : callerCheck()}`);
  if (!IN_CI) console.log(`Task: ${taskCheck()}`);

  const runnerHash = sha256(fs.readFileSync(path.join(root, 'scripts', 'run-pre-pr-audit.js')));
  if (runnerHash !== AUDIT_RUNNER_SHA256) {
    if (!(IN_CI && process.env.ALLOW_RUNNER_CHANGE === 'true')) tamper(`sha256 ${runnerHash.slice(0, 12)}…`);
    console.log('⚠️  Audit runner changed by the Lead Architect: re-seal with --reseal before merging.');
  } else {
    console.log(`Checksum: run-pre-pr-audit.js sha256 ${runnerHash.slice(0, 12)}… OK`);
  }

  let payload = null;
  try {
    payload = openVault(runnerHash);
    const { rules, architecture } = JSON.parse(payload.toString('utf8'));
    const results = args.probeFile ? JSON.parse(fs.readFileSync(args.probeFile, 'utf8')) : runProbe();
    const verdicts = [checkRules(rules, results), checkArchitecture(architecture, root)];
    for (const v of verdicts) console.log(v.line);
    if (verdicts.some((v) => !v.ok)) {
      console.log('❌ Brain Vault verification FAILED');
      return 1;
    }
    console.log(signedLine(currentUser(), payload));
    return 0;
  } finally {
    if (payload) payload.fill(0);
  }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.mode === 'probe') {
      process.stdout.write(JSON.stringify(probe()));
    } else if (args.mode === 'seal') {
      const hash = seal(args.source ? path.resolve(args.source) : path.join(ROOT, 'docs'));
      console.log(`✅ Sealed docs/brain.vault.enc; audit runner checksum locked (${hash.slice(0, 12)}…).`);
    } else if (args.mode === 'reseal') {
      const hash = reseal();
      console.log(`✅ Re-sealed docs/brain.vault.enc for the current audit runner (${hash.slice(0, 12)}…).`);
    } else {
      process.exitCode = verify(args);
    }
  } catch (err) {
    console.error(`❌ brain-guard: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { parseRules, checkRules, checkArchitecture, PROBE_CASES };

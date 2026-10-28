#!/usr/bin/env node
/**
 * install-hooks.js — turns on the repo's Git hooks in .githooks/.
 *
 * Sets `git config core.hooksPath .githooks` and makes the hooks executable.
 * Git config is shared by every worktree of a clone, so run this once per clone.
 *
 * Usage: node scripts/install-hooks.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOKS_DIR = path.join(ROOT, '.githooks');

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

if (!fs.existsSync(HOOKS_DIR)) {
  console.error('No .githooks/ folder found. Nothing to install.');
  process.exit(1);
}

const hooks = fs.readdirSync(HOOKS_DIR).filter((f) => !f.startsWith('.'));
for (const hook of hooks) fs.chmodSync(path.join(HOOKS_DIR, hook), 0o755);

git('config', 'core.hooksPath', '.githooks');

console.log(`✅ Git hooks installed: core.hooksPath = ${git('config', '--get', 'core.hooksPath')}`);
for (const hook of hooks) console.log(`   • .githooks/${hook}`);
console.log("\nCommits that change src/ now need \"✅ Manual check passed\" in the staged qa-evidence/PR_AUDIT_REPORT.md.");
console.log("New worktrees now start from the latest origin/main (post-checkout hook).");

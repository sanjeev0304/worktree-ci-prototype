#!/usr/bin/env node
/**
 * branch-name.js — the branch naming convention: <type>/<issue-id>-<short-description>
 *
 *   fix/104-login-timeout · feat/12-export-csv · chore/8-harden-pr-workflow
 *
 * Used by manage-project-task.js (creates the branch), .githooks/pre-push (blocks bad
 * names locally) and the CI gate (blocks bad names on pull requests).
 *
 * CLI: node scripts/lib/branch-name.js check <branch>   (exit 1 if invalid)
 */
'use strict';

const BRANCH_TYPES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'ci', 'perf', 'hotfix'];
const MAX_LENGTH = 60;
const PATTERN = new RegExp(`^(${BRANCH_TYPES.join('|')})/([1-9][0-9]*)-([a-z0-9]+(?:-[a-z0-9]+)*)$`);

// Default branch type for each task Type.
const TYPE_FOR_TASK = { Task: 'feat', Issue: 'fix', Bug: 'fix' };

// Long-lived branches that are not feature branches.
const EXEMPT = ['main'];

/** Returns { type, issue, slug } for a valid branch name, otherwise null. */
function parseBranch(name) {
  const m = PATTERN.exec(String(name || ''));
  if (!m || name.length > MAX_LENGTH) return null;
  return { type: m[1], issue: Number(m[2]), slug: m[3] };
}

function slugify(text, maxLength) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = slug.slice(0, maxLength).replace(/-+$/, '');
  return cut || 'task';
}

/** Builds a valid branch name, e.g. buildBranch('fix', 104, 'Login timeout') -> fix/104-login-timeout */
function buildBranch(type, issue, title) {
  if (!BRANCH_TYPES.includes(type)) throw new Error(`branch type must be one of: ${BRANCH_TYPES.join(', ')} (got "${type}")`);
  const prefix = `${type}/${issue}-`;
  return prefix + slugify(title, MAX_LENGTH - prefix.length);
}

function explain(name) {
  return [
    `Branch "${name}" does not follow the naming convention.`,
    '',
    '  Required: <type>/<issue-id>-<short-description>   e.g. fix/104-login-timeout',
    `  <type>:   ${BRANCH_TYPES.join(' | ')}`,
    '  <issue-id>: the GitHub issue number of the task',
    `  <short-description>: lowercase words joined by "-" (whole name max ${MAX_LENGTH} chars)`,
    '',
    'Rename it with: git branch -m <new-name>',
  ].join('\n');
}

module.exports = { BRANCH_TYPES, TYPE_FOR_TASK, EXEMPT, MAX_LENGTH, parseBranch, buildBranch, explain };

if (require.main === module) {
  const [command, name] = process.argv.slice(2);
  if (command !== 'check' || !name) {
    console.error('Usage: node scripts/lib/branch-name.js check <branch>');
    process.exit(2);
  }
  if (EXEMPT.includes(name) || parseBranch(name)) process.exit(0);
  console.error(explain(name));
  process.exit(1);
}

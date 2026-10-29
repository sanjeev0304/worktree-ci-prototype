/**
 * evidence-scope.js — decides which evidence a PR needs from what it changed.
 *
 *   ui   the page in renderPage() changed          → screenshot in the PR comment
 *   api  invoice math, API handler or core changed → API flight times + RULE #404 table
 *
 * A PR that only touches tests, scripts, docs or CI needs neither: the common checks
 * still run, but they are shown as a one-line summary.
 *
 * Used by run-pre-pr-audit.js. Input is `git diff -U0` output, so each hunk header
 * ends with the enclosing top-level function, e.g. "function renderPage() {".
 */
'use strict';

const UI_FUNCTIONS = ['renderPage'];

/** @param {string} diff output of `git diff -U0` @returns {{ui: boolean, api: boolean, files: string[]}} */
function scopeFromDiff(diff) {
  const scope = { ui: false, api: false, files: /** @type {string[]} */ ([]) };
  let file = '';
  for (const line of String(diff || '').split('\n')) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1];
      scope.files.push(file);
      continue;
    }
    if (!line.startsWith('@@') || !file.startsWith('src/')) continue;
    const context = line.replace(/^@@[^@]*@@/, '');
    if (file === 'src/server.js' && UI_FUNCTIONS.some((fn) => context.includes(`function ${fn}(`))) scope.ui = true;
    else if (/\.(html|css)$/.test(file)) scope.ui = true;
    else scope.api = true;
  }
  return scope;
}

/** Plain-language list of the evidence a scope asks for. */
function describeScope(scope) {
  const parts = [];
  if (scope.ui) parts.push('UI change → screenshot');
  if (scope.api) parts.push('calculation/API change → API flight times + RULE #404');
  return parts.length ? parts.join(' · ') : 'no app behaviour changed → common checks only';
}

module.exports = { scopeFromDiff, describeScope, UI_FUNCTIONS };

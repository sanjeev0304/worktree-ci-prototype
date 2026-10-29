#!/usr/bin/env node
/**
 * manage-project-task.js — GitHub Project task lifecycle for a worktree.
 *
 * Every piece of work is tracked as a GitHub Issue on the
 * "Enterprise Worktree Task Tracker" project board, with these fields:
 *   Task Name (Title) · Severity (Low*, Medium, High, Critical)
 *   Type (Task, Issue, Bug; shown as "Task Type" on the board, since GitHub reserves "Type")
 *   Status (Todo, In Progress, In Review, Done, Blocked)
 * Repository labels (severity:*, type:*, status:*) mirror the same values, so the task
 * is still tracked if the Projects API is unavailable.
 *
 * Lifecycle: Todo -> In Progress -> In Review -> Done
 *   Todo         issue created                       (create)
 *   In Progress  branch <type>/<issue>-<slug> created (create, right after the issue)
 *   In Review    pull request opened                 (CI: .github/workflows/task-lifecycle.yml)
 *   Done         PR merged; GitHub closes the issue via "Closes #N" (CI, same workflow)
 *   Blocked      work on hold                        (status --set Blocked)
 *
 * Commands:
 *   setup                                   create/repair the project board, fields and labels
 *   create --title "<Task Name>" --type <Task|Issue|Bug> [--severity <Low|Medium|High|Critical>]
 *          [--branch-type <feat|fix|chore|docs|refactor|test|ci|perf|hotfix>] [--no-branch]
 *   status --set <In Progress|Blocked|In Review> [--note "<text>"]
 *   sync --issue <N> --set <status> [--note "<text>"]   used by CI (no active task file needed)
 *   show                                    print the active task
 *
 * The active task is saved in qa-evidence/active-task.json (git-ignored, tied to the branch).
 * Set TASK_DRY_RUN=1 to skip all GitHub calls and branch creation (local demos and tests).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const branches = require('./lib/branch-name');

const ROOT = path.resolve(__dirname, '..');
const TASK_FILE = path.join(ROOT, 'qa-evidence', 'active-task.json');
const PROJECT_TITLE = 'Enterprise Worktree Task Tracker';
const DRY_RUN = process.env.TASK_DRY_RUN === '1';

const FIELDS = {
  Severity: [
    { name: 'Low', color: 'GREEN', description: 'Default severity' },
    { name: 'Medium', color: 'YELLOW', description: 'Noticeable impact' },
    { name: 'High', color: 'ORANGE', description: 'Major impact' },
    { name: 'Critical', color: 'RED', description: 'Production at risk' },
  ],
  Type: [
    { name: 'Task', color: 'BLUE', description: 'Planned work' },
    { name: 'Issue', color: 'PURPLE', description: 'Reported problem or question' },
    { name: 'Bug', color: 'RED', description: 'Defect in existing behaviour' },
  ],
  Status: [
    { name: 'Todo', color: 'GRAY', description: 'Issue created, work not started' },
    { name: 'In Progress', color: 'YELLOW', description: 'Branch created, work under way' },
    { name: 'In Review', color: 'BLUE', description: 'Pull request open' },
    { name: 'Done', color: 'GREEN', description: 'PR merged, issue closed by GitHub' },
    { name: 'Blocked', color: 'RED', description: 'Work on hold' },
  ],
};
const DEFAULT_SEVERITY = 'Low';
// Set only by CI when the PR merges, so a task can never be closed before its code lands.
const CI_ONLY_STATUSES = ['Done'];

// Field names on the project board. GitHub reserves "Type" (its built-in issue types),
// so the Type field is called "Task Type" on the board. Labels still use type:*.
const PROJECT_FIELD = { Severity: 'Severity', Type: 'Task Type', Status: 'Status' };

const LABEL_COLORS = {
  'severity:Low': '0e8a16', 'severity:Medium': 'fbca04', 'severity:High': 'd93f0b', 'severity:Critical': 'b60205',
  'type:Task': '1d76db', 'type:Issue': '5319e7', 'type:Bug': 'd73a4a',
  'status:Todo': 'c5def5', 'status:In Progress': 'fbca04', 'status:In Review': '0052cc', 'status:Done': '0e8a16',
  'status:Blocked': 'b60205',
};

// ---------- small helpers ----------
function say(msg) {
  console.log(msg);
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function gitStrict(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function currentBranch() {
  return git('rev-parse', '--abbrev-ref', 'HEAD') || 'unknown';
}

function repoSlug() {
  const m = git('remote', 'get-url', 'origin').match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error('origin is not a GitHub repository');
  return { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}` };
}

function gh(args, input) {
  return execFileSync('gh', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  }).trim();
}

function graphql(query, variables = {}) {
  const out = JSON.parse(gh(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables })));
  if (out.errors) throw new Error(out.errors.map((e) => e.message).join('; '));
  return out.data;
}

function pick(value, allowed, label) {
  const match = allowed.find((a) => a.toLowerCase() === String(value || '').toLowerCase());
  if (!match) throw new Error(`${label} must be one of: ${allowed.join(', ')} (got "${value}")`);
  return match;
}

const names = (field) => FIELDS[field].map((o) => o.name);

// ---------- active task file ----------
/** @param {{branch?: string}} [opts] */
function loadActiveTask({ branch } = {}) {
  if (!fs.existsSync(TASK_FILE)) return null;
  const task = JSON.parse(fs.readFileSync(TASK_FILE, 'utf8'));
  // A task file inherited from another branch (e.g. merged into main) is not this branch's task.
  if (branch && task.branch && task.branch !== branch) return null;
  return task;
}

function saveActiveTask(task) {
  fs.mkdirSync(path.dirname(TASK_FILE), { recursive: true });
  fs.writeFileSync(TASK_FILE, JSON.stringify(task, null, 2) + '\n');
}

/** "Todo -> In Progress", from the task history with repeats collapsed. */
function lifecycle(task) {
  const steps = [];
  for (const h of task.history || []) if (steps[steps.length - 1] !== h.status) steps.push(h.status);
  return steps.join(' -> ');
}

// ---------- labels (mirrored fallback) ----------
function ensureLabels(repo) {
  for (const [name, color] of Object.entries(LABEL_COLORS)) {
    gh(['label', 'create', name, '--color', color, '--force', '-R', repo.full, '--description', `Worktree task tracker: ${name}`]);
  }
}

// ---------- GitHub Project (Projects V2) ----------
const FIELD_FRAGMENT = `fields(first: 50) { nodes {
  ... on ProjectV2SingleSelectField { id name options { id name } }
  ... on ProjectV2FieldCommon { id name } } }`;

function ownerInfo(repo) {
  const d = graphql(
    `query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id owner { id login __typename } } }`,
    { o: repo.owner, n: repo.name }
  );
  return { repoId: d.repository.id, ownerId: d.repository.owner.id, ownerType: d.repository.owner.__typename };
}

function findProject(repo, ownerType) {
  const root = ownerType === 'Organization' ? 'organization' : 'user';
  const d = graphql(
    `query($login: String!, $q: String!) { ${root}(login: $login) {
       projectsV2(first: 20, query: $q) { nodes { id number title url closed ${FIELD_FRAGMENT} } } } }`,
    { login: repo.owner, q: PROJECT_TITLE }
  );
  return d[root].projectsV2.nodes.find((p) => p.title === PROJECT_TITLE && !p.closed) || null;
}

function getProject(id) {
  return graphql(`query($id: ID!) { node(id: $id) { ... on ProjectV2 { id number title url ${FIELD_FRAGMENT} } } }`, { id }).node;
}

function sameOptions(field, wanted) {
  const have = (field.options || []).map((o) => o.name);
  return have.length === wanted.length && wanted.every((w, i) => have[i] === w.name);
}

/** Finds or creates the board, links the repo, and makes the fields match FIELDS exactly. */
function ensureProject(repo) {
  const { repoId, ownerId, ownerType } = ownerInfo(repo);
  let project = findProject(repo, ownerType);
  if (!project) {
    say(`Creating GitHub Project "${PROJECT_TITLE}"...`);
    const d = graphql(
      `mutation($o: ID!, $t: String!, $r: ID!) { createProjectV2(input: { ownerId: $o, title: $t, repositoryId: $r }) { projectV2 { id } } }`,
      { o: ownerId, t: PROJECT_TITLE, r: repoId }
    );
    project = getProject(d.createProjectV2.projectV2.id);
    graphql(
      `mutation($p: ID!, $d: String!) { updateProjectV2(input: { projectId: $p, shortDescription: $d }) { projectV2 { id } } }`,
      { p: project.id, d: `Task lifecycle (Todo -> In Progress -> In Review -> Done) for ${repo.full} worktrees` }
    );
  } else {
    try {
      graphql(`mutation($p: ID!, $r: ID!) { linkProjectV2ToRepository(input: { projectId: $p, repositoryId: $r }) { repository { id } } }`, {
        p: project.id,
        r: repoId,
      });
    } catch {
      /* already linked */
    }
  }

  let changed = false;
  for (const [key, options] of Object.entries(FIELDS)) {
    const fieldName = PROJECT_FIELD[key];
    const field = project.fields.nodes.find((f) => f.name === fieldName);
    if (!field) {
      graphql(
        `mutation($p: ID!, $n: String!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
           createProjectV2Field(input: { projectId: $p, dataType: SINGLE_SELECT, name: $n, singleSelectOptions: $o }) { clientMutationId } }`,
        { p: project.id, n: fieldName, o: options }
      );
      changed = true;
    } else if (!sameOptions(field, options)) {
      // Keep existing option IDs where names match so items keep their values.
      const merged = options.map((o) => {
        const existing = (field.options || []).find((e) => e.name === o.name);
        return existing ? { ...o, id: existing.id } : o;
      });
      try {
        graphql(
          `mutation($f: ID!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
             updateProjectV2Field(input: { fieldId: $f, singleSelectOptions: $o }) { clientMutationId } }`,
          { f: field.id, o: merged }
        );
      } catch {
        graphql(
          `mutation($f: ID!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
             updateProjectV2Field(input: { fieldId: $f, singleSelectOptions: $o }) { clientMutationId } }`,
          { f: field.id, o: options }
        );
      }
      changed = true;
    }
  }
  return changed ? getProject(project.id) : project;
}

function setItemField(project, itemId, key, optionName) {
  const fieldName = PROJECT_FIELD[key];
  const field = project.fields.nodes.find((f) => f.name === fieldName);
  const option = field && (field.options || []).find((o) => o.name === optionName);
  if (!option) throw new Error(`Project field ${fieldName} has no option "${optionName}". Run: node scripts/manage-project-task.js setup`);
  graphql(
    `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) {
       updateProjectV2ItemFieldValue(input: { projectId: $p, itemId: $i, fieldId: $f, value: { singleSelectOptionId: $o } }) { clientMutationId } }`,
    { p: project.id, i: itemId, f: field.id, o: option.id }
  );
}

// ---------- commands ----------
function setup() {
  const repo = repoSlug();
  ensureLabels(repo);
  say(`✅ Labels ready on ${repo.full} (severity:*, type:*, status:*)`);
  const project = ensureProject(repo);
  say(`✅ Project ready: ${project.title} (#${project.number})\n   ${project.url}`);
  const boardFields = Object.values(PROJECT_FIELD);
  for (const f of project.fields.nodes.filter((f) => boardFields.includes(f.name))) {
    say(`   • ${f.name}: ${f.options.map((o) => o.name).join(', ')}`);
  }
  say('   • Task Name: the built-in Title field');
}

function createTask(opts) {
  if (!opts.title || !String(opts.title).trim()) throw new Error('--title "<Task Name>" is required');
  const type = pick(opts.type, names('Type'), '--type');
  const severity = pick(opts.severity || DEFAULT_SEVERITY, names('Severity'), '--severity');
  const branchType = opts.branchType || branches.TYPE_FOR_TASK[type];
  if (!branches.BRANCH_TYPES.includes(branchType)) {
    throw new Error(`--branch-type must be one of: ${branches.BRANCH_TYPES.join(', ')} (got "${branchType}")`);
  }
  const status = 'Todo';
  const now = new Date().toISOString();

  const task = {
    issueNumber: null,
    issueUrl: null,
    projectItemId: null,
    projectNumber: null,
    projectUrl: null,
    taskName: opts.title.trim(),
    type,
    severity,
    status,
    branch: currentBranch(),
    mode: 'dry-run',
    createdAt: now,
    history: [{ status, at: now }],
  };

  if (DRY_RUN) {
    task.issueNumber = Number(opts.dryRunIssue || 0) || 1;
    say('(dry run) Skipped GitHub: no issue or project item created.');
  } else {
    const repo = repoSlug();
    ensureLabels(repo);
    const body = [
      `**Task Name:** ${task.taskName}`,
      `**Type:** ${type} · **Severity:** ${severity}`,
      '',
      'Tracked by `scripts/manage-project-task.js`. Lifecycle: Todo -> In Progress -> In Review -> Done.',
      'This issue closes automatically when the PR with `Closes #<this issue>` is merged.',
    ].join('\n');
    const url = gh([
      'issue', 'create', '-R', repo.full, '--title', task.taskName, '--body', body,
      '--label', `type:${type}`, '--label', `severity:${severity}`, '--label', `status:${status}`,
    ]);
    task.issueUrl = url.split('\n').pop();
    task.issueNumber = Number(task.issueUrl.split('/').pop());
    task.mode = 'labels';
    say(`✅ Issue #${task.issueNumber} created: ${task.issueUrl}`);

    try {
      const project = ensureProject(repo);
      const issueId = JSON.parse(gh(['api', `repos/${repo.full}/issues/${task.issueNumber}`])).node_id;
      const d = graphql(
        `mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } } }`,
        { p: project.id, c: issueId }
      );
      task.projectItemId = d.addProjectV2ItemById.item.id;
      task.projectNumber = project.number;
      task.projectUrl = project.url;
      setItemField(project, task.projectItemId, 'Type', type);
      setItemField(project, task.projectItemId, 'Severity', severity);
      setItemField(project, task.projectItemId, 'Status', status);
      task.mode = 'project';
      say(`✅ Added to project "${PROJECT_TITLE}" (Type: ${type}, Severity: ${severity}, Status: ${status})`);
    } catch (err) {
      say(`⚠️  Project board update failed, labels used as fallback: ${err.message}`);
    }
  }

  if (DRY_RUN || opts.noBranch) {
    saveActiveTask(task);
    say(`✅ Active task saved: qa-evidence/active-task.json (branch ${task.branch}, status ${status})`);
    return task;
  }

  // Work starts on a branch named after the issue: the task moves to In Progress.
  task.branch = startBranch(branchType, task);
  saveActiveTask(task);
  say(`✅ Branch ${task.branch} checked out`);
  return setStatus('In Progress', { note: `Work started on branch \`${task.branch}\`.` }) || task;
}

/** Creates (or renames to) the convention branch <type>/<issue>-<slug> and returns its name. */
function startBranch(branchType, task) {
  const name = branches.buildBranch(branchType, task.issueNumber, task.taskName);
  const current = currentBranch();
  if (current === name) return name;
  // A fresh worktree branch with no commits of its own is renamed, so no stray branch is left behind.
  const ownCommits = git('rev-list', '--count', 'origin/main..HEAD');
  if (!branches.EXEMPT.includes(current) && current !== 'HEAD' && ownCommits === '0') {
    gitStrict('branch', '-m', name);
  } else {
    gitStrict('switch', '-c', name);
  }
  return name;
}

/** Sets Status on the board (if the issue is on it) and the status:* label, and comments on the issue. */
function applyStatus(repo, issueNumber, status, { projectItemId = null, note = '', log = say } = {}) {
  try {
    const project = ensureProject(repo);
    const itemId = projectItemId || findProjectItem(repo, issueNumber, project.id);
    if (itemId) {
      setItemField(project, itemId, 'Status', status);
      log(`✅ Project board: #${issueNumber} Status -> ${status}`);
    }
  } catch (err) {
    log(`⚠️  Project board update failed (labels still updated): ${err.message}`);
  }
  try {
    const args = ['issue', 'edit', String(issueNumber), '-R', repo.full, '--add-label', `status:${status}`];
    const current = JSON.parse(gh(['issue', 'view', String(issueNumber), '-R', repo.full, '--json', 'labels'])).labels;
    for (const l of current) if (l.name.startsWith('status:') && l.name !== `status:${status}`) args.push('--remove-label', l.name);
    gh(args);
    gh(['issue', 'comment', String(issueNumber), '-R', repo.full, '--body', `**Status:** **${status}**` + (note ? `\n\n${note}` : '')]);
    log(`✅ Issue #${issueNumber}: label status:${status}, comment added`);
  } catch (err) {
    log(`⚠️  Issue label/comment update failed: ${err.message}`);
  }
}

function findProjectItem(repo, issueNumber, projectId) {
  const d = graphql(
    `query($o: String!, $n: String!, $i: Int!) { repository(owner: $o, name: $n) { issue(number: $i) {
       projectItems(first: 20) { nodes { id project { id } } } } } }`,
    { o: repo.owner, n: repo.name, i: issueNumber }
  );
  const item = d.repository.issue.projectItems.nodes.find((n) => n.project.id === projectId);
  return item ? item.id : null;
}

/**
 * Moves the active task to a new status on the board, labels, issue comment and JSON.
 * Returns the updated task, or null if there is no active task for this branch.
 * @param {string} newStatus
 * @param {{note?: string, quiet?: boolean}} [opts]
 */
function setStatus(newStatus, { note = '', quiet = false } = {}) {
  const status = pick(newStatus, names('Status'), '--set');
  const task = loadActiveTask({ branch: currentBranch() });
  if (!task) {
    if (!quiet) say('No active task for this branch. Create one first: node scripts/manage-project-task.js create ...');
    return null;
  }
  const log = quiet ? () => {} : say;

  if (!DRY_RUN && task.issueNumber) {
    applyStatus(repoSlug(), task.issueNumber, status, { projectItemId: task.projectItemId, note, log });
  } else if (DRY_RUN) {
    log(`(dry run) Status ${task.status} -> ${status} (GitHub skipped)`);
  }

  task.status = status;
  task.history = [...(task.history || []), { status, at: new Date().toISOString() }];
  saveActiveTask(task);
  return task;
}

// ---------- CLI ----------
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    flags[key] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return flags;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  try {
    if (command === 'setup') return setup();
    if (command === 'create') return void createTask(flags);
    if (command === 'status') {
      if (!flags.set) throw new Error('status needs --set "<In Progress|In Review|Blocked>"');
      if (CI_ONLY_STATUSES.includes(pick(flags.set, names('Status'), '--set'))) {
        throw new Error('Done is set by CI when the PR merges (GitHub closes the issue via "Closes #N"). It cannot be set by hand.');
      }
      const t = setStatus(flags.set, { note: flags.note });
      if (!t) process.exit(1);
      return say(`✅ Task #${t.issueNumber} status: ${t.status}  (lifecycle: ${lifecycle(t)})`);
    }
    if (command === 'sync') {
      const issue = Number(flags.issue);
      if (!issue || !flags.set) throw new Error('sync needs --issue <N> --set <status>');
      const status = pick(flags.set, names('Status'), '--set');
      if (DRY_RUN) return say(`(dry run) #${issue} -> ${status}`);
      const repo = repoSlug();
      ensureLabels(repo);
      return applyStatus(repo, issue, status, { note: flags.note === true ? '' : flags.note });
    }
    if (command === 'show') {
      const t = loadActiveTask({ branch: currentBranch() });
      if (!t) return say('No active task for this branch.');
      return say(JSON.stringify({ ...t, lifecycle: lifecycle(t) }, null, 2));
    }
    say(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, ''));
    process.exit(command ? 1 : 0);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

module.exports = { loadActiveTask, setStatus, lifecycle, currentBranch, FIELDS, DEFAULT_SEVERITY, PROJECT_TITLE };

if (require.main === module) main();

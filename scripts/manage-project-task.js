#!/usr/bin/env node
/**
 * manage-project-task.js — GitHub Project task lifecycle for a worktree.
 *
 * Every piece of work is tracked as a GitHub Issue on the
 * "Enterprise Worktree Task Tracker" project board, with these fields:
 *   Task Name (Title) · Severity (Low*, Medium, High, Critical)
 *   Type (Task, Issue, Bug; shown as "Task Type" on the board, since GitHub reserves "Type")
 *   Status (Open, Pending, Testing, Closed)
 * Repository labels (severity:*, type:*, status:*) mirror the same values, so the task
 * is still tracked if the Projects API is unavailable.
 *
 * Commands:
 *   setup                                   create/repair the project board, fields and labels
 *   create --title "<Task Name>" --type <Task|Issue|Bug> [--severity <Low|Medium|High|Critical>] [--status Open]
 *   status --set <Open|Pending|Testing|Closed> [--note "<text>"] [--close-issue]
 *   show                                    print the active task
 *
 * The active task is saved in qa-evidence/active-task.json (tied to the current branch).
 * Set TASK_DRY_RUN=1 to skip all GitHub calls (local demos and tests).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
    { name: 'Open', color: 'GRAY', description: 'Task created, work not tested yet' },
    { name: 'Pending', color: 'YELLOW', description: 'Blocked or on hold' },
    { name: 'Testing', color: 'BLUE', description: 'Pre-PR audit running / awaiting manual approval' },
    { name: 'Closed', color: 'GREEN', description: 'Manually approved, PR created' },
  ],
};
const DEFAULT_SEVERITY = 'Low';

// Field names on the project board. GitHub reserves "Type" (its built-in issue types),
// so the Type field is called "Task Type" on the board. Labels still use type:*.
const PROJECT_FIELD = { Severity: 'Severity', Type: 'Task Type', Status: 'Status' };

const LABEL_COLORS = {
  'severity:Low': '0e8a16', 'severity:Medium': 'fbca04', 'severity:High': 'd93f0b', 'severity:Critical': 'b60205',
  'type:Task': '1d76db', 'type:Issue': '5319e7', 'type:Bug': 'd73a4a',
  'status:Open': 'c5def5', 'status:Pending': 'fef2c0', 'status:Testing': '0052cc', 'status:Closed': '6a737d',
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

/** "Open -> Testing -> Closed", from the task history with repeats collapsed. */
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
      { p: project.id, d: `Task lifecycle (Open -> Testing -> Closed) for ${repo.full} worktrees` }
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
  const status = pick(opts.status || 'Open', names('Status'), '--status');
  const branch = currentBranch();
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
    branch,
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
      `**Type:** ${type} · **Severity:** ${severity} · **Status:** ${status}`,
      `**Branch / worktree:** \`${branch}\``,
      '',
      'Tracked by `scripts/manage-project-task.js`. Lifecycle: Open -> Testing -> Closed.',
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

  saveActiveTask(task);
  say(`✅ Active task saved: qa-evidence/active-task.json (branch ${branch})`);
  return task;
}

/**
 * Moves the active task to a new status on the board, labels, issue comment and JSON.
 * Returns the updated task, or null if there is no active task for this branch.
 */
function setStatus(newStatus, { note, closeIssue = false, quiet = false } = {}) {
  const status = pick(newStatus, names('Status'), '--set');
  const task = loadActiveTask({ branch: currentBranch() });
  if (!task) {
    if (!quiet) say('No active task for this branch. Create one first: node scripts/manage-project-task.js create ...');
    return null;
  }
  const previous = task.status;
  const log = quiet ? () => {} : say;

  if (!DRY_RUN && task.issueNumber) {
    const repo = repoSlug();
    try {
      if (task.projectItemId) {
        const project = ensureProject(repo);
        setItemField(project, task.projectItemId, 'Status', status);
        log(`✅ Project board: #${task.issueNumber} Status ${previous} -> ${status}`);
      }
    } catch (err) {
      log(`⚠️  Project board update failed (labels still updated): ${err.message}`);
    }
    try {
      const args = ['issue', 'edit', String(task.issueNumber), '-R', repo.full, '--add-label', `status:${status}`];
      for (const s of names('Status')) if (s !== status) args.push('--remove-label', `status:${s}`);
      gh(args);
      const comment = `**Status:** ${previous} → **${status}**` + (note ? `\n\n${note}` : '');
      gh(['issue', 'comment', String(task.issueNumber), '-R', repo.full, '--body', comment]);
      if (closeIssue) gh(['issue', 'close', String(task.issueNumber), '-R', repo.full, '--reason', 'completed']);
      log(`✅ Issue #${task.issueNumber}: label status:${status}, comment added${closeIssue ? ', issue closed' : ''}`);
    } catch (err) {
      log(`⚠️  Issue label/comment update failed: ${err.message}`);
    }
  } else if (DRY_RUN) {
    log(`(dry run) Status ${previous} -> ${status} (GitHub skipped)`);
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
      if (!flags.set) throw new Error('status needs --set <Open|Pending|Testing|Closed>');
      const t = setStatus(flags.set, { note: flags.note, closeIssue: Boolean(flags.closeIssue) });
      if (!t) process.exit(1);
      return say(`✅ Task #${t.issueNumber} status: ${t.status}  (lifecycle: ${lifecycle(t)})`);
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

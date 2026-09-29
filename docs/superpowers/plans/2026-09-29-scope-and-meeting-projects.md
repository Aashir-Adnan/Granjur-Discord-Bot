# Scope Everywhere and Meeting-Task Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Meeting tasks carry one of four fixed scopes and land in the meeting's project automatically (asking the reviewer only when unclear), old free-text scopes move into Modules, and the site's Board and Tasks tabs filter by scope.

**Architecture:** CSAAS asks Claude for a `scope` and stores only valid values in a new `meeting_tasks.scope` column. The bot maps each CSAAS task to a fixed scope (Claude's pick, else platform, else none) and settles its project by three rules (meeting project → named project → reviewer's pick in a new review-message select), and a SQL migration cleans existing rows. The site adds a client-side Scope filter mirrored to `?scope=`.

**Tech Stack:** Bot: Node ESM, discord.js v14, `node:test`. CSAAS: Node CommonJS, UBS framework, jest. Site: React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-scope-and-meeting-projects-design.md` (bot repo)

## Global Constraints

- The four scopes, verbatim, lowercase: `backend`, `frontend`, `qa`, `design`. Labels: Backend, Frontend, QA, Design.
- Platform fallback: `node`, `python` → `backend`; `react`, `react-native` → `frontend`; anything else → no scope.
- Project rules, in order: (1) the meeting's project, (2) `matchProject` on the name Claude gave, (3) the reviewer's pick; else no project (`projectId` and `projectName` both `null`).
- Review "Which project?" select: guild projects sorted by name, at most 24, plus "No project" (value `none`). Placeholder text: `Which project?`.
- Review page size: 1 when any task in the review state has `needsProject` (rejected or not); otherwise 2.
- Bot tests must use fakes for `db`/`getConfig` — never the default `db` export (`.claude/rules/tests-never-touch-production.md`; the root `.env` points at production).
- Commits: author `Nauraiz Haider <bsse23047@itu.edu.pk>` (pass `-c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk"`), message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` — exactly that, no other model name.
- Never push, merge, deploy, or run anything against a live database. Never run the bot's `npm run db:migrate`.
- A grepped test summary can exit 0 while red: always read the `fail`/`Tests:` counts.

## Workspaces

- Bot: `D:\Work\Granjur Technologies\Granjur-Discord-Bot`, branch `feat/scope-meeting-projects` (already checked out; the spec is committed there). Tasks 1–5 and 8.
- CSAAS: `D:\Work\Granjur Technologies\CSAAS_Backend`, create branch `feat/meeting-task-scope` from `main` in the main checkout (it is clean apart from untracked files that must be left alone). Task 6.
- Site: the main UBS-Doc checkout holds someone else's uncommitted work — never touch it. Create a worktree: `git -C "D:/Work/Granjur Technologies/UBS-Doc" worktree add "D:/Work/Granjur Technologies/UBS-Doc-scope-filter" -b feat/scope-filter main`, then run `npm ci` there if `node_modules` is missing. Task 7.

## Review Focus

1. A legacy review job (posted before deploy) has no `needsProject`/`projectId`/`reviewProjects` — it must render and approve exactly as before (Task 3 and Task 4 tests pin this).
2. A rejected task that still needs a project keeps rendering its three rows — page size must count it, or a page of two such tasks exceeds Discord's 5-row limit (Task 3 test).
3. A reviewer's picked project id that no longer exists (project deleted between review and approval) must yield no project, not a dangling id (Task 2 test).
4. CSAAS returning scope in any case (`"Backend"`) or with whitespace must still count as valid; free text must never reach `task.scope` (Task 1 and Task 6 tests).
5. `?scope=` with an unknown value (typo, old link) must read as "all", and the scope filter must not silently narrow the header counts or People tab where no Scope control is shown (Task 7 tests).

---

### Task 1: Bot — fixed scope and modules for meeting tasks

**Files:**
- Modify: `bot/src/services/meetingTaskMap.js`
- Test: `bot/src/services/meetingTaskMap.test.js`

**Interfaces:**
- Consumes: `isValidScope(value)` from `bot/src/utils/taskScope.js` (existing).
- Produces: `meetingTaskScope(csaasTask) → 'backend'|'frontend'|'qa'|'design'|null` and `meetingTaskModules(csaasTask) → string[]`, both exported from `bot/src/services/meetingTaskMap.js`. `mapMeetingTaskToRow` now sets `scope: meetingTaskScope(csaasTask)` and `modules: meetingTaskModules(csaasTask)`.

- [ ] **Step 1: Write the failing tests**

In `bot/src/services/meetingTaskMap.test.js`, change the import line to:

```js
import { mapMeetingTaskToRow, meetingTaskScope, meetingTaskModules } from './meetingTaskMap.js'
```

In the first test (`'maps a csaas task + review row to a task.create payload'`), replace the two lines

```js
  assert.equal(row.scope, 'Auth')
  assert.deepEqual(row.modules, ['Login'])
```

with

```js
  // No scope from CSAAS and no platform: no scope. The free-text feature is a
  // module now, never a scope (roadmap sub-project 2, 2026-09-29).
  assert.equal(row.scope, null)
  assert.deepEqual(row.modules, ['Auth', 'Login'])
```

Append these tests at the end of the file:

```js
test('meetingTaskScope takes a valid CSAAS scope, in any case or padding', () => {
  assert.equal(meetingTaskScope({ scope: 'backend' }), 'backend')
  assert.equal(meetingTaskScope({ scope: '  Frontend ' }), 'frontend')
  assert.equal(meetingTaskScope({ scope: 'QA' }), 'qa')
  assert.equal(meetingTaskScope({ scope: 'design', platform: 'node' }), 'design', 'Claude wins over platform')
})

test('meetingTaskScope falls back to the platform when the scope is missing or free text', () => {
  assert.equal(meetingTaskScope({ platform: 'node' }), 'backend')
  assert.equal(meetingTaskScope({ platform: 'Python' }), 'backend')
  assert.equal(meetingTaskScope({ platform: 'react' }), 'frontend')
  assert.equal(meetingTaskScope({ scope: 'GitSync', platform: 'react-native' }), 'frontend')
})

test('meetingTaskScope is null with no usable scope or platform', () => {
  assert.equal(meetingTaskScope({}), null)
  assert.equal(meetingTaskScope({ scope: 'GitSync', platform: 'other' }), null)
  assert.equal(meetingTaskScope(null), null)
})

test('meetingTaskModules keeps feature and sub-feature, trimmed, without blanks or duplicates', () => {
  assert.deepEqual(meetingTaskModules({ feature: ' Auth ', sub_feature: 'Login' }), ['Auth', 'Login'])
  assert.deepEqual(meetingTaskModules({ feature: 'Auth', sub_feature: 'auth' }), ['Auth'])
  assert.deepEqual(meetingTaskModules({ feature: '', sub_feature: 'Login' }), ['Login'])
  assert.deepEqual(meetingTaskModules({}), [])
})

test('mapMeetingTaskToRow stores the fixed scope', () => {
  const row = mapMeetingTaskToRow(
    { task_id: 'ct9', scope: 'Backend', feature: 'GitSync' },
    { taskId: 'ct9', rejected: false },
    { guildConfigId: 'g', meetingId: 'M' },
  )
  assert.equal(row.scope, 'backend')
  assert.deepEqual(row.modules, ['GitSync'])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test bot/src/services/meetingTaskMap.test.js` (from the bot repo root)
Expected: FAIL — `meetingTaskScope` is not exported (SyntaxError on import).

- [ ] **Step 3: Implement**

In `bot/src/services/meetingTaskMap.js`, add above `mapMeetingTaskToRow`:

```js
import { isValidScope } from '../utils/taskScope.js'

// Where a meeting task's work is done, when Claude gives no usable scope.
const PLATFORM_SCOPE = { node: 'backend', python: 'backend', react: 'frontend', 'react-native': 'frontend' }

// One of the four fixed scopes, never free text (roadmap sub-project 2,
// 2026-09-29). Claude's pick wins when it is one of the four; otherwise the
// platform decides; otherwise the task has no scope.
export function meetingTaskScope(csaasTask) {
  const picked = String(csaasTask?.scope ?? '').trim().toLowerCase()
  if (isValidScope(picked)) return picked
  const platform = String(csaasTask?.platform ?? '').trim().toLowerCase()
  return PLATFORM_SCOPE[platform] ?? null
}

// The free-text feature and sub-feature Claude names. They used to be stored as
// the scope; they are Modules now.
export function meetingTaskModules(csaasTask) {
  const out = []
  for (const v of [csaasTask?.feature, csaasTask?.sub_feature]) {
    const s = String(v ?? '').trim()
    if (s && !out.some((m) => m.toLowerCase() === s.toLowerCase())) out.push(s)
  }
  return out
}
```

(The `import` goes at the very top of the file, above the existing comment.) In `mapMeetingTaskToRow`, replace

```js
    scope: csaasTask.feature || null,
    modules: csaasTask.sub_feature ? [csaasTask.sub_feature] : [],
```

with

```js
    scope: meetingTaskScope(csaasTask),
    modules: meetingTaskModules(csaasTask),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test bot/src/services/meetingTaskMap.test.js`
Expected: every test passes, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/meetingTaskMap.js bot/src/services/meetingTaskMap.test.js
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "feat(meeting-tasks): fixed scope from Claude or platform; feature becomes a module

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Bot — project rules for meeting tasks

**Files:**
- Create: `bot/src/services/meetingTaskProject.js`
- Test: `bot/src/services/meetingTaskProject.test.js`

**Interfaces:**
- Consumes: `matchProject(name, { projects, repos, links }) → { projectId, projectName, repositoryId } | null` from `bot/src/utils/projectMatch.js` (existing).
- Produces (all exported from `bot/src/services/meetingTaskProject.js`):
  - `REVIEW_PROJECT_LIMIT = 24`
  - `async loadProjectContext(db, job) → { projects, repos, links, meetingProjectId }` — `job` needs `guildConfigId`, `meetingId`. Never throws.
  - `settledProject(csaasTask, ctx) → { projectId, projectName } | null` — rules 1 and 2.
  - `resolveMeetingTaskProject(csaasTask, reviewTask, ctx) → { projectId, projectName, repositoryId }` — rules 1–3 plus the repository rule. `reviewTask.projectId` may be absent (legacy state).
  - `reviewProjectOptions(projects) → { id: string, name: string }[]` — sorted by name, ≤ 24.

- [ ] **Step 1: Write the failing tests**

Create `bot/src/services/meetingTaskProject.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REVIEW_PROJECT_LIMIT,
  loadProjectContext,
  settledProject,
  resolveMeetingTaskProject,
  reviewProjectOptions,
} from './meetingTaskProject.js'

const P1 = { id: 'p1', name: 'Framework' }
const P2 = { id: 'p2', name: 'Badar HMS' }
const ctxOf = (over = {}) => ({ projects: [P1, P2], repos: [], links: [], meetingProjectId: null, ...over })

test('loadProjectContext reads projects, repos, links and the meeting project through the db seam', async () => {
  const seen = []
  const db = {
    project: { findMany: async (q) => { seen.push(['project', q]); return [P1] } },
    repository: { findMany: async () => [{ id: 'r1', name: 'fw' }] },
    projectRepos: { findMany: async () => [{ projectId: 'p1', repositoryId: 'r1' }] },
    meeting: { findUnique: async (q) => { seen.push(['meeting', q]); return { id: 'M', projectId: 'p1' } } },
  }
  const ctx = await loadProjectContext(db, { guildConfigId: 'g', meetingId: 'M' })
  assert.deepEqual(ctx.projects, [P1])
  assert.equal(ctx.repos.length, 1)
  assert.equal(ctx.links.length, 1)
  assert.equal(ctx.meetingProjectId, 'p1')
  assert.deepEqual(seen[0], ['project', { where: { guildConfigId: 'g' } }])
  assert.deepEqual(seen[1], ['meeting', { where: { id: 'M' } }])
})

test('loadProjectContext never throws: a failed read leaves that part empty', async () => {
  const ctx = await loadProjectContext({}, { guildConfigId: 'g', meetingId: 'M' })
  assert.deepEqual(ctx, { projects: [], repos: [], links: [], meetingProjectId: null })
})

test("rule 1: the meeting's project wins over the project Claude named", () => {
  const out = settledProject({ project: 'Badar HMS' }, ctxOf({ meetingProjectId: 'p1' }))
  assert.deepEqual(out, { projectId: 'p1', projectName: 'Framework' })
})

test('rule 2: with no meeting project, the named project is matched', () => {
  const out = settledProject({ project: 'Badar_HMS' }, ctxOf())
  assert.deepEqual(out, { projectId: 'p2', projectName: 'Badar HMS' })
})

test('a meeting project that no longer exists falls through to rule 2', () => {
  const out = settledProject({ project: 'Framework' }, ctxOf({ meetingProjectId: 'gone' }))
  assert.deepEqual(out, { projectId: 'p1', projectName: 'Framework' })
})

test('unclear: no meeting project and no match settles nothing', () => {
  assert.equal(settledProject({ project: 'Something else' }, ctxOf()), null)
  assert.equal(settledProject({}, ctxOf()), null)
})

test("rule 3: the reviewer's pick applies only to an unclear task", () => {
  const picked = resolveMeetingTaskProject({}, { projectId: 'p2' }, ctxOf())
  assert.deepEqual(picked, { projectId: 'p2', projectName: 'Badar HMS', repositoryId: null })
  const ignored = resolveMeetingTaskProject({}, { projectId: 'p2' }, ctxOf({ meetingProjectId: 'p1' }))
  assert.equal(ignored.projectId, 'p1')
})

test('a picked project that no longer exists, "none", or a legacy state gives no project and no name', () => {
  const none = { projectId: null, projectName: null, repositoryId: null }
  assert.deepEqual(resolveMeetingTaskProject({ project: 'Ghost' }, { projectId: 'deleted' }, ctxOf()), none)
  assert.deepEqual(resolveMeetingTaskProject({ project: 'Ghost' }, { projectId: null }, ctxOf()), none)
  assert.deepEqual(resolveMeetingTaskProject({ project: 'Ghost' }, { taskId: 'a' }, ctxOf()), none)
})

test("the matched repository is kept only when the match's project is the task's project", () => {
  const ctx = ctxOf({
    repos: [{ id: 'r2', name: 'Badar_HMS_Node' }],
    links: [{ projectId: 'p2', repositoryId: 'r2' }],
  })
  // Rule 2 settled on the match: its repository comes along.
  assert.equal(resolveMeetingTaskProject({ project: 'Badar HMS' }, {}, ctx).repositoryId, 'r2')
  // Rule 1 overrode the match: the match's repository belongs to another project.
  assert.equal(resolveMeetingTaskProject({ project: 'Badar HMS' }, {}, { ...ctx, meetingProjectId: 'p1' }).repositoryId, null)
})

test('a repository-only match (no project) keeps its repository when the task also has no project', () => {
  const ctx = ctxOf({ projects: [], repos: [{ id: 'r1', name: 'granjur' }] })
  assert.deepEqual(resolveMeetingTaskProject({ project: 'granjur' }, {}, ctx), { projectId: null, projectName: null, repositoryId: 'r1' })
})

test('reviewProjectOptions sorts by name, drops unnamed rows, and caps at 24', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `id${i}`, name: `Proj ${String(i).padStart(2, '0')}` }))
  const out = reviewProjectOptions([{ id: 'x', name: '' }, ...many.reverse()])
  assert.equal(REVIEW_PROJECT_LIMIT, 24)
  assert.equal(out.length, 24)
  assert.deepEqual(out[0], { id: 'id0', name: 'Proj 00' })
  assert.equal(out[23].name, 'Proj 23')
  assert.deepEqual(reviewProjectOptions(undefined), [])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test bot/src/services/meetingTaskProject.test.js`
Expected: FAIL — cannot find module `./meetingTaskProject.js`.

- [ ] **Step 3: Implement**

Create `bot/src/services/meetingTaskProject.js`:

```js
// Which project a task from a meeting belongs to (roadmap sub-project 2,
// 2026-09-29). Rules, in order:
//   1. the MEETING's project (`/meeting-channel` records it on the meeting row);
//   2. the project Claude named, matched loosely against the bot's rows;
//   3. the reviewer's pick in the review message, for a task neither settles.
// Otherwise the task has no project — and no project name either: the name
// Claude heard is not kept, so it cannot show up as a stray project group.

import { matchProject } from '../utils/projectMatch.js'

// Discord caps a select at 25 options; one of them is "No project".
export const REVIEW_PROJECT_LIMIT = 24

// Loads once what the rules need. Best-effort: a failed read leaves that part
// empty and the rules fall through as if it were unset.
export async function loadProjectContext(db, job) {
  const ctx = { projects: [], repos: [], links: [], meetingProjectId: null }
  try {
    const [projects, repos, links] = await Promise.all([
      db.project.findMany({ where: { guildConfigId: job.guildConfigId } }),
      db.repository.findMany({ where: { guildConfigId: job.guildConfigId } }),
      db.projectRepos.findMany({ where: {} }),
    ])
    ctx.projects = projects || []
    ctx.repos = repos || []
    ctx.links = links || []
  } catch (e) {
    console.warn('[meetingPipeline] project/repo lookup failed:', e?.message || e)
  }
  try {
    ctx.meetingProjectId = (await db.meeting.findUnique({ where: { id: job.meetingId } }))?.projectId || null
  } catch (e) {
    console.warn('[meetingPipeline] meeting project lookup failed:', e?.message || e)
  }
  return ctx
}

const projectById = (ctx, id) => (id ? ctx.projects.find((p) => p.id === id) ?? null : null)

// Rules 1 and 2. Null means the task is unclear and the reviewer is asked.
export function settledProject(csaasTask, ctx) {
  const meeting = projectById(ctx, ctx.meetingProjectId)
  if (meeting) return { projectId: meeting.id, projectName: meeting.name ?? null }
  const match = matchProject(csaasTask?.project, ctx)
  if (match?.projectId) return { projectId: match.projectId, projectName: match.projectName ?? null }
  return null
}

// All three rules, plus the repository: the matched repository only when the
// match's project is the task's project (sub-project 4 will pick repositories
// by scope; until then a repository from another project would be wrong).
export function resolveMeetingTaskProject(csaasTask, reviewTask, ctx) {
  const match = matchProject(csaasTask?.project, ctx)
  const settled = settledProject(csaasTask, ctx)
  const picked = settled ? null : projectById(ctx, reviewTask?.projectId)
  const projectId = settled?.projectId ?? picked?.id ?? null
  const projectName = settled?.projectName ?? picked?.name ?? null
  const repositoryId = match && (match.projectId ?? null) === projectId ? match.repositoryId ?? null : null
  return { projectId, projectName, repositoryId }
}

// The choices the review's "Which project?" select offers, stored on the job so
// every re-render (a click, or /meeting-review) shows the same list.
export function reviewProjectOptions(projects) {
  return [...(projects || [])]
    .filter((p) => p?.id && p?.name)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(0, REVIEW_PROJECT_LIMIT)
    .map((p) => ({ id: String(p.id), name: String(p.name) }))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test bot/src/services/meetingTaskProject.test.js`
Expected: every test passes, `fail 0`. If the rule-2 test fails, read `bot/src/utils/projectMatch.js` to see how `'Badar_HMS'` normalises — do not change `matchProject`; adjust only the test's project name so it is an exact normalised match (`normalizeName` strips non-alphanumerics and lowercases).

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/meetingTaskProject.js bot/src/services/meetingTaskProject.test.js
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "feat(meeting-tasks): project rules — meeting project, named project, reviewer's pick

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Bot — review message: scope, modules, project line and "Which project?" select

**Files:**
- Modify: `bot/src/services/meetingReviewUI.js`
- Modify: `bot/src/commands/meetingReview.js`
- Test: `bot/src/services/meetingReviewUI.test.js`, `bot/src/commands/meetingReview.test.js`

**Interfaces:**
- Consumes: `meetingTaskScope`, `meetingTaskModules` from `bot/src/services/meetingTaskMap.js` (Task 1); `scopeLabel` from `bot/src/utils/taskScope.js`; `REVIEW_PROJECT_LIMIT` from `bot/src/services/meetingTaskProject.js` (Task 2).
- Produces:
  - `initReviewState(tasks, assignments, settle?)` — `settle(csaasTask) → { projectId, projectName } | null`. With `settle` given, each state task gains `needsProject: boolean`, `projectId: null`, `projectLabel: string|null`. Without `settle` (legacy callers), `needsProject: false`, `projectId: null`, `projectLabel: null`.
  - `applyReviewAction(state, { type: 'project', taskId, projectId })` — `'none'`/empty → `null`.
  - `pageSizeFor(state) → 1 | 2` (exported). `PAGE_SIZE` stays exported as `2`.
  - `buildReviewMessage` reads `job.dataJson.reviewProjects` (`{id,name}[]`, may be absent).
  - Component customId `mtg_project:<jobId>:<taskId>` (string select).
  - `reviewActionFor(kind, taskId, values) → action | null`, exported from `bot/src/commands/meetingReview.js`.

- [ ] **Step 1: Write the failing tests**

Append to `bot/src/services/meetingReviewUI.test.js` (and add `pageSizeFor` to its import list from `./meetingReviewUI.js`):

```js
// --- roadmap sub-project 2 (2026-09-29): scope, modules and the project select

const settleFirstOnly = (t) => (t.task_id === 'a' ? { projectId: 'p1', projectName: 'Framework' } : null)
const PROJECTS = [{ id: 'p1', name: 'Framework' }, { id: 'p2', name: 'Badar HMS' }]
const rowsJson = (msg) => JSON.stringify(msg.components.map((c) => c.toJSON()))

test('initReviewState marks only unsettled tasks as needing a project', () => {
  const s = initReviewState(tasks, assignments, settleFirstOnly)
  const a = s.tasks.find((t) => t.taskId === 'a')
  const b = s.tasks.find((t) => t.taskId === 'b')
  assert.deepEqual([a.needsProject, a.projectId, a.projectLabel], [false, null, 'Framework'])
  assert.deepEqual([b.needsProject, b.projectId, b.projectLabel], [true, null, null])
})

test('initReviewState without a settle function asks about nothing (legacy callers)', () => {
  const s = initReviewState(tasks, assignments)
  assert.ok(s.tasks.every((t) => t.needsProject === false && t.projectId === null))
})

test('the project action sets or clears the pick, targeted and immutable', () => {
  const s0 = initReviewState(tasks, assignments, settleFirstOnly)
  const s1 = applyReviewAction(s0, { type: 'project', taskId: 'b', projectId: 'p2' })
  assert.equal(s1.tasks.find((t) => t.taskId === 'b').projectId, 'p2')
  assert.equal(s0.tasks.find((t) => t.taskId === 'b').projectId, null)
  const s2 = applyReviewAction(s1, { type: 'project', taskId: 'b', projectId: 'none' })
  assert.equal(s2.tasks.find((t) => t.taskId === 'b').projectId, null)
})

test('pageSizeFor is 1 while any task needs a project, even a rejected one', () => {
  assert.equal(PAGE_SIZE, 2)
  assert.equal(pageSizeFor(initReviewState(tasks, assignments)), 2)
  const s = initReviewState(tasks, assignments, settleFirstOnly)
  assert.equal(pageSizeFor(s), 1)
  assert.equal(pageSizeFor(applyReviewAction(s, { type: 'rejectTask', taskId: 'b' })), 1)
  assert.equal(pageSizeFor(undefined), 2)
})

test('an unclear task gets the project select; every page stays within 5 rows', () => {
  const three = [
    { task_id: 'a', goal_of_task: 'A' },
    { task_id: 'b', goal_of_task: 'B' },
    { task_id: 'c', goal_of_task: 'C' },
  ]
  const job = { id: 'JOB7', dataJson: { title: 'Sync', tasks: three, assignments: [], reviewProjects: PROJECTS } }
  const state = initReviewState(three, [], settleFirstOnly)
  // b and c are unclear, so one task per page: three pages.
  const first = buildReviewMessage({ job, notes: '', reportPath: null, state, roster: [] })
  assert.match(first.embeds[0].data.description, /Page 1\/3/)
  for (const page of [0, 1, 2]) {
    const msg = buildReviewMessage({ job, notes: '', reportPath: null, state: applyReviewAction(state, { type: 'page', page }), roster: [] })
    assert.ok(msg.components.length <= 5, `page ${page} rows ${msg.components.length}`)
  }
  const pageA = rowsJson(buildReviewMessage({ job, notes: '', reportPath: null, state, roster: [] }))
  assert.ok(!pageA.includes('mtg_project:'), 'a settled task has no project select')
  const pageB = buildReviewMessage({ job, notes: '', reportPath: null, state: applyReviewAction(state, { type: 'page', page: 1 }), roster: [] })
  const selectRow = pageB.components.map((c) => c.toJSON()).find((r) => r.components[0].custom_id === 'mtg_project:JOB7:b')
  assert.ok(selectRow, 'the project select for b')
  const select = selectRow.components[0]
  assert.equal(select.placeholder, 'Which project?')
  assert.deepEqual(select.options.map((o) => o.value), ['p1', 'p2', 'none'])
  assert.equal(select.options[2].label, 'No project')
})

test('the project select marks the current pick and never offers more than 25 options', () => {
  const one = [{ task_id: 'b', goal_of_task: 'B' }]
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `id${i}`, name: `P${i}` }))
  const job = { id: 'J', dataJson: { tasks: one, assignments: [], reviewProjects: many } }
  let state = initReviewState(one, [], () => null)
  state = applyReviewAction(state, { type: 'project', taskId: 'b', projectId: 'id3' })
  const select = buildReviewMessage({ job, notes: '', reportPath: null, state, roster: [] })
    .components.map((c) => c.toJSON()).find((r) => r.components[0].custom_id === 'mtg_project:J:b').components[0]
  assert.equal(select.options.length, 25)
  assert.equal(select.options.find((o) => o.value === 'id3').default, true)
})

test('the task embed shows Scope, Modules and Project', () => {
  const two = [
    { task_id: 'a', goal_of_task: 'A', platform: 'node', feature: 'GitSync', sub_feature: 'Webhooks' },
    { task_id: 'b', goal_of_task: 'B', scope: 'design' },
  ]
  const job = { id: 'J', dataJson: { tasks: two, assignments: [], reviewProjects: PROJECTS } }
  let state = initReviewState(two, [], settleFirstOnly)
  const pageA = buildReviewMessage({ job, notes: '', reportPath: null, state, roster: [] }).embeds[1].data.description
  assert.match(pageA, /\*\*Scope:\*\* Backend/)
  assert.match(pageA, /\*\*Modules:\*\* GitSync, Webhooks/)
  assert.match(pageA, /\*\*Project:\*\* Framework/)
  state = applyReviewAction(state, { type: 'page', page: 1 })
  let pageB = buildReviewMessage({ job, notes: '', reportPath: null, state, roster: [] }).embeds[1].data.description
  assert.match(pageB, /\*\*Scope:\*\* Design/)
  assert.ok(!/Modules:/.test(pageB))
  assert.match(pageB, /\*\*Project:\*\* not set, pick one below/)
  state = applyReviewAction(state, { type: 'project', taskId: 'b', projectId: 'p2' })
  pageB = buildReviewMessage({ job, notes: '', reportPath: null, state, roster: [] }).embeds[1].data.description
  assert.match(pageB, /\*\*Project:\*\* Badar HMS/)
})

test('a task with no usable scope says so; a legacy state shows no project line', () => {
  const one = [{ task_id: 'x', goal_of_task: 'X', feature: 'Free text' }]
  const job = { id: 'J', dataJson: { tasks: one, assignments: [] } }
  const desc = buildReviewMessage({ job, notes: '', reportPath: null, state: initReviewState(one, []), roster: [] }).embeds[1].data.description
  assert.match(desc, /\*\*Scope:\*\* none/)
  assert.ok(!/Project:/.test(desc))
})
```

Append to `bot/src/commands/meetingReview.test.js` (and import `reviewActionFor` alongside `parseReviewCustomId`):

```js
test('reviewActionFor maps each component kind to its review action', () => {
  assert.deepEqual(reviewActionFor('mtg_assignee', 't', ['11']), { type: 'assignee', taskId: 't', ref: '11' })
  assert.deepEqual(reviewActionFor('mtg_assignee', 't', []), { type: 'assignee', taskId: 't', ref: null })
  assert.deepEqual(reviewActionFor('mtg_project', 't', ['p2']), { type: 'project', taskId: 't', projectId: 'p2' })
  assert.deepEqual(reviewActionFor('mtg_project', 't', ['none']), { type: 'project', taskId: 't', projectId: 'none' })
  assert.deepEqual(reviewActionFor('mtg_gh', 't'), { type: 'toggleGithub', taskId: 't' })
  assert.deepEqual(reviewActionFor('mtg_taskreject', 't'), { type: 'rejectTask', taskId: 't' })
  assert.deepEqual(reviewActionFor('mtg_page', '2'), { type: 'page', page: 2 })
  assert.equal(reviewActionFor('mtg_unknown', 't'), null)
})

test('parseReviewCustomId handles the project select', () => {
  assert.deepEqual(parseReviewCustomId('mtg_project:j:7'), { kind: 'mtg_project', jobId: 'j', taskId: '7' })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test bot/src/services/meetingReviewUI.test.js bot/src/commands/meetingReview.test.js`
Expected: FAIL — `pageSizeFor` and `reviewActionFor` are not exported.

- [ ] **Step 3: Implement the review UI**

In `bot/src/services/meetingReviewUI.js`:

1. Imports — add `StringSelectMenuBuilder` to the discord.js import list, and below it:

```js
import { meetingTaskScope, meetingTaskModules } from './meetingTaskMap.js'
import { REVIEW_PROJECT_LIMIT } from './meetingTaskProject.js'
import { scopeLabel } from '../utils/taskScope.js'
```

2. After `export const PAGE_SIZE = 2`, add:

```js
// A task that needs a project uses three rows (assignee, project, buttons) and
// the footer one, so two such tasks would pass Discord's five-row limit. A
// rejected one still renders its rows, so it still counts.
export function pageSizeFor(state) {
  return (state?.tasks ?? []).some((t) => t.needsProject) ? 1 : PAGE_SIZE
}
```

3. Replace `initReviewState` with:

```js
// `settle(task)` returns the project rules 1–2 settle on ({ projectId,
// projectName }) or null when the reviewer must be asked. Without it (a caller
// predating project review) nothing is asked.
export function initReviewState(tasks, assignments, settle) {
  const asgByTask = new Map()
  for (const a of assignments ?? []) asgByTask.set(taskKey(a.task_id), a)
  return {
    tasks: (tasks ?? []).map((t) => {
      const settled = typeof settle === 'function' ? settle(t) : undefined
      return {
        taskId: taskKey(t.task_id),
        assigneeRef: asgByTask.get(taskKey(t.task_id))?.assignee_ref ?? null,
        github: false,
        rejected: false,
        needsProject: settled === null,
        projectId: null,
        projectLabel: settled?.projectName ?? null,
      }
    }),
    page: 0,
  }
}
```

4. In `applyReviewAction`'s `switch`, add before `default:`:

```js
      case 'project':
        return { ...t, projectId: action.projectId && action.projectId !== 'none' ? String(action.projectId) : null }
```

5. Replace `taskEmbed` with:

```js
function taskEmbed(task, st, projects) {
  const e = new EmbedBuilder()
  e.setTitle(clip(task.goal_of_task || task.task_id || 'Task', 256))
  const lines = []
  lines.push(`**Scope:** ${scopeLabel(meetingTaskScope(task)) ?? 'none'}`)
  const modules = meetingTaskModules(task)
  if (modules.length) lines.push(`**Modules:** ${modules.join(', ')}`)
  if (st?.needsProject) {
    const picked = projects.find((p) => p.id === st.projectId)
    lines.push(`**Project:** ${picked ? picked.name : 'not set, pick one below'}`)
  } else if (st?.projectLabel) {
    lines.push(`**Project:** ${st.projectLabel}`)
  }
  if (task.code_residence) lines.push(`**Code:** \`${task.code_residence}\``)
  if (st?.assigneeRef) lines.push(`**Assignee:** <@${st.assigneeRef}>`)
  else lines.push('**Assignee:** unassigned')
  const asgQuote = task.quote
  if (asgQuote) lines.push(`> ${clip(asgQuote, 500)}`)
  lines.push(`**GitHub issue:** ${st?.github ? 'yes' : 'no'}`)
  if (st?.rejected) lines.push('⚠️ rejected')
  e.setDescription(clip(lines.join('\n')))
  return e
}
```

6. In `buildReviewMessage`:
   - after `const asgByTask = …`, add `const projects = (job?.dataJson?.reviewProjects ?? []).slice(0, REVIEW_PROJECT_LIMIT)`;
   - replace the three `PAGE_SIZE` uses with a local `const size = pageSizeFor(state)` (declared before `pageCount`): `Math.ceil(allTasks.length / size)`, `page * size`, `start + size`;
   - the fallback `st` object gains `needsProject: false, projectId: null, projectLabel: null`;
   - change `taskEmbed(…, st, roster)` to `taskEmbed(…, st, projects)`;
   - between the assignee-select row push and the `btnRow`, add:

```js
    if (st.needsProject) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`mtg_project:${jobId}:${task.task_id}`)
        .setPlaceholder('Which project?')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          ...projects.map((p) => ({ label: clip(p.name, 100), value: p.id, default: st.projectId === p.id })),
          { label: 'No project', value: 'none' },
        )
      components.push(new ActionRowBuilder().addComponents(menu))
    }
```

`roster` stays in `buildReviewMessage`'s signature (callers pass it) even though `taskEmbed` no longer takes it.

- [ ] **Step 4: Implement the router**

In `bot/src/commands/meetingReview.js`:

1. Add `'mtg_project',` to `KINDS`.
2. Add above `handleComponentAction`:

```js
/** Pure. The review action a component interaction stands for, or null. */
export function reviewActionFor(kind, taskId, values) {
  switch (kind) {
    case 'mtg_assignee': return { type: 'assignee', taskId, ref: values?.[0] ?? null }
    case 'mtg_project': return { type: 'project', taskId, projectId: values?.[0] ?? null }
    case 'mtg_gh': return { type: 'toggleGithub', taskId }
    case 'mtg_taskreject': return { type: 'rejectTask', taskId }
    case 'mtg_page': return { type: 'page', page: Number(taskId) }
    default: return null
  }
}
```

3. In `handleComponentAction`, replace the whole `let action … else { return }` block with:

```js
  const action = reviewActionFor(kind, taskId, interaction.values)
  if (!action) return
```

(String selects with an `mtg_` id are already routed here by `bot/src/handlers/interactions.js` and skip the auto-defer in `bot/src/index.js`; no change needed there.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test bot/src/services/meetingReviewUI.test.js bot/src/commands/meetingReview.test.js`
Expected: all pass, `fail 0` — including the pre-existing `'buildReviewMessage: 3 tasks -> 2 pages, <=5 rows…'` test, which uses no `settle` and so keeps page size 2.

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/meetingReviewUI.js bot/src/services/meetingReviewUI.test.js bot/src/commands/meetingReview.js bot/src/commands/meetingReview.test.js
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "feat(meeting-review): scope and modules lines, and a Which project? select for unclear tasks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Bot — pipeline wiring: review asks, mirror applies the project rules

**Files:**
- Modify: `bot/src/services/meetingPipelineStages.js` (`awaitingReviewStage` ~L203–258, `mirroredStage` ~L284–430)
- Modify: `bot/src/services/meetingTaskMap.js` (the `projectName` line only)
- Test: `bot/src/services/meetingPipelineStages.test.js`, `bot/src/services/meetingTaskMap.test.js`

**Interfaces:**
- Consumes: `loadProjectContext`, `settledProject`, `resolveMeetingTaskProject`, `reviewProjectOptions` (Task 2); `initReviewState(tasks, assignments, settle)` (Task 3).
- Produces: `awaiting_review` stores `dataJson.review` (with `needsProject`/`projectId`/`projectLabel`) and `dataJson.reviewProjects`; `mirrored` creates rows whose `projectId`/`projectName`/`repositoryId` follow `resolveMeetingTaskProject`.

- [ ] **Step 1: Write the failing tests**

In `bot/src/services/meetingTaskMap.test.js`, first test: replace `assert.equal(row.projectName, 'granjur')` with

```js
  // No project resolved: no name either. The name CSAAS heard is not kept
  // (roadmap sub-project 2), so it cannot become a stray project group.
  assert.equal(row.projectName, null)
```

Append to `bot/src/services/meetingPipelineStages.test.js`:

```js
// ---------------------------------------------------------------------------
// Roadmap sub-project 2 (2026-09-29): meeting tasks get their project
// ---------------------------------------------------------------------------

const FW = { id: 'p1', name: 'Framework' }
const HMS = { id: 'p2', name: 'Badar HMS' }

function reviewDb({ meetingProjectId = null, projects = [FW, HMS] } = {}) {
  return {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1', projectId: meetingProjectId }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    meetingRecording: { findMany: async () => [] },
    project: { findMany: async () => projects },
    repository: { findMany: async () => [] },
    projectRepos: { findMany: async () => [] },
  }
}
const twoTaskJob = () => ({
  id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
  dataJson: {
    title: 'Sync',
    tasks: [
      { task_id: 'a', goal_of_task: 'Do A', project: 'Framework' },
      { task_id: 'b', goal_of_task: 'Do B', project: 'Something unheard of' },
    ],
    assignments: [],
    roster: [],
  },
})

test('awaiting_review asks for a project only where the rules settle none, and stores the choices', async () => {
  process.env.MEETING_REPORTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-reports-'))
  const sent = []
  const channel = { id: 'tc1', send: async (p) => { sent.push(p); return { id: 'msg1' } } }
  const client = { channels: { fetch: async () => channel } }
  const csaasClient = { fetchNotes: async () => ({ notes: 'N' }) }
  const out = await stageRunners.awaiting_review({ job: twoTaskJob(), db: reviewDb(), csaasClient, client })
  const [a, b] = out.patch.dataJson.review.tasks
  assert.deepEqual([a.needsProject, a.projectLabel], [false, 'Framework'])
  assert.deepEqual([b.needsProject, b.projectId], [true, null])
  assert.deepEqual(out.patch.dataJson.reviewProjects, [{ id: 'p2', name: 'Badar HMS' }, { id: 'p1', name: 'Framework' }])
  // One task per page while b needs a project: page 1 is a, with no select.
  assert.match(sent[0].embeds[0].data.description, /Page 1\/2/)
})

test("awaiting_review asks nothing when the meeting has a project", async () => {
  process.env.MEETING_REPORTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-reports-'))
  const channel = { id: 'tc1', send: async () => ({ id: 'msg1' }) }
  const out = await stageRunners.awaiting_review({
    job: twoTaskJob(), db: reviewDb({ meetingProjectId: 'p1' }),
    csaasClient: { fetchNotes: async () => ({ notes: 'N' }) }, client: { channels: { fetch: async () => channel } },
  })
  assert.ok(out.patch.dataJson.review.tasks.every((t) => !t.needsProject && t.projectLabel === 'Framework'))
})

function mirrorDb({ meetingProjectId = null } = {}) {
  const created = []
  const db = {
    ...reviewDb({ meetingProjectId }),
    task: { findFirst: async () => null, create: async ({ data }) => { created.push(data); return { id: `db${created.length}` } }, update: async () => ({}) },
    meetingPipelineJob: { update: async () => ({}) },
  }
  return { db, created }
}
const mirrorClient = () => ({ user: { id: 'bot' }, channels: { fetch: async () => ({ id: 'tc1', send: async () => ({ id: 'x' }) }) } })
const mirrorJob = (reviewTasks) => ({ ...twoTaskJob(), dataJson: { ...twoTaskJob().dataJson, review: { tasks: reviewTasks } } })

test("mirrored: the meeting's project wins for every task", async () => {
  const { db, created } = mirrorDb({ meetingProjectId: 'p2' })
  await stageRunners.mirrored({ job: mirrorJob([{ taskId: 'a' }, { taskId: 'b' }]), db, client: mirrorClient(), csaasClient: {} })
  assert.deepEqual(created.map((r) => [r.projectId, r.projectName]), [['p2', 'Badar HMS'], ['p2', 'Badar HMS']])
})

test("mirrored: a named project is matched, and an unclear task takes the reviewer's pick", async () => {
  const { db, created } = mirrorDb()
  await stageRunners.mirrored({
    job: mirrorJob([{ taskId: 'a', needsProject: false, projectId: null }, { taskId: 'b', needsProject: true, projectId: 'p2' }]),
    db, client: mirrorClient(), csaasClient: {},
  })
  assert.deepEqual(created.map((r) => [r.projectId, r.projectName]), [['p1', 'Framework'], ['p2', 'Badar HMS']])
})

test('mirrored: an unclear task left on "No project" (or a legacy review) has no project and no name', async () => {
  const { db, created } = mirrorDb()
  await stageRunners.mirrored({ job: mirrorJob([{ taskId: 'b', needsProject: true, projectId: null }]), db, client: mirrorClient(), csaasClient: {} })
  const legacy = mirrorDb()
  await stageRunners.mirrored({ job: mirrorJob([{ taskId: 'b' }]), db: legacy.db, client: mirrorClient(), csaasClient: {} })
  for (const row of [created[0], legacy.created[0]]) {
    assert.equal(row.projectId, null)
    assert.equal(row.projectName, null)
  }
})
```

Also, in the existing test `"a task CSaaS could not attribute is placed in the MEETING's project section"`, change its `task.create` fake to record the row and assert the project reached the row, not only the channel:

```js
      create: async ({ data }) => { createdRows.push(data); return { id: 'dbtask1', ...data } },
```

with `const createdRows = []` declared at the top of that test, and after the existing asserts:

```js
  assert.equal(createdRows[0].projectId, 'p1', 'the meeting project is now the task row project too')
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test bot/src/services/meetingPipelineStages.test.js bot/src/services/meetingTaskMap.test.js`
Expected: FAIL — `review.tasks[…].needsProject` undefined, `reviewProjects` undefined, rows keep `projectId: null` for the meeting project, mapper still returns `'granjur'`.

- [ ] **Step 3: Implement**

1. `bot/src/services/meetingTaskMap.js`: change `projectName: ctx.projectName || csaasTask.project || null,` to `projectName: ctx.projectName || null,` and replace the comment above `projectId` with:

```js
    // Settled by resolveMeetingTaskProject (meeting project, named project, or
    // the reviewer's pick). No project means no name: the name CSAAS heard is
    // not kept, so it cannot show up on the site as a stray project group.
```

2. `bot/src/services/meetingPipelineStages.js`:
   - Add the import: `import { loadProjectContext, settledProject, resolveMeetingTaskProject, reviewProjectOptions } from './meetingTaskProject.js'`. Remove the `matchProject` import if nothing else in the file uses it (grep first).
   - In `awaitingReviewStage`, replace `const state = initReviewState(tasks, assignments)` with:

```js
  // Settle each task's project now (meeting project, else the project Claude
  // named) so the review can ask only about the unclear ones. The choices are
  // stored so every re-render offers the same list.
  const projectCtx = await loadProjectContext(db, job)
  const state = initReviewState(tasks, assignments, (t) => settledProject(t, projectCtx))
  data.reviewProjects = reviewProjectOptions(projectCtx.projects)
```

   - In `mirroredStage`, delete the `let matchCtx = …` block (with its `try/catch` and comment) and the `let meetingProjectId = …` block (with its comment), and put in their place:

```js
  // Meeting project, else the project CSaaS named, else the reviewer's pick —
  // see meetingTaskProject.js.
  const projectCtx = await loadProjectContext(db, job)
```

   - In the loop, replace `const match = matchProject(csaasTask.project, matchCtx)` and the `mapMeetingTaskToRow(…)` call with:

```js
    const project = resolveMeetingTaskProject(csaasTask, reviewTask, projectCtx)

    const row = mapMeetingTaskToRow(csaasTask, reviewTask, {
      guildConfigId: job.guildConfigId,
      meetingId: job.meetingId,
      discordChannelId,
      botUserId,
      repositoryId: project.repositoryId,
      projectId: project.projectId,
      projectName: project.projectName,
    })
```

   - In the channel block, replace the comment that starts `// Same projects already loaded for the match above` (through `// attribution and channel placement are different claims.`) and the `placementProjectId`/`project` lines with:

```js
      // The channel goes into the section of the project the row settled on
      // (meeting project, named project, or the reviewer's pick).
      const project = row.projectId
        ? projectCtx.projects.find((p) => p.id === row.projectId) ?? null
        : null
```

   Leave everything else in both stages unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test bot/src/services/meetingPipelineStages.test.js bot/src/services/meetingTaskMap.test.js bot/src/services/meetingTaskProject.test.js bot/src/services/meetingReviewUI.test.js`
Expected: all pass, `fail 0` (including every pre-existing pipeline test).

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/meetingPipelineStages.js bot/src/services/meetingPipelineStages.test.js bot/src/services/meetingTaskMap.js bot/src/services/meetingTaskMap.test.js
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "feat(meeting-pipeline): a meeting's tasks get its project; the review asks for unclear ones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Bot — migration 028: old scopes to the four values or Modules

**Files:**
- Create: `bot/src/Database/migrations/028_task_scope_fixed_values.sql`
- Test: `bot/src/Database/migration028.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: after it runs, every `task.scope` is `backend`/`frontend`/`qa`/`design` or `NULL`; former free text is in `task.modules`.

There is no test database and tests must never touch production, so the SQL is verified statically here and by a read-only preview at rollout (see the Rollout section). Do **not** run the migration.

- [ ] **Step 1: Write the failing test**

Create `bot/src/Database/migration028.test.js`:

```js
// Migration 028 is plain SQL and there is no test database (the root .env is
// production), so this pins the statements' guards instead of running them:
// each step must be a no-op on a second run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sql = readFileSync(fileURLToPath(new URL('./migrations/028_task_scope_fixed_values.sql', import.meta.url)), 'utf8')
const statements = sql
  .replace(/--.*$/gm, '')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter(Boolean)
const FIXED = "('backend', 'frontend', 'qa', 'design')"
const MODULES = "IF(JSON_TYPE(modules) = 'ARRAY', modules, JSON_ARRAY())"

test('four UPDATEs on task and nothing else', () => {
  assert.equal(statements.length, 4)
  for (const s of statements) assert.match(s, /^UPDATE task SET /)
  assert.ok(!/\b(DELETE|DROP|ALTER|TRUNCATE|INSERT)\b/i.test(sql.replace(/--.*$/gm, '')))
})

test('1: case variants of the four become lowercase, compared byte-for-byte', () => {
  const s = statements[0]
  assert.ok(s.includes('SET scope = LOWER(TRIM(scope))'), s)
  assert.ok(s.includes(`LOWER(TRIM(scope)) IN ${FIXED}`), s)
  assert.ok(s.includes('CAST(scope AS BINARY) <> CAST(LOWER(TRIM(scope)) AS BINARY)'), s)
})

test('2: a blank scope becomes NULL', () => {
  assert.ok(statements[1].includes('SET scope = NULL'))
  assert.ok(statements[1].includes("scope IS NOT NULL AND TRIM(scope) = ''"))
})

test('3: other text is appended to modules only when not already there', () => {
  const s = statements[2]
  assert.ok(s.includes(`SET modules = JSON_ARRAY_APPEND(${MODULES}, '$', TRIM(scope))`), s)
  assert.ok(s.includes(`LOWER(TRIM(scope)) NOT IN ${FIXED}`), s)
  assert.ok(s.includes(`NOT JSON_CONTAINS(${MODULES}, JSON_QUOTE(TRIM(scope)))`), s)
  assert.ok(s.includes("TRIM(scope) <> ''"), s)
})

test('4: then only non-fixed scopes are cleared (after step 3 copied them)', () => {
  const s = statements[3]
  assert.ok(s.includes('SET scope = NULL'), s)
  assert.ok(s.includes(`LOWER(TRIM(scope)) NOT IN ${FIXED}`), s)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test bot/src/Database/migration028.test.js`
Expected: FAIL — ENOENT, the migration file does not exist.

- [ ] **Step 3: Write the migration**

Create `bot/src/Database/migrations/028_task_scope_fixed_values.sql`:

```sql
-- task.scope holds only backend / frontend / qa / design, or NULL (roadmap
-- sub-project 2, 2026-09-29; spec docs/superpowers/specs/2026-09-29-scope-and-
-- meeting-projects-design.md). Before this, meeting tasks stored CSAAS's free-
-- text feature ("GitSync") as the scope. Nothing is lost: free text moves into
-- modules. Idempotent: afterwards every scope is one of the four or NULL, so
-- a second run matches no rows. The column collation is case-insensitive, so
-- step 1 compares bytes to find case variants. A modules value that is not a
-- JSON array (SQL NULL included) is treated as an empty array.

-- 1. "Backend", " qa " → the lowercase value.
UPDATE task SET scope = LOWER(TRIM(scope))
 WHERE LOWER(TRIM(scope)) IN ('backend', 'frontend', 'qa', 'design')
   AND CAST(scope AS BINARY) <> CAST(LOWER(TRIM(scope)) AS BINARY);

-- 2. A blank scope → NULL.
UPDATE task SET scope = NULL
 WHERE scope IS NOT NULL AND TRIM(scope) = '';

-- 3. Any other text → appended to modules, unless already there.
UPDATE task SET modules = JSON_ARRAY_APPEND(IF(JSON_TYPE(modules) = 'ARRAY', modules, JSON_ARRAY()), '$', TRIM(scope))
 WHERE scope IS NOT NULL
   AND TRIM(scope) <> ''
   AND LOWER(TRIM(scope)) NOT IN ('backend', 'frontend', 'qa', 'design')
   AND NOT JSON_CONTAINS(IF(JSON_TYPE(modules) = 'ARRAY', modules, JSON_ARRAY()), JSON_QUOTE(TRIM(scope)));

-- 4. …and that text is cleared from scope.
UPDATE task SET scope = NULL
 WHERE scope IS NOT NULL
   AND LOWER(TRIM(scope)) NOT IN ('backend', 'frontend', 'qa', 'design');
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test bot/src/Database/migration028.test.js`
Expected: 5 tests pass, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add bot/src/Database/migrations/028_task_scope_fixed_values.sql bot/src/Database/migration028.test.js
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "feat(db): migration 028 — task scope is one of four; free text moves to modules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: CSAAS — Claude picks a scope; only valid scopes are stored

Work in `D:\Work\Granjur Technologies\CSAAS_Backend` on a new branch: `git checkout -b feat/meeting-task-scope main`. Leave the untracked `.bridge/`, `.worktrees/` and `data/migrations_completed/*` files alone.

**Files:**
- Create: `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingTaskScope.js`
- Create: `data/migrations/20260929_2_meeting_tasks_scope.sql`
- Modify: `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js` (`generateTasks` INSERT ~L729–747, `updateTask` ~L853–881, `addTask` ~L888–910, the `MeetingWorkflowTasksUpdate_object` / `MeetingWorkflowTasksAdd_object` field lists ~L1851/L1855)
- Modify: `Services/SysScripts/AIScripts/meetingAgents.js` (`generateMeetingTasks` system prompt ~L222–237)
- Modify: `schema.sql` (the `meeting_tasks` table, after `sub_feature` ~L354)
- Test: `Services/SysScripts/TestScripts/meeting-test/meetingTaskScope.test.js` (jest)

**Interfaces:**
- Produces (from `meetingTaskScope.js`): `MEETING_TASK_SCOPES`, `normalizeMeetingTaskScope(value) → string|null`, `MEETING_TASK_INSERT_SQL`, `meetingTaskInsertParams(meetingId, task) → any[]` (10 values), `meetingTaskUpdateSet(fields) → { setClauses: string[], vals: any[] }`.
- `meeting_tasks.scope VARCHAR(16) NULL` — returned to the bot by the existing `SELECT *`.

- [ ] **Step 1: Write the failing tests**

Create `Services/SysScripts/TestScripts/meeting-test/meetingTaskScope.test.js`:

```js
// Meeting tasks carry one of four scopes or none (Discord bot roadmap
// sub-project 2, 2026-09-29). Offline: Claude is mocked.
jest.mock("../../AIScripts/claudeAgent", () => ({
  runClaudeAgent: jest.fn(async () => ({ tasks: [] })),
  runClaudeAgentHtml: jest.fn(),
}));

const {
  MEETING_TASK_SCOPES,
  normalizeMeetingTaskScope,
  MEETING_TASK_INSERT_SQL,
  meetingTaskInsertParams,
  meetingTaskUpdateSet,
} = require("../../../../Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingTaskScope");
const { runClaudeAgent } = require("../../AIScripts/claudeAgent");
const { generateMeetingTasks } = require("../../AIScripts/meetingAgents");

describe("normalizeMeetingTaskScope", () => {
  test("keeps the four, in any case or padding", () => {
    expect(MEETING_TASK_SCOPES).toEqual(["backend", "frontend", "qa", "design"]);
    expect(normalizeMeetingTaskScope("backend")).toBe("backend");
    expect(normalizeMeetingTaskScope(" Frontend ")).toBe("frontend");
    expect(normalizeMeetingTaskScope("QA")).toBe("qa");
  });
  test("anything else is null", () => {
    for (const v of ["GitSync", "", "   ", null, undefined, 3, "back end"]) {
      expect(normalizeMeetingTaskScope(v)).toBeNull();
    }
  });
});

describe("meetingTaskInsertParams", () => {
  test("has one value per placeholder, scope sixth and normalised", () => {
    const params = meetingTaskInsertParams(7, {
      project: "Framework", platform: "node", feature: "GitSync", sub_feature: "Webhooks",
      scope: "Backend", code_residence: "src/x.js", goal_of_task: "Do it",
      intended_actions: ["a"], suggested_commands: ["npm t"],
    });
    expect((MEETING_TASK_INSERT_SQL.match(/\?/g) || []).length).toBe(params.length);
    expect(MEETING_TASK_INSERT_SQL).toMatch(/sub_feature, scope, code_residence/);
    expect(params).toEqual([7, "Framework", "node", "GitSync", "Webhooks", "backend", "src/x.js", "Do it", '["a"]', '["npm t"]']);
  });
  test("free text and missing fields become null", () => {
    const params = meetingTaskInsertParams(7, { scope: "GitSync", goal_of_task: "g" });
    expect(params[5]).toBeNull();
    expect(params.slice(1, 5)).toEqual([null, null, null, null]);
    expect(params.slice(8)).toEqual(["[]", "[]"]);
  });
});

describe("meetingTaskUpdateSet", () => {
  test("only fields that were sent, in column order, scope normalised", () => {
    expect(meetingTaskUpdateSet({ goal_of_task: "g", scope: "Design", feature: undefined }))
      .toEqual({ setClauses: ["scope = ?", "goal_of_task = ?"], vals: ["design", "g"] });
  });
  test("an invalid or empty scope clears it; no scope sent leaves it alone", () => {
    expect(meetingTaskUpdateSet({ scope: "GitSync" })).toEqual({ setClauses: ["scope = ?"], vals: [null] });
    expect(meetingTaskUpdateSet({ scope: "" })).toEqual({ setClauses: ["scope = ?"], vals: [null] });
    expect(meetingTaskUpdateSet({ status: "done" })).toEqual({ setClauses: ["status = ?"], vals: ["done"] });
  });
  test("ignores keys outside the editable columns", () => {
    expect(meetingTaskUpdateSet({ task_id: 1, meeting_id: 2, "x = 1; --": "y" })).toEqual({ setClauses: [], vals: [] });
  });
});

describe("generateMeetingTasks prompt", () => {
  test("asks Claude for exactly one of the four scopes", async () => {
    await generateMeetingTasks({}, "transcript");
    const { system } = runClaudeAgent.mock.calls[0][0];
    expect(system).toContain('"scope": "backend|frontend|qa|design"');
    expect(system).toMatch(/SCOPE RULE/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest Services/SysScripts/TestScripts/meeting-test/meetingTaskScope.test.js`
Expected: FAIL — cannot find module `meetingTaskScope`.

- [ ] **Step 3: Implement the helper**

Create `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingTaskScope.js`:

```js
// A meeting task's scope is one of four values or NULL (Discord bot roadmap
// sub-project 2, 2026-09-29; spec in the bot repo, docs/superpowers/specs/
// 2026-09-29-scope-and-meeting-projects-design.md). Anything else Claude or a
// client sends is stored as NULL; the bot then falls back to the task's platform.
const MEETING_TASK_SCOPES = ["backend", "frontend", "qa", "design"];

function normalizeMeetingTaskScope(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MEETING_TASK_SCOPES.includes(v) ? v : null;
}

// Shared by generateTasks and addTask, so both write the same columns.
const MEETING_TASK_INSERT_SQL = `INSERT INTO meeting_tasks
   (meeting_id, project, platform, feature, sub_feature, scope, code_residence,
    goal_of_task, intended_actions_json, suggested_commands_json, status)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`;

function meetingTaskInsertParams(meetingId, task) {
  return [
    meetingId,
    task.project || null,
    task.platform || null,
    task.feature || null,
    task.sub_feature || null,
    normalizeMeetingTaskScope(task.scope),
    task.code_residence || null,
    task.goal_of_task || null,
    JSON.stringify(task.intended_actions || []),
    JSON.stringify(task.suggested_commands || []),
  ];
}

// The columns updateTask may set. Only keys present (not undefined) are set;
// scope is normalised, so free text clears it rather than being stored.
const UPDATABLE = ["project", "platform", "feature", "sub_feature", "scope", "code_residence", "goal_of_task", "status"];

function meetingTaskUpdateSet(fields) {
  const setClauses = [];
  const vals = [];
  for (const key of UPDATABLE) {
    if (fields?.[key] === undefined) continue;
    setClauses.push(`${key} = ?`);
    vals.push(key === "scope" ? normalizeMeetingTaskScope(fields[key]) : fields[key]);
  }
  return { setClauses, vals };
}

module.exports = {
  MEETING_TASK_SCOPES,
  normalizeMeetingTaskScope,
  MEETING_TASK_INSERT_SQL,
  meetingTaskInsertParams,
  meetingTaskUpdateSet,
};
```

The SET order follows `UPDATABLE`, not the caller's key order — the tests pin that.

- [ ] **Step 4: Wire it into meetingWorkflow.js and the prompt**

1. `meetingWorkflow.js` — add near the other requires:

```js
const { MEETING_TASK_INSERT_SQL, meetingTaskInsertParams, meetingTaskUpdateSet } = require("./meetingTaskScope");
```

2. In `generateTasks`, replace the `for (const task of tasks) { await executeQuery(\`INSERT INTO meeting_tasks …\`, [ … ]); }` loop with:

```js
  for (const task of tasks) {
    await executeQuery(MEETING_TASK_INSERT_SQL, meetingTaskInsertParams(meeting_id, task));
  }
```

3. In `updateTask`, add `scope` to the destructuring, and replace from `const allowed = …` through the `for` loop with:

```js
  const { setClauses, vals } = meetingTaskUpdateSet({ project, platform, feature, sub_feature, scope, code_residence, goal_of_task, status });
```

(keep the following `if (!setClauses.length) throw …`, `vals.push(task_id)` and the rest as they are).

4. In `addTask`, add `scope` to the destructuring and replace the `INSERT` call with:

```js
  const result = await executeQuery(
    MEETING_TASK_INSERT_SQL,
    meetingTaskInsertParams(meeting_id, { project, platform, feature, sub_feature, scope, code_residence, goal_of_task, intended_actions, suggested_commands })
  );
```

5. Add `"scope"` to the field lists: in `MeetingWorkflowTasksUpdate_object`'s `step(updateTask, [...])` after `"sub_feature"`, and in `MeetingWorkflowTasksAdd_object`'s `step(addTask, [...])` after `"sub_feature"`.

6. `Services/SysScripts/AIScripts/meetingAgents.js`, `generateMeetingTasks` system prompt: after the line `      "sub_feature": "sub-feature or component name",` add

```
      "scope": "backend|frontend|qa|design",
```

and immediately before the line `TASK CONSOLIDATION RULES (apply before you emit anything):` add:

```
SCOPE RULE: set "scope" to exactly one of backend, frontend, qa, design — where the work is done. Server, API, database, scripts and infrastructure are backend; web or mobile screens and client code are frontend; tests and test plans are qa; visual and UX design work is design. Never invent another value; "feature" and "sub_feature" carry the feature names.

```

7. `data/migrations/20260929_2_meeting_tasks_scope.sql`:

```sql
-- meeting_tasks.scope: one of backend / frontend / qa / design, or NULL.
--
-- The Discord bot used to store Claude's free-text `feature` as a task's scope.
-- Claude now picks a fixed scope in generateMeetingTasks, and every writer
-- (generateTasks, addTask, updateTask) stores it through
-- normalizeMeetingTaskScope in MeetingWorkflow/meetingTaskScope.js, so nothing
-- else ever lands here. Spec: Discord bot repo, docs/superpowers/specs/
-- 2026-09-29-scope-and-meeting-projects-design.md.
--
-- Run once, BEFORE deploying the code that writes the column (the INSERT names
-- it). Existing rows keep NULL; the bot falls back to the task's platform.

ALTER TABLE `meeting_tasks`
  ADD COLUMN `scope` VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL
  COMMENT 'backend|frontend|qa|design, or NULL'
  AFTER `sub_feature`;
```

8. `schema.sql`: in the `meeting_tasks` table, add after the `sub_feature` line a line in the same style:

```sql
  `scope` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL COMMENT 'backend|frontend|qa|design, or NULL',
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest Services/SysScripts/TestScripts/meeting-test/meetingTaskScope.test.js`
Expected: all pass (`Tests: … passed`, 0 failed).

Then confirm the module still parses: `node -e "require('./Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingTaskScope'); require('./Services/SysScripts/AIScripts/meetingAgents')"` → no output, exit 0. And `node --check Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js` → exit 0. (Do not `require` meetingWorkflow.js outside jest: it constructs an OpenAI client and needs env.)

Then the discord-tasks regression scripts, each with `node`: `for f in Services/SysScripts/TestScripts/discord-tasks-test/*.test.js; do node "$f" || echo "FAILED $f"; done` → no `FAILED` line.

- [ ] **Step 6: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingTaskScope.js Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js Services/SysScripts/AIScripts/meetingAgents.js data/migrations/20260929_2_meeting_tasks_scope.sql schema.sql Services/SysScripts/TestScripts/meeting-test/meetingTaskScope.test.js
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "feat(meeting-tasks): Claude picks a fixed scope; only backend/frontend/qa/design are stored

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Site — Scope filter on Tasks and Board

Work in the worktree `D:\Work\Granjur Technologies\UBS-Doc-scope-filter` (branch `feat/scope-filter`; see Workspaces).

**Files:**
- Modify: `src/screens/tasksLogic.ts`
- Modify: `src/screens/team/TeamLayout.tsx`
- Modify: `src/screens/team/People.tsx` (~L30)
- Test: `src/screens/tasksLogic.test.ts`

**Interfaces:**
- Produces (from `src/screens/tasksLogic.ts`): `type ScopeFilter = 'all'|'backend'|'frontend'|'qa'|'design'|'none'`, `SCOPE_FILTERS: { value: ScopeFilter; label: string }[]`, `Filters.scope`, `DEFAULT_FILTERS.scope = 'all'`, `fixedScope(scope) → 'backend'|'frontend'|'qa'|'design'|null`, `parseScopeFilter(v) → ScopeFilter`, `scopeAppliesOn(tab: string) → boolean`, `peopleCorpusFilters(f: Filters) → Filters`.

- [ ] **Step 1: Write the failing tests**

In `src/screens/tasksLogic.test.ts`, add `fixedScope, parseScopeFilter, scopeAppliesOn, peopleCorpusFilters, SCOPE_FILTERS` to the import list, and append:

```ts
describe('scope filter', () => {
  const withScope = (id: string, scope: string | null) => ({ ...t(id, 'open', []), scope })
  const scoped: ProjectGroup[] = [
    { id: 'p1', name: 'Framework', docsSlug: 'framework', members: [], counts: { open: 5, in_progress: 0, pending: 0, done: 0, blocked: 0 },
      tasks: [withScope('BE', 'backend'), withScope('FE', 'Frontend'), withScope('LEG', 'GitSync'), withScope('NUL', null), withScope('BL', '  ')] },
  ]
  const ids = (f: Partial<typeof DEFAULT_FILTERS>) => applyFilters(scoped, { ...DEFAULT_FILTERS, ...f }).flatMap((p) => p.tasks.map((x) => x.id))

  it('all keeps everything', () => {
    expect(DEFAULT_FILTERS.scope).toBe('all')
    expect(ids({})).toEqual(['BE', 'FE', 'LEG', 'NUL', 'BL'])
  })
  it('a named scope matches case-insensitively', () => {
    expect(ids({ scope: 'backend' })).toEqual(['BE'])
    expect(ids({ scope: 'frontend' })).toEqual(['FE'])
    expect(ids({ scope: 'qa' })).toEqual([])
  })
  it('"none" catches unset, blank and pre-2026-09-29 free text', () => {
    expect(ids({ scope: 'none' })).toEqual(['LEG', 'NUL', 'BL'])
  })
  it('fixedScope reads only the four', () => {
    expect(fixedScope(' QA ')).toBe('qa')
    expect(fixedScope('GitSync')).toBeNull()
    expect(fixedScope(null)).toBeNull()
  })
  it('parseScopeFilter reads ?scope= and treats anything unknown as all', () => {
    expect(SCOPE_FILTERS.map((o) => o.value)).toEqual(['all', 'backend', 'frontend', 'qa', 'design', 'none'])
    expect(SCOPE_FILTERS.map((o) => o.label)).toEqual(['All scopes', 'Backend', 'Frontend', 'QA', 'Design', 'No scope'])
    expect(parseScopeFilter('design')).toBe('design')
    expect(parseScopeFilter('none')).toBe('none')
    expect(parseScopeFilter('Design')).toBe('all')
    expect(parseScopeFilter('gitsync')).toBe('all')
    expect(parseScopeFilter(null)).toBe('all')
  })
  it('applies only on the Tasks and Board tabs', () => {
    expect(scopeAppliesOn('tasks')).toBe(true)
    expect(scopeAppliesOn('board')).toBe(true)
    for (const tab of ['people', 'time', 'stats']) expect(scopeAppliesOn(tab)).toBe(false)
  })
  it('the People corpus ignores scope with the other member-side filters', () => {
    const f = peopleCorpusFilters({ ...DEFAULT_FILTERS, scope: 'qa', status: 'done', assigneeId: 'u1', blockedOnly: true, query: 'x', projectSlug: 'framework' })
    expect(f).toEqual({ ...DEFAULT_FILTERS, projectSlug: 'framework' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/screens/tasksLogic.test.ts`
Expected: FAIL — `fixedScope`/`parseScopeFilter`/… are not exported.

- [ ] **Step 3: Implement the logic**

In `src/screens/tasksLogic.ts`:

1. Replace the `Filters` interface and `DEFAULT_FILTERS` with:

```ts
// A task's discipline, as a filter. 'none' is a task with no fixed scope:
// unset, blank, or free text from before 2026-09-29.
export type ScopeFilter = 'all' | 'backend' | 'frontend' | 'qa' | 'design' | 'none'
export const SCOPE_FILTERS: { value: ScopeFilter; label: string }[] = [
  { value: 'all', label: 'All scopes' },
  { value: 'backend', label: 'Backend' },
  { value: 'frontend', label: 'Frontend' },
  { value: 'qa', label: 'QA' },
  { value: 'design', label: 'Design' },
  { value: 'none', label: 'No scope' },
]
export interface Filters { status: StatusFilter; projectSlug: string | null; assigneeId: string | null; blockedOnly: boolean; query: string; scope: ScopeFilter }
export const DEFAULT_FILTERS: Filters = { status: 'all', projectSlug: null, assigneeId: null, blockedOnly: false, query: '', scope: 'all' }

// `?scope=` from the address bar; anything unknown (a typo, an old link) is 'all'.
export const parseScopeFilter = (v: string | null | undefined): ScopeFilter =>
  SCOPE_FILTERS.find((o) => o.value === v)?.value ?? 'all'

// The Scope control shows on these tabs only, so the filter applies only there.
export const scopeAppliesOn = (tab: string): boolean => tab === 'tasks' || tab === 'board'

// People counts open work per member: only the project narrows the tasks it
// counts; the member-side filters (and scope, which has no control there) do not.
export const peopleCorpusFilters = (f: Filters): Filters =>
  ({ ...f, status: 'all', assigneeId: null, blockedOnly: false, query: '', scope: 'all' })
```

2. In `applyFilters`'s task predicate, add after the `blockedOnly` line:

```ts
        if (f.scope !== 'all' && (fixedScope(t.scope) ?? 'none') !== f.scope) return false
```

3. Below `scopeLabel` (after `isFixedScope`), add:

```ts
// The fixed scope a task carries, or null (unset, blank, or legacy free text).
export const fixedScope = (scope: string | null | undefined): 'backend' | 'frontend' | 'qa' | 'design' | null => {
  const s = (scope ?? '').trim().toLowerCase()
  return isFixedScope(s) ? (s as 'backend' | 'frontend' | 'qa' | 'design') : null
}
```

- [ ] **Step 4: Wire the screens**

1. `src/screens/team/People.tsx`: import `peopleCorpusFilters` from `'../tasksLogic'` and replace
`applyFilters(projects, { ...filters, status: 'all', assigneeId: null, blockedOnly: false, query: '' })` with `applyFilters(projects, peopleCorpusFilters(filters))`.

2. `src/screens/team/TeamLayout.tsx`:
   - import `SCOPE_FILTERS`, `parseScopeFilter`, `scopeAppliesOn` from `'../tasksLogic'` (alongside the existing imports from there);
   - initial state: `useState<Filters>({ ...DEFAULT_FILTERS, projectSlug: params.get('project'), scope: parseScopeFilter(params.get('scope')) })`;
   - replace `setFilter`'s comment and URL block with:

```ts
  // The project and scope filters are mirrored into the URL (`?project=`,
  // `?scope=`): Projects.tsx deep-links into the first, and both survive the
  // hop between tabs and can be shared.
  const setFilter = useCallback((patch: Partial<Filters>) => {
    const next = { ...filters, ...patch }
    setFilters(next)
    if ('projectSlug' in patch || 'scope' in patch) {
      const p = new URLSearchParams(params)
      if (next.projectSlug) p.set('project', next.projectSlug); else p.delete('project')
      if (next.scope !== 'all') p.set('scope', next.scope); else p.delete('scope')
      setParams(p, { replace: true })
    }
  }, [filters, params, setParams])
```

   - move `const tab = activeTab(pathname)` up so it is declared before `visible`, and change `visible` to:

```ts
  // The header counts follow what is filterable on this tab: scope has no
  // control on People, Time or Stats, so it does not narrow them.
  const visible = useMemo(
    () => applyFilters(projects, scopeAppliesOn(tab) ? filters : { ...filters, scope: 'all' }),
    [projects, filters, tab],
  )
```

   - in the filter bar, after the Project `FilterSelect`, add:

```tsx
              {scopeAppliesOn(tab) && (
                <FilterSelect label="Scope" theme={theme} value={filters.scope} onChange={(v) => setFilter({ scope: parseScopeFilter(v) })}>
                  {SCOPE_FILTERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </FilterSelect>
              )}
```

   Board (`applyFilters(projects, { ...filters, status: 'all' })`) and TasksList (`applyFilters(projects, filters)`) pick the scope up with no change. Stats builds from `DEFAULT_FILTERS` and is unaffected.

- [ ] **Step 5: Run the tests, the type check and the build**

Run: `npx vitest run` → all pass (340 at `a594551`, so 347 expected), 0 failed.
Run: `npx tsc --noEmit` (or the repo's `typecheck` script if `package.json` has one) → no errors.
Run: `npm run build` → succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/screens/tasksLogic.ts src/screens/tasksLogic.test.ts src/screens/team/TeamLayout.tsx src/screens/team/People.tsx
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "feat(team): Scope filter on Tasks and Board, kept in ?scope=

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Bot — full suite, knowledge and state

**Files:**
- Modify: `.claude/knowledge/csaas-meeting-workflow-integration.md`, `.claude/knowledge/project-tasks-site.md`, `.claude/knowledge/README.md` (only if a new file is added)
- Modify: `.claude/state/backlog.md`, `.claude/state/completed.md`, `.claude/state/session.md`

- [ ] **Step 1: Run the full bot suite**

Run from the bot repo root: `npm test 2>&1 | tail -15`
Expected: the summary shows `fail 0`. Read the `# fail` line — do not trust the exit code of a piped command.

- [ ] **Step 2: Update knowledge**

- `csaas-meeting-workflow-integration.md`: in the part describing how CSAAS tasks become bot tasks, document: CSAAS `meeting_tasks.scope` (four values or NULL, `normalizeMeetingTaskScope`); bot `meetingTaskScope` (Claude → platform → none) and `meetingTaskModules` (feature, sub_feature); the three project rules and `meetingTaskProject.js`; the review's `mtg_project` select, `dataJson.reviewProjects`, the state fields `needsProject`/`projectId`/`projectLabel`, and `pageSizeFor`; that a task with no project has `projectName` NULL.
- `project-tasks-site.md`: the Scope filter (`?scope=`, Tasks and Board only, `none` includes legacy free text).

- [ ] **Step 3: Update state**

- `backlog.md`: mark roadmap sub-project 2 "built, not deployed", with the rollout below as its checklist; keep sub-projects 3–7 as they are.
- `completed.md`: add at the top a `2026-09-29` entry — one-line summary plus the commit hashes per repo (`git log --oneline main..HEAD` in each).
- `session.md`: outcome and open items (rollout; the Admin-role question).

- [ ] **Step 4: Commit**

```bash
git add .claude/knowledge .claude/state
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "docs: scope and meeting-project knowledge and state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Rollout (preview runs BEFORE the bot branch is merged; each step needs the owner's go-ahead)

Merging the bot branch to `main` deploys it, and the deploy workflow runs `npm run
db:migrate` — so the preview below must run against production, and be clean, before
that merge happens, not "after merge" as a later step.

1. **Preview migration 028 (read-only, owner's go-ahead, credentials only from env vars), BEFORE merging the bot branch:**

```sql
SELECT
  SUM(LOWER(TRIM(scope)) IN ('backend','frontend','qa','design')
      AND CAST(scope AS BINARY) <> CAST(LOWER(TRIM(scope)) AS BINARY)) AS case_fixed,
  SUM(scope IS NOT NULL AND TRIM(scope) = '')                         AS blank_to_null,
  SUM(scope IS NOT NULL AND TRIM(scope) <> ''
      AND LOWER(TRIM(scope)) NOT IN ('backend','frontend','qa','design')) AS moved_to_modules,
  SUM(modules IS NOT NULL AND JSON_TYPE(modules) <> 'ARRAY')          AS non_array_modules,
  SUM(scope REGEXP '[\t\r\n]')                                        AS has_ctrl_ws,
  SUM(scope IS NOT NULL AND (CAST(scope AS BINARY) <> CAST(LOWER(TRIM(scope)) AS BINARY)
      OR LOWER(TRIM(scope)) NOT IN ('backend','frontend','qa','design'))) AS rows_touched
FROM task;
```

   `non_array_modules` must be 0; if not, stop and show the owner those rows (step 3 would
   replace them with an array). `has_ctrl_ws` counts a scope with a tab/newline — MySQL's
   `TRIM()` strips only spaces, so such a value would fail both the blank-check and the
   fixed-value match and get moved into `modules` rather than normalise; show those rows to
   the owner if non-zero (not itself a reason to stop). `rows_touched` is the total number of
   rows migration 028 will rewrite.
2. **Bot** merges to `main` and deploys (runs migration 028 on start/deploy per its usual path).
3. **CSAAS:** run `data/migrations/20260929_2_meeting_tasks_scope.sql` first, then deploy the code (manual; the INSERT names the new column).
4. **Site** deploys via Vercel on push.
5. **Post-deploy check**, after the bot deploy finishes:

```sql
SELECT COUNT(*) FROM task WHERE scope IS NOT NULL AND scope NOT IN ('backend','frontend','qa','design');
```

   Must be 0 — this catches a meeting mirrored by the old process in the window between
   `db:migrate` running and the bot process actually restarting. If it is non-zero,
   re-running 028's four statements by hand is safe (idempotent).

Each order works with the others' old versions: the new bot with the old CSAAS falls back to the platform; the old bot ignores the new column; the site filter works on whatever scopes exist.

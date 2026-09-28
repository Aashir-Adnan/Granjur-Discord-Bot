# Create and Edit Tasks from UBS-Doc — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in UBS-Doc user holding `update_discord_tasks` can create a Feature or Bug and edit every field Discord's `/update-task` can edit, with Discord showing exactly what it shows for a Discord-made change.

**Architecture:** Every site write takes the existing three hops — site → CSAAS (`accessToken` + `update_discord_tasks`) → bot loopback route (`x-internal-secret`) → the same bot services Discord uses. The bot gains a pure rule module (`utils/taskEditRules.js`), an interaction-free edit core (`services/taskEdit.js`, extracted from `runUpdate`) and a creation service (`services/taskCreate.js`, extracted from `/create-task`'s `handleCreate`), plus three internal routes. CSAAS gains one shared bot-call helper and three thin write objects; its tasks read adds `repositories` and member `kind`. The site gains an edit form on the task page, a create page, an "Add subtask" control and a Discord member picker.

**Tech Stack:** Bot — Node ESM, discord.js v14, `node:test`. CSAAS — Node CommonJS, UBS framework API objects, plain `node` assertion scripts. Site — React 18 + TypeScript, react-router v6, Tailwind + `design.css`, vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-site-task-create-edit-design.md` (bot repo). Read it before starting any task.

## Repos and branches

| Repo | Path | Branch |
|---|---|---|
| bot | `D:\Work\Granjur Technologies\Granjur-Discord-Bot` | `feat/site-task-edit` (exists; the spec is on it) |
| CSAAS | `D:\Work\Granjur Technologies\CSAAS_Backend` | `feat/site-task-edit` (create from `main`) |
| site | `D:\Work\Granjur Technologies\UBS-Doc` | `feat/site-task-edit` in a **git worktree** (see below) |

**The site's `main` checkout has someone else's uncommitted work** (`src/components/meetingWorkflow/LiveTranscribeStage.jsx`, `src/styles/portal-compat.css`, untracked `audioCapture.js` and `.bridge/`). Never touch, stash, commit or revert those. Do all site work in a worktree:
`git -C "D:/Work/Granjur Technologies/UBS-Doc" worktree add ../UBS-Doc-site-task-edit -b feat/site-task-edit main`
and run `npm ci` in the worktree once (`node_modules` is not shared between worktrees). Do not edit `src/styles/portal-compat.css` at all (it is dirty in the main checkout); style with Tailwind utilities and the existing `design.css` classes.

Every commit in every repo: author `Nauraiz Haider <bsse23047@itu.edu.pk>` (use `git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit …`) and end the message with the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Global Constraints

- **Bot tests never touch production.** The bot repo's root `.env` points at the production database. Every bot test command runs with `DATABASE_URL=poisoned://no-production-access` set, and every function under test that queries the database takes a `db` seam that the test fills with a fake — including a first "red" run (`.claude/rules/tests-never-touch-production.md`).
- **Bot leaf rule:** files under `bot/src/utils/` import nothing that reaches `db` or `services/projectSection.js`. `utils/taskEditRules.js` imports only other `utils/` files.
- **Gate on `fail 0`.** A test summary piped through grep exits 0 even when red; read the `# fail` line and require it to be `0` before committing. Full bot suite: from the bot repo root, `DATABASE_URL=poisoned://no-production-access npm test`.
- **CSAAS tests** are standalone scripts: `node Services/SysScripts/TestScripts/discord-tasks-test/<file>.test.js` must print `<file>.test.js: all assertions passed` and exit 0. Nothing opens a DB connection or socket — every handler takes `__setTestHooks`.
- **Site tests:** in the worktree, `npx vitest run <path>`; full `npm test`; `npx tsc --noEmit -p .` must stay clean (if the repo has no root `tsconfig.json` with `noEmit`, use `npm run build` instead).
- Permission for every new endpoint: `update_discord_tasks`, checked in the CSAAS handler with `requirePortalPermission` (object `permission: null`, `accessToken: true`, `bindActorToToken: true`), exactly like `DiscordTasksStatus_object`.
- No new env values. The existing `BOT_INTERNAL_SECRET` (bot) / `DISCORD_BOT_SECRET` + `DISCORD_BOT_URL` (CSAAS) cover the new routes.
- Values (from the spec): statuses `open, pending, in_progress, resolved, closed, done`; scopes `backend, frontend, qa, design` or none; implementation `not_started, in_progress, done`; title 1–200 chars; description ≤2000 (empty → null); test counts integers 0–127; estimate parsed by the bot's `parseDuration` (empty → null, must be a safe integer ≤ 2147483647); ≤50 holders, ≤50 blockers, ≤20 repositories, ≤20 modules (each ≤100 chars); a bug names at most one repository; a site-created task must have a project.
- Holders are written to `assigneeIds` for every task type (as `/update-task` does) and compared against `holdersOf(task)`.
- A site actor is never `@mentioned`: the email-matched Discord id travels as `activityId`, never as `discordId`; the label is `<name-or-email> (via the site)`.

## Review Focus

1. **A form saved without touching a field** (e.g. a description that is `null` in the DB and `''` in the form, or an estimate `120` shown as `2h`) must send nothing and write nothing — no activity row, no channel post. Pinned by `diffChanges` tests (Task 8) and the bot's "unchanged values are dropped" tests (Task 1) and the route's `unchanged: true` test (Task 4).
2. **A blocker list with one bad entry** must leave every other blocker and every field untouched — validation happens before any write. Pinned in Task 4 ("a refused blocker writes nothing").
3. **Clearing every assignee on a bug that was created with tagged members** must not make the tagged members reappear. Pinned in Task 1.
4. **A site user whose portal email matches no Discord member** can still create, edit and add subtasks; `createdBy` is null, the channel embed names them by label, and nothing crashes on the missing id. Pinned in Tasks 3 and 4.
5. **The bot being offline or misconfigured** surfaces on the site as a sentence ("Discord bot is offline, try again." / "Discord bot link is misconfigured. Tell an admin."), and the form keeps what the user typed. Pinned in Task 8 (`saveErrorText`) and Task 5 (mapping).

---

## Bot (Tasks 1–4) — repo `Granjur-Discord-Bot`, branch `feat/site-task-edit`

### Task 1: The rule module `utils/taskEditRules.js`

**Files:**
- Create: `bot/src/utils/taskEditRules.js`
- Create: `bot/src/utils/taskEditRules.test.js`
- Modify: `bot/src/services/taskHub.js:39-41` (take `MAX_TEST_COUNT` and `ESTIMATE_TOO_LARGE` from the new module instead of defining them)

**Interfaces:**
- Consumes: `TASK_STATUSES`, `wouldCycle` (`utils/taskDeps.js`); `SCOPE_VALUES` (`utils/taskScope.js`); `parseDuration`, `MAX_STORABLE_MINUTES`, `BAD_DURATION` (`utils/timeTracking.js`); `holdersOf`, `idList` (`utils/taskLabel.js`). All four are import-free leaves.
- Produces:
  - `validateEdit(task, changes, ctx) → { error: string|null, updates: object, blockers: { add: string[], remove: string[] } }` where `ctx = { projectsById: Map<id,{id,name}>, memberIds: Set<string>, tasksById: Map<id,{id,title}>, deps: {taskId, blockedByTaskId}[] }`. `updates` uses DB column names (`status, title, description, scope, implementationStatus, projectId, projectName, assigneeIds, taggedMemberIds, passedApiTests, passedQaTests, passedAcceptanceCriteria, estimateMinutes`) and contains only values that differ from `task`.
  - `validateCreate(input, ctx) → { error: string|null, fields: { type, title, description, scope, modules, holderIds, repositoryIds, tracks: { apiTests, qaTests, acceptanceCriteria } } | null }` where `ctx = { project: row|null, memberIds: Set<string>, reposById: Map<id,row> }`.
  - Constants: `MAX_TEST_COUNT = 127`, `ESTIMATE_TOO_LARGE`, `EDIT_KEYS`, `IMPLEMENTATION_STATUSES`, `TASK_TYPES`, `MAX_IDS = 50`.

- [ ] **Step 1: Write the failing tests** — `bot/src/utils/taskEditRules.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateEdit, validateCreate, MAX_TEST_COUNT, EDIT_KEYS } from './taskEditRules.js'
import { BAD_DURATION } from './timeTracking.js'

const task = {
  id: 'T', guildConfigId: 'g1', type: 'feature', title: 'Git Sync', description: null, status: 'open',
  scope: 'backend', implementationStatus: 'not_started', projectId: 'P1', projectName: 'Framework',
  assigneeIds: ['u1'], taggedMemberIds: [], passedApiTests: null, passedQaTests: 0, passedAcceptanceCriteria: null,
  estimateMinutes: 120,
}
const ctx = {
  projectsById: new Map([['P1', { id: 'P1', name: 'Framework' }], ['P2', { id: 'P2', name: 'Badar HMS' }]]),
  memberIds: new Set(['u1', 'u2', 'u3']),
  tasksById: new Map([['B', { id: 'B', title: 'Blocker' }], ['C', { id: 'C', title: 'Chain' }]]),
  deps: [],
}
const edit = (changes, t = task, c = ctx) => validateEdit(t, changes, c)

test('the edit keys are exactly the spec fields', () => {
  assert.deepEqual(EDIT_KEYS, ['status', 'title', 'description', 'scope', 'implementationStatus', 'projectId',
    'holderIds', 'passedApiTests', 'passedQaTests', 'passedAcceptanceCriteria', 'estimate', 'blockerIds'])
})
test('a non-object or an unknown key is refused', () => {
  assert.equal(edit(null).error, 'changes must be an object.')
  assert.equal(edit(['status']).error, 'changes must be an object.')
  assert.equal(edit({ priority: 'high' }).error, 'priority cannot be changed.')
})
test('status: one of the six, unchanged is dropped', () => {
  assert.deepEqual(edit({ status: 'in_progress' }).updates, { status: 'in_progress' })
  assert.match(edit({ status: 'flying' }).error, /^status must be one of open, pending/)
  assert.deepEqual(edit({ status: 'open' }).updates, {})
})
test('title: trimmed, required, at most 200', () => {
  assert.deepEqual(edit({ title: '  New name  ' }).updates, { title: 'New name' })
  assert.equal(edit({ title: '   ' }).error, 'A task needs a title.')
  assert.equal(edit({ title: 42 }).error, 'A task needs a title.')
  assert.equal(edit({ title: 'x'.repeat(201) }).error, 'The title can be at most 200 characters.')
})
test('description: blank is null, null equals null, at most 2000', () => {
  assert.deepEqual(edit({ description: '' }).updates, {}, 'null in the DB and "" from a form are the same')
  assert.deepEqual(edit({ description: ' hi ' }).updates, { description: 'hi' })
  assert.deepEqual(edit({ description: '' }, { ...task, description: 'old' }).updates, { description: null })
  assert.equal(edit({ description: 'x'.repeat(2001) }).error, 'The description can be at most 2000 characters.')
})
test('scope: one of four or empty', () => {
  assert.deepEqual(edit({ scope: null }).updates, { scope: null })
  assert.deepEqual(edit({ scope: '' }).updates, { scope: null })
  assert.deepEqual(edit({ scope: 'qa' }).updates, { scope: 'qa' })
  assert.match(edit({ scope: 'Backend' }).error, /^scope must be one of backend, frontend, qa, design/)
})
test('implementationStatus: one of three', () => {
  assert.deepEqual(edit({ implementationStatus: 'done' }).updates, { implementationStatus: 'done' })
  assert.match(edit({ implementationStatus: 'shipped' }).error, /^implementationStatus must be one of/)
})
test('projectId: a known project writes id and name together; null detaches', () => {
  assert.deepEqual(edit({ projectId: 'P2' }).updates, { projectId: 'P2', projectName: 'Badar HMS' })
  assert.deepEqual(edit({ projectId: null }).updates, { projectId: null, projectName: null })
  assert.deepEqual(edit({ projectId: 'P1' }).updates, {})
  assert.equal(edit({ projectId: 'P9' }).error, 'No project matches that id.')
})
test('holderIds: members only, deduped, order-insensitive, at most 50', () => {
  assert.deepEqual(edit({ holderIds: ['u2', 'u1', 'u2'] }).updates, { assigneeIds: ['u2', 'u1'] })
  assert.deepEqual(edit({ holderIds: ['u1'] }).updates, {})
  assert.equal(edit({ holderIds: ['u9'] }).error, 'u9 is not a member of this Discord server.')
  assert.equal(edit({ holderIds: 'u1' }).error, 'holderIds must be a list of Discord ids.')
  const many = new Set(Array.from({ length: 51 }, (_, i) => `m${i}`))
  assert.equal(edit({ holderIds: [...many] }, task, { ...ctx, memberIds: many }).error, 'A task can have at most 50 people.')
})
test('a bug is compared against its tagged members and clearing it clears them too', () => {
  const bug = { ...task, type: 'bug', assigneeIds: [], taggedMemberIds: ['u1', 'u2'] }
  assert.deepEqual(edit({ holderIds: ['u2', 'u1'] }, bug).updates, {}, 'same people, nothing to write')
  assert.deepEqual(edit({ holderIds: ['u3'] }, bug).updates, { assigneeIds: ['u3'] })
  assert.deepEqual(edit({ holderIds: [] }, bug).updates, { assigneeIds: [], taggedMemberIds: [] },
    'otherwise holdersOf would fall back to the tagged members and they would reappear')
})
test('test counts: whole numbers 0 to 127, unchanged dropped', () => {
  assert.equal(MAX_TEST_COUNT, 127)
  assert.deepEqual(edit({ passedApiTests: 127, passedQaTests: 0 }).updates, { passedApiTests: 127 })
  for (const bad of [128, -1, 1.5, '3', null]) {
    assert.equal(edit({ passedApiTests: bad }).error, 'Test counts must be whole numbers from 0 to 127.')
  }
})
test('estimate: parsed like the hub, blank clears, unchanged dropped', () => {
  assert.deepEqual(edit({ estimate: '8h 30m' }).updates, { estimateMinutes: 510 })
  assert.deepEqual(edit({ estimate: '2h' }).updates, {})
  assert.deepEqual(edit({ estimate: '' }).updates, { estimateMinutes: null })
  assert.deepEqual(edit({ estimate: null }).updates, { estimateMinutes: null })
  assert.equal(edit({ estimate: 'soon' }).error, BAD_DURATION)
  assert.equal(edit({ estimate: '99999999999h' }).error, 'That estimate is too large to store.')
})
test('blockerIds: diffed into adds and removes', () => {
  assert.deepEqual(edit({ blockerIds: ['B'] }).blockers, { add: ['B'], remove: [] })
  const withB = { ...ctx, deps: [{ taskId: 'T', blockedByTaskId: 'B' }] }
  assert.deepEqual(edit({ blockerIds: [] }, task, withB).blockers, { add: [], remove: ['B'] })
  assert.deepEqual(edit({ blockerIds: ['B', 'C'] }, task, withB).blockers, { add: ['C'], remove: [] })
  assert.deepEqual(edit({ blockerIds: ['B'] }, task, withB).blockers, { add: [], remove: [] })
})
test('blockerIds: self, unknown and cycles are refused with nothing to apply', () => {
  assert.equal(edit({ blockerIds: ['T'] }).error, 'A task cannot be blocked by itself.')
  assert.equal(edit({ blockerIds: ['Z'] }).error, 'No task matches Z.')
  const cyc = edit({ blockerIds: ['B'] }, task, { ...ctx, deps: [{ taskId: 'B', blockedByTaskId: 'T' }] })
  assert.equal(cyc.error, 'Blocker already depends on Git Sync, so Git Sync cannot be blocked by Blocker.')
  assert.deepEqual(cyc.blockers, { add: [], remove: [] })
  assert.deepEqual(cyc.updates, {})
})
test('one bad field refuses the whole edit', () => {
  const r = edit({ title: 'Fine', passedQaTests: 500 })
  assert.equal(r.error, 'Test counts must be whole numbers from 0 to 127.')
  assert.deepEqual(r.updates, {})
})

const cctx = {
  project: { id: 'P1', name: 'Framework', guildConfigId: 'g1' },
  memberIds: new Set(['u1', 'u2']),
  reposById: new Map([['R1', { id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }], ['R2', { id: 'R2', name: 'site', url: 'https://github.com/g/site' }]]),
}
const create = (input, c = cctx) => validateCreate(input, c)

test('a valid feature comes back normalised', () => {
  const r = create({ type: 'feature', title: ' Sync ', description: '', scope: 'backend', modules: [' auth ', 'auth', ''],
    holderIds: ['u2'], repositoryIds: ['R1', 'R2'], tracks: { apiTests: true, qaTests: 'yes' } })
  assert.equal(r.error, null)
  assert.deepEqual(r.fields, { type: 'feature', title: 'Sync', description: null, scope: 'backend', modules: ['auth'],
    holderIds: ['u2'], repositoryIds: ['R1', 'R2'], tracks: { apiTests: true, qaTests: false, acceptanceCriteria: false } })
})
test('create refusals', () => {
  assert.equal(create({ type: 'task', title: 'x' }).error, 'type must be feature or bug.')
  assert.equal(create({ type: 'feature', title: '' }).error, 'A task needs a title.')
  assert.equal(create({ type: 'feature', title: 'x' }, { ...cctx, project: null }).error, 'Pick a project for the task.')
  assert.equal(create({ type: 'bug', title: 'x', repositoryIds: ['R1', 'R2'] }).error, 'A bug can name one repository.')
  assert.equal(create({ type: 'bug', title: 'x', modules: ['auth'] }).error, 'Modules are for features only.')
  assert.equal(create({ type: 'feature', title: 'x', repositoryIds: ['R9'] }).error, 'No repository matches R9.')
  assert.equal(create({ type: 'feature', title: 'x', holderIds: ['u9'] }).error, 'u9 is not a member of this Discord server.')
  assert.equal(create({ type: 'feature', title: 'x', modules: ['m'.repeat(101)] }).error, 'A module name can be at most 100 characters.')
})
test('a bug with one repository and no lists is fine', () => {
  const r = create({ type: 'bug', title: 'Crash', repositoryIds: ['R1'] })
  assert.equal(r.error, null)
  assert.deepEqual(r.fields.repositoryIds, ['R1'])
  assert.deepEqual(r.fields.holderIds, [])
  assert.deepEqual(r.fields.modules, [])
})
```

- [ ] **Step 2: Run to verify it fails**

Run (bot repo root): `DATABASE_URL=poisoned://no-production-access node --test bot/src/utils/taskEditRules.test.js`
Expected: FAIL — `Cannot find module …/taskEditRules.js`.

- [ ] **Step 3: Write `bot/src/utils/taskEditRules.js`**

```js
// What a site edit or a site create may change, and the rule each value must
// meet. Pure: no Discord, no database — the bot's internal routes load the
// context (projects, members, tasks, dependency rows) and hand it in, so the
// rules are testable on their own and the routes stay thin.
//
// The rules are Discord's own: the value sets are the ones /update-task and
// /create-task offer as pickers, the limits are the slash options' and the
// task hub's. A site edit must never be able to write something Discord could
// not. Messages are plain text (no Discord markdown): the site shows them as-is.

import { TASK_STATUSES, wouldCycle } from './taskDeps.js'
import { SCOPE_VALUES } from './taskScope.js'
import { BAD_DURATION, MAX_STORABLE_MINUTES, parseDuration } from './timeTracking.js'
import { holdersOf, idList } from './taskLabel.js'

/** passedApiTests / passedQaTests / passedAcceptanceCriteria are signed TINYINT columns. */
export const MAX_TEST_COUNT = 127
export const ESTIMATE_TOO_LARGE = 'That estimate is too large to store.'
export const IMPLEMENTATION_STATUSES = ['not_started', 'in_progress', 'done']
export const TASK_TYPES = ['feature', 'bug']
export const TITLE_MAX = 200
export const DESCRIPTION_MAX = 2000
/** Holders and blockers: more than this in one request is not a real edit. */
export const MAX_IDS = 50
export const MAX_REPOSITORIES = 20
export const MAX_MODULES = 20
export const MODULE_MAX = 100

export const EDIT_KEYS = [
  'status', 'title', 'description', 'scope', 'implementationStatus', 'projectId',
  'holderIds', 'passedApiTests', 'passedQaTests', 'passedAcceptanceCriteria', 'estimate', 'blockerIds',
]
const COUNT_KEYS = ['passedApiTests', 'passedQaTests', 'passedAcceptanceCriteria']

const refuse = (error) => ({ error, updates: {}, blockers: { add: [], remove: [] } })

/** Distinct, trimmed, non-empty strings — or null when `value` is not a list of strings. */
function stringList(value) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return null
  return [...new Set(value.map((v) => v.trim()).filter(Boolean))]
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))

function titleOf(value) {
  if (typeof value !== 'string' || !value.trim()) return ['A task needs a title.']
  const t = value.trim()
  if (t.length > TITLE_MAX) return [`The title can be at most ${TITLE_MAX} characters.`]
  return [null, t]
}

function descriptionOf(value) {
  if (value !== null && value !== undefined && typeof value !== 'string') return ['The description must be text.']
  const d = String(value ?? '').trim()
  if (d.length > DESCRIPTION_MAX) return [`The description can be at most ${DESCRIPTION_MAX} characters.`]
  return [null, d || null]
}

function scopeOf(value) {
  if (value === null || value === undefined || value === '') return [null, null]
  if (!SCOPE_VALUES.includes(value)) return [`scope must be one of ${SCOPE_VALUES.join(', ')}, or empty`]
  return [null, value]
}

function holdersFrom(value, memberIds) {
  const ids = stringList(value)
  if (!ids) return ['holderIds must be a list of Discord ids.']
  if (ids.length > MAX_IDS) return [`A task can have at most ${MAX_IDS} people.`]
  const stranger = ids.find((id) => !memberIds.has(id))
  if (stranger) return [`${stranger} is not a member of this Discord server.`]
  return [null, ids]
}

/**
 * Check a site edit against `task` and turn it into the `updates` object
 * /update-task builds, plus the blocker adds and removes. Everything is checked
 * before anything is returned as writable: any refusal comes back with empty
 * `updates` and no blockers. Values equal to the stored ones are dropped, so a
 * form saved without touching a field writes nothing.
 */
export function validateEdit(task, changes, ctx = {}) {
  const { projectsById = new Map(), memberIds = new Set(), tasksById = new Map(), deps = [] } = ctx
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return refuse('changes must be an object.')
  const unknown = Object.keys(changes).find((k) => !EDIT_KEYS.includes(k))
  if (unknown) return refuse(`${unknown} cannot be changed.`)
  const c = changes
  const updates = {}

  if ('status' in c) {
    if (!TASK_STATUSES.includes(c.status)) return refuse(`status must be one of ${TASK_STATUSES.join(', ')}`)
    if (c.status !== task.status) updates.status = c.status
  }
  if ('title' in c) {
    const [err, t] = titleOf(c.title)
    if (err) return refuse(err)
    if (t !== task.title) updates.title = t
  }
  if ('description' in c) {
    const [err, d] = descriptionOf(c.description)
    if (err) return refuse(err)
    if (d !== (task.description ?? null)) updates.description = d
  }
  if ('scope' in c) {
    const [err, s] = scopeOf(c.scope)
    if (err) return refuse(err)
    if (s !== (task.scope ?? null)) updates.scope = s
  }
  if ('implementationStatus' in c) {
    if (!IMPLEMENTATION_STATUSES.includes(c.implementationStatus)) {
      return refuse(`implementationStatus must be one of ${IMPLEMENTATION_STATUSES.join(', ')}`)
    }
    if (c.implementationStatus !== task.implementationStatus) updates.implementationStatus = c.implementationStatus
  }
  if ('projectId' in c) {
    if (c.projectId === null || c.projectId === '') {
      if (task.projectId) { updates.projectId = null; updates.projectName = null }
    } else {
      const p = projectsById.get(String(c.projectId))
      if (!p) return refuse('No project matches that id.')
      if (p.id !== task.projectId) { updates.projectId = p.id; updates.projectName = p.name }
    }
  }
  if ('holderIds' in c) {
    const [err, ids] = holdersFrom(c.holderIds, memberIds)
    if (err) return refuse(err)
    // Written to assigneeIds for every type, as /update-task and the hub do: the
    // notifier and the activity log read only assigneeIds.
    if (!sameSet(ids, holdersOf(task))) {
      updates.assigneeIds = ids
      // holdersOf falls back to taggedMemberIds when assigneeIds is empty, so an
      // emptied bug would show its old tagged members again.
      if (!ids.length && idList(task.taggedMemberIds).length) updates.taggedMemberIds = []
    }
  }
  for (const key of COUNT_KEYS) {
    if (!(key in c)) continue
    const n = c[key]
    if (!Number.isInteger(n) || n < 0 || n > MAX_TEST_COUNT) {
      return refuse(`Test counts must be whole numbers from 0 to ${MAX_TEST_COUNT}.`)
    }
    if (n !== task[key]) updates[key] = n
  }
  if ('estimate' in c) {
    if (c.estimate !== null && typeof c.estimate !== 'string') return refuse(BAD_DURATION)
    const raw = String(c.estimate ?? '').trim()
    let minutes = null
    if (raw) {
      minutes = parseDuration(raw)
      if (minutes === null) return refuse(BAD_DURATION)
      if (!Number.isSafeInteger(minutes) || minutes > MAX_STORABLE_MINUTES) return refuse(ESTIMATE_TOO_LARGE)
    }
    if (minutes !== (task.estimateMinutes ?? null)) updates.estimateMinutes = minutes
  }

  const blockers = { add: [], remove: [] }
  if ('blockerIds' in c) {
    const ids = stringList(c.blockerIds)
    if (!ids) return refuse('blockerIds must be a list of task ids.')
    if (ids.length > MAX_IDS) return refuse(`A task can have at most ${MAX_IDS} blockers.`)
    if (ids.includes(String(task.id))) return refuse('A task cannot be blocked by itself.')
    const missing = ids.find((id) => !tasksById.has(id))
    if (missing) return refuse(`No task matches ${missing}.`)
    const current = deps.filter((r) => String(r.taskId) === String(task.id)).map((r) => String(r.blockedByTaskId))
    const add = ids.filter((id) => !current.includes(id))
    const remove = current.filter((id) => !ids.includes(id))
    // The graph as it will be once this edit lands: the removed edges gone, and
    // each accepted add in place before the next one is checked.
    const graph = deps.filter((r) => !(String(r.taskId) === String(task.id) && remove.includes(String(r.blockedByTaskId))))
    for (const id of add) {
      if (wouldCycle(task.id, id, graph)) {
        const b = tasksById.get(id)?.title || id
        const t = task.title || task.id
        return refuse(`${b} already depends on ${t}, so ${t} cannot be blocked by ${b}.`)
      }
      graph.push({ taskId: String(task.id), blockedByTaskId: id })
    }
    blockers.add = add
    blockers.remove = remove
  }
  return { error: null, updates, blockers }
}

/**
 * Check a site create. The project is required on the site: it gives the guild
 * and puts the task under a project card. Returns the normalised fields
 * `services/taskCreate.js` takes.
 */
export function validateCreate(input, ctx = {}) {
  const { project = null, memberIds = new Set(), reposById = new Map() } = ctx
  const f = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const bad = (error) => ({ error, fields: null })
  if (!TASK_TYPES.includes(f.type)) return bad('type must be feature or bug.')
  const isBug = f.type === 'bug'
  const [tErr, title] = titleOf(f.title)
  if (tErr) return bad(tErr)
  const [dErr, description] = descriptionOf(f.description)
  if (dErr) return bad(dErr)
  if (!project) return bad('Pick a project for the task.')
  const [sErr, scope] = scopeOf(f.scope)
  if (sErr) return bad(sErr)
  const [hErr, holderIds] = holdersFrom(f.holderIds ?? [], memberIds)
  if (hErr) return bad(hErr)

  const modules = stringList(f.modules ?? [])
  if (!modules) return bad('modules must be a list of names.')
  if (isBug && modules.length) return bad('Modules are for features only.')
  if (modules.length > MAX_MODULES) return bad(`A feature can list at most ${MAX_MODULES} modules.`)
  if (modules.some((m) => m.length > MODULE_MAX)) return bad(`A module name can be at most ${MODULE_MAX} characters.`)

  const repositoryIds = stringList(f.repositoryIds ?? [])
  if (!repositoryIds) return bad('repositoryIds must be a list of repository ids.')
  if (isBug && repositoryIds.length > 1) return bad('A bug can name one repository.')
  if (repositoryIds.length > MAX_REPOSITORIES) return bad(`A task can name at most ${MAX_REPOSITORIES} repositories.`)
  const unknownRepo = repositoryIds.find((id) => !reposById.has(id))
  if (unknownRepo) return bad(`No repository matches ${unknownRepo}.`)

  const t = f.tracks && typeof f.tracks === 'object' ? f.tracks : {}
  return {
    error: null,
    fields: {
      type: f.type, title, description, scope, modules, holderIds, repositoryIds,
      tracks: { apiTests: t.apiTests === true, qaTests: t.qaTests === true, acceptanceCriteria: t.acceptanceCriteria === true },
    },
  }
}
```

- [ ] **Step 4: Point `taskHub.js` at the shared constants.** In `bot/src/services/taskHub.js`, delete the two lines

```js
export const MAX_TEST_COUNT = 127 // the column is a signed TINYINT
```
and
```js
const ESTIMATE_TOO_LARGE = 'That estimate is too large to store.'
```
and add beside the other imports:

```js
import { ESTIMATE_TOO_LARGE, MAX_TEST_COUNT } from '../utils/taskEditRules.js'
```
plus, so every existing importer of `MAX_TEST_COUNT` from `taskHub.js` keeps working:

```js
export { MAX_TEST_COUNT }
```

- [ ] **Step 5: Run the new tests and the hub's**

Run: `DATABASE_URL=poisoned://no-production-access node --test bot/src/utils/taskEditRules.test.js bot/src/services/taskHub.test.js`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add bot/src/utils/taskEditRules.js bot/src/utils/taskEditRules.test.js bot/src/services/taskHub.js
git commit -m "feat(tasks): one pure rule module for site edits and creates

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The interaction-free edit core `services/taskEdit.js`

**Files:**
- Create: `bot/src/services/taskEdit.js`
- Create: `bot/src/services/taskEdit.test.js`
- Modify: `bot/src/commands/update-task.js` — move `applyDependencyChange` (≈L96-128) and `projectMoveNote` (≈L225-236, with its doc comment) into `taskEdit.js`; re-export both; rewrite `runUpdate` (≈L238-271) over `applyEdit`.

**Interfaces:**
- Consumes: `applyTaskUpdate` (`services/taskStatusChange.js`), `notifyTaskUpdate`, `assertCanFinish` (`services/taskHierarchy.js`), `recordTaskActivity`, `TaskRuleError`, `wouldCycle`.
- Produces:
  - `applyEdit({ db, client, guild = null, cfg, task, updates = {}, blockers = { add: [], remove: [] }, actor = {}, notify, apply }) → Promise<{ error: string|null, dep: { lines: string[] }, warning: string, notified: { channelId, created, dmed } }>`. `cfg` needs only `.id`. `actor` is `{ discordId }` (Discord) or `{ activityId, label }` (site). On a refusal: `{ error, dep: { lines }, warning: '', notified }` and **no** `applyTaskUpdate` call.
  - `applyDependencyChange({ db, cfg, task, blockedById, unblockId, actorId, actorLabel = null, record })` — unchanged behaviour plus an optional `actorLabel` stored on the activity row.
  - `projectMoveNote(task, updates) → string|null` — unchanged.
  - `commands/update-task.js` still exports `applyDependencyChange`, `projectMoveNote`, `runUpdate`, `commitUpdate` with the same signatures and results.

- [ ] **Step 1: Write the failing tests** — `bot/src/services/taskEdit.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdit, applyDependencyChange } from './taskEdit.js'

const task = { id: 'T', guildConfigId: 'g1', title: 'Git Sync', status: 'open', parentTaskId: null }
const cfg = { id: 'g1' }

// A fake db that records every write. Rows are copies so a fake never mutates the caller's snapshot.
function fakeDb({ children = [], known = ['B', 'C'], deps = [] } = {}) {
  const log = []
  return {
    log,
    task: {
      findChildren: async () => children.map((c) => ({ ...c })),
      findByIds: async ({ where }) => where.ids.filter((id) => known.includes(id)).map((id) => ({ id, title: `Task ${id}`, status: 'open' })),
    },
    taskDependency: {
      findManyForGuild: async () => deps.map((d) => ({ ...d })),
      add: async ({ data }) => { log.push(['dep.add', data.blockedByTaskId, data.createdBy]) },
      remove: async ({ where }) => { log.push(['dep.remove', where.blockedByTaskId]); return { removed: 1 } },
    },
    taskActivity: { add: async ({ data }) => { log.push(['activity', data.actorDiscordId, data.actorLabel, data.changes[0].field]) } },
  }
}

test('finishing a task with an open subtask is refused before anything is written', async () => {
  const db = fakeDb({ children: [{ id: 'S', title: 'Sub', status: 'open' }] })
  let applied = 0
  const r = await applyEdit({ db, cfg, task, updates: { status: 'done' }, blockers: { add: ['B'], remove: [] }, apply: async () => { applied++ } })
  assert.match(r.error, /can't be marked done yet/)
  assert.equal(applied, 0)
  assert.deepEqual(db.log, [], 'no blocker row, no activity')
})

test('blockers are added then removed, then one field write with the actor passed through', async () => {
  const db = fakeDb()
  let seen = null
  const actor = { activityId: 'u-match', label: 'Aashir (via the site)' }
  const r = await applyEdit({
    db, cfg, task, updates: { title: 'New' }, blockers: { add: ['B'], remove: ['C'] }, actor,
    apply: async (a) => { seen = a; return { warning: '', notified: { channelId: 'ch', created: false, dmed: [] } } },
  })
  assert.equal(r.error, null)
  assert.deepEqual(r.dep.lines, ['**Blocked by:** Task B', '**Unblocked:** Task C'])
  assert.deepEqual(seen.updates, { title: 'New' })
  assert.equal(seen.actor, actor)
  assert.deepEqual(db.log, [
    ['dep.add', 'B', 'u-match'],
    ['activity', 'u-match', 'Aashir (via the site)', 'blocked_by'],
    ['dep.remove', 'C'],
    ['activity', 'u-match', 'Aashir (via the site)', 'blocked_by'],
  ])
})

test('a blocker the database no longer has is refused and the fields are not written', async () => {
  const db = fakeDb({ known: [] })
  let applied = 0
  const r = await applyEdit({ db, cfg, task, updates: { title: 'New' }, blockers: { add: ['B'], remove: [] }, apply: async () => { applied++ } })
  assert.match(r.error, /No task matches/)
  assert.equal(applied, 0)
})

test('no field updates: only the blockers change and applyTaskUpdate is not called', async () => {
  const db = fakeDb()
  let applied = 0
  const r = await applyEdit({ db, cfg, task, updates: {}, blockers: { add: ['B'], remove: [] }, apply: async () => { applied++ } })
  assert.equal(r.error, null)
  assert.equal(applied, 0)
  assert.equal(r.warning, '')
  assert.deepEqual(r.notified, { channelId: null, created: false, dmed: [] })
})

test('a Discord actor records its own id on blocker rows, as before', async () => {
  const db = fakeDb()
  await applyDependencyChange({ db, cfg, task, blockedById: 'B', actorId: 'u-discord' })
  assert.deepEqual(db.log, [['dep.add', 'B', 'u-discord'], ['activity', 'u-discord', null, 'blocked_by']])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `DATABASE_URL=poisoned://no-production-access node --test bot/src/services/taskEdit.test.js`
Expected: FAIL — `Cannot find module …/taskEdit.js`.

- [ ] **Step 3: Create `bot/src/services/taskEdit.js`.** Move `applyDependencyChange` and `projectMoveNote` here **verbatim with their doc comments**, with one change to `applyDependencyChange`: an `actorLabel = null` parameter, passed into both `record(...)` calls as `actor: { discordId: actorId, label: actorLabel }`. Then add `applyEdit`:

```js
// The one interaction-free path that writes an edit to a task: the subtask rule,
// then the blocker adds and removes, then the field write with everything that
// follows it (activity row, archive placement, channel post, DMs, parent sync).
// /update-task, the task hub and the site's update route all go through here, so
// a change looks the same in Discord whoever made it and from wherever.

import db from '../db/index.js'
import { applyTaskUpdate } from './taskStatusChange.js'
import { notifyTaskUpdate } from './taskUpdateNotify.js'
import { assertCanFinish } from './taskHierarchy.js'
import { recordTaskActivity } from './taskActivity.js'
import { TaskRuleError } from '../utils/taskHierarchy.js'
import { wouldCycle } from '../utils/taskDeps.js'

// … applyDependencyChange (moved, + actorLabel) …
// … projectMoveNote (moved) …

/**
 * Apply an already-validated edit. Every refusal returns `{ error }` before the
 * task row is written: the subtask rule first, then each blocker change. The
 * blocker checks here are the last line of defence (the site route validates the
 * whole list before calling); a Discord caller passes at most one of each.
 *
 * `actor` is `{ discordId }` from Discord (the channel post @mentions them) or
 * `{ activityId, label }` from the site (named, never mentioned).
 */
export async function applyEdit({
  db: dbArg = db, client, guild = null, cfg, task, updates = {}, blockers = {}, actor = {},
  notify = notifyTaskUpdate, apply = applyTaskUpdate,
}) {
  let notified = { channelId: task.discordChannelId || null, created: false, dmed: [] }
  const lines = []
  try {
    await assertCanFinish({ db: dbArg, task, updates })
  } catch (e) {
    if (e instanceof TaskRuleError) return { error: e.message, dep: { lines }, warning: '', notified }
    throw e
  }
  const actorId = actor.discordId ?? actor.activityId ?? null
  const actorLabel = actor.label ?? null
  for (const blockedById of blockers.add || []) {
    const dep = await applyDependencyChange({ db: dbArg, cfg, task, blockedById, actorId, actorLabel })
    if (dep.error) return { error: dep.error, dep: { lines }, warning: '', notified }
    lines.push(...dep.lines)
  }
  for (const unblockId of blockers.remove || []) {
    const dep = await applyDependencyChange({ db: dbArg, cfg, task, unblockId, actorId, actorLabel })
    lines.push(...dep.lines)
  }
  let warning = ''
  if (Object.keys(updates).length > 0) {
    ;({ warning, notified } = await apply({ db: dbArg, client, guild, task, updates, actor, notify }))
  }
  return { error: null, dep: { lines }, warning: warning || '', notified }
}
```

- [ ] **Step 4: Rewire `bot/src/commands/update-task.js`.** Delete the moved `applyDependencyChange` and `projectMoveNote` bodies. Add:

```js
import { applyDependencyChange, applyEdit, projectMoveNote } from '../services/taskEdit.js'
export { applyDependencyChange, projectMoveNote }
```
Replace `runUpdate`'s body (keep its doc comment and signature) with:

```js
export async function runUpdate(interaction, { db: dbArg = db, notify = notifyTaskUpdate, cfg, task, updates, blockedById = null, unblockId = null }) {
  const result = await applyEdit({
    db: dbArg,
    client: interaction.client,
    guild: interaction.guild,
    cfg,
    task,
    updates,
    blockers: { add: blockedById ? [blockedById] : [], remove: unblockId ? [unblockId] : [] },
    actor: { discordId: interaction.user.id },
    notify,
  })
  if (result.error) return { error: result.error }
  return { dep: result.dep, warning: result.warning, notified: result.notified }
}
```
Then remove imports that `update-task.js` no longer uses (check each with `grep -n "<name>" bot/src/commands/update-task.js`: likely `wouldCycle`, `recordTaskActivity`, `assertCanFinish`, `TaskRuleError`, `applyTaskUpdate`). Keep any still referenced.

- [ ] **Step 5: Run the new tests plus every suite that touches these paths**

Run: `DATABASE_URL=poisoned://no-production-access node --test bot/src/services/taskEdit.test.js bot/src/commands/update-task.test.js bot/src/services/taskHub.test.js bot/src/services/taskFinder.test.js`
Expected: `# fail 0`. If an `update-task.test.js` case fails, the extraction changed behaviour — fix `taskEdit.js`, never the old test.

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/taskEdit.js bot/src/services/taskEdit.test.js bot/src/commands/update-task.js
git commit -m "refactor(tasks): runUpdate's write path becomes interaction-free applyEdit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The creation service `services/taskCreate.js`

**Files:**
- Create: `bot/src/services/taskCreate.js`
- Create: `bot/src/services/taskCreate.test.js`
- Modify: `bot/src/commands/create-task.js` — `handleCreate` (≈L779-938) builds `fields` from the flow state, calls `createTask`, and keeps only its Discord reply.

**Interfaces:**
- Consumes: `createTaskTicketChannel` (`services/taskTicketChannel.js`), `createIssue` (`services/github.js`), `getOrCreateCategory` (`utils/categories.js`), `CATEGORY_BOLD_NAMES` (`constants.js`), `TEXT_ALLOW` (`utils/textAllow.js`), `scopeLabel` (`utils/taskScope.js`); db namespaces `feature`, `bugTicket`, `featureRepositories`, `ticketDoc`.
- Produces: `createTask({ db, guild, cfg, fields, project = null, repo = null, actor = {}, createChannel, openIssue }) → Promise<{ task, channel, fellBack: 'cap'|'missing'|null, issueUrl: string }>`.
  - `fields` is `validateCreate`'s shape: `{ type, title, description, scope, modules, holderIds, repositoryIds, tracks }`.
  - `repo` is the bug's repository row (`{ id, name, url }`) or null; features use `fields.repositoryIds` only.
  - `actor = { discordId?: string|null, label?: string|null, viaSite?: boolean }`. `createdBy = actor.discordId ?? null`. The channel's members are `holderIds` plus `actor.discordId` when set. When `actor.viaSite`, the opening embed carries a `Created by` field (`<@id>` if `discordId`, else `label`).

- [ ] **Step 1: Write the failing tests** — `bot/src/services/taskCreate.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTask } from './taskCreate.js'

const cfg = { id: 'g1' }
const project = { id: 'P1', name: 'Framework', guildConfigId: 'g1', discordCategoryId: 'cat1' }
const baseFields = { type: 'feature', title: 'Sync', description: 'd', scope: 'backend', modules: ['auth'], holderIds: ['u2'], repositoryIds: ['R1', 'R2'], tracks: { apiTests: true, qaTests: false, acceptanceCriteria: false } }

function fakeDb() {
  const log = []
  let n = 0
  const row = (data, type) => ({ id: `task${++n}`, ...data, type })
  return {
    log,
    feature: { create: async ({ data }) => { log.push(['feature.create', data]); return row(data, 'feature') }, update: async (a) => { log.push(['feature.update', a.data]) } },
    bugTicket: { create: async ({ data }) => { log.push(['bug.create', data]); return row(data, 'bug') }, update: async (a) => { log.push(['bug.update', a.data]) } },
    featureRepositories: { add: async (id, ids) => { log.push(['repos.add', id, ids]) } },
    ticketDoc: { create: async ({ data }) => { log.push(['doc.create', data.ticketType]) } },
  }
}
function fakeChannelMaker() {
  const calls = []
  const maker = async (guild, opts) => {
    calls.push(opts)
    const channel = { id: 'ch1' }
    if (opts.onCreated) await opts.onCreated(channel)
    return { channel, fellBack: null, placed: 'section' }
  }
  return { calls, maker }
}

test('a site feature: row, repos, doc, project-section channel, id written back, creator not a holder', async () => {
  const db = fakeDb()
  const { calls, maker } = fakeChannelMaker()
  const r = await createTask({ db, guild: { id: 'G' }, cfg, fields: baseFields, project, actor: { discordId: 'u-me', label: 'Me (via the site)', viaSite: true }, createChannel: maker })
  const [, data] = db.log.find((l) => l[0] === 'feature.create')
  assert.equal(data.createdBy, 'u-me')
  assert.deepEqual(data.assigneeIds, ['u2'], 'the site creator is not auto-added to the holders')
  assert.equal(data.projectId, 'P1'); assert.equal(data.projectName, 'Framework')
  assert.equal(data.repositoryId, 'R1'); assert.equal(data.status, 'open'); assert.equal(data.implementationStatus, 'not_started')
  assert.equal(data.passedApiTests, 0); assert.equal(data.passedQaTests, null)
  assert.deepEqual(db.log.find((l) => l[0] === 'repos.add').slice(2), [['R1', 'R2']])
  assert.ok(db.log.some((l) => l[0] === 'doc.create' && l[1] === 'feature'))
  assert.deepEqual(db.log.find((l) => l[0] === 'feature.update')[1], { discordChannelId: 'ch1' })
  assert.deepEqual(calls[0].memberIds, ['u2', 'u-me'], 'the creator can see the channel')
  assert.equal(calls[0].project, project)
  assert.deepEqual(calls[0].fields.find((f) => f.name === 'Created by'), { name: 'Created by', value: '<@u-me>', inline: true })
  assert.equal(r.channel.id, 'ch1'); assert.equal(r.fellBack, null)
})

test('a site user with no Discord match: createdBy is null and the embed names them', async () => {
  const db = fakeDb()
  const { calls, maker } = fakeChannelMaker()
  await createTask({ db, guild: { id: 'G' }, cfg, fields: baseFields, project, actor: { discordId: null, label: 'ubs@granjur.com (via the site)', viaSite: true }, createChannel: maker })
  assert.equal(db.log.find((l) => l[0] === 'feature.create')[1].createdBy, null)
  assert.deepEqual(calls[0].memberIds, ['u2'])
  assert.equal(calls[0].fields.find((f) => f.name === 'Created by').value, 'ubs@granjur.com (via the site)')
})

test('a Discord feature gets no Created by field (Discord output unchanged)', async () => {
  const db = fakeDb()
  const { calls, maker } = fakeChannelMaker()
  await createTask({ db, guild: { id: 'G' }, cfg, fields: baseFields, project: null, actor: { discordId: 'u-me' }, createChannel: maker })
  assert.equal(calls[0].fields.some((f) => f.name === 'Created by'), false)
  assert.deepEqual(calls[0].fields.map((f) => f.name), ['Status', 'Assignees', 'Scope / Modules'])
})

test('a bug with a project: pending row, GitHub issue, project-section channel via the shared helper', async () => {
  const db = fakeDb()
  const { calls, maker } = fakeChannelMaker()
  const repo = { id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }
  let issued = null
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, project, repo,
    fields: { ...baseFields, type: 'bug', modules: [], repositoryIds: ['R1'] },
    actor: { discordId: null, label: 'Me (via the site)', viaSite: true }, createChannel: maker,
    openIssue: async (url, title) => { issued = [url, title]; return { url: 'https://github.com/g/bot/issues/7', number: 7 } },
  })
  const [, data] = db.log.find((l) => l[0] === 'bug.create')
  assert.equal(data.status, 'pending'); assert.equal(data.projectId, 'P1'); assert.deepEqual(data.taggedMemberIds, ['u2'])
  assert.deepEqual(issued, ['https://github.com/g/bot', 'Sync'])
  assert.deepEqual(db.log.find((l) => l[0] === 'bug.update' && l[1].externalIssueUrl)[1], { externalIssueUrl: 'https://github.com/g/bot/issues/7', externalIssueNumber: 7 })
  assert.equal(calls[0].type, 'bug'); assert.equal(calls[0].project, project)
  assert.ok(calls[0].fields.some((f) => f.name === 'Issue' && f.value === 'https://github.com/g/bot/issues/7'))
  assert.equal(r.issueUrl, 'https://github.com/g/bot/issues/7')
})

test('a failed GitHub issue never fails the create', async () => {
  const db = fakeDb()
  const { maker } = fakeChannelMaker()
  const r = await createTask({
    db, guild: { id: 'G' }, cfg, project, repo: { id: 'R1', name: 'bot', url: 'https://github.com/g/bot' },
    fields: { ...baseFields, type: 'bug', modules: [], repositoryIds: ['R1'] }, actor: {}, createChannel: maker,
    openIssue: async () => { throw new Error('rate limited') },
  })
  assert.equal(r.issueUrl, '')
  assert.equal(r.channel.id, 'ch1')
})

test('a bug without a project keeps the global Bugs channel (the /create-task path)', async () => {
  const db = fakeDb()
  const created = []
  const guild = {
    id: 'G',
    channels: {
      cache: { find: () => ({ id: 'bugsCat', type: 4, name: 'Bugs' }), filter: () => ({ size: 0 }) },
      create: async (opts) => { created.push(opts); return { id: 'bch', send: async () => {} } },
    },
  }
  const r = await createTask({
    db, guild, cfg, project: null, repo: null,
    fields: { ...baseFields, type: 'bug', modules: [], repositoryIds: [] }, actor: { discordId: 'u-me' },
    createChannel: async () => { throw new Error('must not be used for a project-less bug') },
    getCategory: async () => ({ id: 'bugsCat' }),
  })
  assert.equal(created[0].parent, 'bugsCat')
  assert.match(created[0].name, /^bug-/)
  assert.equal(r.channel.id, 'bch')
  assert.deepEqual(db.log.find((l) => l[0] === 'bug.update' && l[1].discordChannelId)[1], { discordChannelId: 'bch' })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `DATABASE_URL=poisoned://no-production-access node --test bot/src/services/taskCreate.test.js`
Expected: FAIL — `Cannot find module …/taskCreate.js`.

- [ ] **Step 3: Write `bot/src/services/taskCreate.js`.** Move the bodies of `handleCreate`'s feature and bug branches here. The project-less bug branch is the existing code verbatim (global Bugs category, `bug-<last six>` name, `@everyone` deny + member `TEXT_ALLOW` overwrites, the red embed with `Resolve` field), with `getOrCreateCategory` behind a `getCategory` seam:

```js
// Creating a Feature or a Bug task: the row, its repositories, its ticket doc,
// the bug's GitHub issue, and its channel. Shared by /create-task and the site's
// create route, so a task looks the same in Discord whichever made it.
//
// Never replies to anyone — the caller does that with what comes back.

import { ChannelType, EmbedBuilder, OverwriteType, PermissionFlagsBits } from 'discord.js'
import db from '../db/index.js'
import { createTaskTicketChannel } from './taskTicketChannel.js'
import { createIssue } from './github.js'
import { getOrCreateCategory } from '../utils/categories.js'
import { CATEGORY_BOLD_NAMES } from '../constants.js'
import { TEXT_ALLOW } from '../utils/textAllow.js'
import { scopeLabel } from '../utils/taskScope.js'

const unique = (ids) => [...new Set(ids.filter(Boolean).map(String))]
const metric = (tracked) => (tracked === true ? 0 : null)

/** The "Created by" field a site-made task's opening embed carries. Null for a Discord-made one. */
function createdByField(actor) {
  if (!actor?.viaSite) return null
  const value = actor.discordId ? `<@${actor.discordId}>` : (actor.label || 'Someone (via the site)')
  return { name: 'Created by', value: String(value).slice(0, 1024), inline: true }
}

/**
 * @param {object} opts
 * @param {{type:'feature'|'bug', title:string, description:string|null, scope:string|null, modules:string[], holderIds:string[], repositoryIds:string[], tracks:{apiTests:boolean,qaTests:boolean,acceptanceCriteria:boolean}}} opts.fields
 * @param {object|null} [opts.project]  the project row (required from the site; optional from Discord)
 * @param {object|null} [opts.repo]     a bug's repository row ({ id, name, url })
 * @param {{discordId?:string|null, label?:string|null, viaSite?:boolean}} [opts.actor]
 * @returns {Promise<{task: object, channel: object, fellBack: 'cap'|'missing'|null, issueUrl: string}>}
 */
export async function createTask({
  db: dbArg = db, guild, cfg, fields, project = null, repo = null, actor = {},
  createChannel = createTaskTicketChannel, openIssue = createIssue, getCategory = getOrCreateCategory,
}) {
  const creator = actor.discordId ?? null
  const holders = unique(fields.holderIds || [])
  const members = unique([...holders, creator])
  const passed = {
    passedApiTests: metric(fields.tracks?.apiTests),
    passedQaTests: metric(fields.tracks?.qaTests),
    passedAcceptanceCriteria: metric(fields.tracks?.acceptanceCriteria),
  }
  const createdBy = createdByField(actor)

  if (fields.type === 'feature') {
    const task = await dbArg.feature.create({
      data: {
        guildConfigId: cfg.id,
        repositoryId: fields.repositoryIds?.[0] ?? null,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        title: fields.title,
        description: fields.description ?? null,
        createdBy: creator,
        assigneeIds: holders,
        status: 'open',
        modules: fields.modules || [],
        scope: fields.scope ?? null,
        implementationStatus: 'not_started',
        ...passed,
      },
    })
    if (fields.repositoryIds?.length) await dbArg.featureRepositories.add(task.id, fields.repositoryIds)
    await dbArg.ticketDoc.create({ data: { guildConfigId: cfg.id, ticketType: 'feature', taskId: task.id, title: fields.title?.slice(0, 512) || 'Feature', content: null } })

    const scopeMod = [scopeLabel(fields.scope), (fields.modules?.length ? fields.modules.join(', ') : null)].filter(Boolean).join(' · ')
    const { channel, fellBack } = await createChannel(guild, {
      taskId: task.id,
      title: fields.title,
      description: fields.description,
      memberIds: members,
      project,
      type: 'feature',
      status: 'open',
      fields: [
        { name: 'Status', value: 'open', inline: true },
        { name: 'Assignees', value: (holders.map((id) => `<@${id}>`).join(' ') || 'None'), inline: true },
        { name: 'Scope / Modules', value: scopeMod || '—', inline: false },
        ...(createdBy ? [createdBy] : []),
      ],
      closeHint: 'Use **/close-feature** in this channel when done.',
      // Straight after the create, before the opening embed is sent: a `send`
      // that throws must not leave a channel with no row pointing at it.
      onCreated: (made) => dbArg.feature.update({ where: { id: task.id }, data: { discordChannelId: made.id } }),
    })
    return { task, channel, fellBack, issueUrl: '' }
  }

  // Bug.
  const taggedMentions = holders.map((id) => `<@${id}>`).join(' ')
  const task = await dbArg.bugTicket.create({
    data: {
      guildConfigId: cfg.id,
      repositoryId: repo?.id ?? null,
      // Only when there is one: /create-task's project-less bug row stays
      // exactly as it was, without two extra null columns.
      ...(project ? { projectId: project.id, projectName: project.name } : {}),
      title: fields.title,
      description: fields.description || null,
      status: 'pending',
      taggedMemberIds: holders,
      createdBy: creator,
      scope: fields.scope ?? null,
      ...passed,
    },
  })

  let issueUrl = ''
  if (repo?.url) {
    try {
      const body = [fields.description || '', `\n---\n**Tagged:** ${taggedMentions || 'none'}`, `**Ticket ID:** ${task.id}`].join('\n')
      const res = await openIssue(repo.url, fields.title, body)
      if (res?.url) {
        issueUrl = res.url
        await dbArg.bugTicket.update({ where: { id: task.id }, data: { externalIssueUrl: res.url, externalIssueNumber: res.number } })
      }
    } catch (_) {}
  }

  await dbArg.ticketDoc.create({ data: { guildConfigId: cfg.id, ticketType: 'bug', taskId: task.id, title: (fields.title || 'Bug').slice(0, 512), content: null } })

  const bugFields = [
    { name: 'Status', value: 'pending', inline: true },
    { name: 'Scope', value: scopeLabel(fields.scope) || '—', inline: true },
    { name: 'Tagged', value: taggedMentions || 'None', inline: true },
    { name: 'Repository', value: repo?.url || '—', inline: false },
    ...(issueUrl ? [{ name: 'Issue', value: issueUrl, inline: false }] : []),
    ...(createdBy ? [createdBy] : []),
  ]

  if (project) {
    // A bug filed under a project lives in that project's section, exactly as a
    // client-reported bug does (services/clientRequest.js).
    const { channel, fellBack } = await createChannel(guild, {
      taskId: task.id,
      title: fields.title,
      description: fields.description,
      memberIds: members,
      project,
      type: 'bug',
      status: 'pending',
      fields: bugFields,
      closeHint: 'Use **/resolve-bug** in this channel when fixed.',
      onCreated: (made) => dbArg.bugTicket.update({ where: { id: task.id }, data: { discordChannelId: made.id } }),
    })
    return { task, channel, fellBack, issueUrl }
  }

  // No project (only /create-task makes these): the global Bugs category,
  // unchanged from before this service existed.
  const category = await getCategory(guild, 'Bugs', { orNames: [CATEGORY_BOLD_NAMES['Bugs']].filter(Boolean) })
  const overwrites = [
    { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    ...members.map((id) => ({ id, type: OverwriteType.Member, allow: TEXT_ALLOW })),
  ]
  const channel = await guild.channels.create({
    name: `bug-${task.id.slice(-6)}`,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Bug: ${fields.title} | Repo: ${repo?.name || '—'}`,
    permissionOverwrites: overwrites,
  })
  await dbArg.bugTicket.update({ where: { id: task.id }, data: { discordChannelId: channel.id } })

  const allMentions = members.map((id) => `<@${id}>`).join(' ')
  const embed = new EmbedBuilder()
    .setTitle(`Bug: ${fields.title}`)
    .setDescription((fields.description || 'No description.').slice(0, 1000))
    .addFields(
      { name: 'Status', value: 'pending', inline: true },
      { name: 'Scope', value: scopeLabel(fields.scope) || '—', inline: true },
      { name: 'Tagged', value: taggedMentions || 'None', inline: true },
      { name: 'Repository', value: repo?.url || '—', inline: false },
      { name: 'Resolve', value: 'Use **/resolve-bug** in this channel when fixed.', inline: false },
      ...(issueUrl ? [{ name: 'Issue', value: issueUrl, inline: false }] : [])
    )
    .setFooter({ text: `Ticket ID: ${task.id}` })
    .setColor(0xed4245)
  await channel.send({ content: allMentions || null, embeds: [embed] })
  return { task, channel, fellBack: null, issueUrl }
}
```

Note on Discord parity: `/create-task` today writes `repositoryId: state.repositoryId` even when `state.repo` (the row whose `url` opens the issue) is missing, and opens the issue only when `state.repo?.url` is set. The `repo` argument built in Step 4 carries `id: state.repositoryId` for exactly that reason; `createTask` reads `repo.id` for the column and `repo.url` / `repo.name` only when present.

- [ ] **Step 4: Rewire `handleCreate` in `bot/src/commands/create-task.js`.** Keep its signature and seams, add an `openIssue = createIssue` seam, and replace the body inside `try` with:

```js
    const firstProject = isFeature && state.projectIds?.[0]
      ? await dbArg.project.findFirst({ where: { id: state.projectIds[0] } })
      : null
    const fields = {
      type: isFeature ? 'feature' : 'bug',
      title: state.title,
      description: state.description ?? null,
      scope: state.scope ?? null,
      modules: state.modules || [],
      holderIds: isFeature ? (state.assigneeIds || []) : (state.taggedMemberIds || []),
      repositoryIds: isFeature ? (state.repositoryIds || []) : [],
      tracks: { apiTests: state.hasApiTest === true, qaTests: state.hasQaTest === true, acceptanceCriteria: state.hasAc === true },
    }
    const { channel, fellBack, issueUrl } = await createTask({
      db: dbArg, guild, cfg, fields,
      project: firstProject,
      // Carries state.repositoryId even without state.repo, as the old code wrote it.
      repo: isFeature || (!state.repositoryId && !state.repo)
        ? null
        : { ...(state.repo || {}), id: state.repositoryId ?? state.repo?.id ?? null },
      actor: { discordId: interaction.user.id },
      createChannel, openIssue,
    })
    flowStore.clear(interaction.user.id, guild.id, FLOW_KEY)
    if (isFeature) {
      await respond(interaction, {
        embeds: [new EmbedBuilder().setTitle('Feature task created').setDescription(channelPlacementNote(`<#${channel.id}>`, firstProject, fellBack)).setColor(0x57f287)],
        components: [],
      })
    } else {
      await respond(interaction, {
        embeds: [new EmbedBuilder().setTitle('Bug task created').setDescription(`Channel: ${channel}${issueUrl ? `\nIssue: ${issueUrl}` : ''}`).setColor(0x57f287)],
        components: [],
      })
    }
```
Discord invariants this keeps: the feature `assigneeIds` column still holds only the picked assignees while the channel also admits the invoker (`members` adds `actor.discordId`); a bug's `taggedMemberIds` is the picked list; the bug channel is still the global one (no project for Discord bugs). Remove imports `create-task.js` no longer uses (`ChannelType`, `PermissionFlagsBits`, `OverwriteType`, `TEXT_ALLOW`, `getOrCreateCategory`, `CATEGORY_BOLD_NAMES` — check each with grep first; `createIssue` stays as the seam default).

- [ ] **Step 5: Run**

Run: `DATABASE_URL=poisoned://no-production-access node --test bot/src/services/taskCreate.test.js bot/src/commands/create-task.test.js`
Expected: `# fail 0`. A failing `create-task.test.js` case means Discord output changed — fix the service, not the test. If a create-task test injected `createIssue` by module mocking, switch it to the new `openIssue` seam.

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/taskCreate.js bot/src/services/taskCreate.test.js bot/src/commands/create-task.js bot/src/commands/create-task.test.js
git commit -m "refactor(tasks): task creation moves into services/taskCreate.js

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The three internal routes

**Files:**
- Modify: `bot/src/services/internalTaskRoute.js` (shared guard; `handleUpdateRequest`, `handleCreateRequest`, `handleSubtaskRequest`)
- Modify: `bot/src/services/taskHierarchy.js` `createSubtask` (≈L60-112): `createdBy` and the activity actor fall back to `actor.activityId`
- Modify: `bot/src/server.js:59-88` (one dispatch table for the four internal paths, body capped)
- Modify: `bot/src/services/internalTaskRoute.test.js` (append cases)
- Modify: `.claude/knowledge/project-tasks-site.md` (new section, see Step 7)

**Interfaces:**
- Consumes: `validateEdit`, `validateCreate` (Task 1); `applyEdit`, `projectMoveNote` (Task 2); `createTask` (Task 3); `createSubtask` (`services/taskHierarchy.js`); `applyTaskUpdate`, `notifyTaskUpdate`.
- Produces (bot HTTP, all `POST`, header `x-internal-secret`, JSON):
  - `/internal/tasks/update` body `{ taskId, changes, actor: { email, name } }` → 200 `{ ok: true, task: { id, status }, warning, lines, unchanged }`; 400 `{ ok:false, message }`; 404 `Task not found`; 409 `{ ok:false, message }`.
  - `/internal/tasks/create` body `{ type, title, description, projectId, scope, modules, holderIds, repositoryIds, tracks: { apiTests, qaTests, acceptanceCriteria }, actor }` → 200 `{ ok: true, task: { id, type, status, projectId }, channelId, fellBack, note }`; 400; 500 when the guild is not in the bot's cache.
  - `/internal/tasks/subtask` body `{ parentId, title, holderIds, actor }` → 200 `{ ok: true, task: { id, status, parentId } }`; 400; 404; 409.
  - Every route: 503 `internal route not configured` when `BOT_INTERNAL_SECRET` is unset; 401 `unauthorized` on a wrong/missing header; 500 on anything thrown.

- [ ] **Step 1: Write the failing tests** — append to `bot/src/services/internalTaskRoute.test.js` (change its import line to also import the three new handlers):

```js
import { handleStatusRequest, handleUpdateRequest, handleCreateRequest, handleSubtaskRequest } from './internalTaskRoute.js'

const H = { 'x-internal-secret': 's3cret' }
const T = { id: 'T', guildConfigId: 'g1', type: 'feature', title: 'Git Sync', status: 'open', description: null, scope: null, implementationStatus: 'not_started', projectId: 'P1', projectName: 'Framework', assigneeIds: ['u1'], taggedMemberIds: [], estimateMinutes: null }
function routeDb(extra = {}) {
  return {
    task: {
      findFirst: async ({ where }) => (where.id === 'T' ? { ...T } : null),
      findByIds: async ({ where }) => where.ids.filter((id) => id === 'B').map((id) => ({ id, title: 'Blocker', status: 'open' })),
    },
    taskDependency: { findManyForGuild: async () => [{ taskId: 'B', blockedByTaskId: 'T' }] },
    project: { findFirst: async ({ where }) => (where.id === 'P1' ? { id: 'P1', name: 'Framework', guildConfigId: 'g1' } : where.id === 'PX' ? { id: 'PX', name: 'Other guild', guildConfigId: 'g2' } : null) },
    guildMember: {
      findByConfigEmail: async ({ where }) => (where.email === 'a@granjur.com' ? { discordId: 'u-aashir' } : null),
      findMany: async () => [{ discordId: 'u1' }, { discordId: 'u2' }],
    },
    guildConfig: { findById: async () => ({ id: 'g1', guildId: 'G1' }) },
    repository: { findMany: async () => [{ id: 'R1', name: 'bot', url: 'https://github.com/g/bot' }] },
    ...extra,
  }
}
const actor = { email: 'a@granjur.com', name: 'Aashir' }

for (const [name, handler] of [['update', handleUpdateRequest], ['create', handleCreateRequest], ['subtask', handleSubtaskRequest]]) {
  test(`${name}: 503 without a secret, 401 on a wrong one, null body is not a crash`, async () => {
    assert.equal((await handler({ headers: H, body: {}, db: routeDb(), client: {}, secret: '' })).status, 503)
    assert.equal((await handler({ headers: { 'x-internal-secret': 'nope' }, body: {}, db: routeDb(), client: {}, secret: 's3cret' })).status, 401)
    assert.equal((await handler({ headers: H, body: null, db: routeDb(), client: {}, secret: 's3cret' })).status, 400)
  })
}

test('update: 404 for an unknown task', async () => {
  const r = await handleUpdateRequest({ headers: H, body: { taskId: 'Z', changes: { title: 'x' } }, db: routeDb(), client: {}, secret: 's3cret' })
  assert.equal(r.status, 404)
})
test('update: a refused field is a 400 with the rule sentence and nothing is applied', async () => {
  let edits = 0
  const r = await handleUpdateRequest({ headers: H, body: { taskId: 'T', changes: { passedApiTests: 900 }, actor }, db: routeDb(), client: {}, secret: 's3cret', edit: async () => { edits++ } })
  assert.equal(r.status, 400)
  assert.equal(r.body.message, 'Test counts must be whole numbers from 0 to 127.')
  assert.equal(edits, 0)
})
test('update: a refused blocker writes nothing, not even the valid fields beside it', async () => {
  let edits = 0
  const r = await handleUpdateRequest({ headers: H, body: { taskId: 'T', changes: { title: 'Renamed', blockerIds: ['B'] }, actor }, db: routeDb(), client: {}, secret: 's3cret', edit: async () => { edits++ } })
  assert.equal(r.status, 400)
  assert.equal(r.body.message, 'Blocker already depends on Git Sync, so Git Sync cannot be blocked by Blocker.')
  assert.equal(edits, 0)
})
test('update: nothing actually changed is a 200 unchanged with no write', async () => {
  let edits = 0
  const r = await handleUpdateRequest({ headers: H, body: { taskId: 'T', changes: { title: 'Git Sync', description: '' }, actor }, db: routeDb(), client: {}, secret: 's3cret', edit: async () => { edits++ } })
  assert.equal(r.status, 200)
  assert.equal(r.body.unchanged, true)
  assert.equal(edits, 0)
})
test('update: success passes updates, blockers and a site actor, and joins the project-move note into the warning', async () => {
  let seen
  const db = routeDb({ taskDependency: { findManyForGuild: async () => [] } })
  const r = await handleUpdateRequest({
    headers: H, body: { taskId: 'T', changes: { title: 'Renamed', projectId: null, holderIds: ['u2'], blockerIds: ['B'] }, actor }, db, client: {}, secret: 's3cret',
    edit: async (a) => { seen = a; return { error: null, dep: { lines: ['**Blocked by:** Blocker'] }, warning: '⛔ x', notified: {} } },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(seen.updates, { title: 'Renamed', projectId: null, projectName: null, assigneeIds: ['u2'] })
  assert.deepEqual(seen.blockers, { add: ['B'], remove: [] })
  assert.deepEqual(seen.actor, { activityId: 'u-aashir', label: 'Aashir (via the site)' })
  assert.equal(seen.actor.discordId, undefined, 'a site actor is never mentioned')
  assert.match(r.body.warning, /^⛔ x\nThis task now belongs to no project/)
  assert.deepEqual(r.body.lines, ['**Blocked by:** Blocker'])
  assert.equal(r.body.unchanged, false)
})
test('update: a project in another guild is refused', async () => {
  const r = await handleUpdateRequest({ headers: H, body: { taskId: 'T', changes: { projectId: 'PX' } }, db: routeDb(), client: {}, secret: 's3cret', edit: async () => ({}) })
  assert.equal(r.status, 400)
  assert.equal(r.body.message, 'No project matches that id.')
})
test('update: a write-time rule refusal from applyEdit is a 409', async () => {
  const r = await handleUpdateRequest({ headers: H, body: { taskId: 'T', changes: { status: 'done' } }, db: routeDb(), client: {}, secret: 's3cret', edit: async () => ({ error: "Git Sync can't be marked done yet", dep: { lines: [] } }) })
  assert.equal(r.status, 409)
})

const guildClient = { guilds: { cache: { get: (id) => (id === 'G1' ? { id: 'G1' } : undefined) } } }
test('create: project required and must exist', async () => {
  const r1 = await handleCreateRequest({ headers: H, body: { type: 'feature', title: 'x' }, db: routeDb(), client: guildClient, secret: 's3cret' })
  assert.equal(r1.status, 400); assert.equal(r1.body.message, 'projectId is required')
  const r2 = await handleCreateRequest({ headers: H, body: { type: 'feature', title: 'x', projectId: 'P9' }, db: routeDb(), client: guildClient, secret: 's3cret' })
  assert.equal(r2.status, 400); assert.equal(r2.body.message, 'No project matches that id.')
})
test('create: the guild missing from the bot cache is a 500 with a sentence', async () => {
  const r = await handleCreateRequest({ headers: H, body: { type: 'feature', title: 'x', projectId: 'P1' }, db: routeDb(), client: { guilds: { cache: { get: () => undefined } } }, secret: 's3cret', create: async () => { throw new Error('must not run') } })
  assert.equal(r.status, 500)
  assert.equal(r.body.message, 'The Discord server is not available to the bot right now.')
})
test('create: validated fields, the bug repo row and a site actor reach createTask', async () => {
  let seen
  const r = await handleCreateRequest({
    headers: H, body: { type: 'bug', title: 'Crash', projectId: 'P1', holderIds: ['u1'], repositoryIds: ['R1'], actor: { email: 'nobody@x.com', name: 'Nobody' } },
    db: routeDb(), client: guildClient, secret: 's3cret',
    create: async (a) => { seen = a; return { task: { id: 'N1', type: 'bug', status: 'pending', projectId: 'P1' }, channel: { id: 'ch9' }, fellBack: 'missing', issueUrl: '' } },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(seen.fields.repositoryIds, ['R1'])
  assert.deepEqual(seen.repo, { id: 'R1', name: 'bot', url: 'https://github.com/g/bot' })
  assert.deepEqual(seen.actor, { discordId: null, label: 'Nobody (via the site)', viaSite: true })
  assert.deepEqual(r.body.task, { id: 'N1', type: 'bug', status: 'pending', projectId: 'P1' })
  assert.equal(r.body.channelId, 'ch9')
  assert.equal(r.body.fellBack, 'missing')
  assert.equal(r.body.note, 'Framework has no Discord section yet, so the channel went to the global Bugs category. Run /project-setup for it.')
})
test('create: an unknown member is a 400', async () => {
  const r = await handleCreateRequest({ headers: H, body: { type: 'feature', title: 'x', projectId: 'P1', holderIds: ['u9'] }, db: routeDb(), client: guildClient, secret: 's3cret' })
  assert.equal(r.status, 400); assert.equal(r.body.message, 'u9 is not a member of this Discord server.')
})

test('subtask: title required, 404 for an unknown parent, members checked', async () => {
  assert.equal((await handleSubtaskRequest({ headers: H, body: { parentId: 'T', title: ' ' }, db: routeDb(), client: guildClient, secret: 's3cret' })).body.message, 'A subtask needs a title.')
  assert.equal((await handleSubtaskRequest({ headers: H, body: { parentId: 'Z', title: 'x' }, db: routeDb(), client: guildClient, secret: 's3cret' })).status, 404)
  assert.equal((await handleSubtaskRequest({ headers: H, body: { parentId: 'T', title: 'x', holderIds: ['u9'] }, db: routeDb(), client: guildClient, secret: 's3cret' })).status, 400)
})
test('subtask: success hands createSubtask the parent, fields and a site actor', async () => {
  let seen
  const r = await handleSubtaskRequest({
    headers: H, body: { parentId: 'T', title: ' Write tests ', holderIds: ['u2'], actor }, db: routeDb(), client: guildClient, secret: 's3cret',
    addSubtask: async (a) => { seen = a; return { id: 'S1', status: 'open', parentTaskId: 'T' } },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, task: { id: 'S1', status: 'open', parentId: 'T' } })
  assert.equal(seen.parent.id, 'T')
  assert.deepEqual(seen.fields, { title: 'Write tests', assigneeIds: ['u2'] })
  assert.deepEqual(seen.actor, { activityId: 'u-aashir', label: 'Aashir (via the site)' })
  assert.deepEqual(seen.guild, { id: 'G1' })
})
test('subtask: a TaskRuleError from createSubtask is a 409', async () => {
  const { TaskRuleError } = await import('../utils/taskHierarchy.js')
  const r = await handleSubtaskRequest({ headers: H, body: { parentId: 'T', title: 'x' }, db: routeDb(), client: guildClient, secret: 's3cret', addSubtask: async () => { throw new TaskRuleError('A task can have at most 25 subtasks.') } })
  assert.equal(r.status, 409); assert.equal(r.body.message, 'A task can have at most 25 subtasks.')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `DATABASE_URL=poisoned://no-production-access node --test bot/src/services/internalTaskRoute.test.js`
Expected: FAIL — `handleUpdateRequest` is not exported. (The existing status cases still pass.)

- [ ] **Step 3: Implement in `bot/src/services/internalTaskRoute.js`.** Add imports:

```js
import { validateCreate, validateEdit } from '../utils/taskEditRules.js'
import { applyEdit, projectMoveNote } from './taskEdit.js'
import { createTask } from './taskCreate.js'
import { createSubtask } from './taskHierarchy.js'
import { notifyTaskUpdate } from './taskUpdateNotify.js'
```
Add the shared front half and actor lookup, and make `handleStatusRequest` use them (its tests must stay green — same codes, same messages):

```js
const bad = (message) => ({ status: 400, body: { ok: false, message } })

/**
 * The part every internal route shares: disabled without a secret (503),
 * refused without the right header (401), the body normalised to an object
 * before anything reads it, a TaskRuleError is the caller's to fix (409), and
 * anything else thrown is a logged 500 — never a hung response.
 */
async function guarded({ headers = {}, body, secret, route }, handler) {
  if (!secret) return { status: 503, body: { ok: false, message: 'internal route not configured' } }
  if (!safeEqual(headers['x-internal-secret'], secret)) return { status: 401, body: { ok: false, message: 'unauthorized' } }
  try {
    // A default parameter only fires on `undefined`; a JSON body of `null` (or
    // any non-object) must not reach a property read, so it's normalized here.
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    return await handler(b)
  } catch (e) {
    if (e instanceof TaskRuleError) return { status: 409, body: { ok: false, message: e.message } }
    console.error(`[internal] ${route} route:`, e?.message ?? e)
    return { status: 500, body: { ok: false, message: e?.message || 'internal error' } }
  }
}

/**
 * Who the site says did this. The label names them in the channel post; the
 * email match (a Discord id) attributes the activity row and, for a create, the
 * creator — never a mention. No match is fine.
 */
async function siteActor(dbArg, guildConfigId, actor) {
  const name = String(actor?.name || actor?.email || 'Someone').slice(0, 100)
  let activityId = null
  const email = String(actor?.email ?? '').trim()
  if (email) {
    try {
      const member = await dbArg.guildMember.findByConfigEmail({ where: { guildConfigId, email } })
      activityId = member?.discordId ?? null
    } catch (e) {
      console.error('[internal] actor lookup:', e?.message ?? e)
    }
  }
  return { label: `${name} (via the site)`, activityId }
}

/** A task id from the body, or a 400 message. */
function idFrom(value, field) {
  const id = String(value ?? '').trim()
  if (!id) return [`${field} is required`]
  if (id.length > 64) return [`${field} is too long (max 64)`]
  return [null, id]
}

/** The Discord ids of every member row in a guild. */
async function memberIdsOf(dbArg, guildConfigId) {
  const rows = await dbArg.guildMember.findMany({ where: { guildConfigId, all: true } })
  return new Set((rows || []).map((m) => String(m.discordId)))
}

async function guildOf(dbArg, client, guildConfigId) {
  const cfg = await dbArg.guildConfig.findById(guildConfigId)
  return { cfg, guild: cfg ? client?.guilds?.cache?.get(cfg.guildId) ?? null : null }
}
```

Rewrite `handleStatusRequest` over them (behaviour identical):

```js
export async function handleStatusRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, apply = applyTaskUpdate }) {
  return guarded({ headers, body, secret, route: 'status' }, async (b) => {
    const [idErr, taskId] = idFrom(b.taskId, 'taskId')
    if (idErr) return bad(idErr)
    const status = String(b.status ?? '').trim()
    if (!TASK_STATUSES.includes(status)) return bad(`status must be one of ${TASK_STATUSES.join(', ')}`)
    const task = await dbArg.task.findFirst({ where: { id: taskId } })
    if (!task) return { status: 404, body: { ok: false, message: 'Task not found' } }
    if (task.status === status) return { status: 200, body: { ok: true, task: { id: task.id, status }, warning: '', unchanged: true } }
    const actor = await siteActor(dbArg, task.guildConfigId, b.actor)
    const { warning } = await apply({ db: dbArg, client, task, updates: { status }, actor })
    return { status: 200, body: { ok: true, task: { id: task.id, status }, warning: warning || '', unchanged: false } }
  })
}
```
(The old test "success applies with a '(via the site)' label" checks `seen.actor.label`; `actor` now also carries `activityId`, exactly as before.)

Then the three new handlers:

```js
/** A site edit: every field `/update-task` and the task hub can change, checked whole before anything is written. */
export async function handleUpdateRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, edit = applyEdit }) {
  return guarded({ headers, body, secret, route: 'update' }, async (b) => {
    const [idErr, taskId] = idFrom(b.taskId, 'taskId')
    if (idErr) return bad(idErr)
    const task = await dbArg.task.findFirst({ where: { id: taskId } })
    if (!task) return { status: 404, body: { ok: false, message: 'Task not found' } }
    const changes = b.changes
    const has = (k) => changes && typeof changes === 'object' && Object.prototype.hasOwnProperty.call(changes, k)

    // Load only what the changes need, all from the task's own guild.
    const ctx = { projectsById: new Map(), memberIds: new Set(), tasksById: new Map(), deps: [] }
    if (has('projectId') && changes.projectId) {
      const p = await dbArg.project.findFirst({ where: { id: String(changes.projectId) } })
      if (p && p.guildConfigId === task.guildConfigId) ctx.projectsById.set(p.id, p)
    }
    if (has('holderIds')) ctx.memberIds = await memberIdsOf(dbArg, task.guildConfigId)
    if (has('blockerIds') && Array.isArray(changes.blockerIds)) {
      const ids = changes.blockerIds.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
      const rows = ids.length ? await dbArg.task.findByIds({ where: { guildConfigId: task.guildConfigId, ids } }) : []
      ctx.tasksById = new Map(rows.map((r) => [String(r.id), r]))
      ctx.deps = await dbArg.taskDependency.findManyForGuild({ where: { guildConfigId: task.guildConfigId } })
    }

    const v = validateEdit(task, changes, ctx)
    if (v.error) return bad(v.error)
    if (!Object.keys(v.updates).length && !v.blockers.add.length && !v.blockers.remove.length) {
      return { status: 200, body: { ok: true, task: { id: task.id, status: task.status }, warning: '', lines: [], unchanged: true } }
    }
    const actor = await siteActor(dbArg, task.guildConfigId, b.actor)
    const r = await edit({ db: dbArg, client, cfg: { id: task.guildConfigId }, task, updates: v.updates, blockers: v.blockers, actor })
    // Validation already passed, so a refusal here is the state changing under
    // us (a subtask reopened, a blocker deleted) — a conflict, not bad input.
    if (r?.error) return { status: 409, body: { ok: false, message: r.error } }
    const warning = [r?.warning, projectMoveNote(task, v.updates)].filter(Boolean).join('\n')
    return {
      status: 200,
      body: { ok: true, task: { id: task.id, status: v.updates.status ?? task.status }, warning, lines: r?.dep?.lines ?? [], unchanged: false },
    }
  })
}

/** Why a new task's channel is not in its project's section, in plain words ('' when it is). */
function placementNote(project, type, fellBack) {
  const label = type === 'bug' ? 'Bugs' : 'Features'
  if (fellBack === 'cap') return `${project.name}'s section is full, so the channel went to the global ${label} category.`
  if (fellBack === 'missing') return `${project.name} has no Discord section yet, so the channel went to the global ${label} category. Run /project-setup for it.`
  return ''
}

/** A site create: a Feature or a Bug under a project, made exactly as /create-task makes it. */
export async function handleCreateRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, create = createTask }) {
  return guarded({ headers, body, secret, route: 'create' }, async (b) => {
    const [idErr, projectId] = idFrom(b.projectId, 'projectId')
    if (idErr) return bad(idErr)
    const project = await dbArg.project.findFirst({ where: { id: projectId } })
    if (!project) return bad('No project matches that id.')
    const { cfg, guild } = await guildOf(dbArg, client, project.guildConfigId)
    if (!cfg || !guild) return { status: 500, body: { ok: false, message: 'The Discord server is not available to the bot right now.' } }

    const memberIds = await memberIdsOf(dbArg, cfg.id)
    const repos = await dbArg.repository.findMany({ where: { guildConfigId: cfg.id } })
    const reposById = new Map((repos || []).map((r) => [String(r.id), r]))
    const v = validateCreate(b, { project, memberIds, reposById })
    if (v.error) return bad(v.error)

    const { label, activityId } = await siteActor(dbArg, cfg.id, b.actor)
    const repo = v.fields.type === 'bug' && v.fields.repositoryIds[0] ? reposById.get(v.fields.repositoryIds[0]) : null
    const made = await create({ db: dbArg, guild, cfg, fields: v.fields, project, repo, actor: { discordId: activityId, label, viaSite: true } })
    return {
      status: 200,
      body: {
        ok: true,
        task: { id: made.task.id, type: made.task.type ?? v.fields.type, status: made.task.status, projectId: project.id },
        channelId: made.channel?.id ?? null,
        fellBack: made.fellBack ?? null,
        note: placementNote(project, v.fields.type, made.fellBack ?? null),
      },
    }
  })
}

/** A site "Add subtask": createSubtask with the site user as the actor. */
export async function handleSubtaskRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, addSubtask = createSubtask }) {
  return guarded({ headers, body, secret, route: 'subtask' }, async (b) => {
    const [idErr, parentId] = idFrom(b.parentId, 'parentId')
    if (idErr) return bad(idErr)
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    if (!title) return bad('A subtask needs a title.')
    if (title.length > 200) return bad('The title can be at most 200 characters.')
    const parent = await dbArg.task.findFirst({ where: { id: parentId } })
    if (!parent) return { status: 404, body: { ok: false, message: 'Task not found' } }
    let assigneeIds = []
    if (b.holderIds !== undefined) {
      const v = validateEdit(parent, { holderIds: b.holderIds }, { memberIds: await memberIdsOf(dbArg, parent.guildConfigId) })
      if (v.error) return bad(v.error)
      assigneeIds = [...new Set(b.holderIds.map((id) => id.trim()).filter(Boolean))]
    }
    const actor = await siteActor(dbArg, parent.guildConfigId, b.actor)
    const { guild } = await guildOf(dbArg, client, parent.guildConfigId)
    const child = await addSubtask({
      db: dbArg, client, guild, parent, fields: { title, assigneeIds }, actor,
      notify: notifyTaskUpdate, apply: applyTaskUpdate,
    })
    return { status: 200, body: { ok: true, task: { id: child.id, status: child.status, parentId: child.parentTaskId ?? parent.id } } }
  })
}
```

- [ ] **Step 4: `createSubtask` accepts a site actor.** In `bot/src/services/taskHierarchy.js` `createSubtask`: change `createdBy: actor.discordId ?? null,` to `createdBy: actor.discordId ?? actor.activityId ?? null,` and the `recordTaskActivity` call's `actor` argument to `actor: { discordId: actor.discordId ?? actor.activityId ?? null, label: actor.label ?? null }`. Leave the `notify(...)` call as it is (it mentions only `actor.discordId`). Add to `bot/src/services/taskHierarchy.test.js`:

```js
test('createSubtask: a site actor is the creator and the activity actor, never a mention', async () => {
  const log = []
  const db = {
    task: {
      findChildren: async () => [],
      create: async ({ data }) => { log.push(['create', data.createdBy]); return { id: 'S1', ...data } },
      findFirst: async () => null,
    },
    taskActivity: { add: async ({ data }) => { log.push(['activity', data.actorDiscordId, data.actorLabel]) } },
  }
  let notified
  await createSubtask({
    db, client: {}, guild: null, parent: { id: 'P', guildConfigId: 'g1', parentTaskId: null }, fields: { title: 'x' },
    actor: { activityId: 'u-site', label: 'Ana (via the site)' },
    notify: async (a) => { notified = a }, apply: async () => ({}),
  })
  assert.deepEqual(log.slice(0, 2), [['create', 'u-site'], ['activity', 'u-site', 'Ana (via the site)']])
  assert.equal(notified.actorId, null)
  assert.equal(notified.actorLabel, 'Ana (via the site)')
})
```
(If `taskHierarchy.test.js` imports differ, import `createSubtask` from `./taskHierarchy.js`. If `syncParent` needs more of the fake db, give `findFirst` a parent row `{ id: 'P', status: 'open', guildConfigId: 'g1' }` and `findChildren` the created child — keep the assertions.)

- [ ] **Step 5: One dispatch table in `bot/src/server.js`.** Replace the `/internal/tasks/status` block with:

```js
import { handleCreateRequest, handleStatusRequest, handleSubtaskRequest, handleUpdateRequest } from './services/internalTaskRoute.js'

// Loopback routes CSAAS calls on behalf of a signed-in site user. Bodies are
// capped (a create carries a 2000-character description plus id lists, well
// under this) so a runaway caller cannot exhaust memory.
const INTERNAL_ROUTES = {
  '/internal/tasks/status': handleStatusRequest,
  '/internal/tasks/update': handleUpdateRequest,
  '/internal/tasks/create': handleCreateRequest,
  '/internal/tasks/subtask': handleSubtaskRequest,
}
const INTERNAL_MAX_BODY = 64 * 1024
```
and inside the request handler, where the old block was:

```js
    const internal = req.method === 'POST' ? INTERNAL_ROUTES[req.url] : null
    if (internal) {
      try {
        req.setEncoding('utf8')
        let ibody
        try {
          ibody = await readBody(req, INTERNAL_MAX_BODY)
        } catch (err) {
          if (err.code === 'PAYLOAD_TOO_LARGE') return send(res, 413, { ok: false, message: 'Payload too large' })
          throw err
        }
        let idata
        try {
          idata = JSON.parse(ibody)
        } catch {
          return send(res, 400, { ok: false, message: 'Invalid JSON' })
        }
        const r = await internal({ headers: req.headers, body: idata, client: discordClient, secret: process.env.BOT_INTERNAL_SECRET || '' })
        return send(res, r.status, r.body)
      } catch (e) {
        console.error(`[internal] ${req.url}:`, e?.message ?? e)
        if (!res.headersSent) send(res, 500, { ok: false, message: 'internal error' })
      }
      return
    }
```
Keep the existing startup log line about the route being enabled/disabled; make it say `[internal] task routes enabled` / `disabled: BOT_INTERNAL_SECRET unset` if it names only the status route.

- [ ] **Step 6: Run the route suite and the full bot suite**

Run: `DATABASE_URL=poisoned://no-production-access node --test bot/src/services/internalTaskRoute.test.js bot/src/services/taskHierarchy.test.js`
Expected: `# fail 0`.
Run (repo root): `DATABASE_URL=poisoned://no-production-access npm test`
Expected: `# fail 0`.

- [ ] **Step 7: Knowledge.** In `.claude/knowledge/project-tasks-site.md`, add a section `## Site create, edit and add-subtask (2026-09-28)` covering: the three routes and their bodies/codes (copy the Interfaces block above); that validation is whole-request in `utils/taskEditRules.js` before any write and a write-time refusal is 409; holders go to `assigneeIds` for every type and the emptied-bug rule; site-created bugs get a project-section channel via `createTaskTicketChannel`, Discord's project-less bugs keep the global Bugs code; the creator is the email match (null when none) and is admitted to the channel but not made a holder; `createSubtask` takes `activityId`; the 64 KB internal body cap. Update the `README.md` index line for this file to mention "site create/edit".

- [ ] **Step 8: Commit**

```bash
git add bot/src/services/internalTaskRoute.js bot/src/services/internalTaskRoute.test.js bot/src/services/taskHierarchy.js bot/src/services/taskHierarchy.test.js bot/src/server.js .claude/knowledge/project-tasks-site.md .claude/knowledge/README.md
git commit -m "feat(internal): create, update and add-subtask routes for the site

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
## CSAAS (Tasks 5–7) — repo `CSAAS_Backend`, branch `feat/site-task-edit` (create from `main`)

Before Task 5: `git -C "D:/Work/Granjur Technologies/CSAAS_Backend" checkout main && git -C "D:/Work/Granjur Technologies/CSAAS_Backend" checkout -b feat/site-task-edit`. Read `CLAUDE.md` and `.claude/rules/safety.md` in that repo first; they bind.

Every file under `Src/Apis/` is `require()`d at startup by `Services/SysScripts/ServerScripts/requiringScript.js`; a helper module there that declares no `global.*_object` is harmless (`DiscordTasks/timeScope.js` is the precedent). An endpoint `POST /api/discord/tasks/<x>` resolves to `global.DiscordTasks<X>_object` (first letter of each path segment upper-cased, rest lower-cased).

### Task 5: One bot-call helper `DiscordTasks/botLink.js`

**Files:**
- Create: `Src/Apis/ProjectSpecificApis/DiscordTasks/botLink.js`
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksStatus.js` (use the helper; behaviour identical)
- Create: `Services/SysScripts/TestScripts/discord-tasks-test/botLink.test.js`

**Interfaces:**
- Produces (CommonJS `module.exports`):
  - `fail(statusCode, message) → { statusCode, message }` — the shape the pipeline turns into an HTTP status.
  - `botConfig(hooks) → { secret, base }`; throws `fail(503, "Discord bot link is not configured")` when `DISCORD_BOT_SECRET` is unset. `base` is `DISCORD_BOT_URL` (default `http://127.0.0.1:4070`) without trailing slashes.
  - `siteActor(hooks, decryptedPayload) → Promise<{ email: string|null, name: string|null }>` — email only when `__identityVerified`, lower-cased and trimmed; name from `users` via `hooks.executeQuery`, best-effort.
  - `callBot(hooks, path, body) → Promise<object>` — POSTs JSON with `x-internal-secret` and a 15 s `AbortSignal.timeout`; returns the bot's parsed object on 2xx; throws `fail(...)`: network error → 502 "Discord bot is not reachable"; 404 → 404 "Task not found"; 400 → 400 (bot message or "Rejected by the Discord bot"); 409 → 409 (bot message or "That change is not allowed right now"); 401/503 → 502 "Discord bot rejected the request (configuration)"; other non-2xx → 502 (bot message or "Discord bot error"); unreadable 2xx → 502 "Discord bot returned an unreadable reply".
  - `hooks` is the caller's own `__hooks` object: `{ fetch, env, executeQuery }`.

- [ ] **Step 1: Write the failing test** — `Services/SysScripts/TestScripts/discord-tasks-test/botLink.test.js`:

```js
const assert = require("assert");
const { callBot, botConfig, siteActor, fail } = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/botLink");

// Nothing here opens a socket or a DB connection: fetch, env and executeQuery are
// plain functions handed in as `hooks`, the same seam every handler module uses.
function res(status, body, { throws = false } = {}) {
  return { status, ok: status >= 200 && status < 300, json: async () => { if (throws) throw new Error("bad json"); return body; } };
}
async function thrown(fn) {
  try { await fn(); } catch (e) { return e; }
  throw new assert.AssertionError({ message: "expected the call to reject, it resolved" });
}
const env = (o = {}) => () => ({ DISCORD_BOT_SECRET: "s3cret", DISCORD_BOT_URL: "http://127.0.0.1:4070/", ...o });

async function run() {
  assert.deepStrictEqual(fail(400, "x"), { statusCode: 400, message: "x" });

  // No secret: 503, and the bot is never called.
  let fetched = 0;
  let e = await thrown(() => callBot({ env: () => ({}), fetch: async () => { fetched += 1; } }, "/internal/tasks/update", {}));
  assert.deepStrictEqual(e, { statusCode: 503, message: "Discord bot link is not configured" });
  assert.strictEqual(fetched, 0);
  assert.deepStrictEqual(botConfig({ env: env() }), { secret: "s3cret", base: "http://127.0.0.1:4070" });
  assert.strictEqual(botConfig({ env: () => ({ DISCORD_BOT_SECRET: "k" }) }).base, "http://127.0.0.1:4070");

  // The request: URL, headers, JSON body, a timeout signal.
  const calls = [];
  const out = await callBot({ env: env(), fetch: async (...a) => { calls.push(a); return res(200, { ok: true, task: { id: "t1" } }); } }, "/internal/tasks/create", { a: 1 });
  assert.deepStrictEqual(out, { ok: true, task: { id: "t1" } });
  assert.strictEqual(calls[0][0], "http://127.0.0.1:4070/internal/tasks/create");
  assert.strictEqual(calls[0][1].method, "POST");
  assert.deepStrictEqual(calls[0][1].headers, { "content-type": "application/json", "x-internal-secret": "s3cret" });
  assert.strictEqual(calls[0][1].body, JSON.stringify({ a: 1 }));
  assert.ok(calls[0][1].signal, "every call carries a timeout signal");

  // Network failure.
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a);
  try {
    e = await thrown(() => callBot({ env: env(), fetch: async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); } }, "/x", {}));
    assert.deepStrictEqual(e, { statusCode: 502, message: "Discord bot is not reachable" });
    assert.ok(!JSON.stringify(errs).includes("s3cret"), "the secret is never logged");
  } finally { console.error = orig; }

  // The mapping, one row per bot reply.
  const table = [
    [res(404, { message: "nope" }), 404, "Task not found"],
    [res(400, { message: "Pick a project for the task." }), 400, "Pick a project for the task."],
    [res(400, {}), 400, "Rejected by the Discord bot"],
    [res(409, { message: "Git Sync can't be marked done yet" }), 409, "Git Sync can't be marked done yet"],
    [res(409, null), 409, "That change is not allowed right now"],
    [res(401, { message: "unauthorized" }), 502, "Discord bot rejected the request (configuration)"],
    [res(503, { message: "internal route not configured" }), 502, "Discord bot rejected the request (configuration)"],
    [res(500, { message: "The Discord server is not available to the bot right now." }), 502, "The Discord server is not available to the bot right now."],
    [res(500, null, { throws: true }), 502, "Discord bot error"],
    [res(200, null), 502, "Discord bot returned an unreadable reply"],
    [res(200, [1, 2]), 502, "Discord bot returned an unreadable reply"],
    [res(200, null, { throws: true }), 502, "Discord bot returned an unreadable reply"],
  ];
  for (const [reply, statusCode, message] of table) {
    e = await thrown(() => callBot({ env: env(), fetch: async () => reply }, "/x", {}));
    assert.deepStrictEqual(e, { statusCode, message }, `bot ${reply.status}`);
  }

  // The actor: only a token-verified email is trusted.
  let queried = 0;
  const q = async () => { queried += 1; return [{ name: "Aashir Khan" }]; };
  assert.deepStrictEqual(await siteActor({ executeQuery: q }, { actor_email: "forged@x.com" }), { email: null, name: null });
  assert.strictEqual(queried, 0);
  assert.deepStrictEqual(await siteActor({ executeQuery: q }, { actor_email: "  A@Granjur.com ", __identityVerified: true }), { email: "a@granjur.com", name: "Aashir Khan" });
  assert.deepStrictEqual(await siteActor({ executeQuery: async () => { throw new Error("db down"); } }, { actor_email: "a@granjur.com", __identityVerified: true }), { email: "a@granjur.com", name: null });

  console.log("botLink.test.js: all assertions passed");
}
run().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails**

Run (CSAAS root): `node Services/SysScripts/TestScripts/discord-tasks-test/botLink.test.js`
Expected: FAIL — `Cannot find module …/botLink`.

- [ ] **Step 3: Write `Src/Apis/ProjectSpecificApis/DiscordTasks/botLink.js`.** Move `ACTOR_NAME_SQL` with its comment and the fetch + mapping code (with its comments) out of `discordTasksStatus.js`:

```js
// The one loopback call from CSAAS into the Discord bot, shared by every
// discord-tasks write endpoint (status, create, update, subtask), and the one
// mapping from the bot's reply to what CSAAS returns. Declares no API object.
//
// `hooks` is the calling module's own __hooks ({ fetch, env, executeQuery }), so
// each handler's test script substitutes them: nothing here opens a socket or a
// database connection by itself.
//
// Trust boundary: the shared secret never leaves this process, and the bot's
// internal routes are loopback-only. A missing secret means the link is not
// configured — we refuse (503) rather than calling the bot without the header.

const BOT_TIMEOUT_MS = 15000;

// The pipeline turns a thrown { statusCode, message } into that HTTP status:
// Services/Middlewares/config.js postProcessHandler -> createMiddlewareError
// (statusCode preserved) -> middlewares.js -> LogError -> res.status(...).
const fail = (statusCode, message) => ({ statusCode, message });

// (ACTOR_NAME_SQL and its comment, moved verbatim from discordTasksStatus.js)
const ACTOR_NAME_SQL =
  "SELECT CONCAT_WS(' ', first_name, last_name) AS name FROM users WHERE LOWER(TRIM(email)) = ? LIMIT 1";

function botConfig(hooks) {
  const env = hooks.env() || {};
  const secret = env.DISCORD_BOT_SECRET;
  if (!secret) throw fail(503, "Discord bot link is not configured");
  const base = String(env.DISCORD_BOT_URL || "http://127.0.0.1:4070").replace(/\/+$/, "");
  return { secret, base };
}

// ONLY a token-bound identity may name the actor (see the long comment this
// replaces in discordTasksStatus.js: actorBinding.js sets actor_email and
// __identityVerified solely from the verified token; anything else is forgeable).
async function siteActor(hooks, decryptedPayload) {
  const email = decryptedPayload?.__identityVerified
    ? String(decryptedPayload.actor_email || "").toLowerCase().trim() || null
    : null;
  if (!email) return { email: null, name: null };
  try {
    const rows = await hooks.executeQuery(ACTOR_NAME_SQL, [email]);
    return { email, name: rows?.[0]?.name || null };
  } catch (_) {
    return { email, name: null };
  }
}

async function callBot(hooks, path, body) {
  const { secret, base } = botConfig(hooks);
  let res;
  try {
    res = await hooks.fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BOT_TIMEOUT_MS),
    });
  } catch (e) {
    // Log the shape of the failure so a silent 502 is diagnosable — never the
    // request init, which carries the shared secret in its headers.
    console.error("[discord-tasks] bot unreachable:", e?.name, e?.code);
    throw fail(502, "Discord bot is not reachable");
  }
  // (the parse + mapping block, moved verbatim with its comments)
  let parsed;
  try { parsed = await res.json(); } catch (_) { parsed = undefined; }
  const readable = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  const data = readable ? parsed : {};
  if (res.status === 404) throw fail(404, "Task not found");
  if (res.status === 400) throw fail(400, data.message || "Rejected by the Discord bot");
  if (res.status === 409) throw fail(409, data.message || "That change is not allowed right now");
  if (res.status === 401 || res.status === 503) throw fail(502, "Discord bot rejected the request (configuration)");
  if (!res.ok) throw fail(502, data.message || "Discord bot error");
  if (!readable) throw fail(502, "Discord bot returned an unreadable reply");
  return data;
}

module.exports = { BOT_TIMEOUT_MS, fail, botConfig, siteActor, callBot };
```

- [ ] **Step 4: Rewire `discordTasksStatus.js`.** Keep its header comment, `STATUSES`, `MAX_TASK_ID`, `__hooks`, `__setTestHooks`, the validation block and the API object exactly. Replace `fail`, `ACTOR_NAME_SQL`, `actorName`, the env block, the actor block and the fetch/mapping block with:

```js
const { botConfig, callBot, fail, siteActor } = require("./botLink");
// …
  // Checked before the actor lookup, as before: a link that is not configured
  // refuses without touching the users table.
  botConfig(__hooks);
  const { email, name } = await siteActor(__hooks, decryptedPayload);
  const data = await callBot(__hooks, "/internal/tasks/status", { taskId, status, actor: { email, name } });
  console.log(`[discord-tasks] ${email || "unknown"} set ${taskId} -> ${status}`);
  return { task: data.task, warning: data.warning || "", unchanged: !!data.unchanged };
```
`BOT_TIMEOUT_MS` is no longer used in this file; remove it.

- [ ] **Step 5: Run the new test and the unchanged status test**

Run: `node Services/SysScripts/TestScripts/discord-tasks-test/botLink.test.js && node Services/SysScripts/TestScripts/discord-tasks-test/status.test.js`
Expected: both print `… all assertions passed`. `status.test.js` must pass **unmodified**.

- [ ] **Step 6: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/botLink.js Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksStatus.js Services/SysScripts/TestScripts/discord-tasks-test/botLink.test.js
git commit -m "refactor(discord-tasks): one loopback helper for every bot write

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The three write endpoints `DiscordTasks/discordTasksWrite.js`

**Files:**
- Create: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksWrite.js`
- Create: `Services/SysScripts/TestScripts/discord-tasks-test/write.test.js`

**Interfaces:**
- Consumes: `botConfig`, `callBot`, `siteActor`, `fail` (Task 5); `requirePortalPermission` (`Src/HelperFunctions/PreProcessingFunctions/ProjectTenancy/portalAuthz.js`).
- Produces (site-facing, all `POST`, `accesstoken` header, snake_case JSON; responses unwrapped by the site as `payload.return`):
  - `/api/discord/tasks/create` `{ type, title, description, project_id, scope, modules, holder_ids, repository_ids, tracks: { api_tests, qa_tests, acceptance_criteria } }` → `{ task: { id, type, status, projectId }, channelId, fellBack, note }`.
  - `/api/discord/tasks/update` `{ task_id, changes: { status?, title?, description?, scope?, implementation_status?, project_id?, holder_ids?, passed_api_tests?, passed_qa_tests?, passed_acceptance_criteria?, estimate?, blocker_ids? } }` → `{ task: { id, status }, warning, lines, unchanged }`.
  - `/api/discord/tasks/subtask` `{ parent_id, title, holder_ids? }` → `{ task: { id, status, parentId } }`.
  - Globals `DiscordTasksCreate_object`, `DiscordTasksUpdate_object`, `DiscordTasksSubtask_object`; exports `createTask`, `updateTask`, `addSubtask`, `__setTestHooks`.

- [ ] **Step 1: Write the failing test** — `Services/SysScripts/TestScripts/discord-tasks-test/write.test.js`:

```js
const assert = require("assert");
const mod = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksWrite");
const { createTask, updateTask, addSubtask, __setTestHooks } = mod;

const ENV_OK = { DISCORD_BOT_SECRET: "s3cret", DISCORD_BOT_URL: "http://127.0.0.1:4070" };
function res(status, body) { return { status, ok: status >= 200 && status < 300, json: async () => body }; }
async function thrown(fn) {
  try { await fn(); } catch (e) { return e; }
  throw new assert.AssertionError({ message: "expected the call to reject, it resolved" });
}
function hooks({ permission, reply } = {}) {
  const calls = [];
  __setTestHooks({
    requirePortalPermission: permission || (async () => ({ urddId: 7 })),
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return reply || res(200, { ok: true, task: { id: "t1", status: "open" } }); },
    executeQuery: async () => [{ name: "Aashir Khan" }],
    env: () => ENV_OK,
  });
  return calls;
}
const who = { actor_email: "a@granjur.com", __identityVerified: true };

async function run() {
  // The three objects: same flags as DiscordTasksStatus_object.
  for (const [name, handler, fields] of [
    ["DiscordTasksCreate_object", createTask, ["type", "title", "description", "project_id", "scope", "modules", "holder_ids", "repository_ids", "tracks"]],
    ["DiscordTasksUpdate_object", updateTask, ["task_id", "changes"]],
    ["DiscordTasksSubtask_object", addSubtask, ["parent_id", "title", "holder_ids"]],
  ]) {
    const step = global[name].versions.versionData[0]["*"].steps[0];
    assert.strictEqual(step.data.requestMetaData.requestMethod, "POST", name);
    assert.strictEqual(step.data.requestMetaData.permission, null, name);
    assert.strictEqual(step.data.requestMetaData.bindActorToToken, true, name);
    assert.strictEqual(step.config.verification.accessToken, true, name);
    assert.strictEqual(step.config.communication.encryption, false, name);
    assert.strictEqual(step.data.apiInfo.postProcessFunction, handler, name);
    assert.deepStrictEqual(step.data.parameters.fields, fields, name);
  }

  // A permission refusal propagates and the bot is never called — for all three.
  for (const [handler, payload] of [[createTask, { type: "feature" }], [updateTask, { task_id: "t1", changes: { title: "x" } }], [addSubtask, { parent_id: "t1", title: "x" }]]) {
    const calls = hooks({ permission: async () => { throw { statusCode: 403, message: "Permission 'update_discord_tasks' is required for this action" }; } });
    const e = await thrown(() => handler({}, payload));
    assert.strictEqual(e.statusCode, 403);
    assert.strictEqual(calls.length, 0);
  }

  // Update: snake_case in, camelCase to the bot, verified actor attached.
  let calls = hooks({ reply: res(200, { ok: true, task: { id: "t1", status: "done" }, warning: "⛔ x", lines: ["l"], unchanged: false }) });
  let out = await updateTask({}, { ...who, task_id: " t1 ", changes: {
    status: "done", title: "T", description: null, scope: null, implementation_status: "done", project_id: null,
    holder_ids: ["u1"], passed_api_tests: 3, passed_qa_tests: 0, passed_acceptance_criteria: 1, estimate: "2h", blocker_ids: [],
  } });
  assert.strictEqual(calls[0].url, "http://127.0.0.1:4070/internal/tasks/update");
  assert.deepStrictEqual(calls[0].body, {
    taskId: "t1",
    changes: { status: "done", title: "T", description: null, scope: null, implementationStatus: "done", projectId: null,
      holderIds: ["u1"], passedApiTests: 3, passedQaTests: 0, passedAcceptanceCriteria: 1, estimate: "2h", blockerIds: [] },
    actor: { email: "a@granjur.com", name: "Aashir Khan" },
  });
  assert.deepStrictEqual(out, { task: { id: "t1", status: "done" }, warning: "⛔ x", lines: ["l"], unchanged: false });

  // Update shape refusals, none of which reach the bot.
  for (const [payload, message] of [
    [{ changes: { title: "x" } }, "task_id is required"],
    [{ task_id: ["t1"], changes: { title: "x" } }, "task_id must be a string"],
    [{ task_id: "x".repeat(65), changes: { title: "x" } }, "task_id must be 64 characters or fewer"],
    [{ task_id: "t1" }, "changes must be an object"],
    [{ task_id: "t1", changes: [] }, "changes must be an object"],
    [{ task_id: "t1", changes: {} }, "Nothing to update"],
    [{ task_id: "t1", changes: { priority: "high" } }, "Unknown field: priority"],
    [{ task_id: "t1", changes: { passed_api_tests: "3" } }, "passed_api_tests must be a whole number"],
    [{ task_id: "t1", changes: { title: 5 } }, "title must be text"],
    [{ task_id: "t1", changes: { holder_ids: "u1" } }, "holder_ids must be a list of ids"],
    [{ task_id: "t1", changes: { blocker_ids: Array.from({ length: 51 }, (_, i) => `b${i}`) } }, "blocker_ids can hold at most 50 entries"],
  ]) {
    calls = hooks();
    const e = await thrown(() => updateTask({}, payload));
    assert.deepStrictEqual(e, { statusCode: 400, message }, JSON.stringify(payload));
    assert.strictEqual(calls.length, 0);
  }

  // The bot's own refusal passes through with its sentence (botLink mapping).
  hooks({ reply: res(400, { ok: false, message: "Pick a project for the task." }) });
  let e = await thrown(() => createTask({}, { type: "feature", title: "x" }));
  assert.deepStrictEqual(e, { statusCode: 400, message: "Pick a project for the task." });

  // Create: the body the bot sees.
  calls = hooks({ reply: res(200, { ok: true, task: { id: "n1", type: "bug", status: "pending", projectId: "P1" }, channelId: "c1", fellBack: null, note: "" }) });
  out = await createTask({}, { ...who, type: "bug", title: "Crash", description: "It broke", project_id: "P1", scope: "backend",
    modules: [], holder_ids: ["u1"], repository_ids: ["R1"], tracks: { api_tests: true, qa_tests: false } });
  assert.strictEqual(calls[0].url, "http://127.0.0.1:4070/internal/tasks/create");
  assert.deepStrictEqual(calls[0].body, {
    type: "bug", title: "Crash", description: "It broke", projectId: "P1", scope: "backend", modules: [], holderIds: ["u1"],
    repositoryIds: ["R1"], tracks: { apiTests: true, qaTests: false, acceptanceCriteria: false },
    actor: { email: "a@granjur.com", name: "Aashir Khan" },
  });
  assert.deepStrictEqual(out, { task: { id: "n1", type: "bug", status: "pending", projectId: "P1" }, channelId: "c1", fellBack: null, note: "" });

  // Create shape refusals.
  for (const [payload, message] of [
    [{ type: 5, title: "x", project_id: "P1" }, "type must be text"],
    [{ type: "feature", title: "x", project_id: "P1", modules: "auth" }, "modules must be a list of names"],
    [{ type: "feature", title: "x", project_id: "P1", repository_ids: Array.from({ length: 21 }, (_, i) => `r${i}`) }, "repository_ids can hold at most 20 entries"],
    [{ type: "feature", title: "x", project_id: "P1", tracks: [] }, "tracks must be an object"],
  ]) {
    calls = hooks();
    e = await thrown(() => createTask({}, payload));
    assert.deepStrictEqual(e, { statusCode: 400, message }, JSON.stringify(payload));
    assert.strictEqual(calls.length, 0);
  }

  // Subtask.
  calls = hooks({ reply: res(200, { ok: true, task: { id: "s1", status: "open", parentId: "t1" } }) });
  out = await addSubtask({}, { ...who, parent_id: "t1", title: "Write tests", holder_ids: ["u2"] });
  assert.strictEqual(calls[0].url, "http://127.0.0.1:4070/internal/tasks/subtask");
  assert.deepStrictEqual(calls[0].body, { parentId: "t1", title: "Write tests", holderIds: ["u2"], actor: { email: "a@granjur.com", name: "Aashir Khan" } });
  assert.deepStrictEqual(out, { task: { id: "s1", status: "open", parentId: "t1" } });
  hooks({ reply: res(409, { ok: false, message: "A task can have at most 25 subtasks." }) });
  e = await thrown(() => addSubtask({}, { parent_id: "t1", title: "x" }));
  assert.deepStrictEqual(e, { statusCode: 409, message: "A task can have at most 25 subtasks." });

  console.log("write.test.js: all assertions passed");
}
run().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node Services/SysScripts/TestScripts/discord-tasks-test/write.test.js`
Expected: FAIL — `Cannot find module …/discordTasksWrite`.

- [ ] **Step 3: Write `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksWrite.js`:**

```js
const { requirePortalPermission } = require("../../../HelperFunctions/PreProcessingFunctions/ProjectTenancy/portalAuthz");
const { executeQuery } = require("../../../../Services/Integrations/Database/queryExecution");
const { botConfig, callBot, fail, siteActor } = require("./botLink");

// POST /api/discord/tasks/create, /api/discord/tasks/update, /api/discord/tasks/subtask
//
// The site's create, edit and add-subtask. Same trust shape as
// discordTasksStatus.js (read its header): CSAAS never writes the bot's tables;
// it checks the caller's permission and the SHAPE of the request, then asks the
// bot over loopback. Every rule about the VALUES (which statuses, which members,
// cycles, limits) lives in the bot's utils/taskEditRules.js, so the site can never
// accept something Discord would refuse and the two cannot drift apart.

const PERMISSION = "update_discord_tasks";
const MAX_ID = 64;
const MAX_IDS = 50;
const MAX_REPOSITORIES = 20;
const MAX_MODULES = 20;
const MAX_NAME = 100;
// Generous on purpose: the bot enforces the real limits (200 / 2000) and says so
// in a sentence; this only stops an absurd body before the loopback call.
const MAX_TEXT = 5000;

// The seam the test script substitutes (mirrors discordTasksStatus.js).
const __hooks = {
  requirePortalPermission: (...a) => requirePortalPermission(...a),
  fetch: (...a) => globalThis.fetch(...a),
  executeQuery: (...a) => executeQuery(...a),
  env: () => process.env,
};
function __setTestHooks(overrides) { Object.assign(__hooks, overrides); }

function idOf(value, field) {
  if (value === undefined || value === null || value === "") throw fail(400, `${field} is required`);
  if (typeof value !== "string") throw fail(400, `${field} must be a string`);
  const v = value.trim();
  if (!v) throw fail(400, `${field} is required`);
  if (v.length > MAX_ID) throw fail(400, `${field} must be ${MAX_ID} characters or fewer`);
  return v;
}

function textOf(value, field, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== "string") throw fail(400, `${field} must be text`);
  if (value.length > MAX_TEXT) throw fail(400, `${field} is too long`);
  return value;
}

function listOf(value, field, { max, maxLen, noun }) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.length > maxLen)) {
    throw fail(400, `${field} must be a list of ${noun}`);
  }
  if (value.length > max) throw fail(400, `${field} can hold at most ${max} entries`);
  return value;
}
const idsOf = (value, field) => listOf(value, field, { max: MAX_IDS, maxLen: MAX_ID, noun: "ids" });

function countOf(value, field) {
  if (!Number.isInteger(value)) throw fail(400, `${field} must be a whole number`);
  return value;
}

// snake_case from the site -> the bot's field name, and the shape check for each.
const CHANGE_FIELDS = {
  status: ["status", (v, k) => textOf(v, k)],
  title: ["title", (v, k) => textOf(v, k)],
  description: ["description", (v, k) => textOf(v, k, { nullable: true })],
  scope: ["scope", (v, k) => textOf(v, k, { nullable: true })],
  implementation_status: ["implementationStatus", (v, k) => textOf(v, k)],
  project_id: ["projectId", (v, k) => (v === null ? null : idOf(v, k))],
  holder_ids: ["holderIds", idsOf],
  passed_api_tests: ["passedApiTests", countOf],
  passed_qa_tests: ["passedQaTests", countOf],
  passed_acceptance_criteria: ["passedAcceptanceCriteria", countOf],
  estimate: ["estimate", (v, k) => textOf(v, k, { nullable: true })],
  blocker_ids: ["blockerIds", idsOf],
};

async function updateTask(req, decryptedPayload) {
  await __hooks.requirePortalPermission(req, decryptedPayload, PERMISSION);
  const p = decryptedPayload || {};
  const taskId = idOf(p.task_id, "task_id");
  const changes = p.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw fail(400, "changes must be an object");
  const keys = Object.keys(changes);
  if (!keys.length) throw fail(400, "Nothing to update");
  const out = {};
  for (const key of keys) {
    const entry = CHANGE_FIELDS[key];
    if (!entry) throw fail(400, `Unknown field: ${key}`);
    const [to, check] = entry;
    out[to] = check(changes[key], key);
  }
  botConfig(__hooks);
  const actor = await siteActor(__hooks, p);
  const data = await callBot(__hooks, "/internal/tasks/update", { taskId, changes: out, actor });
  console.log(`[discord-tasks] ${actor.email || "unknown"} updated ${taskId}: ${Object.keys(out).join(", ")}`);
  return { task: data.task, warning: data.warning || "", lines: Array.isArray(data.lines) ? data.lines : [], unchanged: !!data.unchanged };
}

async function createTask(req, decryptedPayload) {
  await __hooks.requirePortalPermission(req, decryptedPayload, PERMISSION);
  const p = decryptedPayload || {};
  const tracks = p.tracks === undefined ? {} : p.tracks;
  if (!tracks || typeof tracks !== "object" || Array.isArray(tracks)) throw fail(400, "tracks must be an object");
  const body = {
    type: textOf(p.type, "type"),
    title: textOf(p.title ?? "", "title"),
    description: p.description === undefined ? null : textOf(p.description, "description", { nullable: true }),
    // A missing project is the bot's to refuse, in its own words.
    projectId: p.project_id === undefined || p.project_id === null || p.project_id === "" ? null : idOf(p.project_id, "project_id"),
    scope: p.scope === undefined ? null : textOf(p.scope, "scope", { nullable: true }),
    modules: listOf(p.modules ?? [], "modules", { max: MAX_MODULES, maxLen: MAX_NAME, noun: "names" }),
    holderIds: idsOf(p.holder_ids ?? [], "holder_ids"),
    repositoryIds: listOf(p.repository_ids ?? [], "repository_ids", { max: MAX_REPOSITORIES, maxLen: MAX_ID, noun: "ids" }),
    tracks: {
      apiTests: tracks.api_tests === true,
      qaTests: tracks.qa_tests === true,
      acceptanceCriteria: tracks.acceptance_criteria === true,
    },
  };
  botConfig(__hooks);
  const actor = await siteActor(__hooks, p);
  const data = await callBot(__hooks, "/internal/tasks/create", { ...body, actor });
  console.log(`[discord-tasks] ${actor.email || "unknown"} created ${data.task?.id} (${body.type}) in ${body.projectId}`);
  return { task: data.task, channelId: data.channelId ?? null, fellBack: data.fellBack ?? null, note: data.note || "" };
}

async function addSubtask(req, decryptedPayload) {
  await __hooks.requirePortalPermission(req, decryptedPayload, PERMISSION);
  const p = decryptedPayload || {};
  const parentId = idOf(p.parent_id, "parent_id");
  const title = textOf(p.title ?? "", "title");
  const holderIds = idsOf(p.holder_ids ?? [], "holder_ids");
  botConfig(__hooks);
  const actor = await siteActor(__hooks, p);
  const data = await callBot(__hooks, "/internal/tasks/subtask", { parentId, title, holderIds, actor });
  console.log(`[discord-tasks] ${actor.email || "unknown"} added subtask ${data.task?.id} to ${parentId}`);
  return { task: data.task };
}

// Same shape as DiscordTasksStatus_object: accessToken + bindActorToToken so the
// pipeline derives actor_email from the verified token, permission: null because
// each handler enforces update_discord_tasks itself.
function writeObject(fields, handler, successMessage, errorMessage) {
  return {
    versions: {
      versionData: [
        {
          "*": {
            steps: [
              {
                config: {
                  features: { multistep: false, parameters: false, pagination: false },
                  communication: { encryption: false },
                  verification: { otp: false, accessToken: true },
                },
                data: {
                  parameters: { fields },
                  apiInfo: {
                    preProcessFunctions: [],
                    query: { queryPayload: null, database: () => "main" },
                    postProcessFunction: handler,
                  },
                  requestMetaData: { requestMethod: "POST", permission: null, bindActorToToken: true },
                },
                response: { successMessage, errorMessage },
              },
            ],
          },
        },
      ],
    },
  };
}

global.DiscordTasksCreate_object = writeObject(
  ["type", "title", "description", "project_id", "scope", "modules", "holder_ids", "repository_ids", "tracks"],
  createTask, "Task created", "Failed to create the task",
);
global.DiscordTasksUpdate_object = writeObject(["task_id", "changes"], updateTask, "Task updated", "Failed to update the task");
global.DiscordTasksSubtask_object = writeObject(["parent_id", "title", "holder_ids"], addSubtask, "Subtask added", "Failed to add the subtask");

module.exports = {
  DiscordTasksCreate_object: global.DiscordTasksCreate_object,
  DiscordTasksUpdate_object: global.DiscordTasksUpdate_object,
  DiscordTasksSubtask_object: global.DiscordTasksSubtask_object,
  createTask,
  updateTask,
  addSubtask,
  __setTestHooks,
};
```

- [ ] **Step 4: Run**

Run: `node Services/SysScripts/TestScripts/discord-tasks-test/write.test.js && node Services/SysScripts/TestScripts/discord-tasks-test/status.test.js`
Expected: both `… all assertions passed`.

- [ ] **Step 5: Check the globals are unique.** Use the Grep tool (not a shell grep — it times out over `node_modules`) for `DiscordTasksCreate_object|DiscordTasksUpdate_object|DiscordTasksSubtask_object` under `Src/`. Expected: only `discordTasksWrite.js`. A second declaration anywhere silently wins ("last writer wins").

- [ ] **Step 6: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksWrite.js Services/SysScripts/TestScripts/discord-tasks-test/write.test.js
git commit -m "feat(discord-tasks): create, update and add-subtask endpoints for the site

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Repositories and member `kind` on the tasks read

**Files:**
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js` (`assembleTasks` ≈L20-199, `getDiscordTasks` ≈L201-236)
- Create: `Services/SysScripts/TestScripts/discord-tasks-test/repos.test.js`
- Modify: `Services/SysScripts/TestScripts/discord-tasks-test/avatarFallback.test.js` (query count 2 → 3)

**Interfaces:**
- Produces: the `GET /api/discord/tasks` payload gains top-level `repositories: { id: string, name: string, url: string }[]` (sorted by name, case-insensitive; `[]` when the table cannot be read) and every `members[]` entry gains `kind: 'staff' | 'client'` (`'staff'` when the column is missing or holds anything but `client`).

- [ ] **Step 1: Write the failing test** — `Services/SysScripts/TestScripts/discord-tasks-test/repos.test.js`:

```js
const assert = require("assert");
const { getDiscordTasks, assembleTasks, __setTestHooks } = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks");

// executeQuery is substituted: nothing here touches a database.
function hooks({ repos, reposThrow = false, kindColumn = true } = {}) {
  const seen = [];
  __setTestHooks({
    executeQuery: async (sql) => {
      seen.push(sql);
      if (sql.includes("FROM granjur.guildconfig")) return [{ id: "g1", guildId: "1000" }];
      if (sql.includes("FROM granjur.repository")) {
        if (reposThrow) throw new Error("Table 'granjur.repository' doesn't exist");
        return repos || [];
      }
      if (sql.includes("FROM granjur.guildmember")) {
        if (sql.includes("kind") && !kindColumn) throw new Error("Unknown column 'kind' in 'field list'");
        return [
          { guildConfigId: "g1", discordId: "u1", displayName: "Ana", username: "ana", roleNames: null, status: "approved", verifiedAt: new Date(), ...(kindColumn ? { kind: "staff" } : {}) },
          { guildConfigId: "g1", discordId: "u2", displayName: "Client Co", username: "cc", roleNames: null, status: "approved", verifiedAt: new Date(), ...(kindColumn ? { kind: "client" } : {}) },
        ];
      }
      return [];
    },
  });
  return seen;
}

async function run() {
  hooks({ repos: [{ id: "R2", guildConfigId: "g1", name: "site", url: "https://github.com/g/site" }, { id: "R1", guildConfigId: "g1", name: "Bot", url: "https://github.com/g/bot" }] });
  let out = await getDiscordTasks({ query: {} });
  assert.deepStrictEqual(out.repositories, [{ id: "R1", name: "Bot", url: "https://github.com/g/bot" }, { id: "R2", name: "site", url: "https://github.com/g/site" }]);
  assert.deepStrictEqual(out.members.map((m) => [m.discordId, m.kind]), [["u1", "staff"], ["u2", "client"]]);

  hooks({ reposThrow: true });
  out = await getDiscordTasks({ query: {} });
  assert.deepStrictEqual(out.repositories, [], "an unreadable repository table is an empty list, not a failed page");

  const seen = hooks({ kindColumn: false });
  out = await getDiscordTasks({ query: {} });
  assert.deepStrictEqual(out.members.map((m) => m.kind), ["staff", "staff"], "no kind column: everyone is staff");
  assert.ok(seen.filter((s) => s.includes("FROM granjur.guildmember")).length >= 2, "retried without kind");

  assert.deepStrictEqual(assembleTasks({}).repositories, [], "no guilds: still an empty list");
  console.log("repos.test.js: all assertions passed");
}
run().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node Services/SysScripts/TestScripts/discord-tasks-test/repos.test.js`
Expected: FAIL — `out.repositories` is undefined.

- [ ] **Step 3: Implement in `discordTasks.js`.**

In `getDiscordTasks`, replace the guildmember query with a three-step fallback (kind arrives with the bot's migration 025, avatarUrl with 020):

```js
    // kind arrives with the bot's migration 025, avatarUrl with migration 020.
    // Fall back one column at a time so the page loads on any database.
    q(`SELECT guildConfigId, discordId, displayName, username, avatarUrl, roleNames, status, verifiedAt, kind FROM granjur.guildmember WHERE guildConfigId IN (${ph})`, cfgIds)
      .catch(() => q(`SELECT guildConfigId, discordId, displayName, username, avatarUrl, roleNames, status, verifiedAt FROM granjur.guildmember WHERE guildConfigId IN (${ph})`, cfgIds)
        .catch(() => q(`SELECT guildConfigId, discordId, displayName, username, roleNames, status, verifiedAt FROM granjur.guildmember WHERE guildConfigId IN (${ph})`, cfgIds))),
```
Add an eighth entry to the `Promise.all` array and destructure it as `repositories`:

```js
    // The create form's repository picker. A missing table must not fail the page.
    q(`SELECT id, guildConfigId, name, url FROM granjur.repository WHERE guildConfigId IN (${ph})`, cfgIds).catch(() => []),
```
and pass it on: `return assembleTasks({ guilds, projects, tasks, deps, members, names, activity, time, repositories });`.

In `assembleTasks`, add `repositories = []` to the destructured parameters; in `membersOut` add after `verified`:

```js
      // A client must not be offered as an assignee on the site; everyone the bot
      // has not marked as a client is staff (the column's default).
      kind: n.kind === "client" ? "client" : "staff",
```
and change the return to:

```js
  const reposOut = repositories
    .map((r) => ({ id: String(r.id), name: String(r.name ?? ""), url: String(r.url ?? "") }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { generatedAt: new Date().toISOString(), projects: out, members: membersOut, repositories: reposOut };
```
Export `assembleTasks` from the module if it is not already exported.

- [ ] **Step 4: Update `avatarFallback.test.js`.** Its mock throws for any guildmember SQL containing `avatarUrl`, so the chain now makes three attempts (with kind, without kind, without avatarUrl). Change the assertion to:

```js
  assert.strictEqual(seen.filter((s) => s.includes("FROM granjur.guildmember")).length, 3, "tried with kind, then avatarUrl, then neither");
```

- [ ] **Step 5: Run every discord-tasks script**

Run: `for f in Services/SysScripts/TestScripts/discord-tasks-test/*.test.js; do node "$f" || echo "FAILED: $f"; done`
Expected: every file prints `… all assertions passed` and no `FAILED:` line. If `assemble.test.js` compares whole member objects or the whole payload, add `kind: "staff"` / `repositories: []` to its expectations — the new fields are intended.

- [ ] **Step 6: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js Services/SysScripts/TestScripts/discord-tasks-test/repos.test.js Services/SysScripts/TestScripts/discord-tasks-test/avatarFallback.test.js Services/SysScripts/TestScripts/discord-tasks-test/assemble.test.js
git commit -m "feat(discord-tasks): repositories and member kind on the tasks read

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
## Site (Tasks 8–11) — repo `UBS-Doc`, worktree `../UBS-Doc-site-task-edit`, branch `feat/site-task-edit`

Before Task 8, from `D:\Work\Granjur Technologies\UBS-Doc`:
`git worktree add ../UBS-Doc-site-task-edit -b feat/site-task-edit main`, then `cd ../UBS-Doc-site-task-edit && npm ci`. All paths below are relative to the worktree. Do not touch `src/styles/portal-compat.css`.

Conventions in this code: class helpers `c`, `card`, `txt`, `muted`, `chipGray`, `chipIndigo` from `src/lib`; `useTheme()` from `src/app/ThemeContext`; buttons `btn-primary`, `btn-outline-indigo` (+ `dark-variant` in dark mode); inputs `input-base` (it sets `width: 100%` and beats Tailwind width utilities — size a field through a wrapper). Pure logic lives in `*Logic.ts` next to its screen with a colocated `*.test.ts` (vitest). Screens never fetch the tasks payload themselves — `useTeam()` gives `payload`, `loading`, `error`, `refresh`.

### Task 8: Types, API calls and the form logic

**Files:**
- Modify: `src/screens/tasksLogic.ts:49-54` (types)
- Modify: `src/components/discordTasks/api.ts` (three calls)
- Modify: `src/components/discordTasks/api.test.ts` (append)
- Create: `src/screens/team/taskFormLogic.ts`
- Create: `src/screens/team/taskFormLogic.test.ts`

**Interfaces:**
- Consumes: CSAAS endpoints from Task 6; `formatDuration` (`./timeLogic`), `plainRuleMessage` (`./boardLogic`).
- Produces:
  - Types: `TeamMember.kind?: 'staff' | 'client'`; `RepoRef { id: string; name: string; url: string }`; `TasksPayload.repositories?: RepoRef[]`.
  - `api.ts`: `updateTask(taskId: string, changes: TaskChanges): Promise<UpdateTaskResult>`; `createTask(input: CreateTaskInput): Promise<CreateTaskResult>`; `addSubtask(parentId: string, title: string, holderIds: string[]): Promise<AddSubtaskResult>`; the types `TaskChanges`, `UpdateTaskResult`, `CreateTaskInput`, `CreateTaskResult`, `AddSubtaskResult`.
  - `taskFormLogic.ts`: `EditForm`, `CreateForm`, `STATUS_OPTIONS`, `SCOPE_OPTIONS`, `IMPLEMENTATION_OPTIONS`, `formFromTask(task)`, `diffChanges(task, form): TaskChanges`, `validateForm(task, form): string | null`, `emptyCreateForm(projectId?)`, `validateCreateForm(form): string | null`, `createPayload(form): CreateTaskInput`, `blockerCandidates(payload, selfId, chosen)`, `saveErrorText(err): string`, `scopeOptionsFor(current)`.

- [ ] **Step 1: Types.** In `src/screens/tasksLogic.ts`, change `TeamMember` and `TasksPayload` and add `RepoRef`:

```ts
export interface TeamMember {
  discordId: string; name: string; username: string | null; avatarUrl?: string; roleNames: string[]
  status: string; verified: boolean; projects: TeamProjectRef[]
  // 'client' for a client account; absent from an older backend (treat as staff).
  kind?: 'staff' | 'client'
}
export interface RepoRef { id: string; name: string; url: string }
// `repositories` feeds the create form; absent from an older backend.
export interface TasksPayload { generatedAt: string; projects: ProjectGroup[]; members: TeamMember[]; repositories?: RepoRef[] }
```

- [ ] **Step 2: Write the failing API tests** — append to `src/components/discordTasks/api.test.ts` (extend the dynamic import to `const { setTaskStatus, ApiError, updateTask, createTask, addSubtask } = await import('./api')`):

```ts
describe('task writes', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('updateTask posts task_id and only the changes', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ payload: { return: { task: { id: 'T1', status: 'done' }, warning: '', lines: [], unchanged: false } } }))
    const r = await updateTask('T1', { status: 'done', holder_ids: ['u1'] })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/discord/tasks/update`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ task_id: 'T1', changes: { status: 'done', holder_ids: ['u1'] } })
    expect(r.task.status).toBe('done')
  })

  it('createTask posts the input as-is and unwraps the result', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ payload: { return: { task: { id: 'N1', type: 'feature', status: 'open', projectId: 'P1' }, channelId: 'c1', fellBack: null, note: '' } } }))
    const input = { type: 'feature' as const, title: 'x', description: null, project_id: 'P1', scope: null, modules: [], holder_ids: [], repository_ids: [], tracks: { api_tests: false, qa_tests: false, acceptance_criteria: false } }
    const r = await createTask(input)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/discord/tasks/create`)
    expect(JSON.parse(init.body)).toEqual(input)
    expect(r.task.id).toBe('N1')
  })

  it('addSubtask posts parent_id, title and holder_ids', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ payload: { return: { task: { id: 'S1', status: 'open', parentId: 'T1' } } } }))
    await addSubtask('T1', 'Write tests', ['u2'])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/discord/tasks/subtask`)
    expect(JSON.parse(init.body)).toEqual({ parent_id: 'T1', title: 'Write tests', holder_ids: ['u2'] })
  })

  it('a refusal carries the specific sentence and the status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 400, message: 'Invalid request', payload: 'Pick a project for the task.' }, 400))
    await expect(updateTask('T1', { title: 'x' })).rejects.toMatchObject({ name: 'ApiError', status: 400, message: 'Pick a project for the task.' })
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/components/discordTasks/api.test.ts`
Expected: FAIL — `updateTask is not a function`.

- [ ] **Step 4: Add the calls** at the end of `src/components/discordTasks/api.ts`:

```ts
// The site's edit, create and add-subtask. CSAAS checks update_discord_tasks and
// the request's shape; the Discord bot applies the same rules /update-task and
// /create-task use and answers with a sentence when it refuses, which apiCall
// surfaces as ApiError.message (status on ApiError.status).

// Only the fields that changed; an absent key means "leave it alone".
export interface TaskChanges {
  status?: string
  title?: string
  description?: string | null
  scope?: string | null
  implementation_status?: string
  project_id?: string | null
  holder_ids?: string[]
  passed_api_tests?: number
  passed_qa_tests?: number
  passed_acceptance_criteria?: number
  estimate?: string | null
  blocker_ids?: string[]
}
export interface UpdateTaskResult { task: { id: string; status: string }; warning: string; lines: string[]; unchanged: boolean }

export async function updateTask(taskId: string, changes: TaskChanges): Promise<UpdateTaskResult> {
  return apiCall<UpdateTaskResult>('/discord/tasks/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_id: taskId, changes }),
  })
}

export interface CreateTaskInput {
  type: 'feature' | 'bug'
  title: string
  description: string | null
  project_id: string
  scope: string | null
  modules: string[]
  holder_ids: string[]
  repository_ids: string[]
  tracks: { api_tests: boolean; qa_tests: boolean; acceptance_criteria: boolean }
}
export interface CreateTaskResult {
  task: { id: string; type: string; status: string; projectId: string }
  channelId: string | null
  fellBack: 'cap' | 'missing' | null
  note: string
}

export async function createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
  return apiCall<CreateTaskResult>('/discord/tasks/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export interface AddSubtaskResult { task: { id: string; status: string; parentId: string } }

export async function addSubtask(parentId: string, title: string, holderIds: string[]): Promise<AddSubtaskResult> {
  return apiCall<AddSubtaskResult>('/discord/tasks/subtask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parent_id: parentId, title, holder_ids: holderIds }),
  })
}
```

- [ ] **Step 5: Write the failing form-logic tests** — `src/screens/team/taskFormLogic.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { TaskRow, TasksPayload } from '../tasksLogic'
import {
  formFromTask, diffChanges, validateForm, emptyCreateForm, validateCreateForm, createPayload,
  blockerCandidates, saveErrorText, scopeOptionsFor,
} from './taskFormLogic'

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'T', title: 'Git Sync', type: 'feature', status: 'open', implementationStatus: 'not_started',
    assignees: [{ discordId: 'u1', name: 'Ana' }], blockedBy: [{ id: 'B', title: 'Blocker', status: 'open' }], blocks: [],
    isBlocked: true, channelUrl: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
    description: null, scope: 'backend', modules: [], createdBy: null,
    passedApiTests: null, passedQaTests: 3, passedAcceptanceCriteria: null,
    projectId: 'P1', projectName: 'Framework', estimateMinutes: 120,
    ...over,
  }
}

describe('formFromTask / diffChanges', () => {
  it('an untouched form sends nothing, even where the DB holds null', () => {
    const t = task()
    expect(diffChanges(t, formFromTask(t))).toEqual({})
    expect(formFromTask(t)).toMatchObject({ description: '', estimate: '2h', passedApiTests: '', passedQaTests: '3', holderIds: ['u1'], blockerIds: ['B'] })
  })
  it('sends exactly the changed fields in API names', () => {
    const t = task()
    const f = { ...formFromTask(t), title: ' Renamed ', description: 'Now described', status: 'in_progress', scope: '', projectId: '',
      implementationStatus: 'done', holderIds: ['u2', 'u1'], passedApiTests: '4', estimate: '8h 30m', blockerIds: [] }
    expect(diffChanges(t, f)).toEqual({
      title: 'Renamed', description: 'Now described', status: 'in_progress', scope: null, project_id: null,
      implementation_status: 'done', holder_ids: ['u2', 'u1'], passed_api_tests: 4, estimate: '8h 30m', blocker_ids: [],
    })
  })
  it('lists are compared as sets; whitespace-only text edits are not changes', () => {
    const t = task({ assignees: [{ discordId: 'u1', name: 'Ana' }, { discordId: 'u2', name: 'Bo' }] })
    const f = { ...formFromTask(t), holderIds: ['u2', 'u1'], title: 'Git Sync  ', description: '   ' }
    expect(diffChanges(t, f)).toEqual({})
  })
  it('a cleared estimate is sent as null; a cleared description as null', () => {
    const t = task({ description: 'old' })
    expect(diffChanges(t, { ...formFromTask(t), estimate: '', description: '' })).toEqual({ estimate: null, description: null })
  })
  it('an unset implementation status is left alone until one is picked', () => {
    const t = task({ implementationStatus: null })
    expect(formFromTask(t).implementationStatus).toBe('')
    expect(diffChanges(t, formFromTask(t))).toEqual({})
  })
})

describe('validateForm', () => {
  it('title required and capped; description capped', () => {
    const t = task()
    expect(validateForm(t, { ...formFromTask(t), title: '  ' })).toBe('A task needs a title.')
    expect(validateForm(t, { ...formFromTask(t), title: 'x'.repeat(201) })).toBe('The title can be at most 200 characters.')
    expect(validateForm(t, { ...formFromTask(t), description: 'x'.repeat(2001) })).toBe('The description can be at most 2000 characters.')
  })
  it('test counts: 0 to 127, and a set count cannot be cleared', () => {
    const t = task()
    expect(validateForm(t, { ...formFromTask(t), passedApiTests: '128' })).toBe('Test counts must be whole numbers from 0 to 127.')
    expect(validateForm(t, { ...formFromTask(t), passedApiTests: '1.5' })).toBe('Test counts must be whole numbers from 0 to 127.')
    expect(validateForm(t, { ...formFromTask(t), passedQaTests: '' })).toBe('A test count cannot be cleared. Enter a number from 0 to 127.')
    expect(validateForm(t, { ...formFromTask(t), passedApiTests: '' })).toBeNull()
    expect(validateForm(t, formFromTask(t))).toBeNull()
  })
})

describe('create form', () => {
  it('validates title, project and the bug repository limit', () => {
    expect(validateCreateForm({ ...emptyCreateForm('P1'), title: '' })).toBe('A task needs a title.')
    expect(validateCreateForm({ ...emptyCreateForm(''), title: 'x' })).toBe('Pick a project for the task.')
    expect(validateCreateForm({ ...emptyCreateForm('P1'), title: 'x', type: 'bug', repositoryIds: ['R1', 'R2'] })).toBe('A bug can name one repository.')
    expect(validateCreateForm({ ...emptyCreateForm('P1'), title: 'x' })).toBeNull()
  })
  it('builds the payload: modules split and deduped for a feature, dropped for a bug', () => {
    const f = { ...emptyCreateForm('P1'), title: ' Sync ', description: '  ', scope: 'qa', modules: 'auth, billing , auth,, ',
      holderIds: ['u1'], repositoryIds: ['R1', 'R2'], tracksApi: true }
    expect(createPayload(f)).toEqual({
      type: 'feature', title: 'Sync', description: null, project_id: 'P1', scope: 'qa', modules: ['auth', 'billing'],
      holder_ids: ['u1'], repository_ids: ['R1', 'R2'], tracks: { api_tests: true, qa_tests: false, acceptance_criteria: false },
    })
    expect(createPayload({ ...f, type: 'bug' })).toMatchObject({ type: 'bug', modules: [], repository_ids: ['R1'] })
  })
})

describe('blockerCandidates', () => {
  it('every other task, grouped by project, without self or the ones already chosen', () => {
    const payload = {
      generatedAt: '', members: [],
      projects: [
        { id: 'P2', name: 'Zeta', docsSlug: null, members: [], counts: { open: 0, in_progress: 0, pending: 0, done: 0, blocked: 0 }, tasks: [task({ id: 'Z1', title: 'Zed' })] },
        { id: 'P1', name: 'Alpha', docsSlug: null, members: [], counts: { open: 0, in_progress: 0, pending: 0, done: 0, blocked: 0 }, tasks: [task({ id: 'T' }), task({ id: 'B', title: 'Blocker' }), task({ id: 'C', title: 'Chain', status: 'done' })] },
      ],
    } as TasksPayload
    expect(blockerCandidates(payload, 'T', ['B'])).toEqual([
      { project: 'Alpha', tasks: [{ id: 'C', title: 'Chain', status: 'done' }] },
      { project: 'Zeta', tasks: [{ id: 'Z1', title: 'Zed', status: 'open' }] },
    ])
  })
})

describe('saveErrorText', () => {
  it('status first, then the sentence', () => {
    expect(saveErrorText({ status: 403, message: 'x' })).toBe('You need the update_discord_tasks permission to change tasks. Ask an admin.')
    expect(saveErrorText({ status: 404, message: 'Task not found' })).toBe('This task no longer exists. Refresh the page.')
    expect(saveErrorText({ status: 502, message: 'Discord bot rejected the request (configuration)' })).toBe('Discord bot link is misconfigured. Tell an admin.')
    expect(saveErrorText({ status: 502, message: 'Discord bot is not reachable' })).toBe('Discord bot is offline, try again.')
    expect(saveErrorText({ message: 'Failed to fetch' })).toBe('Discord bot is offline, try again.')
    expect(saveErrorText({ status: 409, message: "**Git Sync** can't be marked done yet — 1 subtask is still open:\n• Tests" })).toBe("Git Sync can't be marked done yet — 1 subtask is still open: Tests")
    expect(saveErrorText({ status: 400, message: 'u9 is not a member of this Discord server.' })).toBe('u9 is not a member of this Discord server.')
    expect(saveErrorText({})).toBe('Could not save. Try again.')
  })
})

describe('scopeOptionsFor', () => {
  it('keeps a legacy free-text scope selectable so an untouched save does not erase it', () => {
    expect(scopeOptionsFor('backend').map((o) => o.value)).toEqual(['', 'backend', 'frontend', 'qa', 'design'])
    expect(scopeOptionsFor('GitSync').map((o) => o.value)).toEqual(['', 'backend', 'frontend', 'qa', 'design', 'GitSync'])
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/screens/team/taskFormLogic.test.ts`
Expected: FAIL — cannot resolve `./taskFormLogic`.

- [ ] **Step 7: Write `src/screens/team/taskFormLogic.ts`:**

```ts
import type { TaskRow, TasksPayload } from '../tasksLogic'
import type { CreateTaskInput, TaskChanges } from '../../components/discordTasks/api'
import { formatDuration } from './timeLogic'
import { plainRuleMessage } from './boardLogic'

// The edit and create forms' pure half. The Discord bot is the authority on every
// value (utils/taskEditRules.js); these checks only give instant feedback and
// make sure an untouched field is never sent — an unchanged save must write
// nothing, post nothing and log nothing in Discord.

export const TITLE_MAX = 200
export const DESCRIPTION_MAX = 2000
export const MAX_TEST_COUNT = 127

export const STATUS_OPTIONS = ['open', 'pending', 'in_progress', 'resolved', 'closed', 'done'] as const
export const SCOPE_OPTIONS = [
  { value: 'backend', label: 'Backend' },
  { value: 'frontend', label: 'Frontend' },
  { value: 'qa', label: 'QA' },
  { value: 'design', label: 'Design' },
]
export const IMPLEMENTATION_OPTIONS = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
]

export interface EditForm {
  title: string
  description: string
  status: string
  scope: string
  implementationStatus: string
  projectId: string
  holderIds: string[]
  passedApiTests: string
  passedQaTests: string
  passedAcceptanceCriteria: string
  estimate: string
  blockerIds: string[]
}

const COUNT_FIELDS = [
  ['passedApiTests', 'passed_api_tests'],
  ['passedQaTests', 'passed_qa_tests'],
  ['passedAcceptanceCriteria', 'passed_acceptance_criteria'],
] as const

const countText = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n))
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

export function formFromTask(task: TaskRow): EditForm {
  return {
    title: task.title ?? '',
    description: task.description ?? '',
    status: task.status,
    scope: task.scope ?? '',
    implementationStatus: task.implementationStatus ?? '',
    projectId: task.projectId ?? '',
    holderIds: task.assignees.map((a) => a.discordId),
    passedApiTests: countText(task.passedApiTests),
    passedQaTests: countText(task.passedQaTests),
    passedAcceptanceCriteria: countText(task.passedAcceptanceCriteria),
    estimate: formatDuration(task.estimateMinutes ?? null) ?? '',
    blockerIds: task.blockedBy.map((b) => b.id),
  }
}

/** Only what differs from the task as loaded, in the API's field names. */
export function diffChanges(task: TaskRow, form: EditForm): TaskChanges {
  const base = formFromTask(task)
  const out: TaskChanges = {}
  const title = form.title.trim()
  if (title !== base.title.trim()) out.title = title
  const description = form.description.trim()
  if (description !== base.description.trim()) out.description = description || null
  if (form.status !== base.status) out.status = form.status
  if (form.scope !== base.scope) out.scope = form.scope || null
  if (form.implementationStatus && form.implementationStatus !== base.implementationStatus) out.implementation_status = form.implementationStatus
  if (form.projectId !== base.projectId) out.project_id = form.projectId || null
  if (!sameSet(form.holderIds, base.holderIds)) out.holder_ids = [...form.holderIds]
  for (const [key, apiKey] of COUNT_FIELDS) {
    const v = form[key].trim()
    if (v !== '' && v !== base[key]) out[apiKey] = Number(v)
  }
  const estimate = form.estimate.trim()
  if (estimate !== base.estimate) out.estimate = estimate || null
  if (!sameSet(form.blockerIds, base.blockerIds)) out.blocker_ids = [...form.blockerIds]
  return out
}

export function validateForm(task: TaskRow, form: EditForm): string | null {
  const base = formFromTask(task)
  if (!form.title.trim()) return 'A task needs a title.'
  if (form.title.trim().length > TITLE_MAX) return `The title can be at most ${TITLE_MAX} characters.`
  if (form.description.trim().length > DESCRIPTION_MAX) return `The description can be at most ${DESCRIPTION_MAX} characters.`
  for (const [key] of COUNT_FIELDS) {
    const v = form[key].trim()
    // Discord cannot put a tracked count back to "not tracked" either.
    if (v === '' && base[key] !== '') return `A test count cannot be cleared. Enter a number from 0 to ${MAX_TEST_COUNT}.`
    if (v !== '' && (!/^\d{1,3}$/.test(v) || Number(v) > MAX_TEST_COUNT)) return `Test counts must be whole numbers from 0 to ${MAX_TEST_COUNT}.`
  }
  return null
}

/** The scope select's options: "none", the four, and a legacy free-text value when the task still holds one. */
export function scopeOptionsFor(current: string): { value: string; label: string }[] {
  const opts = [{ value: '', label: 'None' }, ...SCOPE_OPTIONS]
  if (current && !SCOPE_OPTIONS.some((o) => o.value === current)) opts.push({ value: current, label: `${current} (old)` })
  return opts
}

export interface CreateForm {
  type: 'feature' | 'bug'
  title: string
  description: string
  projectId: string
  scope: string
  modules: string // comma-separated, as typed
  holderIds: string[]
  repositoryIds: string[]
  tracksApi: boolean
  tracksQa: boolean
  tracksAc: boolean
}

export function emptyCreateForm(projectId = ''): CreateForm {
  return { type: 'feature', title: '', description: '', projectId, scope: '', modules: '', holderIds: [], repositoryIds: [], tracksApi: false, tracksQa: false, tracksAc: false }
}

export function validateCreateForm(f: CreateForm): string | null {
  if (!f.title.trim()) return 'A task needs a title.'
  if (f.title.trim().length > TITLE_MAX) return `The title can be at most ${TITLE_MAX} characters.`
  if (f.description.trim().length > DESCRIPTION_MAX) return `The description can be at most ${DESCRIPTION_MAX} characters.`
  if (!f.projectId) return 'Pick a project for the task.'
  if (f.type === 'bug' && f.repositoryIds.length > 1) return 'A bug can name one repository.'
  return null
}

export function createPayload(f: CreateForm): CreateTaskInput {
  const isBug = f.type === 'bug'
  return {
    type: f.type,
    title: f.title.trim(),
    description: f.description.trim() || null,
    project_id: f.projectId,
    scope: f.scope || null,
    modules: isBug ? [] : [...new Set(f.modules.split(',').map((m) => m.trim()).filter(Boolean))],
    holder_ids: [...f.holderIds],
    repository_ids: isBug ? f.repositoryIds.slice(0, 1) : [...f.repositoryIds],
    tracks: { api_tests: f.tracksApi, qa_tests: f.tracksQa, acceptance_criteria: f.tracksAc },
  }
}

export interface BlockerGroup { project: string; tasks: { id: string; title: string; status: string }[] }

/** Tasks that can be added as blockers: every other task not already chosen, grouped by project name. */
export function blockerCandidates(payload: TasksPayload, selfId: string, chosen: string[]): BlockerGroup[] {
  return payload.projects
    .map((p) => ({
      project: p.name,
      tasks: p.tasks
        .filter((t) => t.id !== selfId && !chosen.includes(t.id))
        .map((t) => ({ id: t.id, title: t.title, status: t.status }))
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })),
    }))
    .filter((g) => g.tasks.length > 0)
    .sort((a, b) => a.project.localeCompare(b.project, undefined, { sensitivity: 'base' }))
}

/** The sentence to show when a save, create or add-subtask call rejects. Status first, like the board's toast. */
export function saveErrorText(err: { status?: number; message?: string }): string {
  const status = err?.status
  const message = (err?.message ?? '').trim()
  if (status === 403) return 'You need the update_discord_tasks permission to change tasks. Ask an admin.'
  if (status === 404) return 'This task no longer exists. Refresh the page.'
  // The three configuration failures arrive as 502/503 like "unreachable"; retrying does not fix them.
  if (/not configured|rejected the request|unreadable reply/i.test(message)) return 'Discord bot link is misconfigured. Tell an admin.'
  if (status === 502 || status === 503) return 'Discord bot is offline, try again.'
  if (/not reachable|failed to fetch|networkerror|load failed/i.test(message)) return 'Discord bot is offline, try again.'
  return plainRuleMessage(message) || 'Could not save. Try again.'
}
```

- [ ] **Step 8: Run**

Run: `npx vitest run src/screens/team/taskFormLogic.test.ts src/components/discordTasks/api.test.ts`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/screens/tasksLogic.ts src/components/discordTasks/api.ts src/components/discordTasks/api.test.ts src/screens/team/taskFormLogic.ts src/screens/team/taskFormLogic.test.ts
git commit -m "feat(team): task write calls and the edit/create form logic

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The Discord member picker

**Files:**
- Create: `src/screens/team/memberPickerLogic.ts`
- Create: `src/screens/team/memberPickerLogic.test.ts`
- Create: `src/screens/team/MemberPicker.tsx`

**Interfaces:**
- Consumes: `TeamMember` (Task 8 adds `kind`), `Avatar` (`./Avatar`, props `{ person: { discordId, name, avatarUrl? }, size, theme }`).
- Produces:
  - `pickerOptions(members: TeamMember[], projectId: string | null, selected: string[]) → { project: PickerOption[]; others: PickerOption[] }`
  - `matchesQuery(option: PickerOption, query: string) → boolean`
  - `selectedPeople(members: TeamMember[], ids: string[]) → { discordId: string; name: string; avatarUrl?: string }[]`
  - `<MemberPicker members projectId value onChange theme label disabled? />` — `value: string[]` of Discord ids.

- [ ] **Step 1: Write the failing tests** — `src/screens/team/memberPickerLogic.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { TeamMember } from '../tasksLogic'
import { pickerOptions, matchesQuery, selectedPeople } from './memberPickerLogic'

const m = (over: Partial<TeamMember>): TeamMember => ({
  discordId: 'x', name: 'X', username: null, roleNames: [], status: 'approved', verified: true, projects: [], ...over,
})
const members = [
  m({ discordId: 'u1', name: 'zoe', username: 'zoe_k', projects: [{ id: 'P1', name: 'Framework', docsSlug: null, role: 'developer' }] }),
  m({ discordId: 'u2', name: 'Adam', username: 'adam', avatarUrl: 'https://cdn.discordapp.com/a.png' }),
  m({ discordId: 'u3', name: 'Client Co', kind: 'client' }),
  m({ discordId: 'u4', name: 'Pending Pat', verified: false }),
  m({ discordId: 'u5', name: 'Ben', kind: 'staff', projects: [{ id: 'P1', name: 'Framework', docsSlug: null, role: 'qa' }] }),
]

describe('pickerOptions', () => {
  it('verified staff only, project members first, each group by name', () => {
    const g = pickerOptions(members, 'P1', [])
    expect(g.project.map((o) => o.discordId)).toEqual(['u5', 'u1'])
    expect(g.others.map((o) => o.discordId)).toEqual(['u2'])
  })
  it('an older backend without kind treats everyone as staff', () => {
    const g = pickerOptions([m({ discordId: 'a', name: 'A' })], null, [])
    expect(g.others.map((o) => o.discordId)).toEqual(['a'])
  })
  it('someone already selected stays offered even if no longer assignable', () => {
    const g = pickerOptions(members, 'P1', ['u3', 'u4'])
    expect(g.others.map((o) => [o.discordId, o.selected])).toEqual([['u2', false], ['u3', true], ['u4', true]])
  })
  it('no project: everyone is in "others"', () => {
    expect(pickerOptions(members, null, []).project).toEqual([])
  })
})

describe('matchesQuery', () => {
  const [o] = pickerOptions(members, 'P1', []).project.filter((x) => x.discordId === 'u1')
  it('matches display name or username, any case', () => {
    expect(matchesQuery(o, 'ZO')).toBe(true)
    expect(matchesQuery(o, '_k')).toBe(true)
    expect(matchesQuery(o, 'adam')).toBe(false)
    expect(matchesQuery(o, '  ')).toBe(true)
  })
})

describe('selectedPeople', () => {
  it('names each id, and an id with no member row gets a short label', () => {
    expect(selectedPeople(members, ['u2', 'gone1234'])).toEqual([
      { discordId: 'u2', name: 'Adam', avatarUrl: 'https://cdn.discordapp.com/a.png' },
      { discordId: 'gone1234', name: 'Member …1234' },
    ])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/screens/team/memberPickerLogic.test.ts`
Expected: FAIL — cannot resolve `./memberPickerLogic`.

- [ ] **Step 3: Write `src/screens/team/memberPickerLogic.ts`:**

```ts
import type { TeamMember } from '../tasksLogic'

// Who the assignee picker offers: the server's Discord members as the bot keeps
// them (guildmember, synced from Discord), limited to verified staff — pending
// joiners and clients are not people Discord's task commands assign. The task's
// project members come first. Anyone already selected stays in the list so a
// save never silently drops them.

export interface PickerOption {
  discordId: string
  name: string
  username: string | null
  avatarUrl?: string
  selected: boolean
}

export const isAssignable = (m: TeamMember): boolean => m.verified && m.kind !== 'client'

const byName = (a: PickerOption, b: PickerOption) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

export function pickerOptions(members: TeamMember[], projectId: string | null, selected: string[]): { project: PickerOption[]; others: PickerOption[] } {
  const chosen = new Set(selected)
  const project: PickerOption[] = []
  const others: PickerOption[] = []
  for (const m of members) {
    if (!isAssignable(m) && !chosen.has(m.discordId)) continue
    const option: PickerOption = {
      discordId: m.discordId,
      name: m.name,
      username: m.username,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
      selected: chosen.has(m.discordId),
    }
    const inProject = Boolean(projectId) && m.projects.some((p) => p.id === projectId)
    ;(inProject ? project : others).push(option)
  }
  return { project: project.sort(byName), others: others.sort(byName) }
}

export function matchesQuery(option: PickerOption, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return option.name.toLowerCase().includes(q) || (option.username ?? '').toLowerCase().includes(q)
}

export function selectedPeople(members: TeamMember[], ids: string[]): { discordId: string; name: string; avatarUrl?: string }[] {
  const byId = new Map(members.map((m) => [m.discordId, m]))
  return ids.map((id) => {
    const m = byId.get(id)
    if (!m) return { discordId: id, name: `Member …${id.slice(-4)}` }
    return { discordId: id, name: m.name, ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}) }
  })
}
```

- [ ] **Step 4: Write `src/screens/team/MemberPicker.tsx`:**

```tsx
import { useId, useMemo, useState } from 'react'
import { X, Check } from 'lucide-react'
import { c, txt, muted, chipIndigo } from '../../lib'
import type { Theme } from '../../types'
import type { TeamMember } from '../tasksLogic'
import Avatar from './Avatar'
import { matchesQuery, pickerOptions, selectedPeople, type PickerOption } from './memberPickerLogic'

// Pick people from the server's Discord member list: chips for who is chosen,
// a search box, and a list of matches grouped "In this project" / "Everyone
// else". Options keep focus on the search box (mousedown is prevented), so the
// list stays open while several people are picked.
export default function MemberPicker({ members, projectId, value, onChange, theme, label, disabled = false }: {
  members: TeamMember[]
  projectId: string | null
  value: string[]
  onChange: (ids: string[]) => void
  theme: Theme
  label: string
  disabled?: boolean
}) {
  const d = theme === 'dark'
  const inputId = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => pickerOptions(members, projectId, value), [members, projectId, value])
  const chosen = useMemo(() => selectedPeople(members, value), [members, value])
  const shown = {
    project: groups.project.filter((o) => matchesQuery(o, query)),
    others: groups.others.filter((o) => matchesQuery(o, query)),
  }
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  const first = shown.project[0] ?? shown.others[0]

  const row = (o: PickerOption) => (
    <li key={o.discordId}>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => toggle(o.discordId)}
        className={c('w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-lg tr',
          d ? 'hover:bg-white/8' : 'hover:bg-slate-100')}
        aria-pressed={o.selected}
      >
        <Avatar person={o} size={22} theme={theme} />
        <span className={c('text-sm font-semibold truncate', txt(theme))}>{o.name}</span>
        {o.username && <span className={c('text-xs truncate', muted(theme))}>@{o.username}</span>}
        {o.selected && <Check size={14} className="ml-auto text-indigo-500 shrink-0" />}
      </button>
    </li>
  )

  return (
    <div>
      <label htmlFor={inputId} className={c('block text-[11px] font-bold uppercase tracking-wide mb-1.5', muted(theme))}>{label}</label>
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {chosen.map((p) => (
            <span key={p.discordId} className={c('inline-flex items-center gap-1.5 text-[11px] font-semibold pl-1 pr-2 py-1 rounded-full', chipIndigo(theme))}>
              <Avatar person={p} size={18} theme={theme} />
              {p.name}
              {!disabled && (
                <button type="button" onClick={() => toggle(p.discordId)} aria-label={`Remove ${p.name}`} className="inline-flex opacity-70 hover:opacity-100">
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <input
          id={inputId}
          className="input-base"
          placeholder="Search Discord members…"
          value={query}
          disabled={disabled}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false)
            if (e.key === 'Enter') { e.preventDefault(); if (first) toggle(first.discordId) }
          }}
          autoComplete="off"
        />
        {open && !disabled && (
          <div className={c('absolute z-20 mt-1 w-full max-h-72 overflow-y-auto rounded-xl border p-1 shadow-lg',
            d ? 'bg-slate-900 border-white/10' : 'bg-white border-slate-200')}>
            {shown.project.length > 0 && (
              <>
                <p className={c('text-[10px] font-bold uppercase tracking-wide px-3 pt-2 pb-1 m-0', muted(theme))}>In this project</p>
                <ul className="list-none p-0 m-0">{shown.project.map(row)}</ul>
              </>
            )}
            {shown.others.length > 0 && (
              <>
                <p className={c('text-[10px] font-bold uppercase tracking-wide px-3 pt-2 pb-1 m-0', muted(theme))}>{shown.project.length ? 'Everyone else' : 'Members'}</p>
                <ul className="list-none p-0 m-0">{shown.others.map(row)}</ul>
              </>
            )}
            {!shown.project.length && !shown.others.length && (
              <p className={c('text-sm px-3 py-2 m-0', muted(theme))}>No member matches &ldquo;{query}&rdquo;.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Run the logic tests and a type check**

Run: `npx vitest run src/screens/team/memberPickerLogic.test.ts && npx tsc --noEmit -p .`
Expected: tests pass; no type errors. (If `Avatar`'s `person` prop type does not accept `PickerOption`, pass `{ discordId: o.discordId, name: o.name, avatarUrl: o.avatarUrl }`.)

- [ ] **Step 6: Commit**

```bash
git add src/screens/team/memberPickerLogic.ts src/screens/team/memberPickerLogic.test.ts src/screens/team/MemberPicker.tsx
git commit -m "feat(team): pick assignees from the server's Discord member list

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Edit on the task page, and "Add subtask"

**Files:**
- Create: `src/screens/team/TaskEditForm.tsx`
- Create: `src/screens/team/AddSubtask.tsx`
- Modify: `src/screens/team/TaskDetail.tsx`

**Interfaces:**
- Consumes: `updateTask`, `addSubtask`, `UpdateTaskResult` (Task 8); `formFromTask`, `diffChanges`, `validateForm`, `blockerCandidates`, `saveErrorText`, `scopeOptionsFor`, `STATUS_OPTIONS`, `IMPLEMENTATION_OPTIONS` (Task 8); `MemberPicker` (Task 9); `useActingPermissions` (`src/components/portal/tenantProjects/useActingPermissions`); `Toast` (`./Toast`, props `{ message, tone: 'info' | 'error', onClose }`); `plainRuleMessage` (`./boardLogic`); `STATUS_LABEL` (`../tasksLogic`).
- Produces: `<TaskEditForm task payload theme onCancel onSaved />`; `<AddSubtask task payload theme />`. `TaskDetail` accepts `location.state.notice` (string) and shows it as an info toast — Task 11 navigates with it.

- [ ] **Step 1: Write `src/screens/team/TaskEditForm.tsx`:**

```tsx
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { c, txt, muted, chipGray } from '../../lib'
import type { Theme } from '../../types'
import { STATUS_LABEL, type TaskRow, type TasksPayload } from '../tasksLogic'
import { updateTask, type UpdateTaskResult } from '../../components/discordTasks/api'
import MemberPicker from './MemberPicker'
import {
  IMPLEMENTATION_OPTIONS, STATUS_OPTIONS, blockerCandidates, diffChanges, formFromTask, saveErrorText,
  scopeOptionsFor, validateForm, type EditForm,
} from './taskFormLogic'

// Every field Discord's /update-task and task hub can change, in one form. Save
// sends only what changed; the bot applies it as one update (one activity entry,
// one channel post) or refuses it whole with a sentence shown here.
export default function TaskEditForm({ task, payload, theme, onCancel, onSaved }: {
  task: TaskRow
  payload: TasksPayload
  theme: Theme
  onCancel: () => void
  onSaved: (result: UpdateTaskResult) => void
}) {
  const d = theme === 'dark'
  const [form, setForm] = useState<EditForm>(() => formFromTask(task))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof EditForm>(key: K, value: EditForm[K]) => setForm((f) => ({ ...f, [key]: value }))

  const projects = payload.projects.filter((p): p is typeof p & { id: string } => p.id !== null)
  const candidates = useMemo(() => blockerCandidates(payload, task.id, form.blockerIds), [payload, task.id, form.blockerIds])
  const titleOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of payload.projects) for (const t of p.tasks) map.set(t.id, t.title)
    for (const b of task.blockedBy) if (!map.has(b.id)) map.set(b.id, b.title)
    return map
  }, [payload, task.blockedBy])

  async function save() {
    const problem = validateForm(task, form)
    if (problem) { setError(problem); return }
    const changes = diffChanges(task, form)
    if (!Object.keys(changes).length) { onCancel(); return }
    setSaving(true)
    setError(null)
    try {
      onSaved(await updateTask(task.id, changes))
    } catch (err) {
      setError(saveErrorText(err as { status?: number; message?: string }))
      setSaving(false)
    }
  }

  const count = (key: 'passedApiTests' | 'passedQaTests' | 'passedAcceptanceCriteria', label: string) => (
    <Labeled label={label} theme={theme}>
      <input className="input-base" inputMode="numeric" value={form[key]} placeholder="not tracked"
        onChange={(e) => set(key, e.target.value)} disabled={saving} />
    </Labeled>
  )

  return (
    <form onSubmit={(e) => { e.preventDefault(); void save() }} className="flex flex-col gap-5">
      <Labeled label="Title" theme={theme}>
        <input className="input-base" value={form.title} maxLength={200} onChange={(e) => set('title', e.target.value)} disabled={saving} />
      </Labeled>
      <Labeled label="Description" theme={theme}>
        <textarea className="input-base min-h-[120px]" value={form.description} maxLength={2000}
          onChange={(e) => set('description', e.target.value)} disabled={saving} />
      </Labeled>

      <div className="grid gap-4 sm:grid-cols-3">
        <Labeled label="Status" theme={theme}>
          <select className="input-base" value={form.status} onChange={(e) => set('status', e.target.value)} disabled={saving}>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>)}
          </select>
        </Labeled>
        <Labeled label="Scope" theme={theme}>
          <select className="input-base" value={form.scope} onChange={(e) => set('scope', e.target.value)} disabled={saving}>
            {scopeOptionsFor(formFromTask(task).scope).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Labeled>
        <Labeled label="Implementation" theme={theme}>
          <select className="input-base" value={form.implementationStatus} onChange={(e) => set('implementationStatus', e.target.value)} disabled={saving}>
            {!form.implementationStatus && <option value="">—</option>}
            {IMPLEMENTATION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Labeled>
      </div>

      <Labeled label="Project" theme={theme}>
        <select className="input-base" value={form.projectId} onChange={(e) => set('projectId', e.target.value)} disabled={saving}>
          <option value="">No project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {form.projectId !== formFromTask(task).projectId && (
          <p className={c('text-xs mt-1.5 mb-0', muted(theme))}>The Discord channel does not move by itself; run /project-setup for the new project afterwards.</p>
        )}
      </Labeled>

      <MemberPicker members={payload.members} projectId={form.projectId || null} value={form.holderIds}
        onChange={(ids) => set('holderIds', ids)} theme={theme} label={task.type === 'bug' ? 'Tagged members' : 'Assignees'} disabled={saving} />

      <div className="grid gap-4 sm:grid-cols-4">
        {count('passedApiTests', 'API tests passed')}
        {count('passedQaTests', 'QA tests passed')}
        {count('passedAcceptanceCriteria', 'Acceptance criteria')}
        <Labeled label="Estimate" theme={theme}>
          <input className="input-base" value={form.estimate} placeholder="e.g. 8h 30m" onChange={(e) => set('estimate', e.target.value)} disabled={saving} />
        </Labeled>
      </div>

      <Labeled label="Blocked by" theme={theme}>
        {form.blockerIds.length > 0 && (
          <ul className="list-none p-0 m-0 mb-2 flex flex-col gap-1.5">
            {form.blockerIds.map((id) => (
              <li key={id} className={c('flex items-center gap-2 text-sm rounded-lg px-3 py-1.5', chipGray(theme))}>
                <span className={c('flex-1 truncate font-semibold', txt(theme))}>{titleOf.get(id) ?? id}</span>
                <button type="button" aria-label={`Stop ${titleOf.get(id) ?? id} blocking this task`} disabled={saving}
                  onClick={() => set('blockerIds', form.blockerIds.filter((x) => x !== id))} className="inline-flex opacity-70 hover:opacity-100">
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <select className="input-base" value="" disabled={saving || candidates.length === 0}
          onChange={(e) => { if (e.target.value) set('blockerIds', [...form.blockerIds, e.target.value]) }}>
          <option value="">{candidates.length ? 'Add a blocking task…' : 'No other tasks'}</option>
          {candidates.map((g) => (
            <optgroup key={g.project} label={g.project}>
              {g.tasks.map((t) => <option key={t.id} value={t.id}>{t.title} ({STATUS_LABEL[t.status] ?? t.status})</option>)}
            </optgroup>
          ))}
        </select>
      </Labeled>

      {error && <p role="alert" className="text-sm font-semibold text-red-500 m-0">{error}</p>}

      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn-primary px-5 py-2.5 text-sm" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={onCancel} disabled={saving}
          className={c('btn-outline-indigo px-5 py-2.5 text-sm', d ? 'dark-variant' : '')}>Cancel</button>
      </div>
    </form>
  )
}

function Labeled({ label, theme, children }: { label: string; theme: Theme; children: ReactNode }) {
  return (
    <div>
      <p className={c('text-[11px] font-bold uppercase tracking-wide mb-1.5', muted(theme))}>{label}</p>
      {children}
    </div>
  )
}
```

- [ ] **Step 2: Write `src/screens/team/AddSubtask.tsx`:**

```tsx
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { c, muted } from '../../lib'
import type { Theme } from '../../types'
import type { TaskRow, TasksPayload } from '../tasksLogic'
import { addSubtask } from '../../components/discordTasks/api'
import MemberPicker from './MemberPicker'
import { saveErrorText } from './taskFormLogic'
import { useTeam } from './TeamLayout'

// Add a subtask under this task, saved at once (a subtask is its own task).
// The bot makes it exactly as the task hub's Add-subtask does: in the parent's
// project, no channel of its own, the parent reopened if it was finished.
export default function AddSubtask({ task, payload, theme }: { task: TaskRow; payload: TasksPayload; theme: Theme }) {
  const { refresh } = useTeam()
  const [title, setTitle] = useState('')
  const [holderIds, setHolderIds] = useState<string[]>([])
  const [showPeople, setShowPeople] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add() {
    const t = title.trim()
    if (!t) { setError('A subtask needs a title.'); return }
    if (t.length > 200) { setError('The title can be at most 200 characters.'); return }
    setBusy(true)
    setError(null)
    try {
      await addSubtask(task.id, t, holderIds)
      setTitle('')
      setHolderIds([])
      setShowPeople(false)
      await refresh()
    } catch (err) {
      setError(saveErrorText(err as { status?: number; message?: string }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3">
      <form onSubmit={(e) => { e.preventDefault(); void add() }} className="flex flex-wrap gap-2 items-center">
        <div className="flex-1 min-w-[200px]">
          <input className="input-base" placeholder="Add a subtask…" value={title} maxLength={200}
            onChange={(e) => setTitle(e.target.value)} disabled={busy} aria-label="New subtask title" />
        </div>
        <button type="submit" className="btn-primary px-4 py-2 text-sm inline-flex items-center gap-1.5" disabled={busy}>
          <Plus size={14} /> {busy ? 'Adding…' : 'Add'}
        </button>
        <button type="button" onClick={() => setShowPeople((v) => !v)} disabled={busy}
          className={c('text-xs font-semibold underline-offset-2 hover:underline', muted(theme))}>
          {showPeople ? 'Hide assignees' : holderIds.length ? `Assignees (${holderIds.length})` : 'Assign…'}
        </button>
      </form>
      {showPeople && (
        <div className="mt-2">
          <MemberPicker members={payload.members} projectId={task.projectId} value={holderIds} onChange={setHolderIds} theme={theme} label="Subtask assignees" disabled={busy} />
        </div>
      )}
      {error && <p role="alert" className="text-sm font-semibold text-red-500 mt-2 mb-0">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 3: Wire both into `src/screens/team/TaskDetail.tsx`.**

Imports to add:
```tsx
import { useCallback, useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import { useActingPermissions } from '../../components/portal/tenantProjects/useActingPermissions'
import type { UpdateTaskResult } from '../../components/discordTasks/api'
import TaskEditForm from './TaskEditForm'
import AddSubtask from './AddSubtask'
import Toast, { type ToastTone } from './Toast'
import { plainRuleMessage } from './boardLogic'
```
(merge `useLocation` into the existing `react-router-dom` import; `ExternalLink` import stays.)

At the top of `TaskDetail`, **before any early return**, replace `const { payload, loading } = useTeam()` and `const { search } = useLocation()` with:

```tsx
  const { payload, loading, refresh } = useTeam()
  const location = useLocation()
  const { search } = location
  const { has } = useActingPermissions()
  const canEdit = has('update_discord_tasks')
  const [editing, setEditing] = useState(false)
  const [toast, setToast] = useState<{ message: string; tone: ToastTone; seq: number } | null>(null)
  const show = useCallback((message: string, tone: ToastTone) => {
    setToast((prev) => ({ message, tone, seq: (prev?.seq ?? 0) + 1 }))
  }, [])
  // A different task in the same screen starts in read mode.
  useEffect(() => { setEditing(false) }, [taskId])
  // The create page lands here with a note about where the channel went.
  const notice = (location.state as { notice?: string } | null)?.notice
  useEffect(() => { if (notice) show(notice, 'info') }, [notice, show])

  const onSaved = useCallback(async (result: UpdateTaskResult) => {
    setEditing(false)
    const warning = plainRuleMessage(result.warning || '')
    if (warning) show(warning, 'info')
    await refresh()
  }, [refresh, show])
```

In the header row, beside `<CopyLinkButton …/>` (inside the same `mt-1 shrink-0` wrapper, as a flex row), add the Edit button:

```tsx
          <div className="mt-1 shrink-0 flex items-center gap-2">
            {canEdit && !editing && (
              <button type="button" onClick={() => setEditing(true)}
                className={c('btn-outline-indigo inline-flex items-center gap-1.5 px-3 py-1.5 text-xs', d ? 'dark-variant' : '')}>
                <Pencil size={13} /> Edit
              </button>
            )}
            <CopyLinkButton url={taskUrl(window.location.origin, task.id)} theme={theme} />
          </div>
```

When `editing`, the article shows the form instead of the read-only fields. Wrap everything inside `<article>` after the header row (from the type/project `<p>` down to the Discord-channel link) as:

```tsx
        {editing ? (
          <div className="mt-4">
            <TaskEditForm task={task} payload={payload} theme={theme} onCancel={() => setEditing(false)} onSaved={(r) => void onSaved(r)} />
          </div>
        ) : (
          <>
            {/* …the existing read-only content, unchanged… */}
          </>
        )}
```

Replace the Subtasks field condition and body with:

```tsx
        {((task.subtasks?.length ?? 0) > 0 || (canEdit && !task.parent)) && (
          <Field label="Subtasks" theme={theme}>
            {(task.subtasks?.length ?? 0) > 0 && <SubtasksSection task={task} theme={theme} search={search} />}
            {canEdit && !task.parent && <AddSubtask task={task} payload={payload} theme={theme} />}
          </Field>
        )}
```

Just before the closing `</>` of the component's return, add:

```tsx
      {toast && <Toast key={toast.seq} message={toast.message} tone={toast.tone} onClose={() => setToast(null)} />}
```

- [ ] **Step 4: Type-check, test, build**

Run: `npx tsc --noEmit -p . && npm test && npm run build`
Expected: no type errors, all tests pass, build succeeds.

- [ ] **Step 5: Look at it.** `npm run dev`, sign in, open `/tools/team/tasks/<id>` with an account that has `update_discord_tasks`: the Edit button shows; the form is prefilled; Cancel returns to read mode; Save with nothing changed returns to read mode without a network request (check the Network panel). Without the permission the Edit button and the Add-subtask box are absent. Take a screenshot of the form in light and dark mode for the report. If you cannot sign in locally, say so in the report rather than claiming the check.

- [ ] **Step 6: Commit**

```bash
git add src/screens/team/TaskEditForm.tsx src/screens/team/AddSubtask.tsx src/screens/team/TaskDetail.tsx
git commit -m "feat(team): edit a task and add subtasks from its page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: The create page and the "New task" buttons

**Files:**
- Create: `src/screens/team/TaskCreate.tsx`
- Modify: `src/app/routes.tsx:81-88` (the `tasks/new` route)
- Modify: `src/screens/team/TasksList.tsx` (toolbar button; per-project button beside "Graph")

**Interfaces:**
- Consumes: `createTask` (Task 8), `emptyCreateForm`, `validateCreateForm`, `createPayload`, `saveErrorText`, `SCOPE_OPTIONS` (Task 8), `MemberPicker` (Task 9), `useTeam`, `useActingPermissions`.
- Produces: route `/tools/team/tasks/new` (query `projectId=<id>` or `project=<docsSlug>` preselects the project); after a create it navigates to `/tools/team/tasks/<newId>` with `state: { notice }`.

- [ ] **Step 1: Write `src/screens/team/TaskCreate.tsx`:**

```tsx
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { c, card, txt, muted } from '../../lib'
import { useTheme } from '../../app/ThemeContext'
import type { Theme } from '../../types'
import { createTask } from '../../components/discordTasks/api'
import { useActingPermissions } from '../../components/portal/tenantProjects/useActingPermissions'
import { useTeam } from './TeamLayout'
import MemberPicker from './MemberPicker'
import { SCOPE_OPTIONS, createPayload, emptyCreateForm, saveErrorText, validateCreateForm, type CreateForm } from './taskFormLogic'

// A new Feature or Bug, made by the Discord bot exactly as /create-task makes
// it: the row, its ticket doc, the bug's GitHub issue, and its channel in the
// project's Discord section. The project is required here.
export default function TaskCreate() {
  const { theme } = useTheme()
  const d = theme === 'dark'
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { payload, loading, refresh } = useTeam()
  const { has, loaded } = useActingPermissions()
  const [form, setForm] = useState<CreateForm>(() => emptyCreateForm(params.get('projectId') ?? ''))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof CreateForm>(key: K, value: CreateForm[K]) => setForm((f) => ({ ...f, [key]: value }))

  const projects = (payload?.projects ?? []).filter((p): p is typeof p & { id: string } => p.id !== null)
  const repositories = payload?.repositories ?? []

  // `?project=<docsSlug>` (the Tasks list's filter) preselects once the payload has the slugs.
  useEffect(() => {
    if (form.projectId || !payload) return
    const slug = params.get('project')
    const match = slug ? payload.projects.find((p) => p.docsSlug === slug && p.id) : null
    if (match?.id) set('projectId', match.id)
  }, [payload, params, form.projectId])

  if (!loaded || (loading && !payload)) {
    return <div className={c(card(theme), 'rounded-2xl px-8 py-14 text-center')}><p className={c('text-sm font-medium m-0', muted(theme))}>Loading…</p></div>
  }
  if (!has('update_discord_tasks')) {
    return (
      <div className={c(card(theme), 'rounded-2xl px-8 py-14 text-center')}>
        <p className={c('text-sm font-medium mb-4', muted(theme))}>You need the update_discord_tasks permission to create tasks. Ask an admin.</p>
        <Link to="/tools/team/tasks" className="btn-primary px-5 py-2.5 text-sm no-underline">Back to tasks</Link>
      </div>
    )
  }
  if (!payload) return null

  async function submit() {
    const problem = validateCreateForm(form)
    if (problem) { setError(problem); return }
    setSaving(true)
    setError(null)
    try {
      const result = await createTask(createPayload(form))
      await refresh()
      navigate(`/tools/team/tasks/${result.task.id}`, { state: { notice: result.note || 'Task created. Its Discord channel is ready.' } })
    } catch (err) {
      setError(saveErrorText(err as { status?: number; message?: string }))
      setSaving(false)
    }
  }

  const isBug = form.type === 'bug'
  const toggleRepo = (id: string) => {
    if (isBug) set('repositoryIds', form.repositoryIds[0] === id ? [] : [id])
    else set('repositoryIds', form.repositoryIds.includes(id) ? form.repositoryIds.filter((x) => x !== id) : [...form.repositoryIds, id])
  }

  return (
    <>
      <Link to="/tools/team/tasks" className={c('inline-block text-sm font-semibold no-underline mb-4 tr',
        d ? 'text-white/40 hover:text-white/70' : 'text-slate-400 hover:text-indigo-600')}>&larr; Back to tasks</Link>
      <article className={c(card(theme), 'rounded-2xl p-5 sm:p-7')}>
        <h2 className={c('font-extrabold text-xl sm:text-2xl m-0 mb-5', txt(theme))}>New task</h2>
        <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="flex flex-col gap-5">
          <div role="radiogroup" aria-label="Task type" className="flex gap-2">
            {(['feature', 'bug'] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={form.type === t} disabled={saving}
                onClick={() => setForm((f) => ({ ...f, type: t, repositoryIds: t === 'bug' ? f.repositoryIds.slice(0, 1) : f.repositoryIds }))}
                className={c('px-4 py-2 text-sm font-semibold rounded-xl border tr',
                  form.type === t ? 'bg-indigo-500 border-indigo-500 text-white' : d ? 'border-white/15 text-white/70' : 'border-slate-300 text-slate-600')}>
                {t === 'feature' ? 'Feature' : 'Bug'}
              </button>
            ))}
          </div>

          <Labeled label="Title" theme={theme}>
            <input className="input-base" value={form.title} maxLength={200} onChange={(e) => set('title', e.target.value)} disabled={saving} />
          </Labeled>
          <Labeled label="Description" theme={theme}>
            <textarea className="input-base min-h-[120px]" value={form.description} maxLength={2000} onChange={(e) => set('description', e.target.value)} disabled={saving} />
          </Labeled>

          <div className="grid gap-4 sm:grid-cols-2">
            <Labeled label="Project" theme={theme}>
              <select className="input-base" value={form.projectId} onChange={(e) => set('projectId', e.target.value)} disabled={saving}>
                <option value="">Pick a project…</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Labeled>
            <Labeled label="Scope" theme={theme}>
              <select className="input-base" value={form.scope} onChange={(e) => set('scope', e.target.value)} disabled={saving}>
                <option value="">None</option>
                {SCOPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Labeled>
          </div>

          <MemberPicker members={payload.members} projectId={form.projectId || null} value={form.holderIds}
            onChange={(ids) => set('holderIds', ids)} theme={theme} label={isBug ? 'Tagged members' : 'Assignees'} disabled={saving} />

          {!isBug && (
            <Labeled label="Modules (comma-separated)" theme={theme}>
              <input className="input-base" value={form.modules} placeholder="auth, billing" onChange={(e) => set('modules', e.target.value)} disabled={saving} />
            </Labeled>
          )}

          <Labeled label={isBug ? 'Repository (opens a GitHub issue)' : 'Repositories'} theme={theme}>
            {repositories.length === 0
              ? <p className={c('text-sm m-0', muted(theme))}>No repositories are registered with the bot.</p>
              : (
                <div className="flex flex-wrap gap-2">
                  {repositories.map((r) => {
                    const on = form.repositoryIds.includes(r.id)
                    return (
                      <button key={r.id} type="button" aria-pressed={on} disabled={saving} onClick={() => toggleRepo(r.id)} title={r.url}
                        className={c('px-3 py-1.5 text-xs font-semibold rounded-full border tr',
                          on ? 'bg-indigo-500 border-indigo-500 text-white' : d ? 'border-white/15 text-white/70' : 'border-slate-300 text-slate-600')}>
                        {r.name}
                      </button>
                    )
                  })}
                </div>
              )}
          </Labeled>

          <fieldset className="border-0 p-0 m-0">
            <legend className={c('text-[11px] font-bold uppercase tracking-wide mb-1.5', muted(theme))}>Track</legend>
            <div className="flex flex-wrap gap-4">
              {([['tracksApi', 'API tests'], ['tracksQa', 'QA tests'], ['tracksAc', 'Acceptance criteria']] as const).map(([key, label]) => (
                <label key={key} className={c('inline-flex items-center gap-2 text-sm', txt(theme))}>
                  <input type="checkbox" checked={form[key]} onChange={(e) => set(key, e.target.checked)} disabled={saving} /> {label}
                </label>
              ))}
            </div>
          </fieldset>

          {error && <p role="alert" className="text-sm font-semibold text-red-500 m-0">{error}</p>}

          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn-primary px-5 py-2.5 text-sm" disabled={saving}>{saving ? 'Creating…' : 'Create task'}</button>
            <Link to="/tools/team/tasks" className={c('btn-outline-indigo px-5 py-2.5 text-sm no-underline', d ? 'dark-variant' : '')}>Cancel</Link>
          </div>
        </form>
      </article>
    </>
  )
}

function Labeled({ label, theme, children }: { label: string; theme: Theme; children: ReactNode }) {
  return (
    <div>
      <p className={c('text-[11px] font-bold uppercase tracking-wide mb-1.5', muted(theme))}>{label}</p>
      {children}
    </div>
  )
}
```

- [ ] **Step 2: Route.** In `src/app/routes.tsx`, import `TaskCreate from '../screens/team/TaskCreate'` (match the file's existing import style) and add inside the `/tools/team` route, before `tasks/:taskId`:

```tsx
          <Route path="tasks/new" element={<TaskCreate />} />
```

- [ ] **Step 3: Buttons in `src/screens/team/TasksList.tsx`.** Add imports `Plus` (lucide-react) and `useActingPermissions`. In `TasksList`, read `const canCreate = useActingPermissions().has('update_discord_tasks')` and render, as the first child of the returned fragment:

```tsx
      {canCreate && (
        <div className="flex justify-end mb-4">
          <Link to={`/tools/team/tasks/new${search}`} className="btn-primary px-4 py-2 text-sm no-underline inline-flex items-center gap-2">
            <Plus size={14} /> New task
          </Link>
        </div>
      )}
```
In the project-card component that renders the "Graph" toggle (≈L60-80), call `useActingPermissions()` at its top and render, immediately before the Graph button:

```tsx
            {canCreate && p.id && (
              <Link to={`/tools/team/tasks/new?projectId=${encodeURIComponent(p.id)}`}
                className={c('inline-flex items-center gap-1 text-xs font-semibold no-underline px-2.5 py-1 rounded-lg tr',
                  theme === 'dark' ? 'text-indigo-300 hover:bg-white/8' : 'text-indigo-600 hover:bg-indigo-50')}
                title={`New task in ${p.name}`}>
                <Plus size={12} /> Task
              </Link>
            )}
```
(`p` is the card's `ProjectGroup`; the group of tasks with no project has `id: null` and gets no button.)

- [ ] **Step 4: Type-check, test, build**

Run: `npx tsc --noEmit -p . && npm test && npm run build`
Expected: clean.

- [ ] **Step 5: Look at it.** `npm run dev`: the "New task" button on `/tools/team/tasks` and the "+ Task" button on a project card open the form with the project preselected; switching to Bug hides Modules and limits repositories to one; submitting with no title or project shows the sentence without a request. If you cannot sign in locally, say so in the report.

- [ ] **Step 6: Commit**

```bash
git add src/screens/team/TaskCreate.tsx src/app/routes.tsx src/screens/team/TasksList.tsx
git commit -m "feat(team): create a Feature or Bug from the site

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: State files and the rollout note (bot repo)

**Files:**
- Modify: `.claude/state/backlog.md`, `.claude/state/completed.md`, `.claude/state/session.md` (bot repo, branch `feat/site-task-edit`)

- [ ] **Step 1:** In `backlog.md`, add at the top a section `## Site create/edit — rollout (branch feat/site-task-edit in all three repos, 2026-09-28)` with these lines:
  - Deploy order bot → CSAAS → site. No new env values.
  - Bot first: `pm2 logs granjur-bot` shows the internal task routes enabled.
  - CSAAS: the `Deploy to Azure` workflow has not run on `main` since 2026-09-12, so confirm how CSAAS is deployed before relying on a push.
  - First live check: create a feature on the site and see its channel appear in the project's section. Then edit it and see one "(via the site) updated this task" post.
  - Any follow-ups the task reviews parked.
- [ ] **Step 2:** In `completed.md`, add a dated entry (2026-09-28) listing the commits of Tasks 1–11 per repo. In `session.md`, record the outcome and the open rollout.
- [ ] **Step 3: Commit**

```bash
git add .claude/state/backlog.md .claude/state/completed.md .claude/state/session.md
git commit -m "docs(state): site task create/edit built; rollout steps

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

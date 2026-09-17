# Team Section (People, Task Detail, Dependency Graph, Kanban) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tasks page with a Team section: people and workload, a task detail page, a per-project dependency graph, and a kanban board where dragging a card changes the task's status in Discord through the bot.

**Architecture:** The bot owns every write: a shared status-change helper serves both `/update-task` and a new loopback HTTP route guarded by a shared secret. CSAAS verifies the portal user's token and permission, then calls that route; it also returns a richer read payload. The site is one Team layout with one fetch and four child views; all layout, grouping and drop rules are pure, tested functions.

**Tech Stack:** Bot: Node 24 ESM, discord.js v14, mysql2, `node:test`. CSAAS: CommonJS framework API objects, plain-assert test scripts, global `fetch`. Site: Vite + React 19 + TypeScript + Tailwind 4 + react-router 7, vitest, native HTML5 drag and drop, inline SVG.

**Spec:** `docs/superpowers/specs/2026-09-18-team-board-previews-design.md`

## Global Constraints

- Three repos. Bot: `D:\Work\Granjur Technologies\Granjur-Discord-Bot`, branch `feat/team-board` off `main`. CSAAS: `D:\Work\Granjur Technologies\CSAAS_Backend`, branch `feat/discord-tasks-status` off `origin/main` (run `git fetch` first). Site: `D:\Work\Granjur Technologies\UBS-Doc`, branch `feat/team-section` off `origin/main`.
- **Never `git add -A` or `git add .` in CSAAS or UBS-Doc.** Both working trees carry unrelated uncommitted changes. Stage named files only. Never `prettier`.
- **Tests never touch production.** The bot's root `.env` holds the production `DATABASE_URL` (binding rule: `.claude/rules/tests-never-touch-production.md`). Every function under test that queries takes `{ db }` and, where it needs the guild config, `{ getConfig }` or `db.guildConfig.findById`; tests pass fakes. Never run a new test against a version of the code that does not honour those seams, including to demonstrate RED.
- Bot tests: `npm test` from the repo root (`node --test`, bare). Single file: `node --test <path>`.
- Bot SQL: lowercase table names; `LIMIT` inlined; inserts build columns and params from one ordered array (`guildMemberInsertSql` pattern) with a test.
- Terminal statuses: `closed`, `done`, `resolved`. Status list: `open`, `pending`, `in_progress`, `resolved`, `closed`, `done`. Blocked state is computed, never stored. Warn, never refuse.
- CSAAS: route rule `GET /api/discord/tasks` → `DiscordTasks_object`, `POST /api/discord/tasks/status` → `DiscordTasksStatus_object`. Write endpoint declared with `accessToken: true`, `bindActorToToken: true`, `permission: null`, permission enforced in the handler with `requirePortalPermission(req, decryptedPayload, "update_discord_tasks")`. CSAAS never writes `granjur.*`.
- Bot internal route: `POST /internal/tasks/status`, header `x-internal-secret` compared to env `BOT_INTERNAL_SECRET` in constant time; disabled (503) when the env is unset; no CORS headers.
- Site: no new dependencies. Reuse `c, card, txt, muted, Breadcrumb, chip*`, `inputCls` from `src/lib`, `useTheme`, `AuroraText`, `SearchInput`, `lucide-react`, `mwGet`/`mwPost` from `src/components/meetingWorkflow/api.js`, `useActingPermissions` from `src/components/portal/tenantProjects/useActingPermissions.js`. Every `/tools/team*` route is wrapped in `T(...)`.
- Board columns and their drop statuses: Open → `open`, Pending → `pending`, In progress → `in_progress`, Done → `done`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

**Bot**
- Create `bot/src/Database/migrations/018_guildmember_role_names.sql`; modify `schema.sql`.
- Modify `bot/src/Database/index.js`: `roleNames` in `guildMemberUpdateSets` and `guildMemberInsertSql`; `db.guildConfig.findById`.
- Modify `bot/src/services/memberNameSync.js` (+ test): role names.
- Modify `bot/src/utils/taskDeps.js`: `TASK_STATUSES`.
- Create `bot/src/services/taskStatusChange.js` (+ test); modify `bot/src/commands/update-task.js` to use it; modify `bot/src/services/taskUpdateNotify.js` (+ test): `actorLabel`.
- Create `bot/src/services/internalTaskRoute.js` (+ test); modify `bot/src/server.js`.

**CSAAS**
- Modify `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js` (+ `assemble.test.js`): fields, `members`.
- Create `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksStatus.js` (+ `status.test.js`).
- Create `data/migrations/20260918_1_update_discord_tasks_permission.sql`.

**Site**
- Modify `src/screens/tasksLogic.ts` (+ test): types. Create `src/screens/team/boardLogic.ts`, `graphLayout.ts`, `teamLogic.ts`, `redirect.ts` (+ tests). Modify `src/components/discordTasks/api.ts`.
- Create `src/screens/team/TeamLayout.tsx`, `People.tsx`, `TasksList.tsx`, `TaskDetail.tsx`, `Board.tsx`, `DependencyGraph.tsx`, `Toast.tsx`. Delete `src/screens/Tasks.tsx`.
- Modify `src/app/routes.tsx`, `src/screens/ToolsHub.tsx`, `src/components/Sidebar.tsx`, `src/screens/Projects.tsx`.

**Docs**: `.claude/knowledge/project-tasks-site.md` (extend), `.claude/state/*`.

---

### Task 1: Role names in the database and the name sync

**Files:**
- Create: `bot/src/Database/migrations/018_guildmember_role_names.sql`
- Modify: `bot/src/Database/index.js` (`guildMemberUpdateSets`, `guildMemberInsertSql`, the `db` export object), `bot/src/Database/schema.sql` (`guildmember`)
- Modify: `bot/src/services/memberNameSync.js`
- Test: `bot/src/Database/taskDependency.test.js` (append), `bot/src/services/memberNameSync.test.js` (append)

**Interfaces:**
- Produces: `guildMemberUpdateSets({ roleNames })` → `sets` includes `roleNames = ?` with `toJson(roleNames)`; `guildMemberInsertSql` gains a tenth column `roleNames` (default `'[]'` JSON); `toNameUpdates(discordMembers, dbRows)` diffs `roleNames`; `roleNamesOf(member)` exported; `db.guildConfig.findById(id)` → row.

- [ ] **Step 1: Failing tests**

Append to `bot/src/Database/taskDependency.test.js`:

```js
test('guildmember update sets: roleNames is written as JSON', () => {
  assert.deepEqual(guildMemberUpdateSets({ roleNames: ['Senior Dev', 'Frontend'] }), {
    sets: ['roleNames = ?'], vals: ['["Senior Dev","Frontend"]'],
  })
})

test('guildmember insert: roleNames is the tenth column and defaults to an empty list', () => {
  const { sql, params } = guildMemberInsertSql({ id: 'x', guildConfigId: 'g', discordId: 'u' })
  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim())
  assert.equal(cols[9], 'roleNames')
  assert.equal(params[9], '[]')
  assert.equal((sql.match(/\?/g) || []).length, params.length)
})
```

Append to `bot/src/services/memberNameSync.test.js` (its `m()` helper builds a fake member; extend it to accept roles):

```js
import { roleNamesOf } from './memberNameSync.js'

const withRoles = (member, names) => ({
  ...member,
  roles: { cache: new Map(names.map((n, i) => [String(i), { name: n }])) },
})

test('roleNamesOf: sorted, no @everyone, capped at 25 names of 100 chars', () => {
  const member = withRoles(m('1', 'N', 'n'), ['Frontend', '@everyone', 'Senior Dev', 'x'.repeat(150)])
  assert.deepEqual(roleNamesOf(member), ['Frontend', 'Senior Dev', 'x'.repeat(100)])
  const many = withRoles(m('1', 'N', 'n'), Array.from({ length: 30 }, (_, i) => `R${String(i).padStart(2, '0')}`))
  assert.equal(roleNamesOf(many).length, 25)
})

test('toNameUpdates: a changed role list is an update even when names are unchanged', () => {
  const discord = [withRoles(m('1', 'Nauraiz', 'nauraiz_101104'), ['Senior Dev'])]
  const rows = [{ id: 'r1', discordId: '1', displayName: 'Nauraiz', username: 'nauraiz_101104', roleNames: '["Frontend"]' }]
  const out = toNameUpdates(discord, rows)
  assert.deepEqual(out.updates, [{ id: 'r1', displayName: 'Nauraiz', username: 'nauraiz_101104', roleNames: ['Senior Dev'] }])
})

test('toNameUpdates: an identical role list (stored as JSON text) is not an update', () => {
  const discord = [withRoles(m('1', 'Nauraiz', 'nauraiz_101104'), ['Frontend', 'Senior Dev'])]
  const rows = [{ id: 'r1', discordId: '1', displayName: 'Nauraiz', username: 'nauraiz_101104', roleNames: '["Frontend","Senior Dev"]' }]
  assert.deepEqual(toNameUpdates(discord, rows).updates, [])
})
```

Existing `toNameUpdates` tests build members without `roles`; `roleNamesOf` must return `[]` for a member with no `roles`, and the existing expected `updates`/`inserts` objects gain `roleNames: []` — update those expectations.

- [ ] **Step 2: Run, expect failures** — `node --test bot/src/Database/taskDependency.test.js bot/src/services/memberNameSync.test.js`

- [ ] **Step 3: Implement**

Migration `018_guildmember_role_names.sql`:

```sql
-- Discord role names per member, kept fresh by memberNameSync, so the UBS-Doc
-- Team page can show roles without asking Discord.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildmember' AND COLUMN_NAME = 'roleNames');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `guildmember` ADD COLUMN roleNames JSON DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

Add `roleNames JSON DEFAULT NULL` after `username` in `schema.sql`.

`index.js`: in `guildMemberUpdateSets` add `if (data.roleNames !== undefined) { sets.push("roleNames = ?"); vals.push(toJson(data.roleNames)); }`. In `guildMemberInsertSql` append `["roleNames", toJson(data.roleNames || [])]` as the last column. Add `guildConfig: { findById: getGuildConfigById }` to the `db` object. In `guildMemberUpsert`'s existing-row branch pass `roleNames: update.roleNames` into `guildMemberUpdateSets`.

`memberNameSync.js`:

```js
export function roleNamesOf(member) {
  const cache = member?.roles?.cache
  if (!cache) return []
  return Array.from(cache.values())
    .map((r) => String(r?.name ?? ''))
    .filter((n) => n && n !== '@everyone')
    .map((n) => n.slice(0, 100))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 25)
}
const storedRoles = (v) => { if (Array.isArray(v)) return v; if (typeof v === 'string' && v) { try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] } } return [] }
```

In `toNameUpdates`: compute `roleNames = roleNamesOf(member)`; inserts carry `roleNames`; an existing row is an update when names differ **or** `JSON.stringify(storedRoles(row.roleNames)) !== JSON.stringify(roleNames)`; updates carry `roleNames`. `applyNameWrites` passes `roleNames` in both `update.data` and `upsert.create`/`update`.

- [ ] **Step 4: Run** `npm test` — all pass.
- [ ] **Step 5: Commit** `feat(members): store Discord role names for the Team page`

---

### Task 2: Shared status-change helper and `actorLabel`

**Files:**
- Create: `bot/src/services/taskStatusChange.js`, `bot/src/services/taskStatusChange.test.js`
- Modify: `bot/src/utils/taskDeps.js` (add `TASK_STATUSES`), `bot/src/services/taskUpdateNotify.js` (+ test append), `bot/src/commands/update-task.js`

**Interfaces:**
- Produces: `TASK_STATUSES = ['open','pending','in_progress','resolved','closed','done']`; `applyTaskUpdate({ db, client, task, updates, actor = {}, notify = notifyTaskUpdate, guild = null })` → `{ warning, notified }`; `notifyTaskUpdate({ ..., actorLabel = null })`.

- [ ] **Step 1: Failing tests**

`taskStatusChange.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTaskUpdate } from './taskStatusChange.js'

function fakeDb({ deps = [], tasks = [], cfg = { id: 'g1', guildId: 'guild1' } } = {}) {
  const calls = []
  return {
    calls,
    task: {
      update: async (a) => { calls.push(['update', a]); return null },
      findByIds: async ({ where }) => tasks.filter((t) => where.ids.includes(t.id)),
    },
    taskDependency: { findByTask: async ({ where }) => deps.filter((d) => d.taskId === where.taskId) },
    guildConfig: { findById: async () => cfg },
  }
}
const client = { guilds: { cache: new Map([['guild1', { id: 'guild1', name: 'G' }]]) } }

test('writes the update, computes the blocker warning, and passes actorLabel to notify', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'Git Sync', status: 'open' }
  const db = fakeDb({ deps: [{ taskId: 'A', blockedByTaskId: 'B' }], tasks: [{ id: 'B', title: 'Router fix', status: 'open' }] })
  const seen = []
  const notify = async (a) => { seen.push(a); return { channelId: 'c', created: false, dmed: [] } }
  const out = await applyTaskUpdate({ db, client, task, updates: { status: 'in_progress' }, actor: { label: 'Aashir (via the site)' }, notify })
  assert.deepEqual(db.calls[0], ['update', { where: { id: 'A' }, data: { status: 'in_progress' } }])
  assert.match(out.warning, /Still blocked by: \*\*Router fix\*\*/)
  assert.equal(seen[0].actorLabel, 'Aashir (via the site)')
  assert.equal(seen[0].actorId, null)
  assert.equal(seen[0].guild.id, 'guild1')
  assert.equal(seen[0].warning, out.warning)
})

test('no warning when the status stays open, and a notify failure does not throw', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'T', status: 'in_progress' }
  const db = fakeDb()
  const out = await applyTaskUpdate({ db, client, task, updates: { status: 'open' }, actor: { discordId: '55' }, notify: async () => { throw new Error('boom') } })
  assert.equal(out.warning, '')
  assert.deepEqual(out.notified, { channelId: null, created: false, dmed: [] })
})

test('a failing warning lookup leaves the write in place and warning empty', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'T', status: 'open' }
  const db = fakeDb(); db.taskDependency.findByTask = async () => { throw new Error('db down') }
  const errors = []; const orig = console.error; console.error = (...a) => errors.push(a)
  try {
    const out = await applyTaskUpdate({ db, client, task, updates: { status: 'done' }, notify: async () => ({ channelId: null, created: false, dmed: [] }) })
    assert.equal(out.warning, '')
    assert.equal(db.calls.length, 1)
  } finally { console.error = orig }
})
```

Append to `taskUpdateNotify.test.js`: a channel post with `actorId: null, actorLabel: 'Afaq (via the site)'` starts with `Afaq (via the site) updated this task`; with neither it starts with `Someone updated`. Model the fake client/channel on the file's existing tests. `taskDeps.test.js`: `TASK_STATUSES` equals the six values in order.

- [ ] **Step 2: Run, expect failures.**

- [ ] **Step 3: Implement**

`taskDeps.js`: `export const TASK_STATUSES = ['open', 'pending', 'in_progress', 'resolved', 'closed', 'done']`.

`taskUpdateNotify.js`: signature gains `actorLabel = null`; `const who = actorId ? `<@${actorId}>` : (actorLabel || 'Someone')`.

`taskStatusChange.js`:

```js
import db from '../db/index.js'
import { notifyTaskUpdate } from './taskUpdateNotify.js'
import { blockerWarning, openBlockers } from '../utils/taskDeps.js'

export const WARNING_MAX = 1500

/**
 * Write `updates` to `task` and run the consequences: blocker warning, channel
 * post, DMs, unblock notices. Shared by /update-task and the site's status route.
 * The write is what matters; everything after it is best-effort.
 */
export async function applyTaskUpdate({ db: dbArg = db, client, task, updates, actor = {}, notify = notifyTaskUpdate, guild = null }) {
  await dbArg.task.update({ where: { id: task.id }, data: updates })

  let warning = ''
  if (updates.status && updates.status !== task.status && updates.status !== 'open' && updates.status !== 'pending') {
    try {
      const rows = await dbArg.taskDependency.findByTask({ where: { taskId: task.id } })
      const blockers = rows.length
        ? await dbArg.task.findByIds({ where: { guildConfigId: task.guildConfigId, ids: rows.map((r) => r.blockedByTaskId) } })
        : []
      const byId = Object.fromEntries(blockers.map((b) => [b.id, b]))
      warning = blockerWarning(openBlockers(task.id, rows, byId))
      if (warning.length > WARNING_MAX) warning = `${warning.slice(0, WARNING_MAX - 1)}…`
    } catch (e) {
      console.error('[taskStatusChange] blocker warning:', e?.message ?? e)
      warning = ''
    }
  }

  let notified = { channelId: task.discordChannelId || null, created: false, dmed: [] }
  try {
    let g = guild
    if (!g) {
      const cfg = await dbArg.guildConfig.findById(task.guildConfigId)
      g = cfg ? client?.guilds?.cache?.get(cfg.guildId) ?? null : null
    }
    notified = await notify({ client, guild: g, task, before: task, updates, actorId: actor.discordId ?? null, actorLabel: actor.label ?? null, warning, db: dbArg })
  } catch (e) {
    console.error('[taskStatusChange] notify:', e?.message ?? e)
  }
  return { warning, notified }
}
```

`update-task.js`: replace the block from `await dbArg.task.update(...)` through the `notify` try/catch with `({ warning, notified } = await applyTaskUpdate({ db: dbArg, client: interaction.client, guild, task, updates, actor: { discordId: interaction.user.id }, notify }))`; delete the now-unused `WARNING_MAX`, `blockerWarning`, `openBlockers` imports if nothing else uses them. Its existing tests (which pass `notify` and a fake `db` with `taskDependency.findByTask` and `task.findByIds`) must still pass; if a fake lacks `guildConfig.findById`, the helper is given `guild` directly so no lookup happens.

- [ ] **Step 4: Run** `npm test`. - [ ] **Step 5: Commit** `refactor(tasks): one status-change helper for Discord and the site, actor labels`

---

### Task 3: Internal status route on the bot

**Files:**
- Create: `bot/src/services/internalTaskRoute.js`, `bot/src/services/internalTaskRoute.test.js`
- Modify: `bot/src/server.js`

**Interfaces:**
- Produces: `handleStatusRequest({ headers, body, db, client, secret, apply = applyTaskUpdate })` → `{ status: number, body: object }`; `safeEqual(a, b)`.

- [ ] **Step 1: Failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleStatusRequest } from './internalTaskRoute.js'

const task = { id: 'A', guildConfigId: 'g1', title: 'Git Sync', status: 'open' }
const db = { task: { findFirst: async ({ where }) => (where.id === 'A' ? task : null) } }
const ok = { headers: { 'x-internal-secret': 's3cret' }, body: { taskId: 'A', status: 'in_progress', actor: { email: 'a@granjur.com', name: 'Aashir' } } }

test('503 when no secret is configured, before anything else', async () => {
  const r = await handleStatusRequest({ ...ok, db, client: {}, secret: '' })
  assert.equal(r.status, 503)
})
test('401 on a missing or wrong secret', async () => {
  assert.equal((await handleStatusRequest({ ...ok, headers: {}, db, client: {}, secret: 's3cret' })).status, 401)
  assert.equal((await handleStatusRequest({ ...ok, headers: { 'x-internal-secret': 'nope' }, db, client: {}, secret: 's3cret' })).status, 401)
})
test('400 on an unknown status or missing taskId', async () => {
  assert.equal((await handleStatusRequest({ ...ok, body: { ...ok.body, status: 'flying' }, db, client: {}, secret: 's3cret' })).status, 400)
  assert.equal((await handleStatusRequest({ ...ok, body: { status: 'open' }, db, client: {}, secret: 's3cret' })).status, 400)
})
test('404 when the task does not exist', async () => {
  assert.equal((await handleStatusRequest({ ...ok, body: { ...ok.body, taskId: 'Z' }, db, client: {}, secret: 's3cret' })).status, 404)
})
test('same status is a no-op 200', async () => {
  let applied = 0
  const r = await handleStatusRequest({ ...ok, body: { ...ok.body, status: 'open' }, db, client: {}, secret: 's3cret', apply: async () => { applied++ } })
  assert.equal(r.status, 200); assert.equal(r.body.unchanged, true); assert.equal(applied, 0)
})
test('success applies with a "(via the site)" label and returns the warning', async () => {
  let seen
  const r = await handleStatusRequest({ ...ok, db, client: { c: 1 }, secret: 's3cret', apply: async (a) => { seen = a; return { warning: '⛔ x', notified: {} } } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, task: { id: 'A', status: 'in_progress' }, warning: '⛔ x', unchanged: false })
  assert.deepEqual(seen.updates, { status: 'in_progress' })
  assert.equal(seen.actor.label, 'Aashir (via the site)')
})
test('a thrown error becomes 500 without leaking a stack', async () => {
  const errors = []; const orig = console.error; console.error = (...a) => errors.push(a)
  try {
    const r = await handleStatusRequest({ ...ok, db, client: {}, secret: 's3cret', apply: async () => { throw new Error('db down') } })
    assert.equal(r.status, 500); assert.equal(r.body.ok, false); assert.equal(r.body.message, 'db down')
  } finally { console.error = orig }
})
```

- [ ] **Step 2: Run, expect module-not-found.**

- [ ] **Step 3: Implement**

```js
import { timingSafeEqual } from 'node:crypto'
import db from '../db/index.js'
import { applyTaskUpdate } from './taskStatusChange.js'
import { TASK_STATUSES } from '../utils/taskDeps.js'

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

export async function handleStatusRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, apply = applyTaskUpdate }) {
  if (!secret) return { status: 503, body: { ok: false, message: 'internal route not configured' } }
  if (!safeEqual(headers['x-internal-secret'], secret)) return { status: 401, body: { ok: false, message: 'unauthorized' } }
  const taskId = String(body.taskId ?? '').trim()
  const status = String(body.status ?? '').trim()
  if (!taskId || taskId.length > 64) return { status: 400, body: { ok: false, message: 'taskId is required' } }
  if (!TASK_STATUSES.includes(status)) return { status: 400, body: { ok: false, message: `status must be one of ${TASK_STATUSES.join(', ')}` } }
  try {
    const task = await dbArg.task.findFirst({ where: { id: taskId } })
    if (!task) return { status: 404, body: { ok: false, message: 'Task not found' } }
    if (task.status === status) return { status: 200, body: { ok: true, task: { id: task.id, status }, warning: '', unchanged: true } }
    const name = String(body.actor?.name || body.actor?.email || 'Someone').slice(0, 100)
    const { warning } = await apply({ db: dbArg, client, task, updates: { status }, actor: { label: `${name} (via the site)` } })
    return { status: 200, body: { ok: true, task: { id: task.id, status }, warning: warning || '', unchanged: false } }
  } catch (e) {
    console.error('[internal] status route:', e?.message ?? e)
    return { status: 500, body: { ok: false, message: e?.message || 'internal error' } }
  }
}
```

`server.js`: before the `/verify` check, add: if `req.method === 'POST' && req.url === '/internal/tasks/status'`, read the body (reuse the same loop), `JSON.parse` (400 on failure), then `const r = await handleStatusRequest({ headers: req.headers, body: data, client: discordClient, secret: process.env.BOT_INTERNAL_SECRET || '' })`, `res.writeHead(r.status)`, `res.end(JSON.stringify(r.body))`, no CORS headers. Log at startup whether the internal route is enabled (`[internal] status route enabled` or `disabled: BOT_INTERNAL_SECRET unset`).

- [ ] **Step 4: Run** `npm test`; `node --check bot/src/server.js`. - [ ] **Step 5: Commit** `feat(bot): loopback route that sets a task status on behalf of a site user`

---

### Task 4: CSAAS read payload — task fields and members

Working directory CSAAS; `git fetch origin && git checkout -b feat/discord-tasks-status origin/main`.

**Files:**
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js`
- Test: `Services/SysScripts/TestScripts/discord-tasks-test/assemble.test.js`

**Interfaces:**
- Produces: task shape + `description, scope, modules, createdBy, passedApiTests, passedQaTests, passedAcceptanceCriteria, projectId, projectName`; top-level `members: [{ discordId, name, username, roleNames, status, verified, projects: [{ id, name, docsSlug, role }] }]`; `assembleTasks` accepts `names` rows carrying `roleNames, status, verifiedAt`.

- [ ] **Step 1: Failing assertions** (append to the test's `run()`): with a task carrying `description: 'd', scope: 's', modules: '["auth","api"]', createdBy: 'u1', passedApiTests: 3, passedQaTests: null, passedAcceptanceCriteria: 1` assert those come through (`modules` as `['auth','api']`, `createdBy` as `{ discordId: 'u1', name: 'Aashir Adnan' }`, nulls preserved, `projectId`/`projectName` present). With `names` rows carrying `roleNames: '["Senior Dev"]', status: 'approved', verifiedAt: '2026-01-01'` and one row with `verifiedAt: null`, assert `out.members` is sorted by name, has `roleNames` arrays, `verified` booleans, and `projects` listing explicit memberships with `role`.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement.** SELECTs gain the columns (`task`: `description, scope, modules, createdBy, passedApiTests, passedQaTests, passedAcceptanceCriteria, projectName`; `guildmember`: `roleNames, status, verifiedAt`). `shapeTask` adds the fields (`modules: idListLike(t.modules)` reusing the JSON-tolerant parser but keeping strings; `createdBy: t.createdBy ? { discordId: String(t.createdBy), name: nameFor(...) } : null`). Build `members` from `names` rows: `roleNames` parsed like modules, `verified: !!n.verifiedAt`, `projects` from `members` rows joined to `projects` by id, sorted by `name`. Return `{ generatedAt, projects, members }`.

- [ ] **Step 4: Run** the test script. - [ ] **Step 5: Commit** `feat(discord): task detail fields and a members list in the tasks payload`

---

### Task 5: CSAAS status write endpoint and permission migration

**Files:**
- Create: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksStatus.js`, `Services/SysScripts/TestScripts/discord-tasks-test/status.test.js`, `data/migrations/20260918_1_update_discord_tasks_permission.sql`

**Interfaces:**
- Produces: `setTaskStatus(req, decryptedPayload)` → `{ task, warning, unchanged }`; `__setTestHooks({ requirePortalPermission, fetch, executeQuery, env })`; `global.DiscordTasksStatus_object`.

- [ ] **Step 1: Failing test** (plain assert, like `utterance.test.js`), covering: permission refusal propagates the thrown 403; missing `task_id` → 400; bad status → 400; missing secret env → 503 with "not configured" and no fetch; bot 404 → 404 "Task not found"; bot 400 → 400 with the bot's message; bot 401 → 502 "rejected"; fetch throwing (`AbortError`) → 502 "not reachable"; success → `{ task, warning, unchanged }` and the fetch was called with the right URL, header and JSON body carrying `actor.email` from `decryptedPayload.actor_email`.

- [ ] **Step 2: Run, expect module-not-found.**

- [ ] **Step 3: Implement**

```js
const { requirePortalPermission } = require("../../../HelperFunctions/PreProcessingFunctions/ProjectTenancy/portalAuthz");
const { executeQuery } = require("../../../../Services/Integrations/Database/queryExecution");

const STATUSES = ["open", "pending", "in_progress", "resolved", "closed", "done"];
const __hooks = {
  requirePortalPermission: (...a) => requirePortalPermission(...a),
  fetch: (...a) => globalThis.fetch(...a),
  executeQuery: (...a) => executeQuery(...a),
  env: () => process.env,
};
function __setTestHooks(o) { Object.assign(__hooks, o); }
const fail = (statusCode, message) => ({ statusCode, message });

async function actorName(email) {
  try { const r = await __hooks.executeQuery("SELECT name FROM users WHERE email = ? LIMIT 1", [email]); return r[0]?.name || null; } catch { return null; }
}

async function setTaskStatus(req, decryptedPayload) {
  await __hooks.requirePortalPermission(req, decryptedPayload, "update_discord_tasks");
  const taskId = String(decryptedPayload.task_id ?? "").trim();
  const status = String(decryptedPayload.status ?? "").trim();
  if (!taskId || taskId.length > 64) throw fail(400, "task_id is required");
  if (!STATUSES.includes(status)) throw fail(400, `status must be one of ${STATUSES.join(", ")}`);
  const env = __hooks.env();
  const secret = env.DISCORD_BOT_SECRET;
  if (!secret) throw fail(503, "Discord bot link is not configured");
  const base = (env.DISCORD_BOT_URL || "http://127.0.0.1:4070").replace(/\/$/, "");
  const email = decryptedPayload.actor_email || null;
  const name = email ? await actorName(email) : null;
  let res;
  try {
    res = await __hooks.fetch(`${base}/internal/tasks/status`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ taskId, status, actor: { email, name } }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw fail(502, "Discord bot is not reachable");
  }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (res.status === 404) throw fail(404, "Task not found");
  if (res.status === 400) throw fail(400, data.message || "Rejected by the Discord bot");
  if (res.status === 401 || res.status === 503) throw fail(502, "Discord bot rejected the request (configuration)");
  if (!res.ok) throw fail(502, data.message || "Discord bot error");
  console.log(`[discord-tasks] ${email || "unknown"} set ${taskId} -> ${status}`);
  return { task: data.task, warning: data.warning || "", unchanged: !!data.unchanged };
}
```

API object: copy the `step()` shape from `portalUsers.js` inline (fields `task_id`, `status`, method `POST`, `accessToken: true`, `bindActorToToken: true`), `global.DiscordTasksStatus_object`. Export `{ DiscordTasksStatus_object, setTaskStatus, __setTestHooks }`. Confirm by reading `Services/Middlewares/config.js` how a thrown `{ statusCode, message }` from a post-process function becomes the HTTP status (the portal handlers rely on it).

Migration:

```sql
INSERT IGNORE INTO `permissions` (`permission_name`, `status`) VALUES ('update_discord_tasks', 'active');

INSERT IGNORE INTO `permission_groups_permissions` (`group_id`, `permission_id`, `status`)
SELECT g.`permission_group_id`, p.`permission_id`, 'active'
FROM `permission_groups` g
JOIN `roles` r ON r.`role_id` = g.`role_id`
JOIN `permissions` p ON p.`permission_name` = 'update_discord_tasks'
WHERE r.`role_name` IN ('Admin', 'Dev') AND g.`designation_id` IS NULL;

INSERT IGNORE INTO `user_role_designation_permissions`
  (`user_role_designation_department_id`, `permission_id`, `source`, `status`)
SELECT urdd.`user_role_designation_department_id`, p.`permission_id`, 'group', 'active'
FROM `user_roles_designations_department` urdd
JOIN `roles_designations_department` rdd ON rdd.`role_designation_department_id` = urdd.`role_designation_department_id`
JOIN `roles` r ON r.`role_id` = rdd.`role_id`
JOIN `permissions` p ON p.`permission_name` = 'update_discord_tasks'
WHERE urdd.`status` = 'active' AND r.`role_name` IN ('Admin', 'Dev');
```

Verify the column names against `data/migrations_completed/20260717_1_permission_groups.sql` and the schema dump before committing.

- [ ] **Step 4: Run** the two test scripts and the require check. - [ ] **Step 5: Commit** (named files) `feat(discord): POST /api/discord/tasks/status — permission-gated status change through the bot`

---

### Task 6: Site pure logic and API

Working directory UBS-Doc; `git fetch origin && git checkout -b feat/team-section origin/main`.

**Files:**
- Modify: `src/screens/tasksLogic.ts` (+ test), `src/components/discordTasks/api.ts`
- Create: `src/screens/team/boardLogic.ts`, `graphLayout.ts`, `teamLogic.ts`, `redirect.ts` and their `.test.ts`

**Interfaces:**
- `tasksLogic.ts`: `TaskRow` gains `description: string|null, scope: string|null, modules: string[], createdBy: {discordId,name}|null, passedApiTests/passedQaTests/passedAcceptanceCriteria: number|null, projectId: string|null, projectName: string|null`; new `TeamMember { discordId, name, username, roleNames: string[], status, verified, projects: {id,name,docsSlug,role}[] }`; `TasksPayload` gains `members: TeamMember[]`; `findTask(payload, id)` → `{ task, project } | null`; `allTasks(projects)`.
- `boardLogic.ts`: `COLUMNS = [{ key:'open', label:'Open', status:'open' }, { key:'pending', ... }, { key:'in_progress', label:'In progress', status:'in_progress' }, { key:'done', label:'Done', status:'done' }]`; `columnOf(status)` (terminal → 'done'); `statusForColumn(key)`; `groupByColumn(tasks)` → `Record<key, TaskRow[]>` preserving order; `dropOutcome(task, key)` → `{ change: false } | { change: true, status }`.
- `graphLayout.ts`: `layoutGraph(tasks, { nodeW = 180, nodeH = 44, gapX = 60, gapY = 16 })` → `{ nodes: {id,title,x,y,blocked,terminal,depth}[], edges: {from,to}[], width, height }`; only tasks with ≥1 edge inside the set; depth = longest path from a node with no in-set blockers; cap 1000 relaxations.
- `teamLogic.ts`: `memberWorkload(member, tasks)` → `{ open, in_progress, blocked, total }` counting tasks where the member is an assignee; `sortMembers(members, tasks)` by open desc then name; `filterMembers(members, tasks, filters)`.
- `redirect.ts`: `legacyTasksRedirect(search)` → `/tools/team/tasks${search}`.
- `api.ts`: `setTaskStatus(taskId, status)` → `mwPost('/discord/tasks/status', { task_id: taskId, status })` returning `{ task, warning, unchanged }`.

- [ ] **Step 1: Failing vitests** — board: `columnOf('resolved') === 'done'`, `dropOutcome` no-op on same column, `groupByColumn` keeps every task once; graph: three tasks A←B←C give depths 0,1,2 and x increasing, a task with no edges is excluded, a cycle terminates; team: workload counts only assigned tasks, sort order, filter by project narrows to members on the project or assigned within it; redirect keeps `?project=x`.
- [ ] **Step 2: Run, expect failures.** - [ ] **Step 3: Implement** all five modules (pure; no React). - [ ] **Step 4: `npx vitest run`.** - [ ] **Step 5: Commit** `feat(team): board, graph, team and redirect logic`

---

### Task 7: Team layout, routes, navigation, tasks list moved

**Files:**
- Create: `src/screens/team/TeamLayout.tsx`, `src/screens/team/TasksList.tsx`
- Modify: `src/app/routes.tsx`, `src/screens/ToolsHub.tsx`, `src/components/Sidebar.tsx`, `src/screens/Projects.tsx`
- Delete: `src/screens/Tasks.tsx`

**Interfaces:**
- `TeamLayout` provides `useTeam()` (a typed `useOutletContext`) → `{ payload: TasksPayload|null, loading, error, refresh, filters, setFilter, people }`. Tabs: People (`/tools/team`), Tasks (`/tools/team/tasks`), Board (`/tools/team/board`); active tab from `useLocation`. Filter bar: project, assignee, blocked-only, search; status select rendered only on the Tasks tab (the layout knows the tab).
- `TasksList` is `Tasks.tsx`'s body using `useTeam()`; each row's title links to `/tools/team/tasks/${t.id}`; the unknown-slug notice stays.
- Routes: `<Route path="/tools/team" element={T(<TeamLayout />)}>` with `index` → `<People />` (placeholder component rendering "People — coming in Task 8" until Task 8 replaces it), `tasks` → `<TasksList />`, `tasks/:taskId` → placeholder, `board` → placeholder. `<Route path="/tools/tasks" element={<LegacyTasksRedirect />} />` where the component does `const { search } = useLocation(); return <Navigate to={legacyTasksRedirect(search)} replace />`.
- ToolsHub card: `{ label: 'Team', desc: 'People, tasks, board and blockers', Icon: Users, route: '/tools/team', from: '#F59E0B', to: '#EF4444' }` replacing Tasks. Sidebar: `{ to: '/tools/team', label: 'Team', Icon: Users }` replacing Tasks. Projects link → `/tools/team/tasks?project=`.

- [ ] Build, `npx vitest run`, `npm run build`; manually confirm the route table by reading `routes.tsx`. Commit `feat(team): Team section layout with tabs, tasks list moved, legacy redirect`.

---

### Task 8: People and Task detail

**Files:** Create `src/screens/team/People.tsx`, `src/screens/team/TaskDetail.tsx`; modify `routes.tsx` to use them.

Follow spec §6.2 and §6.3 exactly. People cards use `sortMembers`/`filterMembers`/`memberWorkload`; the "only people with open tasks" toggle is local state. TaskDetail uses `findTask`; while `loading && !payload` show the loading treatment; not found → card with a link back to `/tools/team/tasks`. Dates via `toLocaleDateString`. Test counters render `—` for null. Blocked-by entries link to their detail pages. Build + vitest; commit `feat(team): people page and task detail`.

---

### Task 9: Board with drag-to-status

**Files:** Create `src/screens/team/Board.tsx`, `src/screens/team/Toast.tsx`; modify `routes.tsx`.

- Four columns from `COLUMNS`, cards from `groupByColumn(applyFilters(...))`. `const { has, loaded } = useActingPermissions(); const canMove = has('update_discord_tasks')`.
- Card: `draggable={canMove}`, `onDragStart` sets `e.dataTransfer.setData('text/task-id', t.id)` and `effectAllowed = 'move'`. Column: `onDragOver` prevents default when `canMove`, adds a highlight class; `onDrop` reads the id, `dropOutcome(task, col.key)`; if no change return; else optimistic: keep `overrides: Record<id, status>` in state and render with them; call `setTaskStatus`; on success show `warning` toast (8 s) if non-empty, then `refresh()`; on failure remove the override and toast the error: 403 → "You can't move tasks. Ask an admin for the update_discord_tasks permission."; message containing "not reachable"/"offline" → "Discord bot is offline, try again."; else the message. Detect 403 by the thrown error's message from `mwPost` (it throws `data.error || text`), so also check `String(e.message)` for "Permission" — the CSAAS message is `Permission 'update_discord_tasks' is required for this action`.
- Note above the board when `loaded && !canMove`: "You can view the board. Ask an admin for the update_discord_tasks permission to move cards."
- `Toast.tsx`: `{ message, tone: 'info'|'error', onClose }`, fixed bottom-right, auto-close via `setTimeout`, cleared on unmount.
- A vitest for a pure `classifyDropError(message)` helper in `boardLogic.ts` (403/offline/other).

Build + vitest; commit `feat(team): kanban board with drag-to-status through the bot`.

---

### Task 10: Dependency graph

**Files:** Create `src/screens/team/DependencyGraph.tsx`; modify `TasksList.tsx` (Graph toggle per project card).

`layoutGraph(project.tasks)`; SVG `width`/`height` from the result, wrapped in `overflow-x-auto`; `<defs><marker id="arrow" ...>` once; edges as `<line>` from the right edge of `from` to the left edge of `to`, `markerEnd="url(#arrow)"`; nodes as `<g onClick={() => navigate(...)}>` with `<rect rx=8>` (red stroke when blocked, muted fill when terminal) and `<text>` (title clipped to 28 chars + `…`, with a `<title>` child for the full text). Toggle only shown when the project has any edge. Build + vitest; commit `feat(team): per-project dependency graph`.

---

### Task 11: Knowledge and state

Extend `.claude/knowledge/project-tasks-site.md` with a "Team section and the write path" part: routes, the three hops with the exact headers and env names, the permission and its backfill, the bot route's status codes, the drop rule, and how to verify (curl the bot route with and without the secret from the VM; the Discord post text). Update `backlog.md` (deferred items from reviews), `completed.md` (dated 2026-09-18, "built and reviewed on branches, not yet merged"), `session.md`. Commit `docs: team section — knowledge and state`.

---

## Verification after deploy (controller)

1. Bot: merge, push; deploy log shows migration 018 applied; `pm2 logs` shows `[internal] status route disabled` until the secret is set. Set `BOT_INTERNAL_SECRET`, restart, see `enabled`. From the VM: `curl -s -X POST localhost:4070/internal/tasks/status -H 'content-type: application/json' -d '{}'` → 401; with the header and a bad status → 400.
2. CSAAS: merge, push; migration applied at boot (check `data/migrations_completed/`); set `DISCORD_BOT_URL`, `DISCORD_BOT_SECRET`; restart. `curl -s https://api.gobizzi.com/api/discord/tasks | jq '.payload.return.members | length'`.
3. Site: merge, push; open `/tools/team`, `/tools/team/board`; drag a card; see the Discord channel post and, for a blocked card, the warning toast.

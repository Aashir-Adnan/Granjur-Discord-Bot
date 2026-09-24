# Per-project Status Buckets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every project's ticket channels (`feature-…`, `bug-…`, `task-…`) live in one of three sibling categories — `📂 NAME · OPEN`, `📂 NAME · IN PROGRESS`, `📂 NAME · DONE` — chosen by the task's status, move on every status change from any writer, and a finished ticket's channel is locked and deleted after 14 days.

**Architecture:** A leaf module (`bot/src/utils/statusBuckets.js`) owns the status→bucket table and the bucket names; bucket category ids ride in the existing `project.discordChannels` JSON map. Ticket creation (`taskTicketChannel.js`) parents by bucket; the single status-write path (`applyTaskUpdate`) calls one mover (`ticketBucketMove.js`) that re-parents the channel and runs the Done transition (`ticketRetire.js`: lock + stamp `task.channelRetireAt`, hourly sweep deletes). `/project-setup` observes, plans and applies the three buckets exactly the way it does the section category, then files every ticket by status.

**Tech Stack:** Node 24 ESM, discord.js v14, hand-rolled SQL layer (`bot/src/Database/index.js`), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-24-status-buckets-design.md`

## Global Constraints

- The root `.env` points at **production**. Every function under test takes `{ db, getConfig, … }` seams and every test passes fakes. Run every test as `cd bot && DATABASE_URL=poisoned://no-production-access npm test` (or `node --test <file>` with the same env). Never run a test against code that ignores its seams — see `.claude/rules/tests-never-touch-production.md`.
- Commit trailer, exactly: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Commit author is the repo's configured identity (Nauraiz Haider); do not override it.
- Before any commit, the **full** suite must print `ℹ fail 0`. A grepped summary line exits 0 even when red — gate on the line itself:
  `OUT=$(DATABASE_URL=poisoned://no-production-access npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"); echo "$OUT"; echo "$OUT" | grep -q "^ℹ fail 0$" || { echo SUITE RED; exit 1; }`
- `bot/src/services/taskTicketChannel.js` and `bot/src/utils/*` are **leaves**: they must never import `services/projectSection.js` or anything that reaches `db/index.js` (the note at the top of `taskTicketChannel.js` explains the incident). New leaf helpers go in `bot/src/utils/`.
- Bucket table, verbatim from the spec: `open` = `open`, `pending`; `inProgress` = `in_progress`; `done` = `done`, `resolved`, `closed`, `abandoned`. Unknown/empty/null status → `open`. Store keys `bucketOpen`, `bucketInProgress`, `bucketDone`. Labels `OPEN`, `IN PROGRESS`, `DONE`. Name format `📂 <NAME> · <LABEL>` (space, middle dot U+00B7, space), cut to 100 characters by truncating the name, never the suffix.
- `RETIRE_AFTER_MS = 14 * 24 * 60 * 60 * 1000`. `CATEGORY_SOFT_CAP` (49) from `bot/src/constants.js` is the per-bucket cap.
- Every overwrite the bot writes carries an explicit `type` (`OverwriteType.Role` / `OverwriteType.Member`). A bucket move is a parent-only `channel.edit({ parent })` — never `lockPermissions`, never a `permissionOverwrites` payload.
- Nothing in `/project-setup` deletes a channel. Only the sweep (`sweepRetiredTickets`) deletes, and only channels whose `channelRetireAt` has passed.
- Non-ASCII in source (`📂`, `·`) must be written with the Write/Edit tools, not shell heredocs — heredocs in this environment mangle them.

## Review Focus

Inputs the spec implies that a user will hit, each pinned by a test in the task named:

1. **A stored bucket id that now resolves to a text channel** (id reused or hand-edited): creation and `/project-setup` must treat it as missing, never pass it as `parent`. → Task 4 (`taskTicketChannel.test.js`), Task 7 (observe test).
2. **A status change on a task whose channel was already swept** (`discordChannelId` null): the mover is a no-op with `reason: 'no-channel'`, and the fresh channel `notifyTaskUpdate` opens lands in the bucket for the *new* status. → Task 5 (mover test), Task 4 (notify passes `status`).
3. **Two projects whose names collide** (`Framework` / `framework`): the second must not adopt the first's bucket by name. → Task 7 (claimed-id test).
4. **A finished ticket already stamped** when `/project-setup` runs again: no re-stamp, or the 14 days would restart on every run. → Task 7 (`retire` flag only without a stamp).
5. **The sweep meets a channel Discord already deleted** (error code 10003): the row is cleared and counted as deleted rather than retried forever. → Task 3 (sweep test).

---

### Task 1: Bucket table and names (leaf helpers)

**Files:**
- Create: `bot/src/utils/projectStore.js`
- Create: `bot/src/utils/statusBuckets.js`
- Modify: `bot/src/services/projectSection.js` (move `cut` and `storedChannels` out; re-export)
- Test: `bot/src/utils/statusBuckets.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `projectStore.js`: `cut(text, max): string`, `storedChannels(project): object` — the two functions currently at `projectSection.js` (`cut` ~line 89, `storedChannels` ~line 550), moved verbatim.
  - `statusBuckets.js`: `BUCKETS` (array of `{ key, storeKey, label, statuses }`), `bucketFor(status): 'open'|'inProgress'|'done'`, `isDoneBucket(key): boolean`, `bucketByKey(key): object|null`, `bucketNameFor(project, bucketOrKey): string`, `bucketIdsOf(project): { open, inProgress, done }` (ids or `null`), `MAX_CATEGORY_NAME = 100`.
  - `projectSection.js` keeps exporting `cut` and `storedChannels` (re-export), so every existing importer is untouched.

- [ ] **Step 1: Write the failing tests**

Create `bot/src/utils/statusBuckets.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUCKETS, bucketFor, isDoneBucket, bucketByKey, bucketNameFor, bucketIdsOf, MAX_CATEGORY_NAME } from './statusBuckets.js'

test('every status maps to its bucket; unknown, empty and null file as open', () => {
  assert.equal(bucketFor('open'), 'open')
  assert.equal(bucketFor('pending'), 'open')
  assert.equal(bucketFor('in_progress'), 'inProgress')
  for (const s of ['done', 'resolved', 'closed', 'abandoned']) assert.equal(bucketFor(s), 'done')
  // Case and whitespace do not matter: a status typed by hand on the site still files.
  assert.equal(bucketFor('IN_PROGRESS'), 'inProgress')
  assert.equal(bucketFor(' Done '), 'done')
  assert.equal(bucketFor(null), 'open')
  assert.equal(bucketFor(undefined), 'open')
  assert.equal(bucketFor(''), 'open')
  assert.equal(bucketFor('whatever'), 'open')
})

test('isDoneBucket is true for done only', () => {
  assert.equal(isDoneBucket('done'), true)
  assert.equal(isDoneBucket('open'), false)
  assert.equal(isDoneBucket('inProgress'), false)
  assert.equal(isDoneBucket(null), false)
})

test('bucketByKey finds the table row, null for anything else', () => {
  assert.equal(bucketByKey('inProgress').storeKey, 'bucketInProgress')
  assert.equal(bucketByKey('nope'), null)
})

test('bucket names: folder emoji, upper-cased name, the label', () => {
  const p = { name: 'Framework' }
  assert.equal(bucketNameFor(p, 'open'), '📂 FRAMEWORK · OPEN')
  assert.equal(bucketNameFor(p, 'inProgress'), '📂 FRAMEWORK · IN PROGRESS')
  assert.equal(bucketNameFor(p, BUCKETS[2]), '📂 FRAMEWORK · DONE')
  assert.equal(bucketNameFor({ name: '  ubs doc ' }, 'done'), '📂 UBS DOC · DONE')
  assert.throws(() => bucketNameFor(p, 'nope'), /unknown bucket/)
})

test('a long project name is cut so the label survives at 100 characters', () => {
  const name = bucketNameFor({ name: 'x'.repeat(120) }, 'inProgress')
  assert.equal(name.length, MAX_CATEGORY_NAME)
  assert.ok(name.endsWith(' · IN PROGRESS'))
  assert.ok(name.startsWith('📂 XXX'))
})

test('bucketIdsOf reads the stored map — object or JSON string — with missing keys as null', () => {
  assert.deepEqual(
    bucketIdsOf({ discordChannels: { bucketOpen: 'a', bucketDone: 'c', members: 'm' } }),
    { open: 'a', inProgress: null, done: 'c' }
  )
  assert.deepEqual(
    bucketIdsOf({ discordChannels: JSON.stringify({ bucketInProgress: 'b' }) }),
    { open: null, inProgress: 'b', done: null }
  )
  assert.deepEqual(bucketIdsOf({ discordChannels: '{not json' }), { open: null, inProgress: null, done: null })
  assert.deepEqual(bucketIdsOf({}), { open: null, inProgress: null, done: null })
  assert.deepEqual(bucketIdsOf(null), { open: null, inProgress: null, done: null })
})

test('store keys are three distinct bucket* keys, so they never collide with a section key', () => {
  const keys = BUCKETS.map((b) => b.storeKey)
  assert.deepEqual(keys, ['bucketOpen', 'bucketInProgress', 'bucketDone'])
  assert.deepEqual(BUCKETS.map((b) => b.key), ['open', 'inProgress', 'done'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/utils/statusBuckets.test.js`
Expected: FAIL — `Cannot find module './statusBuckets.js'`.

- [ ] **Step 3: Move `cut` and `storedChannels` into a leaf**

Create `bot/src/utils/projectStore.js` with the two functions cut **verbatim** from `bot/src/services/projectSection.js` (their JSDoc too):

```js
// Two small helpers that used to live in services/projectSection.js and moved
// here unchanged. The bucket helpers (statusBuckets.js) need both, and they are
// imported by services/taskTicketChannel.js, which must stay a leaf: importing
// the planner drags projectMembersPanel → db/index.js → the production .env into
// a module whose tests touch no database. projectSection.js re-exports both, so
// every existing importer is unchanged.

/**
 * Cut to `max` UTF-16 units without leaving half of a surrogate pair behind.
 */
export function cut(text, max) {
  if (text.length <= max) return text
  const sliced = text.slice(0, max)
  const last = sliced.charCodeAt(sliced.length - 1)
  // A lone high surrogate would render as a replacement character.
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced
}

/** The project's stored channel-id map, whether MySQL handed back an object or a string. */
export function storedChannels(project) {
  const raw = project?.discordChannels
  if (!raw) return {}
  if (typeof raw === 'object') return { ...raw }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? { ...parsed } : {}
  } catch {
    return {}
  }
}
```

In `bot/src/services/projectSection.js`: delete the bodies of `export function cut` and `export function storedChannels` (keep any JSDoc paragraph you want by moving it to the new file), and add near the other imports:

```js
import { cut, storedChannels } from '../utils/projectStore.js'
export { cut, storedChannels }
```

- [ ] **Step 4: Write `statusBuckets.js`**

```js
// The status→bucket table behind the per-project status categories. A leaf:
// imported by services/taskTicketChannel.js, which must not reach the planner.
import { cut, storedChannels } from './projectStore.js'

/** Discord's cap on a category name. */
export const MAX_CATEGORY_NAME = 100

/**
 * One row per bucket, in sidebar order. `statuses` are the task statuses that
 * file there; `storeKey` is the key under which the bucket category's id is
 * kept in `project.discordChannels`, beside the section channel ids, so the
 * cross-project claim set and /cleanup's protection cover it for free.
 */
export const BUCKETS = [
  { key: 'open', storeKey: 'bucketOpen', label: 'OPEN', statuses: ['open', 'pending'] },
  { key: 'inProgress', storeKey: 'bucketInProgress', label: 'IN PROGRESS', statuses: ['in_progress'] },
  { key: 'done', storeKey: 'bucketDone', label: 'DONE', statuses: ['done', 'resolved', 'closed', 'abandoned'] },
]

const BY_KEY = Object.fromEntries(BUCKETS.map((b) => [b.key, b]))
const BY_STATUS = new Map(BUCKETS.flatMap((b) => b.statuses.map((s) => [s, b.key])))

/** The bucket key for a status. Unknown, empty or null files as open. Never throws. */
export function bucketFor(status) {
  return BY_STATUS.get(String(status ?? '').trim().toLowerCase()) ?? 'open'
}

export function isDoneBucket(key) {
  return key === 'done'
}

export function bucketByKey(key) {
  return BY_KEY[key] ?? null
}

/**
 * '📂 FRAMEWORK · OPEN'. The name is cut so the suffix always survives the
 * 100-character cap — a bucket whose label was cut off would be unreadable.
 */
export function bucketNameFor(project, bucket) {
  const b = typeof bucket === 'string' ? BY_KEY[bucket] : bucket
  if (!b?.label) throw new Error(`unknown bucket ${String(bucket)}`)
  const suffix = ` · ${b.label}`
  const head = `📂 ${String(project?.name ?? '').trim().toUpperCase()}`
  return cut(head, MAX_CATEGORY_NAME - suffix.length) + suffix
}

/** The stored bucket category ids, by bucket key; null where none is stored. */
export function bucketIdsOf(project) {
  const stored = storedChannels(project)
  const out = {}
  for (const b of BUCKETS) out[b.key] = stored[b.storeKey] || null
  return out
}
```

- [ ] **Step 5: Run the new test and the full suite**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/utils/statusBuckets.test.js`
Expected: PASS (7 tests).

Run the full suite with the gate from Global Constraints. Expected: `ℹ fail 0` (the re-export keeps every `cut`/`storedChannels` importer green).

- [ ] **Step 6: Commit**

```bash
git add bot/src/utils/projectStore.js bot/src/utils/statusBuckets.js bot/src/utils/statusBuckets.test.js bot/src/services/projectSection.js
git commit -m "feat(buckets): status bucket table and names as a leaf helper

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Migration 026 and the `channelRetireAt` DB surface

**Files:**
- Create: `bot/src/Database/migrations/026_task_channel_retire.sql`
- Modify: `bot/src/Database/index.js` (`taskUpdate` ~line 415; the `task:` object ~line 2340)

**Interfaces:**
- Produces: `db.task.update({ where: { id }, data: { channelRetireAt: Date|null } })` writes the column; `db.task.findRetirable({ where: { before: Date }, take? })` → task rows with `discordChannelId IS NOT NULL AND channelRetireAt IS NOT NULL AND channelRetireAt <= before`, oldest stamp first, at most `take` (default 100, max 500).

There is no DB-layer test (the layer only runs against a live database, which is production). Verification is a syntax check and the full suite staying green.

- [ ] **Step 1: Write the migration**

Copy the guard pattern of `025_client_role.sql` (column guard and the `idx_task_requestedBy` index guard). Create `bot/src/Database/migrations/026_task_channel_retire.sql`:

```sql
-- Status buckets: when a finished ticket's channel is to be deleted.
-- NULL means "not scheduled": the task is not in its project's Done bucket, or
-- was never filed there. Written when a task enters Done (14 days out), cleared
-- when it leaves; the hourly sweep deletes channels whose stamp has passed.
-- Guarded so the file can run twice.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND COLUMN_NAME = 'channelRetireAt');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE task ADD COLUMN channelRetireAt DATETIME DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND INDEX_NAME = 'idx_task_channelRetireAt');
SET @sql = IF(@idx_exists = 0, 'CREATE INDEX idx_task_channelRetireAt ON task (channelRetireAt)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

If 025's index guard uses a different `information_schema` query, use 025's form — the point is that the file matches its neighbours.

- [ ] **Step 2: Extend `taskUpdate`**

In `bot/src/Database/index.js`, inside `taskUpdate`, next to the `discordChannelId` branch, add:

```js
  // When the channel is to be deleted (status buckets); null clears it.
  if (data.channelRetireAt !== undefined) {
    sets.push("channelRetireAt = ?");
    vals.push(data.channelRetireAt);
  }
```

- [ ] **Step 3: Add `taskFindRetirable`**

Below `taskFindChildren`, following its style (`query`, `LIMIT` inline):

```js
// Finished tickets whose channel is due for deletion: stamped, still pointing
// at a channel, stamp in the past. Oldest stamp first so a backlog drains in
// order. Across every guild — the sweep runs once for the whole bot.
async function taskFindRetirable({ where, take = 100 } = {}) {
  const before = where?.before instanceof Date ? where.before : new Date();
  const limit = Math.max(1, Math.min(500, Number(take) || 100));
  return query(
    "SELECT * FROM `task` WHERE discordChannelId IS NOT NULL AND channelRetireAt IS NOT NULL AND channelRetireAt <= ? ORDER BY channelRetireAt ASC LIMIT " + limit,
    [before],
  );
}
```

Register it in the `task:` object: `findRetirable: taskFindRetirable,` after `findChildren`.

- [ ] **Step 4: Verify**

Run: `cd bot && node --check src/Database/index.js` — Expected: no output.
Run the full suite with the gate. Expected: `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add bot/src/Database/migrations/026_task_channel_retire.sql bot/src/Database/index.js
git commit -m "feat(buckets): migration 026 — task.channelRetireAt and findRetirable

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Lock/unlock helpers and the retire service with its sweep

**Files:**
- Modify: `bot/src/utils/channels.js`
- Create: `bot/src/services/ticketRetire.js`
- Test: `bot/src/utils/channels.test.js`, `bot/src/services/ticketRetire.test.js`

**Interfaces:**
- Consumes: `db.task.update`, `db.task.findRetirable` (Task 2).
- Produces:
  - `channels.js`: `lockTicketChannel(channel) → { edited, failed }`, `unlockTicketChannel(channel) → { edited, failed }`. `lockChannelAndScheduleDeletion` **stays for now** (its two callers switch in Task 6, which removes it).
  - `ticketRetire.js`: `RETIRE_AFTER_MS`, `retireTicketChannel({ channel, task, db, now }) → { retireAt, locked }`, `reviveTicketChannel({ channel, task, db }) → { unlocked }`, `sweepRetiredTickets({ client, db, now, take }) → { deleted, failed }`, `startTicketRetireSweep(client, { db, intervalMs }) → timer`.

- [ ] **Step 1: Write the failing tests**

Create `bot/src/utils/channels.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js'
import { lockTicketChannel, unlockTicketChannel } from './channels.js'

const bits = (...flags) => new PermissionsBitField(flags)

function channelWith(overwrites, { failOn = null } = {}) {
  const edits = []
  return {
    id: 'ch1',
    edits,
    permissionOverwrites: {
      cache: new Map(overwrites.map((o) => [o.id, o])),
      edit: async (id, patch) => {
        if (failOn === id) throw new Error('Missing Permissions')
        edits.push([id, patch])
      },
    },
  }
}

test('lock: every overwrite that allows sending is denied it; the rest are untouched', async () => {
  const ch = channelWith([
    { id: 'G1', allow: bits(), deny: bits(PermissionFlagsBits.ViewChannel) },
    { id: 'assignee', allow: bits(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages), deny: bits() },
    { id: 'role', allow: bits(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages), deny: bits() },
    { id: 'viewer', allow: bits(PermissionFlagsBits.ViewChannel), deny: bits() },
  ])
  const out = await lockTicketChannel(ch)
  assert.deepEqual(ch.edits, [['assignee', { SendMessages: false }], ['role', { SendMessages: false }]])
  assert.deepEqual(out, { edited: 2, failed: 0 })
})

test('lock: one failing overwrite is counted and the others are still edited', async () => {
  const ch = channelWith(
    [
      { id: 'a', allow: bits(PermissionFlagsBits.SendMessages), deny: bits() },
      { id: 'b', allow: bits(PermissionFlagsBits.SendMessages), deny: bits() },
    ],
    { failOn: 'a' }
  )
  const out = await lockTicketChannel(ch)
  assert.deepEqual(ch.edits, [['b', { SendMessages: false }]])
  assert.deepEqual(out, { edited: 1, failed: 1 })
})

test('unlock: only overwrites that can view AND were denied sending get it back — @everyone never does', async () => {
  const ch = channelWith([
    { id: 'G1', allow: bits(), deny: bits(PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages) },
    { id: 'assignee', allow: bits(PermissionFlagsBits.ViewChannel), deny: bits(PermissionFlagsBits.SendMessages) },
    { id: 'viewer', allow: bits(PermissionFlagsBits.ViewChannel), deny: bits() },
  ])
  const out = await unlockTicketChannel(ch)
  assert.deepEqual(ch.edits, [['assignee', { SendMessages: true }]])
  assert.deepEqual(out, { edited: 1, failed: 0 })
})

test('lock and unlock tolerate a channel with no readable overwrites', async () => {
  assert.deepEqual(await lockTicketChannel({ id: 'x' }), { edited: 0, failed: 0 })
  assert.deepEqual(await unlockTicketChannel(null), { edited: 0, failed: 0 })
})
```

Create `bot/src/services/ticketRetire.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js'
import { RETIRE_AFTER_MS, retireTicketChannel, reviveTicketChannel, sweepRetiredTickets, startTicketRetireSweep } from './ticketRetire.js'

const bits = (...flags) => new PermissionsBitField(flags)
const NOW = new Date('2026-09-25T10:00:00Z')

function fakeDb({ retirable = [], updateFails = false } = {}) {
  const updates = []
  return {
    updates,
    task: {
      update: async (a) => {
        if (updateFails) throw new Error('db down')
        updates.push(a)
        return null
      },
      findRetirable: async ({ where, take }) => retirable.filter((t) => t.channelRetireAt <= where.before).slice(0, take ?? 100),
    },
  }
}

function fakeChannel(overwrites = [], { lockFails = false } = {}) {
  const edits = []
  return {
    id: 'ch1',
    edits,
    permissionOverwrites: {
      cache: new Map(overwrites.map((o) => [o.id, o])),
      edit: async (id, patch) => {
        if (lockFails) throw new Error('Missing Permissions')
        edits.push([id, patch])
      },
    },
  }
}

async function quiet(fn) {
  const real = console.warn
  console.warn = () => {}
  try { return await fn() } finally { console.warn = real }
}

test('RETIRE_AFTER_MS is fourteen days', () => {
  assert.equal(RETIRE_AFTER_MS, 14 * 24 * 60 * 60 * 1000)
})

test('retire locks the channel and stamps the row fourteen days from now', async () => {
  const db = fakeDb()
  const channel = fakeChannel([{ id: 'a', allow: bits(PermissionFlagsBits.SendMessages), deny: bits() }])
  const out = await retireTicketChannel({ channel, task: { id: 'T1' }, db, now: () => NOW })
  assert.deepEqual(channel.edits, [['a', { SendMessages: false }]])
  assert.equal(out.retireAt.getTime(), NOW.getTime() + RETIRE_AFTER_MS)
  assert.deepEqual(db.updates, [{ where: { id: 'T1' }, data: { channelRetireAt: out.retireAt } }])
})

test('retire still stamps when the lock fails, and when there is no channel at all', async () => {
  const db = fakeDb()
  await quiet(() => retireTicketChannel({ channel: fakeChannel([{ id: 'a', allow: bits(PermissionFlagsBits.SendMessages), deny: bits() }], { lockFails: true }), task: { id: 'T1' }, db, now: () => NOW }))
  await retireTicketChannel({ channel: null, task: { id: 'T2' }, db, now: () => NOW })
  assert.deepEqual(db.updates.map((u) => u.where.id), ['T1', 'T2'])
})

test('revive unlocks the channel and clears the stamp', async () => {
  const db = fakeDb()
  const channel = fakeChannel([{ id: 'a', allow: bits(PermissionFlagsBits.ViewChannel), deny: bits(PermissionFlagsBits.SendMessages) }])
  await reviveTicketChannel({ channel, task: { id: 'T1' }, db })
  assert.deepEqual(channel.edits, [['a', { SendMessages: true }]])
  assert.deepEqual(db.updates, [{ where: { id: 'T1' }, data: { channelRetireAt: null } }])
})

function fakeClient(channels, { fetchError = null } = {}) {
  const deleted = []
  const map = new Map(channels.map((c) => [c.id, { ...c, delete: async () => { if (c.deleteFails) throw new Error('Missing Permissions'); deleted.push(c.id) } }]))
  return {
    deleted,
    channels: {
      cache: { get: (id) => map.get(id) ?? null },
      fetch: async (id) => {
        if (fetchError) throw fetchError
        const c = map.get(id)
        if (!c) { const e = new Error('Unknown Channel'); e.code = 10003; throw e }
        return c
      },
    },
  }
}

test('sweep deletes only channels past their stamp and clears both columns', async () => {
  const due = { id: 'T1', discordChannelId: 'c1', channelRetireAt: new Date(NOW.getTime() - 1000) }
  const later = { id: 'T2', discordChannelId: 'c2', channelRetireAt: new Date(NOW.getTime() + 1000) }
  const db = fakeDb({ retirable: [due, later] })
  const client = fakeClient([{ id: 'c1' }, { id: 'c2' }])
  const out = await sweepRetiredTickets({ client, db, now: () => NOW })
  assert.deepEqual(client.deleted, ['c1'])
  assert.deepEqual(db.updates, [{ where: { id: 'T1' }, data: { discordChannelId: null, channelRetireAt: null } }])
  assert.deepEqual(out, { deleted: 1, failed: 0 })
})

test('sweep: a channel Discord already deleted counts as deleted and the row is cleared', async () => {
  const due = { id: 'T1', discordChannelId: 'gone', channelRetireAt: new Date(0) }
  const db = fakeDb({ retirable: [due] })
  const client = fakeClient([])
  const out = await sweepRetiredTickets({ client, db, now: () => NOW })
  assert.deepEqual(db.updates, [{ where: { id: 'T1' }, data: { discordChannelId: null, channelRetireAt: null } }])
  assert.deepEqual(out, { deleted: 1, failed: 0 })
})

test('sweep: a delete that throws keeps the stamp so the next tick retries, and the others still run', async () => {
  const rows = [
    { id: 'T1', discordChannelId: 'c1', channelRetireAt: new Date(0) },
    { id: 'T2', discordChannelId: 'c2', channelRetireAt: new Date(0) },
  ]
  const db = fakeDb({ retirable: rows })
  const client = fakeClient([{ id: 'c1', deleteFails: true }, { id: 'c2' }])
  const out = await quiet(() => sweepRetiredTickets({ client, db, now: () => NOW }))
  assert.deepEqual(client.deleted, ['c2'])
  assert.deepEqual(db.updates.map((u) => u.where.id), ['T2'])
  assert.deepEqual(out, { deleted: 1, failed: 1 })
})

test('sweep: a failed read is a warning and an empty result, never a throw', async () => {
  const db = { task: { findRetirable: async () => { throw new Error('db down') } } }
  const out = await quiet(() => sweepRetiredTickets({ client: fakeClient([]), db, now: () => NOW }))
  assert.deepEqual(out, { deleted: 0, failed: 0 })
})

test('startTicketRetireSweep runs once immediately and returns a clearable timer', async () => {
  let runs = 0
  const db = { task: { findRetirable: async () => { runs += 1; return [] } } }
  const timer = startTicketRetireSweep(fakeClient([]), { db, intervalMs: 60_000 })
  clearInterval(timer)
  await new Promise((r) => setImmediate(r))
  assert.equal(runs, 1)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/utils/channels.test.js src/services/ticketRetire.test.js`
Expected: FAIL — missing exports / missing module.

- [ ] **Step 3: Write the lock/unlock helpers**

Replace the body of `bot/src/utils/channels.js` with (keeping `lockChannelAndScheduleDeletion` until Task 6 removes it):

```js
import { PermissionFlagsBits } from 'discord.js'

const DELETION_DELAY_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Make a ticket channel read-only: every overwrite that allows sending loses
 * it. Whoever could see the channel still can. One edit per overwrite, each
 * on its own try/catch, so one refused edit does not leave the rest writable.
 * @returns {Promise<{edited: number, failed: number}>}
 */
export async function lockTicketChannel(channel) {
  const out = { edited: 0, failed: 0 }
  const cache = channel?.permissionOverwrites?.cache
  if (!cache?.entries) return out
  for (const [id, overwrite] of cache) {
    if (!overwrite?.allow?.has?.(PermissionFlagsBits.SendMessages)) continue
    try {
      await channel.permissionOverwrites.edit(id, { SendMessages: false })
      out.edited += 1
    } catch (e) {
      out.failed += 1
      console.warn(`[channels] lock ${channel.id} overwrite ${id}:`, e?.message || e)
    }
  }
  return out
}

/**
 * The reverse of `lockTicketChannel`, for a task reopened out of Done: every
 * overwrite that can view the channel and was denied sending may send again.
 * The @everyone overwrite denies ViewChannel, so it is never re-opened.
 * @returns {Promise<{edited: number, failed: number}>}
 */
export async function unlockTicketChannel(channel) {
  const out = { edited: 0, failed: 0 }
  const cache = channel?.permissionOverwrites?.cache
  if (!cache?.entries) return out
  for (const [id, overwrite] of cache) {
    if (!overwrite?.deny?.has?.(PermissionFlagsBits.SendMessages)) continue
    if (!overwrite?.allow?.has?.(PermissionFlagsBits.ViewChannel)) continue
    try {
      await channel.permissionOverwrites.edit(id, { SendMessages: true })
      out.edited += 1
    } catch (e) {
      out.failed += 1
      console.warn(`[channels] unlock ${channel.id} overwrite ${id}:`, e?.message || e)
    }
  }
  return out
}

/**
 * @deprecated Replaced by ticketRetire.js (lock now, delete after 14 days,
 * persisted). Removed once /close-feature and /resolve-bug no longer call it.
 */
export async function lockChannelAndScheduleDeletion(channel, delayMs = DELETION_DELAY_MS) {
  await lockTicketChannel(channel)
  setTimeout(() => {
    channel.delete().catch((e) => console.error('[channels] delete error:', e?.message))
  }, delayMs)
}
```

- [ ] **Step 4: Write the retire service**

Create `bot/src/services/ticketRetire.js`:

```js
// A finished ticket's channel: read-only the moment the task enters its
// project's Done bucket, deleted fourteen days later. The deadline lives on
// the task row (`channelRetireAt`), not in a timer, so a restart forgets
// nothing — the old five-minute `setTimeout` in /close-feature did.
import db from '../db/index.js'
import { lockTicketChannel, unlockTicketChannel } from '../utils/channels.js'

export const RETIRE_AFTER_MS = 14 * 24 * 60 * 60 * 1000
const TICK_MS = 60 * 60 * 1000

/**
 * Lock the channel (best-effort) and stamp the row. The stamp is written even
 * when the lock fails: a channel nobody could lock still must not outlive its
 * fortnight.
 * @returns {Promise<{retireAt: Date, locked: {edited: number, failed: number}}>}
 */
export async function retireTicketChannel({ channel, task, db: dbArg = db, now = () => new Date() }) {
  let locked = { edited: 0, failed: 0 }
  if (channel) {
    try {
      locked = await lockTicketChannel(channel)
    } catch (e) {
      locked = { edited: 0, failed: 1 }
      console.warn(`[ticketRetire] lock ${channel?.id}:`, e?.message || e)
    }
  }
  const retireAt = new Date(now().getTime() + RETIRE_AFTER_MS)
  await dbArg.task.update({ where: { id: task.id }, data: { channelRetireAt: retireAt } })
  return { retireAt, locked }
}

/** A task reopened out of Done: writable again, stamp cleared. */
export async function reviveTicketChannel({ channel, task, db: dbArg = db }) {
  let unlocked = { edited: 0, failed: 0 }
  if (channel) {
    try {
      unlocked = await unlockTicketChannel(channel)
    } catch (e) {
      unlocked = { edited: 0, failed: 1 }
      console.warn(`[ticketRetire] unlock ${channel?.id}:`, e?.message || e)
    }
  }
  await dbArg.task.update({ where: { id: task.id }, data: { channelRetireAt: null } })
  return { unlocked }
}

/** The channel by id from the cache, else fetched; null when Discord says it is gone (10003). */
async function channelOf(client, id) {
  const cached = client?.channels?.cache?.get?.(id)
  if (cached) return cached
  try {
    return (await client?.channels?.fetch?.(id)) ?? null
  } catch (e) {
    if (e?.code === 10003) return null
    throw e
  }
}

/**
 * Delete every channel whose stamp has passed and clear both columns on its
 * row. A row whose delete threw keeps its stamp and is retried next tick; a
 * channel Discord already deleted counts as deleted.
 * @returns {Promise<{deleted: number, failed: number}>}
 */
export async function sweepRetiredTickets({ client, db: dbArg = db, now = () => new Date(), take = 100 }) {
  const out = { deleted: 0, failed: 0 }
  let rows = []
  try {
    rows = (await dbArg.task.findRetirable({ where: { before: now() }, take })) ?? []
  } catch (e) {
    console.warn('[ticketRetire] read:', e?.message || e)
    return out
  }
  for (const task of rows) {
    try {
      const channel = await channelOf(client, task.discordChannelId)
      if (channel) await channel.delete('Finished ticket past its 14-day retention')
      await dbArg.task.update({ where: { id: task.id }, data: { discordChannelId: null, channelRetireAt: null } })
      out.deleted += 1
    } catch (e) {
      out.failed += 1
      console.warn(`[ticketRetire] task ${task.id} channel ${task.discordChannelId}:`, e?.message || e)
    }
  }
  return out
}

/** Hourly. Runs once at start so a bot restarted after a long outage catches up. */
export function startTicketRetireSweep(client, { db: dbArg = db, intervalMs = TICK_MS } = {}) {
  const tick = () => sweepRetiredTickets({ client, db: dbArg }).catch((e) => console.warn('[ticketRetire] sweep:', e?.message || e))
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  tick()
  return timer
}
```

- [ ] **Step 5: Run the tests and the full suite**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/utils/channels.test.js src/services/ticketRetire.test.js`
Expected: PASS (4 + 9).

Full suite with the gate. Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add bot/src/utils/channels.js bot/src/utils/channels.test.js bot/src/services/ticketRetire.js bot/src/services/ticketRetire.test.js
git commit -m "feat(buckets): lock/unlock helpers and the 14-day retire sweep

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: New ticket channels land in their status bucket

**Files:**
- Modify: `bot/src/services/taskTicketChannel.js` (`resolveParentCategory` ~line 70, `createTaskTicketChannel` ~line 124)
- Modify: `bot/src/commands/create-task.js` (the `createChannel(guild, {...})` call), `bot/src/services/clientRequest.js` (the `createChannel(guild, {...})` call ~line 165), `bot/src/services/meetingPipelineStages.js:394`, `bot/src/services/taskUpdateNotify.js:189`
- Test: `bot/src/services/taskTicketChannel.test.js`, `bot/src/services/taskUpdateNotify.test.js`

**Interfaces:**
- Consumes: `bucketFor`, `bucketIdsOf` from `../utils/statusBuckets.js` (Task 1).
- Produces: `createTaskTicketChannel(guild, { ..., status })` — `status` optional, default `'open'`. Return gains `placed: 'bucket'|'section'|'global'`. **`fellBack` keeps its meaning** (`null` whenever the channel is inside the project's own space — a bucket or the section category — because callers use `!fellBack` to add the project role's allow and to word their reply). The spec's `fellBack: 'noBucket'` is replaced by `placed: 'section'`; record this as a spec correction in Task 10.

- [ ] **Step 1: Write the failing tests**

Append to `bot/src/services/taskTicketChannel.test.js` (reuse its `fakeGuildWithChannels`; it records creates in `guild._created`):

```js
// ---- status buckets ---------------------------------------------------------
const bucketCat = (id, name) => ({ id, name, parentId: null, type: ChannelType.GuildCategory })
const bucketed = () => ({
  id: 'p1', name: 'Framework', discordCategoryId: 'projcat', discordRoleId: 'r1',
  discordChannels: { bucketOpen: 'b-open', bucketInProgress: 'b-prog', bucketDone: 'b-done' },
})

test('a project task is parented to the bucket for its status and carries the project role', async () => {
  const guild = fakeGuildWithChannels([bucketCat('projcat', '📂 FRAMEWORK'), bucketCat('b-open', '📂 FRAMEWORK · OPEN'), bucketCat('b-done', '📂 FRAMEWORK · DONE')])
  guild.roles = { cache: new Map([['r1', { id: 'r1' }]]) }
  const out = await createTaskTicketChannel(guild, { taskId: 'abcdef1234567890', title: 'Add rules', memberIds: ['11'], project: bucketed(), type: 'feature', status: 'done' })
  assert.equal(guild._created[0].parent, 'b-done')
  assert.equal(out.placed, 'bucket')
  assert.equal(out.fellBack, null)
  assert.ok(guild._created[0].permissionOverwrites.some((o) => o.id === 'r1' && o.type === OverwriteType.Role))
})

test('no status means open; pending is open too', async () => {
  const guild = fakeGuildWithChannels([bucketCat('projcat', '📂 FRAMEWORK'), bucketCat('b-open', '📂 FRAMEWORK · OPEN')])
  await createTaskTicketChannel(guild, { taskId: 'a1', title: 'One', memberIds: [], project: bucketed(), type: 'feature' })
  await createTaskTicketChannel(guild, { taskId: 'a2', title: 'Two', memberIds: [], project: bucketed(), type: 'bug', status: 'pending' })
  assert.deepEqual(guild._created.map((c) => c.parent), ['b-open', 'b-open'])
})

test('a bucket that is missing falls back to the section category, still inside the project', async () => {
  const guild = fakeGuildWithChannels([bucketCat('projcat', '📂 FRAMEWORK')])
  const out = await createTaskTicketChannel(guild, { taskId: 'a1', title: 'One', memberIds: [], project: bucketed(), type: 'feature', status: 'in_progress' })
  assert.equal(guild._created[0].parent, 'projcat')
  assert.equal(out.placed, 'section')
  assert.equal(out.fellBack, null)
})

test('a stored bucket id that resolves to a text channel is treated as missing', async () => {
  const guild = fakeGuildWithChannels([bucketCat('projcat', '📂 FRAMEWORK'), { id: 'b-open', name: 'not-a-category', parentId: null, type: ChannelType.GuildText }])
  const out = await createTaskTicketChannel(guild, { taskId: 'a1', title: 'One', memberIds: [], project: bucketed(), type: 'feature' })
  assert.equal(guild._created[0].parent, 'projcat')
  assert.equal(out.placed, 'section')
})

test('a full bucket falls back to the section category and warns', async () => {
  const packed = Array.from({ length: 49 }, (_, i) => ({ id: `c${i}`, name: `chan-${i}`, parentId: 'b-open' }))
  const guild = fakeGuildWithChannels([bucketCat('projcat', '📂 FRAMEWORK'), bucketCat('b-open', '📂 FRAMEWORK · OPEN'), ...packed])
  const warnings = []
  const real = console.warn
  console.warn = (...a) => warnings.push(a.join(' '))
  let out
  try {
    out = await createTaskTicketChannel(guild, { taskId: 'a1', title: 'One', memberIds: [], project: bucketed(), type: 'feature' })
  } finally { console.warn = real }
  assert.equal(guild._created[0].parent, 'projcat')
  assert.equal(out.placed, 'section')
  assert.ok(warnings.some((w) => w.includes('open bucket') && w.includes('cap')))
})

test('with no bucket and no section category the global category is used, as before', async () => {
  const guild = fakeGuildWithChannels([])
  const out = await createTaskTicketChannel(guild, { taskId: 'a1', title: 'One', memberIds: [], project: bucketed(), type: 'feature' })
  assert.equal(out.placed, 'global')
  assert.equal(out.fellBack, 'missing')
})
```

In `bot/src/services/taskUpdateNotify.test.js`, copy the fixture of the test named `a task carrying a projectId gets a channel inside that project, looked up through the db seam` (the fake `client`, `guild`, `dbFake`, `task`) into a new test and change three things: the guild's `catMap` also holds `{ id: 'b-prog', name: '📂 FRAMEWORK · IN PROGRESS', parentId: null, type: ChannelType.GuildCategory }`, `dbFake.project.findFirst` returns `{ id: 'p1', name: 'Framework', discordCategoryId: 'projcat', discordChannels: { bucketInProgress: 'b-prog' } }`, and the call passes `updates: { assigneeIds: ['11'], status: 'in_progress' }`. No seam is added — `notifyTaskUpdate` calls the real `createTaskTicketChannel` against the fake guild, as that test already does. Then:

```js
  assert.equal(out.created, true)
  // The fresh channel lands in the bucket for the NEW status, not the section.
  assert.equal(created[0].parent, 'b-prog')
```

Name it `the channel opened for a newly assigned task lands in the bucket for its new status`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/services/taskTicketChannel.test.js src/services/taskUpdateNotify.test.js`
Expected: the new bucket tests FAIL (`parent` is `'projcat'`/`'cat1'`, `placed` undefined).

- [ ] **Step 3: Resolve the parent by bucket**

In `bot/src/services/taskTicketChannel.js` add the import (leaf → leaf, allowed):

```js
import { bucketFor, bucketIdsOf } from '../utils/statusBuckets.js'
```

Add a helper and replace `resolveParentCategory`:

```js
/** The channel with this id, only when it is a category. A text channel cannot be a parent. */
function categoryById(guild, id) {
  const c = id ? guild?.channels?.cache?.get?.(id) ?? null : null
  return c?.type === ChannelType.GuildCategory ? c : null
}

/**
 * Where a new task channel goes, in order:
 *   1. the project's bucket for the task's status (`bucketFor`), when its
 *      stored id still resolves to a category with room;
 *   2. the project's section category, under the rules it always had;
 *   3. the global Features/Bugs category.
 * `fellBack` is non-null only for 3 — the channel left the project's space,
 * so the project role's allow is not added and the reply says so. `placed`
 * says which of the three it was.
 *
 * @returns {Promise<{category: object, fellBack: 'cap'|'missing'|null, placed: 'bucket'|'section'|'global'}>}
 */
async function resolveParentCategory(guild, project, categoryLabel, status) {
  if (!project) return { category: await globalCategory(guild, categoryLabel), fellBack: null, placed: 'global' }

  const bucketKey = bucketFor(status)
  const bucket = categoryById(guild, bucketIdsOf(project)[bucketKey])
  if (bucket) {
    if (countChannelsInCategory(guild, bucket.id) < CATEGORY_SOFT_CAP) {
      return { category: bucket, fellBack: null, placed: 'bucket' }
    }
    console.warn(
      `[taskTicket] project "${project?.name}"'s ${bucketKey} bucket is at Discord's cap (${CATEGORY_SOFT_CAP} channels); the task channel was created in the section category instead.`
    )
  }

  const projectCategory = categoryById(guild, project.discordCategoryId)
  if (!projectCategory) {
    console.warn(
      `[taskTicket] project "${project?.name}" has no usable category; the task channel was created in the global ${categoryLabel} category instead.`
    )
    return { category: await globalCategory(guild, categoryLabel), fellBack: 'missing', placed: 'global' }
  }
  if (countChannelsInCategory(guild, projectCategory.id) >= CATEGORY_SOFT_CAP) {
    console.warn(
      `[taskTicket] project "${project?.name}"'s category is at Discord's cap (${CATEGORY_SOFT_CAP} channels); the task channel was created in the global ${categoryLabel} category instead.`
    )
    return { category: await globalCategory(guild, categoryLabel), fellBack: 'cap', placed: 'global' }
  }
  return { category: projectCategory, fellBack: null, placed: 'section' }
}
```

In `createTaskTicketChannel`: destructure `status = 'open'` from `opts`, call `resolveParentCategory(guild, project, categoryLabel, status)`, keep `fellBack` for the role-allow condition, and return `{ channel, fellBack, placed }`. Update the JSDoc `@param` list with `opts.status` and the `@returns` shape.

- [ ] **Step 4: Callers pass the status**

- `bot/src/commands/create-task.js`: in the `createChannel(guild, { … })` call add `status: <the status the task row was just created with>` (the variable used for the insert's `status`; if the row is inserted with a default, pass `'open'` for a feature/task and `'pending'` for a bug, matching the insert).
- `bot/src/services/clientRequest.js`: in the `createChannel(guild, { … })` call add `status: task.status` (the created row).
- `bot/src/services/meetingPipelineStages.js:394`: add `status: 'open'` (the row is inserted open; the Status field two lines below already says so).
- `bot/src/services/taskUpdateNotify.js:189`: add `status: updates?.status ?? task.status`.

- [ ] **Step 5: Run the tests and the full suite**

Run the two files, then the full suite with the gate. Expected: `ℹ fail 0`.

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/taskTicketChannel.js bot/src/services/taskTicketChannel.test.js bot/src/commands/create-task.js bot/src/services/clientRequest.js bot/src/services/meetingPipelineStages.js bot/src/services/taskUpdateNotify.js bot/src/services/taskUpdateNotify.test.js
git commit -m "feat(buckets): new ticket channels are parented to their status bucket

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Live moves on every status change

**Files:**
- Create: `bot/src/services/ticketBucketMove.js`
- Modify: `bot/src/services/taskStatusChange.js`
- Test: `bot/src/services/ticketBucketMove.test.js`, `bot/src/services/taskStatusChange.test.js`

**Interfaces:**
- Consumes: `bucketFor`, `bucketIdsOf`, `isDoneBucket` (Task 1); `retireTicketChannel`, `reviveTicketChannel` (Task 3); `CATEGORY_SOFT_CAP`; `db.project.findFirst({ where: { id } })`.
- Produces: `moveTicketToBucket({ guild, task, before, updates, db, now, retire, revive }) → { moved: boolean, bucket: string|null, reason: string|null }` with reasons `'no-channel' | 'no-status' | 'same-bucket' | 'no-project' | 'no-bucket' | 'full' | 'already-there' | 'error' | null`. `applyTaskUpdate` gains the `move = moveTicketToBucket` seam and returns `{ warning, notified, placement }`.

Rules: the **Done transition** (retire on entering Done, revive on leaving) runs for any task with a channel whose status crosses the boundary, project or not — `/close-feature` on a project-less ticket must still retire it. The **move** needs a project with a usable bucket.

- [ ] **Step 1: Write the failing tests**

Create `bot/src/services/ticketBucketMove.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType } from 'discord.js'
import { moveTicketToBucket } from './ticketBucketMove.js'

const cat = (id) => ({ id, type: ChannelType.GuildCategory, parentId: null })
function ticket(id, parentId, { fail = null } = {}) {
  const c = { id, type: ChannelType.GuildText, parentId, edits: [] }
  c.edit = async (o) => { c.edits.push(o); if (fail) throw new Error(fail); if (o.parent !== undefined) c.parentId = o.parent; return c }
  return c
}
function guildWith(channels) {
  const map = new Map(channels.map((c) => [c.id, c]))
  return { id: 'G1', channels: { cache: { get: (id) => map.get(id) ?? null, values: () => map.values() } } }
}
const project = { id: 'p1', name: 'Framework', discordChannels: { bucketOpen: 'b-open', bucketInProgress: 'b-prog', bucketDone: 'b-done' } }
function deps(over = {}) {
  const log = []
  return {
    log,
    db: { project: { findFirst: async ({ where }) => { log.push(['project', where.id]); return over.project ?? project } } },
    retire: async (a) => { log.push(['retire', a.task.id, a.channel?.id ?? null]) },
    revive: async (a) => { log.push(['revive', a.task.id, a.channel?.id ?? null]) },
    now: () => new Date('2026-09-25T00:00:00Z'),
  }
}
async function quiet(fn) { const r = console.warn; console.warn = () => {}; try { return await fn() } finally { console.warn = r } }

test('no channel, no status, or the same bucket: nothing is read or edited', async () => {
  const d = deps()
  const g = guildWith([cat('b-open'), cat('b-prog'), ticket('c1', 'b-open')])
  assert.deepEqual(await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', status: 'open' }, updates: { status: 'done' }, ...d }), { moved: false, bucket: null, reason: 'no-channel' })
  assert.deepEqual(await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { title: 'x' }, ...d }), { moved: false, bucket: null, reason: 'no-status' })
  assert.deepEqual(await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'pending' }, ...d }), { moved: false, bucket: 'open', reason: 'same-bucket' })
  assert.deepEqual(d.log, [])
})

test('open → in progress moves the channel with a parent-only edit', async () => {
  const d = deps()
  const ch = ticket('c1', 'b-open')
  const g = guildWith([cat('b-open'), cat('b-prog'), cat('b-done'), ch])
  const out = await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'in_progress' }, ...d })
  assert.deepEqual(out, { moved: true, bucket: 'inProgress', reason: null })
  assert.deepEqual(ch.edits, [{ parent: 'b-prog' }])
  assert.deepEqual(d.log, [['project', 'p1']])
})

test('entering Done moves and retires; leaving Done moves and revives', async () => {
  const d = deps()
  const ch = ticket('c1', 'b-prog')
  const g = guildWith([cat('b-open'), cat('b-prog'), cat('b-done'), ch])
  await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'in_progress' }, updates: { status: 'done' }, ...d })
  assert.equal(ch.parentId, 'b-done')
  await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'done' }, updates: { status: 'open' }, ...d })
  assert.equal(ch.parentId, 'b-open')
  assert.deepEqual(d.log.filter((l) => l[0] !== 'project'), [['retire', 'T', 'c1'], ['revive', 'T', 'c1']])
})

test('a project-less ticket is not moved but IS retired when it finishes', async () => {
  const d = deps()
  const ch = ticket('c1', 'FEATURES')
  const g = guildWith([ch])
  const out = await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: null, discordChannelId: 'c1', status: 'open' }, updates: { status: 'closed' }, ...d })
  assert.deepEqual(out, { moved: false, bucket: 'done', reason: 'no-project' })
  assert.deepEqual(ch.edits, [])
  assert.deepEqual(d.log, [['retire', 'T', 'c1']])
})

test('a missing, wrong-typed or full bucket leaves the channel where it is, and Done still retires', async () => {
  const d = deps({ project: { ...project, discordChannels: { bucketOpen: 'b-open' } } })
  const ch = ticket('c1', 'b-open')
  const g = guildWith([cat('b-open'), ch])
  const out = await quiet(() => moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'done' }, ...d }))
  assert.deepEqual(out, { moved: false, bucket: 'done', reason: 'no-bucket' })
  assert.deepEqual(ch.edits, [])
  assert.deepEqual(d.log.at(-1), ['retire', 'T', 'c1'])

  const d2 = deps()
  const packed = Array.from({ length: 49 }, (_, i) => ({ id: `x${i}`, parentId: 'b-prog', type: ChannelType.GuildText }))
  const ch2 = ticket('c2', 'b-open')
  const g2 = guildWith([cat('b-open'), cat('b-prog'), ...packed, ch2])
  const out2 = await quiet(() => moveTicketToBucket({ guild: g2, task: { id: 'T', projectId: 'p1', discordChannelId: 'c2', status: 'open' }, updates: { status: 'in_progress' }, ...d2 }))
  assert.equal(out2.reason, 'full')
  assert.deepEqual(ch2.edits, [])
})

test('a channel already in its bucket is not edited', async () => {
  const d = deps()
  const ch = ticket('c1', 'b-prog')
  const g = guildWith([cat('b-open'), cat('b-prog'), ch])
  const out = await moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'in_progress' }, ...d })
  assert.deepEqual(out, { moved: false, bucket: 'inProgress', reason: 'already-there' })
  assert.deepEqual(ch.edits, [])
})

test('an edit that throws, or a project read that throws, is reason error and never a throw', async () => {
  const d = deps()
  const ch = ticket('c1', 'b-open', { fail: 'Missing Permissions' })
  const g = guildWith([cat('b-open'), cat('b-prog'), ch])
  const out = await quiet(() => moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'in_progress' }, ...d }))
  assert.deepEqual(out, { moved: false, bucket: 'inProgress', reason: 'error' })

  const bad = { ...d, db: { project: { findFirst: async () => { throw new Error('db down') } } } }
  const out2 = await quiet(() => moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'in_progress' }, ...bad }))
  assert.equal(out2.reason, 'error')
})

test('a retire that throws is a warning; the move still counts', async () => {
  const d = deps()
  d.retire = async () => { throw new Error('db down') }
  const ch = ticket('c1', 'b-open')
  const g = guildWith([cat('b-open'), cat('b-done'), ch])
  const out = await quiet(() => moveTicketToBucket({ guild: g, task: { id: 'T', projectId: 'p1', discordChannelId: 'c1', status: 'open' }, updates: { status: 'done' }, ...d }))
  assert.equal(out.moved, true)
})
```

Append to `bot/src/services/taskStatusChange.test.js`:

```js
test('a status change calls the bucket mover after the write and before notify, with the guild', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'T', status: 'open', discordChannelId: 'c1', projectId: 'p1' }
  const db = fakeDb()
  const order = []
  const move = async (a) => { order.push(['move', a.task.id, a.before.status, a.updates.status, a.guild?.id, a.db === db]); return { moved: true, bucket: 'inProgress', reason: null } }
  const notify = async () => { order.push(['notify']); return { channelId: 'c1', created: false, dmed: [] } }
  const out = await applyTaskUpdate({ db, client, task, updates: { status: 'in_progress' }, notify, move })
  assert.deepEqual(order, [['move', 'A', 'open', 'in_progress', 'guild1', true], ['notify']])
  assert.deepEqual(out.placement, { moved: true, bucket: 'inProgress', reason: null })
})

test('the mover is not called without a status change, and a mover that throws does not fail the update', async () => {
  const task = { id: 'A', guildConfigId: 'g1', title: 'T', status: 'open', discordChannelId: 'c1' }
  let calls = 0
  const move = async () => { calls += 1; throw new Error('boom') }
  const notify = async () => ({ channelId: 'c1', created: false, dmed: [] })
  await applyTaskUpdate({ db: fakeDb(), client, task, updates: { title: 'New' }, notify, move })
  assert.equal(calls, 0)
  const real = console.error
  console.error = () => {}
  try {
    const out = await applyTaskUpdate({ db: fakeDb(), client, task, updates: { status: 'done' }, notify, move })
    assert.equal(calls, 1)
    assert.deepEqual(out.placement, { moved: false, bucket: null, reason: 'error' })
  } finally { console.error = real }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/services/ticketBucketMove.test.js src/services/taskStatusChange.test.js`
Expected: FAIL — module missing; `placement` undefined.

- [ ] **Step 3: Write the mover**

Create `bot/src/services/ticketBucketMove.js`:

```js
// The channel follows the status. One parent-only edit into the bucket for the
// new status, then the Done transition: read-only and stamped on the way in,
// writable and unstamped on the way out. Called from applyTaskUpdate, so the
// slash command, the task hub and the site's board all behave the same.
import { ChannelType } from 'discord.js'
import db from '../db/index.js'
import { CATEGORY_SOFT_CAP } from '../constants.js'
import { bucketFor, bucketIdsOf, isDoneBucket } from '../utils/statusBuckets.js'
import { retireTicketChannel, reviveTicketChannel } from './ticketRetire.js'

const valuesOf = (cache) => (cache?.values ? [...cache.values()] : [])
const countIn = (guild, id) => valuesOf(guild?.channels?.cache).filter((c) => c?.parentId === id).length

/**
 * @returns {Promise<{moved: boolean, bucket: string|null, reason: string|null}>}
 *   `reason` is why the channel was NOT moved (null when it was). The Done
 *   transition runs whenever the status crosses that boundary and the task has
 *   a channel — whether or not a move was possible — so a project-less ticket
 *   finished with /close-feature is still locked and retired.
 */
export async function moveTicketToBucket({
  guild, task, before = task, updates = {}, db: dbArg = db, now = () => new Date(),
  retire = retireTicketChannel, revive = reviveTicketChannel,
}) {
  const channelId = task?.discordChannelId
  if (!channelId) return { moved: false, bucket: null, reason: 'no-channel' }
  if (updates?.status === undefined || updates.status === null) return { moved: false, bucket: null, reason: 'no-status' }
  const from = bucketFor(before?.status)
  const to = bucketFor(updates.status)
  if (from === to) return { moved: false, bucket: to, reason: 'same-bucket' }

  const channel = guild?.channels?.cache?.get?.(channelId) ?? null
  if (!channel) return { moved: false, bucket: to, reason: 'no-channel' }

  let moved = false
  let reason = null
  if (!task?.projectId) {
    reason = 'no-project'
  } else {
    let project = null
    try {
      project = await dbArg.project.findFirst({ where: { id: task.projectId } })
    } catch (e) {
      console.warn('[ticketBucketMove] project read:', e?.message || e)
      reason = 'error'
    }
    if (!reason) {
      const targetId = bucketIdsOf(project)[to]
      const target = targetId ? guild.channels.cache.get(targetId) ?? null : null
      if (!target || target.type !== ChannelType.GuildCategory) {
        reason = 'no-bucket'
        console.warn(`[ticketBucketMove] project "${project?.name}" has no ${to} bucket; run /project-setup to create it.`)
      } else if (channel.parentId === target.id) {
        reason = 'already-there'
      } else if (countIn(guild, target.id) >= CATEGORY_SOFT_CAP) {
        reason = 'full'
        console.warn(`[ticketBucketMove] project "${project?.name}"'s ${to} bucket is at Discord's cap (${CATEGORY_SOFT_CAP}); ${channel.name ?? channelId} stays where it is.`)
      } else {
        try {
          await channel.edit({ parent: target.id })
          moved = true
        } catch (e) {
          reason = 'error'
          console.warn(`[ticketBucketMove] move ${channelId}:`, e?.message || e)
        }
      }
    }
  }

  try {
    if (isDoneBucket(to)) await retire({ channel, task, db: dbArg, now })
    else if (isDoneBucket(from)) await revive({ channel, task, db: dbArg })
  } catch (e) {
    console.warn(`[ticketBucketMove] ${isDoneBucket(to) ? 'retire' : 'revive'} ${task.id}:`, e?.message || e)
  }
  return { moved, bucket: to, reason }
}
```

- [ ] **Step 4: Hook it into `applyTaskUpdate`**

In `bot/src/services/taskStatusChange.js`: import `moveTicketToBucket`; add `move = moveTaskToBucketDefault` — i.e. `move = moveTicketToBucket` — to the destructured parameters. Replace the guild lookup that sits inside the notify `try` with one done **before** the mover, so both use it:

```js
  // The guild, once, for the mover and the notifier alike.
  let g = guild
  if (!g) {
    try {
      const cfg = await dbArg.guildConfig.findById(task.guildConfigId)
      g = cfg ? client?.guilds?.cache?.get(cfg.guildId) ?? null : null
    } catch (e) {
      console.error('[taskStatusChange] guild lookup:', e?.message ?? e)
    }
  }

  // The channel follows the status — into its bucket, locked on entering Done,
  // unlocked on leaving. After the write, before the post. Best-effort.
  let placement = { moved: false, bucket: null, reason: null }
  if (updates.status !== undefined) {
    try {
      placement = await move({ guild: g, task, before: task, updates, db: dbArg })
    } catch (e) {
      console.error('[taskStatusChange] bucket move:', e?.message ?? e)
      placement = { moved: false, bucket: null, reason: 'error' }
    }
  }
```

The notify block then uses `g` directly (delete its own lookup). Return `{ warning, notified, placement }`.

- [ ] **Step 5: Run the tests and the full suite**

Run the two files, then the full suite with the gate. Expected: `ℹ fail 0`. (Existing `applyTaskUpdate` tests use tasks without `discordChannelId`, so the mover returns `'no-channel'` before touching the fake `db`.)

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/ticketBucketMove.js bot/src/services/ticketBucketMove.test.js bot/src/services/taskStatusChange.js bot/src/services/taskStatusChange.test.js
git commit -m "feat(buckets): a status change moves the ticket channel and runs the Done transition

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `/close-feature` and `/resolve-bug` retire instead of deleting

**Files:**
- Modify: `bot/src/commands/close-feature.js`, `bot/src/commands/resolve-bug.js`, `bot/src/utils/channels.js` (remove `lockChannelAndScheduleDeletion`)
- Test: `bot/src/commands/close-feature.test.js`, `bot/src/commands/resolve-bug.test.js` (new)

**Interfaces:**
- Consumes: `moveTicketToBucket` (Task 5).
- Produces: `execute(interaction, { db, move })` on both commands. `db.feature.findFirst/update` and `db.bugTicket.findFirst/update` are the task table under the old names (they return task rows, with `projectId`, `discordChannelId`, `status`).

- [ ] **Step 1: Write the failing tests**

Create `bot/src/commands/close-feature.test.js`:

```js
// Both seams (db, move) are faked: the root .env points at production.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute } from './close-feature.js'

function harness({ feature = { id: 'T1', title: 'Git Sync', status: 'open', projectId: 'p1', discordChannelId: 'c1', guildConfigId: 'g1' } } = {}) {
  const log = []
  const channel = { id: 'c1', send: async (p) => { log.push(['send', p.content]) }, delete: async () => { log.push(['delete']) } }
  const interaction = {
    guild: { id: 'G1' }, channel, replies: [],
    options: { getAttachment: () => null },
    editReply: async (p) => { interaction.replies.push(p) },
  }
  const db = {
    feature: {
      findFirst: async ({ where }) => (where.discordChannelId === 'c1' ? feature : null),
      update: async (a) => { log.push(['update', a.data.status]) },
    },
    ticketDoc: { findFirst: async () => null, update: async () => {}, create: async () => {} },
  }
  const move = async (a) => { log.push(['move', a.task.id, a.before.status, a.updates.status, a.db === db, a.guild?.id]); return { moved: true, bucket: 'done', reason: null } }
  return { interaction, channel, db, move, log }
}

test('closing writes the status, tells the channel it is read-only for 14 days, and hands the row to the mover — no deletion', async () => {
  const h = harness()
  await execute(h.interaction, { db: h.db, move: h.move })
  assert.deepEqual(h.log, [
    ['update', 'closed'],
    ['send', 'This feature ticket has been closed. This channel is now read-only and will be removed in 14 days.'],
    ['move', 'T1', 'open', 'closed', true, 'G1'],
  ])
  assert.equal(h.interaction.replies[0].embeds[0].data.title, 'Feature ticket closed')
})

test('a mover that throws does not turn a successful close into an error', async () => {
  const h = harness()
  const real = console.warn
  console.warn = () => {}
  try {
    await execute(h.interaction, { db: h.db, move: async () => { throw new Error('boom') } })
  } finally { console.warn = real }
  assert.equal(h.log[0][0], 'update')
  assert.equal(h.interaction.replies.length, 1)
})

test('outside a feature channel, or when already closed, nothing is written or moved', async () => {
  const h = harness({ feature: null })
  await execute(h.interaction, { db: h.db, move: h.move })
  assert.match(h.interaction.replies[0].content, /feature ticket/)
  const h2 = harness({ feature: { id: 'T1', status: 'closed', discordChannelId: 'c1' } })
  await execute(h2.interaction, { db: h2.db, move: h2.move })
  assert.match(h2.interaction.replies[0].content, /already closed/)
  assert.deepEqual([...h.log, ...h2.log], [])
})
```

Create `bot/src/commands/resolve-bug.test.js` with the same shape: `db.bugTicket` instead of `db.feature`, `ticketDoc.findFirst` returning `{ id: 'd1' }`, `options.getAttachment` returning `{ url: 'https://x/fix.md', name: 'fix.md', contentType: 'text/markdown' }`, and `globalThis.fetch` stubbed for the duration of the test (`const realFetch = globalThis.fetch; globalThis.fetch = async () => ({ text: async () => '# fix' }); try { … } finally { globalThis.fetch = realFetch }`). Expected log: `['update', 'resolved']`, the send `'This bug ticket has been resolved. This channel is now read-only and will be removed in 14 days.'`, then `['move', 'T1', 'pending', 'resolved', true, 'G1']`. Include the "no attachment → asks for one, nothing written" case.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/commands/close-feature.test.js src/commands/resolve-bug.test.js`
Expected: FAIL — `execute` ignores the seams (it reads the default `db`, which under the poisoned URL throws or hangs) and the message still says 5 minutes. **Do not run these tests before Step 3 is in place if the default `db` could resolve — with `DATABASE_URL=poisoned://…` it cannot, but the rule stands: the fix and the test land together.**

- [ ] **Step 3: Add the seams and the move**

`bot/src/commands/close-feature.js`:

```js
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import db from '../db/index.js'
import { moveTicketToBucket } from '../services/ticketBucketMove.js'

export const data = /* unchanged */

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction already deferred
 * @param {{db?: object, move?: typeof moveTicketToBucket}} [deps]
 */
export async function execute(interaction, { db: dbArg = db, move = moveTicketToBucket } = {}) {
  // … every `db.` becomes `dbArg.` …

  await dbArg.feature.update({ where: { id: feature.id }, data: { status: 'closed', implementationStatus: 'done' } })

  // embed unchanged

  await interaction.editReply({ embeds: [embed] }).catch(() => {})
  await channel.send({ content: 'This feature ticket has been closed. This channel is now read-only and will be removed in 14 days.', embeds: [embed] }).catch(() => {})
  // Into the project's Done bucket, locked, stamped for deletion in 14 days.
  // The same mover every other status writer uses.
  try {
    await move({ guild, task: feature, before: feature, updates: { status: 'closed' }, db: dbArg })
  } catch (e) {
    console.warn('[close-feature] bucket move:', e?.message || e)
  }
}
```

Drop the unused `EPHEMERAL` import if nothing else uses it. Same pattern in `resolve-bug.js` with `dbArg.bugTicket`, status `'resolved'`, message `'This bug ticket has been resolved. This channel is now read-only and will be removed in 14 days.'`.

Remove `lockChannelAndScheduleDeletion` and `DELETION_DELAY_MS` from `bot/src/utils/channels.js`. Confirm with `grep -rn lockChannelAndScheduleDeletion bot/src` → no matches.

- [ ] **Step 4: Run the tests and the full suite**

Run the two files, then the full suite with the gate. Expected: `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add bot/src/commands/close-feature.js bot/src/commands/close-feature.test.js bot/src/commands/resolve-bug.js bot/src/commands/resolve-bug.test.js bot/src/utils/channels.js
git commit -m "feat(buckets): /close-feature and /resolve-bug retire the channel for 14 days instead of deleting it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `/project-setup` observes and plans the buckets

**Files:**
- Modify: `bot/src/services/projectSection.js` (`observeProjectSection` ~line 820, `planTasks` ~line 383, `planProjectSection` ~line 500)
- Test: `bot/src/services/projectSection.test.js`

**Interfaces:**
- Consumes: `BUCKETS`, `bucketFor`, `bucketNameFor`, `bucketIdsOf`, `isDoneBucket` (Task 1).
- Produces:
  - `observeProjectSection(...)` return gains `buckets: { open, inProgress, done }` each `{ id, name, channelCount } | null`; each entry of `tasks` gains `status` and `retireAt`.
  - `planProjectSection(...)` return gains `buckets: [{ key, storeKey, action: 'create'|'rename'|'reuse', id?, name }]` (table order). Each `tasks` entry gains `bucket: key` and, when it is a Done ticket without a stamp, `retire: true`. `parentOk` now means "already inside its bucket".

- [ ] **Step 1: Write the failing tests**

Append to `bot/src/services/projectSection.test.js` (reuse `fakeChannel`, `fakeGuild`, `ticketChannel`, `project` from the file; `project` is `{ id: 'p1', name: 'Framework', … }` — check the top of the file and use its actual fixture name):

```js
// ---- status buckets --------------------------------------------------------
const bucketCat = (id, name) => fakeChannel(id, name, { type: ChannelType.GuildCategory })
const withBuckets = (p, ids = {}) => ({ ...p, discordCategoryId: 'c1', discordChannels: { ...(p.discordChannels ?? {}), bucketOpen: 'b-open', bucketInProgress: 'b-prog', bucketDone: 'b-done', ...ids } })

test('observe finds each bucket by stored id, else by exact name, never one another project claims', () => {
  const guild = fakeGuild({
    channels: [
      fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory }),
      bucketCat('b-open', 'renamed by hand'),
      bucketCat('by-name', '📂 FRAMEWORK · IN PROGRESS'),
      bucketCat('theirs', '📂 FRAMEWORK · DONE'),
      fakeChannel('t1', 'feature-x', { parentId: 'b-open' }),
    ],
  })
  const p = withBuckets(project, { bucketInProgress: null, bucketDone: null })
  const observed = observeProjectSection(guild, p, [], { claimedIds: new Set(['theirs']) })
  assert.deepEqual(observed.buckets.open, { id: 'b-open', name: 'renamed by hand', channelCount: 1 })
  assert.deepEqual(observed.buckets.inProgress, { id: 'by-name', name: '📂 FRAMEWORK · IN PROGRESS', channelCount: 0 })
  assert.equal(observed.buckets.done, null)
})

test('observe: a stored bucket id that is a text channel is treated as missing', () => {
  const guild = fakeGuild({ channels: [fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory }), fakeChannel('b-open', 'oops')] })
  const observed = observeProjectSection(guild, withBuckets(project), [])
  assert.equal(observed.buckets.open, null)
})

test('observe carries each ticket\'s status and stamp', () => {
  const guild = fakeGuild({ channels: [ticketChannel('tc1', 'feature-x', 'c1')] })
  const stamp = new Date('2026-10-01T00:00:00Z')
  const observed = observeProjectSection(guild, withBuckets(project), [{ id: 't1', title: 'X', type: 'feature', status: 'done', discordChannelId: 'tc1', channelRetireAt: stamp }])
  assert.equal(observed.tasks[0].status, 'done')
  assert.equal(observed.tasks[0].retireAt, stamp)
})

test('plan: the three buckets are created, reused or renamed exactly like the category', () => {
  const plan = planProjectSection(project, {
    categoryId: 'c1', categoryName: '📂 FRAMEWORK',
    buckets: { open: null, inProgress: { id: 'b-prog', name: '📂 FRAMEWORK · IN PROGRESS', channelCount: 0 }, done: { id: 'b-done', name: 'old', channelCount: 3 } },
  })
  assert.deepEqual(plan.buckets, [
    { key: 'open', storeKey: 'bucketOpen', action: 'create', name: '📂 FRAMEWORK · OPEN' },
    { key: 'inProgress', storeKey: 'bucketInProgress', action: 'reuse', id: 'b-prog', name: '📂 FRAMEWORK · IN PROGRESS' },
    { key: 'done', storeKey: 'bucketDone', action: 'rename', id: 'b-done', name: '📂 FRAMEWORK · DONE' },
  ])
})

test('plan: tickets are filed by status — into their bucket, out of the section category', () => {
  const observed = {
    categoryId: 'c1', categoryName: '📂 FRAMEWORK', categoryChannelCount: 15,
    buckets: { open: { id: 'b-open', name: '📂 FRAMEWORK · OPEN', channelCount: 0 }, inProgress: null, done: { id: 'b-done', name: '📂 FRAMEWORK · DONE', channelCount: 0 } },
    tasks: [
      { id: 't1', title: 'Git Sync', type: 'feature', status: 'open', channelId: 'tc1', channelName: 'feature-git-sync', parentId: 'c1' },
      { id: 't2', title: 'Login', type: 'bug', status: 'in_progress', channelId: 'tc2', channelName: 'bug-login', parentId: 'c1' },
      { id: 't3', title: 'Old', type: 'feature', status: 'done', channelId: 'tc3', channelName: 'feature-old', parentId: 'b-done', retireAt: null },
      { id: 't4', title: 'Older', type: 'feature', status: 'closed', channelId: 'tc4', channelName: 'feature-older', parentId: 'b-done', retireAt: new Date() },
    ],
    takenNames: new Set(),
  }
  const plan = planProjectSection(project, observed)
  const byId = Object.fromEntries(plan.tasks.map((t) => [t.taskId, t]))
  assert.equal(byId.t1.action, 'move'); assert.equal(byId.t1.bucket, 'open')
  // A bucket being created this run has no id yet, so the channel is still "not there".
  assert.equal(byId.t2.action, 'move'); assert.equal(byId.t2.bucket, 'inProgress')
  assert.equal(byId.t3.action, 'none'); assert.equal(byId.t3.bucket, 'done'); assert.equal(byId.t3.retire, true)
  // Already stamped: the fourteen days must not restart on every run.
  assert.equal(byId.t4.action, 'none'); assert.equal(byId.t4.retire, undefined)
})

test('plan: room is counted per bucket, and a full bucket leaves its tickets where they are with a warning naming it', () => {
  const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, type: 'feature', status: 'open', channelId: `tc${i}`, channelName: `feature-task-${i}`, parentId: 'c1' }))
  const observed = {
    categoryId: 'c1', categoryName: '📂 FRAMEWORK', categoryChannelCount: 63,
    buckets: { open: { id: 'b-open', name: '📂 FRAMEWORK · OPEN', channelCount: 0 }, inProgress: null, done: null },
    tasks, takenNames: new Set(),
  }
  const plan = planProjectSection(project, observed)
  assert.equal(plan.tasks.filter((t) => t.action === 'move').length, 49)
  assert.equal(plan.tasks.filter((t) => t.action === 'none').length, 1)
  assert.ok(plan.warnings.some((w) => /OPEN bucket/.test(w) && /1 task channel/.test(w)))
})
```

Then **update** the existing tests in this file that assert a task channel ends up in the section category (`parent: 'c1'` / `action: 'move'` into `c1`, and any `landsInside`/`opens` assertions that depended on `categoryId`): they now expect the bucket — `parent` is the bucket's id when one is observed, and a created bucket's id (`new-N`) in apply tests (Task 8). Keep every test; change only the expectation. Anything asserting `categoryChannelCount`-based room for tasks now asserts per-bucket room.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/services/projectSection.test.js`
Expected: new tests FAIL (`observed.buckets` undefined, `plan.buckets` undefined).

- [ ] **Step 3: Observe the buckets**

In `observeProjectSection`, after `categoryId` is known and before the section channels:

```js
  // The three status buckets: by stored id (a category renamed by hand is
  // still ours), else by exact name among categories no other project claims
  // — the same two rules the section category follows.
  const bucketIds = bucketIdsOf(project)
  const buckets = {}
  for (const b of BUCKETS) {
    let cat = bucketIds[b.key] ? byId.get(bucketIds[b.key]) ?? null : null
    if (cat && cat.type !== ChannelType.GuildCategory) cat = null
    if (!cat) {
      const wanted = bucketNameFor(project, b)
      cat = all.find((c) => c.type === ChannelType.GuildCategory && c.name === wanted && !claimed.has(c.id)) ?? null
    }
    buckets[b.key] = cat ? { id: cat.id, name: cat.name, channelCount: all.filter((c) => c.parentId === cat.id).length } : null
  }
```

In the `observedTasks.push({...})` add `status: task.status ?? null,` and `retireAt: task.channelRetireAt ?? null,`. Add `buckets,` to the returned object. Import `BUCKETS, bucketFor, bucketNameFor, bucketIdsOf, isDoneBucket` from `'../utils/statusBuckets.js'`.

- [ ] **Step 4: Plan the buckets and file the tasks**

Add after `planCategory`:

```js
/** One entry per bucket, `planCategory`'s rules applied to each. */
function planBuckets(project, observed) {
  const seen = observed?.buckets ?? {}
  return BUCKETS.map((b) => {
    const name = bucketNameFor(project, b)
    const found = seen[b.key]
    if (!found?.id) return { key: b.key, storeKey: b.storeKey, action: 'create', name }
    if (found.name === name) return { key: b.key, storeKey: b.storeKey, action: 'reuse', id: found.id, name }
    return { key: b.key, storeKey: b.storeKey, action: 'rename', id: found.id, name }
  })
}
```

Rewrite `planTasks(project, observed, channels, role, warnings)` so that:

```js
function planTasks(project, observed, channels, role, warnings) {
  const sectionId = observed?.categoryId ?? null
  const seen = observed?.buckets ?? {}
  const bucketIdOf = (key) => seen[key]?.id ?? null
  const projectCategoryIds = new Set([sectionId, ...BUCKETS.map((b) => bucketIdOf(b.key))].filter(Boolean))
  // Room per bucket. A bucket being created this run starts empty. Section
  // channels never sit in a bucket, so they no longer compete with tickets.
  const room = {}
  for (const b of BUCKETS) room[b.key] = Math.max(0, CATEGORY_SOFT_CAP - Number(seen[b.key]?.channelCount ?? 0))
  const leftBehind = {}

  const tasks = Array.isArray(observed?.tasks) ? observed.tasks : []
  const taken = new Set(observed?.takenNames ?? [])
  for (const channel of channels) taken.add(channel.name)
  const assigned = new Set()
  const planned = []

  for (const task of tasks) {
    if (!task?.channelId) continue
    const pool = new Set(taken)
    if (task.channelName && !assigned.has(task.channelName)) pool.delete(task.channelName)
    const name = taskChannelName({ type: task.type, title: task.title, taskId: task.id, taken: pool })
    assigned.add(name)
    taken.add(name)

    const bucket = bucketFor(task.status)
    const wantedParent = bucketIdOf(bucket)
    const nameOk = task.channelName === name
    // A bucket being created has no id yet, so nothing can already be in it.
    const parentOk = Boolean(wantedParent) && task.parentId === wantedParent
    let action = nameOk ? (parentOk ? 'none' : 'move') : parentOk ? 'rename' : 'both'

    const needsAllow = lacksRoleAllow(task.overwriteIds, role)
    if (action === 'none' && needsAllow) action = 'grant'

    if (action === 'move' || action === 'both') {
      if (room[bucket] > 0) room[bucket] -= 1
      else {
        action = action === 'both' ? 'rename' : 'none'
        leftBehind[bucket] = (leftBehind[bucket] ?? 0) + 1
      }
    }
    // Inside the project's space after this plan: moved into a bucket, or
    // staying in a bucket or the section category it is already in.
    const landsInside = action === 'move' || action === 'both' || projectCategoryIds.has(task.parentId)
    const entry = {
      taskId: task.id,
      channelId: task.channelId,
      action,
      name,
      topic: taskChannelTopic({ type: task.type, title: task.title, taskId: task.id }),
      bucket,
    }
    if (needsAllow && landsInside && action !== 'grant') entry.opens = true
    // Filed into Done for the first time: read-only now, gone in fourteen days.
    // Never re-stamped — the fortnight would restart on every run.
    if (isDoneBucket(bucket) && !task.retireAt) entry.retire = true
    planned.push(entry)
  }

  // (keep the existing `sharedTaskChannels` warning block verbatim)

  for (const [key, n] of Object.entries(leftBehind)) {
    const label = bucketByKey(key)?.label ?? key
    warnings.push(
      `Project "${project?.name}"'s ${label} bucket is at Discord's category cap (${CATEGORY_SOFT_CAP} channels), so ${n} task channel${n === 1 ? '' : 's'} stayed where ${n === 1 ? 'it is' : 'they are'}.`
    )
  }
  return planned
}
```

(Import `bucketByKey` too.) Keep the comments the old function carried about the topic riding with the rename and about `opens`; they still apply. In `planProjectSection`, add `const buckets = planBuckets(project, observed)` after the category and return `{ role, category, buckets, channels, tasks, voice, clients, warnings }`. Update the JSDoc for `observed` (`buckets`, task `status`/`retireAt`).

- [ ] **Step 5: Run the file and the full suite**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/services/projectSection.test.js` — Expected: PASS after updating the older expectations. Full suite with the gate: `ℹ fail 0`. (`project-setup.test.js` may now see `Task channels: … to move` where it saw `already right`; adjust those expectations in the same spirit — the ticket now belongs in a bucket.)

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/projectSection.js bot/src/services/projectSection.test.js bot/src/commands/project-setup.test.js
git commit -m "feat(buckets): /project-setup observes and plans the three status buckets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `/project-setup` applies the buckets and files the tickets

**Files:**
- Modify: `bot/src/services/projectSection.js` (`applyProjectSection` ~line 1031: new step 2b, step 4, new step 4c, step 5)
- Test: `bot/src/services/projectSection.test.js`

**Interfaces:**
- Consumes: `plan.buckets`, `plan.tasks[].bucket/retire` (Task 7); `retireTicketChannel` (Task 3); `categoryOverwrites`, `missingOverwrites`, `mergedOverwrites`, `roleAllowMerged` (existing).
- Produces: `applyProjectSection(guild, project, plan, { db, members, nameFor, botUserId, retire = retireTicketChannel, now = () => new Date() })`. `result` gains `buckets: { created: string[], renamed: string[] }` and `retired: number`. Bucket ids are persisted under their `storeKey` in `discordChannels` by the existing step 5 write.

- [ ] **Step 1: Write the failing tests**

Append to `bot/src/services/projectSection.test.js` (the `fakeGuild` there gives created channels ids `new-1`, `new-2`, … in creation order; a created category has `parentId: null`. Add `rawPosition: 0` to `fakeChannel`'s object and let `edit` apply `o.position` to `rawPosition` — a two-line change to the helper):

```js
test('apply creates the three buckets after the category with its overwrites, positions them below it, and stores their ids', async () => {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const guild = fakeGuild({ roles: [role] })
  const db = fakeDb()
  const plan = planProjectSection(project, { roleId: 'r1', rolesFetched: true })
  const result = await applyProjectSection(guild, { ...project, discordRoleId: 'r1' }, plan, { db })
  const cats = guild.channels.calls.filter((c) => c.type === ChannelType.GuildCategory)
  assert.deepEqual(cats.map((c) => c.name), ['📂 FRAMEWORK', '📂 FRAMEWORK · OPEN', '📂 FRAMEWORK · IN PROGRESS', '📂 FRAMEWORK · DONE'])
  for (const c of cats.slice(1)) {
    assert.deepEqual(c.permissionOverwrites.map((o) => [o.id, o.type]), [['G1', OverwriteType.Role], ['r1', OverwriteType.Role]])
  }
  assert.deepEqual(result.buckets, { created: ['📂 FRAMEWORK · OPEN', '📂 FRAMEWORK · IN PROGRESS', '📂 FRAMEWORK · DONE'], renamed: [] })
  const saved = db.calls[0].data.discordChannels
  assert.equal(saved.bucketOpen, 'new-2'); assert.equal(saved.bucketInProgress, 'new-3'); assert.equal(saved.bucketDone, 'new-4')
  // Positioned directly below the section category, in order.
  const positions = [guild.channels.cache.get('new-2'), guild.channels.cache.get('new-3'), guild.channels.cache.get('new-4')].map((c) => c.rawPosition)
  assert.deepEqual(positions, [1, 2, 3])
})

test('apply renames a bucket found under an old name and repairs its overwrites, without touching one that is right', async () => {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const open = fakeChannel('b-open', '📂 FRAMEWORK · OPEN', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const done = fakeChannel('b-done', 'old done', { type: ChannelType.GuildCategory, overwriteIds: ['G1'] })
  const guild = fakeGuild({ channels: [cat, open, done], roles: [role] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1', discordChannels: { bucketOpen: 'b-open', bucketDone: 'b-done' } }
  const observed = observeProjectSection(guild, stored, [], { rolesFetched: true })
  const plan = planProjectSection(stored, observed)
  const result = await applyProjectSection(guild, stored, plan, { db: fakeDb() })
  assert.deepEqual(open.edits.filter((e) => e.name), [])
  assert.equal(done.edits[0].name, '📂 FRAMEWORK · DONE')
  assert.ok(done.edits[0].permissionOverwrites.some((o) => o.id === 'r1'))
  assert.deepEqual(result.buckets.renamed, ['📂 FRAMEWORK · DONE'])
})

test('apply files a ticket into its bucket — created this run — carrying the role allow in the same edit', async () => {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const taskCh = ticketChannel('tc1', 'feature-git-sync', 'c1')
  const guild = fakeGuild({ channels: [cat, taskCh], roles: [role] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1' }
  const observed = observeProjectSection(guild, stored, [{ id: 't1', title: 'Git Sync', type: 'feature', status: 'in_progress', discordChannelId: 'tc1' }], { rolesFetched: true })
  const plan = planProjectSection(stored, observed)
  const result = await applyProjectSection(guild, stored, plan, { db: fakeDb() })
  const progId = guild.channels.calls.findIndex((c) => c.name === '📂 FRAMEWORK · IN PROGRESS') + 1
  assert.equal(taskCh.edits.length, 1)
  assert.equal(taskCh.edits[0].parent, `new-${progId}`)
  assert.ok(taskCh.edits[0].permissionOverwrites.some((o) => o.id === 'r1'))
  assert.deepEqual(result.moved, ['feature-git-sync'])
  assert.equal(result.tasks, 1)
})

test('apply retires a finished ticket filed into Done — stamped from this run, through the seam — and counts it', async () => {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const doneCat = fakeChannel('b-done', '📂 FRAMEWORK · DONE', { type: ChannelType.GuildCategory, overwriteIds: ['G1', 'r1'] })
  const taskCh = ticketChannel('tc1', 'feature-old', 'b-done')
  const guild = fakeGuild({ channels: [cat, doneCat, taskCh], roles: [role] })
  const stored = { ...project, discordCategoryId: 'c1', discordRoleId: 'r1', discordChannels: { bucketDone: 'b-done' } }
  const observed = observeProjectSection(guild, stored, [
    { id: 't1', title: 'Old', type: 'feature', status: 'done', discordChannelId: 'tc1', channelRetireAt: null },
  ], { rolesFetched: true })
  const plan = planProjectSection(stored, observed)
  const retired = []
  const db = { ...fakeDb(), task: { update: async () => {} } }
  const NOW = new Date('2026-09-25T00:00:00Z')
  const result = await applyProjectSection(guild, stored, plan, {
    db,
    now: () => NOW,
    retire: async (a) => { retired.push([a.task.id, a.channel?.id, a.db === db, a.now()]) },
  })
  assert.deepEqual(retired, [['t1', 'tc1', true, NOW]])
  assert.equal(result.retired, 1)
})

test('apply: without a database, finished tickets are not stamped and the reply says so', async () => {
  const cat = fakeChannel('c1', '📂 FRAMEWORK', { type: ChannelType.GuildCategory })
  const doneCat = fakeChannel('b-done', '📂 FRAMEWORK · DONE', { type: ChannelType.GuildCategory })
  const taskCh = ticketChannel('tc1', 'feature-old', 'b-done')
  const guild = fakeGuild({ channels: [cat, doneCat, taskCh] })
  const stored = { ...project, discordCategoryId: 'c1', discordChannels: { bucketDone: 'b-done' } }
  const observed = observeProjectSection(guild, stored, [{ id: 't1', title: 'Old', type: 'feature', status: 'done', discordChannelId: 'tc1' }])
  const plan = planProjectSection(stored, observed)
  let called = 0
  const result = await applyProjectSection(guild, stored, plan, { retire: async () => { called += 1 } })
  assert.equal(called, 0)
  assert.equal(result.retired, 0)
  assert.ok(result.warnings.some((w) => /not stamped for removal/.test(w)))
})

test('apply: a bucket that fails to create is one warning; the other buckets and the section still land', async () => {
  const role = { id: 'r1', name: 'Framework', members: new Map() }
  const guild = fakeGuild({ roles: [role], createFails: (o) => o.name === '📂 FRAMEWORK · IN PROGRESS' })
  const plan = planProjectSection(project, { roleId: 'r1', rolesFetched: true })
  const result = await quiet(() => applyProjectSection(guild, { ...project, discordRoleId: 'r1' }, plan, { db: fakeDb() }))
  assert.deepEqual(result.buckets.created, ['📂 FRAMEWORK · OPEN', '📂 FRAMEWORK · DONE'])
  assert.ok(result.warnings.some((w) => w.includes('IN PROGRESS')))
  assert.equal(result.created.filter((n) => n.startsWith('framework-')).length, 13)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run the file. Expected: FAIL — no buckets created, `result.buckets` undefined, task channel parented to `c1`.

- [ ] **Step 3: Apply the buckets (step 2b)**

In `applyProjectSection`: add `retire = retireTicketChannel, now = () => new Date()` to the deps parameter (import `retireTicketChannel` from `'./ticketRetire.js'`), and `buckets: { created: [], renamed: [] }, retired: 0` to `result`. At the top of the `else` branch that begins `// 3. The ten section channels`, insert:

```js
    // 2b. The three status buckets: sibling categories directly below the
    //     section category, same overwrites as it. Created, renamed or reused
    //     exactly as the category is; each on its own try/catch.
    const bucketIdByKey = {}
    for (const entry of plan?.buckets ?? []) {
      try {
        let cat = null
        if (entry.action === 'create') {
          cat = await guild.channels.create({
            name: entry.name,
            type: ChannelType.GuildCategory,
            permissionOverwrites: categoryOverwrites(guild, roleId),
            reason: REASON,
          })
          result.created.push(entry.name)
          result.buckets.created.push(entry.name)
        } else {
          cat = guild.channels.cache.get(entry.id) ?? null
          if (!cat) throw new Error(`bucket ${entry.id} no longer exists`)
          const required = categoryOverwrites(guild, roleId)
          const needsName = entry.action === 'rename'
          const needsPerms = missingOverwrites(cat, required)
          if (needsName || needsPerms) {
            const payload = { name: entry.name }
            if (needsPerms) payload.permissionOverwrites = mergedOverwrites(cat, required)
            await cat.edit(payload)
            if (needsName) {
              result.renamed.push(entry.name)
              result.buckets.renamed.push(entry.name)
            }
          }
        }
        channelIds[entry.storeKey] = cat.id
        bucketIdByKey[entry.key] = cat.id
      } catch (e) {
        note(result.warnings, `bucket "${entry.name}"`, e)
      }
    }
    // Sidebar order: section, then open, in progress, done. Best-effort — a
    // refused position edit is a warning, and a bucket already where it
    // belongs is not edited again on every run.
    const base = Number(result.category?.rawPosition ?? result.category?.position ?? 0)
    for (const [i, b] of BUCKETS.entries()) {
      const cat = bucketIdByKey[b.key] ? guild.channels.cache.get(bucketIdByKey[b.key]) : null
      if (!cat) continue
      const wanted = base + i + 1
      if (Number(cat.rawPosition ?? cat.position ?? -1) === wanted) continue
      try {
        await cat.edit({ position: wanted })
      } catch (e) {
        note(result.warnings, `position of "${cat.name}"`, e)
      }
    }
    const projectCategoryIds = new Set([categoryId, ...Object.values(bucketIdByKey)])
```

- [ ] **Step 4: File the tickets by bucket (step 4) and retire (step 4c)**

In the step-4 loop replace the parent/overwrite lines:

```js
        const wantedParent = bucketIdByKey[task.bucket] ?? null
        let action = task.action
        // The bucket could not be made: keep the readable name, stay put.
        if (!wantedParent && (action === 'move' || action === 'both')) {
          unplaced += 1
          action = action === 'both' ? 'rename' : 'none'
          if (action === 'none') continue
        }
        const stays = action === 'rename' || action === 'grant'
        const parent = stays ? channel.parentId ?? null : wantedParent
        const overwrites = projectCategoryIds.has(parent) ? roleAllowMerged(channel, projectRoleId) : null
```

and use `action` (not `task.action`) in the rest of the loop body. Declare `let unplaced = 0` before the loop and after it:

```js
    if (unplaced > 0) {
      result.warnings.push(
        `${unplaced} task channel${unplaced === 1 ? '' : 's'} for "${project?.name}" could not be filed because ${unplaced === 1 ? 'its' : 'their'} status bucket could not be created. Run /project-setup again once the bot can create categories.`
      )
    }

    // 4c. Finished tickets filed into Done for the first time: read-only now,
    //     gone in fourteen days — counted from THIS run, so a backfill never
    //     deletes anything the day it runs. Only through a database the caller
    //     passed: the default would be production.
    const retirable = (plan?.tasks ?? []).filter((t) => t.retire)
    if (retirable.length && !db?.task?.update) {
      result.warnings.push(`${retirable.length} finished ticket(s) were not stamped for removal — no database was passed to the applier.`)
    } else {
      for (const task of retirable) {
        try {
          await retire({ channel: guild.channels.cache.get(task.channelId) ?? null, task: { id: task.taskId }, db, now })
          result.retired += 1
        } catch (e) {
          note(result.warnings, `retiring "${task.name}"`, e)
        }
      }
    }
```

Step 5 is unchanged — `channelIds` already carries the bucket store keys. Update the JSDoc `@returns` for the new fields and the function comment ("role, then category, then the buckets, then the section channels, then the task channels, then the retirements, then one write of the ids").

- [ ] **Step 5: Run the file and the full suite**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/services/projectSection.test.js` — Expected: PASS. Full suite with the gate: `ℹ fail 0`. (`project-setup.test.js` counts of `created` grow by three per project — the three buckets; update those expectations.)

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/projectSection.js bot/src/services/projectSection.test.js bot/src/commands/project-setup.test.js
git commit -m "feat(buckets): /project-setup creates the buckets, files every ticket, and stamps finished ones

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Preview and result text, `/cleanup` protection, the sweep at start-up

**Files:**
- Modify: `bot/src/commands/project-setup.js` (`renderPlan` ~line 189, `renderResult` ~line 239), `bot/src/commands/cleanup.js` (`projectSectionGuards` ~line 147), `bot/src/index.js`
- Test: `bot/src/commands/project-setup.test.js`, `bot/src/commands/cleanup.test.js`

**Interfaces:**
- Consumes: `plan.buckets`, `plan.tasks[].bucket/retire`, `result.buckets`, `result.retired` (Tasks 7–8); `bucketIdsOf`, `bucketByKey` (Task 1); `startTicketRetireSweep` (Task 3).

- [ ] **Step 1: Write the failing tests**

Append to `bot/src/commands/project-setup.test.js`:

```js
test('renderPlan lists the buckets, says which bucket each move goes into, and how many tickets will be retired', () => {
  const out = renderPlan(
    { name: 'Framework' },
    {
      category: { action: 'reuse', id: 'c1', name: '📂 FRAMEWORK' },
      buckets: [
        { key: 'open', storeKey: 'bucketOpen', action: 'create', name: '📂 FRAMEWORK · OPEN' },
        { key: 'inProgress', storeKey: 'bucketInProgress', action: 'reuse', id: 'b', name: '📂 FRAMEWORK · IN PROGRESS' },
        { key: 'done', storeKey: 'bucketDone', action: 'rename', id: 'd', name: '📂 FRAMEWORK · DONE' },
      ],
      tasks: [
        { taskId: 't1', action: 'move', name: 'feature-a', bucket: 'open' },
        { taskId: 't2', action: 'both', name: 'bug-b', bucket: 'open' },
        { taskId: 't3', action: 'move', name: 'feature-c', bucket: 'done', retire: true },
        { taskId: 't4', action: 'none', name: 'feature-d', bucket: 'done' },
      ],
    }
  )
  assert.match(out, /Status buckets: 1 to create, 1 to rename, 1 already right/)
  assert.match(out, /Task channels: 1 to rename and move, 2 to move, 1 already right \(into OPEN: 2, DONE: 1\)/)
  assert.match(out, /1 finished ticket\(s\) will become read-only and be removed in 14 days/)
})

test('renderResult counts the buckets and the retired tickets', () => {
  const out = renderResult({ name: 'Framework' }, {
    created: ['📂 FRAMEWORK · OPEN', 'framework-members'],
    buckets: { created: ['📂 FRAMEWORK · OPEN'], renamed: [] },
    moved: ['feature-a'], tasks: 1, retired: 2,
  })
  assert.match(out, /2 created, 1 moved/)
  assert.match(out, /Status buckets: 1 created/)
  assert.match(out, /2 finished ticket channel\(s\) are now read-only and will be removed in 14 days/)
})
```

Append to `bot/src/commands/cleanup.test.js` (mirror the `run`/`LEGACY` fixtures the file already has; `LEGACY` needs `discordChannels.bucketOpen`):

```js
test('a ticket channel inside a project\'s status bucket is protected, by the bucket\'s id', async () => {
  const bucket = category('bucket-open', 'whatever it is called now')
  const withBucket = { ...LEGACY, discordChannels: { ...(LEGACY.discordChannels ?? {}), bucketOpen: 'bucket-open' } }
  const reply = await run([withBucket], [bucket, chan('tc1', 'feature-0145e3', { parent: bucket }), chan('junk', 'random-leftover')])
  assert.deepEqual(listedForDeletion(reply), ['random-leftover'])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run both files. Expected: FAIL — no `Status buckets` line; `feature-0145e3` listed for deletion.

- [ ] **Step 3: Render**

In `bot/src/commands/project-setup.js` add `import { bucketByKey } from '../utils/statusBuckets.js'` and:

```js
const BUCKET_WORDS = [
  ['create', 'to create'],
  ['rename', 'to rename'],
  ['reuse', 'already right'],
]

/** '(into OPEN: 2, DONE: 1)' — where the moves go, zeros dropped, table order. */
function intoBuckets(tasks) {
  const counts = new Map()
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t?.action !== 'move' && t?.action !== 'both') continue
    counts.set(t.bucket, (counts.get(t.bucket) ?? 0) + 1)
  }
  const parts = ['open', 'inProgress', 'done']
    .filter((k) => counts.get(k))
    .map((k) => `${bucketByKey(k)?.label ?? k}: ${counts.get(k)}`)
  return parts.length ? ` (into ${parts.join(', ')})` : ''
}
```

In `renderPlan`, after the `Category:` line:

```js
  const buckets = summarise(plan?.buckets, BUCKET_WORDS)
  if (buckets) lines.push(`Status buckets: ${buckets}`)
```

change the task line to `if (tasks) lines.push(`Task channels: ${tasks}${intoBuckets(plan?.tasks)}`)`, and after it:

```js
  const retiring = (plan?.tasks ?? []).filter((t) => t?.retire).length
  if (retiring) lines.push(`${retiring} finished ticket(s) will become read-only and be removed in 14 days.`)
```

In `renderResult`, after the first summary line:

```js
  const b = result?.buckets ?? {}
  const bucketBits = []
  if (b.created?.length) bucketBits.push(`${b.created.length} created`)
  if (b.renamed?.length) bucketBits.push(`${b.renamed.length} renamed`)
  if (bucketBits.length) lines.push(`Status buckets: ${bucketBits.join(', ')}.`)
  const retired = Number(result?.retired ?? 0)
  if (retired) lines.push(`${retired} finished ticket channel(s) are now read-only and will be removed in 14 days.`)
```

- [ ] **Step 4: Protect bucket contents in `/cleanup`**

In `bot/src/commands/cleanup.js`, `projectSectionGuards`:

```js
    // Everything living in a project category — the section AND its three
    // status buckets: task channels, and the meeting pairs /meeting-channel
    // creates inside a section.
    categoryIds: new Set(
      rows.flatMap((p) => [p?.discordCategoryId, ...Object.values(bucketIdsOf(p))]).filter(Boolean),
    ),
```

with `import { bucketIdsOf } from "../utils/statusBuckets.js";`.

- [ ] **Step 5: Start the sweep**

In `bot/src/index.js`: `import { startTicketRetireSweep } from "./services/ticketRetire.js";` and, right after `startTicketReminder(client);`, `startTicketRetireSweep(client);`.

- [ ] **Step 6: Run the tests and the full suite**

Run both files; then the full suite with the gate. Expected: `ℹ fail 0`. Also `cd bot && node --check src/index.js`.

- [ ] **Step 7: Commit**

```bash
git add bot/src/commands/project-setup.js bot/src/commands/project-setup.test.js bot/src/commands/cleanup.js bot/src/commands/cleanup.test.js bot/src/index.js
git commit -m "feat(buckets): preview/result wording, /cleanup protects bucket contents, sweep starts with the bot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Knowledge, state and spec corrections

**Files:**
- Create: `.claude/knowledge/status-buckets.md`
- Modify: `.claude/knowledge/project-sections.md` (the "Task channels live in the same category" paragraph and the `/cleanup` paragraph), `.claude/knowledge/README.md`, `.claude/state/session.md`, `.claude/state/completed.md`, `.claude/state/backlog.md`, `docs/superpowers/specs/2026-09-24-status-buckets-design.md`

- [ ] **Step 1: Write `status-buckets.md`**

Cover, in this order, one short section each: the bucket table and where the leaf lives (`bot/src/utils/statusBuckets.js`; why `cut`/`storedChannels` moved to `utils/projectStore.js`); where bucket ids are stored and what that buys (claim set, `/cleanup`); creation placement order (bucket → section → global) and the `fellBack` vs `placed` distinction; the mover (`ticketBucketMove.js`) and its reasons, called from `applyTaskUpdate` so every writer behaves the same; the Done transition (`ticketRetire.js`: lock/unlock rules, `channelRetireAt`, hourly sweep, 10003 handling, the "stamp even when the lock fails" rule); `/project-setup` (observe by id then guarded name, `planBuckets`, per-bucket room, `retire` only without a stamp, step 2b/4/4c, position best-effort, the `unplaced` warning); `/close-feature` and `/resolve-bug`; what clients see; rollout (`/project-setup project:<X>` once per project, `preview:true` first).

- [ ] **Step 2: Update the neighbours**

- `project-sections.md`: replace the "Task channels live in the same category" paragraph with two sentences pointing at `status-buckets.md`; in the `/cleanup` section note `categoryIds` now includes bucket ids; in the section-channel room note that tickets no longer compete with section channels.
- `README.md`: add the `status-buckets.md` line.
- Spec: append a dated "Corrections" section: (1) `fellBack: 'noBucket'` in §5 became `placed: 'section'` with `fellBack` unchanged (Task 4, why); (2) §6/§7: the Done transition runs for project-less tickets too (Task 5, why).
- `.claude/state/`: `completed.md` gets the dated entry with the commits; `backlog.md` gets any parked findings from the build (and remove nothing that is not done); `session.md` is cleared to the post-ship state.

- [ ] **Step 3: Commit**

```bash
git add .claude/knowledge .claude/state docs/superpowers/specs/2026-09-24-status-buckets-design.md
git commit -m "docs(buckets): knowledge file, state, and spec corrections for status buckets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

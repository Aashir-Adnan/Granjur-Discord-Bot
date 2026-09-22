# Task Time Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone can clock time against a task from Discord, and the organisation can report time per task and per person, in Discord and on UBS-Doc.

**Architecture:** The existing shift-level `clockentry` table gains a nullable `taskId`, a derived `minutes` column and a `source`, so old rows survive and one person can only ever have one timer running. All the logic that can be got wrong (duration parsing, formatting, week boundaries, runaway detection, aggregation) lives in one pure module with no database or Discord imports; commands and the background watcher are thin shells over it. CSAAS exposes the totals through the existing tasks read plus one new report endpoint, and UBS-Doc renders them, every new field optional so the three repos can deploy in any order.

**Tech Stack:** Node 24 ESM, discord.js v14.25, mysql2 via the hand-rolled layer in `bot/src/Database/index.js`, `node:test` for the bot, CommonJS + hand-rolled test scripts for CSAAS, React 19 + TypeScript + vitest for UBS-Doc.

**Spec:** `docs/superpowers/specs/2026-09-22-task-time-tracking-design.md`

## Global Constraints

- **No test may touch production.** The root `.env` points at the production database. Every function under test takes `db` (and `getConfig` where needed) as a seam and every test passes fakes. Run bot suites as `DATABASE_URL=poisoned://no-production-access npm test` from `bot/`. This applies to a first red run too.
- **SQL:** lowercase table names in backticks; `LIMIT` inlined as a clamped integer, never bound; every INSERT/UPDATE builds columns and params from one ordered array with a test asserting placeholder/param parity.
- **Migrations:** guarded with the `information_schema` pattern (see `022_task_parent.sql`) and mirrored into `bot/src/Database/schema.sql`.
- **No maximum on a single manual entry.** A duration must parse to a positive whole number of minutes; that is the only bound.
- **`taskId` is nullable** (general work, and pre-existing shift rows) even though `/clock-in` always presents a choice.
- **No foreign key on `clockentry.taskId`** — deleting a task must not delete the hours someone worked.
- **Leadership gate** is `memberPassesRoleGate(guild, member, ensureStringArray(cfg.dashboardRoleIds), LEADERSHIP_ROLE_NAMES)`, the same gate `/update-task` uses.
- **Commits** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` on its own line after a blank line. Author is `Nauraiz Haider <bsse23047@itu.edu.pk>`.
- **Never run `git add -A`** in CSAAS_Backend or UBS-Doc — both carry unrelated uncommitted work. Stage named files only.
- **Never run prettier** in any of these repos.
- Work on branch `feat/task-time-tracking` in Granjur-Discord-Bot (already created, the spec is committed on it).

## Deviation from the spec, decided while planning

**Spec §8 asks for a "Time panel on the task hub reached by a Time button". That is not possible.** The hub's button row already reaches Discord's five-button-per-row ceiling (`Edit details`, `Test counts`, `Subtasks`/`Parent task`, `Back to list`, `Close`) and the message already uses all five action rows (project select, implementation select, add-blocker select, remove-blocker select, buttons). A sixth button or row is rejected by Discord.

Instead, in Task 8:
- The **estimate** becomes a fourth field in the existing counts modal, whose button is relabelled `Counts & estimate` (a modal takes five components; it currently uses three).
- The **logged total and estimate** appear as a field on the hub embed.
- **Logging time** stays with `/clock-in`, `/clock-out` and `/log-time`, which is where people will do it anyway.

Everything else in the spec is implemented as written.

## File structure

**Granjur-Discord-Bot (`bot/src/`)**

| File | Responsibility |
|---|---|
| `Database/migrations/023_task_time_tracking.sql` | *new* — the guarded ALTERs |
| `Database/schema.sql` | mirror the new columns |
| `Database/index.js` | clockentry insert/update builders, new finders, `task.estimateMinutes`, guildconfig columns, fix the `ClockEntry` casing |
| `utils/timeTracking.js` | *new* — all pure rules. No db, no discord.js |
| `utils/timeTaskPicker.js` | *new* — which tasks a person may clock into (pure) |
| `commands/clock-in.js` | rewritten: task required, same-task no-op, switch-in-one-reply |
| `commands/clock-out.js` | rewritten: writes `minutes`, reports the task total |
| `commands/log-time.js` | *new* — retroactive entry |
| `commands/my-time.js` | *new* — your timer, totals and entry edit/delete panel |
| `commands/time-report.js` | *new* — leadership reporting |
| `services/clockWatch.js` | *new* — reminder DM and the cap, on a timer |
| `services/taskHub.js` | estimate in the counts modal, time on the embed |
| `handlers/interactions.js` | route `clk_` buttons and the `mt_`/`tr_` panels |
| `index.js` | `startClockWatch(client)` |
| `commands/index.js` | register the three new commands |
| `config/command-config.json` | help text for five commands |

**CSAAS_Backend**

| File | Responsibility |
|---|---|
| `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js` | time totals on each task, with the fallback |
| `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeReport.js` | *new* — the Team Time tab's data |
| `Services/SysScripts/TestScripts/discord-tasks-test/time.test.js` | *new* — both of the above |

**UBS-Doc (`src/`)**

| File | Responsibility |
|---|---|
| `screens/tasksLogic.ts` | optional `timeLogged`, `estimateMinutes`, `timeByPerson` |
| `screens/team/timeLogic.ts` | *new* — formatting, aggregation, week ranges (pure) |
| `screens/team/TimeSection.tsx` | *new* — the task detail Time block |
| `screens/team/TimeTab.tsx` | *new* — Team → Time |
| `screens/team/TaskDetail.tsx`, `TasksList.tsx`, `Board.tsx`, `teamNav.ts` | the chip and the tab |
| `components/discordTasks/api.ts` | `fetchTimeReport` |

---

### Task 1: Database — migration 023, the columns and the builders

**Files:**
- Create: `bot/src/Database/migrations/023_task_time_tracking.sql`
- Modify: `bot/src/Database/schema.sql` (the `clockentry`, `task` and `guildconfig` blocks)
- Modify: `bot/src/Database/index.js` (`clockEntryCreate` ~2018, `clockEntryUpdate` ~2040, `clockEntryFindMany` ~2056, the `clockEntry` export block ~2371, `taskUpdate`, `guildConfigUpdate` ~79)
- Test: `bot/src/Database/clockEntry.test.js` *(new)*

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `clockEntryInsertSql(data, pk) -> { sql, params }`
  - `clockEntryUpdateSets(data) -> { sets, vals }`
  - `db.clockEntry.create({ data })`, `.findActive(guildId, discordId)`, `.update(id, data)`, `.findMany({ where: { guildConfigId, discordId?, taskId?, since?, until?, openOnly? }, take })`, `.findById(id)`, `.sumByTask({ guildConfigId, taskIds })`, `.findOpen({ guildConfigId? })`
  - `db.projectMember.findByMember({ where: { guildConfigId, discordId } })`
  - `task.estimateMinutes` accepted by `db.task.update`
  - `guildconfig.clockReminderHours` / `clockCapHours` accepted by `updateGuildConfig`

- [ ] **Step 1: Write the failing test**

Create `bot/src/Database/clockEntry.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clockEntryInsertSql, clockEntryUpdateSets } from './index.js'

test('clockentry insert: placeholders equal params and follow the column order', () => {
  const { sql, params } = clockEntryInsertSql({
    guildConfigId: 'g1', discordId: 'u1', clockInAt: '2026-09-22 09:00:00',
    clockOutAt: '2026-09-22 10:30:00', taskId: 't1', minutes: 90, note: 'pairing', source: 'timer',
  }, 'ce1')
  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim())
  assert.deepEqual(cols, ['id', 'guildConfigId', 'discordId', 'clockInAt', 'clockOutAt', 'taskId', 'minutes', 'note', 'source'])
  assert.equal((sql.match(/\?/g) || []).length, params.length)
  assert.deepEqual(params, ['ce1', 'g1', 'u1', '2026-09-22 09:00:00', '2026-09-22 10:30:00', 't1', 90, 'pairing', 'timer'])
  assert.match(sql, /INSERT INTO `clockentry`/)
})

test('clockentry insert: an open general-work entry defaults cleanly', () => {
  const { params } = clockEntryInsertSql({ guildConfigId: 'g1', discordId: 'u1', clockInAt: 'X' }, 'ce2')
  assert.deepEqual(params, ['ce2', 'g1', 'u1', 'X', null, null, null, null, 'timer'])
})

test('clockentry update: only the fields given are written, and the table name is lowercase', () => {
  assert.deepEqual(clockEntryUpdateSets({ clockOutAt: 'X', minutes: 42 }), {
    sets: ['clockOutAt = ?', 'minutes = ?'], vals: ['X', 42],
  })
  assert.deepEqual(clockEntryUpdateSets({ remindedAt: 'R' }), { sets: ['remindedAt = ?'], vals: ['R'] })
  assert.deepEqual(clockEntryUpdateSets({ taskId: null, note: 'n', source: 'manual' }), {
    sets: ['taskId = ?', 'note = ?', 'source = ?'], vals: [null, 'n', 'manual'],
  })
  assert.deepEqual(clockEntryUpdateSets({}), { sets: [], vals: [] })
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/Database/clockEntry.test.js`
Expected: FAIL — `clockEntryInsertSql is not a function`.

- [ ] **Step 3: Write the migration**

Create `bot/src/Database/migrations/023_task_time_tracking.sql`. Repeat this guarded block for each column — `clockentry.taskId VARCHAR(36) DEFAULT NULL`, `clockentry.minutes INT DEFAULT NULL`, `clockentry.note VARCHAR(500) DEFAULT NULL`, `clockentry.source VARCHAR(16) NOT NULL DEFAULT 'timer'`, `clockentry.remindedAt DATETIME(3) DEFAULT NULL`, `task.estimateMinutes INT DEFAULT NULL`, `guildconfig.clockReminderHours INT DEFAULT NULL`, `guildconfig.clockCapHours INT DEFAULT NULL`:

```sql
-- Task time tracking. Every column is nullable or defaulted, so existing shift
-- rows (no task) stay valid and read as general work. No foreign key on taskId:
-- deleting a task must never delete the hours somebody worked.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clockentry' AND COLUMN_NAME = 'taskId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE clockentry ADD COLUMN taskId VARCHAR(36) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

Then the two indexes, guarded the same way against `information_schema.STATISTICS`:

```sql
SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clockentry' AND INDEX_NAME = 'idx_clockentry_task');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE clockentry ADD KEY idx_clockentry_task (guildConfigId, taskId)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clockentry' AND INDEX_NAME = 'idx_clockentry_person');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE clockentry ADD KEY idx_clockentry_person (guildConfigId, discordId, clockInAt)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

Mirror all eight columns and both indexes into `bot/src/Database/schema.sql`.

- [ ] **Step 4: Write the builders and finders**

In `bot/src/Database/index.js`, replace the body of `clockEntryCreate` and `clockEntryUpdate` with builders, exported for the test:

```js
export function clockEntryInsertSql(data, pk) {
  const columns = [
    ["id", pk],
    ["guildConfigId", data.guildConfigId],
    ["discordId", data.discordId],
    ["clockInAt", data.clockInAt],
    ["clockOutAt", data.clockOutAt ?? null],
    ["taskId", data.taskId ?? null],
    ["minutes", data.minutes ?? null],
    ["note", data.note ?? null],
    ["source", data.source ?? "timer"],
  ];
  return {
    sql: `INSERT INTO \`clockentry\` (${columns.map(([c]) => c).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params: columns.map(([, v]) => v),
  };
}

export function clockEntryUpdateSets(data = {}) {
  const sets = [];
  const vals = [];
  for (const col of ["clockInAt", "clockOutAt", "taskId", "minutes", "note", "source", "remindedAt"]) {
    if (data[col] !== undefined) { sets.push(`${col} = ?`); vals.push(data[col]); }
  }
  return { sets, vals };
}

async function clockEntryCreate({ data }) {
  const pk = id();
  const { sql, params } = clockEntryInsertSql(data, pk);
  await query(sql, params);
  return queryOne("SELECT * FROM `clockentry` WHERE id = ?", [pk]);
}

async function clockEntryUpdate(entryId, data) {
  const { sets, vals } = clockEntryUpdateSets(data);
  if (sets.length === 0) return queryOne("SELECT * FROM `clockentry` WHERE id = ?", [entryId]);
  vals.push(entryId);
  // Lowercase, like every other query against this table. It read `ClockEntry`
  // here and nowhere else, which fails outright on a case-sensitive server.
  await query(`UPDATE \`clockentry\` SET ${sets.join(", ")} WHERE id = ?`, vals);
  return queryOne("SELECT * FROM `clockentry` WHERE id = ?", [entryId]);
}
```

Add the finders. `LIMIT` is inlined and clamped, per the constraint:

```js
async function clockEntryFindById(entryId) {
  return queryOne("SELECT * FROM `clockentry` WHERE id = ?", [entryId]);
}

async function clockEntryFindMany({ where = {}, take = 500 }) {
  let sql = "SELECT * FROM `clockentry` WHERE guildConfigId = ?";
  const params = [where.guildConfigId];
  if (where.discordId) { sql += " AND discordId = ?"; params.push(where.discordId); }
  if (where.taskId) { sql += " AND taskId = ?"; params.push(where.taskId); }
  if (where.since) { sql += " AND clockInAt >= ?"; params.push(where.since); }
  if (where.until) { sql += " AND clockInAt < ?"; params.push(where.until); }
  if (where.openOnly) { sql += " AND clockOutAt IS NULL"; }
  const limit = Math.max(1, Math.min(2000, Number(take) || 500));
  sql += ` ORDER BY clockInAt DESC LIMIT ${limit}`;
  return query(sql, params);
}

async function clockEntryFindOpen() {
  return query("SELECT * FROM `clockentry` WHERE clockOutAt IS NULL ORDER BY clockInAt ASC LIMIT 500", []);
}

async function clockEntrySumByTask({ guildConfigId, taskIds = [] }) {
  const ids = taskIds.filter(Boolean).map(String);
  if (!guildConfigId || ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return query(
    `SELECT taskId, discordId, SUM(minutes) AS minutes FROM \`clockentry\`
     WHERE guildConfigId = ? AND minutes IS NOT NULL AND taskId IN (${placeholders})
     GROUP BY taskId, discordId`,
    [guildConfigId, ...ids],
  );
}

async function projectMemberFindByMember({ where }) {
  return query(
    "SELECT * FROM `projectmember` WHERE guildConfigId = ? AND discordId = ? LIMIT 200",
    [where.guildConfigId, where.discordId],
  );
}
```

Extend the export blocks:

```js
  clockEntry: {
    create: clockEntryCreate,
    findActive: clockEntryFindActive,
    findById: clockEntryFindById,
    update: clockEntryUpdate,
    findMany: clockEntryFindMany,
    findOpen: clockEntryFindOpen,
    sumByTask: clockEntrySumByTask,
  },
```

and add `findByMember: projectMemberFindByMember,` to the `projectMember` block.

In `taskUpdate`, beside the existing `scope` handling, add:

```js
  if (data.estimateMinutes !== undefined) {
    sets.push("estimateMinutes = ?");
    vals.push(data.estimateMinutes);
  }
```

In the guildconfig update (~line 79, beside `clockedInRoleId`), add the same shape for `clockReminderHours` and `clockCapHours`. Add `estimateMinutes` to the `taskInsertSql` ordered column list (as `["estimateMinutes", data.estimateMinutes ?? null]`, last) and update the existing `taskInsertSql` parity test's expected column list in `bot/src/services/taskHierarchy.test.js`.

- [ ] **Step 5: Run the tests**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access npm test`
Expected: PASS, including the existing suite (775 tests) plus the three new ones.

- [ ] **Step 6: Commit**

```bash
git add bot/src/Database/migrations/023_task_time_tracking.sql bot/src/Database/schema.sql bot/src/Database/index.js bot/src/Database/clockEntry.test.js bot/src/services/taskHierarchy.test.js
git commit -m "feat(time): migration 023 and the clockentry data layer"
```

---

### Task 2: The rules module

**Files:**
- Create: `bot/src/utils/timeTracking.js`
- Test: `bot/src/utils/timeTracking.test.js`

**Interfaces:**
- Consumes: nothing. No imports from `db` or `discord.js`.
- Produces: `parseDuration(text) -> number|null`, `formatDuration(minutes) -> string`, `entryMinutes(inAt, outAt) -> number|null`, `runawayState(entry, now, opts) -> 'ok'|'remind'|'stop'`, `weekStart(date, tz) -> Date`, `rangeFor(keyword, now, tz) -> { since: Date, until: Date, label: string }`, `sumByTask(entries) -> Map<string|null, number>`, `sumByPerson(entries) -> Map<string, number>`, `overlaps(entries) -> Array<[a, b]>`, `DEFAULT_REMIND_HOURS = 6`, `DEFAULT_CAP_HOURS = 12`.

- [ ] **Step 1: Write the failing test**

Create `bot/src/utils/timeTracking.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDuration, formatDuration, entryMinutes, runawayState, weekStart, rangeFor,
  sumByTask, sumByPerson, overlaps, DEFAULT_REMIND_HOURS, DEFAULT_CAP_HOURS,
} from './timeTracking.js'

test('parseDuration accepts every shape a person will type', () => {
  assert.equal(parseDuration('2h30m'), 150)
  assert.equal(parseDuration('2h 30m'), 150)
  assert.equal(parseDuration('2.5h'), 150)
  assert.equal(parseDuration('90m'), 90)
  assert.equal(parseDuration('90'), 90)
  assert.equal(parseDuration('1:30'), 90)
  assert.equal(parseDuration('  2H  '), 120)
})

test('parseDuration refuses what is not a positive duration, and has NO upper bound', () => {
  for (const bad of ['', '   ', 'soon', '0', '0m', '-5', '-2h', 'NaN', 'Infinity', '1:xx', null, undefined]) {
    assert.equal(parseDuration(bad), null, String(bad))
  }
  // Deliberate: a long entry is somebody's real week, not an error.
  assert.equal(parseDuration('200h'), 12000)
  assert.equal(parseDuration('5000m'), 5000)
})

test('formatDuration reads the way a person says it', () => {
  assert.equal(formatDuration(200), '3h 20m')
  assert.equal(formatDuration(120), '2h')
  assert.equal(formatDuration(45), '45m')
  assert.equal(formatDuration(0), '0m')
  assert.equal(formatDuration(null), '—')
  assert.equal(formatDuration(undefined), '—')
})

test('entryMinutes rounds, never goes negative, and is null while the entry is open', () => {
  const at = (s) => new Date(`2026-09-22T${s}:00.000Z`)
  assert.equal(entryMinutes(at('09:00'), at('10:30')), 90)
  assert.equal(entryMinutes(at('09:00'), null), null)
  assert.equal(entryMinutes(at('10:00'), at('09:00')), 0, 'a clock skew must not invent negative time')
  assert.equal(entryMinutes(new Date('2026-09-22T09:00:00.000Z'), new Date('2026-09-22T09:00:29.000Z')), 0)
  assert.equal(entryMinutes(new Date('2026-09-22T09:00:00.000Z'), new Date('2026-09-22T09:00:31.000Z')), 1)
})

test('runawayState escalates ok -> remind -> stop, and stop wins', () => {
  const start = new Date('2026-09-22T00:00:00.000Z')
  const after = (h) => new Date(start.getTime() + h * 3600000)
  const opts = { remindAfterMin: 360, capMin: 720 }
  const open = { clockInAt: start, clockOutAt: null, remindedAt: null }
  assert.equal(runawayState(open, after(1), opts), 'ok')
  assert.equal(runawayState(open, after(6), opts), 'remind')
  assert.equal(runawayState(open, after(13), opts), 'stop')
  assert.equal(runawayState({ ...open, remindedAt: after(6) }, after(7), opts), 'ok', 'reminded once, not every pass')
  assert.equal(runawayState({ ...open, remindedAt: after(6) }, after(13), opts), 'stop', 'the cap still applies')
  assert.equal(runawayState({ ...open, clockOutAt: after(1) }, after(13), opts), 'ok', 'a closed entry is never chased')
})

test('weeks start Monday in the guild timezone', () => {
  // A Sunday in UTC belongs to the week that began the previous Monday.
  assert.equal(weekStart(new Date('2026-09-20T12:00:00.000Z'), 'UTC').toISOString(), '2026-09-14T00:00:00.000Z')
  assert.equal(weekStart(new Date('2026-09-21T00:30:00.000Z'), 'UTC').toISOString(), '2026-09-21T00:00:00.000Z')
})

test('rangeFor covers today, week, month and all', () => {
  const now = new Date('2026-09-22T15:00:00.000Z')
  assert.equal(rangeFor('today', now, 'UTC').since.toISOString(), '2026-09-22T00:00:00.000Z')
  assert.equal(rangeFor('week', now, 'UTC').since.toISOString(), '2026-09-21T00:00:00.000Z')
  assert.equal(rangeFor('month', now, 'UTC').since.toISOString(), '2026-09-01T00:00:00.000Z')
  assert.equal(rangeFor('all', now, 'UTC').since.getTime(), 0)
  assert.equal(rangeFor('nonsense', now, 'UTC').label, rangeFor('week', now, 'UTC').label, 'unknown falls back to this week')
})

test('sums group by task and by person, ignoring entries still running', () => {
  const entries = [
    { taskId: 't1', discordId: 'u1', minutes: 60 },
    { taskId: 't1', discordId: 'u2', minutes: 30 },
    { taskId: null, discordId: 'u1', minutes: 15 },
    { taskId: 't1', discordId: 'u1', minutes: null },
  ]
  assert.equal(sumByTask(entries).get('t1'), 90)
  assert.equal(sumByTask(entries).get(null), 15)
  assert.equal(sumByPerson(entries).get('u1'), 75)
  assert.equal(sumByPerson(entries).get('u2'), 30)
})

test('overlaps reports a person double-booked, and never pairs two different people', () => {
  const e = (id, discordId, from, to) => ({ id, discordId, clockInAt: new Date(from), clockOutAt: new Date(to) })
  const a = e('a', 'u1', '2026-09-22T09:00:00Z', '2026-09-22T11:00:00Z')
  const b = e('b', 'u1', '2026-09-22T10:00:00Z', '2026-09-22T12:00:00Z')
  const c = e('c', 'u2', '2026-09-22T10:00:00Z', '2026-09-22T12:00:00Z')
  const d = e('d', 'u1', '2026-09-22T11:00:00Z', '2026-09-22T12:00:00Z')
  assert.deepEqual(overlaps([a, b, c]).map((p) => p.map((x) => x.id)), [['a', 'b']])
  assert.deepEqual(overlaps([a, d]), [], 'touching at the boundary is not an overlap')
})

test('the defaults are the documented ones', () => {
  assert.equal(DEFAULT_REMIND_HOURS, 6)
  assert.equal(DEFAULT_CAP_HOURS, 12)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/utils/timeTracking.test.js`
Expected: FAIL — cannot find module `./timeTracking.js`.

- [ ] **Step 3: Write the module**

Create `bot/src/utils/timeTracking.js`. Every function is pure.

```js
// Time tracking rules: parsing, formatting, runaway detection, week
// boundaries and aggregation. No database, no discord.js — this is the part
// that can be got wrong, so it is the part that is tested hardest.

export const DEFAULT_REMIND_HOURS = 6
export const DEFAULT_CAP_HOURS = 12

/**
 * Minutes from what a person typed: "2h30m", "2h 30m", "2.5h", "90m", "90",
 * "1:30". Null for anything that is not a positive duration. There is NO upper
 * bound by design — a long entry is somebody's real week, not a typo to refuse.
 */
export function parseDuration(text) {
  const raw = String(text ?? '').trim().toLowerCase()
  if (!raw) return null
  let minutes = null
  const clock = raw.match(/^(\d+):([0-5]\d)$/)
  const hm = raw.match(/^(\d+(?:\.\d+)?)\s*h(?:\s*(\d+)\s*m?)?$/)
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*m$/)
  const bare = raw.match(/^(\d+(?:\.\d+)?)$/)
  if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2])
  else if (hm) minutes = Number(hm[1]) * 60 + Number(hm[2] ?? 0)
  else if (m) minutes = Number(m[1])
  else if (bare) minutes = Number(bare[1])
  if (minutes === null || !Number.isFinite(minutes)) return null
  const whole = Math.round(minutes)
  return whole > 0 ? whole : null
}

/** "3h 20m", "2h", "45m", "0m"; an em dash when there is nothing to show. */
export function formatDuration(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return '—'
  const total = Math.max(0, Math.round(Number(minutes)))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

/** The duration of a closed entry. Null while it is open, never negative. */
export function entryMinutes(clockInAt, clockOutAt) {
  if (!clockOutAt) return null
  const ms = new Date(clockOutAt).getTime() - new Date(clockInAt).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.round(ms / 60000))
}

/** 'ok' | 'remind' | 'stop' for an open entry. 'stop' always wins. */
export function runawayState(entry, now, { remindAfterMin = DEFAULT_REMIND_HOURS * 60, capMin = DEFAULT_CAP_HOURS * 60 } = {}) {
  if (!entry || entry.clockOutAt) return 'ok'
  const ran = (new Date(now).getTime() - new Date(entry.clockInAt).getTime()) / 60000
  if (!Number.isFinite(ran)) return 'ok'
  if (ran >= capMin) return 'stop'
  if (ran >= remindAfterMin && !entry.remindedAt) return 'remind'
  return 'ok'
}
```

For the timezone-aware boundaries, derive the zone's offset with `Intl` rather than pulling in a library:

```js
/** The offset, in minutes, of `tz` at `date`. 0 for an unknown zone. */
function offsetMinutes(date, tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]))
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second)
    return Math.round((asUTC - date.getTime()) / 60000)
  } catch {
    return 0
  }
}

/** Midnight at the start of `date`'s day in `tz`, as a real instant. */
export function dayStart(date, tz) {
  const off = offsetMinutes(date, tz)
  const local = new Date(date.getTime() + off * 60000)
  local.setUTCHours(0, 0, 0, 0)
  return new Date(local.getTime() - off * 60000)
}

/** Midnight on the Monday that begins `date`'s week in `tz`. */
export function weekStart(date, tz) {
  const start = dayStart(date, tz)
  const off = offsetMinutes(date, tz)
  const localDow = new Date(start.getTime() + off * 60000).getUTCDay() // 0 = Sunday
  const back = (localDow + 6) % 7 // Monday = 0
  return new Date(start.getTime() - back * 86400000)
}

/** since/until/label for 'today' | 'week' | 'month' | 'all'. Unknown = week. */
export function rangeFor(keyword, now = new Date(), tz = 'UTC') {
  const key = String(keyword ?? '').trim().toLowerCase()
  const until = new Date(now.getTime() + 60000)
  if (key === 'today') return { since: dayStart(now, tz), until, label: 'today' }
  if (key === 'month') {
    const off = offsetMinutes(now, tz)
    const local = new Date(now.getTime() + off * 60000)
    local.setUTCDate(1)
    local.setUTCHours(0, 0, 0, 0)
    return { since: new Date(local.getTime() - off * 60000), until, label: 'this month' }
  }
  if (key === 'all') return { since: new Date(0), until, label: 'all time' }
  return { since: weekStart(now, tz), until, label: 'this week' }
}
```

And the aggregation:

```js
const closed = (entries) => (entries || []).filter((e) => e && e.minutes !== null && e.minutes !== undefined)

/** taskId (null for general work) -> total minutes. */
export function sumByTask(entries) {
  const out = new Map()
  for (const e of closed(entries)) {
    const key = e.taskId ?? null
    out.set(key, (out.get(key) ?? 0) + Number(e.minutes))
  }
  return out
}

/** discordId -> total minutes. */
export function sumByPerson(entries) {
  const out = new Map()
  for (const e of closed(entries)) {
    const key = String(e.discordId)
    out.set(key, (out.get(key) ?? 0) + Number(e.minutes))
  }
  return out
}

/**
 * Pairs of entries for the SAME person whose times overlap — two manual entries
 * claiming the same hour. Reported so a person can be asked, never refused:
 * the honest answer is "these two overlap, is that right?".
 */
export function overlaps(entries) {
  const byPerson = new Map()
  for (const e of entries || []) {
    if (!e?.clockOutAt) continue
    const list = byPerson.get(String(e.discordId)) ?? []
    list.push(e)
    byPerson.set(String(e.discordId), list)
  }
  const out = []
  for (const list of byPerson.values()) {
    const sorted = [...list].sort((a, b) => new Date(a.clockInAt) - new Date(b.clockInAt))
    for (let i = 0; i < sorted.length - 1; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i]
        const b = sorted[j]
        if (new Date(b.clockInAt) >= new Date(a.clockOutAt)) break
        out.push([a, b])
      }
    }
  }
  return out
}
```

- [ ] **Step 4: Run the tests**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/utils/timeTracking.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add bot/src/utils/timeTracking.js bot/src/utils/timeTracking.test.js
git commit -m "feat(time): the pure time-tracking rules"
```

---

### Task 3: `/clock-in` and `/clock-out`

**Files:**
- Create: `bot/src/utils/timeTaskPicker.js`
- Modify: `bot/src/commands/clock-in.js`, `bot/src/commands/clock-out.js`
- Test: `bot/src/commands/clock.test.js` *(new, covers both)*

**Interfaces:**
- Consumes: `entryMinutes`, `formatDuration`, `sumByTask` (Task 2); `db.clockEntry.*`, `db.projectMember.findByMember`, `db.clockEntry.sumByTask` (Task 1).
- Produces: `GENERAL = '-'` (the "no task" sentinel), `clockableTasks(tasks, { memberProjectIds, isLeadership, callerId }) -> task[]`, `execute(interaction, { db, getConfig })` and `autocomplete(interaction, { db, getConfig })` on both commands.

- [ ] **Step 1: Write the failing test**

Create `bot/src/commands/clock.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute as clockIn, GENERAL } from './clock-in.js'
import { execute as clockOut } from './clock-out.js'
import { clockableTasks } from '../utils/timeTaskPicker.js'

const HELD = { id: 'H', title: 'My feature', status: 'open', assigneeIds: ['u1'], projectId: 'p1' }
const MINE_PROJECT = { id: 'P', title: 'Teammate task', status: 'open', assigneeIds: ['u2'], projectId: 'p1' }
const FAR = { id: 'F', title: 'Another project', status: 'open', assigneeIds: ['u2'], projectId: 'p9' }

test('clockableTasks: your own tasks, plus any task in a project you belong to', () => {
  const out = clockableTasks([HELD, MINE_PROJECT, FAR], { memberProjectIds: ['p1'], isLeadership: false, callerId: 'u1' })
  assert.deepEqual(out.map((t) => t.id), ['H', 'P'])
})

test('clockableTasks: leadership can clock into anything; a member of no project only their own', () => {
  assert.deepEqual(
    clockableTasks([HELD, MINE_PROJECT, FAR], { memberProjectIds: [], isLeadership: true, callerId: 'u1' }).map((t) => t.id),
    ['H', 'P', 'F'],
  )
  assert.deepEqual(
    clockableTasks([HELD, MINE_PROJECT, FAR], { memberProjectIds: [], isLeadership: false, callerId: 'u1' }).map((t) => t.id),
    ['H'],
  )
})

function fakeDb({ entries = [], tasks = [HELD] } = {}) {
  const rows = [...entries]
  const calls = []
  return {
    rows, calls,
    clockEntry: {
      findActive: async () => rows.find((r) => !r.clockOutAt) ?? null,
      create: async ({ data }) => { const row = { id: `e${rows.length + 1}`, ...data }; rows.push(row); calls.push(['create', row]); return row },
      update: async (id, data) => { const row = rows.find((r) => r.id === id); Object.assign(row, data); calls.push(['update', id, data]); return row },
      findMany: async () => rows.filter((r) => r.minutes != null),
    },
    task: { findFirst: async ({ where }) => tasks.find((t) => t.id === where.id) ?? null, findMany: async () => tasks },
    projectMember: { findByMember: async () => [{ projectId: 'p1' }] },
  }
}

const getConfig = async () => ({ id: 'g1', clockedInRoleId: null, timezone: 'UTC' })

function fakeInteraction(opts = {}, { userId = 'u1' } = {}) {
  const replies = []
  return {
    replies,
    guild: { id: 'guild1', members: { cache: new Map(), fetch: async () => null } },
    user: { id: userId },
    member: { permissions: { has: () => true }, roles: { add: async () => {}, remove: async () => {} } },
    options: { getString: (k) => opts[k] ?? null },
    editReply: async (p) => { replies.push(p); return p },
  }
}

test('clock-in starts a timer against the chosen task', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H' })
  await clockIn(it, { db, getConfig })
  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].taskId, 'H')
  assert.equal(db.rows[0].source, 'timer')
  assert.equal(db.rows[0].clockOutAt, undefined)
  assert.match(it.replies[0].content, /My feature/)
})

test('clock-in on the SAME task changes nothing and says how long it has run', async () => {
  const started = new Date(Date.now() - 40 * 60000)
  const db = fakeDb({ entries: [{ id: 'e1', discordId: 'u1', taskId: 'H', clockInAt: started, clockOutAt: null }] })
  const it = fakeInteraction({ task: 'H' })
  await clockIn(it, { db, getConfig })
  assert.deepEqual(db.calls, [], 'no write at all')
  assert.match(it.replies[0].content, /already/i)
  assert.match(it.replies[0].content, /40m/)
})

test('clock-in on a DIFFERENT task closes the old entry and opens the new one, in one reply', async () => {
  const started = new Date(Date.now() - 70 * 60000)
  const db = fakeDb({
    entries: [{ id: 'e1', discordId: 'u1', taskId: 'P', clockInAt: started, clockOutAt: null }],
    tasks: [HELD, MINE_PROJECT],
  })
  const it = fakeInteraction({ task: 'H' })
  await clockIn(it, { db, getConfig })
  const closed = db.rows.find((r) => r.id === 'e1')
  assert.ok(closed.clockOutAt, 'the old entry is closed')
  assert.equal(closed.minutes, 70, 'and its duration is written')
  assert.equal(db.rows.length, 2)
  assert.equal(db.rows[1].taskId, 'H')
  assert.match(it.replies[0].content, /Stopped/)
  assert.match(it.replies[0].content, /started/i)
})

test('clock-in with the general sentinel logs against no task', async () => {
  const db = fakeDb()
  await clockIn(fakeInteraction({ task: GENERAL }), { db, getConfig })
  assert.equal(db.rows[0].taskId, null)
})

test('clock-in refuses a task the caller may not clock into, and writes nothing', async () => {
  const db = fakeDb({ tasks: [FAR] })
  db.projectMember.findByMember = async () => []
  const it = fakeInteraction({ task: 'F' })
  await clockIn(it, { db, getConfig })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /not available|cannot/i)
})

test('clock-out closes the entry, writes minutes and reports the task total', async () => {
  const started = new Date(Date.now() - 30 * 60000)
  const db = fakeDb({ entries: [
    { id: 'e1', discordId: 'u1', taskId: 'H', clockInAt: started, clockOutAt: null },
    { id: 'e0', discordId: 'u1', taskId: 'H', clockInAt: started, clockOutAt: started, minutes: 60 },
  ] })
  const it = fakeInteraction({ note: 'finished the parser' })
  await clockOut(it, { db, getConfig })
  const row = db.rows.find((r) => r.id === 'e1')
  assert.equal(row.minutes, 30)
  assert.equal(row.note, 'finished the parser')
  assert.match(it.replies[0].content, /30m/)
  assert.match(it.replies[0].content, /1h 30m/, 'the task total includes this session')
})

test('clock-out with no timer running refuses and writes nothing', async () => {
  const db = fakeDb()
  const it = fakeInteraction()
  await clockOut(it, { db, getConfig })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /not clocked in/i)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/commands/clock.test.js`
Expected: FAIL — `GENERAL` is not exported and `clockableTasks` does not exist.

- [ ] **Step 3: Write the picker helper**

Create `bot/src/utils/timeTaskPicker.js`:

```js
// Which tasks a person may clock into: the ones they hold, plus any task in a
// project they are a member of — so a reviewer or QA can log against the task
// they are testing, which "only your own tasks" would forbid. Leadership: any.
// Pure.
import { holdersOf } from './taskLabel.js'

export function clockableTasks(tasks, { memberProjectIds = [], isLeadership = false, callerId }) {
  const mine = new Set(memberProjectIds.map(String))
  return (tasks || []).filter((t) => {
    if (isLeadership) return true
    if (holdersOf(t).includes(String(callerId))) return true
    return Boolean(t.projectId) && mine.has(String(t.projectId))
  })
}
```

- [ ] **Step 4: Rewrite the two commands**

`bot/src/commands/clock-in.js` — the option is required and autocompleted; `GENERAL` is the "no task" sentinel; a same-task re-entry writes nothing; a different task switches in one reply. Build the shared close helper here and import it in `clock-out.js`:

```js
import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig, ensureStringArray } from '../db/index.js'
import { memberPassesRoleGate, LEADERSHIP_ROLE_NAMES } from '../utils/roleGate.js'
import { clockableTasks } from '../utils/timeTaskPicker.js'
import { taskChoiceLabel } from '../utils/taskLabel.js'
import { entryMinutes, formatDuration } from '../utils/timeTracking.js'

export const GENERAL = '-'

export const data = new SlashCommandBuilder()
  .setName('clock-in')
  .setDescription('Start tracking your time against a task')
  .addStringOption((o) =>
    o.setName('task').setDescription('The task you are working on').setRequired(true).setAutocomplete(true))

/** Close an open entry, writing its duration. Shared with /clock-out. */
export async function closeEntry(dbArg, entry, { at = new Date(), note = null, source } = {}) {
  const minutes = entryMinutes(entry.clockInAt, at)
  const data = { clockOutAt: at, minutes }
  if (note) data.note = note
  if (source) data.source = source
  await dbArg.clockEntry.update(entry.id, data)
  return minutes
}
```

`execute` then: load the config; find the active entry; resolve the chosen task (unless `GENERAL`); refuse a task not in `clockableTasks`; if the active entry is on the same task reply with its running time and write nothing; otherwise close it, create the new entry, add `clockedInRoleId` and reply with either "Clocked in" or "Stopped X (1h 10m) · started Y".

`autocomplete` lists `{ name: 'No task — general work', value: GENERAL }` first, then `clockableTasks(...)` mapped through `taskChoiceLabel`, sliced to 25.

`bot/src/commands/clock-out.js` keeps its shape but adds an optional `note` string option, calls `closeEntry`, removes the role, and replies with the session length and the task's new total from `db.clockEntry.findMany({ where: { guildConfigId, taskId } })` summed with `sumByTask`.

- [ ] **Step 5: Run the tests**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access npm test`
Expected: PASS — the eight new tests and the whole existing suite.

- [ ] **Step 6: Commit**

```bash
git add bot/src/commands/clock-in.js bot/src/commands/clock-out.js bot/src/utils/timeTaskPicker.js bot/src/commands/clock.test.js
git commit -m "feat(time): clock in and out against a task"
```

---

### Task 4: `/log-time`

**Files:**
- Create: `bot/src/commands/log-time.js`
- Modify: `bot/src/commands/index.js` (import + register), `bot/src/config/command-config.json`
- Test: `bot/src/commands/log-time.test.js`

**Interfaces:**
- Consumes: `parseDuration`, `formatDuration`, `dayStart` (Task 2); `clockableTasks` (Task 3); `GENERAL` (Task 3).
- Produces: `execute(interaction, { db, getConfig })`, `autocomplete(...)`, and `entryWindow(duration, when, now) -> { clockInAt, clockOutAt }`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execute, entryWindow } from './log-time.js'

test('entryWindow ends at the given day and runs backwards by the duration', () => {
  const now = new Date('2026-09-22T15:00:00.000Z')
  const today = entryWindow(90, 'today', now)
  assert.equal(today.clockOutAt.toISOString(), '2026-09-22T15:00:00.000Z')
  assert.equal(today.clockInAt.toISOString(), '2026-09-22T13:30:00.000Z')
  const yest = entryWindow(60, 'yesterday', now)
  assert.equal(yest.clockOutAt.toISOString(), '2026-09-21T15:00:00.000Z')
  const dated = entryWindow(60, '2026-09-10', now)
  assert.equal(dated.clockOutAt.toISOString(), '2026-09-10T15:00:00.000Z')
})

test('a long entry is accepted — there is no maximum', async () => {
  const db = fakeDb()
  await execute(fakeInteraction({ task: 'H', duration: '200h' }), { db, getConfig })
  assert.equal(db.rows[0].minutes, 12000)
  assert.equal(db.rows[0].source, 'manual')
})

test('an unparseable duration writes nothing and says what is accepted', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H', duration: 'ages' })
  await execute(it, { db, getConfig })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /2h30m/)
})

test('an unknown date writes nothing', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ task: 'H', duration: '1h', when: 'last tuesday' })
  await execute(it, { db, getConfig })
  assert.deepEqual(db.calls, [])
  assert.match(it.replies[0].content, /YYYY-MM-DD/)
})
```

Reuse the `fakeDb`, `fakeInteraction` and `getConfig` helpers from `clock.test.js` by copying them into this file (each test file in this repo is self-contained).

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/commands/log-time.test.js`
Expected: FAIL — cannot find module `./log-time.js`.

- [ ] **Step 3: Write the command**

Options: `task` (required, autocompleted, same picker as `/clock-in`), `duration` (required string), `when` (optional string), `note` (optional string, max 500).

```js
/** The window a retroactive entry occupies: it ends at `when` at the current
 *  time of day and runs backwards by the duration. Returns null for a date we
 *  cannot read, so the caller can refuse rather than invent a day. */
export function entryWindow(minutes, when, now = new Date()) {
  const key = String(when ?? 'today').trim().toLowerCase()
  let end
  if (!key || key === 'today') end = new Date(now)
  else if (key === 'yesterday') end = new Date(now.getTime() - 86400000)
  else if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const [y, m, d] = key.split('-').map(Number)
    const at = new Date(now)
    at.setUTCFullYear(y, m - 1, d)
    if (Number.isNaN(at.getTime())) return null
    end = at
  } else return null
  return { clockInAt: new Date(end.getTime() - minutes * 60000), clockOutAt: end }
}
```

`execute` parses the duration (refusing with "Try 2h30m, 90m, 2.5h or 1:30" on null), builds the window (refusing with "Use today, yesterday or YYYY-MM-DD"), checks `clockableTasks`, writes the row with `source: 'manual'` and `minutes`, and replies with the entry and the task's new total.

Register in `bot/src/commands/index.js` (`import * as logTimeCmd from './log-time.js'` beside the clock imports, and `logTimeCmd,` in the exported list) and add a `command-config.json` entry.

- [ ] **Step 4: Run the tests**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot/src/commands/log-time.js bot/src/commands/log-time.test.js bot/src/commands/index.js bot/src/config/command-config.json
git commit -m "feat(time): /log-time for retroactive entries"
```

---

### Task 5: `/my-time`

**Files:**
- Create: `bot/src/commands/my-time.js`, `bot/src/services/timePanel.js`
- Modify: `bot/src/commands/index.js`, `bot/src/handlers/interactions.js`, `bot/src/config/command-config.json`
- Test: `bot/src/services/timePanel.test.js`

**Interfaces:**
- Consumes: `rangeFor`, `formatDuration`, `sumByTask`, `overlaps` (Task 2).
- Produces: `buildMyTimePayload({ entries, tasks, running, range, nameFor }) -> { embeds, components }`, `handleTimeComponent(interaction, deps)`, `handleTimeEditSubmit(interaction, deps)`; custom ids `mt_<action>:<entryId>`, modal `mt_edit:<entryId>`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMyTimePayload, handleTimeComponent } from './timePanel.js'

const entries = [
  { id: 'e1', taskId: 'H', discordId: 'u1', minutes: 90, clockInAt: new Date('2026-09-22T09:00:00Z'), clockOutAt: new Date('2026-09-22T10:30:00Z'), source: 'timer' },
  { id: 'e2', taskId: null, discordId: 'u1', minutes: 30, clockInAt: new Date('2026-09-22T11:00:00Z'), clockOutAt: new Date('2026-09-22T11:30:00Z'), source: 'manual' },
  { id: 'e3', taskId: 'H', discordId: 'u1', minutes: 60, clockInAt: new Date('2026-09-21T09:00:00Z'), clockOutAt: new Date('2026-09-21T10:00:00Z'), source: 'auto_stopped' },
]
const tasks = [{ id: 'H', title: 'My feature' }]
const json = (p) => p.components.map((r) => r.toJSON())

test('the panel totals by task, names general work, and marks an auto-stopped entry', () => {
  const p = buildMyTimePayload({ entries, tasks, running: null, range: { label: 'this week' } })
  const text = JSON.stringify(p.embeds[0].toJSON())
  assert.match(text, /2h 30m/, 'the task total')
  assert.match(text, /General/)
  assert.match(text, /auto-stopped/i)
})

test('a running timer leads the panel', () => {
  const running = { id: 'e9', taskId: 'H', clockInAt: new Date(Date.now() - 20 * 60000) }
  const p = buildMyTimePayload({ entries, tasks, running, range: { label: 'this week' } })
  assert.match(JSON.stringify(p.embeds[0].toJSON()), /Running now/)
})

test('every entry can be picked for editing, within Discord limits', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ ...entries[0], id: `x${i}` }))
  const p = buildMyTimePayload({ entries: many, tasks, running: null, range: { label: 'this week' } })
  for (const row of json(p)) for (const c of row.components) {
    if (c.options) assert.ok(c.options.length <= 25)
    assert.ok(c.custom_id.length <= 100)
  }
  assert.ok(json(p).length <= 5)
})

test('deleting an entry removes it and only if it is yours', async () => {
  const removed = []
  const db = {
    clockEntry: {
      findById: async (id) => (id === 'e1' ? { id: 'e1', discordId: 'u1' } : { id, discordId: 'someone-else' }),
      remove: async (id) => { removed.push(id) },
      findMany: async () => [], findActive: async () => null,
    },
    task: { findMany: async () => tasks },
  }
  const mine = fakeComponent('mt_delete:e1', 'u1')
  await handleTimeComponent(mine, { db, getConfig })
  assert.deepEqual(removed, ['e1'])

  const theirs = fakeComponent('mt_delete:e5', 'u1')
  await handleTimeComponent(theirs, { db, getConfig })
  assert.deepEqual(removed, ['e1'], 'somebody else\'s entry is untouched')
})
```

Define `fakeComponent(customId, userId)` in the file, returning `{ customId, user: { id: userId }, member, guild, deferred: true, editReply, update, showModal }` in the shape used by `taskHub.test.js`.

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/services/timePanel.test.js`
Expected: FAIL — cannot find module `./timePanel.js`.

- [ ] **Step 3: Write the panel and the command**

`services/timePanel.js` follows `services/taskHub.js` exactly: an embed listing the running timer, the per-task totals and the recent entries; a select of entries to act on; Edit (modal: duration, when, note) and Delete buttons; state in the custom id. An entry is loaded by id and refused unless `entry.discordId === interaction.user.id` or the caller is leadership. `db.clockEntry.remove(id)` is a new one-line finder — add it in this task beside the others:

```js
async function clockEntryRemove(entryId) {
  await query("DELETE FROM `clockentry` WHERE id = ?", [entryId]);
  return { removed: 1 };
}
```

`commands/my-time.js` reads the range (`today`/`week`/`month`/`all`, default `week`), pulls the caller's entries and renders the panel. Route `mt_` in `handlers/interactions.js` beside `uth_`/`utf_`, and add `mt_edit:` to the modal routes and to the no-defer lists in `bot/src/index.js` (the Edit button opens a modal, so it must skip the automatic `deferUpdate`, exactly like `uth_basics`).

- [ ] **Step 4: Run the tests**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot/src/commands/my-time.js bot/src/services/timePanel.js bot/src/services/timePanel.test.js bot/src/commands/index.js bot/src/handlers/interactions.js bot/src/index.js bot/src/config/command-config.json bot/src/Database/index.js
git commit -m "feat(time): /my-time with entry edit and delete"
```

---

### Task 6: `/time-report`

**Files:**
- Create: `bot/src/commands/time-report.js`
- Modify: `bot/src/commands/index.js`, `bot/src/config/command-config.json`
- Test: `bot/src/commands/time-report.test.js`

**Interfaces:**
- Consumes: `rangeFor`, `formatDuration`, `sumByTask`, `sumByPerson` (Task 2); the leadership gate.
- Produces: `execute(interaction, { db, getConfig })`, `buildReportPayload({ entries, tasks, projects, filters, nameFor }) -> { embeds }`.

- [ ] **Step 1: Write the failing test**

```js
test('a non-leadership caller is refused and no data is read', async () => {
  let read = 0
  const db = { clockEntry: { findMany: async () => { read += 1; return [] } }, task: { findMany: async () => [] }, project: { findMany: async () => [] } }
  const it = fakeInteraction({}, { member: plainMember() })
  await execute(it, { db, getConfig })
  assert.match(it.replies[0].content, /only|not allowed/i)
  assert.equal(read, 0)
})

test('leadership gets totals per person and per task, with estimate comparison', () => {
  const p = buildReportPayload({
    entries: [
      { taskId: 'H', discordId: 'u1', minutes: 300 },
      { taskId: 'H', discordId: 'u2', minutes: 120 },
    ],
    tasks: [{ id: 'H', title: 'My feature', estimateMinutes: 480 }],
    projects: [], filters: { label: 'this week' }, nameFor: (id) => ({ u1: 'Ana', u2: 'Ben' })[id],
  })
  const text = JSON.stringify(p.embeds[0].toJSON())
  assert.match(text, /Ana/)
  assert.match(text, /5h/)
  assert.match(text, /7h of 8h|7h \/ 8h/)
})

test('a task that is over its estimate is flagged', () => {
  const p = buildReportPayload({
    entries: [{ taskId: 'H', discordId: 'u1', minutes: 600 }],
    tasks: [{ id: 'H', title: 'My feature', estimateMinutes: 480 }],
    projects: [], filters: { label: 'this week' }, nameFor: () => 'Ana',
  })
  assert.match(JSON.stringify(p.embeds[0].toJSON()), /over/i)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/commands/time-report.test.js`
Expected: FAIL — cannot find module `./time-report.js`.

- [ ] **Step 3: Write the command**

Options: `person` (User), `project` (String, autocompleted with `projectChoices(..., { withDetach: false })`), `task` (String, autocompleted), `range` (String choices: today/week/month/all). Gate on `memberPassesRoleGate` **before any database read**, so a refused caller cannot cause a query. Render one embed: totals per person, then per project, then the top tasks with `logged of estimate` and an "over" flag where `logged > estimate`. Field values clipped to 1024, the list to the top 10 with "…and N more".

- [ ] **Step 4: Run the tests**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot/src/commands/time-report.js bot/src/commands/time-report.test.js bot/src/commands/index.js bot/src/config/command-config.json
git commit -m "feat(time): /time-report for leadership"
```

---

### Task 7: The forgotten-timer watcher

**Files:**
- Create: `bot/src/services/clockWatch.js`
- Modify: `bot/src/index.js` (import and `startClockWatch(client)` beside `startMemberNameSync(client)`), `bot/src/handlers/interactions.js` (`clk_` buttons)
- Test: `bot/src/services/clockWatch.test.js`

**Interfaces:**
- Consumes: `runawayState`, `entryMinutes`, `formatDuration`, `DEFAULT_REMIND_HOURS`, `DEFAULT_CAP_HOURS` (Task 2); `db.clockEntry.findOpen/update` (Task 1).
- Produces: `startClockWatch(client, { db, intervalMs })`, `runClockWatchPass(client, { db, now })`, `handleClockButton(interaction, { db })`; buttons `clk_keep:<id>` and `clk_stop:<id>`.

- [ ] **Step 1: Write the failing test**

```js
test('an entry past the reminder hour is DM\'d once, with both buttons', async () => {
  const start = new Date('2026-09-22T00:00:00Z')
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', taskId: 'H', clockInAt: start, clockOutAt: null, remindedAt: null }])
  const sent = []
  const client = fakeClient(sent)
  await runClockWatchPass(client, { db, now: new Date('2026-09-22T07:00:00Z') })
  assert.equal(sent.length, 1)
  const ids = sent[0].components[0].toJSON().components.map((c) => c.custom_id)
  assert.deepEqual(ids, ['clk_keep:e1', 'clk_stop:e1'])
  assert.ok(db.rows[0].remindedAt, 'remindedAt is stamped so it is not sent again')

  await runClockWatchPass(client, { db, now: new Date('2026-09-22T08:00:00Z') })
  assert.equal(sent.length, 1, 'not reminded twice')
})

test('an entry past the cap is closed AT the cap and marked auto_stopped', async () => {
  const start = new Date('2026-09-22T00:00:00Z')
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: start, clockOutAt: null, remindedAt: null }])
  await runClockWatchPass(fakeClient([]), { db, now: new Date('2026-09-22T20:00:00Z') })
  const row = db.rows[0]
  assert.equal(new Date(row.clockOutAt).toISOString(), '2026-09-22T12:00:00.000Z', 'closed at the cap, not at now')
  assert.equal(row.minutes, 720)
  assert.equal(row.source, 'auto_stopped')
})

test('the guild config can override the hours', async () => {
  const start = new Date('2026-09-22T00:00:00Z')
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: start, clockOutAt: null }], { clockCapHours: 2 })
  await runClockWatchPass(fakeClient([]), { db, now: new Date('2026-09-22T03:00:00Z') })
  assert.equal(db.rows[0].source, 'auto_stopped')
})

test('one failing DM never stops the rest of the pass', async () => {
  const start = new Date('2026-09-22T00:00:00Z')
  const db = fakeWatchDb([
    { id: 'e1', discordId: 'bad', clockInAt: start, clockOutAt: null },
    { id: 'e2', discordId: 'u2', clockInAt: start, clockOutAt: null },
  ])
  const client = { users: { fetch: async (id) => (id === 'bad' ? Promise.reject(new Error('cannot DM')) : { send: async () => {} }) } }
  const orig = console.error; console.error = () => {}
  try {
    await runClockWatchPass(client, { db, now: new Date('2026-09-22T20:00:00Z') })
  } finally { console.error = orig }
  assert.equal(db.rows[0].source, 'auto_stopped', 'still closed even though the DM failed')
  assert.equal(db.rows[1].source, 'auto_stopped')
})

test('Stop now closes the entry; Keep going leaves it alone', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: new Date(Date.now() - 3600000), clockOutAt: null }])
  await handleClockButton(fakeButton('clk_stop:e1', 'u1'), { db })
  assert.ok(db.rows[0].clockOutAt)
  const db2 = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: new Date(), clockOutAt: null }])
  await handleClockButton(fakeButton('clk_keep:e1', 'u1'), { db: db2 })
  assert.equal(db2.rows[0].clockOutAt, null)
})

test('a button pressed by somebody else does nothing', async () => {
  const db = fakeWatchDb([{ id: 'e1', discordId: 'u1', clockInAt: new Date(), clockOutAt: null }])
  await handleClockButton(fakeButton('clk_stop:e1', 'someone-else'), { db })
  assert.equal(db.rows[0].clockOutAt, null)
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/services/clockWatch.test.js`
Expected: FAIL — cannot find module `./clockWatch.js`.

- [ ] **Step 3: Write the watcher**

Model it on `services/memberNameSync.js`: `startClockWatch(client, { db: dbArg = db, intervalMs = 5 * 60 * 1000 } = {})` runs one pass immediately then on `setInterval`, each pass wrapped so a failure is logged and swallowed. `runClockWatchPass` reads `db.clockEntry.findOpen()`, groups by `guildConfigId` to read each guild's config once, and for each entry switches on `runawayState`. A `stop` closes at `clockInAt + capMin` — **not at `now`**, so a watcher that was down for a day does not log a day. Then DM, `.catch()`ing each one separately.

- [ ] **Step 4: Run the tests**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/clockWatch.js bot/src/services/clockWatch.test.js bot/src/index.js bot/src/handlers/interactions.js
git commit -m "feat(time): remind at 6h and cap a runaway timer at 12h"
```

---

### Task 8: Estimates and time on the task hub

**Files:**
- Modify: `bot/src/services/taskHub.js` (the counts modal ~line 280, `buildHubPayload` ~line 113, the button label ~line 177), `bot/src/config/command-config.json`
- Modify: `bot/src/services/taskHub.test.js`
- Modify: `.claude/knowledge/project-tasks-site.md`

**Interfaces:**
- Consumes: `formatDuration`, `parseDuration` (Task 2); `db.clockEntry.sumByTask` (Task 1).
- Produces: `estimateFromModal(task, values) -> { updates, error }`; the hub embed's `Time` field.

**Note:** there is no room for a `Time` button — see "Deviation from the spec" at the top. The estimate goes in the counts modal and the totals go on the embed.

- [ ] **Step 1: Write the failing test**

```js
test('the counts modal carries the estimate as a fourth field, prefilled', () => {
  const m = buildCountsModal({ ...HELD, estimateMinutes: 480 }).toJSON()
  const ids = m.components.map((c) => c.component.custom_id)
  assert.deepEqual(ids, ['api', 'qa', 'ac', 'estimate'])
  assert.equal(m.components[3].component.value, '8h')
})

test('the estimate accepts a duration and clears on an empty field', () => {
  assert.deepEqual(countsFromModal({ ...HELD, estimateMinutes: null }, { api: '', qa: '', ac: '', estimate: '8h' }).updates, { estimateMinutes: 480 })
  assert.deepEqual(countsFromModal({ ...HELD, estimateMinutes: 480 }, { api: '', qa: '', ac: '', estimate: '' }).updates, { estimateMinutes: null })
  assert.deepEqual(countsFromModal({ ...HELD, estimateMinutes: 480 }, { api: '', qa: '', ac: '', estimate: '8h' }).updates, {}, 'unchanged writes nothing')
})

test('an unreadable estimate saves nothing and says so', () => {
  const out = countsFromModal(HELD, { api: '', qa: '', ac: '', estimate: 'ages' })
  assert.deepEqual(out.updates, {})
  assert.match(out.error, /2h30m|duration/i)
})

test('the hub shows logged time against the estimate', () => {
  const p = buildHubPayload({ ...baseHub, task: { ...HELD, estimateMinutes: 480 }, timeLogged: 200 })
  const field = p.embeds[0].toJSON().fields.find((f) => f.name === 'Time')
  assert.equal(field.value, '3h 20m of 8h')
  const none = buildHubPayload({ ...baseHub, timeLogged: 0 })
  assert.equal(none.embeds[0].toJSON().fields.find((f) => f.name === 'Time').value, 'Nothing logged')
})
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access node --test src/services/taskHub.test.js`
Expected: FAIL — the modal has three fields, not four.

- [ ] **Step 3: Implement**

In `buildCountsModal`, add a fourth field whose value is `formatDuration(task.estimateMinutes)` when set. In `countsFromModal`, parse `estimate` with `parseDuration`: a blank field clears the estimate to `null`, an unparseable one returns the shared error, an unchanged one writes nothing. Relabel the button to `Counts & estimate`. In `buildHubPayload`, add a `Time` field reading `formatDuration(timeLogged)` plus ` of ${formatDuration(task.estimateMinutes)}` when an estimate is set, `Nothing logged` when zero. `loadHub` gains the sum through `db.clockEntry.sumByTask({ guildConfigId: cfg.id, taskIds: [task.id] })`, `.catch(() => [])` so a missing column never breaks the hub.

Update `.claude/knowledge/project-tasks-site.md` with a "Task time tracking" section: the table shape, why `minutes` is stored as well as the timestamps, the five-button ceiling that forced the estimate into the counts modal, and the fact that `clockentry` had a `ClockEntry` casing bug fixed in Task 1.

- [ ] **Step 4: Run the tests**

Run: `cd bot && DATABASE_URL=poisoned://no-production-access npm test`
Expected: PASS, the whole bot suite.

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/taskHub.js bot/src/services/taskHub.test.js bot/src/config/command-config.json .claude/knowledge/project-tasks-site.md
git commit -m "feat(time): estimates in the counts modal, logged time on the hub"
```

---

### Task 9: CSAAS — time on the tasks read

**Files:**
- Modify: `CSAAS_Backend/Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js`
- Test: `CSAAS_Backend/Services/SysScripts/TestScripts/discord-tasks-test/time.test.js` *(new)*

**Interfaces:**
- Consumes: the `clockentry` columns from Task 1.
- Produces: on every task — `timeLogged: number`, `estimateMinutes: number|null`, `timeByPerson: [{ discordId, name, username?, avatarUrl?, minutes }]`.

- [ ] **Step 1: Write the failing test**

```js
const { assembleTasks, getDiscordTasks, __setTestHooks } = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks");

function run() {
  const time = [
    { taskId: "A", discordId: "u1", minutes: 120 },
    { taskId: "A", discordId: "u2", minutes: 45 },
  ];
  const out = byId(assembleTasks({ guilds, projects, tasks: [t({ id: "A", estimateMinutes: 480 })], names, time }));
  assert.strictEqual(out.A.timeLogged, 165);
  assert.strictEqual(out.A.estimateMinutes, 480);
  assert.deepStrictEqual(out.A.timeByPerson.map((p) => [p.name, p.minutes]), [["Ana", 120], ["Ben", 45]]);
  // Biggest contributor first, so the list reads usefully when it is clipped.
  assert.ok(out.A.timeByPerson[0].minutes >= out.A.timeByPerson[1].minutes);

  const none = byId(assembleTasks({ guilds, projects, tasks: [t({ id: "B" })], names, time: [] }));
  assert.strictEqual(none.B.timeLogged, 0);
  assert.deepStrictEqual(none.B.timeByPerson, []);
  assert.strictEqual(none.B.estimateMinutes, null);
}

// The read still answers when clockentry has no `minutes` column yet.
async function fallback() {
  const seen = [];
  __setTestHooks({ executeQuery: async (sql) => {
    if (sql.includes("FROM granjur.guildconfig")) return [{ id: "g1", guildId: "1000" }];
    if (sql.includes("FROM granjur.clockentry")) { seen.push("time"); throw new Error("Unknown column 'minutes' in 'field list'"); }
    if (sql.includes("FROM granjur.task ")) return [t({ id: "A" })];
    if (sql.includes("FROM granjur.project ")) return projects;
    if (sql.includes("FROM granjur.guildmember")) return names;
    return [];
  }});
  const out = await getDiscordTasks({ query: {} });
  assert.deepStrictEqual(seen, ["time"]);
  assert.strictEqual(out.projects[0].tasks[0].timeLogged, 0, "no time rather than no page");
}
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd "CSAAS_Backend/Services/SysScripts/TestScripts/discord-tasks-test" && node time.test.js`
Expected: FAIL — `timeLogged` is undefined.

- [ ] **Step 3: Implement**

Add a seventh query to the `Promise.all`, with the established fallback:

```js
    q(`SELECT taskId, discordId, SUM(minutes) AS minutes
       FROM granjur.clockentry
       WHERE guildConfigId IN (${ph}) AND taskId IS NOT NULL AND minutes IS NOT NULL
       GROUP BY taskId, discordId`, cfgIds).catch(() => []),
```

Add `estimateMinutes` to the task select (inside the existing try/fallback pair, so an old schema still loads). In `assembleTasks`, build `timeByTask: Map<taskId, rows>` before `shapeTask`, and in `shapeTask` add:

```js
      timeLogged: (timeByTask.get(t.id) || []).reduce((n, r) => n + Number(r.minutes || 0), 0),
      estimateMinutes: t.estimateMinutes ?? null,
      timeByPerson: (timeByTask.get(t.id) || [])
        .map((r) => ({ ...personOf(t.guildConfigId, r.discordId), minutes: Number(r.minutes || 0) }))
        .sort((a, b) => b.minutes - a.minutes),
```

- [ ] **Step 4: Run every test in the folder**

Run: `cd "CSAAS_Backend/Services/SysScripts/TestScripts/discord-tasks-test" && for f in time hierarchy activity assemble avatarFallback status; do node $f.test.js; done`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js Services/SysScripts/TestScripts/discord-tasks-test/time.test.js
git commit -m "feat(discord): time logged and estimate on each task"
```

---

### Task 10: CSAAS — the time report endpoint

**Files:**
- Create: `CSAAS_Backend/Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeReport.js`
- Test: append to `discord-tasks-test/time.test.js`

**Interfaces:**
- Consumes: the `clockentry` columns.
- Produces: `global.DiscordTimeReport_object`, `getTimeReport(req, decryptedPayload)` returning `{ since, until, people: [{ discordId, name, avatarUrl?, minutes }], projects: [{ id, name, minutes }], scope: 'self' | 'all' }`.

- [ ] **Step 1: Write the failing test**

Append to `discord-tasks-test/time.test.js`, in the hand-rolled style of `status.test.js`:

```js
const { getTimeReport, __setTestHooks: setReportHooks } = require(
  "../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeReport"
);

/** Captures every SQL call so the self-scope filter can be asserted in the QUERY. */
function reportHooks({ allowed, rows = [] }) {
  const calls = [];
  setReportHooks({
    requirePortalPermission: async (_req, _p, permission) => {
      if (permission === "view_discord_time" && !allowed) throw { statusCode: 403, message: "denied" };
      return { urddId: 7 };
    },
    executeQuery: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("FROM granjur.guildmember")) return [{ discordId: "u1", guildConfigId: "g1" }];
      if (sql.includes("FROM granjur.clockentry")) return rows;
      if (sql.includes("FROM granjur.project")) return [{ id: "p1", name: "Framework" }];
      return [];
    },
    env: () => ({}),
  });
  return calls;
}
const payload = (over = {}) => ({ __identityVerified: true, actor_email: "ana@granjur.com", ...over });

async function report() {
  // Without the permission: one person, and the narrowing happens in SQL — a
  // filter applied after the query would have shipped everyone's hours already.
  let calls = reportHooks({ allowed: false, rows: [{ discordId: "u1", projectId: "p1", minutes: 120 }] });
  let out = await getTimeReport({}, payload());
  assert.strictEqual(out.scope, "self");
  assert.deepStrictEqual(out.people.map((p) => p.discordId), ["u1"]);
  const timeCall = calls.find((c) => c.sql.includes("FROM granjur.clockentry"));
  assert.ok(/AND\s+discordId\s*=\s*\?/.test(timeCall.sql), "self scope must filter in SQL");
  assert.ok(timeCall.params.includes("u1"));

  // With the permission: everybody, and no discordId filter.
  calls = reportHooks({ allowed: true, rows: [
    { discordId: "u1", projectId: "p1", minutes: 120 },
    { discordId: "u2", projectId: "p1", minutes: 45 },
  ] });
  out = await getTimeReport({}, payload());
  assert.strictEqual(out.scope, "all");
  assert.deepStrictEqual(out.people.map((p) => p.minutes), [120, 45]);
  assert.deepStrictEqual(out.projects.map((p) => [p.name, p.minutes]), [["Framework", 165]]);
  assert.ok(!/AND\s+discordId\s*=\s*\?/.test(calls.find((c) => c.sql.includes("clockentry")).sql));

  // An explicit range is passed through; a missing one defaults to this week.
  calls = reportHooks({ allowed: true });
  out = await getTimeReport({}, payload({ since: "2026-09-01T00:00:00.000Z", until: "2026-09-08T00:00:00.000Z" }));
  assert.strictEqual(out.since, "2026-09-01T00:00:00.000Z");
  calls = reportHooks({ allowed: true });
  out = await getTimeReport({}, payload());
  assert.ok(out.since, "a default range is always returned");
  assert.ok(new Date(out.until) > new Date(out.since));
}
```

Call `report()` from the file's promise chain alongside `fallback()`.

- [ ] **Step 2: Run and watch it fail**

Run: `cd "CSAAS_Backend/Services/SysScripts/TestScripts/discord-tasks-test" && node time.test.js`
Expected: FAIL — cannot find module `discordTimeReport`.

- [ ] **Step 3: Implement**

Copy the object shape from `discordTasksStatus.js`: `accessToken: true`, `permission: null` with the check in the handler, `bindActorToToken: true`. The handler resolves the caller's Discord id from their verified email through `granjur.guildmember`, then:

- tries `requirePortalPermission(req, payload, "view_discord_time")`; on success `scope = 'all'`, on a 403 `scope = 'self'` and the query is constrained by `AND discordId = ?`.
- returns per-person and per-project totals for the range.

**The self path must filter in SQL, not in JavaScript** — a filter applied after the query would ship everyone's hours to the browser.

- [ ] **Step 4: Run the tests**

Run: `cd "CSAAS_Backend/Services/SysScripts/TestScripts/discord-tasks-test" && node time.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeReport.js Services/SysScripts/TestScripts/discord-tasks-test/time.test.js
git commit -m "feat(discord): time report endpoint for the Team Time tab"
```

---

### Task 11: UBS-Doc — types and the pure time logic

**Files:**
- Modify: `UBS-Doc/src/screens/tasksLogic.ts`
- Create: `UBS-Doc/src/screens/team/timeLogic.ts`, `UBS-Doc/src/screens/team/timeLogic.test.ts`

**Interfaces:**
- Produces: `TaskTime = { discordId: string; name: string; avatarUrl?: string; minutes: number }`; optional `timeLogged?: number`, `estimateMinutes?: number | null`, `timeByPerson?: TaskTime[]` on `TaskRow`; `formatDuration(minutes)`, `estimatePercent(logged, estimate)`, `isOverEstimate(logged, estimate)`, `weekRange(date)`, `shiftWeek(range, n)`, `topContributors(list, max)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { formatDuration, estimatePercent, isOverEstimate, weekRange, shiftWeek, topContributors } from './timeLogic'

describe('formatDuration', () => {
  it('matches what the bot prints', () => {
    expect(formatDuration(200)).toBe('3h 20m')
    expect(formatDuration(120)).toBe('2h')
    expect(formatDuration(45)).toBe('45m')
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(undefined)).toBeNull()
    expect(formatDuration(null)).toBeNull()
  })
})

describe('estimates', () => {
  it('is a percentage, capped at 100 for the bar but honest about being over', () => {
    expect(estimatePercent(240, 480)).toBe(50)
    expect(estimatePercent(600, 480)).toBe(100)
    expect(isOverEstimate(600, 480)).toBe(true)
    expect(isOverEstimate(240, 480)).toBe(false)
    expect(estimatePercent(240, null)).toBeNull()
    expect(estimatePercent(240, 0)).toBeNull()
  })
})

describe('weeks', () => {
  it('runs Monday to Sunday and steps cleanly', () => {
    const r = weekRange(new Date('2026-09-23T12:00:00Z'))
    expect(r.since.toISOString()).toBe('2026-09-21T00:00:00.000Z')
    expect(shiftWeek(r, -1).since.toISOString()).toBe('2026-09-14T00:00:00.000Z')
    expect(shiftWeek(r, 1).since.toISOString()).toBe('2026-09-28T00:00:00.000Z')
  })
})

describe('topContributors', () => {
  it('keeps the biggest and rolls the rest into one "others" row', () => {
    const list = [
      { discordId: 'a', name: 'Ana', minutes: 300 },
      { discordId: 'b', name: 'Ben', minutes: 120 },
      { discordId: 'c', name: 'Cy', minutes: 60 },
      { discordId: 'd', name: 'Di', minutes: 30 },
    ]
    const out = topContributors(list, 2)
    expect(out.map((x) => x.name)).toEqual(['Ana', 'Ben', '2 others'])
    expect(out[2].minutes).toBe(90)
    expect(topContributors(list, 10).length).toBe(4)
    expect(topContributors([], 3)).toEqual([])
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd UBS-Doc && npx vitest run src/screens/team/timeLogic.test.ts`
Expected: FAIL — cannot resolve `./timeLogic`.

- [ ] **Step 3: Implement**

Write `timeLogic.ts` with those six functions, `formatDuration` returning `null` (not an em dash) so callers decide what to render. Add the three optional fields and `TaskTime` to `tasksLogic.ts`.

- [ ] **Step 4: Run the tests**

Run: `cd UBS-Doc && npx vitest run src/screens && npx tsc --noEmit -p .`
Expected: PASS and no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/screens/tasksLogic.ts src/screens/team/timeLogic.ts src/screens/team/timeLogic.test.ts
git commit -m "feat(team): time types and pure time logic"
```

---

### Task 12: UBS-Doc — time on the task, the list and the board

**Files:**
- Create: `UBS-Doc/src/screens/team/TimeSection.tsx`
- Modify: `UBS-Doc/src/screens/team/TaskDetail.tsx`, `TasksList.tsx`, `Board.tsx`, `TaskPreview.tsx`

**Interfaces:**
- Consumes: `formatDuration`, `estimatePercent`, `isOverEstimate`, `topContributors` (Task 11); `Avatar` (existing).
- Produces: `<TimeSection task theme />`.

- [ ] **Step 1: Write the failing test**

Extend `timeLogic.test.ts` with the one pure decision this UI makes:

```ts
describe('the time chip', () => {
  it('is the logged total, and nothing at all when no time is logged', () => {
    expect(timeChip({ timeLogged: 200 })).toBe('3h 20m')
    expect(timeChip({ timeLogged: 0 })).toBeNull()
    expect(timeChip({})).toBeNull()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd UBS-Doc && npx vitest run src/screens/team/timeLogic.test.ts`
Expected: FAIL — `timeChip` is not exported.

- [ ] **Step 3: Implement**

Add `timeChip(task)` to `timeLogic.ts`. Write `TimeSection.tsx`: the total, an estimate bar (indigo under the estimate, red over it, with "3h 20m of 8h · 41%"), and a row per person with `<Avatar>` and their total through `topContributors(list, 5)`. Render it in `TaskDetail.tsx` as a `<Field label="Time">` after the Subtasks field, only when `timeLogged` or `estimateMinutes` is set. Add a `<Clock size={12}/> {timeChip(t)}` chip beside the scope chip in `TasksList.tsx` and `Board.tsx`, and a line in `TaskPreview.tsx`.

- [ ] **Step 4: Run the tests and build**

Run: `cd UBS-Doc && npx vitest run && npx tsc --noEmit -p . && npx vite build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/screens/team/TimeSection.tsx src/screens/team/timeLogic.ts src/screens/team/timeLogic.test.ts src/screens/team/TaskDetail.tsx src/screens/team/TasksList.tsx src/screens/team/Board.tsx src/screens/team/TaskPreview.tsx
git commit -m "feat(team): time on the task page, list rows and board cards"
```

---

### Task 13: UBS-Doc — the Team Time tab

**Files:**
- Create: `UBS-Doc/src/screens/team/TimeTab.tsx`
- Modify: `UBS-Doc/src/screens/team/teamNav.ts`, `UBS-Doc/src/components/discordTasks/api.ts`, the team route table in `src/app`

**Interfaces:**
- Consumes: `fetchTimeReport(since, until)` (added to `api.ts`, same transport as `fetchDiscordTasks`); `weekRange`, `shiftWeek`, `formatDuration` (Task 11).
- Produces: the `/tools/team/time` route.

- [ ] **Step 1: Write the failing test**

```ts
import { activeTab, TEAM_TABS } from './teamNav'

describe('the Time tab', () => {
  it('is a tab and resolves from its path', () => {
    expect(TEAM_TABS.map((t) => t.key)).toContain('time')
    expect(activeTab('/tools/team/time')).toBe('time')
  })
})
```

Add to the existing `teamNav.test.ts`.

- [ ] **Step 2: Run and watch it fail**

Run: `cd UBS-Doc && npx vitest run src/screens/team/teamNav.test.ts`
Expected: FAIL — no `time` tab.

- [ ] **Step 3: Implement**

Add the tab to `teamNav.ts` and the route. `TimeTab.tsx` fetches the report for the current week, renders a week picker (`shiftWeek`), a per-person table with avatars and totals, and a per-project table. When the response's `scope` is `'self'` it shows one row and a quiet line: "Showing your own time. Ask an admin for the view_discord_time permission to see the team's." Loading and error states match the other tabs.

- [ ] **Step 4: Run the tests and build**

Run: `cd UBS-Doc && npx vitest run && npx tsc --noEmit -p . && npx vite build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/screens/team/TimeTab.tsx src/screens/team/teamNav.ts src/screens/team/teamNav.test.ts src/components/discordTasks/api.ts src/app
git commit -m "feat(team): the Time tab"
```

---

## Rollout

Merge and deploy in this order; each step is safe on its own because the site tolerates missing fields and CSAAS falls back to the old select.

1. **Bot** — merge to `main`, which runs migration 023 and restarts. Verify the bot is online and the command count went 43 → 46.
2. **CSAAS** — merge to `main`, wait for the Azure deploy.
3. **UBS-Doc** — merge to `main`, Vercel builds.

Then, live: `/clock-in` on a task, `/clock-out`, check the total on that task's page on the site, `/log-time 2h30m`, `/my-time`, and `/time-report` as a leader.

## Self-review notes

- **Spec coverage:** §4 data model → Task 1. §5 rules module → Task 2. §6 commands → Tasks 3–6. §7 watcher → Task 7. §8 estimates → Task 8 (with the documented deviation). §9 CSAAS → Tasks 9–10. §10 site → Tasks 11–13. §11 permissions → Tasks 6, 10, 13. §12 testing → every task. §13 rollout → above.
- **The one spec requirement that changed shape:** §8's Time button, which Discord's five-button limit forbids. Recorded at the top of this plan.
- **Names are consistent across tasks:** `clockEntryInsertSql`/`clockEntryUpdateSets` (Task 1) are used by name in Task 1's tests only; `entryMinutes`/`formatDuration`/`parseDuration`/`rangeFor`/`sumByTask`/`sumByPerson`/`runawayState` (Task 2) are consumed by Tasks 3–8 under those exact names; `clockableTasks` (Task 3) by Tasks 3 and 4; `GENERAL` (Task 3) by Tasks 3 and 4; `closeEntry` (Task 3) by Tasks 3 and 7; `timeLogged`/`estimateMinutes`/`timeByPerson` (Task 9) by Tasks 11–13.

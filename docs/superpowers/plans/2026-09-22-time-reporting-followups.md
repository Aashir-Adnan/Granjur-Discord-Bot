# Time Reporting Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person export their own logged time as CSV, filter the site's Time tab to one person, and post each day's per-person totals to a public Discord channel at 23:59.

**Architecture:** One new CSAAS endpoint returns a single person's raw time entries; the site derives both the per-task breakdown and the CSV from it, generating the file in the browser. The bot gains a `setInterval` service that posts a daily embed, guarded by a persisted day-key on `guildconfig` so a restart cannot double-post.

**Tech Stack:** Node 24 ESM + discord.js v14 + mysql2 (bot, `node:test`); CommonJS UBS framework (CSAAS, assert-based scripts); React 19 + TypeScript + Tailwind 4 + vitest (site).

**Spec:** `docs/superpowers/specs/2026-09-22-time-reporting-followups-design.md`

## Global Constraints

- **Tests never touch production.** The bot repo's root `.env` points at the live database. Every function under test takes a `db` seam (and `getConfig` where it needs guild config), every test passes fakes, and every suite run sets `DATABASE_URL=poisoned://no-production-access`. No exceptions, including a first "red" run. See `.claude/rules/tests-never-touch-production.md`.
- **The bot binds JS `Date` objects for `clockentry` date comparisons, on purpose.** Its pool is created with no `timezone` option (`bot/src/Database/connection.js`), so it writes and reads `clockInAt` through the same local-wall-clock convention — `clockEntryFindMany` already binds raw `Date`s. Do **not** "fix" new bot queries to `toISOString()`; that would break consistency with every existing write.
- **CSAAS binds MySQL-format strings via `toMysqlUtc`, also on purpose.** Its pool sets `timezone: DB_TIMEZONE` (`'+05:00'`), which is what makes it read the bot's stored values correctly. New CSAAS queries **import and reuse** `toMysqlUtc` from `discordTimeReport.js`. Re-deriving it as plain UTC is the exact bug fixed in commit `38640d5`.
- **The daily cutoff is the constant 23:59**, in the guild's configured timezone (`guildconfig.timezone`, falling back to `'UTC'` via `isValidZone`). Not configurable; see spec §9.
- **`guildMemberFindMany` caps at 25 rows unless `where.all` is true.** The daily report must pass `all: true` or it will silently truncate the roster.
- Site follows existing Tailwind conventions — no new design language, palette, or UI library. The site has no component tests; new site tests are logic-only (vitest).
- Every commit ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` on its own line after a blank line.

## File Structure

**Bot** (`Granjur-Discord-Bot`)
- `bot/src/Database/migrations/024_daily_time_report.sql` — new: two `guildconfig` columns.
- `bot/src/Database/schema.sql` — modify: same two columns, keeping the canonical schema in step.
- `bot/src/Database/index.js` — modify: `clockEntrySumByPersonRangeSql` + `clockEntrySumByPersonRange`, and two entries in `updateGuildConfig`'s allow-list.
- `bot/src/utils/timeTracking.js` — modify: four pure helpers (`dayKeyOf`, `dueReportDay`, `dayWindow`, `rankDailyTotals`). Pure day maths belongs beside the existing `dayStart`/`weekStart`/`rangeFor`, not in a near-duplicate module.
- `bot/src/services/dailyTimeReport.js` — new: the pass, the channel resolution, the embed.
- `bot/src/index.js` — modify: start the service beside `startClockWatch`.

**CSAAS** (`CSAAS_Backend`)
- `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeReport.js` — modify: export `toMysqlUtc` for reuse.
- `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeEntries.js` — new: the endpoint. `Src/Bootstrap/filesystem.js` recursively requires everything under `Src/Apis`, so defining `global.DiscordTimeEntries_object` is the whole registration — there is no route table to edit.
- `Services/SysScripts/TestScripts/discord-tasks-test/entries.test.js` — new.

**Site** (`UBS-Doc`)
- `src/components/discordTasks/api.ts` — modify: `TimeEntry`, `TimeEntriesPayload`, `fetchTimeEntries`.
- `src/screens/team/timeLogic.ts` — modify: `toCsv`, `csvFilename`, `entriesByTask`.
- `src/screens/team/timeLogic.test.ts` — modify: tests for the three.
- `src/screens/team/TimeTab.tsx` — modify: person select, per-task breakdown, Download CSV.

---

### Task 1: Bot — migration 024 and the data layer

**Files:**
- Create: `bot/src/Database/migrations/024_daily_time_report.sql`
- Modify: `bot/src/Database/schema.sql`, `bot/src/Database/index.js`
- Test: `bot/src/Database/clockEntry.test.js`

**Interfaces:**
- Produces: `clockEntrySumByPersonRangeSql(): string`; `db.clockEntry.sumByPersonRange({ guildConfigId, since, until }) -> [{ discordId, minutes }]`; `updateGuildConfig(guildId, { timeReportChannelId, lastTimeReportOn })`.

- [ ] **Step 1: Write the failing test**

Append to `bot/src/Database/clockEntry.test.js`, following the existing `clockEntryInsertSql` tests in that file:

```js
import { clockEntrySumByPersonRangeSql } from './index.js'

test('sumByPersonRange groups a date-bounded span by person', () => {
  const sql = clockEntrySumByPersonRangeSql()
  assert.match(sql, /SUM\(minutes\)/)
  assert.match(sql, /GROUP BY discordId/)
  // An open timer has no minutes yet and must not count as zero.
  assert.match(sql, /minutes IS NOT NULL/)
  assert.match(sql, /clockInAt >= \?/)
  assert.match(sql, /clockInAt < \?/)
  // Half-open: an entry starting exactly at the next midnight belongs to the next day.
  assert.ok(!/clockInAt <= \?/.test(sql))
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `DATABASE_URL=poisoned://no-production-access npx node --test bot/src/Database/clockEntry.test.js`
Expected: FAIL — `clockEntrySumByPersonRangeSql` is not exported.

- [ ] **Step 3: Implement**

In `bot/src/Database/index.js`, beside `clockEntrySumByTask`:

```js
// Per-person totals for one date span. A separate SQL aggregate rather than a
// findMany + JS sum because the daily post is public and must be exact: a
// capped fetch that silently understates somebody's day is worse than no post.
// `since`/`until` are bound as JS Dates, matching clockEntryFindMany and every
// clockentry write — this pool has no `timezone` option, so both sides of the
// comparison use the same local wall-clock convention. Do not "fix" to ISO.
export function clockEntrySumByPersonRangeSql() {
  return `SELECT discordId, SUM(minutes) AS minutes FROM \`clockentry\`
     WHERE guildConfigId = ? AND minutes IS NOT NULL AND clockInAt >= ? AND clockInAt < ?
     GROUP BY discordId`;
}

async function clockEntrySumByPersonRange({ guildConfigId, since, until }) {
  if (!guildConfigId || !since || !until) return [];
  return query(clockEntrySumByPersonRangeSql(), [guildConfigId, since, until]);
}
```

Add `sumByPersonRange: clockEntrySumByPersonRange,` to the `clockEntry` block of the exported db object (beside `sumByTask`).

In `updateGuildConfig`, after the `clockCapHours` block:

```js
  if (data.timeReportChannelId !== undefined) {
    sets.push("timeReportChannelId = ?");
    vals.push(data.timeReportChannelId);
  }
  if (data.lastTimeReportOn !== undefined) {
    sets.push("lastTimeReportOn = ?");
    vals.push(data.lastTimeReportOn);
  }
```

Create `bot/src/Database/migrations/024_daily_time_report.sql`:

```sql
-- The daily time report: which channel it posts to, and the last local day it
-- posted. The day is persisted rather than held in memory so a restart near
-- midnight cannot post the same report twice to a public channel.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildconfig' AND COLUMN_NAME = 'timeReportChannelId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildconfig ADD COLUMN timeReportChannelId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildconfig' AND COLUMN_NAME = 'lastTimeReportOn');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildconfig ADD COLUMN lastTimeReportOn DATE DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

Add both columns to the `guildconfig` block in `bot/src/Database/schema.sql`.

- [ ] **Step 4: Run the tests**

Run: `DATABASE_URL=poisoned://no-production-access npm test`
Expected: PASS, count up by 1 from the current 974.

- [ ] **Step 5: Commit**

```bash
git add bot/src/Database/migrations/024_daily_time_report.sql bot/src/Database/schema.sql bot/src/Database/index.js bot/src/Database/clockEntry.test.js
git commit -m "feat(time): migration 024 and per-person range totals"
```

---

### Task 2: Bot — the pure day maths

**Files:**
- Modify: `bot/src/utils/timeTracking.js`
- Test: `bot/src/utils/timeTracking.test.js`

**Interfaces:**
- Consumes: the module-private `localDate`, `offsetMinutes` and `midnightOf` already in this file.
- Produces: `dayKeyOf(date, tz) -> 'YYYY-MM-DD'`; `dueReportDay(now, tz, { hour, minute }) -> 'YYYY-MM-DD'`; `dayWindow(key, tz) -> { since: Date, until: Date }`; `rankDailyTotals(members, totals) -> [{ discordId, name, minutes }]`.

- [ ] **Step 1: Write the failing test**

Append to `bot/src/utils/timeTracking.test.js`:

```js
import { dayKeyOf, dayWindow, dueReportDay, rankDailyTotals } from './timeTracking.js'

test('dayKeyOf reads the calendar date in the given zone, not UTC', () => {
  // 22:30 UTC is already the next day in Karachi (+05:00).
  const d = new Date('2026-09-22T22:30:00Z')
  assert.equal(dayKeyOf(d, 'UTC'), '2026-09-22')
  assert.equal(dayKeyOf(d, 'Asia/Karachi'), '2026-09-23')
})

test('dueReportDay is today once the cutoff passes, yesterday before it', () => {
  // 23:58 local -> yesterday is still the day owed a report.
  assert.equal(dueReportDay(new Date('2026-09-22T18:58:00Z'), 'Asia/Karachi'), '2026-09-21')
  // 23:59 local -> today is now due.
  assert.equal(dueReportDay(new Date('2026-09-22T18:59:00Z'), 'Asia/Karachi'), '2026-09-22')
  // Just after local midnight, yesterday is due (and still unposted if we were down).
  assert.equal(dueReportDay(new Date('2026-09-22T19:30:00Z'), 'Asia/Karachi'), '2026-09-22')
})

test('dueReportDay rolls back across a month boundary without date arithmetic bugs', () => {
  assert.equal(dueReportDay(new Date('2026-09-01T05:00:00Z'), 'UTC'), '2026-08-31')
})

test('dayWindow is the half-open local day', () => {
  const { since, until } = dayWindow('2026-09-22', 'Asia/Karachi')
  assert.equal(since.toISOString(), '2026-09-21T19:00:00.000Z')
  assert.equal(until.toISOString(), '2026-09-22T19:00:00.000Z')
})

test('dayWindow spans a month end', () => {
  const { until } = dayWindow('2026-09-30', 'UTC')
  assert.equal(until.toISOString(), '2026-10-01T00:00:00.000Z')
})

test('rankDailyTotals gives everyone a row, zeros included, highest first', () => {
  const members = [
    { discordId: '1', name: 'Ali' },
    { discordId: '2', name: 'Zara' },
    { discordId: '3', name: 'Bilal' },
  ]
  const totals = [{ discordId: '2', minutes: 120 }]
  assert.deepEqual(rankDailyTotals(members, totals), [
    { discordId: '2', name: 'Zara', minutes: 120 },
    // Ties break alphabetically so the zero block reads predictably.
    { discordId: '1', name: 'Ali', minutes: 0 },
    { discordId: '3', name: 'Bilal', minutes: 0 },
  ])
})

test('rankDailyTotals ignores totals for people not on the roster', () => {
  const ranked = rankDailyTotals([{ discordId: '1', name: 'Ali' }], [{ discordId: '9', minutes: 60 }])
  assert.deepEqual(ranked, [{ discordId: '1', name: 'Ali', minutes: 0 }])
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `DATABASE_URL=poisoned://no-production-access npx node --test bot/src/utils/timeTracking.test.js`
Expected: FAIL — none of the four are exported.

- [ ] **Step 3: Implement**

Append to `bot/src/utils/timeTracking.js`:

```js
const pad = (n) => String(n).padStart(2, '0')

/** 'YYYY-MM-DD' for `date` as the calendar in `tz` sees it. */
export function dayKeyOf(date, tz = 'UTC') {
  const { y, m, d } = localDate(date, tz)
  return `${y}-${pad(m + 1)}-${pad(d)}`
}

/**
 * The local day whose report is owed at `now`: today once the local clock
 * reaches the cutoff, otherwise yesterday — whose own 23:59 has already gone.
 *
 * Yesterday is computed in calendar terms (Date.UTC normalises day 0 and day
 * -1 across month and year ends) rather than by subtracting 24h, which would
 * land on the wrong date across a DST change.
 */
export function dueReportDay(now, tz = 'UTC', { hour = 23, minute = 59 } = {}) {
  const local = new Date(now.getTime() + offsetMinutes(now, tz) * 60000)
  const h = local.getUTCHours()
  const past = h > hour || (h === hour && local.getUTCMinutes() >= minute)
  const { y, m, d } = localDate(now, tz)
  const ref = new Date(Date.UTC(y, m, past ? d : d - 1))
  return `${ref.getUTCFullYear()}-${pad(ref.getUTCMonth() + 1)}-${pad(ref.getUTCDate())}`
}

/** The half-open [since, until) instants covering local day `key` in `tz`. */
export function dayWindow(key, tz = 'UTC') {
  const [y, m, d] = String(key).split('-').map(Number)
  return { since: midnightOf(y, m - 1, d, tz), until: midnightOf(y, m - 1, d + 1, tz) }
}

/**
 * Every roster member with their minutes for the day — zero when they logged
 * nothing, because the daily post lists everyone on purpose. Highest first,
 * ties alphabetical, so the zeros collect into a predictable block.
 */
export function rankDailyTotals(members, totals) {
  const byId = new Map()
  for (const row of totals || []) byId.set(String(row.discordId), Number(row.minutes) || 0)
  return (members || [])
    .map((mem) => ({
      discordId: String(mem.discordId),
      name: mem.name,
      minutes: byId.get(String(mem.discordId)) || 0,
    }))
    .sort((a, b) => b.minutes - a.minutes || String(a.name).localeCompare(String(b.name)))
}
```

- [ ] **Step 4: Run the tests**

Run: `DATABASE_URL=poisoned://no-production-access npm test`
Expected: PASS, six new tests green.

- [ ] **Step 5: Commit**

```bash
git add bot/src/utils/timeTracking.js bot/src/utils/timeTracking.test.js
git commit -m "feat(time): due-day, day-window and daily ranking helpers"
```

---

### Task 3: Bot — the daily report service

**Files:**
- Create: `bot/src/services/dailyTimeReport.js`
- Modify: `bot/src/index.js`
- Test: `bot/src/services/dailyTimeReport.test.js`

**Interfaces:**
- Consumes: `dayKeyOf`, `dueReportDay`, `dayWindow`, `rankDailyTotals`, `formatDuration` (Task 2); `db.clockEntry.sumByPersonRange` and `updateGuildConfig`'s two new fields (Task 1); `isValidZone` from `bot/src/utils/timezone.js`.
- Produces: `runDailyReportPass(client, { db, getConfig, update, now })`; `startDailyTimeReport(client, { db, intervalMs })`; `reportLines(ranked, max)`.

- [ ] **Step 1: Write the failing test**

Create `bot/src/services/dailyTimeReport.test.js`. The fake client mirrors `clockWatch.test.js`'s:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { reportLines, runDailyReportPass } from './dailyTimeReport.js'

function fakeGuild(sent) {
  return {
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: { fetch: async (id) => ({ id, displayName: `User ${id}` }) },
    channels: {
      fetch: async () => ({ id: 'chan1', send: async (payload) => { sent.push(payload); return { id: 'msg1' } } }),
      create: async () => ({ id: 'chan1', send: async (payload) => { sent.push(payload); return { id: 'msg1' } } }),
    },
  }
}

function harness({ lastTimeReportOn = '2026-09-21', totals = [], members = [{ discordId: '1', displayName: 'Ali', status: 'approved' }] } = {}) {
  const sent = []
  const updates = []
  const guild = fakeGuild(sent)
  const client = { guilds: { cache: new Map([['g1', guild]]) } }
  const db = {
    clockEntry: { sumByPersonRange: async () => totals },
    guildMember: { findMany: async (args) => { db.lastFindMany = args; return members } },
  }
  const getConfig = async () => ({ id: 'cfg1', timezone: 'UTC', lastTimeReportOn, timeReportChannelId: 'chan1' })
  const update = async (guildId, data) => { updates.push({ guildId, data }) }
  return { client, db, getConfig, update, sent, updates }
}

test('posts the day that just ended and records it', async () => {
  const h = harness({ totals: [{ discordId: '1', minutes: 90 }] })
  await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z') })
  assert.equal(h.sent.length, 1)
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-22')
})

test('the roster read is uncapped — guildMemberFindMany defaults to 25', async () => {
  const h = harness()
  await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z') })
  assert.equal(h.db.lastFindMany.where.all, true)
  assert.equal(h.db.lastFindMany.where.status, 'approved')
})

test('does not post twice for the same day', async () => {
  const h = harness({ lastTimeReportOn: '2026-09-22' })
  await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z') })
  assert.equal(h.sent.length, 0)
})

test('the first ever pass records the day and posts nothing', async () => {
  const h = harness({ lastTimeReportOn: null })
  await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T12:00:00Z') })
  assert.equal(h.sent.length, 0)
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-21')
})

test('a long outage posts once, for the most recent due day only', async () => {
  const h = harness({ lastTimeReportOn: '2026-09-15' })
  await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z') })
  assert.equal(h.sent.length, 1)
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-22')
})

test('before the cutoff, yesterday is posted rather than a partial today', async () => {
  const h = harness({ lastTimeReportOn: '2026-09-20' })
  await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T10:00:00Z') })
  assert.equal(h.updates.at(-1).data.lastTimeReportOn, '2026-09-21')
})

test('reportLines lists zeros and truncates with a truthful tail', () => {
  const ranked = [
    { discordId: '1', name: 'Ali', minutes: 120 },
    { discordId: '2', name: 'Zara', minutes: 0 },
    { discordId: '3', name: 'Bilal', minutes: 0 },
  ]
  assert.deepEqual(reportLines(ranked, 10), ['**Ali** — 2h', '**Zara** — 0m', '**Bilal** — 0m'])
  assert.deepEqual(reportLines(ranked, 2), ['**Ali** — 2h', '**Zara** — 0m', '…and 1 more'])
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `DATABASE_URL=poisoned://no-production-access npx node --test bot/src/services/dailyTimeReport.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `bot/src/services/dailyTimeReport.js`:

```js
import { ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js'
import db, { getOrCreateGuildConfig, updateGuildConfig } from '../db/index.js'
import { isValidZone } from '../utils/timezone.js'
import { dayWindow, dueReportDay, formatDuration, rankDailyTotals } from '../utils/timeTracking.js'

// Posts each day's per-person totals to a channel everyone can read, at 23:59
// in the guild's own timezone.
//
// Follows ticketReminder.js's shape (interval tick plus a day-key guard) with
// two corrections: the cutoff is evaluated in the GUILD's timezone rather than
// the bot host's local clock, and the guard is a persisted column rather than
// an in-memory Map — losing a Map on restart is untidy for a DM and
// embarrassing for a public channel.

const TICK_MS = 60 * 1000
const CHANNEL_NAME = 'time-reports'
const MAX_LINES = 40

const pad = (n) => String(n).padStart(2, '0')

/** A DATE column comes back as a Date from mysql2, or a string; both to 'YYYY-MM-DD'. */
function dateKey(v) {
  if (!v) return null
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  return String(v).slice(0, 10)
}

/** The embed's body: everyone, zeros included, with a truthful truncation tail. */
export function reportLines(ranked, max = MAX_LINES) {
  const shown = (ranked || []).slice(0, max)
  const lines = shown.map((r) => `**${r.name}** — ${formatDuration(r.minutes)}`)
  if ((ranked || []).length > shown.length) lines.push(`…and ${ranked.length - shown.length} more`)
  return lines
}

/**
 * The channel to post in: the configured one, or a fresh #time-reports that
 * @everyone can read but not write. A failure to create is logged and skipped
 * — the pass retries next tick rather than throwing out of the interval.
 */
async function resolveChannel(guild, cfg, update) {
  if (cfg.timeReportChannelId) {
    const existing = await guild.channels.fetch(cfg.timeReportChannelId).catch(() => null)
    if (existing) return existing
  }
  const created = await guild.channels.create({
    name: CHANNEL_NAME,
    type: ChannelType.GuildText,
    topic: 'Daily time totals, posted automatically at 23:59.',
    permissionOverwrites: [{
      id: guild.roles.everyone.id,
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [PermissionFlagsBits.SendMessages],
    }],
  }).catch((e) => {
    console.warn('[dailyTimeReport] could not create the channel:', e?.message || e)
    return null
  })
  if (created) await update(guild.id, { timeReportChannelId: created.id }).catch(() => {})
  return created
}

export async function runDailyReportPass(client, {
  db: dbArg = db,
  getConfig = getOrCreateGuildConfig,
  update = updateGuildConfig,
  now = new Date(),
} = {}) {
  for (const [, guild] of client.guilds.cache) {
    try {
      const cfg = await getConfig(guild.id).catch(() => null)
      if (!cfg) continue

      const tz = isValidZone(cfg.timezone) ? cfg.timezone : 'UTC'
      const due = dueReportDay(now, tz)
      const last = dateKey(cfg.lastTimeReportOn)

      // String compare is safe and total for 'YYYY-MM-DD'.
      if (last && last >= due) continue

      // First ever pass: adopt the current day silently, so deploying at 3pm
      // does not fire a surprise report for yesterday.
      if (!last) {
        await update(guild.id, { lastTimeReportOn: due })
        continue
      }

      const { since, until } = dayWindow(due, tz)
      const totals = await dbArg.clockEntry.sumByPersonRange({ guildConfigId: cfg.id, since, until })
      // `all: true` or guildMemberFindMany silently caps the roster at 25.
      const rows = await dbArg.guildMember.findMany({
        where: { guildConfigId: cfg.id, status: 'approved', all: true },
      })

      // Someone who left keeps their guildmember row; listing them forever as
      // 0m would turn the post into a graveyard.
      const members = []
      for (const row of rows || []) {
        const member = await guild.members.fetch(String(row.discordId)).catch(() => null)
        if (!member) continue
        members.push({ discordId: String(row.discordId), name: member.displayName || row.displayName || row.username || `Member ${row.discordId}` })
      }

      const ranked = rankDailyTotals(members, totals)
      const channel = await resolveChannel(guild, cfg, update)
      if (!channel) continue

      const label = new Intl.DateTimeFormat('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz,
      }).format(since)
      const total = ranked.reduce((n, r) => n + r.minutes, 0)

      const embed = new EmbedBuilder()
        .setTitle(`Time — ${label}`)
        .setDescription(reportLines(ranked).join('\n') || 'Nobody is on the roster yet.')
        .addFields({ name: 'Team total', value: formatDuration(total) })
        .setColor(0x5865f2)

      await channel.send({ embeds: [embed] })
      // Recorded only after a successful post, so a failed send retries.
      await update(guild.id, { lastTimeReportOn: due })
    } catch (e) {
      console.warn(`[dailyTimeReport] guild ${guild?.id} failed:`, e?.message || e)
    }
  }
}

export function startDailyTimeReport(client, { db: dbArg = db, intervalMs = TICK_MS } = {}) {
  const tick = () => { runDailyReportPass(client, { db: dbArg }).catch(() => {}) }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  tick()
  return timer
}
```

In `bot/src/index.js`, import it beside `startClockWatch` and call `startDailyTimeReport(client)` wherever `startClockWatch(client)` is called.

- [ ] **Step 4: Run the tests**

Run: `DATABASE_URL=poisoned://no-production-access npm test`
Expected: PASS, seven new tests green.

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/dailyTimeReport.js bot/src/services/dailyTimeReport.test.js bot/src/index.js
git commit -m "feat(time): post a daily per-person report at 23:59"
```

---

### Task 4: CSAAS — the entries endpoint

**Files:**
- Create: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeEntries.js`
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeReport.js` (export `toMysqlUtc`)
- Test: `Services/SysScripts/TestScripts/discord-tasks-test/entries.test.js`

**Interfaces:**
- Consumes: `requirePortalPermission`, `executeQuery`, and `toMysqlUtc` (now exported from `discordTimeReport.js`).
- Produces: `getTimeEntries(req, decryptedPayload)`, `global.DiscordTimeEntries_object`, `__setTestHooks`.

Read `discordTimeReport.js` in full before starting — this endpoint mirrors its hooks, its identity handling and its API object, and differs only in shape and in refusing rather than narrowing.

- [ ] **Step 1: Write the failing test**

Create `entries.test.js`, following `time.test.js`'s harness style (hooks substituted, no DB connection):

```js
const assert = require("assert");
const { getTimeEntries, __setTestHooks } = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeEntries");

function hooks({ allowed = true, identity = { guildConfigId: "cfg1", discordId: "u1" }, rows = [] } = {}) {
  const calls = [];
  __setTestHooks({
    requirePortalPermission: async () => { if (!allowed) throw { statusCode: 403, message: "no" }; },
    executeQuery: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM granjur.guildmember WHERE LOWER\(email\)/.test(sql)) return identity ? [identity] : [];
      if (/FROM granjur.clockentry/.test(sql)) return rows;
      return [];
    },
    env: () => ({ DB_TIMEZONE: "+05:00" }),
  });
  return calls;
}
const payload = (over = {}) => ({ __identityVerified: true, actor_email: "me@x.com", ...over });

(async () => {
  // Your own entries need no permission at all.
  hooks({ allowed: false });
  const own = await getTimeEntries({ query: { discordId: "u1" } }, payload());
  assert.ok(Array.isArray(own.entries), "own entries returned");

  // Somebody else's, without view_discord_time, is refused rather than quietly
  // narrowed — there is no smaller honest answer to "show me Ali's entries".
  hooks({ allowed: false });
  let refused = null;
  try { await getTimeEntries({ query: { discordId: "u2" } }, payload()); } catch (e) { refused = e; }
  assert.equal(refused && refused.statusCode, 403, "other person without permission is 403");

  // With the permission, allowed.
  hooks({ allowed: true });
  const other = await getTimeEntries({ query: { discordId: "u2" } }, payload());
  assert.ok(Array.isArray(other.entries), "other person with permission returned");

  // The person filter is a SQL clause, and dates bind through toMysqlUtc.
  const calls = hooks({ allowed: true });
  await getTimeEntries({ query: { discordId: "u2", since: "2026-09-01T00:00:00.000Z", until: "2026-09-08T00:00:00.000Z" } }, payload());
  const q = calls.find((c) => /FROM granjur.clockentry/.test(c.sql));
  assert.ok(/AND\s+c\.discordId\s*=\s*\?/.test(q.sql), "person filtered in SQL");
  assert.ok(q.params.includes("2026-09-01 05:00:00"), "since bound in the pool's configured frame");

  // A full page sets `truncated` so the UI can say so instead of understating.
  hooks({ allowed: true, rows: Array.from({ length: 5000 }, (_, i) => ({ id: String(i), minutes: 1 })) });
  const full = await getTimeEntries({ query: { discordId: "u1" } }, payload());
  assert.equal(full.truncated, true, "truncated flagged at the limit");

  console.log("entries.test.js: all assertions passed");
})();
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd CSAAS_Backend && node Services/SysScripts/TestScripts/discord-tasks-test/entries.test.js`
Expected: FAIL — `Cannot find module .../discordTimeEntries`.

- [ ] **Step 3: Implement**

In `discordTimeReport.js`, add `toMysqlUtc` to its `module.exports` so the new file imports rather than copies it.

Create `discordTimeEntries.js`. Mirror `discordTimeReport.js`'s `__hooks`, `fail`, `parseIsoDate`, `resolveRange` and `callerIdentity` (import what it exports; copy only what it does not). The handler:

```js
const LIMIT = 5000;

async function getTimeEntries(req, decryptedPayload) {
  // Identity comes only from a token-bound, verified email — never a
  // client-supplied field. Same rule as discordTasksStatus.js.
  const email = decryptedPayload?.__identityVerified
    ? String(decryptedPayload.actor_email || "").toLowerCase().trim() || null
    : null;
  const identity = await callerIdentity(email);

  const wanted = String(decryptedPayload?.discordId ?? req?.query?.discordId ?? "").trim();
  if (!wanted) throw fail(400, "discordId is required");

  // Yourself is always allowed. Anyone else needs the permission — and is
  // refused, not narrowed: unlike the aggregate report there is no smaller
  // honest answer to a request for a named person.
  if (!identity.discordId || wanted !== identity.discordId) {
    try {
      await __hooks.requirePortalPermission(req, decryptedPayload, "view_discord_time");
    } catch (e) {
      if (e && e.statusCode === 403) throw fail(403, "You do not have permission to read someone else's time");
      throw e;
    }
  }

  const { since, until } = resolveRange(req, decryptedPayload);

  let rows = [];
  try {
    rows = await __hooks.executeQuery(
      `SELECT c.id, c.clockInAt, c.clockOutAt, c.minutes, c.note, c.source,
              c.taskId, t.title AS taskTitle, t.projectId, t.projectName
       FROM granjur.clockentry c
       LEFT JOIN granjur.task t ON t.id = c.taskId
       WHERE c.discordId = ? AND c.minutes IS NOT NULL
         AND c.clockInAt >= ? AND c.clockInAt < ?
       ORDER BY c.clockInAt ASC
       LIMIT ${LIMIT}`,
      [wanted, toMysqlUtc(since), toMysqlUtc(until)],
    );
  } catch (_) {
    throw fail(502, "Could not read time entries");
  }

  const info = await loadMemberInfo(identity.guildConfigId ? [identity.guildConfigId] : []);
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    person: { discordId: wanted, name: personName(info, wanted), ...personAvatar(info, wanted) },
    entries: (rows || []).map((r) => ({
      id: String(r.id),
      clockInAt: r.clockInAt instanceof Date ? r.clockInAt.toISOString() : String(r.clockInAt),
      clockOutAt: r.clockOutAt instanceof Date ? r.clockOutAt.toISOString() : (r.clockOutAt ? String(r.clockOutAt) : null),
      minutes: Number(r.minutes || 0),
      taskId: r.taskId != null ? String(r.taskId) : null,
      taskTitle: r.taskTitle != null ? String(r.taskTitle) : null,
      projectId: r.projectId != null ? String(r.projectId) : null,
      projectName: r.projectName != null ? String(r.projectName) : null,
      note: r.note != null ? String(r.note) : null,
      source: String(r.source || "timer"),
    })),
    truncated: (rows || []).length >= LIMIT,
  };
}
```

The API object copies `DiscordTimeReport_object` exactly — `accessToken: true`, `encryption: false`, `permission: null`, `bindActorToToken: true`, `requestMethod: "GET"` — with `fields` naming `discordId`, `since` and `until`, each `source: "req.query"`, and `discordId` required. Export `global.DiscordTimeEntries_object`, `getTimeEntries` and `__setTestHooks`. `Src/Bootstrap/filesystem.js` requires every file under `Src/Apis`, so no registration step exists.

- [ ] **Step 4: Run the tests**

Run: `cd CSAAS_Backend && for f in Services/SysScripts/TestScripts/discord-tasks-test/*.test.js; do node "$f" || exit 1; done`
Expected: all seven files pass.

- [ ] **Step 5: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeEntries.js Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeReport.js Services/SysScripts/TestScripts/discord-tasks-test/entries.test.js
git commit -m "feat(time): per-person time entries endpoint"
```

---

### Task 5: Site — CSV, grouping and the API call

**Files:**
- Modify: `src/components/discordTasks/api.ts`, `src/screens/team/timeLogic.ts`
- Test: `src/screens/team/timeLogic.test.ts`

**Interfaces:**
- Consumes: the Task 4 response shape.
- Produces: `TimeEntry`, `TimeEntriesPayload`, `fetchTimeEntries(discordId, since, until)`; `toCsv(rows)`, `csvFilename(name, since, until)`, `entriesByTask(entries)`.

- [ ] **Step 1: Write the failing test**

Append to `src/screens/team/timeLogic.test.ts`:

```ts
import { csvFilename, entriesByTask, toCsv } from './timeLogic'

describe('toCsv', () => {
  it('writes a header and quotes only what needs it', () => {
    const csv = toCsv([['Date', 'Task'], ['2026-09-22 09:00', 'Simple']])
    expect(csv).toBe('Date,Task\r\n2026-09-22 09:00,Simple')
  })

  it('quotes fields containing a comma, a quote or a newline', () => {
    // Task titles and notes routinely contain all three; getting this wrong
    // corrupts the file silently rather than failing loudly.
    const csv = toCsv([['a,b', 'say "hi"', 'line1\nline2']])
    expect(csv).toBe('"a,b","say ""hi""","line1\nline2"')
  })

  it('renders null and undefined as empty, not as the word null', () => {
    expect(toCsv([[null, undefined, 0]])).toBe(',,0')
  })
})

describe('csvFilename', () => {
  it('slugifies the person and carries the range', () => {
    expect(csvFilename('Ali Raza', new Date('2026-09-21T00:00:00Z'), new Date('2026-09-28T00:00:00Z')))
      .toBe('time-ali-raza-2026-09-21-to-2026-09-27.csv')
  })
})

describe('entriesByTask', () => {
  it('totals per task, keeps general work separate, and sorts by minutes', () => {
    const rows = entriesByTask([
      { taskId: 't1', taskTitle: 'Login', projectName: 'Core', minutes: 30 },
      { taskId: null, taskTitle: null, projectName: null, minutes: 45 },
      { taskId: 't1', taskTitle: 'Login', projectName: 'Core', minutes: 60 },
    ] as never)
    expect(rows).toEqual([
      { taskId: 't1', taskTitle: 'Login', projectName: 'Core', minutes: 90 },
      { taskId: null, taskTitle: 'General work', projectName: null, minutes: 45 },
    ])
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd UBS-Doc && npx vitest run src/screens/team/timeLogic.test.ts`
Expected: FAIL — the three are not exported.

- [ ] **Step 3: Implement**

In `src/components/discordTasks/api.ts`, beside `fetchTimeReport`:

```ts
export interface TimeEntry {
  id: string
  clockInAt: string
  clockOutAt: string | null
  minutes: number
  taskId: string | null
  taskTitle: string | null
  projectId: string | null
  projectName: string | null
  note: string | null
  source: string
}
export interface TimeEntriesPayload {
  since: string
  until: string
  person: { discordId: string; name: string; avatarUrl?: string }
  entries: TimeEntry[]
  truncated: boolean
}
export function fetchTimeEntries(discordId: string, since: Date, until: Date): Promise<TimeEntriesPayload> {
  const q = `discordId=${encodeURIComponent(discordId)}&since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}`
  return mwGet(`/discord/time/entries?${q}`) as Promise<TimeEntriesPayload>
}
```

In `src/screens/team/timeLogic.ts`:

```ts
// RFC 4180: a field is quoted only when it contains a comma, a double quote,
// CR or LF, and embedded quotes are doubled. Task titles and notes contain all
// of these, and getting it wrong corrupts the file without any error.
export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined): string => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return rows.map((r) => r.map(cell).join(',')).join('\r\n')
}

const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** `until` is exclusive, so the filename names the last day actually covered. */
export function csvFilename(name: string, since: Date, until: Date): string {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'person'
  const lastDay = new Date(until.getFullYear(), until.getMonth(), until.getDate() - 1)
  return `time-${slug}-${isoDay(since)}-to-${isoDay(lastDay)}.csv`
}

/** Per-task totals for one person, general work kept as its own row. */
export function entriesByTask(entries: TimeEntry[]): Array<{ taskId: string | null; taskTitle: string; projectName: string | null; minutes: number }> {
  const byKey = new Map<string, { taskId: string | null; taskTitle: string; projectName: string | null; minutes: number }>()
  for (const e of entries || []) {
    const key = e.taskId ?? '__general__'
    const row = byKey.get(key) ?? {
      taskId: e.taskId ?? null,
      taskTitle: e.taskTitle ?? 'General work',
      projectName: e.projectName ?? null,
      minutes: 0,
    }
    row.minutes += Number(e.minutes) || 0
    byKey.set(key, row)
  }
  return [...byKey.values()].sort((a, b) => b.minutes - a.minutes)
}
```

Import `type TimeEntry` into `timeLogic.ts` from `../../components/discordTasks/api`.

- [ ] **Step 4: Run the tests and build**

Run: `cd UBS-Doc && npx vitest run && npx tsc --noEmit -p . && npx vite build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/discordTasks/api.ts src/screens/team/timeLogic.ts src/screens/team/timeLogic.test.ts
git commit -m "feat(team): CSV, per-task grouping and the entries fetch"
```

---

### Task 6: Site — person filter and Download CSV on the Time tab

**Files:**
- Modify: `src/screens/team/TimeTab.tsx`

**Interfaces:**
- Consumes: `fetchTimeEntries`, `TimeEntriesPayload` (Task 5); `toCsv`, `csvFilename`, `entriesByTask` (Task 5); `formatDuration`, `weekRange`, `shiftWeek` (existing); `useTeam().payload.members`; `Avatar`, `FilterSelect`.

Read `TimeTab.tsx` in full first. Keep its existing structure — the week picker, the `loading && data` dim, the `scope === 'self'` note, the `TimeCard` helper — and add to it.

- [ ] **Step 1: No new test**

Every pure decision here is already covered by Task 5 (`toCsv`, `csvFilename`, `entriesByTask`) and Task 2's site equivalents. This repo has no component-testing infrastructure and this task must not introduce any — confirmed in the parent build's reviews. Verify the existing suite stays green in Step 3.

- [ ] **Step 2: Implement**

Add a person `<select>` beside the week picker, sourced from the roster the layout already holds:

```tsx
const { payload } = useTeam()
const [personId, setPersonId] = useState<string>('')
const members = useMemo(
  () => [...(payload?.members ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  [payload],
)
const [detail, setDetail] = useState<TimeEntriesPayload | null>(null)
```

The options come from `payload.members`, **not** from `assigneeOptions(projects)` — you can log time against general work or a task you are not assigned to, so the assignee list is the wrong set. The shared filter row stays hidden on this tab, as it is today; this select is local to `TimeTab`.

Add a second effect that fetches the detail when a person is selected, clearing it when not:

```tsx
useEffect(() => {
  if (!personId) { setDetail(null); return }
  let cancelled = false
  setLoading(true)
  setError(null)
  fetchTimeEntries(personId, range.since, range.until)
    .then((d) => { if (!cancelled) setDetail(d) })
    .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    .finally(() => { if (!cancelled) setLoading(false) })
  return () => { cancelled = true }
}, [personId, range, payload])
```

When `personId` is set, render the per-task breakdown from `entriesByTask(detail.entries)` in a `TimeCard` titled "By task" (task title, project name beneath, `formatDuration(minutes) ?? '0m'`), alongside a second card listing the individual entries (date, task, duration, note). When it is empty, `TimeCard`'s existing "Nothing here for this range." covers it. When `detail.truncated` is true, show one line above the cards: `Showing the first 5000 entries — narrow the range for a complete total.`

The Download button renders only when a person is selected, disabled when there are no entries:

```tsx
function downloadCsv(d: TimeEntriesPayload, range: { since: Date; until: Date }) {
  const rows: Array<Array<string | number | null>> = [
    ['Date', 'Person', 'Project', 'Task', 'Minutes', 'Note', 'Source'],
    ...d.entries.map((e) => {
      const at = new Date(e.clockInAt)
      const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
      return [stamp, d.person.name, e.projectName, e.taskTitle ?? 'General work', e.minutes, e.note, e.source]
    }),
  ]
  // Built in the browser from what is already on screen, so the file can never
  // disagree with what the user is looking at, and there is no export endpoint
  // to authorise or rate-limit.
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = csvFilename(d.person.name, range.since, range.until)
  a.click()
  URL.revokeObjectURL(url)
}
```

Style the button and select with the classes already used on this tab and in `FilterSelect` — no new palette. Use the `Download` icon from `lucide-react`, matching how `TasksList` imports `Clock`.

- [ ] **Step 3: Run the tests and build**

Run: `cd UBS-Doc && npx vitest run && npx tsc --noEmit -p . && npx vite build`
Expected: all pass, count unchanged from Task 5.

- [ ] **Step 4: Commit**

```bash
git add src/screens/team/TimeTab.tsx
git commit -m "feat(team): filter the Time tab by person and export their CSV"
```

---

## Rollout

Merge and deploy in this order; each step is safe alone.

1. **Bot** — merge to `main`, which runs migration 024 and restarts. The first pass after deploy posts nothing (it adopts the current day); the first real report lands the following 23:59. Verify `#time-reports` was created and that `@everyone` can read but not post in it.
2. **CSAAS** — merge to `main`, wait for the Azure deploy. The endpoint is additive; nothing consumes it yet.
3. **Site** — merge to `main`, Vercel builds. Verify the person select, the per-task breakdown, and that the downloaded CSV opens cleanly in a spreadsheet with a task title containing a comma.

## Self-review notes

- **Spec coverage:** §3 entries endpoint → Task 4. §4 permissions → Task 4. §5 person filter → Task 6 (types and fetch in Task 5). §6 CSV → Tasks 5 (logic) and 6 (button). §7 daily report → Tasks 2 (pure maths) and 3 (service). §8 data model → Task 1. §9 constants → Task 3 (`TICK_MS`, cutoff defaults in `dueReportDay`). §10 testing → every task. §11 rollout → above.
- **Names are consistent across tasks:** `sumByPersonRange` (Task 1) is called by name in Task 3; `dayKeyOf`/`dueReportDay`/`dayWindow`/`rankDailyTotals` (Task 2) are consumed under those exact names in Task 3; `toCsv`/`csvFilename`/`entriesByTask` and `fetchTimeEntries`/`TimeEntry`/`TimeEntriesPayload` (Task 5) are consumed under those exact names in Task 6.
- **Two traps are called out where an implementer would otherwise hit them:** `guildMemberFindMany`'s silent `LIMIT 25` without `where.all` (Task 3), and the opposite date-binding conventions of the two repos' pools (Global Constraints, restated in Tasks 1 and 4).

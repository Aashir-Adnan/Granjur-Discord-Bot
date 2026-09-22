# Time reporting follow-ups — design

**Date:** 2026-09-22
**Builds on:** `docs/superpowers/specs/2026-09-22-task-time-tracking-design.md` (shipped the
same day; this spec assumes all of it is live).

## 1. Purpose

Three follow-ups the owner asked for once time tracking shipped:

1. **Export.** A person can download their logged time as a CSV — task title, time on it, and
   project.
2. **Filter.** The site's Team → Time section cannot currently be narrowed to one person.
3. **A daily report.** At 23:59 every day, post that day's per-person totals to a Discord
   channel everyone can read.

The through-line: the time data exists, but it is only readable in aggregate, in one place, by
people who go looking. These make it personal, portable, and visible without asking.

## 2. Scope

**In:** a per-person entries endpoint in CSAAS; a person filter and CSV download on the site's
Time tab; a daily report service in the bot; migration 024 for two `guildconfig` columns.

**Out (deliberately):** a Discord `/export-time` command; PDF or XLSX; weekly or monthly
digests; a per-project breakdown in the daily post; making the 23:59 cutoff configurable (it is
a constant — see §9); URL state for the person filter.

## 3. Shared plumbing: the entries endpoint

Both site features need the same thing — one person's individual time entries — so they share
one endpoint rather than growing two query shapes.

`GET /api/discord/time/entries?discordId=<id>&since=<ISO>&until=<ISO>`

`since`/`until` are optional and default to the current week, matching `discordTimeReport.js`.
Response:

```js
{
  since: string,            // ISO, echoed back
  until: string,            // ISO
  person: { discordId, name, avatarUrl? },
  entries: [{
    id: string,
    clockInAt: string,      // ISO
    clockOutAt: string,     // ISO
    minutes: number,
    taskId: string | null,  // null = general work
    taskTitle: string | null,
    projectId: string | null,
    projectName: string | null,
    note: string | null,
    source: string,         // 'timer' | 'manual' | 'auto_stopped' | 'legacy'
  }],
  truncated: boolean,
}
```

**One person per request, by construction.** The endpoint has no "all people" mode. This makes
the owner's "the export must be user-specific, not mixed" a property of the API, not a UI
convention that a later change could quietly break.

**Ordering:** ascending by `clockInAt`. The CSV is the primary consumer and spreadsheets read
top-down chronologically; the site's per-task grouping does not care about order.

**Limit:** `LIMIT 5000`, with `truncated: true` when that many rows come back, so the UI can say
so rather than silently understating a total. Same rule as the 2000-row cap in the parent spec:
a cap that lies is a correctness bug, not a limit.

**Date binding:** reuses `discordTimeReport.js`'s existing `toMysqlUtc` — the `DB_TIMEZONE`-aware
formatter, not a fresh `toISOString()`. Re-implementing it is exactly how the shipped bug
happened; the helper is exported and shared, never copied.

## 4. Permissions

Reuses the model already in `discordTimeReport.js`:

- Caller identity comes only from `decryptedPayload.__identityVerified ? actor_email : null`.
- `discordId` equal to the caller's own → always allowed.
- Any other `discordId` → requires `view_discord_time`, else **403**.

The 403 is a deliberate difference from the aggregate report, which silently narrows to
self-scope instead. That narrowing makes sense when the question is "show me the report" — there
is a smaller honest answer. There is no smaller honest answer to "show me Ali's entries", so
this refuses rather than returning someone else's name attached to your own rows.

## 5. Site: person filter on the Time tab

The Time tab gets **its own** person select, local to `TimeTab.tsx` — not the shared Assignee
filter in `TeamLayout`. Two reasons: the shared filter's options come from
`assigneeOptions(projects)` (people assigned to tasks), which is the wrong set — you can log
time against general work, or against a task you are not assigned to — and overloading
`filters.assigneeId` with a second meaning would leak state between tabs. The shared filter row
stays hidden on this tab, as it is today.

Options come from `payload.members` (the roster the Team section already fetched), sorted by
name, with an "Everyone" default.

- **Nobody selected** → today's behaviour: totals by person and by project.
- **Person selected** → fetch `/time/entries` for them and show a per-task breakdown (task
  title, project, total minutes), plus their individual entries.

A caller without `view_discord_time` only ever receives their own data, so for them the select
is fixed to themselves.

## 6. Site: CSV download

A **Download CSV** button appears only when a person is selected — the same mechanism that
enforces user-specific export.

The file is generated **in the browser** from the entries already on screen: a `Blob` and an
object URL. No download endpoint, no second auth surface, nothing to rate-limit, and no way for
the file to disagree with what the user is looking at.

**Columns:** `Date, Person, Project, Task, Minutes, Note, Source` — one row per entry, plus a
header row. `Date` is the entry's `clockInAt` as `YYYY-MM-DD HH:mm` in the browser's local
timezone. `Minutes` is an integer so a spreadsheet can sum it directly.

**Filename:** `time-<person>-<since>-to-<until>.csv`, dates as `YYYY-MM-DD`, the person
slugified.

**Quoting is the only fiddly part** and gets its own tested pure function: RFC 4180 — a field is
wrapped in double quotes when it contains a comma, double quote, CR or LF, and embedded quotes
are doubled. Task titles and notes routinely contain commas and quotes, so getting this wrong
corrupts the file silently.

The button is disabled when the selected person has no entries in range.

## 7. Bot: the daily report

New service `bot/src/services/dailyTimeReport.js`, following `ticketReminder.js`'s shape
(interval tick plus a day-key guard) but correcting two weaknesses in that precedent.

**Schedule.** Ticks every 60 seconds. The cutoff is **23:59 in the guild's configured timezone**
(`guildconfig.timezone`, falling back to UTC). `ticketReminder` checks the bot host's local
hour, which is wrong on any host not set to the team's zone — the same class of mistake as the
timezone bug fixed during the parent build.

**Which day is due.** Let `todayKey` be the current date in the guild's timezone. `dueKey` is
`todayKey` when local time is at or past 23:59, otherwise the previous day. If
`guildconfig.lastTimeReportOn >= dueKey` there is nothing to do. Otherwise post the report
covering `dueKey` 00:00:00 → 23:59:59.999 in that timezone, then set `lastTimeReportOn = dueKey`.

Three consequences, all intended:

- **Restart-safe.** The guard is a persisted column, not an in-memory Map. `ticketReminder`
  loses its Map on restart, which for a DM is untidy and for a public channel is embarrassing.
- **Never silently loses a day.** If the bot is down at 23:59 it posts on boot instead of
  skipping — late, but present.
- **A long outage does not spam.** Only the most recent due day is ever posted; a week of
  downtime loses the intervening days rather than firing seven reports at once.

**The first run posts nothing.** When `lastTimeReportOn` is NULL the service records `dueKey`
and returns, so deploying at 3pm does not fire a surprise report for yesterday.

**Content.** One embed per guild, titled with the day (e.g. "Time — Monday 22 September 2026").
Every **approved** `guildmember` for that guild is listed with their total — `**Name** — 3h 20m`,
or `— 0m` where nothing was logged — sorted by minutes descending, ties alphabetical, so the
zeros collect at the bottom. A closing `Team total:` line. At the current roster (15 approved of
17) that is ~15 lines, comfortably inside Discord's limits; the list truncates with an
"…and N more" tail if it ever would not be.

A person's total is **all** the time they logged that day, general work included — the daily
post answers "what did people put in", not "what did people put into tasks". Approved members
who are no longer in the Discord guild are skipped, so departures do not accumulate as permanent
`0m` lines.

A day where nobody logged anything still posts. The zeros are the point.

**Channel.** `guildconfig.timeReportChannelId`. When it is unset — or the stored channel is gone
— the service creates `#time-reports` with `@everyone` able to view but not send and the bot
able to send, then stores the id. A failed creation logs and skips the pass rather than throwing.

Wired into `bot/src/index.js` beside `startClockWatch`.

## 8. Data model

Migration `024_daily_time_report.sql`, idempotent in the established style:

- `guildconfig.timeReportChannelId VARCHAR(64) DEFAULT NULL`
- `guildconfig.lastTimeReportOn DATE DEFAULT NULL`

No new tables. The entries endpoint reads `clockentry` joined to `task` exactly as the report
endpoint already does.

## 9. Constants

The cutoff is a constant `23:59`, not per-guild configuration. The parent build already left
`clockReminderHours`/`clockCapHours` as database-only settings with no command to set them;
adding a third unconfigurable knob is a known, accepted gap rather than a silent one. If these
should become configurable later, one settings command should cover all of them together.

## 10. Testing

**Bot** (`node:test`, `db`/`getConfig` seams with fakes, `DATABASE_URL=poisoned://…` always — see
`.claude/rules/tests-never-touch-production.md`): due-day computation across the 23:59 boundary
and in a non-UTC timezone; the NULL-first-run skip; a long outage posting exactly once; the
persisted guard preventing a double post within a day; zeros included in the listing; channel
auto-create when the id is unset; embed truncation.

**CSAAS** (assert-based script, `entries.test.js`, hooks substituted, no DB connection): a
self-request allowed; another person without `view_discord_time` → 403; another person with it →
allowed; the SQL carries the person filter and binds dates through the shared `toMysqlUtc`;
`truncated` set at the limit.

**Site** (vitest, logic-only — the repo has no component tests): CSV quoting against fields
containing commas, quotes and newlines; filename generation; grouping entries by task; the empty
and truncated states, via pure helpers.

## 11. Rollout

1. **Bot** — migration 024 and the daily report service. Independent of the other two; verify a
   report appears in `#time-reports` after the first full day.
2. **CSAAS** — the entries endpoint. The site needs it.
3. **Site** — person filter and CSV download.

Each step is safe alone: the endpoint is additive, and the site's new controls do not appear
until it answers.

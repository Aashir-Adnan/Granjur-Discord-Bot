# Task time tracking: clock in against a task, report per task and per person

**Date:** 2026-09-22
**Status:** approved design, not yet implemented
**Repos touched:** Granjur-Discord-Bot (migration 023), CSAAS_Backend, UBS-Doc

---

## 1. Goal

Anyone can clock time against a task from Discord, and the organisation can answer two
questions it cannot answer today: **how long did this task take**, and **where did this
person's week go**. Time shows up where the work already lives — on the task in Discord,
on the task's page on UBS-Doc, and as per-person and per-project totals for leadership.

## 2. What exists today

- **`/clock-in` and `/clock-out` exist and track a *shift*, not a task.**
  `bot/src/commands/clock-in.js` writes a `clockentry` row and adds the configured
  "Clocked In" role; `/clock-out` closes the row, removes the role and replies with the
  session length in minutes. Neither mentions a task.
- **The `clockentry` table has no task column**: `id`, `guildConfigId`, `discordId`,
  `clockInAt`, `clockOutAt`, `createdAt`, with keys on `(guildConfigId, discordId)` and
  `clockInAt`.
- **Nothing ever reads the data.** `db.clockEntry.findMany` is defined in
  `bot/src/Database/index.js` and called from nowhere. `findActive`, `create` and `update`
  are called only by the two clock commands. Grepping CSAAS_Backend and UBS-Doc for
  `clockentry`, `timeEntry`, `timeSpent` or `clock` returns nothing. Hours go into the
  table and die there.
- **`guildconfig` already carries what this needs**: `clockedInRoleId`, `timezone`
  (nullable) and `dashboardRoleIds` (the leadership gate).
- **The task row has no estimate.**
- **Reusable patterns this design follows rather than reinvents:**
  - `memberPassesRoleGate(guild, member, ensureStringArray(cfg.dashboardRoleIds), LEADERSHIP_ROLE_NAMES)`
    — the CEO / Server Manager gate used by `/update-task`.
  - `services/memberNameSync.js` — a background loop started from `bot/src/index.js`
    (`startMemberNameSync(client)`), db passed as a seam, failures logged and swallowed.
  - `services/taskHub.js` — the panel-plus-modal pattern (state in the custom id, one
    save per interaction, the message redrawn with a notice).
  - `services/taskActivity.js` — `recordTaskActivity` for "who changed what".
  - The graceful-fallback query pattern in
    `CSAAS_Backend/Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js`: try the new
    column, `.catch()` back to the old select so the site loads while a migration is
    still rolling.
- **43 commands are registered today** (`bot/src/commands/index.js`).

## 3. Decisions

| Question | Decision |
|---|---|
| Shift clock vs task clock | **Replace.** `/clock-in` requires a task choice. No separate shift timer, so one person never has two clocks running and totals can never disagree. |
| Old rows with no task | Kept. The `taskId` column is **nullable** even though the command requires a choice, so existing shift rows stay valid and read as "General". |
| Time that isn't on a task | The picker's **first option is "No task — general work"**, which writes `taskId = NULL`. Standups, admin and review have somewhere to go, and the option is deliberate rather than a task chosen because something had to be. |
| Approval workflow | **None.** Everyone edits and deletes their own entries; leadership edits anyone's. Every correction is recorded. |
| Which tasks can be clocked into | Tasks you hold, **plus any task in a project you are a member of** (so a reviewer or QA can log against the task they are testing). Leadership: any task. |
| Forgotten timer | **Both** a reminder and a cap: a DM at 6 hours with *Keep going* / *Stop now*, and a hard close at 12 hours marked `auto_stopped`. Both configurable per guild. |
| Maximum single entry | **No maximum.** A manual entry may be any positive duration. It must parse to a positive whole number of minutes; that is the only bound. |
| Estimates | In scope. `task.estimateMinutes`, compared against logged time in reports and on the site. |
| Auto-tracking voice time | Out of scope. |
| Duration storage | Both the timestamps and a derived `minutes` column, with one helper as the only writer. |

## 4. Data model — migration 023

Every column is nullable or defaulted, so the migration cannot fail on existing rows. Each
`ALTER` is guarded by the `information_schema` pattern used by migrations 020–022, and
`bot/src/Database/schema.sql` is updated to match.

On `clockentry`:

| Column | Type | Purpose |
|---|---|---|
| `taskId` | `VARCHAR(36) NULL` | The task the time was spent on. `NULL` = general work. |
| `minutes` | `INT NULL` | Duration, written when the entry closes. `NULL` while running. |
| `note` | `VARCHAR(500) NULL` | Optional "what I did". |
| `source` | `VARCHAR(16) NOT NULL DEFAULT 'timer'` | `timer`, `manual` or `auto_stopped`. |
| `remindedAt` | `DATETIME(3) NULL` | Set when the 6-hour DM is sent, so it is sent once. |

Indexes: `KEY idx_clockentry_task (guildConfigId, taskId)` for per-task sums, and
`KEY idx_clockentry_person (guildConfigId, discordId, clockInAt)` for per-person ranges.
No foreign key on `taskId`: a deleted task must not delete the hours somebody worked. An
entry whose task no longer exists reports as "Deleted task".

On `task`: `estimateMinutes INT NULL`.

On `guildconfig`: `clockReminderHours INT NULL` and `clockCapHours INT NULL`. `NULL` means
use the code defaults (6 and 12).

**Why `minutes` is stored as well as the timestamps.** A report becomes one `SUM(minutes)`
instead of datetime arithmetic across rows, and a retroactive entry ("2h30m yesterday")
gets a real duration without pretending to know the exact minute it started. The duplication
is safe because exactly one helper writes it — `entryMinutes(clockInAt, clockOutAt)` — and
it is recomputed on **every** write, including edits. A test asserts the two can never
disagree after any write path.

## 5. The rules module — `bot/src/utils/timeTracking.js`

Pure, no database, no Discord. This is where the logic that can be got wrong lives, and it
carries the heaviest tests.

- `parseDuration(text) -> number | null` — minutes from `2h30m`, `2h 30m`, `2.5h`, `90m`,
  `90`, `1:30`. Returns `null` for empty input, unparseable text, zero, a negative, `NaN`
  or `Infinity`. **No upper bound.**
- `formatDuration(minutes) -> string` — `200` → `3h 20m`, `120` → `2h`, `45` → `45m`,
  `0` → `0m`, `null` → `—`.
- `entryMinutes(clockInAt, clockOutAt) -> number | null` — rounded minutes, never negative,
  `null` while the entry is open. The only writer of the `minutes` column.
- `runawayState(entry, now, { remindAfterMin, capMin }) -> 'ok' | 'remind' | 'stop'` —
  `'stop'` wins over `'remind'`, and `'remind'` is never returned twice for one entry
  (`remindedAt`).
- `weekStart(date, timezone)` / `rangeFor(keyword, now, timezone)` — `today`, `week`,
  `month`, `all`. Weeks start **Monday 00:00** in the guild's timezone, UTC when unset.
- `sumByTask(entries)` / `sumByPerson(entries)` — aggregation for the reports.
- `overlaps(entries)` — manual entries that overlap in time for one person. Reported as a
  warning on the entry, never a refusal: the honest answer is "these two overlap, is that
  right?", not a rejection of someone's timesheet.

## 6. Discord commands

Three new commands (43 → 46) and two rewritten.

- **`/clock-in task:<autocomplete>`** — starts your timer.
  - Already running on **the same task**: nothing changes; the reply says how long it has
    been running. This is what stops a double `/clock-in` creating a zero-minute split.
  - Already running on **a different task**: the old entry is closed and the new one
    started in one reply — "Stopped **Git Sync** 1h 10m · started **Router fix**". There is
    no separate `/switch` command to learn.
  - Adds the `clockedInRoleId` role if configured, exactly as today.
  - Autocomplete: "No task — general work" first, then tasks you hold, then tasks in your
    projects, capped at Discord's 25 choices and labelled with `taskChoiceLabel`.
- **`/clock-out [note]`** — closes the entry, replies with the session length and the
  task's new total, and removes the role.
- **`/log-time task: duration: [when] [note]`** — retroactive. `when` accepts `today`,
  `yesterday` or `YYYY-MM-DD` and defaults to today; the entry's timestamps are derived as
  `end = when at the current time of day`, `start = end - duration`. Source `manual`.
- **`/my-time [range]`** — your running timer, your totals by task and your entries, this
  week by default. Each entry can be edited or deleted from a picker (panel-plus-modal,
  the `taskHub` pattern).
- **`/time-report [person] [project] [task] [range]`** — leadership only. Totals per
  person, per project and per task, with logged-versus-estimate where an estimate is set.

`bot/src/config/command-config.json` gains entries for the three new commands and updated
text for the two rewritten ones.

## 7. Forgotten timers — `bot/src/services/clockWatch.js`

`startClockWatch(client, { db, intervalMs })` from `bot/src/index.js`, modelled on
`startMemberNameSync`: runs at startup and every **5 minutes**, takes the db as a seam,
logs and swallows its own failures.

Each pass reads open entries (`clockOutAt IS NULL`) and, per entry:

- **`remind`** (running ≥ `clockReminderHours`, default 6, `remindedAt` unset): DM the
  person — "Still on **Router fix**? It's been 6h." — with **Keep going** and **Stop now**
  buttons, then set `remindedAt`. *Keep going* clears nothing and simply acknowledges;
  *Stop now* closes the entry at the current time.
- **`stop`** (running ≥ `clockCapHours`, default 12): close the entry at
  `clockInAt + capHours`, set `source = 'auto_stopped'`, and DM the person so they can fix
  it with `/log-time`. An auto-stopped entry is visibly flagged everywhere it appears, so
  a capped guess is never mistaken for a measurement.

Buttons `clk_keep:<entryId>` and `clk_stop:<entryId>` are routed in
`bot/src/handlers/interactions.js` beside the existing `uth_` / `utf_` routes.

## 8. Estimates

`task.estimateMinutes`, set from a new **Time** panel on the task hub
(`services/taskHub.js`), reached by a **Time** button next to *Subtasks*. The panel shows
the logged total, the estimate, the per-person split and buttons to **Set estimate** and
**Log time**. The Edit-details modal is already at Discord's five-component limit, so it is
not touched.

Reports and the site then read "3h 20m of 8h (41%)", and flag anything past its estimate.

## 9. CSAAS

**`discordTasks.js`** gains one query, grouped so a single pass serves both the task total
and the per-person breakdown:

```sql
SELECT taskId, discordId, SUM(minutes) AS minutes
FROM granjur.clockentry
WHERE guildConfigId IN (...) AND taskId IS NOT NULL AND minutes IS NOT NULL
GROUP BY taskId, discordId
```

Each task then carries `timeLogged` (minutes), `estimateMinutes`, and `timeByPerson`
(`discordId`, `name`, `avatarUrl`, `minutes`), with the people resolved through the
existing `personOf` helper so a former member reads as "Former member" rather than an id.
The query is wrapped in the established `.catch()` fallback: if `clockentry.minutes` does
not exist yet, tasks come back with no time rather than the page failing.

**A new `DiscordTimeReport` API object** for the Team → Time tab, shaped like
`DiscordTasks_object` (`accessToken: true`, permission enforced in the handler). It takes a
date range and returns per-person and per-project totals. Its handler enforces the
permission split in §11.

## 10. UBS-Doc

- **Task detail:** a **Time** section — total, an estimate bar when an estimate is set, and
  a row per person with their avatar and total.
- **List rows and board cards:** a small `3h 20m` chip beside the existing scope and
  subtask chips.
- **Team → Time tab:** totals per person, per project and per week, with a week picker.
- Pure logic (formatting, aggregation, the week picker's ranges) goes in
  `src/screens/team/timeLogic.ts` with vitest coverage, matching `hierarchyLogic.ts` and
  `activityLogic.ts`.
- Every new field is optional in `TaskRow`, so a site deployed ahead of CSAAS or the bot
  renders exactly as it does today.

## 11. Who sees what

- **Your own time**: always visible and editable by you.
- **CEO / Server Manager** (`memberPassesRoleGate` + `LEADERSHIP_ROLE_NAMES`, the
  `/update-task` gate): everyone's time, and may correct anyone's entry.
- **On the site**: the per-task breakdown is visible to anyone who can already see the
  Team section — it is the same shape as the assignees and history already shown there.
  The **Team → Time tab shows your own totals to everyone**, and everyone's totals only to
  a holder of a new `view_discord_time` permission. That way the tab is useful on day one
  and cannot leak the whole team's hours to whoever is granted nothing.
- **Every correction** — an edited duration, a deleted entry, an estimate change — is
  written to the task activity log through `recordTaskActivity`, so "who changed this
  number" is answerable on the task's own page.

## 12. Testing

The project rule stands: **no test touches production**. Every function under test takes
`db` and, where it needs it, `getConfig` as seams; suites run with
`DATABASE_URL=poisoned://no-production-access`.

- **`utils/timeTracking.js`** — the bulk of the tests. Parsing (every accepted form, and
  each rejection: empty, text, zero, negative, `NaN`, `Infinity`), formatting across the
  boundaries, `entryMinutes` never negative and `null` while open, `runawayState`
  precedence and the once-only reminder, week boundaries across a timezone and across a
  Sunday/Monday edge, and overlap detection.
- **Commands** — fakes for `db`/`getConfig`: same-task re-clock-in changes nothing,
  different-task switches in one reply, `/clock-out` with no timer refuses, `/log-time`
  with unparseable input writes nothing, `/time-report` refuses a non-leadership caller,
  and a normal member cannot edit someone else's entry.
- **`clockWatch`** — a fake clock and a fake db: reminds once and only once, caps at the
  configured hour, marks `auto_stopped`, and one failing DM never stops the rest of the pass.
- **Invariant** — after every write path (start, stop, edit, manual, auto-stop),
  `minutes` equals `entryMinutes(clockInAt, clockOutAt)`.
- **CSAAS** — an assemble test for the new fields and a fallback test proving the read
  still answers when the columns are missing.
- **Site** — vitest over `timeLogic.ts`, plus type-check and build.

## 13. Rollout

Bot (migration 023) → CSAAS → site, the order used by the avatar, activity and hierarchy
work. Each step is independently safe: the site tolerates missing fields, CSAAS falls back
to the old select, and the bot's migration only adds nullable columns.

After deploy: `/clock-in` on a task, `/clock-out`, check the total on the task's page on
the site, then `/log-time` and `/my-time`.

## 14. Deliberately not in this design

- Auto-logging time from project voice channels.
- Approval, submission or locked weeks. The table gains no `status` column; adding one
  later is a nullable-column migration, not a restructure.
- Billing rates, costs or invoicing.
- Idle detection beyond the reminder and the cap.

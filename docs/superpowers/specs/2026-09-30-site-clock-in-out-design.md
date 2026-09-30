# Clock in and out on the site

Sub-project 5 of the owner's roadmap (see `.claude/state/backlog.md`). Design approved in
chat on 2026-09-30. Touches the bot, CSAAS and the UBS-Doc site. No database change.

## Owner's request

"Also clock in and clock out should be able to done in the ubs-doc site too."

Answers given while designing:
- The control sits in the Team header on every Team tab, and on each task page.
- Anyone linked to Discord can clock in and out. No site permission is needed.
- Also in this round: an optional note at clock-out, and a "who's clocked in" list for
  people with the time-report permission.
- Logging past time by hand, and editing entries, are out of scope.

## Current behaviour

- **`/clock-in task:<id | "-">`** (`bot/src/commands/clock-in.js`):
  - `-` means general work.
  - A task must pass `clockableTasks` (the member's projects, or leadership).
  - Clocking in while already on another task closes that entry (`closeEntry`) and
    starts a new one.
  - The same task replies "already clocked in… Nothing changed".
  - It writes `clockentry` (`clockInAt`, `taskId | null`, `source: 'timer'`).
  - It adds `cfg.clockedInRoleId` only when there was no open entry.
- **`/clock-out note?`** (`clock-out.js`):
  - It closes the open entry (`clockOutAt`, `minutes`, `note`).
  - It removes the role.
  - It replies with the session length and, for a task, the task total
    (`clockEntry.sumByTask`).
  - When there is no open entry it replies "You are not clocked in".
- **`services/clockWatch.js`** runs every 5 minutes:
  - It sends a DM reminder after `clockReminderHours` (default 6).
  - It auto-stops at `clockCapHours` (default 12).
- **The logic lives in the command files** and is bound to a Discord interaction. There
  is no shared service.
- **CSAAS's time endpoints** (`discordTimeEntries.js`, `discordTimeReport.js`) read only
  closed entries (`minutes IS NOT NULL`). Nothing reports an open entry.
- **The site's Time tab** (`src/screens/team/TimeTab.tsx`) shows totals and finished
  entries. `payload.viewer` carries the caller's linked Discord ids.

## Design

### 1. Bot: one clock service

A new module, `bot/src/services/clock.js`, with `db` and `cfg` passed in:

- **`clockIn({ db, cfg, guild, discordId, taskId })`** returns
  `{ outcome: 'started' | 'switched' | 'unchanged', entry, task, stopped }`.
  - `taskId` is `null` for general work.
  - A task that does not exist, or is not clockable for this member, throws
    `ClockError('That task is not available to clock in on.')`.
  - `stopped` is the task (or general work) just closed on a switch.
  - It adds the Clocked In role when starting from nothing. This is best-effort: a
    missing member or role never fails the clock-in.
- **`clockOut({ db, cfg, guild, discordId, note })`** returns
  `{ entry, minutes, task, taskTotalMinutes }`.
  - With no open entry it throws `ClockError('You are not clocked in.')`.
  - `note` is trimmed and capped at 500 characters.
  - It removes the role, best-effort.
- **`clockStatus({ db, cfg, discordId, now })`** returns
  `{ active: false }`, or `{ active: true, entryId, taskId, taskTitle, projectName,
  clockInAt, elapsedSeconds }`.
- **`clockedInNow({ db, cfg, now })`** returns a list of `{ discordId, name, avatarUrl,
  taskId, taskTitle, projectId, projectName, clockInAt, elapsedSeconds }`, one per open
  entry in the guild, longest first.

`/clock-in` and `/clock-out` become thin wrappers over `clockIn` and `clockOut`. Their
replies and behaviour are unchanged. `closeEntry` stays exported for the watcher and the
reminder buttons.

`clockWatch` is untouched. A site clock-in is an ordinary `source: 'timer'` entry, so the
reminder DM and the cap apply to it.

### 2. Bot: internal routes

New handlers in `bot/src/services/internalClockRoute.js`, registered in
`bot/src/server.js`'s `INTERNAL_ROUTES`. They reuse `guarded` (`x-internal-secret`) and
`guildOf`:

| Route | Body | 200 body |
|---|---|---|
| `POST /internal/clock/in` | `{ guildConfigId, discordId, taskId \| null }` | `{ ok, outcome, status, stopped }` |
| `POST /internal/clock/out` | `{ guildConfigId, discordId, note? }` | `{ ok, minutes, taskTitle, taskTotalMinutes }` |
| `POST /internal/clock/status` | `{ guildConfigId, discordId }` | `{ ok, status }` |
| `POST /internal/clock/active` | `{ guildConfigId }` | `{ ok, people: [...] }` |

- `discordId` must match `/^\d{1,32}$/` and be an approved staff member of that guild
  (`guildmember`, kind staff). Otherwise the route returns 400.
- A `ClockError` becomes 409 with its sentence.

### 3. CSAAS endpoints

A new file, `Src/Apis/ProjectSpecificApis/DiscordTasks/discordClock.js`, follows
`discordTasksWrite.js`'s pattern (`accessToken`, `bindActorToToken`, `callBot`):

| Endpoint | Needs | Calls |
|---|---|---|
| `POST /api/discord/clock/in` `{ task_id? }` | a link | `/internal/clock/in` |
| `POST /api/discord/clock/out` `{ note? }` | a link | `/internal/clock/out` |
| `GET /api/discord/clock/status` | a link (unlinked gives `{ linked: false }`) | `/internal/clock/status` |
| `GET /api/discord/time/active` | `view_discord_time` | `/internal/clock/active` |

- **Identity** comes from `resolveIdentity`. The caller needs a link, and there is no
  `seesAll` bypass. An unlinked caller gets 403 "Link your Discord account to clock in."
  (clock in and out) or `{ linked: false }` (status).
- **Guild:**
  - For clock in with a task: the task's guild. The caller must be linked in that guild,
    and the task must be visible to them (`assertCanTouchTask`-style; hidden gives 404).
  - Otherwise: the caller's first link.
- **No portal permission** is needed for in, out or status.
- **`/time/active`** uses the existing any-URDD permission check for `view_discord_time`.
  A task the caller cannot see is returned as `taskId: null, taskTitle: 'a task',
  projectName: null`, using the visibility rules the tasks payload already uses.

### 4. Site

- **API** (`src/components/discordTasks/api.ts`): `clockIn(taskId | null)`,
  `clockOut(note)`, `fetchClockStatus()`, `fetchClockedIn()`.
- **Logic** (`src/screens/team/clockLogic.ts`, pure and tested):
  - elapsed formatting (`1h 20m`);
  - the ticking computation from `elapsedSeconds` plus the time since the fetch;
  - the picker's task list: the payload's open tasks the viewer can see, with "General
    work" first, filtered by a search string;
  - the button state for a task page (`clock-in` / `switch` / `clock-out`);
  - the outcome messages.
- **`ClockControl`** in `TeamLayout`'s header, on every Team tab:
  - **Not linked:** the text "Link your Discord account to clock in".
  - **Clocked out:** a **Clock in** button opens a popover with a search box, "General
    work", and the task list.
  - **Clocked in:** "Clocked in 1h 20m · <task or General work>" with **Clock out**.
    That opens a small dialog with an optional note (up to 500 characters) and Confirm.
  - **Refresh:** it fetches status on mount, after each action, on the header's Refresh,
    and every 60 seconds. The elapsed time ticks locally each minute.
- **Task page** (`TaskDetail.tsx`): a button next to Edit.
  - Not clocked in: **Clock in on this task**.
  - Clocked in here: **Clock out**.
  - Clocked in elsewhere: **Switch to this task**.
  - It is hidden when not linked, or when the task is finished.
- **Time tab:** a "Clocked in now" card (person, task, elapsed), shown only when the
  report scope is `all` (the caller has `view_discord_time`). It is fetched with the
  report.
- **Errors:** the bot's or CSAAS's sentence is shown in the toast, using the existing
  `plainRuleMessage` handling.

## Testing (fakes only; `.claude/rules/tests-never-touch-production.md`)

- **Bot:**
  - `clock.js`: start, switch, unchanged, general work, a task that is not clockable, the
    role add and remove, and a role failure that does not fail the action.
  - `clockOut`: totals, the note cap, and the not-clocked-in error.
  - `clockStatus` and `clockedInNow` with an injected `now`.
  - The commands' existing tests pass unchanged.
  - The four routes: auth, validation, the 409 mapping, and the staff-member check.
- **CSAAS:**
  - the unlinked 403 and `{ linked: false }`;
  - no permission needed;
  - guild resolution;
  - a hidden task gives 404;
  - the `view_discord_time` gate and the redaction on `/time/active`;
  - bot errors passed through.
- **Site (vitest):** `clockLogic` (formatting, ticking, picker list and search, button
  state) and the API wrappers' request shapes.

## Rollout

Bot, then CSAAS (a push deploys it), then the site. Each part tolerates the others' old
versions: until CSAAS has the endpoints, the site's control shows "Clock unavailable"
and nothing else changes.

## Out of scope

- Logging past time by hand; editing or deleting entries on the site.
- Changing the reminder or cap.

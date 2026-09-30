# Clock in and out on the site

Roadmap sub-project 5 of 7 (owner roadmap, `.claude/state/backlog.md`). Built across the
bot, CSAAS and the site on branch `feat/site-clock` in each — **not merged, not
deployed.** No migration anywhere. Spec:
`docs/superpowers/specs/2026-09-30-site-clock-in-out-design.md`. The bot owns the clock
(its `clockentry` table and every rule about it); CSAAS only works out who the caller is
in Discord and asks the bot over loopback; the site renders it. Same trust shape as the
site's task-write routes (see [[project-tasks-site]]).

## Bot: one clock service, two front ends

`bot/src/services/clock.js` holds the rules. `/clock-in`, `/clock-out` and the site's
routes all call it, so they cannot drift. Nothing in it touches a Discord interaction;
`member` is optional and fetched on demand.

- `clockIn({ db, cfg, guild, discordId, taskId, member, now })` → `{ outcome, task,
  stopped, runningMinutes }`, outcome `started` | `switched` | `unchanged`. With a
  `taskId` the task must exist in this guild and pass `clockableTasks` (project member,
  leadership, or holder); a missing task and a forbidden one get the same refusal so it
  cannot probe for tasks. Same task already open → `unchanged`. A different open entry is
  closed first (`stopped: { title, minutes }`). New entries are `source: 'timer'`. The
  clocked-in role is added only when the person was not already clocked in (a switch
  leaves it alone).
- `clockOut({ ..., note })` → `{ minutes, task, taskTotalMinutes }`; note trimmed and cut
  to 500; removes the clocked-in role; `taskTotalMinutes` is a SQL `sumByTask`, `null` if
  that fails or for general work.
- `clockStatus` → `{ active: false }` or `{ active: true, entryId, taskId, taskTitle,
  projectName, clockInAt, elapsedSeconds }`. No task means title `General work`.
- `clockedInNow({ cfg })` → the guild's open entries, oldest first, with name and avatar
  from `guildMember` (read with `all: true`, or the roster is silently capped at 25),
  task and project names, `elapsedSeconds`.
- `closeEntry` moved here; `commands/clock-in.js` re-exports it so `/clock-out`,
  `clockWatch` and the reminder buttons keep importing it from there.
- A refusal is a `ClockError` (safe to show the asker).

The commands are thin wrappers: they only word the reply. The Discord refusal wording
differs from the service's: `/clock-in` says `That task is not available to you.`, the
service message (seen on the site) is `That task is not available to clock in on.`.
`/clock-out` maps a `ClockError` to `You are not clocked in. Use **/clock-in** first.`
(the service's own text is `You are not clocked in.`).

`clockWatch` (reminders and the auto-stop cap) is unchanged and applies to site
clock-ins like any other, since they are ordinary `clockentry` rows; an auto-stop writes
`source: 'auto_stopped'`.

### Internal routes (`bot/src/services/internalClockRoute.js`, wired in `server.js`)

Same guard as the task routes (shared secret, disabled when unset). Loopback only.
Every body carries `guildConfigId`; in/out/status also carry `discordId`.

| Route | Body | 200 body |
|---|---|---|
| `/internal/clock/in` | `guildConfigId`, `discordId`, `taskId?` (string ≤ 64 or null) | `{ ok, outcome, stopped, status }` (status is read after the clock-in) |
| `/internal/clock/out` | `guildConfigId`, `discordId`, `note?` (string) | `{ ok, minutes, taskTitle, taskTotalMinutes }` |
| `/internal/clock/status` | `guildConfigId`, `discordId` | `{ ok, status }` |
| `/internal/clock/active` | `guildConfigId` | `{ ok, people }` |

Errors: 400 for a missing/unknown `guildConfigId`, a non-numeric `discordId`, a bad
`taskId` or `note`; 500 when the Discord guild is not available to the bot. For in, out
and status the `discordId` must be an **approved staff** `guildMember` in that guild: a
missing row, a non-approved status or `kind === 'client'` gives 400 `No staff member
matches that Discord account.` (a row from before the `kind` column counts as staff, as in
the daily report). `/active` needs no member. A `ClockError` becomes **409** with its
message; anything else falls through to the shared guard's logged 500.

## CSAAS: `DiscordClockIn/Out/Status`, `DiscordTimeActive`

`Src/Apis/ProjectSpecificApis/DiscordTasks/discordClock.js`. No registry edit: the file
is auto-required and each URL maps to the global object name set in the file:

| URL | Global object | Method |
|---|---|---|
| `/api/discord/clock/in` | `DiscordClockIn_object` | POST (`task_id`) |
| `/api/discord/clock/out` | `DiscordClockOut_object` | POST (`note`) |
| `/api/discord/clock/status` | `DiscordClockStatus_object` | GET |
| `/api/discord/time/active` | `DiscordTimeActive_object` | GET |

All four use `accessToken` with `bindActorToToken`, and `permission: null` (each handler
does its own check). Tests replace everything through `__setTestHooks`; nothing opens a
socket or database.

**In, out and status are link-only, with no admin or `seesAll` bypass.** The caller needs
a stored Discord link and nothing else. An unlinked admin has no Discord member to clock,
so `assertCanWrite` (which waves such callers through) is deliberately not used: they get
403 `Link your Discord account to clock in.` (`status` instead answers `{ linked: false }`).

- **Clock in, guild resolution:** with a `task_id` the task's guild is used. The caller
  must be linked in that guild and able to see the task (same rule as
  `assertCanTouchTask`); an unknown, hidden or other-guild task all give 404 `No task
  matches that id.` so a hidden task's existence is never confirmed. Without a `task_id`
  it is the caller's **first link**. Response `{ outcome, stopped, status }`.
- **Clock out and status:** the open clock may be in any guild the caller is linked to.
  One link: used directly. Several: each linked guild is probed with the bot's status
  route; the first with a running clock wins, else the first link that answered. A
  failing probe counts as "not active here", and the error surfaces only when **every**
  probe fails (so a failure is never reported as "not clocked in").
- `task_id` must be a string of at most 64 characters; `note` a string of at most 500.
- **`/time/active`** needs `view_discord_time` (on any of the caller's URDDs). It uses the
  **same guild scope as the time report** (the `timeScope.js` helpers `callerIdentity`
  and `resolveCfgIds`): a linked caller gets their linked guild, an unlinked permission
  holder gets every guild, so the "Clocked in now" card and the report on one tab agree.
  People whose task the viewer cannot see are redacted to `taskId: null, taskTitle: 'a
  task', projectId: null, projectName: null` (entries with no task, and `seesAll`
  viewers, are left as sent; a failed task lookup is a 502). A bot failure for **any**
  guild fails the whole request, because a silently partial list reads as "nobody else is
  working". Sorted longest-running first.

**Gotcha (found in review here):** any DiscordTasks file that passes its hooks to
`resolveIdentity` must include `actorIsRoleAdmin` in those hooks. A test suite that always
fakes `resolveIdentity` cannot catch its absence, so the first real call would fail.
`discordClock.js` carries it in `__hooks`.

## Site

- `src/components/discordTasks/api.ts`: `clockIn(taskId)`, `clockOut(note)`,
  `fetchClockStatus()`, `fetchClockedIn()`. `apiCall` surfaces the bot's sentence
  (403 not linked, 404 no such task, 409 refusal) as `ApiError.message`.
- `src/screens/team/clockLogic.ts`: pure helpers (elapsed math, the picker's choices —
  `General work` first, then open tasks the payload holds, capped — which action a task
  page offers, toast sentences).
- `src/screens/team/ClockControl.tsx`: `useClock()` is called once in `TeamLayout` and the
  result is shared through the Team context, so the header control and the task page see
  one status and every action refreshes it for both. The header shows a Clock in picker
  (search box) when idle, or `Clocked in <elapsed> · <task>` with Clock out (a dialog with
  an optional 500-character note) when running.
- **Task page** (`TaskDetail.tsx`): a button on a non-terminal task, hidden for an
  unlinked viewer, while the clock is unavailable and while editing. Label is `Clock in on
  this task`, `Switch to this task`, or `Clock out` (`taskClockAction`).
- **Time tab** (`TimeTab.tsx`): a `Clocked in now` card, shown only when the report's
  scope is `all`, fetched alongside the report; its elapsed time ticks from the fetch
  too.
- **Refresh:** the status is fetched on mount and every 60 s.
- **Elapsed ticks from the bot's `elapsedSeconds` plus the time since the status was
  received (`elapsedNow`), never from `clockInAt`.** The viewer's browser clock or
  timezone may disagree with the server's; only the server's own count is trusted.
- **Failure handling:** `Clock unavailable` shows only while no status fetch has ever
  succeeded (`linked` is still `null`). A failed refresh keeps the last good status, so a
  running clock never loses its Clock out button, and it raises no toast (the 60 s
  refresh must not loop error messages). The clock-in and clock-out responses are applied
  directly (clock-in's `status`; clock-out sets inactive) and a follow-up refresh runs, so
  a failing refresh cannot hide a successful action. Action errors become a toast.
- A picker or clock-out dialog left open while the clock changes underneath it is closed.
- A task the viewer cannot see arrives as `a task` (never shown as General work).

## Rollout

Bot → CSAAS → site, each push needing the owner's go-ahead. No migration. CSAAS
auto-deploys on push to its `main`; the site deploys on Vercel. The site must go last:
against an older CSAAS the status fetch fails and the control just reads `Clock
unavailable`. See `.claude/state/backlog.md` (roadmap item 5) for the deferred items.

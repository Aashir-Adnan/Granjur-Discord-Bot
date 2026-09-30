# Clock In and Out on the Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A linked site user can clock in (on a task or general work) and clock out (with an optional note) from the UBS-Doc Team section, see their running clock everywhere in it, and people with the time-report permission see who is clocked in now.

**Architecture:** The clock rules move out of the `/clock-in` and `/clock-out` command files into one bot service (`services/clock.js`) that both the commands and four new internal routes call. CSAAS adds four endpoints that resolve the caller's linked Discord member (no portal permission for self actions) and call those routes. The site adds a header clock control, a task-page button and a "Clocked in now" card.

**Tech Stack:** Bot: Node ESM, discord.js v14, `node:test`. CSAAS: Node CommonJS, UBS framework, jest + standalone node test scripts. Site: React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-site-clock-in-out-design.md`

## Global Constraints

- The clock rules are unchanged: `-`/null task = general work; a task must pass `clockableTasks` (the member's projects, or leadership); clocking in on another task closes the open entry and starts a new one; the same task changes nothing; the Clocked In role is added only when starting from nothing and removed on clock-out; entries are `source: 'timer'`; `clockWatch`'s reminder and cap apply unchanged.
- `/clock-in` and `/clock-out` keep their exact replies and behaviour; their existing tests (`bot/src/commands/clock.test.js`) must pass unchanged.
- Self actions (in, out, status) need only a link between the site account and a Discord member — no portal permission, and no `seesAll`/admin bypass. "Who's clocked in" needs `view_discord_time`.
- Verbatim strings: `That task is not available to clock in on.`; `You are not clocked in.`; `Link your Discord account to clock in.`; site control texts `Clock in`, `Clock out`, `Clock in on this task`, `Switch to this task`, `General work`, `Clocked in now`, `Clock unavailable`.
- A clock-out note is trimmed and capped at 500 characters.
- A task the viewer cannot see is never named: `taskId: null, taskTitle: 'a task', projectName: null`.
- No database change.
- Bot tests use fakes for every `db`/`getConfig` seam — never the default `db`, never a real server (`.claude/rules/tests-never-touch-production.md`; the root `.env` is production). Never read any `.env`.
- Commits: `git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit ...`; message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` — exactly that.
- A piped test summary can exit 0 while red: read `ℹ fail` (bot), `Tests:` (jest), vitest's `Tests` line.

## Workspaces

- Bot: `D:\Work\Granjur Technologies\Granjur-Discord-Bot`, branch `feat/site-clock` (checked out; spec commit `6293d31`). Tasks 1, 2, 5.
- CSAAS: `D:\Work\Granjur Technologies\CSAAS_Backend`, create `feat/site-clock` from `main` (leave its untracked `.bridge/`, `.worktrees/`, `data/migrations_completed/*` alone). Task 3.
- Site: never touch `D:\Work\Granjur Technologies\UBS-Doc`. `git -C "D:/Work/Granjur Technologies/UBS-Doc" fetch origin main`, then `git -C "D:/Work/Granjur Technologies/UBS-Doc" worktree add "D:/Work/Granjur Technologies/UBS-Doc-site-clock" -b feat/site-clock origin/main`, then `npm ci`. Task 4.

## Review Focus

1. A site clock-in on a task the member could not pick in Discord (not in their projects, not leadership) must be refused with the same rule — Task 1 + Task 2 tests.
2. An unlinked admin (sees everything on the site) must NOT be able to clock in — there is no Discord member to clock — Task 3 test.
3. A role failure (member left the server, missing permission) must not fail or undo a clock-in/out — Task 1 test.
4. The "Clocked in now" list must not leak the title of a task the viewer cannot see — Task 3 test.
5. The header's elapsed time must be right even when the viewer's browser clock or timezone differs from the bot's — it ticks from the bot's `elapsedSeconds`, never from `clockInAt` — Task 4 test.

---

### Task 1: Bot — the clock service, and the commands as thin wrappers

**Files:**
- Create: `bot/src/services/clock.js`
- Modify: `bot/src/commands/clock-in.js`, `bot/src/commands/clock-out.js`
- Test: `bot/src/services/clock.test.js` (new); `bot/src/commands/clock.test.js` (must pass unchanged)

**Interfaces:**
- Consumes (existing): `db.clockEntry.{findActive(guildId, discordId), create({data}), update(id, data), findMany({where}), sumByTask({guildConfigId, taskIds})}`; `db.task.findFirst`; `clockableTasks` (`utils/timeTaskPicker.js`); `memberProjectIdsOf`, `isLeadershipFor` (`utils/timeAccess.js`); `entryMinutes`, `formatDuration` (`utils/timeTracking.js`). Note `findActive` takes the **Discord guild id** (`guild.id`), not `cfg.id`.
- Produces (from `bot/src/services/clock.js`):
  - `class ClockError extends Error`
  - `closeEntry(dbArg, entry, { at, note, source })` — moved here; `clock-in.js` re-exports it so `clock-out.js`, `clockWatch.js` and the reminder buttons keep working unchanged.
  - `async clockIn({ db, cfg, guild, discordId, taskId, member?, now? })` → `{ outcome: 'started'|'switched'|'unchanged', task: object|null, stopped: { title: string, minutes: number }|null, runningMinutes: number|null }`. `taskId` null = general work. Task missing or not clockable → `throw new ClockError('That task is not available to clock in on.')`. `member` is optional (the Discord command passes `interaction.member`); when absent the service does `guild.members.fetch(discordId).catch(() => null)` and treats a missing member as not leadership. Role add best-effort, only when there was no open entry.
  - `async clockOut({ db, cfg, guild, discordId, note, member?, now? })` → `{ minutes, task: object|null, taskTotalMinutes: number|null }`; no open entry → `throw new ClockError('You are not clocked in.')`; `note` trimmed, capped at 500, empty → null. Role remove best-effort. `taskTotalMinutes` from `sumByTask` (null for general work or when the sum fails).
  - `async clockStatus({ db, cfg, guild, discordId, now? })` → `{ active: false }` | `{ active: true, entryId, taskId, taskTitle, projectName, clockInAt, elapsedSeconds }` (`taskTitle` `'General work'` and `projectName` null for general work; `elapsedSeconds` = whole seconds between `clockInAt` and `now`, never negative).
  - `async clockedInNow({ db, cfg, now? })` → `[{ discordId, name, avatarUrl, taskId, taskTitle, projectId, projectName, clockInAt, elapsedSeconds }]` for every open entry of the guild (`clockEntry.findMany({ where: { guildConfigId: cfg.id, openOnly: true } })`), longest-running first; names/avatars from the guild's member rows (find the existing db function used elsewhere for member names, e.g. what the time report uses), falling back to the Discord id.

- [ ] **Step 1: Write the failing tests** `bot/src/services/clock.test.js` with an in-memory fake db (arrays for clock entries, tasks, projects, members) and a fake guild (`members.fetch` → `{ roles: { add, remove } }` recording calls). Cases, one test each:
  1. general work from nothing → `outcome: 'started'`, one entry `{ taskId: null, source: 'timer' }`, role added once;
  2. a clockable task → started, entry carries the task id;
  3. a task outside the member's projects (and not leadership) → `ClockError` with the exact message; nothing written; a missing task → the same error;
  4. already on the same task → `unchanged`, `runningMinutes` set, nothing written, role untouched;
  5. switching → the old entry closed with minutes, `stopped.title` = the old task's title (or `'general work'`), a new entry created, role NOT added again;
  6. `roles.add` rejecting, and `members.fetch` returning null → the clock-in still succeeds;
  7. `clockOut` → entry closed, `minutes` right for an injected `now`, role removed, `taskTotalMinutes` from `sumByTask`; general work → `task: null, taskTotalMinutes: null`;
  8. `clockOut` note: `'  done  '` → `'done'`; 600 chars → 500; blank → no note written;
  9. `clockOut` with nothing open → `ClockError('You are not clocked in.')`;
  10. `clockStatus`: none → `{ active: false }`; open general → `taskTitle: 'General work'`; open task → title + project name; `elapsedSeconds` from the injected `now`;
  11. `clockedInNow`: two open entries → longest first, names from member rows, fallback to the id; closed entries excluded.
- [ ] **Step 2: Run** `node --test bot/src/services/clock.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement** `services/clock.js` by moving the logic out of the two commands. Then rewrite `clock-in.js`'s `execute` to: resolve cfg, map the picked value (`GENERAL` → null), call `clockIn({ db: dbArg, cfg, guild, discordId: interaction.user.id, taskId, member: interaction.member })`, and build the SAME reply strings from the result (`unchanged` → "You are already clocked in on … (running for **X**). Nothing changed."; `switched` → "Stopped **T** (D) · started …"; `started` → "**Clocked in** on …"); a `ClockError` → the command's existing `NOT_AVAILABLE` text (`That task is not available to you.` — the Discord wording stays as it is). Rewrite `clock-out.js`'s `execute` to call `clockOut` and build the same replies (`ClockError` → `You are not clocked in. Use **/clock-in** first.`). Keep `export const GENERAL`, `data`, `autocomplete` and `export { closeEntry }` in `clock-in.js`.
- [ ] **Step 4: Run** `node --test bot/src/services/clock.test.js bot/src/commands/clock.test.js bot/src/services/clockWatch.test.js` → all pass, and `bot/src/commands/clock.test.js` has NO edits (`git diff --stat` shows it untouched). Then `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `refactor(clock): one clock service for /clock-in, /clock-out and the site`.

---

### Task 2: Bot — internal clock routes

**Files:**
- Create: `bot/src/services/internalClockRoute.js`
- Modify: `bot/src/services/internalTaskRoute.js` (export `guarded` and `guildOf`; nothing else), `bot/src/server.js` (`INTERNAL_ROUTES`)
- Test: `bot/src/services/internalClockRoute.test.js`

**Interfaces:**
- Consumes: `clockIn`, `clockOut`, `clockStatus`, `clockedInNow`, `ClockError` (Task 1); `guarded({ headers, body, secret, route }, handler)` and `guildOf(db, client, guildConfigId)` → `{ cfg, guild }` from `internalTaskRoute.js`.
- Produces: `handleClockInRequest`, `handleClockOutRequest`, `handleClockStatusRequest`, `handleClockActiveRequest`, each `({ headers, body, db, client, secret, ...seams }) → { status, body }`, registered at `/internal/clock/in`, `/out`, `/status`, `/active`.
  - Body `{ guildConfigId, discordId, taskId|null }` / `{ guildConfigId, discordId, note? }` / `{ guildConfigId, discordId }` / `{ guildConfigId }`.
  - 200 bodies: in → `{ ok: true, outcome, stopped, status }` (`status` = `clockStatus` after the action); out → `{ ok: true, minutes, taskTitle, taskTotalMinutes }`; status → `{ ok: true, status }`; active → `{ ok: true, people }`.
  - 400 when `guildConfigId` is missing/unknown, when `discordId` doesn't match `/^\d{1,32}$/`, or when that id is not an approved **staff** member of the guild (use the existing `guildMember` lookup the routes/services already use for members; a client or an unknown member → `No staff member matches that Discord account.`); `note` not a string → 400.
  - `ClockError` → 409 `{ ok: false, message }`. The server/guild unavailable → 500 like the task routes.

- [ ] **Step 1: Write the failing tests** (follow `internalTaskRoute.test.js`'s fakes): missing/wrong secret → 401/503 exactly as the task routes; each validation 400; a non-staff/unknown member → 400 with the message; in → calls the clock service seam with `{ cfg, guild, discordId, taskId }` and returns `outcome` + `status`; a `ClockError` → 409 with its sentence; out passes the note through; status and active return the service results; an unknown route path is still 404 at the server level (unchanged).
- [ ] **Step 2: Run** `node --test bot/src/services/internalClockRoute.test.js` → FAIL.
- [ ] **Step 3: Implement**; export `guarded`/`guildOf`; register the four routes in `server.js`.
- [ ] **Step 4: Run** the test file, `node --check bot/src/server.js`, and `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(internal): clock in, out, status and who-is-clocked-in routes for the site`.

---

### Task 3: CSAAS — clock endpoints

Work in `D:\Work\Granjur Technologies\CSAAS_Backend`: `git checkout -b feat/site-clock main`.

**Files:**
- Create: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordClock.js`
- Modify: wherever the DiscordTasks API objects are registered/exported (follow how `discordTasksWrite.js` and `discordTimeReport.js` are wired)
- Test: `Services/SysScripts/TestScripts/discord-tasks-test/clock.test.js` (standalone node script, same style as its siblings, using `__setTestHooks`)

**Interfaces:**
- Consumes: `resolveIdentity` (`identity.js`), the visibility helpers (`visibility.js`: task visibility / hidden task ids), `callBot` + `botConfig` (`botLink.js`), `requirePermissionOnAnyUrdd` (`portalAuthz.js`), and the write-object pattern of `discordTasksWrite.js` (`accessToken: true`, `bindActorToToken: true`, `permission: null`).
- Produces four endpoints:
  - `POST /api/discord/clock/in` `{ task_id? }` → the bot's `{ outcome, stopped, status }`.
  - `POST /api/discord/clock/out` `{ note? }` → `{ minutes, taskTitle, taskTotalMinutes }`.
  - `GET /api/discord/clock/status` → `{ linked: false }` for an unlinked caller, else `{ linked: true, status }`.
  - `GET /api/discord/time/active` → `{ people }`, needs `view_discord_time`.
- Rules:
  - in/out: no portal permission. No link → 403 `Link your Discord account to clock in.` — **including for admins/`seesAll`** (do not use `assertCanWrite`, which bypasses the link check for them).
  - Guild and member: with `task_id` → load the task's `guildConfigId`; the caller must have a link in that guild and the task must be visible to them (hidden or unknown → 404 `No task matches that id.`); the linked `discordId` for that guild is sent. Without `task_id` (and for out/status) → the caller's first link.
  - `note`: string, ≤ 500 after trim, else 400.
  - `/time/active`: `requirePermissionOnAnyUrdd(..., 'view_discord_time')`; calls the bot for each guild the caller is linked to (or, for a `seesAll` caller, every visible guild — follow how `discordTimeReport.js` scopes guilds); any entry whose task is hidden from the caller is returned with `taskId: null, taskTitle: 'a task', projectId: null, projectName: null`.
  - Bot errors: pass 400/404/409 messages through via `callBot`'s existing mapping.

- [ ] **Step 1: Write the failing test script** covering: unlinked → 403 with the exact sentence for in and out, `{ linked: false }` for status; an unlinked admin/`seesAll` identity → still 403; linked, no `task_id` → `callBot` called with `/internal/clock/in` and `{ guildConfigId, discordId, taskId: null }`; with a visible `task_id` → that task's guild and the link's discordId for that guild; a hidden task → 404, bot never called; note over 500 → 400; `/time/active` without the permission → 403, with it → people returned and a hidden task's entry redacted; a bot 409 message passed through.
- [ ] **Step 2: Run** `node Services/SysScripts/TestScripts/discord-tasks-test/clock.test.js` → FAIL.
- [ ] **Step 3: Implement** and register the endpoints.
- [ ] **Step 4: Run** the new script and the regression loop `for f in Services/SysScripts/TestScripts/discord-tasks-test/*.test.js; do node "$f" >/dev/null 2>&1 || echo "FAILED $f"; done` → no `FAILED`; `npx jest Services/SysScripts/TestScripts/portalAnyUrddPermission.test.js` → passes.
- [ ] **Step 5: Commit** `feat(discord-clock): clock in, out, status and who-is-clocked-in for the site`.

---

### Task 4: Site — the clock control, the task-page button, and "Clocked in now"

Work in the worktree `D:\Work\Granjur Technologies\UBS-Doc-site-clock` (see Workspaces).

**Files:**
- Modify: `src/components/discordTasks/api.ts`, `src/screens/team/TeamLayout.tsx`, `src/screens/team/TaskDetail.tsx`, `src/screens/team/TimeTab.tsx`
- Create: `src/screens/team/clockLogic.ts`, `src/screens/team/ClockControl.tsx`
- Test: `src/screens/team/clockLogic.test.ts`

**Interfaces:**
- `api.ts`: `clockIn(taskId: string | null)`, `clockOut(note: string)`, `fetchClockStatus()` → `{ linked: boolean; status?: ClockStatus }`, `fetchClockedIn()` → `{ people: ClockedInPerson[] }` — built like the existing wrappers (`apiCall`, same error surfacing).
- `clockLogic.ts` (pure): `formatElapsed(seconds)` → `'45m'`, `'1h 20m'`, `'0m'`; `elapsedNow(status, fetchedAtMs, nowMs)` → seconds (= `status.elapsedSeconds + floor((nowMs - fetchedAtMs)/1000)`, never negative, never uses `clockInAt`); `clockTaskChoices(projects, query)` → `[{ id: null, label: 'General work' }, ...open (non-finished) tasks the payload holds, filtered case-insensitively by title or project name, max 50]`; `taskClockAction(status, taskId)` → `'clock-in' | 'switch' | 'clock-out'`; `clockOutcomeText(result)` → `Clocked in on <task>.` / `Switched from <old> to <new>.` / `Already clocked in on <task>.`; `clockOutText(result)` → `Clocked out — <session>.`
- `ClockControl` (in `TeamLayout`'s header, every tab): unlinked → text `Link your Discord account to clock in`; status fetch failing → `Clock unavailable`; clocked out → `Clock in` button → popover (search box, `General work`, tasks); clocked in → `Clocked in <elapsed> · <task>` + `Clock out` → a small dialog with an optional note textarea (maxLength 500) and Confirm. Fetches on mount, after each action, when the header Refresh is pressed, and every 60 s; re-renders the elapsed text every 60 s. Shares its status with the rest of the Team section through the existing Team context (add `clock: { status, refresh }`).
- `TaskDetail.tsx`: next to Edit, hidden when unlinked or the task is finished: `Clock in on this task` / `Switch to this task` / `Clock out` per `taskClockAction`, calling the same actions and refreshing the shared status.
- `TimeTab.tsx`: when the report scope is `all`, a `Clocked in now` card listing name, task (or `General work` / `a task`), and `formatElapsed`, fetched with the report; empty → `Nobody is clocked in.`

- [ ] **Step 1: Write the failing tests** `clockLogic.test.ts`: `formatElapsed` (0, 59 s, 45 min, 80 min, 25 h); `elapsedNow` adds the time since fetch, clamps at 0, and ignores a wildly different `clockInAt`; `clockTaskChoices` puts General work first, drops finished tasks, filters by title and by project name, caps at 50; `taskClockAction` for clocked out / same task / another task / general work; the outcome texts for started, switched, unchanged and clock-out.
- [ ] **Step 2: Run** `npx vitest run src/screens/team/clockLogic.test.ts` → FAIL.
- [ ] **Step 3: Implement** the logic, API wrappers, `ClockControl`, the task-page button and the Time tab card, matching the surrounding style (Tailwind classes, light/dark theme handling, the existing toast for results and errors via `plainRuleMessage`).
- [ ] **Step 4: Run** `npx vitest run` (all), `npx tsc --noEmit`, `npm run build` → all clean.
- [ ] **Step 5: Commit** `feat(team): clock in and out from the site; who is clocked in now`.

---

### Task 5: Full suites, knowledge and state

**Files:** `.claude/knowledge/` (new `site-clock.md` + README index line; a pointer in `project-tasks-site.md`), `.claude/state/backlog.md`, `.claude/state/completed.md`, `.claude/state/session.md`.

- [ ] **Step 1:** bot `npm test` (`ℹ fail 0`); CSAAS `clock.test.js` + the discord-tasks script loop; site `npx vitest run` in the worktree.
- [ ] **Step 2: Knowledge** — `site-clock.md`: the clock service and that the commands wrap it; the four internal routes and their bodies; CSAAS's endpoints, the link-only rule with no admin bypass, guild resolution, redaction; the site control, the task-page button, the Time tab card, the 60 s refresh and why elapsed ticks from `elapsedSeconds`.
- [ ] **Step 3: State** — backlog: roadmap item 5 → BUILT, NOT DEPLOYED, rollout bot → CSAAS → site; completed: a 2026-09-30 entry with commits per repo; session: current state.
- [ ] **Step 4: Commit** `docs: clock in and out on the site — knowledge and state`.

---

## Rollout (after merge; each push needs the owner's go-ahead)

1. Push the bot's `main` (no migration).
2. Push CSAAS `main` (auto-deploys).
3. Push the site (Vercel).

# Project tasks on the UBS-Doc site

Every task in the bot's database, grouped by project, with owners, multiple assignees,
and blocking dependencies, shown live at `https://ubs-doc.vercel.app/tools/tasks`. No
copy of the data anywhere else, no rebuild to refresh.

Spec: `docs/superpowers/specs/2026-09-17-project-tasks-site-section-design.md`.
Plan: `docs/superpowers/plans/2026-09-17-project-tasks-site-section.md`.

## Data path

```
UBS-Doc /tools/tasks  ---GET--->  CSAAS /api/discord/tasks  ---SQL--->  granjur.* (bot's MySQL)
  (behind ToolGuard)              (public, no token)                    guildconfig, project,
                                                                         task, taskdependency,
                                                                         projectmember, guildmember
```

- The site already calls CSAAS at `https://api.gobizzi.com` (nginx to port 3000 on the
  VM) for other Dev Tools screens; this endpoint follows the same path.
- **CSAAS reads the bot's tables directly, cross-database, with no API in between.**
  This only works because CSAAS's MySQL user is `root@localhost` with grants on `*.*`,
  and the bot's `granjur` database lives on the same physical server. Every query in
  the handler is fully qualified (`granjur.task`, `granjur.guildconfig`, …). If CSAAS's
  DB user is ever scoped down from `root`, this endpoint breaks silently (empty
  results, not an error) unless the new user is granted at least `SELECT` on
  `granjur.*`.
- The endpoint **requires the portal access token** (`verification: { accessToken: true }`,
  no encryption, `permission` still null — a read needs only proof the caller is signed
  in). It was public in the 2026-09-17 build, matching the portal's other read endpoints
  (`/api/portal/users/list`, `/api/projects/tenant/list`), because `ToolGuard` protects
  the `/tools/tasks` page and not the data — but the Team section added descriptions and
  scope to the response, and anyone with the URL could `curl` those alongside titles,
  Discord ids and member names. Closed in the 2026-09-18 build. Every consumer sits
  behind the portal gate and the site's fetch wrapper already sends the token, so nothing
  on the site had to change. **A bare `curl` now returns 401** — see "How to verify".
- The framework wraps a post-process function's return value as `payload.return`. The
  site's fetch helper unwraps `payload.return ?? payload ?? data` — the same pattern
  used for every other portal call (`mwGet`).

## Schema (bot, migration `017_task_dependencies_project_members.sql`)

Three additions, all guarded with the `information_schema` re-run pattern from
migration 016, all `COLLATE=utf8mb4_general_ci` at table level (required for the FKs to
`task`/`project`/`guildconfig`, same reason as migrations 007 and 012).

1. **`taskdependency`** — one row per "task A is blocked by task B" (`taskId`,
   `blockedByTaskId`). `UNIQUE (taskId, blockedByTaskId)`.
2. **`projectmember`** — the explicit project-to-developer list (`projectId`,
   `discordId`, `role` in `lead`/`developer`/`backend_developer`/`frontend_developer`/`qa`/`design`). `UNIQUE (projectId, discordId)`,
   upsert on re-add (changes the role).
3. **`guildmember.displayName` / `guildmember.username`** — two new nullable columns,
   filled by the name sync below.

**Blocked is computed, never stored.** A task is blocked while any `taskdependency` row
names it as `taskId` and the blocker's `task.status` is not one of the notifier's
`TERMINAL_STATUSES` (`closed`, `done`, `resolved`). Both `bot/src/utils/taskDeps.js`
(`openBlockers`, `isBlocked`) and the CSAAS aggregation (`assembleTasks`) recompute this
from the same rule on every read — there is no "blocked" flag anywhere in the DB, so a
stored dependency automatically becomes live/stale correctly as the blocker's status
changes.

## `/update-task`: dependency options and the cycle refusal

Four new options beyond the existing ones: `add_assignee` / `remove_assignee` (user;
no-op if already applied), `blocked_by` / `unblock` (string, autocomplete on the task
picker).

`blocked_by` is refused, with a plain reply and no write, in three cases:
- the value names the task itself,
- the blocker task does not exist in this guild,
- `wouldCycle(taskId, blockerId, depRows)` is true — walking `blockedByTaskId` edges
  from the proposed blocker already reaches the task being updated (depth-first; the
  per-guild graph is small enough that this is cheap). The message names both tasks:
  `**B** already depends on **A**, so **A** cannot be blocked by **B**.`

`unblock` narrows its autocomplete to the task's current blockers when the `task`
option is already filled in on the interaction, otherwise falls back to the full list.
Removing an absent dependency row is a no-op, not an error.

When a status change lands on a task that still has open blockers, the command reply
and the notifier's channel post both end with `blockerWarning(openBlockers)`
(`⛔ Still blocked by: **Title A** (open), …`) — a warning, never a refusal. When a task
reaches a terminal status, every task it blocks gets `unblockNotice(...)` posted to its
channel (best-effort, same try/catch shape as the existing DM path).

**`/close-feature` and `/resolve-bug` bypass all of this.** They change `task.status`
directly, not through `notifyTaskUpdate`, so neither one ever shows a blocker warning
or fires an unblock notice for tasks that depend on them. A task closed through those
two commands can silently unblock its dependents with no notice posted anywhere.

## `/project-members` and inferred membership

`CEO` / `Server Manager` / `Project Manager` only (`command-config.json`; no
`setDefaultMemberPermissions` — the guard test forbids both).

- `add` upserts into `projectmember` (re-adding changes the role).
- `remove` deletes the row.
- `list` shows explicit members with their roles, then a separate "Also assigned to
  tasks here" section for **inferred** members: anyone who is an assignee on one of the
  project's tasks but has no `projectmember` row. Inferred membership is never written
  anywhere — it is computed at read time from `task.assigneeIds`, in both the Discord
  command and the CSAAS endpoint (`source: "explicit"` vs `"inferred"` in the JSON).

## Member name sync (`bot/src/services/memberNameSync.js`)

The bot only ever stored Discord ids. The site needs names, and cannot itself ask
Discord, so the bot now keeps `guildmember.displayName` / `username` fresh: runs at
`ClientReady`, every six hours (`setInterval`, same shape as `meetingReminder.js`), and
on `Events.GuildMemberUpdate` for one member.

For each non-bot guild member: if a `guildmember` row exists and either name differs,
update it. **If no row exists, it inserts one with `status: 'pending'`** — exactly the
state `memberAdd.js` already writes for every fresh joiner, so a member who is merely
*seen* by the sync (never verified, never ran `/verify`) ends up in precisely the same
state as someone who just joined. `/approve` and `/backlog` treat them identically.
This is intentional, not a bug: it is the only way to get a name on record before
someone verifies, but it does mean the sync can create rows for people who never
interacted with the bot at all.

**Trap: `guildMember.findMany` silently applies `LIMIT 25`** unless the caller passes
`where.all: true`. The sync's guild-wide sweep passes `all: true` for exactly this
reason — without it, only the first 25 members (by whatever order the query returns)
get synced or considered for the diff, with no error and no warning. Any future caller
of `guildMember.findMany` needs to know about this default; it is not documented
anywhere in the Database layer itself.

`toNameUpdates(discordMembers, dbRows)` is the pure diff, unit tested.
`syncOneMember` takes a `{ db }` seam and looks the row up directly by
`guildId_discordId` rather than going through a config lookup. Failures are logged with
a `[memberNameSync]` prefix and swallowed, never thrown — a broken sync must not break
anything else that runs at `ClientReady`.

## The site screen: `/tools/tasks`

`src/screens/Tasks.tsx`, behind `ToolGuard`, in the same design system as
`Meetings.tsx`. Filter bar (status, project, assignee, blocked-only, free text) over one
card per project: name, status counts, member chips (explicit chips carry a role
label; inferred chips are gray, titled "assigned to tasks here"), then task rows with a
red `Blocked by: …` badge when applicable.

**Deep link:** `/tools/tasks?project=<docsSlug>` preselects the project filter.
`/tools/projects` cards link here when the registry slug matches.

**Trap: the site's own project registry uses different slugs than the bot's
`docsSlug`**, for every project except `badar-hms` — the one case where they happen to
agree. A `/tools/projects` card whose registry slug has no match among the bot's
`docsSlug`s links to a Tasks page that shows "No project called `<slug>` has tasks in
Discord" with a button to clear the filter, rather than a silent empty page. This is a
real mismatch, not a hypothetical — see the backlog item.

Pure logic (`tasksLogic.ts`: `applyFilters`, `assigneeOptions`, `statusTone`) is
vitest-tested separately from the screen.

## Deploy order and verification

Bot, then CSAAS, then site — each depends on the previous:

1. **Bot to `main`.** Auto-deploy runs migration 017 and restarts pm2. Verify:
   `pm2 logs granjur-bot --lines 50` shows `Registered 43 slash commands` and
   `[memberNameSync] …` lines; `SELECT COUNT(*) FROM guildmember WHERE displayName IS NOT NULL`
   is non-zero.
2. **CSAAS to `main`.** Auto-deploy. Verify: `curl -s https://api.gobizzi.com/api/discord/tasks | head -c 600`
   now shows a 401 envelope, not `"projects"` — the endpoint requires the portal token as
   of the 2026-09-18 build. Check the payload signed-in in the browser instead.
3. **Site to `main`.** Vercel builds on push. Open `/tools/tasks`.
4. **Live Discord check:** `/update-task task:<A> blocked_by:<B>`, then
   `/update-task task:<A> status:In progress` shows the warning; `/update-task task:<B> status:Done`
   posts the unblock notice in A's channel; `/project-members add` then refresh the page.

## Left out on purpose (not follow-ups to lose track of, but deliberate scope cuts)

- **No blocked marker in `/dashboard` or `/fetch-my`.** Blocked state only surfaces in
  `/update-task` replies, the notifier's channel posts, and the site. Someone reading
  `/dashboard` cannot tell a task is blocked without opening it.
- **No avatars on the site.** Member chips show name/username text only, no Discord
  avatar images.

Both are additive later; neither required any schema or endpoint change to add now.

## Team section and the write path

Built 2026-09-18 (spec `docs/superpowers/specs/2026-09-18-team-board-previews-design.md`,
ledger `.superpowers/sdd/2026-09-18-team-board-previews/progress.md`). Turns the read-only
Tasks page into a four-view Team section and adds the first *write* from the site back
into Discord data. Built and reviewed on branches in all three repos; **not merged or
deployed** as of this writing — see `session.md` for what remains.

### Routes (site)

`/tools/team` (`TeamLayout`, one shared fetch + filter bar) with children: index →
People, `tasks` → `TasksList` (former `Tasks.tsx` body), `tasks/:taskId` → `TaskDetail`,
`board` → `Board`. `/tools/tasks` is now `<Navigate to="/tools/team/tasks<search>" />`,
preserving the query string (so `?project=` deep links still work). Dependency graph is
not a route — it's a per-project "Graph" toggle inside `TasksList`'s project cards,
shown only when the project has ≥1 dependency edge.

### The write path: three hops, one shared secret, one shared helper

A board drag only ever *reads* Discord state; the actual mutation happens exactly where
`/update-task` already does it — in the bot, against `granjur.*`. CSAAS never writes the
bot's tables. Hop by hop:

1. **Site → CSAAS.** `setTaskStatus(taskId, status)` in
   `src/components/discordTasks/api.ts` calls `mwPost('/discord/tasks/status', { task_id,
   status })`. The site's patched `window.fetch` (`installApiAuth()` in `src/app/main.tsx`)
   adds the `accesstoken` header because the URL is under `API_BASE_URL` — no code in
   `setTaskStatus` itself has to know about auth.
2. **CSAAS: `POST /api/discord/tasks/status` → `DiscordTasksStatus_object`.** Declared
   `accessToken: true`, `bindActorToToken: true` (sets `actor_email` +
   `actionPerformerURDD` from the verified token), `permission: null` (the permission
   check happens inside the handler, not the framework step, matching
   `PortalUsersRole_object`'s shape). Handler `setTaskStatus(req, decryptedPayload)`:
   `requirePortalPermission(req, decryptedPayload, "update_discord_tasks")`, validates
   `task_id` (non-empty, ≤64 chars) and `status` (one of the six `TASK_STATUSES`), then
   calls the bot.
3. **CSAAS → bot (loopback).** `fetch(`${DISCORD_BOT_URL}/internal/tasks/status`, {
   method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret':
   DISCORD_BOT_SECRET }, body: { taskId, status, actor: { email: actor_email, name } },
   signal: AbortSignal.timeout(15000) })`. Env names: `DISCORD_BOT_URL` (default
   `http://127.0.0.1:4070`), `DISCORD_BOT_SECRET` (required — missing means CSAAS returns
   503 "not configured" and never makes the call at all, so the bot never sees a
   secret-less request from this path).
4. **Bot: `POST /internal/tasks/status`** (`bot/src/server.js`, dispatches into
   `bot/src/services/internalTaskRoute.js` `handleStatusRequest({ headers, body, db,
   client, secret, apply })` — pure and socket-free, so it's unit tested without a real
   HTTP server). Body `{ taskId, status, actor: { email, name } }`. The header is checked
   against `process.env.BOT_INTERNAL_SECRET` with `safeEqual` (`node:crypto`
   `timingSafeEqual`, both buffers must be non-empty and equal length first — an empty
   secret can never match, so an unset env can't accidentally be satisfied by an empty
   header). On success it calls the same `applyTaskUpdate` helper `/update-task` uses
   (`bot/src/services/taskStatusChange.js`), with `actor: { label: '<name-or-email> (via
   the site)' }` and no `discordId` (the site user isn't a Discord identity).

The bot route's status codes, in check order: **503** `internal route not configured` if
`BOT_INTERNAL_SECRET` is unset (checked before anything else, including the header) —
`server.js` logs `[internal] status route enabled`/`disabled` once at startup based on
this same env var. **401** `unauthorized` if the header is missing or wrong. **400** for
a missing/over-length `taskId` (>64 chars) or a `status` not in `TASK_STATUSES`. **404**
`Task not found` if `db.task.findFirst` misses. **200** `{ ok: true, task: { id, status },
warning: '', unchanged: true }` with **no write** if the task is already at that status.
**200** `{ ok: true, task: { id, status }, warning }` otherwise, after the write. **500**
`{ ok: false, message }` for anything thrown (logged with a `[internal]` prefix) — the
whole handler body runs inside one try/catch specifically so a bad/`null` JSON body can
never reach `.taskId` and hang the response (that was a real bug, fixed in `7045f99`
after the first review round; body is normalized to `{}` before any property read).

CSAAS maps the bot's response onto its own status codes rather than passing them
through: bot 404 → CSAAS 404 "Task not found"; bot 400 → CSAAS 400 (message passed
through); bot 401 or 503 → CSAAS 502 "Discord bot rejected the request (configuration)"
(a secret mismatch or a disabled route both mean "the loopback trust is misconfigured",
never surfaced to the site as a permission problem); a network error or the 15 s
`AbortSignal` timeout → CSAAS 502 "Discord bot is not reachable"; bot 200 → CSAAS returns
`{ task, warning, unchanged }` unwrapped. On success CSAAS logs
`[discord-tasks] <email> set <taskId> -> <status>`.

### The permission and its backfill

New permission `update_discord_tasks`, seeded by
`data/migrations/20260918_1_update_discord_tasks_permission.sql`:
`INSERT IGNORE INTO permissions (permission_name, status) VALUES
('update_discord_tasks','active')`, added to the `Role - Dev` and `Role - Admin`
permission groups, then **backfilled directly into
`user_role_designation_permissions`** for every URDD whose role is one of those two.
The direct backfill is necessary, not belt-and-suspenders: `applyRoleDefaults` only
materialises a role group's permissions into a URDD at URDD-creation time or when the
URDD's role changes — a person who already held the Dev or Admin role before this
migration ran would never pick up the new group permission on their own. `INSERT IGNORE`
on the unique pair makes re-running the migration a no-op.

`Platform Admin` is in the migration's role lists alongside `Admin` and `Dev`, and gets a
real URDP row like everyone else. The earlier plan — lean on the `seesAll` fallback in
`requirePortalPermission` and leave the role out of the groups — **does not work for the
board**: that fallback only decides what the CSAAS *endpoint* accepts. The site decides
whether a card is draggable from `useActingPermissions`, which reads the acting URDD's
permission list and has no admin fallback of its own, so a Platform Admin with no URDP
row saw the read-only note and never got as far as sending a request. Grant the
permission; do not rely on `seesAll` for anything the UI also gates on.

### The drop rule and the override lifecycle (Board.tsx)

On a card drop: (1) if the acting user lacks `update_discord_tasks`, cards aren't
`draggable` in the first place and a note above the board reads "You can view the board.
Ask an admin for the update_discord_tasks permission to move cards." — no drop event to
even reach; (2) dropping on the card's current column is a no-op; (3) otherwise the move
is optimistic — the card jumps columns locally, then `setTaskStatus(id,
statusForColumn(col))` fires; (4) on success the move stays, a non-empty `warning` (e.g.
a blocker warning) shows as an 8 s toast, then `refresh()` runs in the background so
counts/blocked state catch up — a refresh that itself fails just leaves stale counts
until the next refresh, not a wrong board; (5) on failure the card snaps back and a toast
shows the message, with two overrides: HTTP 403 becomes the permission sentence, HTTP 502
becomes "Discord bot is offline, try again".

**Override lifecycle**, fixed in a review round (Task 9, `d886ab9`): the optimistic
per-card status override used to be cleared unconditionally right after `refresh()`
resolved, which raced two ways — a `refresh()` that failed left a stale card snapped back
even though the write had succeeded, and two quick drops on the same card could have the
first drop's cleanup wipe out the second drop's still-pending override. The fix made
clearing **ownership-checked** — `clearOverride(id, status)` only clears an override if
it still matches the status that call itself wrote — plus a separate effect that retires
an override once the freshly-fetched payload already agrees with it (so a slow-but-
eventually-successful refresh still converges instead of leaving a permanent local
override).

### The bot route has no guild scope

`handleStatusRequest` resolves the task with `db.task.findFirst({ where: { id: taskId } })`
— **by id alone**. It never checks which guild the task belongs to, and CSAAS does not
send one. `update_discord_tasks` is therefore a global grant: a site user who holds it
can move *any* task in *any* guild the bot serves, provided they can learn its id (the
read endpoint hands out every id they can see). That is harmless today because the
deployment is single-guild, and it is the same shape as the read side, which is also
guild-blind. It stops being harmless the moment a second guild is onboarded — at that
point the route needs the caller's guild (or the permission needs a guild scope) before
the write, not after.

### The error-body shape (read this before parsing a CSAAS error anywhere)

Every CSAAS error response, at every status code, has the same envelope:
`{ status, message, payload, source, scc }`. `message` is **generic catalogue text**
(one fixed string per `scc` code — 400 is `E10`, 403 is `E31`, 404 is `E50`, 502/503 are
both `E99`); the specific, useful text lives in `payload`, not `message`. `setTaskStatus`
on the site therefore reads `payload` first (when it's a non-empty string), falls back to
`message`, then to `res.statusText`, and — separately — classifies 403/502/503 by HTTP
**status code first**, never by sniffing message text, because the generic `message` is
identical across unrelated failures. Getting this backwards (reading `message` before
`payload`, or classifying by string content) was flagged mid-build as the one thing that
would make the board's permission notice silently never show; see progress ledger
"Task 5: FACT for Task 9".

### How to verify (post-deploy)

- **Bot, from the VM, before the secret is set:** any request to the route returns 503;
  `pm2 logs` shows `[internal] status route disabled: BOT_INTERNAL_SECRET unset`. After
  setting `BOT_INTERNAL_SECRET` and restarting: `pm2 logs` shows `... enabled`.
- **Bot, with the secret set:** `curl -s -X POST localhost:4070/internal/tasks/status -H
  'content-type: application/json' -d '{}'` (no `x-internal-secret` header) → **401**.
  `curl -s -X POST localhost:4070/internal/tasks/status -H 'content-type: application/json'
  -H 'x-internal-secret: <secret>' -d '{"taskId":"x","status":"bogus"}'` → **400**.
- **CSAAS:** the read side no longer answers a bare `curl` — `GET /api/discord/tasks`
  without an access token returns **401**, which is itself the check that the gate
  landed. To see the data, open `/tools/team` signed in and read the response in the
  browser's network panel (or replay it from there with the `Authorization` header
  attached); both sides of this endpoint are now exercised from a signed-in browser
  rather than from the shell. The write side always needed a token and is likewise
  exercised live from the site.
- **Live, end to end:** sign in on the site, drag a card on `/tools/team/board`, and the
  task's Discord channel shows a post starting **"<Name> (via the site) updated this
  task:"** followed by the usual `• field: old → new` bullet lines — the exact text the
  notifier already sends for a Discord-originated update, just with a name instead of a
  `<@mention>` because the actor has no Discord id in this path. A blocked card shows the
  blocker-warning toast; moving a blocker to Done still fires the unblock notice in the
  dependent task's channel, same as `/update-task`.

### Deploy order (load-bearing, same shape as the 2026-09-17 build)

Bot → CSAAS → site, and two env values must be hand-set on the VM between the first two
steps: `BOT_INTERNAL_SECRET` in `~/Granjur-Discord-Bot/.env` (bot deploy, then set, then
`pm2 restart granjur-bot`), then `DISCORD_BOT_URL` + `DISCORD_BOT_SECRET` (same value as
`BOT_INTERNAL_SECRET`) in `/var/www/CSAAS/CSAAS_Backend/.env` (CSAAS deploy, then set,
then restart). The CSAAS read endpoint's `members[].roleNames` field only exists after
the bot's migration 018 has run, so CSAAS cannot go out ahead of the bot even for the
read side.

## Related

[[project-docs]] (the other bot-to-site data path, UBS-Doc markdown into MySQL — this
feature runs the same trust and deploy shape in the opposite direction: bot data read
out to the site rather than site data read into the bot).

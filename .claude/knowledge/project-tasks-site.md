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
- The endpoint is **public — no token, no encryption, no `accessToken` check** —
  matching the trust model of the portal's other read endpoints (`/api/portal/users/list`,
  `/api/projects/tenant/list`). `ToolGuard` protects only the `/tools/tasks` page, not
  the data. Anyone with the URL can `curl` task titles, Discord ids and names. This was
  a deliberate spec choice (§2), not an oversight, but it is a real exposure — see the
  backlog item if it needs revisiting.
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
   shows `"projects"`.
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

## Related

[[project-docs]] (the other bot-to-site data path, UBS-Doc markdown into MySQL — this
feature runs the same trust and deploy shape in the opposite direction: bot data read
out to the site rather than site data read into the bot).

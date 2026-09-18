# Team section on the UBS-Doc site: people, task detail, dependency graph, kanban with drag-to-status

**Date:** 2026-09-18
**Status:** approved design, not yet implemented
**Builds on:** `2026-09-17-project-tasks-site-section-design.md` (live since 2026-09-17)
**Repos touched:** Granjur-Discord-Bot (migration 018, name sync, internal status route,
shared status-change helper), CSAAS_Backend (endpoint fields, write endpoint, permission
migration), UBS-Doc (Team section with four views)

---

## 1. Goal

Turn the single Tasks page into a Team section: who is on the team and what they carry,
a detail page per task, a dependency graph per project, and a kanban board where dragging a
card changes the task's status in Discord, through the bot, with every warning and notice
the bot already sends.

## 2. What exists and what this reuses

- **Read path:** `GET /api/discord/tasks` (public) returns projects with members, tasks,
  blockers. The site fetches it through `mwGet`.
- **Site identity:** Firebase sign-in, then `POST /api/portal/users/signin` verifies the
  Google ID token server-side (`portalIdentityVerify.js`) and mints a framework JWT. The
  site keeps it in `sessionStorage` (`src/services/authToken.js`) and its fetch wrapper
  (`src/services/apiAuth.js`) adds it as the `accesstoken` header on every call to
  `API_BASE_URL`. A 401 signs the user out.
- **CSAAS request identity:** an API object declared with `accessToken: true` runs
  `validateToken` on that header and sets `decryptedPayload.userId`;
  `bindActorToToken: true` then sets `actor_email` and `actionPerformerURDD` from the
  verified user. `requirePortalPermission(req, decryptedPayload, name)` checks a named
  permission on that URDD and admits role admins.
- **Permissions:** rows in `permissions`; role groups in `permission_groups` and
  `permission_groups_permissions`; per-user rows in `user_role_designation_permissions`
  with `source = 'group' | 'manual'`. `applyRoleDefaults` materialises a role's group into
  a URDD only when the URDD is created or its role changes; existing users do not pick up a
  new group permission by themselves.
- **Bot:** a local HTTP server on port 4070 (`bot/src/server.js`, `POST /verify` only).
  The port is not reachable from the internet (checked 2026-09-17). `/update-task`'s
  execute holds the status-change logic (write, blocker warning, notify) inline.
- **Notifier:** `notifyTaskUpdate({ client, guild, task, before, updates, actorId,
  warning, db })` posts to the task channel as `<@actorId>` or "Someone".
- **Site permissions hook:** `useActingPermissions().has(name)` reads the acting URDD's
  effective permissions from `/portal/users/urdds`.
- Node 24 on the VM for both processes, so CSAAS has global `fetch`.

## 3. Decisions

| Question | Decision |
|---|---|
| Who may move a card | Anyone whose acting URDD holds `update_discord_tasks`, or a role admin. Granted to the Dev and Admin role groups and backfilled to existing users. Revocable per person in Tenant Admin. |
| Where the write happens | Only in the bot, through the same helper `/update-task` uses. CSAAS never writes `granjur.*`. |
| CSAAS → bot trust | Shared secret header on a loopback call. |
| Read endpoint | Stays public (unchanged; the open backlog item stands). |
| Board columns | Open, Pending, In progress, Done. Resolved, closed and done all render in Done; a drop into Done writes `done`. |
| Blocked cards | Movable; the warning comes back and shows as a toast. Warn, never refuse. |
| Navigation | `/tools/team` (People), `/tools/team/tasks`, `/tools/team/board`, `/tools/team/tasks/:taskId`. `/tools/tasks` redirects to `/tools/team/tasks` keeping the query string. One Team sidebar entry and tool card replace Tasks. |
| Discord role names | Stored on `guildmember.roleNames` by the name sync. |
| Dependency graph | Inline SVG, layered layout, no library. |

Out of scope: editing anything but status from the site; reordering within a column;
avatars; clock-in data.

## 4. Bot

### 4.1 Migration `018_guildmember_role_names.sql`

`guildmember.roleNames JSON NULL`, guarded with the `information_schema` pattern. Mirrored
in `schema.sql`.

### 4.2 Name sync

`toNameUpdates` also compares `roleNames`: the member's role names sorted, excluding
`@everyone`, clipped to 25 names of 100 characters. A changed list is an update. Writes
go through `guildMember.update/upsert`, which accept `roleNames` (JSON via `toJson`).
`guildMemberUpdateSets` and `guildMemberInsertSql` gain the column.

### 4.3 Shared status-change helper — `bot/src/services/taskStatusChange.js`

```js
export async function applyTaskUpdate({ db, client, task, updates, actor, notify = notifyTaskUpdate })
// actor: { discordId?: string|null, label?: string|null }
// → { warning: string, notified: { channelId, created, dmed } }
```

Contains what `/update-task` execute does after the dependency step: `task.update`,
the blocker-warning computation with its try/catch and 1500-character cap, and the
best-effort `notify` call with `actorId: actor.discordId ?? null` and
`actorLabel: actor.label ?? null`. Resolves `guild` as
`client.guilds.cache.get(<guildconfig.guildId>)`, looked up through
`db.guildConfig.findById(task.guildConfigId)` (the existing `getGuildConfigById`, exposed
on the `db` object as `guildConfig.findById` so it can be faked). `/update-task` calls it
instead of its inline block; behaviour is unchanged and its tests keep passing.

### 4.4 Notifier: `actorLabel`

`notifyTaskUpdate` gains `actorLabel = null`. `who` becomes `<@actorId>` when there is an
id, else `actorLabel` when given, else "Someone". The ticket-channel creation path passes
`memberIds: [...holders, actorId]`, which already filters falsy ids.

### 4.5 Internal route — `bot/src/server.js`

`POST /internal/tasks/status`, JSON body `{ taskId, status, actor: { email, name } }`.

- Requires header `x-internal-secret` equal to `BOT_INTERNAL_SECRET` (constant-time
  compare). Missing env → route disabled with 503 `internal route not configured`. Wrong
  or missing header → 401. Never CORS headers on this route.
- Validates `status` against the `/update-task` status list (exported as
  `TASK_STATUSES` from `bot/src/utils/taskDeps.js`: open, pending, in_progress, resolved,
  closed, done). Unknown → 400.
- Finds the task by id (`db.task.findFirst({ where: { id } })`). Missing → 404.
- Same status → 200 with `{ ok: true, task, warning: '', unchanged: true }` and no write.
- Otherwise `applyTaskUpdate({ db, client, task, updates: { status }, actor: { label:
  `${name || email} (via the site)` } })` → 200 `{ ok: true, task: { id, status },
  warning }`.
- Any thrown error → 500 `{ ok: false, message }`, logged with `[internal]`.

Handler logic lives in `bot/src/services/internalTaskRoute.js` as
`handleStatusRequest({ body, headers, db, client, secret, apply })` → `{ status, body }`
so it is testable without sockets; `server.js` only parses and dispatches.

## 5. CSAAS

### 5.1 `GET /api/discord/tasks` gains fields

Task shape adds `description`, `scope`, `modules` (array), `createdBy`
(`{ discordId, name }` or null), `passedApiTests`, `passedQaTests`,
`passedAcceptanceCriteria` (numbers or null), `projectId`, `projectName`.

New top-level `members`: every guild member row —
`{ discordId, name, username, roleNames: string[], status, verified: boolean,
projects: [{ id, name, docsSlug, role }] }` where `projects` lists explicit
`projectmember` rows. Sorted by name.

### 5.2 `POST /api/discord/tasks/status` → `DiscordTasksStatus_object`

Declared with the `step()` shape from `portalUsers.js`: `accessToken: true`,
`bindActorToToken: true`, `permission: null`, `requestMethod: "POST"`, fields
`task_id`, `status`.

Handler `setTaskStatus(req, decryptedPayload)`:
1. `requirePortalPermission(req, decryptedPayload, "update_discord_tasks")`.
2. Validate `task_id` (non-empty string ≤ 64) and `status` (one of the six). Else 400.
3. `fetch(`${DISCORD_BOT_URL}/internal/tasks/status`, { method: "POST", headers:
   { "content-type": "application/json", "x-internal-secret": DISCORD_BOT_SECRET },
   body: { taskId, status, actor: { email: actor_email, name: <users.name for the
   actor, if known> } }, signal: AbortSignal.timeout(15000) })`.
4. Map: bot 404 → 404 "Task not found"; bot 400 → 400; bot 401/503 → 502 "Discord bot
   rejected the request (configuration)"; network error / timeout → 502 "Discord bot is
   not reachable"; bot 200 → return `{ task, warning, unchanged }`.
5. Log `[discord-tasks] <email> set <taskId> -> <status>` on success.

Env: `DISCORD_BOT_URL` (default `http://127.0.0.1:4070`), `DISCORD_BOT_SECRET`
(required; missing → 503 "not configured", never a call without the header).

### 5.3 Migration `data/migrations/20260918_1_update_discord_tasks_permission.sql`

- `INSERT IGNORE INTO permissions (permission_name, status) VALUES ('update_discord_tasks','active')`.
- Add it to the `Role - Dev` and `Role - Admin` permission groups
  (`permission_groups` rows with `designation_id IS NULL`, joined by role name).
- Backfill: `INSERT IGNORE INTO user_role_designation_permissions
  (user_role_designation_department_id, permission_id, source, status)` for every active
  URDD whose `roles_designations_department.role_id` is one of those two roles.

## 6. Site

### 6.1 Structure

- `src/screens/team/TeamLayout.tsx`: breadcrumb, `Team` title, tab bar (People, Tasks,
  Board), the shared filter bar (project, assignee, blocked-only, search; status filter
  only on Tasks), refresh button, and `<Outlet context={...}>` carrying `{ payload,
  loading, error, refresh, filters, setFilters }`. One fetch for all tabs.
- `src/screens/team/People.tsx`, `TasksList.tsx` (the current `Tasks.tsx` body moved),
  `Board.tsx`, `TaskDetail.tsx`, `DependencyGraph.tsx` (used inside `TasksList`'s
  project cards behind a "Graph" toggle, shown only when the project has ≥1 dependency).
- Pure logic: `src/screens/team/teamLogic.ts` (`memberWorkload(members, projects)`,
  `sortMembers`), `boardLogic.ts` (`COLUMNS`, `columnOf(status)`, `statusForColumn(col)`,
  `groupByColumn(tasks)`), `graphLayout.ts` (`layoutGraph(tasks)` → nodes with
  `{ id, title, column, row, x, y, blocked }` and edges `{ from, to }`; layered by longest
  path from a source; cycle-safe because the bot refuses cycles, but the layout must not
  hang on one: cap iterations). `tasksLogic.ts` keeps its filters and gains the new types.
- `src/components/discordTasks/api.ts` gains `setTaskStatus(taskId, status)` posting
  through `mwPost('/discord/tasks/status', { task_id, status })`. The wrapper adds the
  token. A 403 surfaces its message.
- Routes in `routes.tsx`: `/tools/team` element `T(<TeamLayout />)` with children index
  → People, `tasks` → TasksList, `tasks/:taskId` → TaskDetail, `board` → Board.
  `/tools/tasks` → `<Navigate to={`/tools/team/tasks${search}`} replace />` via a tiny
  component that reads `useLocation().search`.
- `ToolsHub.tsx` card `Team` ("People, tasks, board and blockers", `Users` icon, route
  `/tools/team`) replaces the Tasks card. `Sidebar.tsx` entry `Team` replaces Tasks.
  `Projects.tsx` link → `/tools/team/tasks?project=`.

### 6.2 People

Cards sorted by open-task count desc, then name. Each: name, username, Discord role
chips (`roleNames`), a Verified/Pending chip (`verified`), project chips with role
labels, workload line `N open · N in progress · N blocked`. Filters apply (project narrows
to members on or assigned within that project; assignee filter selects one). A toggle
"only people with open tasks". Members with no tasks and no projects still appear (that is
the directory).

### 6.3 Task detail

`/tools/team/tasks/:taskId`. Finds the task in the payload; if the payload isn't loaded
yet, waits; if absent after load, "Task not found" with a link back. Shows title, status
chip, type, project (linking to `/tools/team/tasks?project=`), implementation status,
description (pre-wrap), scope, modules chips, created by + date, updated date, the three
test counters (or "—"), assignees, blocked by (each linking to its detail), blocks,
Discord channel link. Back link returns to `/tools/team/tasks` with the current query.

### 6.4 Board

Four columns from `boardLogic.COLUMNS`. Cards: title, project name, assignees, blocked
badge, status chip inside Done. Filters apply. Native drag and drop: `draggable` cards
carrying the task id in `dataTransfer`; columns accept drops. On drop:
1. If `!has('update_discord_tasks')`: ignore (cards are not draggable then; a note above
   the board says "You can view the board. Ask an admin for the update_discord_tasks
   permission to move cards.").
2. If the target column is the card's current column: no-op.
3. Optimistically move the card; call `setTaskStatus(id, statusForColumn(col))`.
4. Success: keep; if `warning` is non-empty show a toast with it for 8 s; then `refresh()`
   in the background so counts and blocked state update.
5. Failure: snap back; toast with the message (403 → the permission sentence; 502 →
   "Discord bot is offline, try again"; other → the message).

Toast: a small inline component in `Board.tsx`; no library.

### 6.5 Dependency graph

Per project card, a "Graph" button when `project.tasks.some(t => t.blockedBy.length ||
t.blocks.length)`. Renders an SVG: nodes are rounded rects (title clipped to 28 chars),
columns left→right by dependency depth, edges as lines with an arrowhead marker, blocked
nodes with a red stroke, terminal nodes muted. Clicking a node navigates to its detail.
Width scales with columns, scrolls horizontally when wider than the card.

## 7. Errors

Site: same error card on fetch failure; board drop errors are toasts; detail not-found
card. CSAAS: refusals as 400/403/404/502 with plain messages; never a partial write. Bot:
route errors as JSON; nothing thrown into the process.

## 8. Testing

- Bot: `taskStatusChange.test.js` (warning computed, capped, notify receives actorLabel,
  a notify failure does not throw); `internalTaskRoute.test.js` (secret missing/wrong,
  disabled when unconfigured, bad status, unknown task, unchanged status, success);
  `memberNameSync.test.js` additions for role names; `update-task.test.js` still green;
  builder tests for the new column.
- CSAAS: `discord-tasks-test/assemble.test.js` additions for the new fields and
  `members`; new `status.test.js` with hooks for `requirePortalPermission` and `fetch`:
  permission refusal, bad input, bot 404/400/timeout mapping, success.
- Site: vitest for `boardLogic`, `graphLayout`, `teamLogic`, and the redirect keeping the
  query string (pure helper).
- Live: after deploy, sign in, open the board, drag a card, see the Discord channel post
  "Name (via the site) updated this task", the warning toast on a blocked card, and the
  unblock notice when a blocker moves to Done.

## 9. Rollout

1. Bot to `main` (migration 018; the internal route stays disabled until
   `BOT_INTERNAL_SECRET` is set). Then add `BOT_INTERNAL_SECRET=<random 48 hex>` to
   `~/Granjur-Discord-Bot/.env` and `pm2 restart granjur-bot`.
2. CSAAS to `main` (migration applied at boot). Add `DISCORD_BOT_URL` and
   `DISCORD_BOT_SECRET` (same value) to `/var/www/CSAAS/CSAAS_Backend/.env` and
   `sudo pm2 restart csaas`.
3. UBS-Doc to `main`.
Production env edits are asked for before they are made.

## 10. Risks

- **The secret is only as private as the VM.** Acceptable: the port is loopback-only in
  practice and the payload is a status change on an internal task board.
- **Permission backfill touches every Dev/Admin URDD.** `INSERT IGNORE` on the unique
  pair keeps it idempotent; a later `applyRoleDefaults` leaves group rows that the group
  still contains.
- **Optimistic UI vs refresh.** A drop that succeeds but whose refresh fails leaves the
  card correct and the counts stale until the next refresh; acceptable.
- **Graph layout on a malformed cycle.** Capped iterations; renders whatever depth it
  reached.

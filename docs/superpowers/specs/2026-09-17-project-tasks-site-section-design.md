# Project tasks on the UBS-Doc site: multi-assignee, dependencies, project members

**Date:** 2026-09-17
**Status:** approved design, not yet implemented
**Repos touched:** Granjur-Discord-Bot (schema, commands, member name sync),
CSAAS_Backend (one read-only endpoint), UBS-Doc (one new Dev Tools screen)

---

## 1. Goal

Show every task from the Discord bot's database on the UBS-Doc site, grouped by project,
with the people working on each project, more than one assignee per task, and the tasks
that block a task. The site must always be live: no rebuilds, no copies of the data.

## 2. What exists today, and what it means for the design

- **Assignees are already a list.** `task.assigneeIds` is a JSON array and
  `/update-task assignees:` parses several mentions. Nobody has ever stored more than one,
  because the only way in is a free-text string option, and the interactive flow's
  `handleAssigneesSelect` (written for the confirm step) has never been shown to anyone.
  This is a picker problem, not a schema problem.
- **Dependencies have no home.** Nothing in the schema, the commands, or the notifier.
- **Project to developer links exist nowhere.** No Discord roles are named after projects,
  `project.owner_emails` holds group addresses, and no `guildmember` row has an email.
  The feature has to create this data.
- **The bot stores Discord ids only.** No display names anywhere in the database. The site
  cannot ask Discord, so the bot must start keeping names.
- **The live site already calls CSAAS** at `https://api.gobizzi.com` (nginx to port 3000
  on the VM). CSAAS's MySQL user is `root@localhost` with grants on `*.*`, and the bot's
  `granjur` database is on the same server. CSAAS can read the bot's tables directly.
- **CSAAS resolves a request path to a global object** by capitalising each segment:
  `GET /api/discord/tasks` resolves to `global.DiscordTasks_object`.
- The portal's own read endpoints (`/api/portal/users/list`, `/api/projects/tenant/list`,
  the meeting workflow) run with `encryption: false` and `accessToken: false`. The new
  endpoint uses the same trust model. The page itself sits behind the site's portal gate
  (`ToolGuard`: granjur.com accounts or provisioned users).

## 3. Decisions

| Question | Decision |
|---|---|
| How the site gets data | Read-only CSAAS endpoint over the bot's tables. No bot HTTP endpoint, no JSON committed to the repo. |
| Project to developers | Explicit list via `/project-members`, plus inferred members (assignees of the project's tasks) marked as inferred. |
| Blocked task on status change | Warn, never refuse. Blocked state is computed live, never stored. |
| Where on the site | `/tools/tasks`, behind the portal gate. Tool card and sidebar entry. |
| Names on the site | `guildmember.displayName` / `username`, kept fresh by the bot. |
| Refusals | A task blocking itself, and a dependency that would form a cycle. |

Left out on purpose: a blocked marker in `/dashboard` and `/fetch-my`, avatars on the site,
editing tasks from the site. All are additive later.

## 4. Data model, bot database: migration `017_task_dependencies_project_members.sql`

Every statement is guarded with the `information_schema` pattern from migration 016 so a
re-run is a no-op. Table names lowercase. `COLLATE=utf8mb4_general_ci` pinned at table
level, as migration 012 does, or the foreign keys to `task` and `project` fail with
`ER_FK_INCOMPATIBLE_COLUMNS`.

### `taskdependency`

One row per "task A is blocked by task B".

| Column | Type | Notes |
|---|---|---|
| `id` | VARCHAR(36) PK | `helpers.id()` |
| `guildConfigId` | VARCHAR(36) NOT NULL | FK `guildconfig(id)` ON DELETE CASCADE |
| `taskId` | VARCHAR(36) NOT NULL | the blocked task. FK `task(id)` ON DELETE CASCADE |
| `blockedByTaskId` | VARCHAR(36) NOT NULL | the blocker. FK `task(id)` ON DELETE CASCADE |
| `createdBy` | VARCHAR(64) NULL | Discord id of who recorded it |
| `createdAt` | DATETIME(3) | |

`UNIQUE (taskId, blockedByTaskId)`, `KEY (guildConfigId)`, `KEY (blockedByTaskId)`.

**Blocked is computed, never stored:** a task is blocked while any row in
`taskdependency` names it as `taskId` and the blocker's `task.status` is not one of
`closed`, `done`, `resolved` (the notifier's existing `TERMINAL_STATUSES`).

### `projectmember`

The explicit list.

| Column | Type | Notes |
|---|---|---|
| `id` | VARCHAR(36) PK | |
| `guildConfigId` | VARCHAR(36) NOT NULL | FK `guildconfig(id)` ON DELETE CASCADE |
| `projectId` | VARCHAR(36) NOT NULL | FK `project(id)` ON DELETE CASCADE |
| `discordId` | VARCHAR(64) NOT NULL | |
| `role` | VARCHAR(32) NOT NULL DEFAULT 'developer' | one of `lead`, `developer`, `qa`, `design` |
| `addedBy` | VARCHAR(64) NULL | |
| `createdAt` | DATETIME(3) | |

`UNIQUE (projectId, discordId)`, `KEY (guildConfigId)`.

### `guildmember`: two added columns

`displayName VARCHAR(100) NULL`, `username VARCHAR(64) NULL`. Filled by the name sync
(section 6). Missing values render as `Member …<last four digits of the id>` on the site.

### DB surface (`bot/src/Database/index.js`)

Added in the file's style: hand-rolled SQL, `queryOne` after a write, `LIMIT` inlined as a
clamped integer, never a bound parameter. Every insert builds columns and params from
**one** ordered array (the `meetingUtteranceInsertSql` pattern), with a test that asserts
the two line up.

- `db.taskDependency.add({ data: { guildConfigId, taskId, blockedByTaskId, createdBy } })`,
  `remove({ where: { taskId, blockedByTaskId } })`,
  `findByTask({ where: { taskId } })` (rows where this task is blocked),
  `findByBlocker({ where: { blockedByTaskId } })` (rows this task blocks),
  `findManyForGuild({ where: { guildConfigId } })`.
- `db.projectMember.add({ data: { guildConfigId, projectId, discordId, role, addedBy } })`
  (upsert on the unique pair, updates `role`), `remove({ where: { projectId, discordId } })`,
  `findByProject({ where: { projectId } })`.
- `db.guildMember.update` accepts `displayName` and `username`;
  `db.guildMember.upsert` writes both on create and on update when given.
- `db.task.findByIds({ where: { guildConfigId, ids } })` for resolving blocker rows in one
  query.

## 5. Dependency rules (`bot/src/utils/taskDeps.js`, pure)

- `openBlockers(task, depRows, tasksById)` returns the blocker tasks whose status is not
  terminal. `isBlocked` is `openBlockers(...).length > 0`.
- `wouldCycle(taskId, blockerId, depRows)`: true when `blockerId === taskId`, or when
  walking `blockedByTaskId` edges from `blockerId` reaches `taskId`. Depth-first over the
  guild's dependency rows; the graph is tiny.
- `blockerWarning(openBlockers)` renders the line
  `⛔ Still blocked by: **Title A** (open), **Title B** (in progress)` used by both the
  command reply and the channel post. Empty string when nothing is open.
- `unblockNotice(blockerTask, remainingOpen)` renders
  `✅ Blocker **Title B** is done. N blocker(s) still open.` or
  `✅ Blocker **Title B** is done. This task is no longer blocked.`

## 6. Member name sync (`bot/src/services/memberNameSync.js`)

Runs at `ClientReady` and every six hours (`setInterval`, same shape as
`meetingReminder.js`), and on `Events.GuildMemberUpdate` for the one member. For each
non-bot member of each guild: if a `guildmember` row exists and either name differs,
update `displayName` and `username`; if no row exists, upsert one with
`status: 'pending'`, which is exactly what `memberAdd.js` already writes for every
joiner, so no state is invented. `toNameUpdates(discordMembers, dbRows)` is the pure
diff and is what gets tested. Failures are logged with a `[memberNameSync]` prefix and
never thrown.

## 7. Discord surface

### `/create-task` (feature flow)

The confirm step gains an **Assignees** row: a `UserSelectMenuBuilder` with custom id
`create_task_assignees`, `setMinValues(0)`, `setMaxValues(25)`, defaulting to the current
`state.assigneeIds`. `handleAssigneesSelect` already expects `STEP_CONFIRM` and re-renders
the confirm step; `index.js` already routes `create_task_assignees`, but as a string
select. The route moves to the user-select branch. The `assignees:` string option stays.

### `/update-task`: four new options

- `add_assignee` (user), `remove_assignee` (user). Applied after `assignees:` if both are
  given. Adding an existing assignee or removing an absent one is a no-op, not an error.
- `blocked_by` (string, autocomplete on the existing task picker): adds a
  `taskdependency` row. Refused with a plain message when the value is the task itself,
  when the blocker does not exist in this guild, or when `wouldCycle` is true
  (`**B** already depends on **A**, so **A** cannot be blocked by **B**.`).
- `unblock` (string, autocomplete): removes the row; absent row is a no-op.

Autocomplete for `blocked_by` and `unblock` reuses the `task` option's resolver.
`unblock` narrows to the task's current blockers when the `task` option is already filled
in the interaction; otherwise falls back to the full list.

The reply embed lists changed fields as today, plus `Blocked by` / `Unblocked` lines. When
`status` changes to `in_progress` or a terminal status and the task still has open
blockers, the reply ends with `blockerWarning(...)`.

### Notifier (`taskUpdateNotify.js`)

- After a status change on a task with open blockers, the channel post ends with the same
  warning line.
- When a task reaches a terminal status, for every task it blocks (`findByBlocker`) that
  has a channel, post `unblockNotice(...)` into that channel. Best-effort, wrapped like the
  existing DM path.
- `assigneeDiff` already drives the assignment DMs, so `add_assignee` / `remove_assignee`
  get DMs and channel access for free.

### `/project-members`

Roles: `CEO`, `Server Manager`, `Project Manager` (in `command-config.json`; no
`setDefaultMemberPermissions`, the guard test forbids both).

- `add project:<autocomplete> member:<user> role:<lead|developer|qa|design>` (role
  defaults to developer). Upserts; re-adding changes the role.
- `remove project:<autocomplete> member:<user>`.
- `list project:<autocomplete>`: explicit members with roles, then "Also assigned to
  tasks here" for inferred members not on the list.

Project autocomplete reuses `projectChoices` from `update-task.js` minus the "No project"
entry (a `withDetach` flag on that helper).

## 8. CSAAS endpoint: `GET /api/discord/tasks`

`Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js`, `global.DiscordTasks_object`,
config `encryption: false`, `otp: false`, `accessToken: false`, `requestMethod: "GET"`,
`permission: null`, `postProcessFunction: getDiscordTasks`. Handler exported with the
`__hooks` / `__setTestHooks` seam from `meetingWorkflow.js`.

Optional query `guild=<discordGuildId>`; default: every guild in `granjur.guildconfig`.

Five queries, all fully qualified with `granjur.`: `guildconfig`, `project`, `task`
(all statuses, `LIMIT 2000`), `taskdependency`, `projectmember`, `guildmember`
(id to names). Aggregation is a pure function `assembleTasks({ guilds, projects, tasks,
deps, members, names })` that is unit tested with fixtures.

Response (`payload.return`, unwrapped by the site's helper):

```json
{
  "generatedAt": "2026-09-17T10:00:00.000Z",
  "projects": [
    {
      "id": "d290f9…", "name": "Framework", "docsSlug": "framework",
      "members": [
        { "discordId": "5459…", "name": "Aashir Adnan", "username": "__gilf", "role": "lead", "source": "explicit" },
        { "discordId": "7296…", "name": "Afaq Khawar", "username": "afaqkhawar9299", "role": null, "source": "inferred" }
      ],
      "counts": { "open": 5, "in_progress": 1, "pending": 0, "done": 2, "blocked": 1 },
      "tasks": [
        {
          "id": "65a4…", "title": "Git Sync", "type": "feature", "status": "open",
          "implementationStatus": null,
          "assignees": [ { "discordId": "7296…", "name": "Afaq Khawar" } ],
          "blockedBy": [ { "id": "de9a…", "title": "Router fix", "status": "open" } ],
          "blocks": [],
          "isBlocked": true,
          "channelUrl": "https://discord.com/channels/1476079072584138825/1234",
          "createdAt": "…", "updatedAt": "…"
        }
      ]
    },
    { "id": null, "name": "No project", "docsSlug": null, "members": [], "counts": {…}, "tasks": […] }
  ]
}
```

Rules: `counts.done` sums closed, done and resolved; `blocked` counts tasks whose
`isBlocked` is true; `channelUrl` is null without a `discordChannelId`; a name falls back
to `username`, then `Member …last4`. Projects are ordered by name, "No project" last and
omitted when empty. Tasks within a project: blocked first, then by `updatedAt` desc.

Errors: a query failure returns the framework's standard error response; nothing partial.

## 9. Site: `/tools/tasks`

- `src/screens/Tasks.tsx`, wrapped in `ToolGuard` in `routes.tsx`. Tool card in
  `ToolsHub.tsx` (`Tasks`, "Project tasks, owners and blockers", `ListChecks` icon) and a
  sidebar entry in `Sidebar.tsx` between Projects and GitHub.
- `src/components/discordTasks/api.ts`: `fetchDiscordTasks()` using the `mwGet` shape
  (`${API_BASE_URL}/api/discord/tasks`, unwrap `payload.return`).
- `src/screens/tasksLogic.ts` (pure, vitest-tested): `applyFilters(projects, { status,
  projectId, assigneeId, blockedOnly, query })`, `assigneeOptions(projects)`,
  `statusTone(status)` mapping open/pending → idle, in_progress → active, terminal →
  done, blocked → bad.
- Layout in the design system already used by `Meetings.tsx` (`card`, `txt`, `muted`,
  chips, `Breadcrumb`, `SearchInput`, `AuroraText`): filter bar on top, then one card per
  project with name, counts, member chips (explicit chips carry the role; inferred chips
  are gray and titled "assigned to tasks here"), then task rows: status chip, title,
  assignee names, and a red `Blocked by: …` badge listing blocker titles. Refresh button
  re-fetches. States: loading, error card ("Could not load tasks"), empty.
- Deep link: `/tools/tasks?project=<docsSlug>` preselects the project filter. Project
  cards on `/tools/projects` link to it when the registry slug matches.

## 10. Testing

- **Bot (`node:test`, colocated):** `taskDeps.test.js` (open blockers, cycle detection
  including self and two-hop, warning and notice text); `Database/index.test.js`
  additions asserting each new insert's column list and params come from one array;
  `memberNameSync.test.js` for `toNameUpdates`; `update-task.test.js` additions for the
  option handling against a `db` seam (the root `.env` points at production, so no test
  may reach the default `db` export); `project-members.test.js` for the list rendering
  and the `withDetach` choice helper; `commandGates.test.js` keeps guarding
  `project-members`.
- **CSAAS:** `Services/SysScripts/TestScripts/discord-tasks-test/assemble.test.js`, a
  plain-assert script like `utterance.test.js`, covering grouping, inferred members,
  blocked computation, counts, name fallback, ordering, and the "No project" bucket.
- **Site (vitest):** `src/screens/tasksLogic.test.ts`.
- **Live:** after deploy, `curl https://api.gobizzi.com/api/discord/tasks`, then open
  `/tools/tasks`; in Discord, `/update-task` with `blocked_by`, mark the blocker done, see
  the unblock notice; `/project-members add`, refresh the page.

## 11. Rollout

1. Bot to `main`: auto-deploy runs migration 017 and restarts pm2. Verify the log shows
   `Registered 43 slash commands` and the tables exist.
2. CSAAS to `main`: auto-deploy. Verify with curl on the VM. Stage by file only; the
   working tree carries unrelated changes.
3. UBS-Doc to `main`: Vercel builds on push. The local clone also carries unrelated
   uncommitted edits; stage by file.

## 12. Risks

- **A blocker that is also blocked** renders in the site badge with its own status; the
  page does not draw the chain. Acceptable for now.
- **Name sync inserts rows for members who never verified.** They arrive as `pending`,
  the state `memberAdd` already gives every joiner, so `/approve` and `/backlog` behave
  as they do for a fresh joiner.
- **Cross-database reads depend on `root@localhost` keeping `*.*` grants.** If CSAAS ever
  moves to a scoped user, it needs `SELECT` on `granjur.*`. Recorded in the knowledge file.
- **`/update-task` option count** goes from 10 to 14, under Discord's cap of 25.

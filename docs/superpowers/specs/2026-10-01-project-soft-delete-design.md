# Soft-deleting and reactivating a project

Owner request, 2026-10-01: "give an option delete project … make it soft delete so the data is
still present in db and can be reactivated but the channels go on deletion and come back on
reactivation." Design approved in chat the same day. Touches the bot (one migration) and
CSAAS. No site change.

Answers given while designing:
- Task ticket channels are archived (moved to a hidden, read-only archive category, discussion
  kept) and restored on reactivation; the project's own channels, category and role are deleted
  and rebuilt.
- While deleted, the project and its tasks are hidden everywhere; time already logged still
  counts in time reports.
- (Renaming a project was considered and dropped.)

## Current behaviour (verified in the code)

- `/projects` (`bot/src/commands/projects.js`, roles CEO and Server Manager in
  `config/command-config.json`) lists projects with Add / Link repo / Unlink repo. There is no
  delete.
- `project` (`schema.sql` ~399-415): `id`, `guildConfigId`, `name` (`UNIQUE (guildConfigId,
  name)`), `docsSlug`, `docsPaths`, `discordCategoryId`, `discordRoleId`, `discordChannels`
  (JSON map of the 13 section channels plus `archiveDivider`), timestamps. `db.project.update`
  writes only the columns in `PROJECT_UPDATABLE` (`Database/index.js` ~1087).
- A project's section is built by `setupOneProject` (`commands/project-setup.js` ~731) →
  `setupProjectSection` (observe / plan / apply in `services/projectSection.js`) →
  `syncProjectRoleMembers` (the role granted to `projectmember` staff). It recreates cleanly when
  the stored ids point at deleted objects, and moves existing task channels (by
  `task.discordChannelId`) back into the category with the role's access merged in.
- Task ticket channels (`services/taskTicketChannel.js`) live in the project's category with
  explicit overwrites: `@everyone` denied view, the project role allowed, one allow per holder.
  Finished tasks are locked and stamped `task.channelRetireAt = now + 14 days`; the hourly sweeper
  (`services/ticketRetire.js`) deletes channels whose stamp has passed, whatever category they
  are in.
- Rows keyed to a project: `task.projectId` (no FK), `projectmember` (FK cascade),
  `project_repos` (FK cascade), `project_schemas` (FK cascade), `docpage.projectId` (FK SET
  NULL), `meeting.projectId`, `scheduledmeeting.projectId`. A soft delete deletes none of them.
- CSAAS reads the bot's database directly for the site: projects, tasks, members, stats and time
  (`Src/Apis/ProjectSpecificApis/DiscordTasks/`). A task whose project is missing from the loaded
  project list falls into the site's "No project" group.

## Design

### 1. Data (bot migration `031_project_soft_delete.sql`)

- `project.deletedAt DATETIME(3) NULL` and `project.deletedBy VARCHAR(64) NULL` (the Discord id
  of whoever deleted it), plus `KEY (guildConfigId, deletedAt)`. Guarded so it can run twice, in
  the style of migrations 026/030; `schema.sql` mirrored.
- `deletedAt` and `deletedBy` added to `PROJECT_UPDATABLE`.
- `project.archivedChannels JSON NULL` is NOT added: the archive is recomputed from the tasks
  (below).

### 2. Hiding a deleted project (bot)

- `db.project.findMany` returns only live projects (`deletedAt IS NULL`) unless called with
  `{ where: { …, includeDeleted: true } }`. `findFirst` by id and `findByName` still return a
  deleted project (callers that act on an id need to see it to refuse properly).
- `db.task.findMany`, `task.findByIds` and `ticketDocListWithTask` exclude tasks whose project is
  deleted (`NOT EXISTS (SELECT 1 FROM project p WHERE p.id = task.projectId AND p.deletedAt IS
  NOT NULL)`), unless called with `includeDeleted: true`. Project-less tasks are unaffected.
- Callers that must see deleted projects pass `includeDeleted`: the `/projects` list, the
  reactivate flow, `setupProjectSection` (tasks and siblings) when reactivating, the docs sync's
  project list (`docsSync.js` `projectsFor` — otherwise it would unhook a deleted project's docs),
  `/cleanup`'s protected lists, and the time report's project names.
- Name and slug stay reserved: `/projects` Add refuses a name or slug a deleted project holds —
  `A deleted project has that name — reactivate it or pick another name.` (and the slug
  equivalent). `repos.js` / `create-project-role.js` name lookups refuse a deleted project.
- Meeting-task project matching (`meetingTaskProject.js`) uses only live projects and only live
  projects' repository links, so it never resolves to a deleted project.
- Writes refuse a deleted project with `This project is deleted.`: the internal create, update
  (moving a task into it, or editing a task in it), subtask, status and import-check routes
  (`services/internalTaskRoute.js`); `/create-task`, `/update-task`, `/clock-in`, `/log-time`,
  `/tasks-from-doc`, `/project-members`, `/project-setup` (except the reactivation path),
  `/meeting-channel` with a deleted project.
- A deleted project's tasks never get a new channel: `taskUpdateNotify`'s channel creation
  skips them.

### 3. Delete (`/projects` → Delete project)

1. A select of live projects, then a modal asking to type the project's name to confirm (case-
   insensitive, trimmed); a mismatch refuses with `The name does not match — nothing was
   deleted.`
2. The project row gets `deletedAt = now`, `deletedBy = <the member>` FIRST, so everything
   above hides it at once even if the Discord part is slow or partly fails.
3. Each task channel of the project (every task with `discordChannelId` set) is moved into the
   archive category and locked: parent → archive category; overwrites replaced by `@everyone`
   denied view and send (admins still see it by their permissions). The task row keeps its
   `discordChannelId`; `channelRetireAt` is left as it is (a finished task's channel is still
   removed on its normal schedule; an open task's never is).
4. The project's own channels (the 13 section channels and the archive divider), then its
   category, then its role are deleted. `discordCategoryId`, `discordRoleId` and
   `discordChannels` are set to null.
5. The reply (edited as it goes) says what was done: `Deleted **<name>**. Archived N task
   channels; removed its section and role.` Any Discord step that failed is listed (e.g. a
   channel already gone); the project stays deleted regardless.

**The archive category**: `🗄 ARCHIVED PROJECTS`, created on first use with `@everyone` denied
view; when it holds 50 channels (Discord's limit), `🗄 ARCHIVED PROJECTS 2`, and so on. Found by
name (it holds no ids). `/cleanup` treats every category whose name starts with
`🗄 ARCHIVED PROJECTS` as protected.

### 4. Reactivate (`/projects` → Reactivate project)

1. A select of deleted projects (shown only when there are any), then a confirm button.
2. `deletedAt` and `deletedBy` are cleared FIRST.
3. The section is rebuilt with the existing `setupOneProject` (category, channels, role, member
   role grants, members panel). Its task pass moves every task channel that still exists back
   into the new category with the role's access.
4. Each restored task channel's overwrites are rebuilt the way `createTaskTicketChannel` builds
   them (`@everyone` denied, the role allowed, each holder allowed); a finished task's channel is
   then locked again (`lockTicketChannel`), an open one left writable.
5. The reply: `Reactivated **<name>**. Rebuilt its section; restored N task channels.` plus any
   failures. If the section rebuild fails, the project stays reactivated and the reply says to
   run `/project-setup` for it.
6. An archive category left empty is deleted.

### 5. CSAAS

Every query that loads projects for the site skips deleted ones, and every task query skips tasks
of deleted projects (`AND (t.projectId IS NULL OR t.projectId NOT IN (SELECT id FROM granjur.project
WHERE deletedAt IS NOT NULL))` or a join), so nothing falls into the "No project" group:
- `discordTasks.js`: the project query and the task query (all its schema-fallback variants).
- `visibility.js`: `projectRow` refuses a deleted project (so every write through
  `assertCanUseProject` / `assertCanTouchTask` refuses with `This project is deleted.`, 409);
  `visibleProjectIdsFor` skips them.
- `discordProjectStats.js`: the project list.
- `discordClock.js`: clock-in on a deleted project's task refuses (via `canSeeTask`).
- Time report and entries: unchanged — logged time still counts; a deleted project's name comes
  from `task.projectName` as today.
- Against an older bot database without the column, the queries must not break: CSAAS checks the
  column once (information_schema, cached) and omits the clause when it is absent, OR the rollout
  runs the bot's migration first — see Rollout.

## Testing (fakes only; `.claude/rules/tests-never-touch-production.md`)

- Bot: the migration (its SQL, guarded twice); `findMany`/`task.findMany` hiding and
  `includeDeleted`; the name/slug refusals; each write refusal; delete (row first, archive moves
  and overwrites, deletions, reply, partial failure), reactivate (row first, rebuild call, restored
  overwrites, finished-task relock, empty archive removal); the archive category overflow at 50;
  `/cleanup` protection; meeting matching ignores deleted projects and their repositories; the
  docs sync keeps a deleted project's docs attributed.
- CSAAS: each changed query with and without deleted projects; the 409 on writes; the column
  check fallback.

## Rollout

Bot first (the migration runs in the deploy before the restart), then CSAAS. A CSAAS deployed
before the migration would query a missing column unless it checks for it; the column check in
§5 makes the order safe either way.

## Out of scope

- Renaming a project.
- Permanently deleting a project's data.
- Deleting a project's docs or repository links.

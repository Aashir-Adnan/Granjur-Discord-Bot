# Project soft delete (delete and reactivate a project)

Built 2026-10-01 on branch `feat/project-soft-delete` in the bot and CSAAS; not merged, not
deployed. Spec `docs/superpowers/specs/` (2026-10-01, soft-deleting and reactivating a
project), plan `docs/superpowers/plans/` (same). `/projects` gains Delete project and
Reactivate project. Nothing in the database is ever removed: a deleted project keeps its
row, tasks, docs, time entries and clock history, and a reactivation brings it back.

## The marker and the `includeDeleted` opt-in

Bot migration `031_project_soft_delete.sql` (guarded, safe to run twice) adds
`project.deletedAt DATETIME(3) NULL`, `project.deletedBy VARCHAR(64) NULL` and the index
`idx_project_guild_deleted (guildConfigId, deletedAt)`. NULL `deletedAt` = active, so every
existing project stays active. Both columns are in `PROJECT_UPDATABLE`
(`bot/src/Database/index.js`). `bot/src/utils/projectDeleted.js` holds the shared sentences
and helpers: `PROJECT_DELETED`, `DELETED_NAME_HELD`, `DELETED_SLUG_HELD`,
`ARCHIVE_CATEGORY_BASE`, `isDeletedProject(row)`, `projectIdIsDeleted(db, id)`.

### Hidden by default

These DB reads drop a deleted project and its tasks unless `where.includeDeleted === true`
(only the exact value `true` opts in; the flag is never a column in the SQL):

- `project.findMany` (`deletedAt IS NULL`)
- `task.findMany`, `task.findByIds`, `task.count` (`taskCountSql`) — a
  `NOT EXISTS (... project ... deletedAt IS NOT NULL)` clause; tasks with no project are
  unaffected
- `ticketDoc.listWithTask` (`ticketDocListWithTaskSql`)

NOT hidden: `project.findFirst` and `project.findByName` return a deleted row, so a caller
acting on an id or a name sees it and decides (refuse, or reserve the name).

### Who opts in (`includeDeleted: true`)

The `/projects` list and its pickers (they split live from deleted), docs sync (attribution
is recomputed every sync; leaving a deleted project out would unhook its pages),
`/cleanup` (protects ids a deleted project still carries and its archived ticket channels),
`/project-setup` sibling and task reads, `/create-project-role`, `/repos`, the time report
(tasks and projects), the clock's project-name map, section rebuild, and blocker lookups by
id (`update-task`, the task hub, `internalTaskRoute`) so a blocker in a deleted project
still resolves.

## Refusals

Every write that names a deleted project, or a task in one, answers `This project is
deleted.` (`PROJECT_DELETED`); on the internal routes it is HTTP 409 (CSAAS does the same).
Covered: `/create-task`, `/update-task`, `/feature`, `/clock-in`, `/log-time`,
`/project-members`, `/project-setup`, `/create-project-role`, `/repos`, `/tasks-from-doc`,
the meeting channel command, task update notices, the internal task routes, the task hub
(`loadHub` returns `{ task: null, deleted: true }`, rendered as the refusal), and
`/close-feature` / `/resolve-bug` (an archived ticket cannot be finished).

Reservations: `/projects` Add refuses a name held by a deleted project (`A deleted project
has that name — reactivate it or pick another name.`) and a slug held by one (`A deleted
project uses that slug — reactivate it or pick another slug.`). Meeting project matching
(`services/meetingTaskProject.js`) ignores deleted projects and their repository links. No
new task channel is created for a deleted project's task. `/cleanup` never deletes a
category whose name starts with `🗄 ARCHIVED PROJECTS`.

## Delete and reactivate: `bot/src/services/projectLifecycle.js`

Both directions change the row FIRST, so every list reflects the change at once even if the
Discord part is slow or fails. Each Discord step is caught on its own and added to
`failures` (one reply line each); the project stays deleted (or reactivated) regardless.
Only a failure to write the row itself throws, and then nothing was done.

`/projects` also holds a per-project in-memory lock (`withProjectLock`); a second delete or
reactivate of the same project answers `This project is being changed — try again in a
minute.` The row is re-read inside the lock. The pickers show the first 25 by name and a
line with the count of the rest.

### Delete, in order

1. Mark the row: `deletedAt = now`, `deletedBy = actor`.
2. Read its tasks (newest first, 2000 max). Close every open clock entry on those tasks
   (`closeEntry`, note `Project deleted`, source `auto_stopped`) and remove the Clocked In
   role from the member (best effort).
3. Archive each task channel that is the task's own (a channel named by several rows is a
   meeting's shared review channel and is skipped): move it into `🗄 ARCHIVED PROJECTS`,
   or `🗄 ARCHIVED PROJECTS 2`, `3`, ... once one holds 50 (counted from the channel cache;
   the category is created with `@everyone` denied view), and replace its overwrites with
   `@everyone` denied view and send.
4. Delete the section's channels (by the stored ids), then the category, then the role. One
   already gone (Discord 10003 / 10011) is skipped.
5. Clear the ids of what is gone. The category is KEPT, with its id, when any task channel
   could not be archived (deleting it would lift the still-open channels to the top level);
   the reply says `Kept the section category because some task channels could not be
   archived.` Any channel, category or role that could not be removed keeps its stored id,
   so `/project-setup` and a reactivation track it instead of building a duplicate. Only
   removed ids are cleared.

Reply: `Deleted **<name>**. Archived N task channels; removed its section and role.`, plus
`Stopped N running clocks.` when any, then one line per failure.

### Reactivate, in order

1. Un-mark the row (`deletedAt`, `deletedBy` null) and re-read it.
2. `setupOneProject` rebuilds the section (the same routine `/project-setup` runs); its
   task pass moves task channels into the new category. Warnings from the rebuild go into
   the reply as `Rebuild: ...`; a failed rebuild adds `Section rebuild failed — run
   /project-setup for it.`
3. Every task channel gets the overwrites a new one gets (`taskChannelOverwrites`). A
   straggler the rebuild left inside an archive category is moved in the same edit to
   where a new channel would go (`resolveParentCategory`: the project's category if it has
   room, else the global Features or Bugs one). A finished task's channel is relocked
   (`lockTicketChannel`). A channel still in the archive afterwards is named in the reply.
4. Any archive category with nothing left in it is deleted.

Reply: `Reactivated **<name>**. Rebuilt its section; restored N task channels.`, then one
line per failure.

## CSAAS side (`Src/Apis/ProjectSpecificApis/DiscordTasks/`)

CSAAS commit `605a582`. `projectDeletedClause.js` checks once whether
`granjur.project.deletedAt` exists (an `information_schema` read). A positive answer is kept
forever; a negative one for 5 minutes (so the bot's migration is noticed after a deploy); a
failing check counts as absent and warns once, so the site never breaks. With the column
absent every query is exactly what it was before.

With the column present: the site's project and task lists (`discordTasks.js`) and the
visibility project set (`visibility.js`) hide deleted projects and their tasks; writes to a
task in a deleted project (`assertProjectNotDeleted`, and the clock in `discordClock.js`)
answer 409 `This project is deleted.`, checked after visibility so only someone who can see
the task learns why. Time reports and time entries are unchanged: time logged on a deleted
project still counts. Test: `Services/SysScripts/TestScripts/discord-tasks-test/soft-delete.test.js`.

## Rollout (each push needs the owner's go-ahead)

1. Push the bot's `main`: the deploy runs `npm run db:migrate` (031) before restarting.
2. Push CSAAS `main` (auto-deploys). The column check makes either order safe.

## Known limits

- The lock is per process (a second bot process, were there one, would not see it).
- A restored channel lands below the archive divider until the next `/project-setup`.
- Tasks beyond the 2000-row read are not visited on delete or reactivation.
- Tests use fakes for `db`, the guild and config only; see
  `.claude/rules/tests-never-touch-production.md`.

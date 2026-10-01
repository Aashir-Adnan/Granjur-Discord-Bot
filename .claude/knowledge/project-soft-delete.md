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
id, including update-task, the task hub, internalTaskRoute, taskEdit, taskStatusChange,
taskUpdateNotify, timePanel, so a blocker in a deleted project still resolves.

## Refusals

Every write that names a deleted project, or a task in one, answers `This project is
deleted.` (`PROJECT_DELETED`); on the internal routes it is HTTP 409 (CSAAS does the same).
Covered: `/create-task`, `/update-task`, `/feature`, `/clock-in`, `/log-time`,
`/project-members`, `/project-setup`, `/create-project-role`, `/repos`, `/tasks-from-doc`,
the meeting channel command, the internal task routes, the task hub
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

The confirm-name modal (`handleDeleteModal`) and the Reactivate confirm button
(`handleReactivateConfirm`) re-run the `/projects` role gate (`canUseCommand(member,
'projects', { clientRoleId })` from `config/commands.js`, the same check the command router
runs) and refuse with the router's own sentence (`commandRefusal('projects')`, e.g. `This
command needs one of these roles: CEO, Server Manager.`). No member to check is a refusal.

The Delete picker says what is lost: `Deleting hides the project and its tasks and archives
task channels. Its section channels (members, docs, chat, voice…) are deleted with their
messages — Reactivate rebuilds them empty.` **Section channel messages and pins are lost
for good**; only task channels (and the other channels swept into the archive, below) keep
their history.

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
4. Delete the section's channels (by the stored ids). One already gone (Discord 10003 /
   10011) is skipped.
5. Sweep: EVERY channel still in the section category (read from the channel cache) that
   step 3 did not already try gets the same archive treatment — a `/meeting-channel` pair
   (its text channel is a shared review channel, so step 3 skips it), a legacy section
   channel whose id was never stored, a hand-made channel, a section channel that refused
   deletion. Their ids are recorded on the row as `discordChannels.archived = [ids]`.
   Without this, deleting the category lifts them to the top level with the role's
   overwrite gone, and `/cleanup` would offer them for deletion.
6. Delete the category, then the role, and clear the ids of what is gone. The category is
   KEPT, with its id, when any channel (task or swept) could not be archived, or the tasks
   could not be read (deleting it would lift still-open channels to the top level); the
   reply says `Kept the section category because some task channels could not be
   archived.` Any channel, category or role that could not be removed keeps its stored id,
   so `/project-setup` and a reactivation track it instead of building a duplicate. Only
   removed ids are cleared.

The `archived` key is a list, not a channel id. `storedChannels` (`utils/projectStore.js`)
leaves it out, so neither the section observer nor anything iterating the stored ids ever
sees it as a section channel; `archivedChannelIds(project)` reads it; `claimedSectionIds`
adds its ids, so `/cleanup` protects them and no other project adopts them by name.

Reply: `Deleted **<name>**. Archived N task channels; removed its section and role.`, plus
`Stopped N running clocks.` when any, then one line per failure.

### Reactivate, in order

1. Un-mark the row (`deletedAt`, `deletedBy` null) and re-read it; keep its `archived` list
   (the rebuild's single write of the section ids drops it).
2. `setupOneProject(..., { reactivating: true })` rebuilds the section (the same routine
   `/project-setup` runs); its task pass moves task channels into the new category.
   Warnings from the rebuild go into the reply as `Rebuild: ...`; a failed rebuild adds
   `Section rebuild failed — run /project-setup for it.`
3. Each `archived` id that still exists is moved back in one edit, `{ parent, lockPermissions:
   true }` (discord.js v14 copies the new parent's overwrites, so the new project role sees
   it), but ONLY into the project's own rebuilt category. A swept channel has no `@everyone`
   deny of its own, so the server-wide Features category (no overwrites) would make it
   visible to everyone. With no category (rebuild failed) or none with room
   (`categoryHasRoom`, exported from `taskTicketChannel.js`, the same cap rule as
   `resolveParentCategory`), the channel is not edited, stays in the archive, keeps its id
   in `archived`, and the reply says `#name stays in 🗄 ARCHIVED PROJECTS — move it into the
   project's category by hand.` Ids that are also in the section map (the rebuild placed
   them) are skipped and dropped. One that cannot be moved is `Could not restore #name: ...`
   and stays recorded; one deleted by hand is dropped. The final write re-reads the row, keeps
   the rebuild's section ids and sets `archived` to exactly what is left (absent when none);
   if that re-read fails nothing is written and the reply says `Could not record which
   channels stayed archived.` Task ticket channels still may fall back to global Features/Bugs.
4. Every task channel gets the overwrites a new one gets (`taskChannelOverwrites`) for its
   creator and holders; a client request (`requestedBy` set) also gets the project's client
   managers (`managerIdsOf` over the roster, the rule `clientRequest.js` creates the channel
   with and `/project-members` maintains; the roster is read only when there is a request
   task). A meeting-mirrored task's approver is NOT stored on the task row, so it is not
   restored. A straggler the rebuild left inside an archive category is moved in the same
   edit to where a new channel would go (`resolveParentCategory`: the project's category if
   it has room, else the global Features or Bugs one). A finished task's channel is
   relocked (`lockTicketChannel`). A channel still in the archive afterwards is named in the
   reply.
5. Any archive category with nothing left in it is deleted.

### `/project-setup` and a deleted project

`setupProjectSection` finds the project's own row in its fresh sibling read (deleted ones
included) and refuses a deleted one (`**<name>** — This project is deleted. Nothing was
changed.`, `refused: true`) unless called with `reactivating: true`, which only
`reactivateProject` passes. So an `all:true` walk skips a project deleted after the walk
read its list, instead of pulling its archived task channels back out.

### Recovering from an interrupted delete

A delete that stopped partway (bot restart, Discord outage) leaves the row marked deleted,
so the project is hidden from the Delete picker. Reactivate it (which rebuilds everything),
then Delete again.

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
- Section channel messages and pins are gone for good once deleted.
- Concurrent deletes of different projects share the archive categories without a lock
  (a failure is reported and recoverable).
- A meeting's tasks from a project deleted mid-pipeline land in "No project" and are not
  re-attached on reactivation.
- After the bot deploy CSAAS can take up to 5 minutes to notice the column; check the CSAAS
  log for its one-time `Could not check granjur.project.deletedAt` warning.
- Tests use fakes for `db`, the guild and config only; see
  `.claude/rules/tests-never-touch-production.md`.

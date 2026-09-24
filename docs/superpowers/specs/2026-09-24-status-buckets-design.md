# Per-project status buckets for ticket channels — design

**Date:** 2026-09-24
**Repo:** Granjur-Discord-Bot only
**Status:** approved in conversation; implementation plan to follow

## 1. Goal

Every project's ticket channels (`feature-…`, `bug-…`, `task-…`) are grouped by
the task's status into three sibling categories under the project's section, and
move between them as the status changes — from any writer. Finished tickets stay
readable for two weeks, then go.

Today a project's single category (`📂 NAME`) holds the thirteen section channels
and every ticket channel in creation order. Nothing groups them. `/close-feature`
and `/resolve-bug` delete a channel five minutes after closing (a `setTimeout`
that does not survive a restart), while `/update-task status:done` leaves the
channel in the category forever. Both are why the layout reads as messy.

## 2. Decisions (from the owner)

| Question | Decision |
|---|---|
| Buckets | Three: **Open**, **In progress**, **Done** |
| Done retention | Lock on entry, keep **14 days**, then delete. `/close-feature` and `/resolve-bug` adopt this instead of deleting in five minutes |
| Bucket visibility | Same overwrites as the project's section category |
| Scope | Every project. Project-less tasks stay in the global `Features`/`Bugs` categories, unchanged |

## 3. Constraints that shape the design

- Discord cannot nest categories → buckets are **sibling** categories placed
  directly below the section category.
- 50 channels per category (`CATEGORY_SOFT_CAP = 49`) → room is counted **per
  bucket**; a project may now hold up to 49 tickets per bucket.
- A channel edit that changes only `parent` keeps the channel's own overwrites
  and is not subject to the two-per-ten-minutes name/topic limit. Moves are
  therefore cheap and never touch `permissionOverwrites`.
- Every status write already goes through `applyTaskUpdate`
  (`bot/src/services/taskStatusChange.js`): `/update-task`, the task hub, and the
  site board via `internalTaskRoute`. That is the one hook for live moves.
- The root `.env` is production. Every new function takes `{ db, getConfig, … }`
  seams and every test runs with `DATABASE_URL=poisoned://no-production-access`.

## 4. The bucket table

One exported constant drives naming, placement and repair
(`bot/src/services/statusBuckets.js`, new):

```js
export const BUCKETS = [
  { key: 'open',       storeKey: 'bucketOpen',       label: 'OPEN',        statuses: ['open', 'pending'] },
  { key: 'inProgress', storeKey: 'bucketInProgress', label: 'IN PROGRESS', statuses: ['in_progress'] },
  { key: 'done',       storeKey: 'bucketDone',       label: 'DONE',        statuses: ['done', 'resolved', 'closed', 'abandoned'] },
]
```

- `bucketFor(status)` → the bucket **key**. Case-insensitive; `null`, empty or
  unknown status → `'open'`. Never throws.
- `isDoneBucket(key)` → `key === 'done'`.
- `bucketNameFor(project, bucket)` → `📂 <NAME> · <LABEL>`, where `<NAME>` is
  the project name upper-cased. Cut to Discord's 100-character category cap by
  truncating the **name**, never the ` · LABEL` suffix (same rule as
  `channelNameFor` keeps the suffix). Uses the existing `cut` helper.
- Bucket ids are stored in the existing `project.discordChannels` JSON map under
  `storeKey` (`bucketOpen`, `bucketInProgress`, `bucketDone`), read with the
  existing `storedChannels(project)`. Reusing the map means `claimedSectionIds`
  (cross-project claim protection) and `/cleanup`'s `sectionIds` already cover
  the bucket **categories** with no further change.

## 5. Placement of new ticket channels

`createTaskTicketChannel(guild, opts)` (`bot/src/services/taskTicketChannel.js`)
gains `opts.status` (the task's status at creation; default `'open'`).
`resolveParentCategory` becomes:

1. No project → global `Features`/`Bugs` category, as today.
2. Project: the bucket category for `bucketFor(status)`, when its stored id
   resolves to a `GuildCategory` **and** it has room (< `CATEGORY_SOFT_CAP`).
3. Else the project's section category (`discordCategoryId`) under the existing
   rules (resolves to a category, has room) — `fellBack: 'noBucket'`.
4. Else the global category — `fellBack: 'missing'` / `'cap'` as today.

Callers that pass a project pass the status too: `/create-task`, the meeting
mirror (`meetingPipelineStages`), `notifyTaskUpdate`'s late channel creation, and
`createClientRequest`. A ticket created directly into Done (e.g. a task inserted
already `done`) is **not** locked or stamped at creation; only a status change
into Done does that (§7). This keeps creation a single code path.

## 6. Live moves on status change

New service `bot/src/services/ticketBucketMove.js`:

```js
export async function moveTicketToBucket({ guild, task, before, updates, db, now = () => new Date() })
// → { moved: boolean, bucket: string|null, reason: 'no-channel'|'no-project'|'same-bucket'|'no-bucket'|'full'|'error'|null }
```

Called from `applyTaskUpdate` **after** the DB write and **before** `notify`,
inside its own try/catch, best-effort like everything after the write. It:

1. Returns early (no edit) when the task has no `discordChannelId`, no
   `projectId`, `updates.status` is undefined, or
   `bucketFor(before.status) === bucketFor(updates.status)`.
2. Loads the project (`db.project.findFirst`), reads the target bucket id from
   `storedChannels`. Missing id, or an id that is not a `GuildCategory`, or a
   bucket at cap → no move, reason recorded, `console.warn`.
3. Otherwise `channel.edit({ parent: bucketId })` — **no** `lockPermissions`, no
   overwrite payload. The channel's per-member and role overwrites are its own.
4. Then the Done transition (§7): entering Done → `retireTicketChannel`; leaving
   Done → `reviveTicketChannel`.

The channel's pinned embed and the "Status" field are not rewritten — the move
itself is the visible signal, and `notifyTaskUpdate` already posts the change.

## 7. Done retention

**Migration 026** (`026_task_channel_retire.sql`, guarded like 025): adds
`task.channelRetireAt DATETIME NULL` and `idx_task_channelRetireAt`. The DB
layer gains `channelRetireAt` in the task update/select surface and
`db.task.findRetirable({ where: { before: Date }, take })` → rows with
`discordChannelId IS NOT NULL AND channelRetireAt <= ?`, oldest first.

`bot/src/utils/channels.js`:

- `lockChannelAndScheduleDeletion` is **removed** (its two callers switch to
  `retireTicketChannel`).
- `lockTicketChannel(channel)`: every overwrite whose `allow` has `SendMessages`
  is edited to `SendMessages: false`. (The existing loop, kept.)
- `unlockTicketChannel(channel)`: every overwrite whose `deny` has `SendMessages`
  **and** whose `allow` has `ViewChannel` is edited to `SendMessages: true`. The
  `@everyone` overwrite denies `ViewChannel`, so it is never re-opened.

`bot/src/services/ticketRetire.js` (new):

- `RETIRE_AFTER_MS = 14 * 24 * 60 * 60 * 1000`.
- `retireTicketChannel({ channel, task, db, now })`: lock, then write
  `channelRetireAt = now + RETIRE_AFTER_MS` on the task row. Lock failure is a
  warning; the stamp is still written.
- `reviveTicketChannel({ channel, task, db })`: unlock, then write
  `channelRetireAt = null`.
- `sweepRetiredTickets({ client, db, now })`: for each guild config,
  `findRetirable({ before: now() })`, delete the channel (`channel.delete()`; a
  channel already gone counts as deleted), then write
  `{ discordChannelId: null, channelRetireAt: null }`. A row whose delete threw
  keeps its stamp and is retried next tick. Returns `{ deleted, failed }`.
- `startTicketRetireSweep(client, { db, intervalMs = 60 * 60 * 1000 })`: hourly
  `setInterval`, started from `bot/src/index.js` beside `startTicketReminder`.
  Returns the timer so tests can clear it.

`/close-feature` and `/resolve-bug`: replace `lockChannelAndScheduleDeletion`
with `moveTicketToBucket` (moving the channel into Done, which retires it) via
the task row they already resolve; their closing message says "This channel is
now read-only and will be removed in 14 days." They keep their own DB writes and
embeds otherwise.

Reopening a retired task (status leaves the Done bucket) revives the channel and
clears the stamp; a task whose channel was already swept gets a fresh channel
from `notifyTaskUpdate`'s existing "assigned task with no channel" path.

## 8. `/project-setup`

`observeProjectSection` gains, per bucket: the category found by stored id, else
by exact `bucketNameFor` name among `GuildCategory`s not in `claimedIds` (the
same guarded name fallback the section category uses), plus its channel count.
Each observed task now carries `status`. `/project-setup`'s task fetch already
returns full rows; `status` rides along.

`planBuckets(project, observed)` → one entry per bucket:
`{ key, storeKey, action: 'create'|'rename'|'reuse', id?, name }` — exactly
`planCategory`'s rules, per bucket.

`planTasks` changes: a task's wanted parent is the bucket for `bucketFor(status)`.
The plan records the bucket **key**, not an id: a bucket being created this run
has no id at plan time, and the applier resolves each key to the category it
created or reused in step 2b. A task already inside its bucket is `parentOk`;
one inside the section category or a wrong bucket is not. Room is tracked
**per bucket**, seeded from each observed bucket's channel count (a bucket being
created starts with the full `CATEGORY_SOFT_CAP`). Section channels always stay
in the section category, so their room accounting is unchanged and they no
longer compete with tickets. A task whose bucket is full
keeps today's "readable name, stay put" behaviour and is counted in the existing
`leftBehind` warning, now naming the bucket. Every plan entry gains
`bucket: key` and, for tickets in the Done bucket that lack a `channelRetireAt`,
`retire: true`.

`applyProjectSection` gains step **2b. The buckets** right after the category:
create (with `categoryOverwrites(guild, roleId)`, same as the section category),
rename, or reuse; then `setPosition` so the three sit directly below the section
category in order open, in progress, done. Position is best-effort (one warning
on failure). Step 4 parents each task channel to its bucket's id (which the
applier now knows even for buckets created this run) instead of `categoryId`; the
role-allow merge applies whenever the channel lands in any of the project's
categories. After the task loop, every entry with `retire: true` is locked and
stamped `now + 14 days` through `retireTicketChannel`, so a backfill never
deletes anything on the day it runs. Step 5's single write persists the bucket
ids beside the section ids. The `result` gains `buckets: { created, renamed }`
and `retired: number`.

The preview (`preview:true`) lists bucket actions the way it lists the category,
and the move counts read "N to move into OPEN / IN PROGRESS / DONE". Project
rename repairs bucket names the same run it repairs the section category name.

## 9. `/cleanup`

`categoryIds` (the set that marks "this channel lives in a project section") is
extended with the three bucket ids of every project, so ticket channels inside a
bucket are as protected as they were inside the section category. The bucket
categories themselves are already in `sectionIds` through `discordChannels`.

## 10. Client role interaction

Nothing changes for clients: a request channel keeps its per-member overwrites
across moves, so a client (and their client manager) still sees exactly the
request channels they are on, now under the bucket header. A client never sees
a bucket that holds none of their channels, because Discord hides a category
with no visible child. Clients are never granted on a bucket category.

## 11. Site and CSAAS

No change. The board's drag lands in `applyTaskUpdate` through the internal route
and moves the channel like any other writer.

## 12. Out of scope

- Buckets for project-less tasks in the global `Features`/`Bugs` categories.
- Rewriting the ticket's pinned embed on status change.
- Backfilling `channelRetireAt` for done tasks outside `/project-setup`.
- Deleting or archiving anything other than a ticket channel past its stamp.

## 13. Testing

All under `node:test` with fakes; no test touches the default `db`.

- `statusBuckets.test.js`: `bucketFor` table incl. null/unknown/case; name cut
  keeps the suffix at 100 chars; `storeKey`s match `BUCKETS`.
- `ticketBucketMove.test.js`: no-op reasons; a move edits `parent` only, never
  overwrites; full bucket leaves the channel; entering Done retires, leaving
  Done revives; a thrown edit is `reason: 'error'` and does not throw.
- `ticketRetire.test.js`: lock/unlock overwrite selection (including the
  `@everyone` deny never re-opened); stamp arithmetic with an injected `now`;
  sweep deletes only rows past the stamp, tolerates an already-deleted
  channel, retries a failed delete, and clears both columns.
- `taskTicketChannel.test.js`: the four-step parent resolution with `status`.
- `taskStatusChange.test.js`: `applyTaskUpdate` calls the mover after the write
  and before notify; a mover throw does not fail the update.
- `projectSection.test.js` / `project-setup.test.js`: bucket observe/plan by id
  and by guarded name; per-bucket room; tasks parented by status; `retire` flag
  only for Done tickets without a stamp; apply creates/renames/positions
  buckets and persists their ids; preview text.
- `close-feature.test.js` / `resolve-bug.test.js`: no deletion scheduled; the
  mover is called; the message names 14 days.
- `cleanup.test.js`: a ticket channel inside a bucket is protected.

## 14. Rollout

1. Deploy (push to `main`; the migration runs on the VM).
2. Run `/project-setup project:<X>` once per project (use `preview:true`
   first). This creates the three buckets, files every ticket by status, and
   stamps already-finished tickets to disappear 14 days later.
3. From then on new tickets land in the right bucket and every status change
   moves them.

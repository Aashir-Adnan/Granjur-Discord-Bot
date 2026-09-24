# Per-project status buckets for ticket channels

Built on branch `feat/status-buckets` (commits d635188..e691909, on top of the
merged `feat/client-role`/`feat/project-sections` work). Read this before touching
`bot/src/utils/statusBuckets.js`, `bot/src/services/ticketBucketMove.js`,
`bot/src/services/ticketRetire.js`, `/project-setup`'s bucket steps, `/close-feature`,
`/resolve-bug`, or `/cleanup`'s protection set.

The design record is `docs/superpowers/specs/2026-09-24-status-buckets-design.md`,
now with a dated **Corrections** section for where the shipped code deviates from
it. The build's full ruling-by-ruling record is
`.superpowers/sdd/2026-09-24-status-buckets/progress.md`. Read [[project-sections]]
first — this feature sits inside the per-project section it describes.

## The bucket table, and why the leaf is so small

`bot/src/utils/statusBuckets.js` is the whole table:

```js
export const BUCKETS = [
  { key: 'open',       storeKey: 'bucketOpen',       label: 'OPEN',        statuses: ['open', 'pending'] },
  { key: 'inProgress', storeKey: 'bucketInProgress', label: 'IN PROGRESS', statuses: ['in_progress'] },
  { key: 'done',       storeKey: 'bucketDone',       label: 'DONE',        statuses: ['done', 'resolved', 'closed', 'abandoned'] },
]
```

`bucketFor(status)` maps a status to a bucket key, case-insensitive, trimmed;
`null`/empty/unknown all file as `open` and it never throws. `isDoneBucket(key)`
is `key === 'done'`. `bucketByKey(key)` returns the row (or `null`).
`bucketNameFor(project, bucket)` builds `📂 FRAMEWORK · OPEN`: the project name
upper-cased and cut so the ` · LABEL` suffix always survives Discord's
100-character category cap (`MAX_CATEGORY_NAME`, also defined in
`projectSection.js` — deliberately duplicated rather than imported, a parked
minor, see "Known limitations" below). `bucketIdsOf(project)` reads the three
stored ids off the project row, keyed by bucket key.

`statusBuckets.js` is a **leaf** on purpose: it is imported by
`bot/src/services/taskTicketChannel.js`, which must never import the section
planner (`projectSection.js`) — that pulls in `projectMembersPanel.js` →
`db/index.js` → the production `.env`, dragging a whole database layer into a
test that touches no database (the same reason `CATEGORY_SOFT_CAP` lives in
`bot/src/constants.js` instead). For the same reason, `cut` (UTF-16-safe
truncation, never splitting a surrogate pair) and `storedChannels` (the
project's `discordChannels` JSON map, parsed defensively) were **moved out of
`projectSection.js` into `bot/src/utils/projectStore.js`**, a second leaf, and
`projectSection.js` now re-exports both (`export { cut, storedChannels }`) so
every existing importer is unchanged. `statusBuckets.js` imports them from
`projectStore.js` directly.

## Where bucket ids are stored, and what that buys for free

A bucket category's id is stored in the project's existing `discordChannels`
JSON map, under `storeKey` (`bucketOpen`, `bucketInProgress`, `bucketDone`) —
the same map the thirteen section-channel ids already live in, read with the
shared `storedChannels(project)`. Reusing that map means two things needed no
new code:

- **`claimedSectionIds(projects, exceptId)`** (`projectSection.js`) already
  walks every value in `discordChannels`, so the three bucket ids of every
  *other* project are claimed the same way its thirteen channel ids are — a
  second project can never adopt-by-name a bucket category that belongs to the
  first.
- **`/cleanup`'s protection set** (`bot/src/commands/cleanup.js`) builds
  `categoryIds` from `discordCategoryId` **and** `Object.values(bucketIdsOf(p))`
  for every project row, so a ticket channel sitting inside a bucket is
  protected exactly like one sitting in the section category — see
  `bot/src/commands/cleanup.js:154-157`.

## Creation placement order: bucket, then section, then global

`resolveParentCategory(guild, project, categoryLabel, status)`
(`bot/src/services/taskTicketChannel.js`) decides where a *new* ticket channel
is created, in order:

1. **The project's bucket** for `bucketFor(status)`, when its stored id
   resolves to a `GuildCategory` with room (`< CATEGORY_SOFT_CAP`) —
   `placed: 'bucket'`.
2. **The project's section category** (`discordCategoryId`), under the rules it
   always had (resolves, has room) — `placed: 'section'`.
3. **The global `Features`/`Bugs` category** — `placed: 'global'`.

`fellBack` is a **separate** field from `placed`, and its meaning did not
change from before this branch: it is non-null only when the channel left the
project's space entirely (case 3), because that is the one case where the
project role's allow must not be added and the reply has to say so.
`fellBack: 'missing'` (no usable section category) and `fellBack: 'cap'`
(section category full) are unchanged; a bucket that is missing or full simply
falls through to case 2 with `fellBack: null` — landing in the section category
is not a fallback worth flagging, it is where task channels always lived
before this feature. `placed` is the new field that names all three outcomes,
including the ordinary "it's in its bucket" case. See "Spec corrections" below
for why this replaced the spec's original `fellBack: 'noBucket'`.

## The mover: `ticketBucketMove.js`

`moveTicketToBucket({ guild, task, before, updates, db, now, retire, revive })`
(`bot/src/services/ticketBucketMove.js`) is called from **`applyTaskUpdate`**
(`bot/src/services/taskStatusChange.js`), after the database write and before
`notify`, inside its own try/catch — so `/update-task`, the task hub, and the
site's board (via `internalTaskRoute`) all move the channel identically,
because they all funnel through the one function. It returns
`{ moved, bucket, reason }` and never throws:

- `reason: 'no-channel'` — no `discordChannelId` on the task.
- `reason: 'no-status'` — `updates.status` is undefined/null.
- `reason: 'same-bucket'` — the status change did not cross a bucket boundary.
- `reason: 'no-channel'` (a second case) — the channel id exists but isn't in
  the guild's cache; the Done transition still runs with `channel: null` (see
  below), just no move is attempted.
- `reason: 'no-project'` — the task has no `projectId` (a project-less ticket,
  e.g. closed via `/close-feature`); the Done transition still runs.
- `reason: 'no-bucket'` — the project has no bucket category for the target
  status (missing or not a `GuildCategory`).
- `reason: 'full'` — the target bucket is at `CATEGORY_SOFT_CAP`.
- `reason: 'error'` — the `channel.edit({ parent })` call threw.
- `reason: null` with `moved: true` — the channel's parent changed. Only
  `parent` is edited: no name, no topic, no `permissionOverwrites` — a move is
  cheap and does not touch the channel's own overwrites.

## The Done transition: `ticketRetire.js`

`runDoneTransition` inside `ticketBucketMove.js` calls `retireTicketChannel` on
entering the Done bucket and `reviveTicketChannel` on leaving it — **regardless
of whether the move itself happened**. This is deliberate: a project-less
ticket closed with `/close-feature`, or a ticket whose channel isn't in the
guild's cache, still needs to be locked and stamped, or it would never be
cleaned up.

`bot/src/services/ticketRetire.js`:

- **`retireTicketChannel({ channel, task, db, now })`**: locks the channel
  (`lockTicketChannel`, every overwrite with `SendMessages` allowed loses it,
  one edit per overwrite) best-effort, then **always** writes
  `task.channelRetireAt = now() + RETIRE_AFTER_MS` (14 days), even when the
  lock failed or `channel` was `null` — a channel nobody could lock, or
  couldn't be resolved at all, still must not outlive its fortnight.
- **`reviveTicketChannel({ channel, task, db })`**: the reverse — unlocks
  (`unlockTicketChannel`, every overwrite denying `SendMessages` while
  allowing `ViewChannel`; the `@everyone` overwrite denies `ViewChannel` so it
  is never re-opened), then clears `channelRetireAt` to `null`.
- **`channelRetireAt`** lives on the `task` row (migration
  `026_task_channel_retire.sql`), not a timer — a bot restart forgets nothing,
  unlike the old `setTimeout` in `/close-feature`.
- **`sweepRetiredTickets({ client, db, now, take })`** reads
  `db.task.findRetirable({ where: { before: now() }, take })` (global, not
  per-guild — see "Spec corrections"), and for each row: resolves the channel
  via `channelOf` (cache, else `fetch`), deletes it if found, and always clears
  `discordChannelId`/`channelRetireAt`. Discord's **10003 ("Unknown Channel")**
  is treated as "already gone" **only on the fetch path** inside `channelOf` —
  a *cached* channel whose `delete()` itself throws 10003 is counted `failed`
  and retried next tick (self-corrects, since the retry will then miss the
  cache and hit the fetch path). A row whose delete throws for any other
  reason keeps its stamp and is retried too.
- **`startTicketRetireSweep(client, { db, intervalMs })`** runs hourly
  (`TICK_MS`), started from `bot/src/index.js`'s `Events.ClientReady` handler
  (`startTicketRetireSweep(client)`), and fires once immediately so a bot
  restarted after a long outage catches up rather than waiting an hour.

## `/project-setup`

`observeProjectSection` finds each bucket **by stored id first**, falling back
to an exact `bucketNameFor` name match among categories no other project
claims (`claimedSectionIds`) — the identical two-step rule the section category
itself uses, so a bucket renamed by hand is still found by id, and a
project that predates this feature adopts its bucket by name exactly once.

`planBuckets(project, observed)` (`bot/src/services/projectSection.js`) applies
`planCategory`'s create/reuse/rename rules to each of the three buckets in
table order. `planTasks` then assigns each task's **wanted parent** as the
bucket for `bucketFor(task.status)`, tracks room **per bucket** (seeded from
each bucket's observed channel count; a bucket being created this run starts
empty), and a task whose bucket has no room keeps the pre-bucket "readable
name, stay put" behaviour, counted in a per-bucket `leftBehind` warning. A
ticket lands in Done's `retire: true` **only when it has no `channelRetireAt`
stamp yet** — a stamped ticket is never re-stamped, or its fortnight would
restart on every run.

The applier (`applyProjectSection`) performs, in order:

- **Step 2b** — create/rename/reuse the three bucket categories (same
  overwrites as the section category, `categoryOverwrites(guild, roleId)`),
  persist each id into `channelIds[entry.storeKey]` and `bucketIdByKey`, then
  best-effort position them directly below the section category in table order.
  Two details that were bugs on the first cut of this step and are now load
  bearing:
  - **One unit on both sides of the position edit.** Both the read and the
    write use discord.js's **`position`** getter — the *sorted index* among the
    guild's categories, which is also what `edit({ position })` takes (it goes
    through `setPosition`, which re-numbers the rest). `base =
    Number(result.category.position ?? 0)`, `wanted = base + i + 1`, skip when
    `Number(cat.position ?? -1) === wanted`. The first cut read `rawPosition`
    (the raw, non-contiguous gateway value) and wrote a sorted index, so the
    skip check almost never hit and the number written meant something else
    than the one compared. A refused position edit is still one warning, not a
    stopped run.
  - **A bucket is bound before its repair edit, not after.** As soon as the
    category resolves from the cache, `channelIds[entry.storeKey]` and
    `bucketIdByKey[entry.key]` are assigned — the same order in which the
    section category sets `result.category = existing` before its own repair.
    A refused rename or overwrite repair (`Missing Permissions`) is then one
    `note(...)` warning and **the tickets still file into that bucket**.
    Assigning after the `await cat.edit(...)` (the first cut) meant a refused
    repair dropped the bucket out of `bucketIdByKey`, sent every ticket bound
    for it down the `unplaced` path, and told the operator the bucket "could
    not be created" when it plainly existed.
- **Step 4** — parent each task channel to its bucket's id instead of the
  section `categoryId`; a channel already correctly named but not yet visible
  to the project role gets a standalone `grant`; a rename/move that also needs
  the allow carries it in the same edit (`opens`). "Inside the project's
  space" for the allow decision is the section category **or** any of its
  three buckets. Task channels the run could not file (their bucket could not
  be created) are counted and surfaced as the **`unplaced`** warning:
  `"N task channel(s) for '<project>' could not be filed because its status
  bucket could not be created."`
- **Step 4c** — every planned entry with `retire: true` is locked and stamped
  through `retireTicketChannel`, counted from **this run's** clock, so a
  backfill never deletes a long-finished ticket the day `/project-setup`
  first runs on it. Guarded by `db?.task?.update` — no database means a
  warning instead of a silent skip. This whole step sits under `if
  (categoryId)`; see "Known limitations."

### What the reply says about buckets

The applier pushes a created or renamed bucket category into **both**
`result.created`/`result.renamed` **and** `result.buckets.created`/`.renamed`.
`renderResult` (`project-setup.js`) therefore words the bucket line as a
*breakdown* of the first summary line, never as an addition to it — the same
shape as its existing `(incl. N task channel(s))` and `N of those channel(s)
were also opened…` lines:

```
**Framework** — 17 created, 1 moved (incl. 1 task channel).
Status buckets: 3 of those created.
Status buckets: 1 of those created, 2 of those renamed.
```

Wording it as `Status buckets: 3 created` (the first cut) read as three
categories on top of the seventeen.

`intoBuckets` (the preview's `(into OPEN: 2, DONE: 1)` suffix) iterates
`BUCKETS.map((b) => b.key)` rather than a hardcoded key list, so adding a
fourth bucket to the table is still a one-file change.

## Project inference from inside a bucket

`projectFromChannel(projects, channel)` (`projectSection.js`) — shared by
`/project-members`, `/meeting-channel` and `/create-task` — matches a project
when the channel's `parentId` (or the channel's own id) is the project's
`discordCategoryId` **or any of `Object.values(bucketIdsOf(p))`**. The bucket
half is not optional: ticket channels no longer sit in the section category at
all, so matching on `discordCategoryId` alone left every command run inside a
ticket channel unable to infer its project — exactly the channels an operator
runs `/meeting-channel` from. The "two projects claim the same id → return
`null`, make the caller pick" rule applies across the combined id set, since
the bucket ids live in the free-form `discordChannels` JSON map and nothing
makes them unique either.

## `/close-feature` and `/resolve-bug`

Both commands still do their own database write (`status: 'closed'` /
`'resolved'`) and post their own closing embed, but no longer schedule a
five-minute `setTimeout` deletion. Instead each calls the same
`moveTicketToBucket({ guild, task, before: task, updates: { status }, db })`
every other status writer uses, moving the channel into the project's Done
bucket (or, for a project-less ticket, just running the Done transition with
no move — see the mover's `reason: 'no-project'` above). The channel message
now reads "This channel is now read-only and will be removed in 14 days."

## What clients see

Nothing changes for a client on a request channel: its per-member overwrites
travel with it across a bucket move (`channel.edit({ parent })` never touches
`permissionOverwrites`), so a client and their client manager still see
exactly the request channels they are on, now filed under a bucket instead of
directly in the section. Discord hides a category with no visible child, so a
client never sees a bucket that holds none of their channels. Clients are
never granted on a bucket category itself — only on the individual channels
inside it, as before.

## Rollout

1. Deploy (push to `main`; migration `026_task_channel_retire.sql` runs on the
   VM).
2. Run `/project-setup project:<X>` once per project — `preview:true` first.
   This creates the three buckets, files every existing ticket into the bucket
   matching its status, and stamps already-finished tickets to be removed 14
   days later.
3. From then on, new ticket channels land straight in their bucket at
   creation, and every status change moves them — from `/update-task`, the
   task hub, or the site board alike.
4. `/close-feature` and `/resolve-bug` no longer delete a channel five minutes
   after closing; they move it into Done, same as any other status change.

## Known limitations

- **`MAX_CATEGORY_NAME = 100` is defined twice** — in `projectSection.js` (the
  planner) and again in `utils/statusBuckets.js` (the leaf). Deliberate, not an
  oversight: `statusBuckets.js` cannot import the planner (see above), so the
  constant is duplicated rather than shared. Both copies are `100`, Discord's
  actual category-name cap, and have no reason to diverge.
- **Two same-named projects with different slugs still want the same bucket
  names.** This is pre-existing for the section category itself
  (`categoryNameFor`) — `bucketNameFor` inherits the same exposure. The
  cross-project claim set (`claimedSectionIds`) stops the second project from
  *adopting* the first's bucket by name, but does not stop two projects with
  identical display names from being planned in the first place; see
  [[project-sections]] ("Duplicate slugs") for the existing guard at the
  project level.
- **A run with no resolvable section category leaves finished tickets
  unstamped until the next run.** Step 4c (the retire/stamp pass) sits under
  `if (categoryId)` in `applyProjectSection`, alongside every other per-project
  step — when the category itself can't be created or found, the whole
  `else` branch is skipped and the reply says only "No category for
  '<project>'…". A repeat run once the category exists fixes it; nothing is
  lost, just delayed.

## Spec corrections (2026-09-25)

The design in `docs/superpowers/specs/2026-09-24-status-buckets-design.md`
predates several rulings made during the build. The spec is kept as history;
this file and the code are current.

1. **§5 said `fellBack: 'noBucket'` for "landed in the section category
   instead of a bucket."** The shipped code keeps `fellBack`'s existing
   meaning unchanged (non-null only when the channel fell all the way to the
   *global* category) and adds a new `placed: 'bucket'|'section'|'global'`
   field instead. Why: every existing caller keys the project-role allow, and
   its reply wording, on "is `fellBack` set" — a channel placed in the section
   category must still get the project role's allow, which a `'noBucket'`
   value on `fellBack` would have broken.
2. **§6/§7 implied the Done transition (retire/revive) only runs after a
   successful bucket move.** It actually runs whenever the status crosses the
   Done boundary and the task has a channel id — including a project-less
   ticket (no bucket to move into at all) and a ticket whose channel isn't in
   the guild's cache (`channel: null` is passed through and the stamp is
   still written; no lock is attempted). Why: otherwise `/close-feature` on a
   project-less ticket, or on a ticket Discord's cache hasn't warmed for,
   would never be cleaned up — a regression from the behaviour this feature
   was built to fix.
3. **§7 said `sweepRetiredTickets` runs "for each guild config."** It runs
   once, globally: `findRetirable` has no per-guild loop, because the sweep is
   one process-wide job and every returned row already carries everything
   needed to resolve and delete its own channel. No functional difference —
   a guild-scoped loop would do the same work through an extra round trip.
4. **Not stated in the spec at all:** the planner's `opens` flag (§8) is never
   set on a task entry that got dropped from `move`/`both` to `none` because
   its bucket was at the category cap. `planTasks` computes `edited` from the
   task's **final** action after the cap check, and only sets `opens` when
   `needsAllow && landsInside && edited` — a cap-dropped `none` entry is never
   `edited`, so it is never reported as opened to the project role, matching
   that no edit for it actually happens.
5. **§4 said `cut` and `storedChannels` live in `projectSection.js`** (they
   were already there before this branch). They **moved to the new
   `bot/src/utils/projectStore.js`** and are re-exported from
   `projectSection.js` unchanged, so every existing importer keeps working.
   Why: `statusBuckets.js` needs both, and it is imported by
   `taskTicketChannel.js`, which must stay a leaf — importing the planner
   there would drag `projectMembersPanel.js` → `db/index.js` → the production
   `.env` into a module whose tests touch no database.

## Related

[[project-sections]], [[client-role]]

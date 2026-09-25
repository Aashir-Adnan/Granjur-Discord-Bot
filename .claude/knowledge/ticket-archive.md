# The archive divider: finished tickets below the line

Built on branch `feat/archive-divider`, replacing the three sibling status-bucket
categories of `feat/status-buckets` (merged as `e845d17`, one day old) after the
owner saw them live: *"open should've been inside TEST."* Discord cannot nest
categories, so the grouping moved **inside** the project's own category as an
ordered list with a read-only divider channel.

Read this before touching `bot/src/utils/ticketArchive.js`,
`bot/src/utils/channelOrder.js`, `bot/src/services/ticketArchive.js`,
`bot/src/services/ticketRetire.js`, `/project-setup`'s divider steps,
`/close-feature`, `/resolve-bug`, or `/cleanup`'s protection set. The design
record is `docs/superpowers/specs/2026-09-25-archive-divider-design.md`; the
older `2026-09-24-status-buckets-design.md` is history with a dated note at the
top pointing here. Read [[project-sections]] first — this sits inside the
per-project section it describes.

## The layout

```
📂 TEST
  # test-members … (the 13 text section channels, order untouched)
  # bug-abc                ← live tickets (open, pending, in_progress, anything unknown)
  # feature-cdsad
  # task-kk
  # ────archive────        ← the read-only divider channel
  # bug-abc-eaa8           ← finished tickets (done, resolved, closed, abandoned)
  🔊 test-meeting-voice … (voice channels render below all text; untouched)
```

A ticket's **parent** is always the project's section category (or the global
`Features`/`Bugs` category when the project has none). Its **order** within that
category is the only thing that says whether it is live or archived. Everything
that already existed for a finished ticket is unchanged: the lock on finishing,
the `channelRetireAt` stamp 14 days out, the hourly sweep, the "read-only /
writable again" notice, `/close-feature` and `/resolve-bug`.

## Vocabulary: `utils/ticketArchive.js`

A leaf, for the same reason `statusBuckets.js` was one:
`services/taskTicketChannel.js` imports it and must never reach the section
planner (`projectSection.js` → `projectMembersPanel.js` → `db/index.js` → the
production `.env`, dragged into a module whose tests touch no database).
`utils/projectStore.js` (`cut`, `storedChannels`) is the second leaf it uses.

```js
export const FINISHED_STATUSES = ['done', 'resolved', 'closed', 'abandoned']
export function isFinished(status)          // case/whitespace-insensitive; null/unknown → false
export const ARCHIVE_DIVIDER_NAME = '────archive────'   // U+2500 ×4, 'archive', U+2500 ×4
export const ARCHIVE_DIVIDER_TOPIC = 'Finished tickets sit below this line, read-only, and are removed 14 days after finishing.'
export const ARCHIVE_STORE_KEY = 'archiveDivider'       // key in project.discordChannels
export function archiveDividerIdOf(project)
```

Two things about the divider are load bearing, and both are tested:

- **It is never a ticket channel.** `isTicketChannel`
  (`utils/taskChannelName.js`) reads the topic first and the name only when
  there is no topic; the divider's topic is not a `Feature:`/`Bug:`/`Task:`
  signature and its name carries no ticket prefix, so it fails both halves. If
  it ever passed, `/project-setup` would rename it into some task's channel, the
  mover would drag it across the line, and the sweep would delete it.
- **Its name has no spaces.** Discord turns a space in a channel name into a
  hyphen, which would break the line into dashes.

Its id lives in the project's existing `discordChannels` JSON map under
`ARCHIVE_STORE_KEY`, beside the thirteen section-channel ids. That buys two
things with no new code: `claimedSectionIds` already walks every value in the
map, so no second project can adopt another's divider by name; and `/cleanup`'s
`sectionIds` protection covers it exactly as it covers a section channel.

## The ordering primitive: `utils/channelOrder.js`

One helper does every reorder in the feature — creation, the live mover and
`/project-setup` all call the same three functions.

```js
export function textChannelsOf(guild, categoryId)          // GuildText, this parent, sorted
export function desiredOrder(channels, { dividerId, archivedIds, ticketIds })
export async function applyOrder(guild, current, order)    // → { changed: boolean }
```

- **`textChannelsOf` sorts by `rawPosition`, then by id numerically.** That is
  what Discord sorts siblings on. The id tie-break compares **length first**,
  then lexicographically: a snowflake is a decimal number in a string, and a
  plain string comparison puts `11` before `9`. Voice channels and categories
  are excluded — Discord renders voice below every text channel in a category
  whatever its position says, so a reorder must only speak about channels it can
  actually order.
- **`desiredOrder` groups**: everything that is neither a ticket nor the divider
  first (relative order kept), then the live tickets, then the divider, then the
  archived tickets. `dividerId: null` still applies the live/archived split, just
  with no line between. A `dividerId` that is **not among `channels`** is never
  emitted — ordering a channel that is not in this category would tip it out of
  its own.
- **"Bottom of its group" is expressed by input order**, not by a flag. A caller
  that wants one channel at the bottom of the side it is joining passes it last
  in `channels`; `placeTicketForStatus` does exactly that
  (`[...current.filter(c => c.id !== channel.id), channel]`). Without it, a live
  ticket becoming finished would land at the *top* of the archive, above tickets
  finished long before it.
- **`applyOrder` sends ONE `guild.channels.setPositions(...)`**
  (`GuildChannelManager#setPositions`, entries `{ channel: id, position: number }`,
  one `PATCH /guilds/:id/channels`) numbered `0..n-1`, and **nothing at all**
  when the order already matches. A throw propagates; each caller decides
  whether that is a `console.warn` or a `reason: 'error'`.

Positions are re-numbered from zero every time because Discord sorts by position
then id — only the relative order carries meaning, so there is no point trying to
preserve the raw values.

## Placement at creation: `createTaskTicketChannel`

`resolveParentCategory(guild, project, categoryLabel)` is back to what it was
before buckets: the project's section category when it resolves and has room
(`placed: 'section'`), else the global `Features`/`Bugs` category
(`placed: 'global'`). `fellBack` keeps its old meaning — non-null only when the
channel left the project's space entirely, which is the one case where the
project role's allow must not be added and the reply has to say so.

After the create, `placeAboveDivider` runs. It does nothing at all when the
ticket's status `isFinished` — Discord puts a new channel **last** in its
category, which is already below the line, so a finished ticket costs no reorder
request. For a live one it computes `desiredOrder` with the new id among the live
tickets and sends one `setPositions`. Which side each *other* ticket is on is
read off the divider's current index, not off anybody's status: the order on
screen is the truth the operator sees. The new channel is explicitly removed from
`archivedIds`, because Discord just put it below the line.

A refused reorder is one `console.warn` and a channel one row out of place, never
a failed create — the opening embed still goes out.

## The status change: `services/ticketArchive.js`

`placeTicketForStatus({ guild, task, before, updates, db, now, retire, revive })`
replaces `moveTicketToBucket`. It is called from **`applyTaskUpdate`**
(`taskStatusChange.js`) after the database write and before `notify`, inside its
own try/catch, so `/update-task`, the task hub and the site's board all behave
identically. It returns `{ moved, archived, reason }` and never throws.

`archived` is `isFinished(updates.status)` — which side of the line the new
status puts the ticket on, `null` when nothing was decided. `reason` is why the
channel was **not** reordered:

- `'no-channel'` — no `discordChannelId` on the task.
- `'no-status'` — `updates.status` is undefined/null.
- `'same-zone'` — finished-ness did not change. `open → in_progress` and
  `done → closed` both land here: no reorder, and **no Done transition**.
- `'no-channel'` (second case) — the id exists but is not in the guild's cache.
  The Done transition still runs with `channel: null`, so the stamp lands (or
  clears) and a channel that reappears later is honored.
- `'not-ticket'` — `isTicketChannel(channel)` says the task does not own it.
  **No reorder and no Done transition** — the only reason that suppresses the
  transition too. `meetingPipelineStages.js` writes the meeting's *review*
  channel id onto every task a meeting produced; finishing an unassigned one
  would otherwise drag the whole meeting's shared channel below the line, lock
  it, stamp it, and let the sweep delete it fourteen days later.
- `'no-project'` — no `projectId`; the Done transition still runs.
- `'no-divider'` — the project has no stored divider, its id no longer resolves,
  it is not a `GuildText`, **or it lives in a different category from the
  channel**. Ordering against a line somewhere else would tip the ticket out of
  its own category.
- `'already-there'` — the order was already right, so `applyOrder` sent nothing.
- `'error'` — the project read or the `setPositions` threw.
- `null` with `moved: true` — the category was reordered.

The Done transition (`retireTicketChannel` on becoming finished,
`reviveTicketChannel` on becoming live) runs **whenever the status crosses the
line and the task has a channel**, regardless of whether the reorder happened —
a project-less ticket closed with `/close-feature`, or one whose channel is not
cached, still has to be locked and stamped or it would never be cleaned up.

## Done retention: `ticketRetire.js` (unchanged)

Nothing in this file changed on this branch; it is repeated here because it is
half of what the divider means.

- **`retireTicketChannel({ channel, task, db, now })`** locks the channel
  best-effort (`lockTicketChannel`, one edit per overwrite that allows
  `SendMessages`), then **always** writes `task.channelRetireAt = now() + 14
  days`, even when the lock failed or `channel` was `null`.
- **`reviveTicketChannel({ channel, task, db })`** unlocks and clears the stamp.
  The `@everyone` overwrite denies `ViewChannel`, so it is never re-opened.
- **`sweepRetiredTickets`** runs hourly (and once immediately at
  `ClientReady`), globally rather than per guild. Three rules: a channel
  `isTicketChannel` refuses is `skipped` and the id kept; Discord's **10003**
  on either the fetch or the delete counts as `deleted`; any other throw is
  `failed` with the stamp pushed `RETRY_AFTER_MS` (6h) forward, so a hundred
  undeletable rows cannot shadow every newer one forever.
- The deadline lives on the `task` row (migration `026_task_channel_retire.sql`,
  also in `schema.sql`), not in a timer, so a restart forgets nothing.

## What the channel is told

`applyTaskUpdate` computes `extraLines` after the placement and hands them to
`notifyTaskUpdate`. The condition keys on the **statuses**, not on the
placement's return value:

- `isFinished(updates.status) && !isFinished(task.status)` → `[READ_ONLY_LINE]`
- `!isFinished(updates.status) && isFinished(task.status)` → `[WRITABLE_LINE]`
- anything else, including a change inside one zone → `[]`

Both sentences are exported constants (`taskStatusChange.js`) so the wording has
one home; `/close-feature` and `/resolve-bug` post the same read-only sentence
themselves. The notice is suppressed entirely when the placement returned
`reason: 'not-ticket'`: a shared channel the task does not own was not locked, so
telling it it is read-only would be a lie posted in front of everyone using it.

## `/project-setup`

**Observe.** `divider: { id, name, parentId } | null` — by stored id first (a
channel renamed by hand is still ours), else by exact `ARCHIVE_DIVIDER_NAME`
among the text channels whose `parentId` is this project's category and that no
other project claims. The same two-step rule the section category itself uses,
narrowed to the category because the line only means anything inside it.
`staleBuckets: [{ id, name, channelCount }]` — the stored `bucketOpen` /
`bucketInProgress` / `bucketDone` ids that **still resolve to a category**.

**Plan.** `divider: { action: 'create' | 'reuse' | 'move' | 'rename', id?, name }`
— `planChannels`'s rules applied to one channel, and a `move` carries the final
name too, so a divider that is both misnamed and misplaced is still one edit.

`planTasks` is back to **one parent** (the section category) and the original
room accounting: `CATEGORY_SOFT_CAP - categoryChannelCount - arriving`, where
`arriving` counts the section channels this plan creates or moves in **plus the
divider** when it is one of them. Each entry carries `archived`
(`isFinished(status)`) and `retire: true` for an archived ticket with no
`channelRetireAt` stamp — a stamped one is never re-stamped, or its fortnight
would restart on every run. `opens` is set exactly as it was before buckets:
`needsAllow && (action is move/both, or a rename that keeps a parent already
inside the category)`, which is also why a ticket the cap dropped is never
reported as opened.

Tickets sitting in a leftover bucket category are ordinary `move`s back into the
section. When the plan **empties** a stale bucket, one warning names it:

> `"📂 TEST · OPEN" is a leftover from the old layout and will be empty after this run — delete it by hand; /project-setup never deletes a category.`

Only when the run empties it: a bucket this plan leaves channels in is not safe
to delete, and saying so would be wrong.

**Apply.** Step 2b (the three bucket categories and their position edits) is
gone. In order now: role, category, the thirteen section channels, the client
manual, per-client access, **3c the divider**, **4 the task channels**, **4c the
retirements**, **4d one reorder**, 4b the voice repair, 5 the write, 6 the panel.

- **3c** creates the divider after the section channels with explicit overwrites
  `[{ @everyone, Role, deny ViewChannel }, { projectRole, Role, allow ViewChannel + ReadMessageHistory, deny SendMessages }]`,
  `topic: ARCHIVE_DIVIDER_TOPIC`, `parent: categoryId`. On reuse it is repaired
  the way a section channel is: one edit carrying name, parent and, when the
  role's overwrite is missing, the merged set. **A `grant` on the divider builds
  from the read-only set, never `ROLE_ALLOW`** — `dividerAllowMerged` is a
  deliberate twin of `roleAllowMerged` rather than a call to it, because
  `ROLE_ALLOW` carries `SendMessages` and a divider anyone can post in stops
  being a divider. The divider's id is bound **before** its repair edit, so a
  refused repair is one warning and the line is still the line step 4d orders
  around.
- **4** parents every ticket to `categoryId`. A `move` is still parent-only
  (the planner only chooses `move` when the name is already right, so sending
  `name`/`topic` back would spend part of Discord's two-edits-per-ten-minutes
  budget rewriting what it just read). The `unplaced` warning is gone with the
  buckets.
- **4d** reads the category's text channels, takes `archivedIds` from the plan
  entries with `archived: true` (so a preview and a run agree) and `ticketIds`
  from `isTicketChannel`, and calls `applyOrder` once. `result.reordered` is the
  `changed` flag. Best-effort: a refusal is one warning.
- **5** writes `channelIds[ARCHIVE_STORE_KEY]` and **deletes** the three
  `bucket*` keys. The categories they named are not touched — nothing in
  `/project-setup` or the mover deletes a channel, only the sweep does — the bot
  simply stops calling them its own, so a later run neither claims them nor
  files into them.

**Render.** `Archive divider: create|reuse|move|rename` in the preview; the task
line gains ` (N archived)`; the retire line is unchanged. A real run prints
`Ticket order refreshed.` when `reordered`, and the stale-bucket warnings flow
through `warnings` like any other.

## `/close-feature` and `/resolve-bug`

Both still do their own database write and post their own closing embed, and
both now call `placeTicketForStatus` instead of `moveTicketToBucket`. Nothing
else about them changed: no five-minute `setTimeout`, and the channel message
still reads "This channel is now read-only and will be removed in 14 days."

## What clients see

A client on a request channel keeps their per-member overwrites: a reorder
touches positions only, never `permissionOverwrites`, so it is even safer than
the parent edit the bucket move used. Clients never see the divider — it denies
`@everyone` and allows only the project role, and a client holds `Client`, not
the project role. They see exactly the request channels they are on, in the
project's one category, with the archived ones at the bottom.

## Known limitations

- **A reorder is one request, but it is a whole-category request.** Two
  `/project-setup` runs or two status changes racing each other both send the
  full list; the later one wins and the earlier one's intent is simply
  overwritten. There is no read-modify-write lock, and there does not need to be
  while the order is derived from the divider's position each time.
- **The live mover reads the sides off the line, not off the statuses.** A
  ticket a human dragged to the wrong side stays there until either its own
  status changes or `/project-setup` runs; only `/project-setup` reconciles the
  whole category against the database.
- **Leftover bucket categories are never deleted.** They are reported once, when
  a run empties them, and then forgotten — the stored ids are dropped, so a
  second run says nothing. An operator who misses the line has to find them by
  name.
- **`/project-setup` with no resolvable section category still skips the retire
  and reorder passes** — they sit under `if (categoryId)` with every other
  per-project step, and the reply says only "No category for '<project>'…". A
  repeat run once the category exists fixes it.
- **A voice channel can end up sharing a position number with a text channel.**
  `applyOrder` is only ever handed the category's *text* channels, so the voice
  ones keep whatever positions they had. Harmless in practice: Discord sorts and
  renders voice channels as a separate list below every text channel in a
  category, whatever their position says. Nothing here can prove that, so it is
  an assumption worth knowing about; if it ever stops holding, `textChannelsOf`
  has to become "every child, text first".
- **Discord's normalisation of U+2500 in `────archive────` is unverified.** The
  name has no spaces (a space becomes a hyphen), but nothing in this repo can
  say whether Discord rewrites or strips the box-drawing characters. It does not
  matter for correctness: the observer looks the divider up by **stored id**
  first and only falls back to the exact name, so a normalised name costs the
  name fallback and nothing else. First live check after deploy.

## Rollout

1. Deploy. No migration: `026_task_channel_retire.sql` and `schema.sql` are
   unchanged, and the divider's id goes into the existing `discordChannels` JSON.
2. `/project-setup project:TEST` once (`preview:true` first). It creates the
   divider, pulls `bug-abc`, `bug-abc-eaa8`, `feature-cdsad` and `task-kk` back
   into `📂 TEST`, orders them around the line, and reports that
   `📂 TEST · OPEN`, `· IN PROGRESS` and `· DONE` are empty leftovers to delete
   by hand.
3. Other projects: `/project-setup` as usual. A project that never had buckets
   simply gains a divider.
4. From then on new tickets land above the line at creation, and every status
   write that crosses it reorders — from `/update-task`, the task hub, the site
   board, `/close-feature` or `/resolve-bug` alike.

## Related

[[project-sections]], [[client-role]]

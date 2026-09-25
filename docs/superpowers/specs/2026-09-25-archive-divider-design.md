# Archive divider inside the project category — design

**Date:** 2026-09-25
**Supersedes:** the three sibling bucket categories of
`2026-09-24-status-buckets-design.md` (owner decision after seeing the buckets
live: "open should've been inside TEST"). Discord cannot nest categories, so
the grouping moves *inside* the project category as an ordered list with a
read-only divider channel.

## 1. Layout per project

```
📂 TEST
  # test-members … (the 8 text section channels, order untouched)
  # bug-abc                ← live tickets (open, pending, in_progress)
  # feature-cdsad
  # task-kk
  # ────archive────        ← read-only divider channel
  # bug-abc-eaa8           ← finished tickets (done, resolved, closed, abandoned)
  🔊 test-meeting-voice … (voice channels render below all text; untouched)
```

Everything that already exists for finished tickets stays: lock on finishing,
`channelRetireAt` stamp 14 days out, the hourly sweep, the "read-only / writable
again" notice, `/close-feature` and `/resolve-bug`. Only the *placement* changes:
no bucket categories; a ticket's parent is always the project's section category
(or the global Features/Bugs category when the project has none), and its
**order** within that category says whether it is live or archived.

## 2. Vocabulary (replaces `utils/statusBuckets.js`)

`bot/src/utils/ticketArchive.js` (leaf; `utils/statusBuckets.js` and its test are
deleted):

```js
export const FINISHED_STATUSES = ['done', 'resolved', 'closed', 'abandoned']
export function isFinished(status)           // case/whitespace-insensitive; null/unknown → false
export const ARCHIVE_DIVIDER_NAME = '────archive────'   // U+2500 ×4, "archive", U+2500 ×4 — no spaces
export const ARCHIVE_DIVIDER_TOPIC = 'Finished tickets sit below this line, read-only, and are removed 14 days after finishing.'
export const ARCHIVE_STORE_KEY = 'archiveDivider'      // key in project.discordChannels
export function archiveDividerIdOf(project)  // storedChannels(project)[ARCHIVE_STORE_KEY] || null
```

`utils/projectStore.js` (`cut`, `storedChannels`) stays as is.

## 3. Ordering primitive

One helper does every reorder, in `bot/src/utils/channelOrder.js` (leaf):

```js
/** Text channels of one category in Discord's display order: rawPosition, then id. */
export function textChannelsOf(guild, categoryId)  // GuildText only, parentId === categoryId, sorted

/**
 * The desired order of a category's text channels: every channel that is not
 * a ticket or the divider first (their relative order kept), then live tickets
 * (relative order kept), then the divider, then archived tickets (relative
 * order kept). `archivedIds` is the set of ticket channel ids that belong
 * below the line; `dividerId` may be null (then the live/archived split is
 * still applied, with no line between). Returns an array of channel ids.
 */
export function desiredOrder(channels, { dividerId, archivedIds, ticketIds })

/**
 * Apply `order` (ids) to the guild with ONE call —
 * `guild.channels.setPositions(order.map((channel, position) => ({ channel, position })))` —
 * and only when it differs from the current order. Returns { changed: boolean }.
 * A throw propagates; callers wrap it.
 */
export async function applyOrder(guild, current, order)
```

`ticketIds` = the ids `isTicketChannel` accepts among the category's text
channels (the divider is never a ticket: its topic does not match and its name
carries no ticket prefix). Positions are re-numbered 0..n-1 within the category;
Discord sorts siblings by position then id, so only the relative order matters
and one PATCH of `/guilds/:id/channels` carries the whole list.

## 4. Placement rules

- **Creation** (`createTaskTicketChannel`): parent resolution is section → global
  exactly as before buckets (`placed: 'section' | 'global'`, `fellBack` unchanged).
  After the create, when the project has a divider that resolves to a text
  channel inside that category and the new ticket's status is not finished,
  reorder the category so the new channel sits directly above the divider
  (`desiredOrder` with the new id among the live tickets, appended last among
  them). A finished ticket needs no reorder: Discord puts a new channel last,
  which is below the line. Best-effort: a reorder failure is `console.warn`.
- **Status change** (`bot/src/services/ticketArchive.js`, replaces
  `ticketBucketMove.js`): `placeTicketForStatus({ guild, task, before, updates, db, now, retire, revive })`
  → `{ moved, archived: boolean|null, reason }`. Reasons: `'no-channel'`,
  `'no-status'`, `'same-zone'` (finished-ness unchanged), `'not-ticket'`,
  `'no-project'`, `'no-divider'` (project has no stored/resolvable divider in
  the channel's category), `'already-there'`, `'error'`, `null`. The Done
  transition (retire on becoming finished, revive on becoming live) runs exactly
  as today for every task with a channel whose finished-ness changes — except
  `'not-ticket'`, which runs nothing. Moving = one `applyOrder` with the channel
  relocated to the bottom of the live group (becoming live) or the bottom of
  the archived group (becoming finished).
- `applyTaskUpdate` keeps its hook (`move = placeTicketForStatus`) and its
  notice lines; `placement.bucket` becomes `placement.archived`.
- `/close-feature` and `/resolve-bug` call the same function.

## 5. `/project-setup`

- **Observe:** `divider: { id, name, parentId } | null` — by stored id
  (`ARCHIVE_STORE_KEY`) when it is a `GuildText`, else by exact
  `ARCHIVE_DIVIDER_NAME` among text channels whose `parentId` is this project's
  category and that are not in `claimedIds`. Tasks carry `status` and
  `retireAt` as now. `staleBuckets: [{ id, name, channelCount }]` — the stored
  `bucketOpen` / `bucketInProgress` / `bucketDone` ids that still resolve to
  categories (left over from the previous layout).
- **Plan:** `divider: { action: 'create' | 'reuse' | 'move' | 'rename', id?, name }`
  — inside the section category, named `ARCHIVE_DIVIDER_NAME`; `planTasks`
  goes back to one parent (the section category) and the original room
  accounting (`CATEGORY_SOFT_CAP - categoryChannelCount - arriving`, where the
  divider create counts as arriving); each entry carries `archived: boolean`
  (from `isFinished(status)`) and `retire: true` for an archived ticket with no
  stamp. `buckets` is gone from the plan. Warnings: tickets sitting in a stale
  bucket category are ordinary `move`s back into the section; when the plan
  empties a stale bucket, a warning names it: `"📂 TEST · OPEN" is a leftover
  from the old layout and will be empty after this run — delete it by hand;
  /project-setup never deletes a category.`
- **Apply:** step 2b (buckets) is removed. New step 3c creates the divider
  after the section channels with explicit overwrites
  `[ {everyone, Role, deny ViewChannel}, {projectRole, Role, allow ViewChannel+ReadMessageHistory, deny SendMessages} ]`
  (bot allow as the section does, if it does), `topic: ARCHIVE_DIVIDER_TOPIC`,
  `parent: categoryId`; on reuse, repairs name/parent/overwrites the way
  section channels are repaired (a `grant` on the divider must never add
  SendMessages — build its required overwrite from the read-only set, not
  `ROLE_ALLOW`). Step 4 files every ticket into the section category (parent-only
  edit for `move`, as today). Step 4c retires as today. New step 4d: compute
  `desiredOrder` for the section category's text channels (archived = plan
  entries with `archived: true`) and `applyOrder` once; `result.reordered =
  boolean`. Step 5 persists `channelIds` with `ARCHIVE_STORE_KEY` and with the
  three `bucket*` keys **deleted**. `result.buckets`/position code is removed.
- **Render:** `Archive divider: create|reuse|move|rename`; task line unchanged
  plus ` (N archived)` when any entry is archived; the retire line as today.
  Result: `Ticket order refreshed.` when `reordered`; stale-bucket warnings
  flow through `warnings`.

## 6. Everything else

- `/cleanup`: `categoryIds` back to `discordCategoryId` only; the divider is
  protected by id through `discordChannels` (`claimedSectionIds`) as every
  section channel is.
- `projectFromChannel`: back to `discordCategoryId` matching only.
- Sweep, lock/unlock, migration 026, `schema.sql`, notice lines: unchanged.
- Knowledge: `.claude/knowledge/status-buckets.md` is replaced by
  `.claude/knowledge/ticket-archive.md` (README entry updated); the spec of
  2026-09-24 gets a dated note pointing here; `project-sections.md` describes
  the divider; state files updated; backlog items about buckets removed or
  reworded.

## 7. Tests (all through fakes; `DATABASE_URL=poisoned://no-production-access`)

- `utils/ticketArchive.test.js`: `isFinished` table; constants.
- `utils/channelOrder.test.js`: `textChannelsOf` sorts by rawPosition then id
  and excludes voice/categories; `desiredOrder` keeps relative orders, puts
  non-tickets first, divider between, handles `dividerId: null`; `applyOrder`
  calls `setPositions` once with 0..n-1 and not at all when unchanged.
- `taskTicketChannel.test.js`: bucket tests replaced by: a live ticket created
  under a category with a divider triggers one `setPositions` placing it just
  above the divider; a finished one triggers none; no divider → none.
- `ticketArchive.test.js` (service): every reason; becoming finished reorders to
  the bottom and retires; becoming live reorders above the divider and revives;
  `not-ticket` does nothing; no divider → Done transition still runs.
- `projectSection.test.js`: divider observe/plan/apply; stale bucket detection
  and warning; tickets pulled back from a stale bucket; one `setPositions` in
  apply; `bucket*` keys dropped on write; `retire` flag rules unchanged.
- `project-setup.test.js`, `cleanup.test.js`, `taskStatusChange.test.js`,
  `close-feature.test.js`, `resolve-bug.test.js`: adjusted to the new names.

## 8. Rollout

Deploy, then `/project-setup project:TEST` once: it creates the divider, pulls
`bug-abc`, `bug-abc-eaa8`, `feature-cdsad`, `task-kk` back into `📂 TEST`, orders
them, and reports that `📂 TEST · OPEN`, `· IN PROGRESS`, `· DONE` are empty
leftovers to delete by hand. Other projects: `/project-setup` as usual.

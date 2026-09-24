# Current Session

**Date:** 2026-09-25

## Goal
Replace the three sibling status-bucket categories — built and merged the same day — with
ordering **inside** the project's own category around a read-only `────archive────`
divider channel. The owner's call after seeing the buckets live: *"open should've been
inside TEST."* Discord cannot nest categories, so the grouping moves inside the one the
project already has: live tickets above the line, finished ones below it, everything else
about the Done transition unchanged.

## Outcome — BUILT on `feat/archive-divider`, not yet merged
Design → implementation in four commits on `feat/archive-divider` (base `c6e97e0`, the
design commit), plus this documentation commit. Full suite 1185 pass / 0 fail. Not merged
to `main`, not deployed.

- `8e4c893` feat(archive): the archive vocabulary and the one reorder primitive
- `907c9ed` feat(archive): tickets are ordered across the divider instead of moved
  between categories
- `902b46d` feat(archive): /project-setup builds the divider, files every ticket, orders
  the category once
- this commit: the docs

Knowledge in use: `.claude/knowledge/ticket-archive.md` (new this session, replaces
`status-buckets.md`), `.claude/knowledge/project-sections.md` (updated — the divider sits
inside the section it describes). Rule in force:
`.claude/rules/tests-never-touch-production.md` — every run was
`DATABASE_URL=poisoned://no-production-access`.

## What changed
**New leaves.** `bot/src/utils/ticketArchive.js` (`FINISHED_STATUSES`, `isFinished`, the
divider's name/topic/store key, `archiveDividerIdOf`) and `bot/src/utils/channelOrder.js`
(`textChannelsOf`, `desiredOrder`, `applyOrder` — one `guild.channels.setPositions` per
reorder, and none when the order already matches).

**New service.** `bot/src/services/ticketArchive.js` — `placeTicketForStatus` replaces
`moveTicketToBucket`. Same Done transition, same `not-ticket` gate, same cache-miss
behaviour; `same-bucket` becomes `same-zone`, `no-bucket`/`full` become `no-divider`, and
the result field `bucket` becomes `archived: boolean|null`.

**Creation.** `resolveParentCategory` is back to section → global (`placed:
'section'|'global'`); a live ticket is then slid above the divider with one reorder, a
finished one costs none because Discord already put it last.

**`/project-setup`.** Observes `divider` and `staleBuckets`; plans a divider with
`planChannels`'s rules; `planTasks` back to one parent and the original room accounting
(the divider counts as arriving); apply step 2b gone, new 3c (create/repair the divider
with the READ-ONLY overwrite set — a `grant` on it never builds from `ROLE_ALLOW`) and 4d
(one `desiredOrder` + `applyOrder`, `result.reordered`); step 5 deletes the three
`bucket*` keys. A leftover bucket the run empties is named in a warning that says
`/project-setup` never deletes a category.

**Deleted.** `utils/statusBuckets.js`, `services/ticketBucketMove.js` and both tests.
`projectFromChannel` and `/cleanup`'s `categoryIds` are back to `discordCategoryId` only.

## Open items before merge
See `backlog.md` → "Archive divider — deferred follow-ups". Beyond that:
- No live acceptance run yet. Rollout: deploy (no migration), then
  `/project-setup project:TEST preview:true`, then for real; it creates the divider, pulls
  the four TEST tickets back into `📂 TEST`, orders them, and reports that
  `📂 TEST · OPEN`, `· IN PROGRESS` and `· DONE` are empty leftovers to delete by hand.
- The three leftover bucket categories in the real guild have to be deleted manually —
  nothing in the bot will ever do it.

## Next session
Merge `feat/archive-divider` to `main`, deploy, run the rollout per project, delete the
leftover bucket categories by hand — or pick up the next item at the top of `backlog.md`.

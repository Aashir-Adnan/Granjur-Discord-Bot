# Current Session

**Date:** 2026-09-18

## Goal
Team section on the UBS-Doc site: turn `/tools/tasks` into People / Tasks / Board views
plus a per-task detail page and a dependency graph, and give the board's drag-to-status
its first write path back into Discord data — through the bot, via CSAAS, using the same
helper `/update-task` already uses for the write, blocker warning, channel post and
unblock notices.

## Outcome
All 11 tasks of `docs/superpowers/plans/2026-09-18-team-board-previews.md` are
implemented, reviewed (each lane's Critical/Important findings fixed, re-reviewed clean),
and committed — but **nothing is merged or deployed yet**. Built and reviewed on
branches:

- **Bot** (this repo): `feat/team-board`, suite 320 → 340, at `7045f99`.
- **CSAAS** (`../CSAAS_Backend`): `feat/discord-tasks-status`, at `481d6c1`.
- **UBS-Doc** (`../UBS-Doc`): `feat/team-section`, vitest 123 → 194, at `0fadfd4`.

Task 11 (this task) closed out knowledge and state: `.claude/knowledge/project-tasks-site.md`
gained "Team section and the write path" (routes, the three-hop write with exact
headers/body/env names, the `update_discord_tasks` permission and its backfill, the bot
route's status codes, the board's drop rule and override-clearing fix, the CSAAS
error-body shape, and how to verify). `.claude/state/completed.md` has the 2026-09-18
entry (commits per repo). `.claude/state/backlog.md` has a new "Team section —
follow-ups" section carrying the ledger's deferred minors (loopback bind, `portalAuthz`
`pickFrom` fallback, People search placeholder, no keyboard board path, graph layout
recompute per keystroke, `storedRoles`/`ensureStringArray` duplication, duplicated
`'notified'` default literal, `Platform Admin` missing from the permission groups,
uncapped TEXT payload, raw `task.type` rendering).

## Deployed (2026-09-18)
All three branches merged to `main` and live, in order. Bot `8f03f3e`: migration 018
applied, `[internal] status route enabled` after `BOT_INTERNAL_SECRET` was set (both
`.env` files backed up as `.env.bak-20260918`); from the VM the route answers 401 without
the header and 400 on a bad status. CSAAS `a689eda`: migration applied (permission granted
to 7 Admin, 20 Dev, 2 Platform Admin URDDs); both `/api/discord/tasks` endpoints return 401
without a token. UBS-Doc `d0660cf`: Vercel build. Feature branches deleted.

## What remains
Signed-in browser checks: open `/tools/team`, the Board, drag a card; confirm the Discord
channel post "Name (via the site) updated this task"; a warning toast on a blocked card;
an unblock notice when a blocker moves to Done.

## Open threads (parked)
- FAQ error-lookup design, section 3.
- `STT_PROVIDER=soniox` experiment on the VM.

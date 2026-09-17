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

## What remains
1. **Final whole-branch review** across all three repos together (the per-task reviews
   are done; this build hasn't had the cross-repo pass the 2026-09-17 build got before
   its own deploy).
2. **Deploy, in order** (load-bearing — see the knowledge doc's "Deploy order" section):
   - Bot to `main` → migration 018 applies → set `BOT_INTERNAL_SECRET` in
     `~/Granjur-Discord-Bot/.env` → `pm2 restart granjur-bot`.
   - CSAAS to `main` → migration applies at boot → set `DISCORD_BOT_URL` +
     `DISCORD_BOT_SECRET` (same value as `BOT_INTERNAL_SECRET`) in
     `/var/www/CSAAS/CSAAS_Backend/.env` → restart.
   - UBS-Doc (site) to `main`.
   Production env edits are asked for before they are made (spec §9). **The order is
   not cosmetic:** if CSAAS deploys before bot migration 018, the existing Team/Tasks
   page shows "Could not load tasks" until the bot deploy lands — the CSAAS read selects
   `roleNames`, a column migration 018 adds, so MySQL answers 1054 (unknown column) and
   the whole endpoint 500s.
3. **Live verification**: sign in on the site, open `/tools/team/board`, drag a card,
   confirm the Discord channel post reads "Name (via the site) updated this task:", a
   blocked card shows the warning toast, and moving a blocker to Done still fires the
   unblock notice on its dependents. Also spot-check `/tools/team` (People) and the
   dependency graph toggle on a project with a blocker.

## Knowledge / skills in use
- `.claude/knowledge/project-tasks-site.md` (this feature; extended this session).
- `.claude/rules/tests-never-touch-production.md` (binding for any further test work —
  unchanged this session, but every test run in this build had to honour the `db`/
  `getConfig` seams per that rule).

## Open threads (parked)
- FAQ error-lookup design, section 3.
- `STT_PROVIDER=soniox` experiment on the VM.

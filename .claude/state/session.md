# Current Session

**Date:** 2026-09-29

## Goal
Roadmap sub-project 2 (scope everywhere and meeting-task projects) is now built across all
three repos, not merged or deployed. This session's task was documentation: bot full suite,
knowledge and state, so the rollout and open items are on record before anyone acts on them.

## Outcome
- Bot full suite: `npm test 2>&1 | tail -15` from the repo root — 1339 tests, `fail 0`.
- Knowledge updated: `.claude/knowledge/csaas-meeting-workflow-integration.md` ("Scope and
  meeting-task projects" — CSAAS `meeting_tasks.scope`/`normalizeMeetingTaskScope`, bot
  `meetingTaskScope`/`meetingTaskModules`, the three project rules and
  `meetingTaskProject.js`, the review's `mtg_project` select and `pageSizeFor`), and
  `.claude/knowledge/project-tasks-site.md` ("Scope filter" — `?scope=` on Tasks/Board only,
  `none` covers legacy free text).
- State updated: `backlog.md` sub-project 2 marked BUILT, NOT DEPLOYED with the rollout as
  its checklist; `completed.md` gained a 2026-09-29 entry with commit hashes per repo.
- Committed as `docs: scope and meeting-project knowledge and state` (bot repo only — no
  branch switch, no push, no changes to the other two repos).

## Rollout — still to happen, each step needs the owner's go-ahead
1. Preview migration 028 on production (read-only, env-var credentials); `non_array_modules`
   must be 0, and the preview should also flag a scope containing a tab/newline (MySQL
   `TRIM()` strips only spaces, so such a value would move to `modules` instead of
   normalising).
2. Bot to `main` (runs migration 028 automatically).
3. CSAAS by hand: run `data/migrations/20260929_2_meeting_tasks_scope.sql` first, then
   trigger the manual deploy (CSAAS pushes to `main` do not auto-deploy).
4. Site to `main` (Vercel, on push).

Full detail: `.claude/state/backlog.md` sub-project 2.

## Open items (not part of this session's work)
- Owner question, carried from sub-project 1: should the org-level `Admin` role keep
  `seesAll` and link management, or only `Platform Admin`?
- The usman@granjur.com permission fix (CSAAS `20856ae`, site `a594551`, both already on
  `main`) is pushed and waiting on the same manual CSAAS deploy as this sub-project's
  rollout — one deploy covers both.

## Knowledge files touched this session
- `.claude/knowledge/csaas-meeting-workflow-integration.md`
- `.claude/knowledge/project-tasks-site.md`

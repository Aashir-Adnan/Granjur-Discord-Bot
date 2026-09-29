# Current Session

**Date:** 2026-09-29

## Goal
Roadmap sub-project 2 (scope everywhere and meeting-task projects): built via
subagent-driven development, reviewed per task and as a whole (the final review caught
migration 028 overwriting `task.updatedAt`; fixed), and merged into each repo's local
`main` (bot `f62baa4`, CSAAS `09b2f61`, site `4f6dc09`). Not pushed yet.

## Done this session
- Read-only preview of migration 028 on production: 146 tasks, 81 rows touched (2 case
  fixes, 79 free-text scopes to modules), `non_array_modules` 0, `has_ctrl_ws` 0 — safe.
- Corrected the CSAAS deploy fact everywhere: a push to CSAAS `main` deploys
  automatically, and CSAAS runs `data/migrations/` at startup before serving.

## Rollout — next, each push needs the owner's go-ahead
1. Push bot `main` (deploy runs migration 028).
2. Push CSAAS `main` (auto-deploys; its column migration runs at startup).
3. Push site `main` (Vercel).
4. Post-deploy check: `SELECT COUNT(*) FROM task WHERE scope IS NOT NULL AND scope NOT IN
   ('backend','frontend','qa','design')` must be 0.

Full detail: `.claude/state/backlog.md` sub-project 2.

## Open items
- Owner question, carried from sub-project 1: should the org-level `Admin` role keep
  `seesAll` and link management, or only `Platform Admin`?

## Knowledge files touched this session
- `.claude/knowledge/csaas-meeting-workflow-integration.md`
- `.claude/knowledge/project-tasks-site.md`
- `.claude/knowledge/identity-link.md`

# Current Session

**Date:** 2026-09-30

## Goal
Owner roadmap (see `backlog.md`, "Owner roadmap"). Sub-project 6 (JSON task import on the
site) is built and reviewed on branch `feat/task-import` in the bot, CSAAS and the site
(worktree `UBS-Doc-task-import`). It is NOT merged and NOT deployed. Next is sub-project 7
(meeting docs/JSON -> Claude -> tasks), not started; it begins with brainstorming.

## State
- Bot: `3b0fe06` spec, `3e7ec19` plan, `661f248`, `80eab9d`, `42bb8cd`, `0773409`, and the
  docs commit. CSAAS: `1f5a3d2`, `0edeca5`. Site: `a4ed386`, `8af25c8`, `37b93ee`, `43c9e88`.
- Suites: bot `npm test` 1590 tests, `fail 0`; CSAAS `import.test.js` and the
  `discord-tasks-test` loop clean, jest 5/5; site vitest 456 tests in 36 files, `tsc` clean.
- File cap is 90 KB (CSAAS's body parser), not the spec's original 256 KB.

## Open items
- Owner go-ahead to merge and push, in the order bot, then CSAAS, then site (the bot must be
  live first). No migration.
- Never exercised in a browser against a live backend. Deferred items are under roadmap item
  6 in `backlog.md`.
- Owner actions from sub-project 4 still outstanding (in `backlog.md`): tag Edarete's and
  Framework's repository links with scopes; add the Badar HMS mobile repository.

## Knowledge files touched this session
- `.claude/knowledge/task-import.md` (new)
- `.claude/knowledge/README.md` (index line)
- `.claude/knowledge/project-tasks-site.md` (pointer)

## Next steps
1. Owner: approve the merge and the rollout; then a live browser pass of the import.
2. Sub-project 7: brainstorm -> design -> spec -> plan -> build.

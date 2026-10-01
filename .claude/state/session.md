# Current Session

**Date:** 2026-10-01

## Goal
Owner roadmap (see `backlog.md`, "Owner roadmap"). All seven roadmap sub-projects are built,
merged and deployed. Sub-project 7 (tasks from a document, a document at `/record start`,
meeting notes as files) went live 2026-10-01.

## State
- Project soft delete: BUILT, NOT MERGED, NOT DEPLOYED. Bot `feat/project-soft-delete`
  (`2c6e5e3`, `1ea4336`, `725f77a`, `833a0cd`, `f160bce`, the docs commit `5dbd9e3`, then the
  final fix wave `fix(projects): archive every section child, restore managers, honest delete
  prompt, role check`), CSAAS `feat/project-soft-delete` (`605a582`). Suites green: bot 1832
  tests, `ℹ fail 0` (after the final fix wave); CSAAS
  `soft-delete.test.js` OK, loop no `FAILED`, jest 5 passed. Rollout bot then CSAAS, each push
  needs the owner's go-ahead (`backlog.md`). Knowledge `project-soft-delete.md`.
- Sub-project 7: CSAAS `1c9eb0c` (auto-deploys; not observed); bot `4cf460d`, whose deploy
  failed at `git pull` because the VM's `package-lock.json` had npm-written local changes;
  `bfb60af` fixed `.github/workflows/deploy.yml` (`git checkout -- package-lock.json` before
  the pull; prints `node --version`) and deployed: VM Node v24.13.0, bot online.
- Suites on the merged heads: bot `npm test` 1696 tests, `ℹ fail 0`; CSAAS `create.test.js OK`.
- Also this session: a bug no longer needs a repository (bot `830ef92`, site `1e7c357`).

## Open items
- Owner: decide on merging and pushing project soft delete (bot first, then CSAAS), then a live
  delete/reactivate pass on a scratch project.
- Owner: live passes — `/tasks-from-doc` (a small .md, then a PDF), `/record start document:`,
  a finished meeting's notes and report files; and the earlier ones still listed in
  `backlog.md` (site clock, task import, Discord clock smoke test, a bug with no repository).
- Deferred items under roadmap items 5, 6 and 7 in `backlog.md`.
- Owner actions from sub-project 4 still outstanding (in `backlog.md`): tag Edarete's and
  Framework's repository links with scopes; add the Badar HMS mobile repository.
- The bot working tree has an uncommitted stray edit to
  `docs/superpowers/plans/2026-09-30-json-task-import.md` and an untracked `brag-output/`
  (neither is from this work; left for the owner).

## Knowledge files touched this session
- `.claude/knowledge/project-soft-delete.md` (new), `.claude/knowledge/doc-tasks.md` (new; deploy gotcha added), `.claude/knowledge/README.md`,
  `.claude/knowledge/csaas-meeting-workflow-integration.md`

## Next steps
1. Owner: the live passes above.
2. Work the deferred backlog items, highest-risk first (in-process document extraction;
   approving a review needs no role).

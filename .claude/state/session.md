# Current Session

**Date:** 2026-10-01

## Goal
Owner roadmap (see `backlog.md`, "Owner roadmap"). Sub-project 7 (tasks from a document, a
document at `/record start`, meeting notes as files) is BUILT, NOT DEPLOYED and not merged.
All seven roadmap sub-projects are now built.

## State
- Branch `feat/doc-tasks` in the bot and in CSAAS (`D:\Work\Granjur Technologies\CSAAS_Backend`).
  Bot commits: spec `48f1f06`, plan `5597828`, `4d6782a`, `16334b3`, `b08b81e`, `24ad422`,
  `6e9d492`, `5ff14ec`, `826a127`, `be182b4`, then this docs commit. CSAAS: `6a159cf`.
- Suites on these heads: bot `npm test` 1677 tests, `ℹ fail 0`; CSAAS `create.test.js OK`,
  `utterance.test.js OK`.
- No migration. Rollout when the owner approves: merge, push CSAAS `main`, then the bot's
  `main` (see `backlog.md` item 7).

## Open items
- Owner: confirm the VM's Node version is >= 22 (PDF reading uses `unpdf`).
- Owner: a live pass of `/tasks-from-doc`, `/record start document:`, and a finished
  meeting's notes and report files.
- Deferred items under roadmap item 7 in `backlog.md`.
- Owner actions from sub-project 4 still outstanding (in `backlog.md`): tag Edarete's and
  Framework's repository links with scopes; add the Badar HMS mobile repository.
- The bot working tree has an uncommitted stray edit to
  `docs/superpowers/plans/2026-09-30-json-task-import.md` and an untracked `brag-output/`
  (neither is from this work; left for the owner).

## Knowledge files touched this session
- `.claude/knowledge/doc-tasks.md` (new), `.claude/knowledge/README.md` (index line),
  `.claude/knowledge/csaas-meeting-workflow-integration.md` (stage list, notes history,
  document jobs)

## Next steps
1. Owner: approve the merge and the rollout (CSAAS first, then the bot).
2. Owner: the live passes above.

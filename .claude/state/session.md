# Current Session

**Date:** 2026-09-03

## Goal
Merge `main` (the project-docs work) into `design/meeting-to-tasks-integration`, then
finish the meeting -> tasks pipeline: get it running end to end.

## Branch state
`design/meeting-to-tasks-integration`, forked at `88f6855`, 21 commits of meeting-pipeline
work. `main` moved 23 commits ahead in the meantime (the UBS-Doc sync + `/docs` rebuild),
now merged in here.

## Merge resolutions worth remembering
- **`/docs` is main's version.** This branch had added a second `/docs` root reading a
  local `ubs_doc` clone (`UBS_DOC_PATH`). `main` replaced `/docs` wholesale with a
  MySQL-backed browser fed by a GitHub sync of the same repo, so the local-clone route is
  superseded: `bot/src/services/docRoots.js` + its test are deleted and `UBS_DOC_PATH` is
  gone from `bot/.env.example`. The E2E runbook no longer asks for a clone.
  The spec and plan still describe the old approach — they are historical records.
- **Migrations renumbered.** `main` took `012` for `012_doc_pages.sql`, so this branch's
  three migrations moved up: `013_meeting_pipeline_job`, `014_task_external_meeting`,
  `015_task_externalid_unique`. None of them had been applied to any database yet.
- Both `startDocsSync` and `startMeetingPipelineWorker` now start from `bot/src/index.js`.
- `npm test` is `node --test` (bare), which discovers both this branch's colocated
  `*.test.js` files and main's `bot/test/` suite.

## Next
Finish the meeting pipeline. The one hard blocker is the live E2E run, which needs a real
`CSAAS_ACTOR_URDD` from the user (a URDD holding `add_meetings` + `run_meeting_ai` +
`update_meetings` + `view_meetings`). Runbook: `docs/meeting-pipeline-e2e-checklist.md`.
Everything else outstanding is in `backlog.md` under "Meeting -> tasks integration".

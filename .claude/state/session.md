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

## Live E2E — in progress (2026-09-04)
- `CSAAS_ACTOR_URDD=6` (holds all four meeting permissions — verified: 403 without it).
- CSAAS runs on the VM at `/var/www/CSAAS/CSAAS_Backend`, port 3000, root's pm2 `csaas`,
  nodemon (restarts on file change; migrations run on boot from `data/migrations/`).
- The bot runs LOCALLY over an SSH tunnel: `ssh -N -L 3000:127.0.0.1:3000 azureuser@VM`,
  so `CSAAS_API_URL=http://127.0.0.1:3000/api`. Production `granjur-bot` is stopped on
  the VM for the duration; restart it with `pm2 start granjur-bot` afterwards.
- Applied on the VM as LOCAL commits (ephemeral — see backlog): the four
  `feat/meeting-workflow-assign` cherry-picks (`/assign`, `skip_github`, `task_ids`),
  plus a fix making four meeting endpoints' `requestMethod` an array — the hand-written
  `{Add, List}` map never went through `ApiObjectsGenerator`, so `requestMethodValidator`
  405'd every method on `/issuesync` (and three siblings) on deployed main.
- Bot migrations 013–015 applied to the live bot DB. CSAAS's `meeting_task_assignees`
  migration ran on CSAAS boot (three nullable columns on `meeting_tasks`).
- First live tick failed: `LIMIT ?` / `INTERVAL ? SECOND` under prepared statements.
  Fixed in `fe4db8d`; smoke-tested live. Worker now ticks cleanly.
- Verified endpoints through the tunnel: `/assign` exists ("roster array is required"),
  `/issuesync` reaches its handler on POST and GET.

Remaining: a human must record a meeting (runbook §3) — everything from the `created`
stage onward is unexercised. A monitor on `meeting_pipeline_job` + the bot log is armed.

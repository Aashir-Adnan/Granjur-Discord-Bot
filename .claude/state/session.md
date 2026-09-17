# Current Session

**Date:** 2026-09-17

## Goal
Project tasks on the UBS-Doc site: tasks grouped by project from the bot's DB, project
members (explicit + inferred), several assignees per task, blocking dependencies.

## Where it stands
All 10 tasks of `docs/superpowers/plans/2026-09-17-project-tasks-site-section.md` are
implemented, reviewed, and committed — but nothing is merged or deployed yet. Built and
reviewed on branches:

- **Bot** (this repo): `feat/project-tasks-site`, suite 264 -> 317, 43 slash commands.
- **CSAAS** (`../CSAAS_Backend`): `feat/discord-tasks-endpoint`.
- **UBS-Doc** (`../UBS-Doc`): `feat/tasks-screen`.

Knowledge and state written up: `.claude/knowledge/project-tasks-site.md`,
`.claude/state/completed.md` (2026-09-17 entry), `.claude/state/backlog.md` (follow-ups
+ deferred minors). New binding rule: `.claude/rules/tests-never-touch-production.md`,
added after a test run during a fix round inserted one row into production (see the
rule file and the backlog item on the stray `guildconfig` row).

Final whole-branch review is done: "merge with fixes", no Critical findings. Its fixes
landed as bot `04dfd07`, CSAAS `a6fbb12` and UBS-Doc `93f8df0`, and their re-review came
back clean. Bot suite 318, site suite 122. Collation of `task`, `project` and
`guildconfig` on the VM was checked read-only: all `utf8mb4_general_ci`, so migration
017's foreign keys will attach. The deploy workflow now starts with `set -e`, so a
failed migration stops the restart.

## Deployed (2026-09-17)
Merged to `main` and live in all three repos, in order: bot `9161c7b` (migration 017
applied, 43 commands, 13 members named), CSAAS `a6fbb12` (endpoint returns 200 with
projects), UBS-Doc `93f8df0` (Vercel build). Feature branches deleted.

Note for next time: CSAAS's deploy runs `npm ci` before `pm2 restart`, so the API
returns 502 for roughly a minute mid-deploy. That is expected, not a failure.

## What remains
Discord-side checks: `/update-task ... blocked_by:`, move that task to in progress and
see the warning, mark the blocker done and see the unblock notice in the dependent
task's channel; `/project-members add`, then refresh `/tools/tasks`.

## Knowledge / skills in use
- `.claude/knowledge/project-tasks-site.md` (this feature, just written).
- `.claude/knowledge/project-docs.md` (the other bot<->site data path, for comparison).
- `.claude/rules/tests-never-touch-production.md` (binding for any further test work
  on this branch).

## Open threads (parked)
- FAQ error-lookup design, section 3.
- `STT_PROVIDER=soniox` experiment on the VM.

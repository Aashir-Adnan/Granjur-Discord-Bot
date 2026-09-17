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

## What remains
1. Final whole-branch review across all three repos (each task's review is done; the
   assembled branches as a whole have not had a last look).
2. Merge and deploy **in order**: bot -> `main` first, then CSAAS -> `main`, then
   UBS-Doc -> `main`. Each stage depends on the previous one being live (CSAAS's
   endpoint needs migration 017 on the bot's DB; the site needs CSAAS's endpoint).
3. Live verification per `docs/superpowers/plans/2026-09-17-project-tasks-site-section.md`
   section "Verification after deploy": pm2 logs show 43 commands + `[memberNameSync]`
   lines; `curl https://api.gobizzi.com/api/discord/tasks` returns `"projects"`; open
   `/tools/tasks`; in Discord, `/update-task ... blocked_by:` then mark the blocker done
   and confirm the warning and unblock notice; `/project-members add` then refresh the
   page.

## Knowledge / skills in use
- `.claude/knowledge/project-tasks-site.md` (this feature, just written).
- `.claude/knowledge/project-docs.md` (the other bot<->site data path, for comparison).
- `.claude/rules/tests-never-touch-production.md` (binding for any further test work
  on this branch).

## Open threads (parked)
- FAQ error-lookup design, section 3.
- `STT_PROVIDER=soniox` experiment on the VM.

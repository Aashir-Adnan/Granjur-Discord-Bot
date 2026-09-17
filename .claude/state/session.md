# Current Session

**Date:** 2026-09-17

## Goal
Project tasks on the UBS-Doc site: tasks grouped by project from the bot's DB, project
members (explicit + inferred), several assignees per task, blocking dependencies.
High priority per the user.

## Where it stands
- Spec approved and committed: `docs/superpowers/specs/2026-09-17-project-tasks-site-section-design.md`.
- Plan written: `docs/superpowers/plans/2026-09-17-project-tasks-site-section.md` (10 tasks:
  1-7 bot, 8 CSAAS, 9 UBS-Doc, 10 docs). Awaiting the user's choice of execution mode.

## Knowledge / skills in use
- `.claude/knowledge/project-docs.md` (UBS-Doc sync shape), `live-meeting-transcription.md`
  (CSAAS test seam pattern), superpowers brainstorming -> writing-plans -> (next)
  subagent-driven-development.

## Facts learned this session (not yet in knowledge/)
- Live site calls CSAAS at `https://api.gobizzi.com` (nginx -> :3000 on the VM).
- CSAAS MySQL user is `root@localhost` with grants on `*.*`; the bot's `granjur` DB is on
  the same server, so CSAAS can read it with `granjur.<table>` names.
- CSAAS path rule: `/api/discord/tasks` -> `global.DiscordTasks_object`.
- No Discord roles are named after projects; no `guildmember` has an email; `task.assigneeIds`
  is already a JSON list but no picker ever offered more than the free-text option.
- Local UBS-Doc clone exists at `../UBS-Doc`, at origin/main, with unrelated uncommitted
  edits (stage by file). Push access confirmed via `gh`.

## Open threads (parked)
- FAQ error-lookup design, section 3.
- `STT_PROVIDER=soniox` experiment on the VM.

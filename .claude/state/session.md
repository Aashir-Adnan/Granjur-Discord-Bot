# Current Session

**Date:** 2026-09-28

## Goal
Create and update Discord-bot tasks from the UBS-Doc site. Owner's words: "we need the
user to give option to create-task, update task on the ubs-doc too … on update anything
which can be updated from discord should be editable from there". Plan first, then
implement.

## Path
Architectural (three repos: site forms, CSAAS endpoints, bot internal routes). Brainstorm
→ written spec → plan → execution. Extends the existing three-hop write path
(site → CSAAS `/api/discord/tasks/status` → bot `/internal/tasks/status` →
`applyTaskUpdate`), which today carries status only.

## Knowledge in use
- `.claude/knowledge/project-tasks-site.md` (read path, write path, permission, error body)
- `.claude/knowledge/client-role.md`, `ticket-archive.md` (creation side effects)
- Rule: `.claude/rules/tests-never-touch-production.md`

## Earlier today (done)
- UBS-Doc sign-in fix: `users.photo_url` widened live to 2048 and CSAAS guard merged as
  `512624f` (not auto-deployed; the "Deploy to Azure" workflow has not run since 2026-09-12).

## Open questions
See the brainstorming exchange; recorded in the spec once written.

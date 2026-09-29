# Current Session

**Date:** 2026-09-29

## Goal
Roadmap sub-project 2: scope everywhere and meeting-task projects. Design approved in
chat; spec written at
`docs/superpowers/specs/2026-09-29-scope-and-meeting-projects-design.md` (branch
`feat/scope-meeting-projects`). Waiting on the owner's review of the spec, then the
implementation plan.

## Plan
Spec → owner review → implementation plan → build (three repos: bot, CSAAS, UBS-Doc) →
rollout bot → CSAAS (manual) → site.

## Done earlier today (already in completed.md or to be folded in)
- Identity link (sub-project 1) is merged, pushed and deployed on all three repos.
- usman@granjur.com permission fix: a permission on ANY active URDD now counts for the
  Discord endpoints and screens (CSAAS 20856ae, site a594551). CSAAS needs the owner's
  manual deploy.

## Knowledge/skill files in use
- `.claude/knowledge/csaas-meeting-workflow-integration.md`
- `.claude/knowledge/project-sections.md`
- `.claude/knowledge/project-tasks-site.md`
- `.claude/rules/tests-never-touch-production.md`

## Open questions
- Owner: should the org-level Admin role keep seesAll and link management, or only
  Platform Admin?
- Migration 028 preview query on production needs the owner's go-ahead before deploy.

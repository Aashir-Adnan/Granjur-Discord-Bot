# Current Session

**Date:** 2026-09-01

## Goal
Scope + design the "meeting → transcription → notes → tasks → assign to Discord
users" feature, bridging this bot to the CSAAS backend meeting workflow. Also:
`git clone` ubs_doc onto the VM and expose its markdown in `/docs`.

## Status: DESIGN / SPIKE — not yet approved, no code written

User decisions locked in:
1. Approved meeting-tasks become **real rows in the bot `task` table** (assignees,
   `externalId=csaas:<meeting_task_id>`); CSAAS `meeting_tasks` stays pipeline
   source-of-truth.
2. **No bot-side project index** — CSAAS `tracked_projects` + `REPOS_CLONE_BASE_DIR`
   is the single index; codebase search stays server-side. Bot only needs `UBS_DOC_PATH`.
3. **Assignment = explicit transcript statements only** ("X will do Y" → assign to Y).
   No capacity/skill/auto-balance logic. Unmatched → unassigned.
4. When a task IS pushed to GitHub, use the `[Agent Call]` marker so CSAAS's existing
   autonomous issue→PR agent picks it up.
5. Bot↔CSAAS uses CSAAS **platform encryption** (`aes.js`, AES-256-ECB CryptoJS).

Orchestration decision: **Approach A** — persisted `meeting_pipeline_job` table +
60s interval worker (pattern of `meetingReminder.js`), one stage/tick, idempotent,
restart-safe.

## Key findings (full detail: knowledge/csaas-meeting-workflow-integration.md)
- CSAAS pipeline is **already fully API-exposed** (~22 endpoints) and Soniox is
  **already wired** (`STT_PROVIDER=soniox`). GitHub push already gated on `GITHUB_PAT`.
- Real gaps: meeting endpoints have `encryption:false`/`accessToken:false` in `step()`
  → must flip for platform encryption; handlers need a **service URDD** (tenancy layer);
  add `skip_github` flag to `/approve`; build new `/assign` endpoint + `extractAssignments`
  agent + `meeting_task_assignees` table.
- Bot has audio capture done (per-speaker `.ogg` + `MeetingRecording` rows), a `task`
  table with `assigneeIds`/`externalId`, `guildmember.email` (same join key CSAAS uses),
  `createIssue()`, and a `/docs` markdown traversal with a path-traversal guard to reuse.
- Bot has **no Anthropic client** — not needed, AI stays in CSAAS.

## Effort estimate
~19–31 working days (~4–6 weeks) for a solid v1, one dev. Thin happy-path demo
~6–9 days. Dominant cost = Discord review/approval UX + orchestration + integration
testing (not the AI pipeline).

## Next step
Design doc WRITTEN + committed on branch `design/meeting-to-tasks-integration`:
`docs/superpowers/specs/2026-09-01-meeting-to-tasks-integration-design.md`.
Adjustment from user: **no authenticated/encrypted APIs for v1** — bot passes an
existing `actionPerformerURDD` (env `CSAAS_ACTOR_URDD`) as a plain body field over
localhost; encryption is a tracked hardening follow-up. Note: every CSAAS meeting
handler calls `requireMeetingPermission` (throws 403 without a URDD holding
`add_meetings`/`run_meeting_ai`/`update_meetings`), so that URDD must exist / be
seeded on the CSAAS side.
Spec approved. Implementation plan WRITTEN + committed:
`docs/superpowers/plans/2026-09-01-meeting-to-tasks-integration.md` — 17 tasks in
5 phases (P0 ubs_doc/`/docs`; P1 CSAAS: skip_github + /assign + /issuesync filter;
P2 csaasClient; P3 job table + task cols + worker skeleton; P4 the 8 pipeline
stages + review UI + interaction handlers + mirroring + issue sync + failure alerts).
Bot test runner introduced: `node:test` (`npm test` = `node --test`), no new deps.
User will provide the `CSAAS_ACTOR_URDD` (holds add_meetings/run_meeting_ai/update_meetings).

Branch: `design/meeting-to-tasks-integration`.
Next: execute the plan (subagent-driven per task, or inline).

## Open questions still to resolve in the spec
- Exact roster payload fields for `/assign` (ref = discordId? email?).
- How the bot obtains/holds its service URDD + tenant scope in CSAAS.
- Whether `/report` HTML is written to a bot-readable path or fetched via `/notes`.
- Segment upload ordering / how speaker labels ride along with `segment_index`.

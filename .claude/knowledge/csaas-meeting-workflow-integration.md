# CSAAS backend — meeting-workflow integration surface

Context for the planned feature: bot records a meeting → CSAAS transcribes/analyzes/
generates tasks → bot assigns tasks to Discord users (GitHub push optional).
CSAAS backend lives at `C:\Users\adnan\VS_Code\Clones\CSAAS\Backend`, runs on the
**same VM** as this bot. Master reference on that side:
`CSAAS/Backend/docs/meeting-workflow-flow.md` (exhaustive, file+line accurate).

## What already works on the CSAAS side (no build needed)

- **Full pipeline is already API-exposed** — ~22 endpoints, all defined as
  `global.MeetingWorkflow*_object` at the bottom of
  `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js` (~1880 lines).
  Path → object mapping: `/api/meeting/workflow/<seg>` → `MeetingWorkflow<Seg>_object`.
  Key ones: `/create`, `/transcribe` (multipart, `segment_index` 0=overwrite / >0=append
  `[Segment N]`), `/analyze`, `/tasks` (GET fetch / POST generate+persist), `/clarify`,
  `/approve`, `/report`, `/notes`, `/meeting` (full state restore), `/issuesync`
  (explicit per-task GitHub push, supports `dry_run`), `/context-files`.
- **Soniox STT is already wired** — `STT_PROVIDER=soniox` env toggle
  (`meetingWorkflow.js:5-11`), default is Whisper. Module:
  `Services/Integrations/AI/Soniox/transcribeAudioSoniox.js` (drop-in, multilingual
  en/ur `stt-async-v4`, needs `SONIOX_API_KEY`). Same toggle in
  `Src/Apis/ProjectSpecificApis/MeetingAdditionalNotes/meetingAdditionalNotes.js`.
- **GitHub push is already gated** — `/approve` (`approveTasks`, ~:834) creates issues
  only if `decision === "approved"` **and** `process.env.GITHUB_PAT` is set (~:868).
  Issues get the `[Agent Call]` title+body marker → CSAAS's own cron agent
  (`issueScannerCron`, every 6h, gated on `SCAN_FOR_ISSUES=true`) turns them into PRs.
- **Projects index already exists** — `tracked_projects` table (migration
  `CSAAS/Backend/docs/migrations/tracked_projects_table.sql`) + `REPOS_CLONE_BASE_DIR`
  env (`Src/Bootstrap/startup.js:26`) + `Services/SysScripts/AIScripts/codebaseSearch.js`
  (scoring search over locally-cloned repos). **The bot does NOT need its own project
  index** — codebase search stays server-side.
- AI agents: `Services/SysScripts/AIScripts/meetingAgents.js` (612 lines) —
  `analyzeMeetingTranscript`, `generateMeetingTasks`, `generateConciseNotes`,
  `generateHTMLReport`, `generateClarificationQuestions`, `revisedAnalysis`,
  `generateGithubIssue` (no-LLM formatter). All via `claudeAgent.js` → `claudeClient.js`
  (`CLAUDE_MODEL`, default `claude-sonnet-4-6`).

## Status — IMPLEMENTED (2026-09-02)

The gaps below are now **built**. CSAAS branch `feat/meeting-workflow-assign`:
plaintext transport + `actionPerformerURDD`, `skip_github` on `/approve`, the
`/assign` endpoint + `extractAssignments` agent + `meeting_task_assignees` table,
and an `/issuesync` `task_ids` filter. Bot side: `bot/src/services/csaasClient.js`
(AES envelope + `isConfigured`), `meeting_pipeline_job` table
(`bot/src/Database/meetingPipelineJob*.js`, migration 012),
`bot/src/services/meetingPipelineWorker.js` (`runTick` 60s loop, backoff,
`MAX_ATTEMPTS`, stage timeout, `notifyFailure`),
`bot/src/services/meetingPipelineStages.js` (10 stage runners +
`resolveMeetingChannel`), review UI (`bot/src/services/meetingReviewUI.js` +
`bot/src/commands/meetingReview.js`, `/meeting-review` `/meeting-retry`), `task`
mirroring with `externalId`/`meetingId` (migration 013), and the ubs_doc `/docs`
root via `UBS_DOC_PATH`. Manual E2E runbook:
`docs/meeting-pipeline-e2e-checklist.md`. Remaining follow-ups are in
`.claude/state/backlog.md` (live E2E run, enqueue hook, `findLatest`, env truthiness).

## Gaps that must be built for this integration

1. **Auth / encryption on the meeting endpoints.** `step()` (`meetingWorkflow.js:64`)
   hard-sets `communication.encryption:false`, `verification.accessToken:false`,
   `permission:null`. To talk to them with **platform encryption** (user's choice) the
   flags must be flipped (or an authenticated endpoint variant added). Encryption
   helper: `Services/SysFunctions/Encryption/aes.js` → `{ encryptObject, decryptObject }`
   (AES-256-ECB, CryptoJS, two-layer: request secret key + response platform key).
2. **Service identity.** Handlers run a tenancy layer keyed on `actionPerformerURDD`
   (`getActorUrdd`, `actorScope` → `resolveProjectScope`; `meetingAuthz.js`,
   `meetingHierarchy.js`, `ProjectTenancy/projectScope.js`). The bot needs a **service
   URDD** with tenant + repo scope, passed on every call.
3. **`skip_github` flag on `/approve`** — currently the only way to not push is to
   unset the global `GITHUB_PAT`. Need a per-call opt-out so the bot approves tasks,
   assigns them to Discord users, and only pushes the ones the operator toggled.
4. **New `/assign` endpoint + `extractAssignments()` agent** — input
   `{ meeting_id, roster:[{ref,displayName,aliases[]}] }`; matches **explicitly stated
   ownership in the transcript** ("X will do Y") to roster entries; returns
   `{task_id, assignee_ref|null, quote, confidence}`; unmatched → null. New
   `meeting_task_assignees` column/table. No auto-balancing / capacity logic —
   explicit transcript statements only (user decision).

## CSAAS schema note (their `meetings` table ≠ bot `meeting` table)

CSAAS: `meetings.meeting_id`, `status` enum (`pending`→`transcribed`→`analyzed`→
`tasks_generated`→`approved`/`rejected`→`report_ready`→`completed`), `current_stage`
0–5, `transcript`, `analysis_json`, `pre_meeting_notes`; `meeting_tasks`
(`project/platform/feature/sub_feature/code_residence/goal_of_task/intended_actions_json`,
`status`), `meeting_notes`, `meeting_html_reports`, `meeting_github_issues`,
`meeting_stage_costs`. The bot's `meeting` row stays a thin local record; CSAAS
`meeting_id` is the pipeline key, stored on the bot-side pipeline job.

## Bot-side shape (IMPLEMENTED — file pointers above)

- `csaasClient.js` — CryptoJS-compatible encrypted HTTP client + service URDD; env
  `CSAAS_API_URL`, `CSAAS_PLATFORM_KEY`/secret, `CSAAS_SERVICE_URDD`.
- `meeting_pipeline_job` table + 60s interval worker (pattern: `meetingReminder.js`),
  one stage per tick, idempotent, retry w/ backoff, restart-safe.
- Trigger: `MeetingRecordingStatus → completed` (see
  [meeting-audio-recording.md](meeting-audio-recording.md)) → enqueue → create CSAAS
  meeting → upload each `MeetingRecording` `.ogg` as a `/transcribe` segment
  (speaker-labelled) → `/analyze` → `/tasks` → `/assign`.
- Review UI in the meeting text channel: notes + local HTML-report link + per-task
  row (assignee user-select, "Push to GitHub" toggle, Approve/Reject) + "Approve all".
- On approval: `/approve {skip_github:true}` → create real rows in the bot `task`
  table (`assigneeIds=[discordId]`, `externalId=csaas:<meeting_task_id>`,
  `projectName`, `status='open'`) → ping assignees → `/issuesync` for GitHub-flagged
  tasks (with `[Agent Call]` marker).

## ubs_doc

`C:\Users\adnan\VS_Code\Clones\UBS_Doc` — Docusaurus 3.9 site. For this feature: just
`git clone` it on the VM, set `UBS_DOC_PATH` (relative), and mount its `docs/` as a
read-only branch in the existing `/docs` traversal (`bot/src/commands/docs.js`,
reuse the `resolveDocsPath` path-traversal guard). **No HTTP serving, no Firebase
portal** — markdown browsing only.

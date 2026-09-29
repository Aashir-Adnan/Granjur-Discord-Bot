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
(`bot/src/Database/meetingPipelineJob*.js`, migration 013),
`bot/src/services/meetingPipelineWorker.js` (`runTick` 60s loop, backoff,
`MAX_ATTEMPTS`, stage timeout, `notifyFailure`),
`bot/src/services/meetingPipelineStages.js` (10 stage runners +
`resolveMeetingChannel`), review UI (`bot/src/services/meetingReviewUI.js` +
`bot/src/commands/meetingReview.js`, `/meeting-review` `/meeting-retry`), `task`
mirroring with `externalId`/`meetingId` (migration 014). Manual E2E runbook:
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
   URDD** with tenant + repo scope, passed on every call. Required permission set
   (union over the endpoints the bot hits — `/create`, `/transcribe`, `/analyze`,
   `/tasks` POST, `/assign`, `/notes`, `/meeting`, `/approve`, `/issuesync` POST):
   `add_meetings` (`/create`), `run_meeting_ai` (`/transcribe`, `/analyze`,
   `/tasks` POST, `/assign`), `update_meetings` (`/approve`, `/issuesync` POST),
   `view_meetings` (`/notes`, `/meeting`).
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

## ubs_doc — superseded

This feature originally planned to `git clone` ubs_doc onto the VM and mount its `docs/`
as a second read-only root in `/docs` via `UBS_DOC_PATH`. **That approach is gone.**
`main` replaced `/docs` with a MySQL-backed browser fed by a 15-minute sync of the same
repository from GitHub, so no clone and no local path are involved any more. See
[[project-docs]]. The `UBS_DOC_PATH` env var and `bot/src/services/docRoots.js` were
removed when `main` merged into this branch on 2026-09-03.

## Operational gotchas found on the first live run (2026-09-04)

**CSAAS's Claude CLI reads `azureuser`'s credentials, not root's.** The server runs as
root under root's pm2, but `Services/SysScripts/AgentScripts/claudeClient.js` overrides
`HOME` when it spawns the CLI:

    const effectiveHome = process.env.CLAUDE_CLI_HOME || "/home/azureuser";

So the credential store that matters is `/home/azureuser/.claude/.credentials.json`.
Authenticating with `sudo -i` + `claude auth login` writes `/root/.claude/` and changes
nothing — the symptom is `401 OAuth access token has expired` from `/analyze` while a
manual `sudo -H claude` succeeds. **Log in as `azureuser`, no sudo.** Every AI stage
(`analyzing`, `generating_tasks`, `assigning`) depends on this; transcription does not,
because Soniox is a separate credential.

**Retry scheduling must use the database clock.** `nextAttemptAt` is compared against
MySQL's `NOW(3)`. Writing it as a JS `Date` makes mysql2 serialise it in the Node
process's local timezone, so with Node on UTC+5 and MySQL on UTC every backoff landed
five hours late and the job was never re-claimed. Fixed by sending an offset and letting
MySQL compute `NOW(3) + INTERVAL n SECOND`. Any future column compared against a SQL
clock needs the same treatment.

**`LIMIT ?` and `INTERVAL ? SECOND` cannot be bound.** `query()` uses prepared statements;
mysql2 binds a JS number as a DOUBLE and MySQL rejects it with `Incorrect arguments to
mysqld_stmt_execute`. Inline a clamped integer instead. Seven other `LIMIT ?` sites in
`bot/src/Database/index.js` still have this latent bug — see the backlog.

**`/issuesync` and three sibling endpoints 405'd on every method** on deployed CSAAS main.
`meetingWorkflow.js` is hand-written and never passes through `ApiObjectsGenerator`, so
its `requestMethod: { Add: "POST", List: "GET" }` map reached `requestMethodValidator`
raw and matched nothing. It must be a plain array: `requestMethod: ["POST", "GET"]`.

## Scope and meeting-task projects (2026-09-29, roadmap sub-project 2 — BUILT, NOT DEPLOYED)

Two changes riding the same three-repo rollout (bot → CSAAS manual → site — see
`backlog.md`). Spec `docs/superpowers/specs/2026-09-29-scope-and-meeting-projects-design.md`.

**Scope is one of four values or NULL, never free text.** CSAAS `meeting_tasks.scope`
(migration `data/migrations/20260929_2_meeting_tasks_scope.sql`) holds `backend` /
`frontend` / `qa` / `design` or NULL. `normalizeMeetingTaskScope(value)`
(`Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingTaskScope.js`) lowercases/trims and
returns `null` for anything else; it runs in `generateTasks`, `addTask` and `updateTask`,
so a client or Claude sending garbage can never leave stale free text in the column. The
task-generation prompt now asks Claude for one of the four in its schema.

On the bot, `meetingTaskMap.js`'s `meetingTaskScope(csaasTask)` picks, in order: Claude's
`scope` if valid (`isValidScope`, new leaf `bot/src/utils/taskScope.js` — also exports
`SCOPE_CHOICES`/`scopeLabel`, the same four values `/create-task` and `/update-task`
already offered as a picker); else by `platform` (`node`/`python` → `backend`,
`react`/`react-native` → `frontend`); else `null` (no scope at all). `meetingTaskModules
(csaasTask)` returns the de-duplicated, non-empty `[feature, sub_feature]` — what used to
be written into `scope` as free text ("GitSync") now lands in `modules` instead.
`mapMeetingTaskToRow` uses both. Migration `bot/src/Database/migrations/
028_task_scope_fixed_values.sql` does the equivalent cleanup for `task.scope` rows already
on disk: a case/whitespace variant of the four values is normalised, a blank scope becomes
NULL, anything else is appended to `modules` (unless already there) and then cleared from
`scope`. Idempotent (a second run matches no rows); SQL-only with no unit test (no test
database — see `tests-never-touch-production.md`); a read-only preview query must run on
production, with the owner's go-ahead, before the bot deploys it (`backlog.md` has the
query and the `non_array_modules` guard). Every one of its four UPDATEs also sets
`updatedAt = updatedAt`, so none of the rows it touches gets bumped to deploy time (MySQL
skips the column's `ON UPDATE CURRENT_TIMESTAMP(3)` only when the column is set
explicitly) — without it, every `ORDER BY updatedAt desc` view (`/update-task`,
`/clock-in`, taskFinder, taskHub, the site's "Last updated") would misreport old meeting
tasks as just-touched.

When a guild has no projects at all (or the project read failed), `awaitingReviewStage`
does not ask "Which project?" for anything — `initReviewState` is called with no settle
function at all, so every task falls back to legacy behaviour (`needsProject: false`, the
usual 2-per-page), instead of asking via a select whose only option would be "No project".

**A meeting task's project is settled per task, in three rules.**
`bot/src/services/meetingTaskProject.js`:
1. the **meeting's own project** — `meeting.projectId`, set by `/meeting-channel`;
2. the **named project** — `matchProject(csaasTask.project, ctx)`, as before;
3. the **reviewer's pick** in the review UI — reached only when 1 and 2 both miss.

`loadProjectContext(db, job)` loads `{ projects, repos, links, meetingProjectId }` once per
pipeline stage (best-effort: a failed read leaves that part empty, so the rules fall
through as if it were unset). `settledProject(csaasTask, ctx)` runs rules 1–2 and returns
`null` when the task is unclear. `resolveMeetingTaskProject(csaasTask, reviewTask, ctx)`
adds rule 3 and the repository — the matched repository is kept only when the match's
project is the chosen project (sub-project 4 will pick repositories by scope instead). **A
task with no project ends up with `projectName: null` too** — the CSAAS-spoken name is
never kept once no project settles, so it can never show up on the site as a stray
project group of one.

**The review message asks about unclear tasks.** `initReviewState` (`meetingReviewUI.js`)
gains, per task: `needsProject` (true only when `settledProject` returned `null`),
`projectId` (starts `null`) and `projectLabel` (the settled project's name, for a task that
doesn't need asking). `buildReviewMessage` reads `job.dataJson.reviewProjects` — written
once by `awaitingReviewStage` as `reviewProjectOptions(projectCtx.projects)` (sorted by
name, capped at `REVIEW_PROJECT_LIMIT = 24`, so every re-render offers the same list) —
and renders a `mtg_project:<jobId>:<taskId>` string select, placeholder "Which project?",
options = the capped project list plus "No project" (value `none`), but **only** on a task
where `needsProject` is true. `meetingReview.js` routes the `mtg_project` component kind to
`{ type: 'project', taskId, projectId }`; `applyReviewAction` stores a `none` pick as
`projectId: null`. `pageSizeFor(state)` drops the page to **1** task (from the usual
`PAGE_SIZE = 2`) whenever any task on the job has `needsProject` true, rejected or not: a
`needsProject` task uses 3 component rows (assignee select, project select, GitHub/Drop
buttons) plus the 1-row footer, so two such tasks on one page would exceed Discord's
5-action-row ceiling. `mirroredStage` re-derives the final `projectId`/`projectName`/
`repositoryId` via `resolveMeetingTaskProject` at mirror time, using the reviewer's stored
`projectId` for rule 3; a job already `awaiting_review` at deploy time has no
`needsProject`/`projectId` in its state, so its tasks resolve by rules 1–2 then `null` —
the same as today, plus the new rule 1.

Files: `bot/src/services/meetingTaskProject.js` (+ test), `bot/src/services/
meetingTaskMap.js` (+ test), `bot/src/utils/taskScope.js` (new), `bot/src/services/
meetingReviewUI.js`, `bot/src/commands/meetingReview.js`, `bot/src/services/
meetingPipelineStages.js` (`awaitingReviewStage`, `mirroredStage`), migration `028_
task_scope_fixed_values.sql`. CSAAS: `Src/Apis/ProjectSpecificApis/MeetingWorkflow/
meetingTaskScope.js` (new), `meetingWorkflow.js`, `meetingAgents.js` (prompt schema),
migration `20260929_2_meeting_tasks_scope.sql`. Rollout order and the preview query are in
`.claude/state/backlog.md`.

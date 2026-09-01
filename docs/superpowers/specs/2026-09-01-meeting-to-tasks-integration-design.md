# Meeting → Transcription → Notes → Tasks → Assignment — Design

**Date:** 2026-09-01
**Status:** Draft for review
**Repos touched:** `Granjur-Discord-Bot` (primary), `CSAAS/Backend` (secondary)

---

## 1. Overview

Today the bot records meetings to disk (one OGG-Opus file per speaker, rows in
`MeetingRecording` / `MeetingRecordingStatus`) and stops there. Separately, the CSAAS
backend already runs a complete meeting-analysis pipeline
(transcribe → analyze → generate tasks → GitHub issues → autonomous PR agent),
exposed as ~22 HTTP endpoints under `/api/meeting/workflow/*`.

This feature **bridges the two**: when a bot-recorded meeting ends, the bot drives the
CSAAS pipeline over HTTP, gets back concise notes + a task list, uses Claude (on the
CSAAS side) to read **who was explicitly assigned to what in the transcript**, and
posts a review UI in Discord. On approval the tasks become real rows in the bot's
`task` table assigned to Discord users — **not** GitHub issues — with a per-task
opt-in to also push to GitHub (which hands off to CSAAS's existing autonomous agent).

Also in scope: `git clone` the `ubs_doc` Docusaurus repo onto the VM and expose its
markdown files through the existing `/docs` browser.

### 1.1 Goals

- End-to-end: bot meeting recording → Soniox transcription → Claude notes + tasks →
  Claude assignment extraction → Discord review → bot `task` rows assigned to users.
- Reuse the CSAAS pipeline as-is; add the minimum on that side.
- Per-task optional GitHub push using the `[Agent Call]` marker.
- `ubs_doc` markdown browsable via `/docs`.
- Restart-safe orchestration (a bot restart mid-pipeline resumes cleanly).

### 1.2 Non-goals (v1)

- Pre-meeting notes / agenda capture at `/schedule` time.
- Clarify ⇄ revise loop.
- Audio mixing into a single meeting track (per-speaker segments instead).
- Assignment by skill/capacity/load balancing — **explicit transcript statements only**.
- Authenticated / encrypted bot↔CSAAS transport (see §4.1 — deferred, plaintext
  localhost + a reused `actionPerformerURDD` field for v1).
- Serving `ubs_doc` over HTTP or its Firebase portal.
- Multi-guild fan-out concerns beyond what already exists.

---

## 2. Current state

### 2.1 Bot (`Granjur-Discord-Bot`)

| Piece | State | Reference |
|---|---|---|
| Per-speaker audio capture → `.ogg` + `MeetingRecording` rows | Done | `bot/src/services/voiceCapture.js`, `.claude/knowledge/meeting-audio-recording.md` |
| `MeetingRecordingStatus.status` → `completed` on session end | Done | `voiceCapture.js` `endMeetingSession` |
| `meeting` table (thin local row: `transcript`, `notes` TEXT) | Done | `bot/src/Database/schema.sql` |
| `task` table w/ `assigneeIds` JSON, `externalIssueUrl/Number`, `externalId`? | Partial — has `assigneeIds`, `externalIssueUrl`, `externalIssueNumber`; **no `externalId`, no `meetingId`** | `schema.sql` `CREATE TABLE task` |
| `guildmember` maps `discordId` ↔ `email` | Done — same join key CSAAS uses | `schema.sql` |
| `createIssue(repoUrl, title, body)` | Done | `bot/src/services/github.js` |
| `/docs` markdown traversal w/ path-traversal guard | Done — rooted at `bot/docs/` only | `bot/src/commands/docs.js` |
| Interval-worker pattern (60s tick) | Exists — copy this | `bot/src/services/meetingReminder.js` |
| Anthropic client | **None** — not needed, AI stays in CSAAS | — |
| HTTP server | Minimal `/verify` only | `bot/src/server.js` |

### 2.2 CSAAS backend

Full map: `CSAAS/Backend/docs/meeting-workflow-flow.md`. Salient points:

- **All pipeline endpoints already exist and work** — `/create`, `/transcribe`
  (multipart; `segment_index` 0 = overwrite, >0 = append `[Segment N]`), `/analyze`,
  `/tasks` (GET fetch / POST generate+persist), `/approve`, `/report`, `/notes` (GET),
  `/meeting` (GET full-state restore), `/issuesync` (explicit per-task GitHub push,
  `dry_run` supported), `/context-files`.
- **Soniox already wired** — `STT_PROVIDER=soniox` env toggle
  (`meetingWorkflow.js:5-11`); module
  `Services/Integrations/AI/Soniox/transcribeAudioSoniox.js` (needs `SONIOX_API_KEY`).
- **GitHub push already gated** — `/approve` (`approveTasks`, ~:834) creates issues
  only when `decision === "approved"` **and** `process.env.GITHUB_PAT` is set (~:868),
  with the `[Agent Call]` marker.
- **Every handler calls `requireMeetingPermission(req, dp, "<verb>", meetingId)`**
  (`meetingAuthz.js`) which throws 403 unless the acting URDD
  (`dp.actionPerformerURDD` / `req.body.actionPerformerURDD`) holds the verb permission
  (`add_meetings`, `run_meeting_ai`, `update_meetings`, `list_meetings`).
- `step()` (`meetingWorkflow.js:64`) sets `communication.encryption:false`,
  `verification.accessToken:false` — so **transport is plaintext today**; the auth
  that exists is the app-level `requireMeetingPermission` verb check + tenant/repo
  scope, all keyed on the `actionPerformerURDD` body field.
- Projects index already server-side: `tracked_projects` table +
  `REPOS_CLONE_BASE_DIR` + `codebaseSearch.js`.

---

## 3. Architecture

```
 Discord VC ──record──> voiceCapture ──MeetingRecordingStatus=completed──┐
                                                                        ▼
                        ┌──────────────  BOT  ──────────────────────────────────────┐
                        │  meetingPipelineWorker (60s tick, meeting_pipeline_job)   │
                        │   stage machine, 1 step/tick, idempotent, retry+backoff   │
                        └───────┬───────────────────────────────────────────────────┘
                                │ csaasClient (plaintext HTTP, actionPerformerURDD field)
                                ▼
      ┌────────────────────  CSAAS /api/meeting/workflow  ────────────────────────┐
      │ /create → /transcribe (×N segments) → /analyze → /tasks → /assign (NEW)   │
      │ → /notes (fetch) ;  later: /approve {skip_github} , /issuesync            │
      └─────────────────────────────────────────────────────────────────────────────┘
                                │ results (analysis, tasks, assignments, notes, html)
                                ▼
                     Bot posts REVIEW UI to the meeting text channel
                   (notes + report link + per-task: assignee select,
                    "push to GitHub" toggle, Approve / Reject, Approve all)
                                │ operator approves
                                ▼
      ┌── Bot: POST /approve {decision:"approved", skip_github:true}              ┐
      │    for each approved task: INSERT INTO task (assigneeIds=[discordId],     │
      │      externalId="csaas:<meeting_task_id>", meetingId, projectName, …)     │
      │    ping assignees in-channel                                              │
      │    for tasks toggled GitHub → POST /issuesync {task_ids:[…], owner, repo} │
      │      (CSAAS creates "[Agent Call]" issue → its cron agent opens the PR)   │
      └─────────────────────────────────────────────────────────────────────────────┘
```

**Division of responsibility**

| Concern | Owner |
|---|---|
| STT, transcript storage, analysis, task generation, notes/HTML, assignment extraction, GitHub issue creation | CSAAS (source of truth for the pipeline) |
| Triggering + sequencing the pipeline, restart safety | Bot |
| Discord identity ↔ person mapping, roster | Bot |
| Review/approval UX | Bot |
| The canonical **assigned task** record used for pings / `/update-task` | Bot `task` table (mirror, linked by `externalId`) |
| Local project/codebase index | CSAAS (`tracked_projects`) — bot has none |
| `ubs_doc` markdown | Bot filesystem (`git clone` + `/docs`) |

---

## 4. Component design

### 4.1 Transport & auth (v1: minimal)

Per decision, **no new auth system and no platform encryption for now.**

- Bot calls `http://<CSAAS_HOST>:<port>/api/meeting/workflow/*` directly (same VM,
  ideally bound to localhost).
- Each request body includes `actionPerformerURDD: <CSAAS_ACTOR_URDD>` — a **single
  pre-existing URDD id**, configured in bot env, belonging to a CSAAS user/role that
  holds `add_meetings`, `run_meeting_ai`, and `update_meetings` and has tenant + repo
  scope covering the tracked repos (or `seesAll`). No code change on CSAAS for this —
  the field is already read from `req.body`.
- **CSAAS change required:** none for transport. If that URDD does not exist yet it
  is a one-time data/seed task on the CSAAS side (create the user/role/permissions),
  not code.

> **Hardening follow-up (out of scope, tracked in backlog):** flip the `step()`
> flags to enable platform encryption (`Services/SysFunctions/Encryption/aes.js`,
> AES-256-ECB CryptoJS) and issue the bot a dedicated service token. The
> `csaasClient` module (§4.3) is the single place that changes when we do.

### 4.2 CSAAS backend changes

Small, additive. Keep everything else untouched.

#### 4.2.1 `STT_PROVIDER=soniox`
Config only: set `STT_PROVIDER=soniox` and `SONIOX_API_KEY` in the CSAAS `.env`.
Optionally `SONIOX_LANGUAGE_HINTS=en,ur` (already the default).

#### 4.2.2 `skip_github` flag on `/approve`
In `approveTasks` (`meetingWorkflow.js` ~:868), change the GitHub-creation guard from

```js
if (decision === "approved" && process.env.GITHUB_PAT) {
```
to
```js
if (decision === "approved" && process.env.GITHUB_PAT && !decryptedPayload.skip_github) {
```

Add `skip_github` to the endpoint's declared fields
(`step(approveTasks, ["meeting_id", "decision", "skip_github"])`, ~:1727). Default
false → existing callers unaffected.

#### 4.2.3 New `/assign` endpoint + `extractAssignments` agent

**Endpoint:** `global.MeetingWorkflowAssign_object = { versions:{ versionData:[{ "*":{
steps:[ step(assignTasks, ["meeting_id", "roster"]) ] } }] } };`

**Handler `assignTasks(req, dp)`:**
1. `requireMeetingPermission(req, dp, "run_meeting_ai", dp.meeting_id)`.
2. Load meeting + transcript + `meeting_tasks` for `meeting_id`.
3. `roster` = array of `{ ref, displayName, aliases: string[] }` (bot supplies it;
   `ref` is opaque to CSAAS — it's the Discord user id).
4. Call `extractAssignments(transcript, analysis, tasks, roster)` (new fn in
   `meetingAgents.js`).
5. Persist: `UPDATE meeting_tasks SET assignee_ref=?, assignee_quote=?,
   assignee_confidence=? WHERE task_id=?` for each result.
6. Return `{ assignments: [{ task_id, assignee_ref|null, quote, confidence }] }`.

**Agent `extractAssignments(transcript, analysis, tasks, roster)`** — one Claude call
via the existing `runClaudeAgent` (JSON). System prompt in brief:

> You are given a meeting transcript, a list of generated tasks, and a roster of team
> members. For each task, determine whether the transcript **explicitly** states who
> will do it (e.g. "Ali will handle the login screen", "I'll take the migration" said
> by a named speaker). Only assign when a specific person is named or clearly
> self-assigns. Match to exactly one roster entry by name/alias. If ownership is not
> explicitly stated, return `assignee_ref: null`. Never guess based on expertise or
> who talked most. Return the supporting quote and a confidence 0–1.

Output schema:
```json
{ "assignments": [
  { "task_id": "...", "assignee_ref": "discordUserId | null",
    "quote": "verbatim transcript span or ''", "confidence": 0.0 }
] }
```

Cost logged via the existing `logStageCost(..., "assign", ...)`.

#### 4.2.4 Migration (CSAAS)
```sql
ALTER TABLE meeting_tasks
  ADD COLUMN assignee_ref       VARCHAR(64)  NULL,
  ADD COLUMN assignee_quote     TEXT         NULL,
  ADD COLUMN assignee_confidence DECIMAL(3,2) NULL;
```
Placed in `CSAAS/Backend/data/migrations/` (auto-run on startup per their convention).

#### 4.2.5 `/issuesync` — already sufficient
Takes `meeting_id`, `owner`, `repo`, optional task filter, `dry_run`. Bot calls it
post-approval for the GitHub-toggled tasks. Confirm during implementation whether it
accepts an explicit `task_ids` filter; if not, add one (small — it already loops over
approved tasks).

### 4.3 Bot: `csaasClient.js`

`bot/src/services/csaasClient.js` — the **only** module that knows the CSAAS wire
format. Thin wrapper over `node-fetch` (already a dep).

```
createMeeting({ title, participants, scopeRepoIds? }) -> { meeting_id }
transcribeSegment(meetingId, { buffer, filename, segmentIndex }) -> { preview }
analyze(meetingId) -> { analysis }
generateTasks(meetingId) -> { tasks: [...] }
assign(meetingId, roster) -> { assignments: [...] }
fetchNotes(meetingId) -> { notes, html }
fetchMeeting(meetingId) -> { ...full state }
approve(meetingId, { decision, skipGithub }) -> { tasks }
issueSync(meetingId, { owner, repo, taskIds, dryRun }) -> { issues: [...] }
```

- Base URL from `CSAAS_API_URL`; injects `actionPerformerURDD: CSAAS_ACTOR_URDD` into
  every body (and multipart field for `/transcribe`).
- Multipart uploads via global `FormData`/`Blob` (Node 18+, same as the Soniox module).
- Normalizes the `{ payload: { return: {...} } }` envelope → returns `.payload.return`.
- Throws `CsaasError` with status + CSAAS message on non-200 or `status !== 200`.
- No ret/backoff here — the worker owns retries (§4.4).

### 4.4 Bot: pipeline orchestration

#### 4.4.1 `meeting_pipeline_job` table (bot migration)
```sql
CREATE TABLE IF NOT EXISTS meeting_pipeline_job (
  id              VARCHAR(36) PRIMARY KEY,
  guildConfigId   VARCHAR(36) NOT NULL,
  meetingId       VARCHAR(36) NOT NULL,           -- bot meeting.id
  csaasMeetingId  VARCHAR(64),                    -- filled after /create
  stage           VARCHAR(32) NOT NULL DEFAULT 'created',
  status          VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending|working|blocked|done|failed
  attempts        INT NOT NULL DEFAULT 0,
  nextAttemptAt   DATETIME(3),
  lastError       TEXT,
  reviewMessageId VARCHAR(64),                    -- the review UI message
  dataJson        JSON,                           -- analysis, tasks, assignments, notes cache
  createdAt       DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt       DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY (meetingId),
  KEY (status), KEY (stage), KEY (nextAttemptAt),
  FOREIGN KEY (guildConfigId) REFERENCES guildconfig(id) ON DELETE CASCADE,
  FOREIGN KEY (meetingId) REFERENCES meeting(id) ON DELETE CASCADE
);
```

Stages (linear):
`created → transcribing → analyzing → generating_tasks → assigning → awaiting_review
→ approved → mirrored → issue_syncing → done`
plus terminal `failed`.

#### 4.4.2 Enqueue
When `voiceCapture.endMeetingSession` sets `MeetingRecordingStatus.status='completed'`,
also `INSERT` a `meeting_pipeline_job` (`stage='created'`, `status='pending'`) for that
`meetingId` (skip if the meeting had zero `MeetingRecording` rows). One-line hook.

#### 4.4.3 Worker `bot/src/services/meetingPipelineWorker.js`
- `setInterval(tick, 60_000)`, started from `bot/src/index.js` next to
  `meetingReminder`.
- Each tick: `SELECT * FROM meeting_pipeline_job WHERE status IN ('pending','blocked')
  AND (nextAttemptAt IS NULL OR nextAttemptAt <= NOW()) ORDER BY updatedAt LIMIT 3`.
- For each job: mark `working`, run **one** stage transition, persist result into
  `dataJson`, advance `stage`, set `status='pending'` for the next tick (or `blocked`
  for `awaiting_review`, or `done`).
- Each stage handler is **idempotent** and safe to re-enter (e.g. `transcribing`
  records which `MeetingRecording.id`s have been uploaded in `dataJson.uploaded[]`).
- On throw: `attempts++`, `lastError`, exponential `nextAttemptAt`
  (1m, 5m, 15m, 1h, capped). After `attempts >= 6` → `status='failed'` + alert the
  meeting channel ("pipeline failed at <stage>: <error> — retry with `/meeting-retry`").
- `awaiting_review` and `approved` are driven by button interactions, not the timer
  (the worker just leaves `blocked` jobs alone; interactions flip them).

#### 4.4.4 Stage details

| Stage | Action |
|---|---|
| `created` | `csaas.createMeeting({ title: deriveMeetingName(...), participants: roster displayNames })` → store `csaasMeetingId` |
| `transcribing` | for each not-yet-uploaded `MeetingRecording` (ordered by `startedAt`): read file, `csaas.transcribeSegment(csaasMeetingId, { buffer, filename: "<speakerLabel>.ogg", segmentIndex: i })`. Speaker label = guild displayName or email local-part (already the filename). Missing file → skip + note. If **all** files missing → fail. |
| `analyzing` | `csaas.analyze(csaasMeetingId)` → `dataJson.analysis` |
| `generating_tasks` | `csaas.generateTasks(csaasMeetingId)` → `dataJson.tasks` |
| `assigning` | build roster (§4.5) → `csaas.assign(csaasMeetingId, roster)` → `dataJson.assignments` |
| `awaiting_review` | `csaas.fetchNotes(csaasMeetingId)` → cache notes + html; render + post the review UI (§4.6); store `reviewMessageId`; `status='blocked'` |
| `approved` | (set by the Approve interaction, which also stashes per-task assignee overrides + GitHub toggles in `dataJson.review`) → `csaas.approve(csaasMeetingId, { decision:'approved', skipGithub:true })` |
| `mirrored` | for each approved task → `INSERT INTO task` (§4.7); post assignee pings |
| `issue_syncing` | if any task toggled GitHub → resolve `owner/repo` from the task's project repo → `csaas.issueSync(...)`; write `externalIssueUrl/Number` back onto the mirrored `task` rows |
| `done` | final summary edit on the review message |

Rejection path: the Reject interaction → `csaas.approve(..., { decision:'rejected' })`,
job → `done`, review message updated.

### 4.5 Bot: roster construction

For `csaas.assign` and for `/create` participants. Per guild:

```
SELECT gm.discordId, gm.email FROM guildmember gm
  WHERE gm.guildConfigId = ? AND gm.status = 'verified'
```
Enrich each with the guild member's `displayName` (from the Discord.js cache /
`guild.members.fetch`). Roster entry:
```json
{ "ref": "<discordId>",
  "displayName": "Ali Raza",
  "aliases": ["Ali", "ali", "<email local-part>", "@AliR"] }
```
Optionally narrow to members who were actually in the voice channel (from
`MeetingRecording.memberId` + anyone who posted in `meetingmessage`) — preferred, so
Claude matches against people who were present.

### 4.6 Bot: review UI

Posted to the meeting's text channel (`meetingchannel.textChannelId`; fall back to the
voice channel's chat, else DM the organizer).

- **Header embed:** meeting name + date, concise notes (chunked like `docs.js`
  `chunkForEmbed`), and — if the HTML report was fetched — write it to
  `bot/meeting-reports/<meetingId>.html` and link the local path (VM-local; the ask is
  local file access, not serving).
- **One embed/section per task:** goal, feature/sub-feature, `code_residence`,
  proposed assignee (or "unassigned"), the supporting quote.
- **Components per task (in rows, respecting Discord's 5-component limit — paginate if
  >~4 tasks):**
  - `UserSelectMenu` `mtg_assignee:<jobId>:<taskId>` — override/set assignee.
  - Button `mtg_gh:<jobId>:<taskId>` — toggle "Push to GitHub" (style flips
    Secondary/Success).
  - Button `mtg_taskreject:<jobId>:<taskId>` — drop this task.
- **Footer row:** `Approve all & assign` (Success), `Reject meeting` (Danger).
- Interaction handlers live in a new `bot/src/commands/meetingReview.js`, wired in
  `bot/src/handlers/interactions.js` by `customId` prefix (same pattern as
  `playback_*`). Selections/toggles mutate `dataJson.review`; `Approve` flips the job
  to `stage='approved', status='pending'`.
- `/meeting-retry` and `/meeting-review` slash commands: re-post the UI for a job / kick
  a `failed` job back to `pending`.

Interaction-token TTL (~15 min) is a non-issue: the review message is a normal channel
message edited via the bot token, not an interaction reply.

### 4.7 Bot: task mirroring

Per approved, non-rejected task:

```
INSERT INTO task SET
  id            = uuid(),
  guildConfigId = <cfg.id>,
  type          = 'feature',           -- meeting tasks are feature-shaped
  is_feature    = 1,
  title         = task.goal_of_task (trimmed to 200),
  description   = [intended_actions joined + suggested_commands + "\nFrom meeting <name> <date>"],
  status        = 'open',
  createdBy     = <bot user id>,
  assigneeIds   = JSON([resolved discordId])   -- assignments[taskId].assignee_ref, overridden by review
  projectName   = task.project,
  repositoryId  = <resolve from repository.name = task.project, nullable>,
  scope         = task.feature,
  modules       = JSON([task.sub_feature].filter),
  externalId    = 'csaas:' + task.task_id,
  discordChannelId = <meeting text channel>
```

**Migration (bot):**
```sql
ALTER TABLE task
  ADD COLUMN externalId VARCHAR(128) NULL,
  ADD COLUMN meetingId  VARCHAR(36)  NULL,
  ADD KEY (externalId), ADD KEY (meetingId),
  ADD FOREIGN KEY (meetingId) REFERENCES meeting(id) ON DELETE SET NULL;
```
(`externalIssueUrl` / `externalIssueNumber` already exist and are filled in the
`issue_syncing` stage.)

Pings: after insert, `channel.send("<@discordId> you've been assigned **<title>**
from <meeting name>. Details: /update-task")` — one message, grouped by assignee.

### 4.8 Bot: `ubs_doc` in `/docs`

- **Provisioning (one-time, VM):** `git clone <ubs_doc remote> <path>` — likely
  alongside the bot, e.g. `../UBS_Doc`. Document in the bot README / deploy notes. A
  `git pull` cron is optional future work.
- **Env:** `UBS_DOC_PATH` — relative to the bot process CWD (per the user's ask),
  resolved to absolute at startup. Points at the docs root (e.g. `../UBS_Doc/docs`).
- **`docs.js` change:** generalize from a single `DOCS_ROOT` to a small list of named
  roots:
  ```js
  const DOC_ROOTS = [
    { key: 'bot',  label: 'Bot docs',           dir: path.join(__dirname,'..','..','docs') },
    ...(process.env.UBS_DOC_PATH
      ? [{ key: 'ubs', label: 'UBS Knowledge Base', dir: path.resolve(process.env.UBS_DOC_PATH) }]
      : []),
  ];
  ```
  - Top level of `/docs` lists the roots when there's more than one; otherwise
    behaves exactly as today.
  - `resolveDocsPath` takes the active root and keeps the existing
    `resolved.startsWith(root)` traversal guard (now per-root).
  - `value` encoding gains a root prefix: `file:ubs:guides/intro.md`.
  - Only `.md` / `.mdx`, unchanged. `.mdx` with JSX renders as raw text — acceptable.
- No new dependency, no HTTP serving.

---

## 5. Data model summary

**Bot — new:** `meeting_pipeline_job` (§4.4.1). **Bot — altered:** `task` (+`externalId`,
`+meetingId`).

**CSAAS — altered:** `meeting_tasks` (+`assignee_ref`, `+assignee_quote`,
`+assignee_confidence`).

No other schema changes. CSAAS `meetings.meeting_id` is the pipeline key, held in
`meeting_pipeline_job.csaasMeetingId`.

---

## 6. End-to-end flow (happy path)

1. Meeting ends → `MeetingRecordingStatus='completed'` → `meeting_pipeline_job` row
   (`created`).
2. Worker: `created` → `csaas.createMeeting` → `transcribing`.
3. Worker: uploads each speaker `.ogg` as a segment → `analyzing`.
4. Worker: `analyze` → `generating_tasks` → `generateTasks` → `assigning`.
5. Worker: builds roster of present members → `csaas.assign` → `awaiting_review`;
   fetches notes/HTML; posts review UI; job `blocked`.
6. Operator adjusts assignees / toggles GitHub on 1 task / clicks **Approve all**.
7. Interaction: stash `review` overrides, job → `approved` / `pending`.
8. Worker: `csaas.approve({skip_github:true})` → `mirrored`: insert `task` rows,
   ping assignees → `issue_syncing`: one task → `csaas.issueSync` → writes issue URL
   back → `done`: review message shows the final summary.

---

## 7. Error handling & edge cases

| Case | Handling |
|---|---|
| Soniox timeout / CSAAS 5xx | Worker retry w/ backoff; after 6 attempts `failed` + channel alert + `/meeting-retry` |
| Some speaker files missing on disk | Skip, annotate notes; fail only if all missing |
| CSAAS returns 0 tasks | Post notes-only review message, job → `done` |
| No explicit assignees found | All tasks show "unassigned"; operator assigns via the `UserSelectMenu`; nothing blocks |
| Assignee not a verified `guildmember` | `UserSelectMenu` still allows it; ping sent; `assigneeIds` stores the id regardless |
| `actionPerformerURDD` lacks a permission (403) | Fatal for the job → `failed` with the CSAAS message (names the missing permission); fix is a CSAAS-side permission grant |
| Bot restart mid-pipeline | Worker picks the job up from its persisted `stage` next tick; stages idempotent |
| Duplicate `endMeetingSession` | `UNIQUE(meetingId)` on `meeting_pipeline_job` makes the insert a no-op |
| Review message deleted | `/meeting-review <meetingId>` re-posts from `dataJson` |
| GitHub repo unresolvable for a toggled task | Skip that sync, note it on the review summary; task still mirrored + assigned |
| Interaction race (two approvers) | Approve handler is a conditional `UPDATE ... WHERE status='blocked'`; second is a no-op |

---

## 8. Configuration

**Bot `.env` (new):**
```
CSAAS_API_URL=http://127.0.0.1:<csaas-port>/api
CSAAS_ACTOR_URDD=<existing CSAAS URDD id with add_meetings + run_meeting_ai + update_meetings>
UBS_DOC_PATH=../UBS_Doc/docs
MEETING_PIPELINE_ENABLED=true          # kill switch; worker no-ops when false
MEETING_REPORTS_DIR=bot/meeting-reports # where fetched HTML reports are written
```

**CSAAS `.env` (new / changed):**
```
STT_PROVIDER=soniox
SONIOX_API_KEY=<key>
# GITHUB_PAT stays set — per-call skip_github now controls push
```

**CSAAS one-time data:** ensure the `CSAAS_ACTOR_URDD` user/role exists with the three
permissions and tenant/repo scope (or `seesAll`).

---

## 9. Testing strategy

- **CSAAS unit:** `extractAssignments` against a fixture transcript with 3 explicit
  assignments + 2 unstated (assert nulls, no guessing); `skip_github` branch of
  `approveTasks` (no Octokit call when set). Reuse their
  `Services/SysScripts/TestScripts/meeting-test/` harness — add an
  `--assign` step to `runMeetingAnalysis.js`.
- **Bot unit:** `csaasClient` envelope parsing + error mapping (nock/undici mock);
  each worker stage handler with a mocked `csaasClient` (idempotency: run twice,
  assert one effect); roster builder; task-mirror row shape; `docs.js` multi-root
  resolution + traversal guard per root.
- **Bot integration (VM, manual for v1):** record a 2-speaker test meeting → watch the
  job walk stages → review UI renders → approve → `task` rows + pings → toggle one to
  GitHub → issue appears with `[Agent Call]`.
- **Regression:** existing `/docs` behavior unchanged when `UBS_DOC_PATH` unset;
  existing CSAAS callers unaffected by `skip_github` default-false.
- `node --check` + dynamic `import()` on every touched bot file (repo convention).

---

## 10. Effort estimate

| Area | Days |
|---|---|
| CSAAS: `skip_github`, `/assign` + agent + migration, `issuesync` task filter, Soniox config | 3–5 |
| Bot: `csaasClient` | 1 |
| Bot: `meeting_pipeline_job` + worker + stage handlers + enqueue hook | 4–6 |
| Bot: roster builder + task mirroring + migration | 2–3 |
| Bot: review UI (embeds, components, pagination, interaction handlers, `/meeting-retry` `/meeting-review`) | 4–6 |
| Bot: `ubs_doc` clone + `/docs` multi-root | 1 |
| Error handling, retries, kill switch, restart-safety hardening | 2–3 |
| Testing (unit + one guided VM integration pass) | 2–4 |
| **Total** | **19–29 working days (~4–6 weeks), one dev** |

Thin happy-path demo (no pagination/retry hardening, per-speaker upload only, manual
assignee entry, no GitHub toggle): **~6–9 days**.

---

## 11. Future work (tracked, not in v1)

- Platform encryption + dedicated service token for bot↔CSAAS (§4.1).
- Pre-meeting notes: agenda/scope capture in `/schedule`, call `/premeeting`.
- Clarify ⇄ revise loop surfaced as a Discord thread.
- Mixed single-track audio for `/playback` and a single transcription input.
- `git pull` cron for `ubs_doc`; serve reports over the existing `/verify` HTTP server
  behind a signed link.
- Assignment: factor in open task load (`SELECT COUNT(*) ... task WHERE assignee ...`)
  as a *tie-breaker only*, still never overriding explicit statements.
- Two-way status sync: when a mirrored `task` closes, `PATCH` CSAAS `meeting_tasks.status`.
```

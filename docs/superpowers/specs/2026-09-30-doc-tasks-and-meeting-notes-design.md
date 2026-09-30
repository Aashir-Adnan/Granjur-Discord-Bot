# Tasks from a document, a meeting-start document, and meeting notes as files

Sub-project 7 of the owner's roadmap (see `.claude/state/backlog.md`). Design approved in
chat on 2026-09-30. Touches the bot and CSAAS. No site change. No database change.

## Owner's request

"Meeting docs/JSON → Claude → tasks without a meeting, plus a document field when a
meeting starts." Asked while designing: "did you implement that after a meeting a meeting
notes or summary is given in some form?"

Answers given while designing:
- Notes: attached to the meeting's channel as a file.
- Tasks without a meeting: a Discord command with a file.
- The meeting-start document is context for Claude, not a separate source of tasks.
- File types: `.txt`, `.md`, `.json`, `.pdf`, `.docx`.

## Current behaviour (verified in the code)

- **Pipeline.** A recorded meeting that ends enqueues a `meeting_pipeline_job` (only
  `guildConfigId`, `meetingId`; `bot/src/services/voiceCapture.js:457-462`, when
  `meetingPipelineEnabled()`). Stages (`meetingPipelineWorker.js` `STAGE_ORDER`):
  `created` (CSAAS `/create` with `{ title, participants }`, unless the meeting already
  has a `csaasMeetingId`) → `transcribing` (the live path: at least 5 live utterances →
  CSAAS `/analyze-live` with `meeting_notes` text; else per-speaker audio `/transcribe`)
  → `analyzing` (`/analyze`, a no-op after the live path) → `generating_tasks` (`/tasks`)
  → `assigning` (`/assign` with the roster) → `awaiting_review` (`/notes`, the review
  message, blocks) → `approved` (`/approve`, `skipGithub: true`) → `mirrored` (bot task
  rows and channels) → `issue_syncing` (bot-side GitHub issues) → `done`.
- **The review channel** is resolved from the meeting's voice channel
  (`meeting.channelId` → `meetingchannel.textChannelId`, `resolveMeetingChannel`) and
  stored as `dataJson.reviewChannelId` when the review is posted.
- **Notes are empty today.** CSAAS writes `meeting_notes.raw_notes`
  (`generateConciseNotes`) and `meeting_html_reports` (`generateHTMLReport`) only in
  `POST /report` (`meetingWorkflow.js` `generateReport`, ~:1006). The bot never calls
  `/report`, so `fetchNotes` returns `notes: ''`, `html: null`: the review header's notes
  are blank and the "Full report: `<path>` (on the VM)" line is never shown.
- **`done` overwrites the review message** with the task summary
  (`meetingPipelineStages.js:660`); anything shown there is lost.
- **Text instead of audio already works in CSAAS**: `/analyze-live` takes
  `meeting_notes: { segment_N: { time_range, transcription, user_notes? } }`, writes
  `meetings.transcript`, and runs `analyzeMeetingTranscript` (~:563-600). The bot builds
  that shape in `services/liveTranscriptPayload.js`.
- **`pre_meeting_notes`** is read by `analyzeMeetingTranscript` (as "PRE-MEETING BRIEF",
  first 3000 characters), `generateMeetingTasks` (2000) and `generateConciseNotes` (2000).
  It is set only by `POST /premeeting` (AI-generated). `/create` accepts `title,
  scheduled_at, participants, created_by, agenda, scope_repo_ids, scope_feature_ids` —
  not `pre_meeting_notes`.
- **Roster** (`services/meetingRoster.js` `buildRoster`): verified members present in the
  recording, else all verified members.
- **Project of generated tasks** (`services/meetingTaskProject.js`): the meeting's
  `projectId`, else the project Claude named, else the reviewer's pick.
- **CSAAS body limit**: `express.json()` default 100 KB; the bot's CSAAS requests are
  AES-encrypted (larger than the plaintext).

## Design

### 1. Meeting notes as files

- **A new pipeline stage `reporting`**, between `assigning` and `awaiting_review`, calls
  CSAAS `POST /report` `{ meeting_id }` (new `csaasClient.generateReport`, a long
  timeout — it re-runs the analysis). Best-effort: a failure logs, records
  `dataJson.reportError`, and advances; tasks never wait on notes. It runs once per job
  (`dataJson.reported`).
- **`awaiting_review`** then fetches `/notes` as today and, before posting the review:
  - posts a separate message in the review channel: `**Meeting notes — <title>**` with two
    attachments, `meeting-notes-<YYYY-MM-DD>.md` (the concise notes) and
    `meeting-report-<YYYY-MM-DD>.html` (the full report); either is omitted when CSAAS
    returned none; no message at all when both are empty. Its id is stored as
    `dataJson.notesMessageId`, and it is posted once (a retried stage does not post twice).
  - The review header keeps the notes, clipped as today, followed by
    `Full notes are attached above.` when the notes message was posted.
  - The on-disk HTML report and the "Full report: `<path>` (on the VM)" line are removed.
- **`done`** is unchanged: it edits only the review message, so the notes message stays.

### 2. `/tasks-from-doc`

- **Command** `/tasks-from-doc file:<attachment> [project:<autocomplete>] [title:<text>]`.
  - Available to the same members as `/create-task` (the same registration/permission
    setup; no new permission).
  - Refused with a sentence when the meeting pipeline is not enabled
    (`meetingPipelineEnabled()` false) or CSAAS is not configured.
- **Reading the file** (`services/docText.js`, pure over a buffer + file name):
  - `.txt`, `.md`: UTF-8 text.
  - `.json`: if it is a transcript-like object or array (strings under keys such as
    `transcription`, `text`, `content`), those strings in order; otherwise the
    pretty-printed JSON as text.
  - `.pdf`: text via a PDF text-extraction library; no text (a scanned PDF) → refused.
  - `.docx`: text via a Word text-extraction library.
  - Anything else → refused, listing the accepted types.
  - The file download is capped at 10 MB; the extracted text at 60,000 characters (over →
    refused, saying the limit). Empty text → refused.
  - Refusal sentences name the file and the reason; nothing is enqueued.
- **What it creates**:
  - A bot `meeting` row: `channelId` = the channel the command was run in, `projectId` =
    the chosen project (or none), `transcript` = the extracted text.
  - A `meeting_pipeline_job` with `dataJson.source = 'document'`,
    `dataJson.reviewChannelId` = that channel, `dataJson.documentName`.
  - The reply: `Reading **<file>** — the proposed tasks will be posted here for review.`
- **The pipeline for a document job**:
  - `created`: title = the `title` option, else the file name without extension, plus the
    date; CSAAS `/create` as today; roster = all verified members (there is no
    recording).
  - `transcribing`: sends the document text to `/analyze-live` as
    `{ segment_0: { time_range: '', transcription: <text> } }` with `total_duration_sec: 0`,
    sets `liveTranscript: true`; never falls back to audio (a failure is a normal stage
    error with the job's retries).
  - From `analyzing` on: unchanged, including `reporting` (part 1), the review in
    `dataJson.reviewChannelId`, approval, task rows, channels, project and repository
    rules and issues.
- **Nothing about recorded meetings changes**: a job without `dataJson.source` behaves
  exactly as today.

### 3. A document when a meeting starts

- `/record action:start` gains an optional `document` attachment (the same file types
  and reading rules as part 2).
- Its text is sent to CSAAS as the meeting's `pre_meeting_notes` when the CSAAS meeting
  is created (`startMeetingRecording` → `csaasClient.createMeeting`), and is also stored on
  the bot `meeting` row so a later `created` stage that creates the CSAAS meeting sends it
  too.
- **CSAAS change**: `POST /create` accepts optional `pre_meeting_notes` (a string, at most
  20,000 characters, else 400) and stores it in the existing `meetings.pre_meeting_notes`
  column. Nothing else in CSAAS changes.
- The reply to `/record action:start` adds one line: `Using **<file>** as background for
  this meeting.`, and, when the text is longer than 3,000 characters, `Claude reads the
  first 3,000 characters of it.`
- A document that cannot be read does not stop the recording: the recording starts and
  the reply says why the document was skipped.
- Scheduled meetings (started automatically) have no document; out of scope.

## Testing (fakes only; `.claude/rules/tests-never-touch-production.md`)

- **Bot:**
  - `docText.js`: each type (with small fixture buffers), the JSON transcript shapes, the
    size and empty refusals, an unknown type, a PDF with no text.
  - The `reporting` stage: calls `/report` once, advances on failure, records the error.
  - `awaiting_review`: posts the notes message with the right attachments (one, both,
    none), once only, and the review header line.
  - A document job through `created` (title, roster) and `transcribing` (the payload, no
    audio fallback); a recorded-meeting job unchanged.
  - `/tasks-from-doc`: the refusals, the rows it creates, the reply.
  - `/record action:start` with a document: the text passed to `createMeeting`, the reply
    lines, an unreadable document not blocking the start.
- **CSAAS:** `/create` stores `pre_meeting_notes`, refuses a non-string or over-long one,
  and behaves as before without it.

## Rollout

CSAAS, then the bot. The bot against an old CSAAS: `pre_meeting_notes` is ignored (the
meeting still starts); `/report` exists already. No migration.

## Out of scope

- Reading files posted in the meeting channel during a meeting (still stored, still not
  read).
- A site page for meeting notes.
- Documents for scheduled meetings.
- Editing notes.

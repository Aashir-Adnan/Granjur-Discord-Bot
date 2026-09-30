# Tasks from a document, a meeting-start document, and meeting notes as files

Roadmap sub-project 7 of 7 (owner roadmap, `.claude/state/backlog.md`). BUILT, NOT DEPLOYED
and not merged (2026-10-01): bot and CSAAS branch `feat/doc-tasks`. No migration anywhere.
Three features sharing one text reader and one pipeline:

1. `/tasks-from-doc` turns an attached document into proposed tasks, reviewed like a meeting.
2. `/record action:start document:<file>` gives Claude a document as background for the meeting.
3. The meeting notes and HTML report are posted as files (the `reporting` stage).

## Reading a document: `bot/src/services/docText.js`

`extractDocText({ buffer, fileName })` returns `{ text, chars }`; every refusal is a
`DocTextError` whose message is the sentence shown to the user. `downloadAttachment(attachment)`
fetches the Discord attachment (20 s timeout, `DOWNLOAD_TIMEOUT_MS`).

- Types: `.txt`, `.md`, `.json`, `.pdf`, `.docx`. Anything else is refused.
- Limits: 10 MB download (`MAX_DOC_BYTES`, checked on the attachment's size and again on the
  buffer), 60,000 characters of text (`MAX_DOC_CHARS`). Empty text is refused (a scanned PDF
  has none, and the message says so).
- `.json`: parsed; the text fields named `transcription`, `text` or `content` are collected
  and joined with blank lines, else the whole value is pretty-printed.
- PDF uses `unpdf` (`extractText`, pages merged), `.docx` uses `mammoth` (`extractRawText`).
  Both are imported lazily inside the extractor, so a missing or incompatible library only
  breaks that file type. `unpdf` declares Node >= 22; on an older Node only PDF reading fails,
  with the "could not be read" sentence. The VM's Node version is unknown (owner check).
- Tests pass `download` and `extract` fakes; none downloads or parses a real file through
  the network.

## `/tasks-from-doc file [project] [title]`

`bot/src/commands/tasks-from-doc.js`. Role `Verified` (same as `/create-task`,
`command-config.json`). Listed in `PUBLIC_REPLY_COMMANDS` (`commands/index.js`), so it is
deferred publicly first; unexpected errors are masked as for `/explain`.

- Refusals are ephemeral: Discord fixes the ephemeral flag at the first acknowledgement, so
  `refuse()` does `deleteReply()` then `followUp({ flags: EPHEMERAL })`. The accepted reply
  stays public: `Reading **<file>** — the proposed tasks will be posted here for review.`
  A role denial happens before the command runs and is public (as for `/explain`).
- Extra limit: 65,535 UTF-8 bytes of text (the `meeting.transcript` TEXT column holds bytes,
  not characters), so a file can pass the 60,000-character cap and still be refused as
  `too long to store`.
- Also refuses: outside a server, pipeline disabled or CSAAS not configured
  (`Tasks from documents are not available on this server yet.`), no guild config, a
  `project` that is not this guild's.
- What it writes: a `meeting` row (`channelId` = the channel the command ran in, `transcript`
  = the text, `projectId` if a project was picked), then a `meeting_pipeline_job` row created
  in ONE insert with `dataJson { source: 'document', reviewChannelId, documentName, title }`.
  One write so the worker can never claim the job before it knows it is a document job. If
  the job insert fails the meeting row is deleted (best-effort, warning logged) and the error
  propagates.
- `title` defaults to the file name without its extension.

### The document job in the pipeline (`meetingPipelineStages.js`)

A job with `dataJson.source === 'document'` behaves differently in a few stages only:

- `created`: no recordings; the CSAAS meeting title is `<title> — <date>`; the roster is every
  verified member (`buildRoster` with `meetingId: null` falls back to that); the CSAAS meeting
  is created here (no recording start did it).
- `transcribing`: reads `meeting.transcript` and sends it as one segment through
  `/analyze-live` (`segment_0`); never audio, never the `/transcribe` fallback. Any error is
  rethrown so the worker retries the stage; an empty text fails the job's attempt
  (`document job has no text`).
- `resolveMeetingChannel`: `dataJson.reviewChannelId` (the command's channel) is tried first,
  and no `meetingchannel` lookup is made for a document job. The review and every later
  notice go there.
- Everything after (`generating_tasks`, `assigning`, `reporting`, review, approval, mirroring,
  issues) is the recorded-meeting path unchanged.

## A document at `/record action:start`

`bot/src/commands/record.js`. Optional attachment option `document`.

- `readBrief` downloads and extracts it before the recording starts (whole read capped at
  20 s, `READ_TIMEOUT_MS`), truncates the text to 20,000 characters (`MAX_BRIEF_CHARS`), and
  hands it to `startMeetingRecording(..., { preMeetingNotes })`, which passes it to
  `csaasClient.createMeeting`, sent as `pre_meeting_notes` (key omitted when empty).
- It is NOT stored. `meeting.notes` is the channel chat log, and nothing else holds the
  text. If CSAAS cannot create the meeting at the start, the brief is lost (the `created`
  stage later creates the meeting without it).
- An unreadable, unsupported, oversized or slow document never stops the recording: every
  failure comes back as a sentence, and the start reply gets
  `The document was not used: <reason>`. On success the reply adds
  `Using **<file>** as background for this meeting.`, and, past 3,000 characters,
  `Claude reads the first 3,000 characters of it.` (`ANALYSIS_READS_CHARS`; CSAAS's
  analysis slices the brief to 3,000, other agents to 2,000). The "Using ..." line is shown
  even when the brief is later lost.
- CSAAS side (repo `CSAAS_Backend`, `6a159cf`): `/create` (`createMeeting` in
  `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js`) accepts
  `pre_meeting_notes`, a string of at most 20,000 characters, else 400; checked before any
  write; absent means undefined, null or `''`. It went through a new test seam
  (`__hooks.executeQuery`/`requireMeetingPermission`) and is tested by
  `Services/SysScripts/TestScripts/meeting-test/create.test.js`.
- Files posted in the meeting channel during a meeting are still not read.

## Meeting notes as files: the `reporting` stage

Before this, the notes were always empty: the bot never called CSAAS `/report`, and `/notes`
is empty until `/report` has run.

- `STAGE_ORDER` (`meetingPipelineWorker.js`): `created, transcribing, analyzing,
  generating_tasks, assigning, reporting, awaiting_review, approved, mirrored, issue_syncing,
  done`. `reporting` sits between `assigning` and `awaiting_review`.
- `reportingStage` calls `csaasClient.generateReport(meetingId)` (`/report`, 300 s timeout).
  Best-effort and once: success sets `dataJson.reported = true`; a failure is logged, sets
  `reported = true` and `reportError = <message>`, and the job carries on, so a failed report
  never stops tasks reaching review.
- `awaitingReviewStage` fetches `/notes` and posts `**Meeting notes — <title>**` with
  `meeting-notes-<date>.md` and `meeting-report-<date>.html` attached (each only when
  non-empty; no message at all when both are empty). `<date>` is UTC `YYYY-MM-DD` of the
  first recording's start, else the meeting's creation (`meetingNotesFileNames`).
- It stores `notesMessageId` and `notesChannelId` in a mid-stage `meetingPipelineJob.update`
  BEFORE the review message is sent, so a crash between the two sends retries without
  posting the notes twice.
- The review header says `Full notes are attached above.` only in the channel that holds the
  notes message: `notesAttachedIn(dataJson, channelId)` in `commands/meetingReview.js`
  (`notesMessageId` set and `notesChannelId` equals the channel). `/meeting-review` re-posts
  use it too, so a review re-posted elsewhere does not claim notes above it.
- The on-disk report (`MEETING_REPORTS_DIR`) is gone.

## Rollout (nothing merged or deployed yet)

1. CSAAS first (push `main`, auto-deploys). Harmless alone: `pre_meeting_notes` is accepted
   and nothing sends it yet.
2. Bot second. The deploy (`.github/workflows/deploy.yml`) runs `npm install --production`
   (installs `unpdf` and `mammoth`), `npm run db:migrate` (nothing new) and restarts pm2.
   Slash commands register at bot startup: `loadCommands` (`commands/index.js`) compares the
   live command list with the new one and re-registers when it differs, so `/tasks-from-doc`
   and the new `/record` option appear after the restart without `scripts/deploy-commands.js`.
3. Owner check before trusting PDFs: the VM's `node --version` must be >= 22.

## Tests

Bot: `docText.test.js`, `tasks-from-doc.test.js`, `record.test.js`,
`meetingPipelineStages.test.js` (document branches, `reporting`, notes message),
`meetingReview.test.js` (`notesAttachedIn`), `csaasClient.test.js`; all with `db`, `getConfig`,
`download`, `extract` and `csaasClient` fakes (see
`.claude/rules/tests-never-touch-production.md`). CSAAS: `meeting-test/create.test.js` and
`meeting-test/utterance.test.js` (run with `OPENAI_API_KEY=dummy node <file>`; plain assert
scripts). Spec `docs/superpowers/specs/2026-09-30-doc-tasks-and-meeting-notes-design.md`
(`48f1f06`), plan `docs/superpowers/plans/2026-09-30-doc-tasks-and-meeting-notes.md`
(`5597828`).

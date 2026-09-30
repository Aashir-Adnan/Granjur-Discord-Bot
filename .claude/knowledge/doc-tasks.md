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
  breaks that file type. `unpdf` declares Node >= 22; on Node below 22 PDF reading may fail;
  the failure is contained to that file (the "could not be read" sentence). The VM's Node
  version is unknown (owner check).
- Extraction runs in the bot's own process (no worker thread), so a crafted `.docx` could
  exhaust its memory (deferred, `backlog.md` item 7).
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
- Extra size limits, both refused as `too long to store`: more than 65,535 − 64 UTF-8 bytes
  of text, or more than 95,000 bytes once JSON-encoded. Why: `meeting.transcript` is a TEXT
  column (65,535 bytes, not characters) in the bot AND in CSAAS, and CSAAS stores
  `"[segment_0]\n" + text` there (the 64 bytes leave room for that marker); CSAAS parses
  request bodies up to 100 KB, and JSON escaping (quotes, newlines, control characters)
  inflates the text. So a file can pass the 60,000-character cap and still be refused.
- Before any download, it also refuses (ephemerally):
  - when the bot lacks View Channel, Send Messages or Attach Files in the channel
    (`interaction.channel.permissionsFor(client.user)`): `I can't post in this channel — run
    /tasks-from-doc where I can send messages and attach files.` (The review, the notes files
    and the pings all go to that channel.)
  - when the guild already has 3 document jobs in progress (`dataJson.source === 'document'`,
    status not `done`/`failed`, read with `db.meetingPipelineJob.findUnfinishedByGuild`):
    `This server already has 3 documents being turned into tasks. Try again when one is
    reviewed.`
- Also refuses: outside a server, pipeline disabled or CSAAS not configured
  (`Tasks from documents are not available on this server yet.`), no guild config, a
  `project` that is not this guild's.
- Mention safety: the public `Reading **<file>**` reply is sent with
  `allowedMentions: { parse: [] }`, so a file named `@everyone.md` pings nobody.
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
- `reportingStage` calls `csaasClient.generateReport(meetingId, { timeoutMs })` (`/report`).
  Best-effort and once: `dataJson.reported = true` is written to the job (a mid-stage
  `meetingPipelineJob.update`) BEFORE the call, because the worker saves nothing from a stage
  its timeout abandons; a retry after a stage timeout sees `reported` and advances without
  calling `/report` again. A failed call is logged and sets `reportError = <message>`; the
  job carries on, so a failed report never stops tasks reaching review.
- The call's timeout is `reportTimeoutMs()` = `min(REPORT_TIMEOUT_MS (300 s), stage timeout
  − 30 s)`; the stage timeout comes from `stageTimeoutMs()` in
  `Database/meetingPipelineJob.helpers.js` (`MEETING_STAGE_TIMEOUT_MS`, default 360 s), the
  same helper the worker uses.
- Cost: `/report` adds ~3 Claude calls and minutes per meeting, and truncates long
  transcripts in the HTML. Participant names show blank in the HTML report (the bot sends
  names as strings; CSAAS's report expects objects). Both deferred (`backlog.md` item 7).
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

## Safety in public messages and in the worker (final fix wave, 2026-10-01)

The client sets no default `allowedMentions` (`bot/src/index.js`), so every public send that
carries user- or Claude-written text sets its own:

- The notes message (`**Meeting notes — <title>**`; a document job's title is the free-text
  `title` option): `allowedMentions: { parse: [] }`.
- The assignee ping in `mirroredStage` (`<@ref> you've been assigned: **<task title>**`; the
  title is Claude's, steerable by a document): `allowedMentions: { users: [ref] }`, so only
  that assignee is pinged.
- The review message has no `content` (embeds only), so nothing in it pings; the unassigned
  summary line holds only a count.
- `notifyFailure` no longer posts the raw error (it could hold internal URLs): the channel
  gets `The meeting pipeline stopped at **<stage>** after several attempts. An admin can retry
  it with /meeting-retry <meetingId>.` The full error stays in the job's `lastError`.

Worker (`meetingPipelineWorker.js`):

- `runTick` has an in-flight guard (a module-level flag set and cleared in `try/finally`): a
  tick that starts while the previous one is still running returns at once. `/report` can
  hold a tick for minutes and `setInterval` does not wait.
- `claimBatch` returns a snapshot of up to 3 jobs, run one after another, and `claim` checks
  only the status. After a successful claim the worker re-reads the job (`findById`) and runs
  the stage from that fresh row; if its `stage` differs from the snapshot's, it sets the job
  back to `pending` (the status the claim found) and leaves it for a later tick. Before this,
  a later job in the batch could be re-run from its old stage and `dataJson` (duplicate
  Claude runs, a second review, re-mirrored tasks).
- Known gap: the claim does not check `nextAttemptAt`, so a job that failed in another
  process between the batch read and the claim, on the same stage, runs without waiting out
  its backoff. The in-process guard makes this a multi-process case only.

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
`meetingPipelineStages.test.js` (document branches, `reporting`, notes message, mention
options), `meetingPipelineWorker.test.js` (fresh row per claim, in-flight guard, masked
notice), `meetingReview.test.js` (`notesAttachedIn`), `csaasClient.test.js`,
`Database/meetingPipelineJobInsert.test.js` (the unfinished-jobs SQL); all with `db`, `getConfig`,
`download`, `extract` and `csaasClient` fakes (see
`.claude/rules/tests-never-touch-production.md`). CSAAS: `meeting-test/create.test.js` and
`meeting-test/utterance.test.js` (run with `OPENAI_API_KEY=dummy node <file>`; plain assert
scripts). Spec `docs/superpowers/specs/2026-09-30-doc-tasks-and-meeting-notes-design.md`
(`48f1f06`), plan `docs/superpowers/plans/2026-09-30-doc-tasks-and-meeting-notes.md`
(`5597828`).

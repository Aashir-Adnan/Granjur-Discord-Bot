# Tasks From a Document, Meeting-Start Document, Meeting Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Meeting notes reach people as files in the meeting's channel; a document can be turned into reviewed tasks with `/tasks-from-doc` and no meeting; a document given at `/record action:start` becomes Claude's background for that meeting.

**Architecture:** The bot's meeting pipeline gains a `reporting` stage (CSAAS `/report`) and posts the notes as attachments before the review. A document job is an ordinary pipeline job marked `dataJson.source = 'document'` whose transcript is the document's text, sent through CSAAS's existing text path (`/analyze-live`). A new pure module reads text out of .txt/.md/.json/.pdf/.docx. CSAAS's `/create` accepts `pre_meeting_notes`.

**Tech Stack:** Bot: Node ESM (Node ≥18; the dev machine runs 24), discord.js v14, `node:test`. CSAAS: Node CommonJS, UBS framework, standalone node test scripts.

**Spec:** `docs/superpowers/specs/2026-09-30-doc-tasks-and-meeting-notes-design.md`

## Global Constraints

- A recorded-meeting job (no `dataJson.source`) behaves exactly as today except for the new `reporting` stage and the notes message; existing pipeline tests pass unchanged (added cases only).
- Accepted file types: `.txt`, `.md`, `.json`, `.pdf`, `.docx` (by extension, case-insensitive). Download cap 10 MB; extracted text cap 60,000 characters; empty text refused.
- Verbatim strings:
  - notes message heading `**Meeting notes — <title>**`; file names `meeting-notes-<YYYY-MM-DD>.md`, `meeting-report-<YYYY-MM-DD>.html`; review header line `Full notes are attached above.`
  - `/tasks-from-doc` reply `Reading **<file>** — the proposed tasks will be posted here for review.`
  - `/record` reply lines `Using **<file>** as background for this meeting.` and `Claude reads the first 3,000 characters of it.`
- Notes are best-effort: a `/report` failure never blocks the review or the tasks.
- The notes message is posted at most once per job; the `done` stage keeps editing only the review message.
- CSAAS `/create`: optional `pre_meeting_notes`, a string of at most 20,000 characters, else 400; stored in the existing `meetings.pre_meeting_notes` column.
- No database migration (bot or CSAAS). No new permission.
- New bot dependencies: exactly two text extractors — `unpdf` for PDF and `mammoth` for Word — added to the root `package.json` with a lockfile update; nothing else.
- Bot tests use fakes for every `db`/`getConfig`/`csaasClient`/Discord seam — never the default `db`, never a real server, never a real CSAAS, never a network download (`.claude/rules/tests-never-touch-production.md`; the root `.env` is production). Never read any `.env`.
- Commits: `git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit ...`; message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` — exactly that.
- A piped test summary can exit 0 while red: read `ℹ fail` (bot), each CSAAS script's own pass line.
- The bot working tree has an uncommitted stray edit to `docs/superpowers/plans/2026-09-30-json-task-import.md` (not ours) and an untracked `brag-output/`: never stage, edit or revert them.

## Workspaces

- Bot: `D:\Work\Granjur Technologies\Granjur-Discord-Bot`, branch `feat/doc-tasks` (checked out; spec `48f1f06`). Tasks 1–4, 6.
- CSAAS: `D:\Work\Granjur Technologies\CSAAS_Backend`, create `feat/doc-tasks` from `main` (leave its untracked `.bridge/`, `.worktrees/`, `data/migrations_completed/*` alone). Task 5.

## Review Focus

1. A retried `awaiting_review` stage (a crash after posting the notes message, before posting the review) must not post the notes twice — Task 2 test.
2. A document job must post its review in the channel the command was run in, even though its `meeting.channelId` is a text channel with no `meetingchannel` row — Task 3 test.
3. A PDF whose extraction throws, a corrupt .docx, or a JSON file that is not valid JSON must give a sentence, never an unhandled rejection or a stuck interaction — Task 1 test.
4. A document job must never fall back to the audio `/transcribe` path (it has no recordings) — Task 3 test.
5. An unreadable meeting-start document must not stop the recording from starting — Task 4 test.

---

### Task 1: Bot — reading text out of a document

**Files:**
- Create: `bot/src/services/docText.js`, `bot/src/services/docText.test.js`
- Modify: `package.json`, `package-lock.json` (add `unpdf`, `mammoth`)

**Interfaces:**
- Produces (`bot/src/services/docText.js`):
  - `DOC_TYPES = ['.txt', '.md', '.json', '.pdf', '.docx']`, `MAX_DOC_BYTES = 10 * 1024 * 1024`, `MAX_DOC_CHARS = 60_000`
  - `class DocTextError extends Error` (its message is the user-facing sentence)
  - `async extractDocText({ buffer, fileName, extract = defaultExtractors })` → `{ text: string, chars: number }`; throws `DocTextError` with:
    - unknown type → `**<file>** is not a supported file. Use .txt, .md, .json, .pdf or .docx.`
    - over the byte cap → `**<file>** is larger than 10 MB.`
    - extraction threw / invalid JSON → `**<file>** could not be read.`
    - no text after trimming (includes a scanned PDF) → `**<file>** has no readable text.` (for .pdf: `**<file>** has no readable text — a scanned PDF has none.`)
    - over the char cap → `**<file>** has more than 60,000 characters of text. Split it into smaller files.`
  - `jsonDocText(value)` (exported for tests): a transcript-like value — an array, or an object whose values are objects/strings — yields the string fields named `transcription`, `text` or `content`, in order (depth-first, arrays in order, object keys in insertion order), joined with blank lines; when none are found, `JSON.stringify(value, null, 2)`.
  - `async downloadAttachment(attachment, { fetchImpl = fetch })` → `Buffer`: refuses (DocTextError, the byte-cap sentence) when `attachment.size > MAX_DOC_BYTES` before downloading; `**<file>** could not be downloaded.` on a non-OK response or a network error.
  - `defaultExtractors = { pdf: async (buffer) => string, docx: async (buffer) => string }` using `unpdf` (`extractText`, merged pages) and `mammoth` (`extractRawText`). The `extract` seam lets tests avoid the libraries except for one smoke test each (Step 1, case 9).

- [ ] **Step 1: Write the failing tests** `docText.test.js`:
  1. `.txt` and `.md` (mixed-case extension) → the UTF-8 text, trimmed; a leading BOM removed.
  2. unknown extension (`.png`, no extension) → the unsupported sentence with the file name.
  3. `.json` transcript shapes: `{ segment_0: { transcription: 'a' }, segment_1: { transcription: 'b' } }` → `a\n\nb`; `[{ text: 'x' }, { content: 'y' }]` → `x\n\ny`; a plain object with no such keys → its pretty JSON; invalid JSON → the could-not-be-read sentence.
  4. `.pdf` and `.docx` through fake extractors: returns their text; an extractor that throws → the could-not-be-read sentence (never an unhandled rejection); an extractor returning `'   '` → the no-readable-text sentence (the PDF variant for .pdf).
  5. 60,000 characters → accepted; 60,001 → the too-long sentence; empty → no-readable-text.
  6. `downloadAttachment`: `size` over 10 MB → refused without calling `fetchImpl`; a fake `fetchImpl` returning `ok: false` → the could-not-be-downloaded sentence; returning bytes → a Buffer of them.
  7. `jsonDocText` directly: nested arrays, key order, non-string `text` values ignored.
  8. `chars` equals the returned text's length.
  9. Smoke tests with the real libraries and tiny fixtures generated in the test (a minimal one-page PDF buffer built in the test or a checked-in fixture under `bot/src/services/__fixtures__/` no larger than a few KB; a minimal .docx built with the same approach) → non-empty text. If a library cannot run under the test runner, report it (DONE_WITH_CONCERNS) rather than removing the test.
- [ ] **Step 2: Run** `node --test bot/src/services/docText.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement**; `npm install unpdf mammoth` (from the repo root; confirm both land in `dependencies` and the lockfile).
- [ ] **Step 4: Run** the file, then `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(docs): read the text out of a .txt, .md, .json, .pdf or .docx file`.

---

### Task 2: Bot — meeting notes as files

**Files:**
- Modify: `bot/src/services/csaasClient.js` (`generateReport`), `bot/src/services/meetingPipelineWorker.js` (`STAGE_ORDER`), `bot/src/services/meetingPipelineStages.js` (`reportingStage`, `awaitingReviewStage`), `bot/src/services/meetingReviewUI.js` (the header line; drop the report-path line)
- Test: `bot/src/services/meetingPipelineStages.test.js`, `bot/src/services/meetingReviewUI.test.js`, `bot/src/services/meetingPipelineWorker.test.js`, `bot/src/services/csaasClient.test.js` (added cases; existing cases unchanged except any asserting the removed report-path line or the exact `STAGE_ORDER`, which are updated and listed in the report)

**Interfaces:**
- `csaasClient.generateReport(meetingId)` → posts `/report` `{ meeting_id }` with a 180 s timeout (a named constant `REPORT_TIMEOUT_MS`), same envelope as the other calls.
- `STAGE_ORDER` becomes `created, transcribing, analyzing, generating_tasks, assigning, reporting, awaiting_review, approved, mirrored, issue_syncing, done`. A job already past `assigning` when this ships is unaffected; a job AT `assigning` advances into `reporting`.
- `reportingStage({ job, csaasClient })`: when `dataJson.reported` is not set, calls `generateReport(job.csaasMeetingId)`; success → `dataJson.reported = true`; failure → logs `[meetingPipeline] report failed:`, sets `dataJson.reported = true` and `dataJson.reportError = <message>`; always advances (never throws).
- `awaitingReviewStage`: after `fetchNotes` and before posting the review message:
  - when `dataJson.notesMessageId` is not set and (`notes` non-empty or `html` non-empty): send to the review channel `{ content: '**Meeting notes — <title>**', files: [...] }` with `meeting-notes-<date>.md` (notes, when non-empty) and `meeting-report-<date>.html` (html, when non-empty), where `<date>` is the meeting date the title already uses, formatted `YYYY-MM-DD`; store the sent message id as `dataJson.notesMessageId` in the SAME patch that the stage already persists — and persist it BEFORE sending the review message (write the patch via the job update seam the stage uses, then post the review) so a retry after a crash does not post twice.
  - a failure to post the notes message logs and continues (the review still posts).
  - the on-disk HTML write (`MEETING_REPORTS_DIR`) is removed.
- `buildReviewMessage`: drop `reportPath`; add `notesAttached: boolean` → the header's notes are followed by `Full notes are attached above.` when true.

- [ ] **Step 1: Write the failing tests**: `generateReport` request shape and timeout; `STAGE_ORDER`; `reportingStage` success, failure (advances, error recorded, no throw), and already-reported (no call); `awaitingReviewStage` posts the notes message with both files / only notes / only html / nothing when both empty, stores `notesMessageId` before the review is sent, does not post again when `notesMessageId` is set (Review Focus 1), continues when the notes send throws; `buildReviewMessage` with `notesAttached` true/false and no path line.
- [ ] **Step 2: Run** the four test files → the new cases FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them, then `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(meetings): write the meeting notes and post them as files before the review`.

---

### Task 3: Bot — `/tasks-from-doc` and the document job

**Files:**
- Create: `bot/src/commands/tasks-from-doc.js`, `bot/src/commands/tasks-from-doc.test.js`
- Modify: `bot/src/commands/index.js` (register it the way the others are), `bot/src/services/meetingPipelineStages.js` (`createdStage`, `transcribingStage`, the review-channel lookup), their tests (added cases)

**Interfaces:**
- Consumes: `extractDocText`, `downloadAttachment`, `DocTextError` (Task 1); `meetingPipelineEnabled()` (`Database/meetingPipelineJob.helpers.js`); `csaasClient.isConfigured()`; the project autocomplete used by `/create-task` (reuse its helper, do not re-implement); `db.meeting.create`, `db.meetingPipelineJob.create`; `buildRoster`.
- Command `/tasks-from-doc`: options `file` (attachment, required), `project` (string, autocomplete, optional), `title` (string, optional, ≤ 100 characters). No `setDefaultMemberPermissions` (the same access as `/create-task`). Replies ephemerally for refusals, publicly for the accepted reply.
  - Refusals, verbatim: pipeline off or CSAAS not configured → `Tasks from documents are not available on this server yet.`; an unknown project → `No project matches that name.`; any `DocTextError` → its message.
  - Accepted: creates `meeting` `{ guildConfigId, channelId: interaction.channelId, projectId?, transcript: text }` and `meetingPipelineJob` `{ guildConfigId, meetingId, dataJson: { source: 'document', reviewChannelId: interaction.channelId, documentName: <file name>, title: <title option or file name without extension> } }` (if `create` does not take `dataJson`, create then update it, and say so in the report); replies `Reading **<file>** — the proposed tasks will be posted here for review.`
- `createdStage`, when `dataJson.source === 'document'`: title = `dataJson.title + ' — ' + <the date formatted as for meetings>`; roster = `buildRoster({ guild, guildConfigId, meetingId: null, db })` (all verified members); keeps every other key of `dataJson`.
- `transcribingStage`, when `dataJson.source === 'document'`: reads `meeting.transcript`; calls `csaasClient.analyzeLive(job.csaasMeetingId, { meetingNotes: { segment_0: { time_range: '', transcription: text } }, totalDurationSec: 0 })`; patch `{ liveTranscript: true, analysis }` as the live path does; advances. Any error is thrown (the worker retries) and it NEVER uses `/transcribe` or sets `liveTranscriptFailed` (Review Focus 4). An empty transcript throws `document job has no text`.
- Review channel: wherever the pipeline resolves the review channel (`awaiting_review`, `done`, failure notices), a job with `dataJson.reviewChannelId` set uses that channel first (Review Focus 2); recorded meetings keep today's lookup.

- [ ] **Step 1: Write the failing tests**: the command's refusals (each sentence), the rows it creates and the reply, a `DocTextError` passed through, `title` defaulting to the file name; `createdStage` for a document job (title, roster from all verified members, `dataJson` kept); `transcribingStage` for a document job (the exact `analyzeLive` payload; an `analyzeLive` failure throws and never calls `transcribeSegment`; an empty transcript throws); the review channel for a document job is `dataJson.reviewChannelId` even with no `meetingchannel` row; a recorded-meeting job's `createdStage`/`transcribingStage` unchanged (existing tests untouched).
- [ ] **Step 2: Run** the test files → FAIL.
- [ ] **Step 3: Implement.** Download the attachment with `downloadAttachment(interaction.options.getAttachment('file'))` after `deferReply`.
- [ ] **Step 4: Run** them, then `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(meetings): /tasks-from-doc turns a document into reviewed tasks`.

---

### Task 4: Bot — a document at `/record action:start`

**Files:**
- Modify: `bot/src/commands/record.js`, `bot/src/services/voiceCapture.js` (`startMeetingRecording` passes the text), `bot/src/services/csaasClient.js` (`createMeeting` accepts `preMeetingNotes`), `bot/src/services/meetingPipelineStages.js` (`createdStage` passes the stored text when it creates the CSAAS meeting)
- Test: `bot/src/commands/record.test.js` (create if absent), `bot/src/services/csaasClient.test.js`, `bot/src/services/meetingPipelineStages.test.js` (added cases)

**Interfaces:**
- `/record` gains optional `document` (attachment). With `action:start`: read it with Task 1's functions BEFORE starting; on success pass `preMeetingNotes: text.slice(0, 20000)` to `startMeetingRecording`, which passes it to `csaasClient.createMeeting({ title, participants, preMeetingNotes })` and stores it on the bot `meeting` row (the `notes`-like column that exists and is unused for this purpose — use a key inside an existing JSON/text column only if one fits; if no column fits without a migration, keep it only in memory for `startMeetingRecording`'s CSAAS call and say so in the report — do NOT add a migration).
- `createMeeting` sends `pre_meeting_notes` only when `preMeetingNotes` is a non-empty string.
- Replies: the existing start reply plus `Using **<file>** as background for this meeting.`, plus `Claude reads the first 3,000 characters of it.` when the text is longer than 3,000 characters. A `DocTextError` → the recording still starts and the reply adds `The document was not used: <sentence>` (Review Focus 5). `document` with `action:stop` is ignored.

- [ ] **Step 1: Write the failing tests** (seams for the recording start, the download, the CSAAS client): the text reaches `createMeeting` as `pre_meeting_notes`; capped at 20,000; the reply lines; > 3,000 adds the second line; an unreadable document still starts the recording and explains; no document → today's behaviour and today's `createMeeting` body (no `pre_meeting_notes` key).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them, then `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(meetings): a document at /record start becomes Claude's background for the meeting`.

---

### Task 5: CSAAS — `/create` accepts `pre_meeting_notes`

Work in `D:\Work\Granjur Technologies\CSAAS_Backend`: `git checkout -b feat/doc-tasks main`.

**Files:**
- Modify: `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js` (`createMeeting`)
- Test: a standalone node script beside the existing meeting-workflow test scripts (find them; follow their style and their hooks for faking `executeQuery` and the permission check), e.g. `Services/SysScripts/TestScripts/meeting-workflow-test/create.test.js`

**Interfaces:**
- `createMeeting` reads optional `pre_meeting_notes`: absent/null/'' → today's behaviour exactly (the same INSERT and values); a string of ≤ 20,000 characters → stored in `meetings.pre_meeting_notes` (add it to the INSERT's columns and values); a non-string or a longer string → 400 (`pre_meeting_notes must be text of at most 20,000 characters`), nothing inserted.
- The object's declared fields list (if the object declares one) gains `pre_meeting_notes`.

- [ ] **Step 1: Write the failing test script**: without the field the INSERT and values are exactly as before; with a string it is stored; 20,000 accepted, 20,001 refused; a number refused; nothing inserted on refusal.
- [ ] **Step 2: Run** the script → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the script and every existing meeting-workflow test script (report each script's own pass line).
- [ ] **Step 5: Commit** `feat(meeting-workflow): /create accepts the pre-meeting brief`.

---

### Task 6: Full suites, knowledge and state

**Files:** `.claude/knowledge/csaas-meeting-workflow-integration.md` (the notes, the reporting stage, document jobs, the pre-meeting brief), a new `.claude/knowledge/doc-tasks.md` + a README index line, `.claude/state/backlog.md`, `.claude/state/completed.md`, `.claude/state/session.md`.

- [ ] **Step 1:** bot `npm test` (`ℹ fail 0`); CSAAS the new script and the meeting-workflow scripts.
- [ ] **Step 2: Knowledge** — `doc-tasks.md`: the command, the accepted files and limits, the document job (`dataJson.source`, `reviewChannelId`, the text path), the meeting-start document and the 3,000-character reading; the notes files and the `reporting` stage (best-effort, once). Update `csaas-meeting-workflow-integration.md`'s stage list and the "notes are empty" history.
- [ ] **Step 3: State** — backlog: roadmap item 7 → BUILT, NOT DEPLOYED, rollout CSAAS → bot; completed: a 2026-09-30 entry with commits per repo; session: current state.
- [ ] **Step 4: Commit** `docs: tasks from documents and meeting notes — knowledge and state`.

---

## Rollout (after merge; each push needs the owner's go-ahead)

1. Push CSAAS `main` (auto-deploys). Harmless alone: `pre_meeting_notes` is simply accepted.
2. Push the bot's `main` (`npm ci` on the VM installs `unpdf` and `mammoth`; confirm the deploy workflow runs `npm ci`/`npm install` — if it does not, say so before pushing).

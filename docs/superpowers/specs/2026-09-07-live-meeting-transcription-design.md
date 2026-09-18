# Live meeting transcription — design

**Date:** 2026-09-07
**Status:** approved (design), not yet implemented
**Repos:** `Granjur-Discord-Bot` (bot) and `CSAAS_Backend` (VM backend)

## 1. Goal

While a meeting is being recorded, the conversation appears as text in that
meeting's Discord channel, attributed to the person who said it, in the order it
was said. The same turn-by-turn transcript then becomes the transcript CSAAS
analyses, replacing the per-speaker whole-file upload used today. Every meeting
channel also carries a pinned explanation of the meeting commands and the
end-to-end flow.

## 2. Why the current recordings cannot be reused

`startMeetingRecording` (`bot/src/services/voiceCapture.js`) opens **one
continuous** Opus stream per speaker (`EndBehaviorType.Manual`) and pipes it into
a single `.ogg`. Discord sends no packets while a user is silent, so each file
contains that speaker's speech with every gap removed: a 40-minute meeting in
which one person spoke for 6 minutes yields a 6-minute file whose internal
timeline has no relation to wall-clock.

Two consequences:

- No merge of the existing files can reconstruct speaking order. Timestamps
  inside them are meaningless across speakers.
- Today's CSAAS transcript is therefore *all of speaker A, then all of speaker B*
  (`[Segment N]` blocks). It is labelled, but it is not a conversation, which is
  why extracting "X will do Y" ownership from it is unreliable.

A real conversation transcript requires segmenting into utterances **at capture
time** and stamping each with the wall clock. Discord tells the bot exactly who
is speaking, so speaker attribution is exact — no diarization is involved.

## 3. Decisions taken

| Question | Decision |
|---|---|
| Live or at the end? | **Live**, as people speak. |
| Presentation | **Grouped blocks posted by the bot** — bold name, timestamp, quoted text; consecutive turns by one speaker merge. |
| Does it feed CSAAS? | **Yes — replaces** the whole-file `/transcribe` upload, with automatic fallback to it. |
| Where does STT run? | **CSAAS on the VM**, via a new endpoint. Provider stays on the existing `STT_PROVIDER` toggle. |
| Consent | **Always on**, announced by a notice posted at meeting start. |

## 4. Capture and segmentation (bot)

**File:** `bot/src/services/voiceCapture.js`, the `receiver.speaking.on("start")`
handler (currently ~L527-596).

Change one subscription-per-speaker into one subscription **per utterance**:

- Subscribe on each `speaking.start` with
  `{ end: { behavior: EndBehaviorType.AfterSilence, duration: 900 } }`. The
  stream that results is exactly one utterance. Because `AfterSilence` ends the
  stream, `receiver.subscriptions` releases the user and the next
  `speaking.start` creates a fresh stream — re-subscribing is safe.
- Keep **one long-lived `OggOpusEncoder` and write stream per speaker** for the
  whole session. Each utterance stream pipes into it with `{ end: false }`. The
  resulting `.ogg` and its `MeetingRecording` row are byte-identical to today's,
  so `/playback` is unaffected.
- Tee the same Opus packets into a second, throwaway `OggOpusEncoder` that yields
  one small in-memory OGG buffer per utterance.
- `finishRecording` moves from per-stream-finish to session end (one row per
  speaker, as today).

Each utterance carries:

- `sequence` — a per-meeting counter assigned at `speaking.start`. This is the
  ordering authority for the whole feature.
- `startedAt` — wall clock at `speaking.start`.
- `durationMs` — packet count x 20 (Opus frames are exactly 20 ms).

Gates:

- Utterances shorter than **500 ms** are dropped without an STT call.
- An utterance still running at **30 s** is force-cut and a new one begins, so a
  monologue cannot stall the feed.

### 4.1 Creating the CSAAS meeting up front

Today the CSAAS meeting is created by `createdStage`, which runs only *after* the
recording ends. A live feed needs a `meeting_id` while the meeting is still
running, so the `createMeeting` call moves to recording start:

- `startMeetingRecording`, once the voice connection is ready, calls
  `csaasClient.createMeeting({ title, participants })`. The title uses the same
  `deriveMeetingName` + `formatMeetingDate` pair `createdStage` uses — both read
  the recordings directory name, which is already known at start — and
  `participants` are the non-bot members in the channel at that moment.
- The returned id is stored on the bot's `meeting` row in a new `csaasMeetingId`
  column (part of migration `016`).
- `createdStage` is amended to reuse that id when present and only create a
  meeting when it is absent. That keeps the pipeline working for meetings
  recorded before this change, and for any meeting where CSAAS was unreachable at
  start.
- If `createMeeting` fails at start, recording proceeds normally with no live
  feed, and `createdStage` creates the meeting at the end exactly as it does
  today.

The roster snapshot stays in `createdStage`, where it belongs — people join a
meeting after it starts, so a roster captured at start would be wrong.

## 5. Transcription endpoint (CSAAS)

**New:** `POST /api/meeting/workflow/utterance` →
`global.MeetingWorkflowUtterance_object` in
`Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js`, defined with
the same `step(handler, fields)` helper as its neighbours.

Multipart request: `meeting_id`, `speaker_ref` (Discord user id), `speaker_name`
(guild display name), `started_at` (ISO), `sequence` (int), `duration_ms` (int),
audio file.

Handler:

1. `await requireMeetingPermission(req, decryptedPayload, "run_meeting_ai", meetingId)`
   — same guard as `transcribeMeeting`.
2. `await transcribeSegment(audioFile.buffer, audioFile.originalname)` — the
   existing provider dispatcher (`meetingWorkflow.js:7`), so `STT_PROVIDER`
   continues to select Soniox (`stt-async-v4`, en/ur) or Whisper.
3. Insert into a new `meeting_utterances` table.
4. Return `{ text, sequence }`.

Empty or whitespace-only text means inaudible: the row is still written (with
empty text) so the sequence is accounted for, and the bot posts nothing.

**Migration:** `data/migrations/20260907_1_meeting_utterances.sql` — the
`YYYYMMDD_N_description.sql` convention that directory already uses — picked up by
`runMigrationsOnStart.js` (ledger table `schema_migrations`, keyed by filename).
Table `meeting_utterances`, InnoDB / utf8mb4:

- `id` INT AUTO_INCREMENT PRIMARY KEY
- `meeting_id` VARCHAR(64) NOT NULL
- `sequence` INT NOT NULL
- `speaker_ref` VARCHAR(64) NULL — Discord user id
- `speaker_name` VARCHAR(190) NULL
- `started_at` DATETIME NOT NULL
- `duration_ms` INT NOT NULL DEFAULT 0
- `text` TEXT NULL
- `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
- UNIQUE KEY on (`meeting_id`, `sequence`) — makes a retried upload idempotent
- KEY on (`meeting_id`)

**Bot client:** `bot/src/services/csaasClient.js` gains
`transcribeUtterance(meetingId, { buffer, filename, speakerRef, speakerName, startedAt, sequence, durationMs })`,
modelled on the existing `transcribeSegment`. At most **3 calls in flight** at
once.

## 6. Posting to the channel (bot)

**New file:** `bot/src/services/transcriptFeed.js`. One feed per meeting.

**Target channel:** whatever `resolveMeetingChannel`
(`bot/src/services/meetingPipelineStages.js:123`) returns — the dedicated meeting
text channel if one exists, else the voice channel's own chat. That makes
`/record` in an ad-hoc voice channel work without extra setup.

**Ordering.** STT returns out of order. The feed holds completed utterances in a
map keyed by `sequence` and flushes only the longest **contiguous** run starting
at the next unflushed sequence. A sequence still pending after **25 s** is marked
failed and skipped, so one slow call cannot freeze the feed behind it.

**Flush cadence.** Every **6 s**. That caps the bot at 10 messages per minute,
far below Discord's per-channel limit, and gives consecutive turns time to merge.

**Grouping and rendering.** Consecutive utterances by the same speaker within
60 s become one block:

```
**Nauraiz Haider** · 14:32
> Let's start with the booking module — the cancellation window is still wrong.

**Adnan** · 14:32
> Right, it's reading the created date instead of the check-in date.
```

Lines accumulate to ~1800 characters before the message is cut, so a message
never approaches Discord's 2000-character limit. Display names are the guild
`displayName`, resolved once per speaker per meeting and cached.

**Start notice.** When the feed starts it posts, before any transcript, a short
notice that the meeting is being recorded and transcribed and that everything
said will appear in the channel. This is posted alongside the existing
`ready-to-record.ogg` audio cue.

**Bot-side persistence.** Every utterance that returns from the endpoint —
including the empty ones, so sequences stay accounted for — is also written to
the bot's own database, mirroring what CSAAS stored. Migration
`bot/src/Database/migrations/016_meeting_utterance.sql`,
following the `information_schema`-guarded style of `014_task_external_meeting.sql`.
Columns mirror the CSAAS table plus `guildConfigId` and `meetingId` (the bot's
`meeting.id`). The same migration adds `meeting.csaasMeetingId` (see §4.1). This
is what makes the pipeline handoff restart-safe and lets a partial transcript
survive a bot restart.

## 7. Pipeline handoff (bot)

**File:** `bot/src/services/meetingPipelineStages.js`.

`STAGE_ORDER` is unchanged (`created → transcribing → analyzing →
generating_tasks → assigning → awaiting_review → approved → mirrored →
issue_syncing → done`), so in-flight jobs, `/meeting-review` and `/meeting-retry`
keep working.

`transcribingStage` gains a branch at the top:

- Count the bot's utterance rows for the meeting with non-empty text. If it is
  **>= 5**, build the `analyze-live` payload and call
  `POST /api/meeting/workflow/analyze-live`. That endpoint stores the assembled
  transcript **and** runs `analyzeMeetingTranscript` in the same call. Store the
  returned analysis on `dataJson` together with `liveTranscript: true`, and
  advance.
- Otherwise run today's per-speaker file upload loop unchanged.

`analyzingStage` gains a guard: when `dataJson.liveTranscript` is set and an
analysis is present, advance without calling CSAAS.

**Fallback triggers:** fewer than 5 utterances with text, or `analyze-live`
throwing. Either way the stage falls through to the existing whole-file path and
`analyzingStage` behaves as it does today. Five is low enough that a genuinely
short meeting still takes the live path, and high enough to distinguish a working
feed from an STT outage.

**`analyze-live` payload shape** (matching `analyzeLive` at
`meetingWorkflow.js:509`):

```js
{
  meeting_id,
  meeting_notes: {
    segment_0: { time_range: "00:00-05:00", transcription: "Nauraiz Haider: ...\nAdnan: ..." },
    segment_1: { time_range: "05:00-10:00", transcription: "..." },
  },
  total_duration_sec,
}
```

Utterances are bucketed into ~5-minute segments by `startedAt` relative to the
meeting start; within a segment each line is `Display Name: text` in `sequence`
order.

## 8. Pinned meeting guidelines (bot)

**New file:** `bot/src/config/meetingGuidelines.js`, exporting a builder for the
embed, following the `getChannelPinnedMessage` pattern at
`bot/src/config/commands.js:62`.

Content:

- **Transcription notice** — this channel receives a live transcript of
  everything said in the meeting.
- **Commands** — `/record start|stop`, `/schedule`, `/meetings`,
  `/meeting-channel`, `/meeting-review`, `/meeting-retry`, `/playback`.
- **Flow** — bot joins and plays the ready cue → transcript appears live in this
  channel → last person leaves (2-minute grace) or `/record action:stop` → CSAAS
  transcribes and analyses → the review UI posts here with proposed tasks and
  assignees → someone approves → tasks are created, per-task ticket channels
  open, assignees are DM'd.

**Pinned at three entry points:**

- `bot/src/commands/meeting-channel.js:52` — on text-channel creation.
- `bot/src/services/meetingAutoChannel.js:198` — on auto-created meeting channels
  for scheduled meetings.
- `/record action:start` — pins into the channel `resolveMeetingChannel` picks.

**Idempotent:** before posting, fetch the channel's pins and look for a
bot-authored message carrying the guidelines marker (a fixed string in the embed
footer). If one is present, do nothing. Restarting the bot or re-recording in the
same channel must not stack duplicates.

## 9. Failure behaviour

| Failure | Behaviour |
|---|---|
| STT calls start failing | Feed posts one warning and goes quiet. Audio recording is untouched. Pipeline takes the fallback path. |
| Target channel deleted mid-meeting | Feed disables itself; no throw on each flush. |
| One utterance's STT stalls | Skipped after 25 s; the feed continues from the next sequence. |
| Bot restarts mid-meeting | The recording already dies today. Utterance rows persisted so far survive, so a partial transcript remains and the pipeline can still use it. |
| `analyze-live` errors | `transcribingStage` falls back to whole-file upload. |
| CSAAS unreachable | No live feed; recording and the existing pipeline retry path are unchanged. |

## 10. Testing

`node:test`, colocated `*.test.js`, run with bare `node --test` (the directory
form fails on Windows).

- `transcriptFeed.test.js` — out-of-order arrival, contiguous-prefix flushing, a
  stalled sequence being skipped after the timeout, same-speaker grouping, the
  60-second grouping boundary, and the ~1800-character message cut.
- `meetingPipelineStages.test.js` (extend) — the live-transcript branch, the
  `< 5` fallback, the `analyze-live` error fallback, and `analyzingStage` skipping
  when `liveTranscript` is set.
- A payload-builder test for the `analyze-live` segment bucketing.
- `createdStage` reusing a stored `csaasMeetingId` rather than creating a second
  CSAAS meeting, and still creating one when the column is null.
- `meetingGuidelines.test.js` — embed content and the marker used for pin
  detection.
- CSAAS: a test for the `utterance` handler under
  `Services/SysScripts/TestScripts/meeting-test/`, following `explainAgent.test.js`.

The streaming glue inside `voiceCapture.js` is not unit-testable and is verified
on a live meeting.

## 11. Cost

Soniox bills on audio duration, and the total speech in a meeting is the same
either way. This adds per-request overhead (one request per utterance instead of
one per speaker) but **removes** the second whole-file pass, so it lands roughly
cost-neutral rather than doubling.

## 12. Known risks

- **Utterance fragmentation.** Discord's `speaking` events follow voice activity,
  so a noisy mic can split one sentence across several utterances. The 900 ms
  silence window plus same-speaker merging covers most of it; this is the
  parameter most likely to need tuning after the first real meeting.
- **`analyze-live` blocks the CSAAS event loop.** It runs the Claude analysis
  inside the request via `spawnSync` for 30-90 s. This is exactly what `/analyze`
  does today, so the change does not make it worse, but the async-spawn fix stays
  on the backlog.
- **Out of scope:** editing or redacting a posted transcript line, and exporting
  the transcript as a file. Neither is required for this feature.

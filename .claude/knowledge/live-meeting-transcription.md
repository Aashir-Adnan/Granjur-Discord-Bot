# Live meeting transcription

While a meeting records, each speaker turn is transcribed and posted to the meeting's
Discord channel, attributed and in spoken order. That same transcript then becomes what
CSAAS analyses, replacing the per-speaker whole-file upload.

Spec: `docs/superpowers/specs/2026-09-07-live-meeting-transcription-design.md`.
Plan: `docs/superpowers/plans/2026-09-07-live-meeting-transcription.md`.

## Why the old recordings could not be reused

`startMeetingRecording` used to open **one continuous** Opus subscription per speaker
(`EndBehaviorType.Manual`). Discord sends no packets during silence, so each `.ogg` is
that speaker's speech with every gap removed — a 40-minute meeting where someone spoke
for 6 minutes yields a 6-minute file whose internal timeline has no relation to
wall-clock. Speaking order cannot be reconstructed from those files by any merge, which
is why the old CSAAS transcript was *all of speaker A, then all of speaker B*
(`[Segment N]` blocks) rather than a conversation.

Segmentation therefore has to happen at capture time. Discord tells us exactly who is
speaking, so attribution is exact — there is no diarization anywhere in this feature.

## Capture — `bot/src/services/voiceCapture.js`

One subscription **per utterance** (`AfterSilence`, 900 ms), each piped into the same
long-lived per-speaker `OggOpusEncoder`. The stored `.ogg` and its single
`MeetingRecording` row are byte-identical to before, so `/playback` is unaffected.

Gotchas that cost real debugging time, all verified against the `@discordjs/voice`
source:

- **Never `await` before `receiver.subscribe`.** `onUdpMessage` emits `speaking.start`
  and looks up the subscription in the same synchronous block, so any await loses the
  packet that raised the event — 20 ms off the front of every turn.
- **Do not destroy a subscription mid-monologue.** `SpeakingMap` emits `start` only when
  the user is not already marked speaking, so destroying at `MAX_UTTERANCE_MS` drops
  every packet until the speaker actually pauses. The 30 s cap cuts the *feed segment*
  and leaves the subscription alive.
- **`finalize` must not remove the speaker from `activeUserStreams`.** It sets
  `retired` instead. Deleting it let a mid-meeting write error start a second encoder on
  the same path — a truncated file and two `MeetingRecording` rows for one speaker.
- `writeStream.destroy()` emits only `close`, not `finish` or `error`. Without a `close`
  listener, `pendingWrites` never resolves and `endMeetingSession` hangs forever.

## Ordering — `bot/src/services/transcriptFeed.js`

Speech-to-text returns out of order, so the feed releases only a **contiguous** run of
sequence numbers from its cursor.

- **The sequence is claimed at turn START**, not at turn end. Claiming it at the end
  makes an interjection render above the longer turn it interrupted, because rendering
  orders by sequence and stamps headers from `startedAt`. An utterance later rejected by
  the 500 ms gate settles as `failed` so the cursor still consumes it — every number
  handed out must reach a settled state or the feed freezes for the rest of the meeting.
- **`OPEN_STALL_MS` (60 s) is deliberately larger than `STALL_MS` (25 s)** because an
  open turn holds the cursor and the capture loop's segment cap is 30 s. **If
  `MAX_UTTERANCE_MS` is ever raised during tuning, `OPEN_STALL_MS` must move with it** or
  every long turn is dropped.
- Flush every 6 s caps the bot at 10 messages/minute. Messages cut at 1800 chars against
  Discord's 2000 limit. `allowedMentions: { parse: [] }` is load-bearing — transcribed
  speech contains people's names constantly.

## Backend — CSAAS `POST /api/meeting/workflow/utterance`

`Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js`. Multipart:
`meeting_id`, `sequence`, `speaker_ref`, `speaker_name`, `started_at`, `duration_ms`,
`actionPerformerURDD`, file. Returns `{ text, sequence }`. Provider follows the existing
`STT_PROVIDER` toggle (Soniox `stt-async-v4` for en/ur, else Whisper).

**An inaudible turn resolves with `text: ''`; a failed transcription throws.** The feed
routes these differently — collapsing them would make a total STT outage look like a
silent meeting.

Table `meeting_utterances`, migration `data/migrations/20260907_1_meeting_utterances.sql`.
`meeting_id` is `INT(11)` with `FOREIGN KEY … ON DELETE CASCADE`, matching the nine
sibling meeting-child tables — a VARCHAR column with no FK would orphan rows forever.

## Pipeline handoff — `bot/src/services/meetingPipelineStages.js`

`STAGE_ORDER` is unchanged. Two branches:

- `createdStage` **reuses `meeting.csaasMeetingId`** when present. The CSAAS meeting is
  now created at recording start so the live feed has somewhere to post; without this
  reuse every meeting creates two CSAAS meetings and the analysis runs against the empty
  one.
- `transcribingStage` takes the live path when there are **≥ 5** utterances with text:
  `buildAnalyzeLivePayload` → `analyzeLive`, which stores the transcript *and* runs the
  analysis in one call, so `analyzingStage` then skips. Any failure falls through to the
  unchanged whole-file upload, and sets `dataJson.liveTranscriptFailed` so the expensive
  call is not retried on every `advance: false` tick.

## Debugging

```bash
pm2 logs granjur-bot --lines 80 | grep -iE "transcriptFeed|voiceCapture|live transcript"
```

```sql
-- did the live path run?
SELECT stage, JSON_EXTRACT(dataJson,'$.liveTranscript') live,
       JSON_EXTRACT(dataJson,'$.liveTranscriptFailed') failed
  FROM meetingpipelinejob ORDER BY createdAt DESC LIMIT 1;

-- the turns themselves
SELECT sequence, speakerName, LEFT(text,60) FROM meetingutterance
 WHERE meetingId = ? ORDER BY sequence;
```

On CSAAS, a real conversation looks like alternating `Name: text` lines under
`[00:00-05:00]`. If it looks like one `[Segment N]` block per speaker, the fallback ran.

## Known limits

- `ensureMeetingChannel` returns the same `meetingId` forever for a persistent voice
  channel, so re-recording the same room reuses it. `clearStaleLiveSession` wipes the
  previous session's utterance rows at recording start to stop them being half-overwritten
  — which means a previous recording's un-run pipeline job loses its live transcript and
  falls back. The real fix is `forceNewMeeting` from `/record`; see [[../state/backlog]].
- `/meeting-retry` does not clear `liveTranscriptFailed`, so a meeting that hit a
  transient outage is stuck on the fallback path permanently.
- The consent notice needs a resolvable channel. If `resolveMeetingChannel` returns null
  nothing is posted and nothing warns loudly.

Related: [[meeting-audio-recording]], [[csaas-meeting-workflow-integration]].

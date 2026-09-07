# Current Session

**Date:** 2026-09-07

## Goal
Live per-speaker meeting transcription in the meeting's Discord channel, plus a
pinned meeting-guidelines message in every meeting channel.

## Status
Design approved in chat; spec written to
`docs/superpowers/specs/2026-09-07-live-meeting-transcription-design.md`.
Awaiting the human's review of the spec before writing the implementation plan.

## Plan
1. Spec (done) → human review.
2. `superpowers:writing-plans` → implementation plan.
3. `superpowers:subagent-driven-development` to execute it.

## Decisions taken (see spec §3)
- Live as people speak, not a dump at the end.
- Grouped blocks posted by the bot (bold name · time, quoted text), not webhook
  impersonation.
- The live transcript **replaces** the per-speaker whole-file `/transcribe`
  upload, with automatic fallback to it.
- STT runs on CSAAS via a new `POST /api/meeting/workflow/utterance`; the
  existing `STT_PROVIDER` toggle still picks Soniox or Whisper.
- Always on, announced by a notice at meeting start.

## Key finding driving the design
`startMeetingRecording` opens one continuous Opus stream per speaker; Discord
sends nothing during silence, so each `.ogg` is that speaker's speech with all
gaps removed. Speaking order cannot be reconstructed from the stored files by
any merge — segmentation has to happen at capture time. See spec §2.

## Hole found in spec self-review
The CSAAS meeting is created by `createdStage`, which runs after recording ends,
so a live feed would have no `meeting_id`. Fixed in spec §4.1: `createMeeting`
moves to recording start, the id is stored on `meeting.csaasMeetingId`, and
`createdStage` reuses it when present.

## Knowledge / skills in use
- `.claude/knowledge/meeting-audio-recording.md` — capture and playback pipeline.
- `.claude/knowledge/csaas-meeting-workflow-integration.md` — CSAAS endpoints.
- `superpowers:brainstorming` (done), then `writing-plans`,
  then `subagent-driven-development`.

## Open questions
None blocking. The 900 ms utterance-silence window is the parameter most likely
to need tuning after the first real meeting (spec §12).

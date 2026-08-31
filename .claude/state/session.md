# Current Session

**Date:** 2026-08-31

## Goal
- Stand up the `.claude/` memory scaffold + root `CLAUDE.md`.
- Answer questions about meeting audio: on-disk playback, user↔recording relations,
  and feasibility of a playback UI with play/pause/±10s controls.

## Status: done

## Knowledge / skills in use
- `.claude/knowledge/meeting-audio-recording.md` (created this session)

## Findings (see knowledge file for detail)
- Recordings ARE played back today via `/playback` (join VC, stream one file).
- User↔recording relation exists: `MeetingRecording.memberId` (Discord user id) +
  `meetingId` + `guildConfigId`.
- Transport controls (play/pause/skip/rewind) are feasible but NOT with a modal —
  needs a button row + ffmpeg-based seek. Filed in backlog.

## Open questions
- Is `bot/src/services/meetingAudioRecorder.js` dead code vs
  `voiceCapture.startMeetingRecording`? (format mismatch — see backlog)

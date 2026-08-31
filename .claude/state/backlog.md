# Backlog

Outstanding work, highest priority first. Move items to `completed.md` (dated) when done.

---

## Meeting recording playback with transport controls (modal/buttons)
**Context:** `/playback` currently only does select-menu → join VC → play one file
start-to-finish. No pause/resume, no ±10s seek. Discord modals cannot host live
transport controls; this needs a **button ActionRow** (Play/Pause, ⏪ 10s, ⏩ 10s,
Stop) on the reply message, backed by an `AudioPlayer` with seek implemented by
recreating the `AudioResource` at a byte/time offset (needs ffmpeg `-ss`, since
`@discordjs/voice` has no native seek).
**Relevant:** `.claude/knowledge/meeting-audio-recording.md`,
`bot/src/commands/playback.js`, `bot/src/handlers/interactions.js`

## Fix format mismatch in playback.js
**Context:** `playback.js` does `r.fileName?.replace(".ogg", "")` but
`meetingAudioRecorder.js` writes `.opus` (raw Opus, no container — not playable).
`voiceCapture.js` writes real `.ogg` via `OggOpusEncoder`. Decide on one recorder +
one format. `meetingAudioRecorder.js` appears to be dead/legacy alongside
`voiceCapture.startMeetingRecording`.
**Relevant:** `.claude/knowledge/meeting-audio-recording.md`

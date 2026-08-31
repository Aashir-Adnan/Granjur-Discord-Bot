# Meeting audio recording & playback

## Recording pipeline

Two recorders exist:

### `bot/src/services/voiceCapture.js` — `startMeetingRecording()` (current)
- `joinVoiceChannel({ selfDeaf: false })`, waits for `Ready`, plays
  `bot/assets/ready-to-record.ogg` as a cue.
- On `receiver.speaking.on("start", userId)` it subscribes to that user's Opus
  stream **once** (`EndBehaviorType.Manual`, one continuous stream per user tracked
  in `activeUserStreams`).
- Pipes raw Opus → `OggOpusEncoder` (`bot/src/utils/oggOpusStream.js`, hand-rolled
  OGG page muxer with correct OGG CRC32) → `fs.createWriteStream`.
- File: `bot/recordings/<meetingId8>-<topic-slug>/<emailLocalPart-or-userId>.ogg`
  (one file per speaker per meeting).
- Session ends when the channel has no non-bot members for a 2-min grace period, on
  `MAX_RECORDING_SECONDS` (2h), or explicit stop. On end: destroys streams, waits for
  `pendingWrites`, sets `MeetingRecordingStatus.status = "completed"`, optionally
  deletes the voice/text channels (`deleteOnEnd`, `textChannelId`).
- Each finished file → `db.meetingRecording.create({ audioFormat: "ogg", ... })`.

### `bot/src/services/meetingAudioRecorder.js` — `startMeetingAudioRecording()` (legacy/suspect)
- Similar, but writes **raw Opus** to `bot/recordings/meeting-<id>-<user>-<ts>.opus`
  with `audioFormat: "opus"` and a **new file every speaking burst**.
- Raw Opus with no container is NOT directly playable by `createAudioResource` /
  VLC / ffmpeg. Likely dead code. Confirm callers before relying on either.

Legacy `startRecording()` in `voiceCapture.js` (used by `/record` slash command)
writes decoded **`.pcm`** per burst under `recordings/<meetingId>/` — raw PCM, also
not directly playable without specifying input format.

## Database tables (`bot/src/Database/migrations/007_meeting_records.sql`, `schema.sql`)

### `MeetingRecording` — one row per speaker per (continuous) recording
| column | meaning |
|---|---|
| `id` | PK (uuid) |
| `guildConfigId` | FK → `guildconfig.id` |
| `meetingId` | FK → `meeting.id` |
| `memberId` | **Discord user id of the speaker** |
| `filePath` | absolute path on the bot host |
| `fileName` | basename |
| `audioFormat` | `"ogg"` (voiceCapture) or `"opus"` (legacy) |
| `startedAt` / `endedAt` / `durationSeconds` | timing |

Indexed on `guildConfigId`, `meetingId`, `memberId`. **This is the user↔recording
relation.** To map to a human: `memberId` → `guildMember` (by
`guildId_discordId`) → `email`. `voiceCapture` already uses the email local-part as
the filename.

### `MeetingRecordingStatus` — one row per meeting (`UNIQUE(meetingId)`)
`status` (`idle`/`recording`/`completed`), `voiceChannelId`, `startedAt`, `endedAt`.

## Playback today — `bot/src/commands/playback.js` (`/playback`)

CEO/Server-Manager only. Flow:
1. `/playback` → embed + `StringSelectMenu` `playback_select_meeting` listing up to 25
   meetings (recordings grouped by `meetingId`).
2. `playback_select_meeting` → `handleMeetingSelect` → filters recordings whose
   `filePath` exists on disk → `StringSelectMenu` `playback_select_recording`.
3. `playback_select_recording` → `handleRecordingSelect`:
   - requires the invoking user to be in a voice channel,
   - stops any existing playback for the guild (`activePlayers` Map, guildId-keyed),
   - `joinVoiceChannel` → `createAudioPlayer` → `createAudioResource(filePath)` →
     `player.play` + `connection.subscribe(player)`,
   - on `AudioPlayerStatus.Idle` / error → `connection.destroy()`.

Select-menu routing is wired in `bot/src/handlers/interactions.js` (~L300).

### Menu labels (2026-08-31)
`playback.js` has helpers `resolveDisplayName(guild, memberId)` (guild displayName →
stored email local-part → raw id), `deriveMeetingName(filePath, meetingId)` (parses
the `<meetingId8>-<topic-slug>` recordings dir → Title Case; falls back to
`Meeting <id8>`), and `formatMeetingDate` (`Aug 31, 2026, 2:30 PM`).
- Meeting dropdown label: `"<Meeting Name> — <date>"`, sorted newest first.
- Recording dropdown label: `"<username> Recording"`, description = duration.
- `meeting` table has **no name/topic column**; the only meeting-name source is the
  recordings directory path (or `scheduledmeeting.topic` matched loosely by
  `voiceChannelId`).

### Limitations / bugs
- **No transport controls.** Plays a single file front-to-back; only implicit "stop"
  is starting another playback.
- Plays one speaker's file, not a mixed meeting track. No mixing step exists.

## Can we add play / pause / skip 10s / rewind 10s?

**Yes — but not via a Discord modal.** Modals (`ModalBuilder`) are one-shot text-input
forms; they cannot hold live playback controls or update in place. Use a **button
`ActionRow`** on the `/playback` reply instead (`▶️/⏸`, `⏪ 10s`, `⏩ 10s`, `⏹`),
handled as `ButtonInteraction`s.

Implementation notes:
- **Pause/resume:** `AudioPlayer.pause()` / `.unpause()` — native, easy.
- **Seek (±10s):** `@discordjs/voice` has **no native seek**. Standard approach:
  keep a playback-position counter (`AudioResource.playbackDuration` gives ms played),
  then on seek recreate the resource from ffmpeg with a start offset:
  `prism.FFmpeg({ args: ['-ss', String(newSeconds), '-i', filePath, '-f', 's16le',
  '-ar', '48000', '-ac', '2'] })` → `createAudioResource(ffmpeg.stdout, { inputType:
  StreamType.Raw })`, then `player.play(newResource)`. ffmpeg must be on the host
  (`ffmpeg-static` or system). `prism-media` is already a dependency.
- Track state per guild in the existing `activePlayers` map (add `filePath`,
  `positionMs`, `paused`).
- Debounce rapid ⏪/⏩ clicks; `interaction.update()` the button message with the new
  position.

Filed in `.claude/state/backlog.md`.

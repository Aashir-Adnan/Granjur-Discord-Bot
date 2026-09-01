# Backlog

Outstanding work, highest priority first. Move items to `completed.md` (dated) when done.

---

## Meeting → tasks integration — post-implementation follow-ups
Feature shipped 2026-09-02 (see `completed.md`). Remaining:
- **Live E2E run pending** — blocked on the user providing a real `CSAAS_ACTOR_URDD`
  (a URDD with `add_meetings`+`run_meeting_ai`+`update_meetings`). Runbook:
  `docs/meeting-pipeline-e2e-checklist.md`.
- **`/meeting-review latest` unsupported** — no `db.meetingPipelineJob.findLatest`;
  the command needs an explicit meetingId.
- **`stopMeetingRecording` completion path not hooked** — nothing calls
  `db.meetingPipelineJob.enqueue` when `MeetingRecordingStatus→completed`. Pipeline
  jobs must currently be created manually / by another path.
- **Env truthiness** — `MEETING_PIPELINE_ENABLED="false"` is truthy; the worker gate
  is `!process.env.MEETING_PIPELINE_ENABLED`. Only unset/empty disables it.

## Verify migrations 010 + 011 applied on the live DB
`010_guild_timezone.sql` (guildconfig.timezone), `011_scheduled_meeting_cancelled.sql`
(scheduledmeeting.cancelled). Run `npm run db:migrate`. Until then `/setup timezone`,
`/meetings` cancel, and the cancelled-row filters will error on the missing columns.

## ffmpeg-static — approve install script on fresh deploys
DONE locally: `node_modules/ffmpeg-static/ffmpeg.exe` = 82 MB, `ffmpeg -version`
returns 0, prism-media detects it, package.json + package-lock.json both updated.
BUT this npm has `allowScripts` gating — `npm install` warns ffmpeg-static's
`install: node install.js` is "not yet covered". On a clean prod/CI install run
`npm approve-scripts ffmpeg-static` (or `--allow-scripts`) or the binary won't
download and the seek buttons stay disabled.

## `/meetings` — manager filter is name-based
`isManager()` matches role names `CEO` / `Server Manager` (plus owner / ManageGuild).
If those role names ever change, managers silently lose the all-meetings view. Consider
reusing `guildConfig` role-id lists instead.

## Mixed meeting playback track
`/playback` still plays one speaker's file at a time. No step mixes the per-speaker
`.ogg` files into a single meeting track. Would need ffmpeg `amix` / `amerge`.

## `/schedule` — still open
- Per-user timezone override (deliberately skipped — per-guild only for now).
- Voice-channel picker step (currently `voiceChannelId` is always null).

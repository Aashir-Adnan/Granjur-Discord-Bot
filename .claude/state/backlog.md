# Backlog

Outstanding work, highest priority first. Move items to `completed.md` (dated) when done.

---

## Verify migrations 010 + 011 applied on the live DB
`010_guild_timezone.sql` (guildconfig.timezone), `011_scheduled_meeting_cancelled.sql`
(scheduledmeeting.cancelled). Run `npm run db:migrate`. Until then `/setup timezone`,
`/meetings` cancel, and the cancelled-row filters will error on the missing columns.

## Confirm ffmpeg-static finished downloading
The `npm install` stalled once mid-download (slow GitHub link) and produced a
truncated `node_modules/ffmpeg-static/ffmpeg.exe`. A clean reinstall was started.
Verify: `node -e "require('child_process').spawnSync(require('ffmpeg-static'),['-version'],{stdio:'inherit'})"`
should print a version. Playback still plays from the start without it, but the
rewind/forward buttons stay disabled until ffmpeg works.

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

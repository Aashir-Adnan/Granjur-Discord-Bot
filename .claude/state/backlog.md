# Backlog

Outstanding work, highest priority first. Move items to `completed.md` (dated) when done.

---

## Meeting → tasks integration — post-implementation follow-ups
Feature shipped 2026-09-02 (see `completed.md`). Remaining:
- **Live E2E run is merge-gating** — never run end to end; blocked on the user
  providing a real `CSAAS_ACTOR_URDD`. Runbook: `docs/meeting-pipeline-e2e-checklist.md`.
  During it, smoke-test the `meeting_pipeline_job` `claim`/`claimBatch` SQL against a
  live DB (only fake-db tested).
- **Migration 014 leaves a redundant plain `idx_task_externalId`** on fresh installs
  (013 adds the plain key, 014 no-ops because the unique key from `schema.sql` is
  already present). Harmless; tidy `013` to skip when a unique key exists.
- **Stale-`working` reaper threshold == `MEETING_STAGE_TIMEOUT_MS`** with no margin
  (`bot/src/Database/index.js` `claim`/`claimBatch`). Fine single-process; give it a
  2x multiplier before running multiple worker processes.
- `.claude/state/session.md` still lists the old 3-permission `CSAAS_ACTOR_URDD` set
  (superseded — it's 4 now incl. `view_meetings`; spec/knowledge/backlog are correct).
- **Live E2E run pending** — blocked on the user providing a real `CSAAS_ACTOR_URDD`
  (a URDD with `add_meetings`+`run_meeting_ai`+`update_meetings`+`view_meetings`). Runbook:
  `docs/meeting-pipeline-e2e-checklist.md`.
- **`/meeting-review latest` unsupported** — no `db.meetingPipelineJob.findLatest`;
  the command needs an explicit meetingId.
- **`stopMeetingRecording` in `voiceCapture.js` is dead code (no callers)** — the
  pipeline enqueue actually fires from `endMeetingSession` (empty-channel grace
  timer + max-duration timer, the real meeting-end paths). `stopMeetingRecording`
  is exported but unused — delete it or wire it in for symmetry.
- **Live E2E `CSAAS_ACTOR_URDD` permission set** — must hold `add_meetings` +
  `run_meeting_ai` + `update_meetings` + `view_meetings` (the last for
  `/notes` + `/meeting`).

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

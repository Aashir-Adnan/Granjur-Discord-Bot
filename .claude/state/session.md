# Current Session

**Date:** 2026-09-11

## Goal (done)
Ship live per-speaker meeting transcription into the meeting channel, and deploy it.

## Outcome
Built across 9 tasks with subagent-driven development, reviewed task by task plus a
whole-branch review, merged and deployed. Suite 190 → 246.

- Bot `main` **9ca532d**, CSAAS `main` **ef24b0a**. Both live on the VM.
- Knowledge: `.claude/knowledge/live-meeting-transcription.md`.
- Follow-ups: the "Live meeting transcription" section of `backlog.md`.

## Deployment facts worth remembering
- **Both repos auto-deploy on push to `main`.** The bot's
  `.github/workflows/deploy.yml` pulls, runs `npm run db:migrate`, then restarts pm2 —
  migrations are handled, no manual step. CSAAS uses `Deploy to Azure.yml`, and its
  `runMigrationsOnStart.js` applies migrations at boot and moves the file into
  `data/migrations_completed/`.
- `gh run list` on the CSAAS repo showed **no run** for the push, yet the VM was at the
  right commit with the migration applied. Do not trust `gh run list` there as evidence
  of whether CSAAS deployed — verify on the VM instead.
- **VM access:** `ssh -i /c/Users/Dell/Downloads/frame-work_key.pem azureuser@20.120.228.55`.
  Bot at `~/Granjur-Discord-Bot` under azureuser's pm2; CSAAS at
  `/var/www/CSAAS/CSAAS_Backend` under **root's** pm2 (`sudo pm2 list`).
- CSAAS `.env` DB vars are `DB_HOST` / `DB_USER` / `DB_PW` / `DB_DATABASE` (not
  `DB_PASSWORD` / `DB_NAME`). The bot uses a single `DATABASE_URL`.

## Next
A live meeting is the only thing left. Two people talking, deliberately overlapping, then
check `meetingpipelinejob.dataJson` shows `liveTranscript: true` and that the CSAAS
transcript reads as alternating `Name: text` lines rather than one block per speaker.
The tuning knob if turns come out fragmented is `UTTERANCE_SILENCE_MS` (900 → 1200) in
`voiceCapture.js`; if `MAX_UTTERANCE_MS` is ever raised, `OPEN_STALL_MS` must rise with it.

Known sharp edge while testing: re-recording the same voice channel clears the previous
session's stored turns, because `/record` reuses one `meetingId` per voice channel. Use a
fresh channel per test run. Root fix is in the backlog.

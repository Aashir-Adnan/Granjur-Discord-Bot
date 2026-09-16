# Current Session

**Date:** 2026-09-16

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


---

## 2026-09-16 — command access

`/invite` was invisible because it declared both a `commandRoles` entry and
`setDefaultMemberPermissions`; Discord enforces the second by hiding the command, so
the roles the config grants it to could not see it. Ten commands had this. All ten now
rely on `command-config.json` alone, and `commandGates.test.js` fails the build if a
command ever declares both again.

Two commands then turned out to have never worked, because nobody could reach them:
`/invite emails:...` and `/verify code:...` both built a fake interaction with
`{ ...interaction }`, which drops prototype members — so `editReply` and the `guild`
getter were missing. Both now take their value as an argument. `{ ...interaction }`
appears nowhere in the codebase any more.

Also fixed: the boot-time command hash ignored `default_member_permissions`, so any
permission change produced an identical hash and never reached Discord.

New: `/set-roles` changes any member's roles, not only those awaiting approval.
`roleSync.js` owns the managed role list and `/approve` and `/backlog` import it.
Only managed roles are ever removed, so Verified and Holding cannot be stripped by
accident.

Commits: 4c7ede6, fb8b75d, 592689f, b8b45c0. Suite 248 -> 264. 42 commands live.

## Open threads
- FAQ error-lookup design, parked at section 3 (auto-detect watcher + failure
  behaviour). Sections 1 and 2 agreed: layered matcher, structured entries captured
  from Discord, corpus learns from its own misses.
- `STT_PROVIDER` unset on the VM, so meeting transcription runs on Whisper rather than
  Soniox — the likely cause of the Urdu/Hindi script flapping. One env line + restart,
  then a short comparison meeting.

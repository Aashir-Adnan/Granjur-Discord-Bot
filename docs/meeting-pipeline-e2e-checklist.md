# Meeting → Tasks Pipeline — Manual E2E Checklist

This feature has no automated integration test. Run this runbook end to end after
any change to the meeting pipeline, CSAAS meeting-workflow endpoints, or the review UI.

## 1. CSAAS side

- [ ] Deploy the `feat/meeting-workflow-assign` branch of the CSAAS backend.
- [ ] Set `STT_PROVIDER=soniox` and a valid `SONIOX_API_KEY` in the CSAAS env.
- [ ] Ensure a URDD exists with permissions `add_meetings`, `run_meeting_ai`,
      `update_meetings`, and `view_meetings` (the last is required by `/notes` and
      `/meeting`). Record its id: `__________` (this is the bot's `CSAAS_ACTOR_URDD`).
- [ ] Confirm the CSAAS API is reachable at the URL the bot will use
      (default `http://127.0.0.1:3000/api`).

## 2. Bot side

- [ ] Set the 5 env vars in `bot/.env`:
      `MEETING_PIPELINE_ENABLED=true`, `MEETING_REPORTS_DIR=bot/meeting-reports`,
      `MEETING_STAGE_TIMEOUT_MS=360000`, `CSAAS_API_URL=<url>`,
      `CSAAS_ACTOR_URDD=<urdd id from step 1>`.
- [ ] Run `npm run db:migrate` — confirm migrations `013_meeting_pipeline_job`,
      `014_task_external_meeting` and `015_task_externalid_unique` apply cleanly
      (`012_doc_pages` is already applied on the live DB).
- [ ] Start the bot; confirm the log line `[meetingPipeline] worker started (60s tick)`
      (not the "disabled" line).

## 3. Record a meeting

- [ ] Start a 2-person voice meeting via the existing recording flow.
- [ ] End the meeting.
- [ ] Confirm `.ogg` files were written for each participant.
- [ ] Confirm `MeetingRecording` rows exist and `MeetingRecordingStatus='completed'`.

## 4. Watch the pipeline job

- [ ] Poll `SELECT id,stage,status,lastError FROM meeting_pipeline_job;` and confirm the
      job walks: `created` → `transcribing` → `analyzing` → `generating_tasks` →
      `assigning` → `awaiting_review` (with `status='blocked'`).

## 5. Review UI

- [ ] Confirm the review message posts in the meeting's text channel.
- [ ] Check the notes section, the proposed task list, and the proposed assignees.

## 6. Approve

- [ ] Edit one task's assignee via the assignee select.
- [ ] Toggle "Push to GitHub" on exactly one task.
- [ ] Click "Approve all".

## 7. Verify results

- [ ] `SELECT * FROM task WHERE meetingId=<id>;` — rows created with populated
      `assigneeIds` and `externalId='csaas:...'`.
- [ ] Assignee ping messages posted in the channel.
- [ ] The GitHub-toggled task produced a `[Agent Call]` issue — check `externalIssueUrl`
      on that task row.
- [ ] Job ends `stage='done'`, `status='done'`.
- [ ] The review message was edited into the final summary embed (components removed).

## 8. Failure path

- [ ] Re-run with a fresh meeting; kill CSAAS mid-run.
- [ ] Watch `attempts` increment and `nextAttemptAt` back off across retries.
- [ ] After 6 attempts confirm `status='failed'` and a `⚠️ Meeting pipeline failed at …`
      alert posts in the channel.
- [ ] Run `/meeting-retry <meetingId>` — confirm the job resets
      (`status='pending'`, `attempts=0`, `lastError=null`) and resumes.

## 9. Docs

- [ ] `/docs` browses the synced UBS-Doc corpus (projects + sections) — no local clone
      is involved any more; see `.claude/knowledge/project-docs.md`.

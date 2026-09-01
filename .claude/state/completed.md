# Completed

Finished tasks, newest first. Format: `## YYYY-MM-DD — Title` + summary + files/commits.

---

## 2026-09-02 — Meeting → tasks integration with CSAAS (feature complete)
Full pipeline: a recorded Discord voice meeting is transcribed/analyzed by CSAAS,
turned into proposed tasks + assignees, reviewed by a human in Discord, then mirrored
into the bot's `task` table with optional per-task GitHub `[Agent Call]` issue push.
- **CSAAS side** (branch `feat/meeting-workflow-assign`): plaintext transport +
  `actionPerformerURDD` on MeetingWorkflow endpoints; `skip_github` on `/approve`;
  new `/assign` endpoint + `extractAssignments` agent + `meeting_task_assignees`
  table; `/issuesync` `task_ids` filter; `STT_PROVIDER=soniox`.
- **Bot side**: `csaasClient.js` (AES envelope + `isConfigured`); `meeting_pipeline_job`
  table (migration 012) + `meetingPipelineWorker.js` (`runTick` 60s loop, backoff,
  `MAX_ATTEMPTS`, stage timeout, `notifyFailure` channel alert); 10 stage runners in
  `meetingPipelineStages.js` (`created`→`transcribing`→`analyzing`→`generating_tasks`
  →`assigning`→`awaiting_review`→`approved`→`mirrored`→`issue_syncing`→`done`) +
  `resolveMeetingChannel`; roster build; review UI (`meetingReviewUI.js` builders +
  `applyReviewAction`, `commands/meetingReview.js` handlers + `/meeting-review`
  `/meeting-retry`); task mirroring + `externalId`/`meetingId` on `task` (migration
  013); ubs_doc clone mounted as a second `/docs` root via `UBS_DOC_PATH`.
- **Task 17 wrap-up**: real `notifyFailure` (best-effort channel alert on final
  failure, exported + injectable resolver, tested); `route()` fall-through now acks
  with an ephemeral "no longer active" reply; timeout race losing-path `.catch`ed to
  kill unhandledRejection; `bot/.env.example` consolidated; manual E2E runbook at
  `docs/meeting-pipeline-e2e-checklist.md`.
Files: `bot/src/services/{csaasClient,meetingPipelineWorker,meetingPipelineStages,
meetingReviewUI}.js`, `bot/src/commands/meetingReview.js`,
`bot/src/Database/meetingPipelineJob*.js`, `bot/src/Database/migrations/012,013`,
`bot/.env.example`, `docs/meeting-pipeline-e2e-checklist.md`,
`.claude/knowledge/csaas-meeting-workflow-integration.md`.

## 2026-08-31 — Fix: `/schedule` autocomplete ISO round-trip lost the `Z`
`parseWhen`'s ISO regex didn't allow fractional seconds, so `.000Z` fell through the
offset group and the timestamp was re-read as wall-clock in the guild zone — a
`toISOString()` value from autocomplete came back shifted by the zone offset ("in 5
minutes" → "5 hours ago" on Asia/Karachi). Fixed the regex (`(?:\.\d+)?` + trailing
`Z`/offset check). Also changed `schedule.autocomplete` to return the user's raw
phrase as the choice value (not an ISO snapshot), so `execute()` re-parses fresh at
submit time. Files: `bot/src/utils/parseWhen.js`, `bot/src/commands/schedule.js`.

## 2026-08-31 — Backlog sweep: playback controls, /setup timezone, /meetings, cleanup
- **Playback transport controls**: `/playback` now shows ⏪10s / ▶️⏸️ / ⏩10s / ⏹️
  buttons (`playback.handleControl`). Seek respawns ffmpeg with `-ss`; added
  **ffmpeg-static** dep (prism-media auto-detects it). Graceful degradation: without
  ffmpeg it plays from start with seek buttons disabled. State in `activePlayers` Map.
- **Timezone model** (`bot/src/utils/timezone.js`, zero-dep, Intl-based): `/schedule`
  now interprets + `/setup` configures `guildConfig.timezone` (per-guild only).
  `parseWhen` reworked to be zone-aware. Migration `010_guild_timezone.sql`.
- **`/setup`** command (new) — CEO/Server Manager; `timezone` option w/ autocomplete;
  no-arg shows current settings.
- **`/meetings`** command (new) — list your upcoming meetings, reschedule (modal) or
  cancel. Managers see everyone's. `db.scheduledMeeting.findUpcoming/findById`,
  `update()` extended (scheduledAt/topic/memberIds/cancelled). Migration
  `011_scheduled_meeting_cancelled.sql`.
- **Flood guard**: `findDueToStart` now bounded to `now-30min .. now` and skips
  cancelled; `findDueForReminder` / `findMany` / `count` skip cancelled.
- **Dead code**: deleted `bot/src/services/meetingAudioRecorder.js`; default
  `audioFormat` → `"ogg"`.
- **Nicknames**: `/create-task` member picker uses `displayName` + `@username`.
Files: `bot/src/commands/{playback,setup,meetings,schedule,create-task,index}.js`,
`bot/src/handlers/interactions.js`, `bot/src/index.js`, `bot/src/Database/index.js`,
`bot/src/Database/schema.sql`, `bot/src/Database/migrations/010,011`,
`bot/src/utils/{timezone,parseWhen,discordTime}.js`, `bot/src/config/command-config.json`,
`package.json`.

## 2026-08-31 — `/schedule` time UX overhaul (items 1-3, 6) + nickname picker
- **Discord timestamps everywhere** (`<t:UNIX:style>`, renders in viewer's own tz):
  new `bot/src/utils/discordTime.js`; updated schedule embeds, `meetingReminder.js`,
  `fetch-my.js`, `dashboard.js`.
- **NL time parser** `bot/src/utils/parseWhen.js` (zero-dep): "tomorrow 3pm",
  "next mon 14:00", "in 90 minutes", "in 1h30m", ISO, weekdays, month/day, bare times.
- **`when` autocomplete** previewing the resolved date; first autocomplete command in
  the repo — routing added in `bot/src/index.js` + `handleAutocomplete` in
  `bot/src/commands/index.js`.
- **Structured options**: `topic` + `when` both required; removed the button→modal
  path (`buildScheduleModal`/`handleScheduleModal`/`handleShowModalButton` and their
  routes in `interactions.js` / `index.js` noDefer lists).
- **Resolved-time echo** + past-time rejection in `execute`.
- **Nicknames**: member select now uses `member.displayName` + `@username`, sorted.
Files: `bot/src/commands/schedule.js`, `bot/src/utils/{parseWhen,discordTime}.js`,
`bot/src/{index.js,commands/index.js,handlers/interactions.js}`,
`bot/src/services/meetingReminder.js`, `bot/src/commands/{fetch-my,dashboard}.js`,
`.claude/knowledge/schedule-meetings.md`

## 2026-08-31 — Human-readable `/playback` menu labels
Meeting dropdown now shows `"<Meeting Name> — <formatted date>"` (name derived from
the recordings dir, date via `toLocaleString`), sorted newest first. Recording
dropdown shows `"<username> Recording"` (Discord displayName → email local-part → id).
Confirmation message updated to match.
Files: `bot/src/commands/playback.js`, `.claude/knowledge/meeting-audio-recording.md`

## 2026-08-31 — Set up `.claude/` memory scaffold
Added root `CLAUDE.md` wiring the knowledge/rules/skills/state system. Created
`.claude/knowledge/`, `.claude/rules/`, `.claude/skills/`, `.claude/state/`
(backlog/completed/session). Documented the meeting audio recording + playback
pipeline in `.claude/knowledge/meeting-audio-recording.md`.
Files: `CLAUDE.md`, `.claude/**`

# Completed

Finished tasks, newest first. Format: `## YYYY-MM-DD — Title` + summary + files/commits.

---

## 2026-09-05 — Ship `/explain`: Claude answers from a project's documentation

Live feature: `/explain project:<picker> question:<text>` answers questions about a project's 
documentation using Claude, running on the VM in a scope bounded by the project's first 
`docsPaths` entry. One-shot, no session. One live smoke test: Badar HMS question answered 
in 23 s with three references under `hms-documentation/`.

**Bot side** (`52c434e`): `/explain` command, modal picker per project, text truncation at 
4000 chars, reference limit 8, 120 s timeout. Dedicated `csaasClient.explain()` call via 
`POST /api/meeting/workflow/explain`. Embeds built by `explainRender.js`. Tests cover 
the command, rendering, and CSAAS integration.

**CSAAS side** (`1c44b62`): `POST /api/meeting/workflow/explain` endpoint wiring. 
`explainAgent.js` runs Claude (`claudeClient.chat`) with `--disallowedTools` (Write, Edit, 
Bash, WebFetch, etc.) in the docs directory scoped by project. `extraArgs` option on 
`claudeClient` (`1aa51e0`) gates tool access. Non-JSON from Claude is retried once, then 
returned raw. References drop entries with no path; answer trimmed at 4000. Tests: 
`explainAgent.test.js` (`896fd75`), `dc52778`.

**Scope fallback:** Footer reports `All documentation` when scoping did not happen — 
verify `Repos/UBS-Doc/docs/<project.docsPaths[0]>` exists on the VM if answers look 
too broad.

**Debugging:** `pm2 logs csaas | grep '\[explain\]'` shows scope, reference count, 
milliseconds per question.

**Deferred features** in `backlog.md`: code as a second source, thread/follow-up mode, 
multiple `docsPaths` per project.

**Final review and fix wave (same day).** The whole-branch review found one Critical: the
working directory is a default, not a jail — under `--dangerously-skip-permissions` the
CLI's `Read` accepts absolute paths, so a Verified member could have had `.env` posted into a
public embed. Fixed in CSAAS `3050103` / bot `8d55c35`: the explain call runs without that
flag (per-call `skipPermissions:false`) so a read outside the working directory is denied by
the CLI's own permission system; `--setting-sources user`; reference paths validated against
the docs root; `CLAUDE_BACKEND=cli` asserted; flags carried through both retry paths; 110 s
per-call CLI timeout and a one-in-flight guard; public error text made generic. Verified
live: the endpoint refused an injection probe with no leak, and a direct CLI run with the
endpoint's identity was denied `../init.md` — "requested permissions to read … but you
haven't granted it yet". Spec §3 corrected (`b2c0d27`). Bot `main` = `c50823c`, 174 tests;
CSAAS `main` = `3050103`, 39 tests. `/explain` registered as the 41st command.

## 2026-09-04 — Ship to production: task ticket channels, both repos on main
The meeting pipeline now notifies people the way `/create-task` always has, and both
sides of it are on `main` and deployed.

**Task notification (`05bfc78`).** A mirrored meeting task used to get one ping in the
review channel — which for a `/record` meeting with no dedicated meeting text channel
lands in the voice channel's own chat, where nobody looks. Now each assigned task gets
its own private channel under the Features category, visible to the assignee and the
approver, opened with an embed that mentions them, plus a best-effort DM pointing at
it. The task row is repointed at its own channel so `/close-feature` and `/update-task`
resolve there; the review-channel summary links each one. New
`bot/src/services/taskTicketChannel.js` (`createTaskTicketChannel`, `dmTaskAssignees`);
`mirroredStage` carries a prior `taskChannelId` forward so a retry after a partial
mirror never makes a second channel or re-DMs; `/meeting-review` approve now records
`dataJson.approvedBy` — the assigner's role. Five new tests, suite at 122.

**Bot repo:** `design/meeting-to-tasks-integration` fast-forwarded onto `main` and
pushed (`45aaf64..05bfc78`, 39 commits). VM pulled, migrations 013–015 already applied,
40 commands re-registered, `granjur-bot` restarted and logging
`[meetingPipeline] worker started (60s tick)`.

**CSAAS repo:** the five local VM commits are now on CSAAS `main` as one clean commit
(`263f861`). The originals had swept up server-runtime churn — 17 migration files the
boot process had moved to `data/migrations_completed/`, and a regenerated `schema.sql`
— so the push was rebuilt from a source-only diff in a temp clone, restoring
`data/migrations/20260901_meeting_task_assignees.sql` that the churn commit had
deleted. Safe because `runMigrationsOnStart.js` keys off a `schema_migrations` ledger
table, not file presence. Deploy ran; VM CSAAS is at `263f861`, 0 ahead, and
`/meeting/workflow/{assign,approve,issuesync}` all reach their handlers.

**Production env:** `MEETING_PIPELINE_ENABLED=true`, `CSAAS_API_URL=http://127.0.0.1:3000/api`
(CSAAS is on the same VM — no tunnel in production), `CSAAS_ACTOR_URDD=6` added to
`~/Granjur-Discord-Bot/.env`. Local bot instance and the SSH tunnel both shut down.


## 2026-09-04 — Meeting → tasks pipeline: first successful end-to-end run
A two-person voice meeting became a task row in the bot database, through all ten
stages: `created → transcribing → analyzing → generating_tasks → assigning →
awaiting_review → approved → mirrored → issue_syncing → done`. CSAAS meeting 5,
Soniox transcription of two per-speaker files, one task correctly identifying a
tenant-reactivation URDD bug with four source files named; bot task `8cac25ab…`
(`type=feature`, `externalId=csaas:1`).

Setup: CSAAS on the VM reached over an SSH tunnel, `CSAAS_ACTOR_URDD=6`, bot run
locally with production `granjur-bot` stopped. Four CSAAS commits cherry-picked onto
the VM's `main` (`/assign`, `skip_github`, `task_ids`, plus an `/issuesync`
`requestMethod` fix) — **local commits only, erased by the next push to CSAAS main**.

Eight bugs found and fixed, none reachable by unit tests:
1. `LIMIT ?` / `INTERVAL ? SECOND` cannot be bound under prepared statements — broke
   the first tick (`fe4db8d`).
2. `nextAttemptAt` written on the Node clock but compared against MySQL's `NOW(3)`,
   putting every retry five hours out (`87642e9`).
3. `/record` was never registered in the command index, and used a start path that
   never enqueued the pipeline (`77626a2`).
4. Connection pool had no keepalive against the remote database (`baed8c3`).
5. `/meeting-retry` refused `pending` jobs — exactly the state it is needed for
   (`30ab9f8`).
6. `awaiting_review` advanced the stage while blocking, so the job sat at stage
   `approved` with nobody having approved — which killed the assignee dropdown, the
   GitHub toggle, the per-task reject and `/meeting-review` (`da35317`).
7. **`task` INSERT/UPDATE referenced `` `Task` ``**, which does not exist on a
   case-sensitive server — task writes had never worked here, affecting
   `/create-task`, `/bug` and `/feature` too (`099179d`).
8. The final summary was edited into the meeting's channel rather than the one the
   review was re-posted to, so it silently never appeared (`c3f42e4`).

Not yet exercised: assignment (the task mirrored unassigned), the assignee ping, and
the GitHub `[Agent Call]` push. See `backlog.md`.

## 2026-09-03 — Project documentation: sync UBS-Doc into MySQL and browse it from Discord
Phase 1 (read-only) of `docs/superpowers/specs/2026-09-03-project-docs-preview-design.md`,
executed from `docs/superpowers/plans/2026-09-03-project-docs-preview.md` on branch
`feat/project-docs` (21 commits, not merged).

- **Sync service** `bot/src/services/docsSync.js` — every 15 min, one API call for the head
  SHA; on change, one tree call, then only changed blobs from raw.githubusercontent. Records
  the head SHA only when the mirror is provably complete (a truncated tree, an empty document
  list, or any per-file failure each suppress both the delete pass and the SHA write).
  Re-attribution runs every cycle, including the short-circuit one.
- **Storage** migration `012_doc_pages.sql`: `docpage` + `docsource`, plus `project.docsSlug`
  and `project.docsPaths`. Applied to production; 173 pages synced, 138 attributed to Badar HMS.
- **`/docs` rebuilt** — browse projects and sections, walk the tree, read a page in paged
  embeds with a link to the live site, and an autocompleted `query` option backed by FULLTEXT.
  Replaces the old browser over six unrelated files in `bot/docs/`.
- **`/projects` added** — create a project (name, docs slug, extra doc paths), link a repo.
  Closes the gap that no command created projects and `/repos` silently discarded the project
  name its own modal collected.
- **`/edit-docs` repointed** at `docpage` (it read a table with 0 rows), writing `source='local'`
  pages that the sync can never overwrite or delete. Also fixed a pre-existing bug where
  `edit_docs_select` was deferred before `showModal`, which had broken the command outright.
- **`#documentation` channel** rebuilt on the same data.
- **First test suite in this repo**: `node:test`, `npm test`, 54 tests in `bot/test/`.

Verified against the live corpus: all 173 documents render (674 embed pages, longest 3800 of
4096, zero unbalanced code fences), and walking all 102 levels of the browse tree reaches every
document exactly once with no level over Discord's 25-option cap.

Files: `bot/src/services/docsSync.js`, `bot/src/utils/{docPath,docRender,docTree}.js`,
`bot/src/commands/{docs,projects,edit-docs,repos,setup,doc-channel}.js`,
`bot/src/services/docTraversal.js`, `bot/src/Database/{index.js,schema.sql}`,
`bot/src/Database/migrations/012_doc_pages.sql`, `bot/src/{index.js,handlers/interactions.js}`,
`bot/src/config/command-config.json`, `bot/test/*`, `package.json`.

## 2026-09-02 — Environment setup verified; migrations 010/011 confirmed live
Fresh `npm install` (73 pkgs, exit 0) on Node v24.15.0. `ffmpeg-static` binary
downloaded without needing `npm approve-scripts` (82 MB, ffmpeg 6.1.1); `prism-media`
resolves it and `libsodium-wrappers` initialises. Connected to the remote MySQL
(20.120.228.55/granjur, 8.0.46): `schema_migrations` lists all 11 migrations and both
`guildconfig.timezone` and `scheduledmeeting.cancelled` exist — backlog items
"verify migrations 010+011" and "ffmpeg-static approve-scripts" are closed.
All 36 slash commands build; 72/87 modules import cleanly (the 15 failures are dead
vendored `Database/*` files, now a backlog item). No code changes.

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

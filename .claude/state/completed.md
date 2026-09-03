# Completed

Finished tasks, newest first. Format: `## YYYY-MM-DD — Title` + summary + files/commits.

---

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

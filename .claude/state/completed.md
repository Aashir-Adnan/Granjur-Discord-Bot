# Completed

Finished tasks, newest first. Format: `## YYYY-MM-DD — Title` + summary + files/commits.



## 2026-09-24 — /request-task: support tasks as a third kind (MERGED, PUSHED)

Client-requested segmentation. `type='task'` with both flags off; `task-` channel prefix, `Task:`
topic, own fields (platform, semester, needed_by, scope, reason), icon and title; gate list and
its pinning test updated. `ec3c9e9`, merged `16b5528`; 1108 tests.

## 2026-09-24 — Client Manager project role (MERGED, PUSHED)

`projectmember.role='client_manager'`: a client who is in every request channel on their project
(from creation, and existing ones on add; closed on remove/demotion), is DMed with the leads on a
new request, and sees the team's requests in `/my-requests`/`/request-report` with who raised each.
Never the project role; never a team task's channel (`requestedBy` null). Both client roles in
`utils/clientRoles.js`. `edafbcf`, merged `62669e9`; 1104 tests.

## 2026-09-24 — Casual chat channel per project, open to its clients (MERGED, PUSHED)

`<slug>-casual-chat` is the thirteenth section channel and the third entry in
`CLIENT_SECTION_KEYS`, so every client-access path (per-client overwrites, `/project-members`
grant/revoke, `/project-setup` repair) covers it with no other change. `fe0779d`, merged
`fe8979d`. **Process slip:** that merge was pushed with 8 count assertions red — the verify step
grepped the summary line, which exits 0 regardless — fixed in `0a3b992`; every verify step now
gates on `fail 0` explicitly. 1092 tests.

## 2026-09-24 — Structured fields + screenshots on client requests (MERGED, PUSHED)

Follow-up `de1a102` (merged `2f85053`): optional `semester` text field on both commands, first
header line beside the platform.

Owner asked for the fields a developer always goes back for. `/report-issue` gains platform, os,
app_version, severity, frequency, when, account, steps, expected; `/request-feature` gains
platform, priority, needed_by, problem, who, example — all optional, composed by
`composeDetails()` into a header above the free text (one table per command drives builder,
reader and composer). Attachments are now `screenshot`, `screenshot2`, `document`. A description
over the embed's 1000-character cut is also posted in full below it. 1092 tests.

## 2026-09-24 — Clients could see #time-reports: the public-channel deny is now derived (MERGED, PUSHED)

Owner found the first client could see `#time-reports`. Root cause: `denyClientOnPublicChannels`
named three `/init` targets, while what makes a channel visible to a client is any `@everyone`
ViewChannel allow — the daily report's channel, the onboarding category and the `cmd-*` command
channels all have one. Fixed by deriving the target set from `everyoneCanView(guild, channel)`
(channel overwrite decides, else the guild `@everyone` role), skipping the support pair by id;
`#time-reports` also carries the Client deny from creation and repairs it on the per-process
reconcile. Closes parked Rulings 17/18 territory. `d42292a`, merged `de5c893`; 1085 tests.

## 2026-09-24 — Client manual pinned in every project support channel (MERGED, PUSHED, DEPLOYED)

Owner follow-up after the acceptance-test instructions. `applyProjectSection` step 3a pins the same
manual embed `#support` carries in each project's `<slug>-support` channel via the now-exported
`ensureManualPinned` (presence-only by title and author); the manual gains "you can post more
documents or screenshots in that request's channel at any time". `cb6e2e3`, merged `3b3c130`.
1082 tests.

## 2026-09-24 — Client role in the Discord bot (MERGED to main as 4297b2e, PUSHED, DEPLOYED)

A `Client` role: clients enter by invitation, are approved without ever receiving `Verified`,
see only a global `🛟 Support` pair plus a per-project support pair, raise issues and feature
requests that become ordinary tasks they can follow, and are shut out of every other command by
a deny-by-default gate. Spec `docs/superpowers/specs/2026-09-24-client-role-design.md`, plan
`docs/superpowers/plans/2026-09-24-client-role.md`, nine tasks via subagent-driven development
plus one whole-branch review fix wave. Knowledge: `.claude/knowledge/client-role.md` (new) and
`project-sections.md` (ten → twelve channels).

- **Isolation rule.** `cfg.verifiedRoleId` is added in exactly one place — the staff branch of
  `services/approval.js` `approveMember` — which `/approve` and `/backlog` both use. A client
  never receives `Verified`; the deny-by-default gate in `config/commands.js` (`canUseCommand`,
  `autocompleteAllowed`, `memberIsClient` by stored id then name) closes every command and every
  autocomplete outside `clientCommands`. `guildmember.kind` is what the bot's own reports read.
- **Entry.** `/invite client:true` → `pendinginvite.kind` → member join copies it → `/verify`
  accepts the invited address through `utils/clientEmail.js` (own row, or an unclaimed client
  invite it then claims). `handleOtpModal` gained `getConfig` and `notify` seams.
- **Support pair.** `services/clientAccess.js` `ensureSupportChannels`: id-first, name fallback
  only with no id stored, presence-only overwrite repair, the manual (`services/clientManual.js`)
  pinned once by title+author, and `denyClientOnPublicChannels` for the three `@everyone`-visible
  places `/init` makes (onboarding channel, `📜 Rules`, `#announcements-all`). Runs on `/init`,
  `/setup` and the first client approval.
- **Project level.** `SECTIONS` is twelve; `CLIENT_SECTION_KEYS` get one member overwrite per
  `projectmember.role='client'` row, observed/planned/applied by `projectSection.js`
  (`clientIds: null` = roster not read = plan nothing; `revokeClients` false on a truncated or
  unreadable roster). `staffOnly` at the one line in `project-setup.js` that feeds
  `syncProjectRoleMembers` is the guard against a client holding the project role;
  `/project-members add role:client` revokes the role unconditionally.
- **Requests.** `services/clientRequest.js` + `commands/client-request.js` (`/report-issue`,
  `/request-feature`): a `task` row with `requestedBy`, the existing private task channel with the
  client in it, attachments re-uploaded (CDN links expire), notice to the project's support
  channel + lead DMs or `#admin`, never the global pair. `commands/client-tracking.js`
  (`/my-requests`, `/request-report`) with `utils/clientRequestView.js`; `pending` reads
  "Waiting on you". `notifyTaskUpdate` DMs the requester on status changes and keeps estimates,
  blocker warnings and unblock notices out of a `requestedBy` channel.
- **Exclusions.** Daily time report skips `kind='client'`; `/cleanup` protects the support pair by
  id (and `🛟 Support` by name); `/time-report` needed nothing (entry-driven).

Migration `025_client_role.sql`. 19 commits `4683821..285f0bc`, merged as `4297b2e`, pushed and deployed (deploy run green); 1079 tests green with
`DATABASE_URL=poisoned://no-production-access`. Every ruling made during the build is in the
final session message and, where it left work, in `backlog.md`.

## 2026-09-23 — Project Stats tab, and the Time tab under the shared filters (SHIPPED)

Spec `docs/superpowers/specs/2026-09-23-project-stats-and-time-filters-design.md`, plan
`docs/superpowers/plans/2026-09-23-project-stats-and-time-filters.md`, 8 tasks via
subagent-driven development — every task reviewed, 1–2 fix rounds each, a final
whole-branch review clean after one fix wave.

- **CSAAS** branch `feat/project-stats`, 6 commits `2e8d503..28a6830`: `b2f6a30`
  refactor `timeScope.js` extraction; `e04c3fa` project filter on report/entries;
  `1c850da` stats endpoint; `cf776e6` DB-local day bucketing for completions; `4c6c22e`
  stale sort/cap tests; `28a6830` guild-scoped project clause + stale header. Files:
  `Src/Apis/ProjectSpecificApis/DiscordTasks/{timeScope.js,discordProjectStats.js,
  discordTimeReport.js,discordTimeEntries.js}`, tests under
  `Services/SysScripts/TestScripts/discord-tasks-test/{timeScope,stats,time,entries}.test.js`.
  All 8 discord-tasks-test scripts pass.
- **UBS-Doc** branch `feat/project-stats`, 11 commits `ecfc40f..00ae80c`: `d047086` route
  + API client; `168538a` apiCall helper; `4d8dc73` statsLogic; `8cb5e31` stackByMember
  guard; `d005321` Time tab under shared filters; `947511e` personId guard before scope
  known; `ffb6aa1` chart components; `59a3ad1` chart fixes (pointer-events, keys,
  chartChrome, contrast, a11y, format); `f365ad5` Stats tab; `7cd7194` fetch dedupe +
  ring; `00ae80c` tasks-error banner, estimate tile hidden under self scope,
  label/comment fixes. Files: `src/components/discordTasks/api.ts`,
  `src/screens/team/{teamNav.ts,statsLogic.ts,TeamLayout.tsx,TimeTab.tsx,Stats.tsx}`,
  `src/screens/team/charts/{axes.ts,chartChrome.tsx,Sparkline.tsx,Bars.tsx,
  StackedBars.tsx,CumulativeLines.tsx}`, `src/app/routes.tsx`, tests
  `statsLogic.test.ts`, `teamNav.test.ts`. `tsc` clean, 304 vitest tests pass. The
  working tree also carries unrelated uncommitted changes from other work
  (`src/components/meetingWorkflow/LiveTranscribeStage.jsx`,
  `src/styles/portal-compat.css`, `audioCapture*.js`) that were deliberately left
  untouched.

**Status: SHIPPED.** Merged `--no-ff` into `main` (CSAAS `9f779d0`, UBS-Doc `c2ad4a4`),
suites green on the merged result (9/9 scripts; `tsc` clean + 304 tests), branches deleted,
then pushed CSAAS first and the site second (spec §10). Verified: the CSAAS "Deploy to Azure"
run 35832910941 succeeded (the API returned 502 for ~30s during the pm2 restart, then
`/api/discord/projects/stats` answered with the token validator's 401 — the object resolves);
Vercel marked `c2ad4a4` a successful Production deployment. A manual browser walkthrough of
the Time and Stats tabs was NOT performed (the devtools tooling could not attach to the
owner's running Chrome); see `session.md` for what a walkthrough should check.

## 2026-09-23 — #time-reports was visible to everyone and readable by nobody (PUSHED)

The first daily report posted, and members got "You do not have permission to view the message
history of #time-reports" instead of it. Cause: `dailyTimeReport.js` created the channel with
`allow: [ViewChannel]` only. This guild's @everyone role does not carry ReadMessageHistory at
the role level, so a channel has to grant it explicitly — which is why every other public
channel this bot creates pairs the two bits (`init.js:125`, `meetingAutoChannel.js`,
`create-channel.js`). ViewChannel alone buys a sidebar entry and an empty room.

Two changes, because fixing the create path does nothing for a channel that already exists:

- The create overwrite now allows `ViewChannel` **and** `ReadMessageHistory` (SendMessages
  still denied — it is a read-only report channel by design).
- `reconcileChannelAccess` repairs an already-configured channel, once per process, guarded by
  a `reconciledThisRun` WeakMap keyed on `db` like the other guards in the file. It runs
  **before** the due-day checks, not inside `resolveChannel`: today's report was already sent
  and the day already closed, so a repair on the post path would not have run until 23:59 the
  next day. It only edits when @everyone is actually missing a bit, and only once per process,
  so an admin who deliberately locks the channel down later is not overridden every 60s. A
  failed edit (missing ManageRoles) warns and still posts.

Files: `bot/src/services/dailyTimeReport.js`, `bot/src/services/dailyTimeReport.test.js`
(+4 tests: the create overwrite's two bits, the repair, the repair on an already-posted day,
the already-readable no-op, and a failed repair that still posts). 1006 tests pass.
Commit `95fa9d4`, pushed to main (deploy pipeline restarts pm2, which triggers the repair).

## 2026-09-23 — UBS-Doc: copy a task's link, and a theme toggle on the sign-in screen (MERGED, NOT PUSHED)

Two small site-only features, brainstormed as bounded changes (no spec, no plan document).

- **Copy task link.** `screens/team/CopyLinkButton.tsx` plus `taskUrl(origin, taskId)` in
  `detailLogic.ts`, wired into the task detail header and the preview popover's action row, so a
  link can be grabbed from the board without opening the task. The link is built from the id
  alone: the internal `<Link>`s carry the board's current filter string, and pasting that into
  chat would drop the reader into your view rather than on the task. Guards
  `navigator.clipboard` before use — outside a secure context the property is undefined and
  `.writeText` throws synchronously, which the APIBuilder precedent it otherwise follows would
  turn into a blank page.
- **Sign-in theme toggle.** The screen was pinned dark deliberately (notes at `SignIn.tsx:6` and
  above `.portal-google-btn` in `portal-compat.css` both said so); the owner asked for the
  toggle, overriding that. The sidebar's Light/Dark pill moved into a shared
  `components/ThemeSwitch.tsx` rather than being copied. Light values are AppLayout's own —
  `#04070F` under a `rgba(250,248,255,0.88)` overlay, shader at 0.18, `card-light` — so the two
  backgrounds cannot drift. Two colours needed their own treatment: the Google button keeps its
  white fill in both themes but loses its white border against a pale card, and the
  `@granjur.com` accent washes out at indigo-400.

**Verification.** 284 tests and `tsc` clean on merged `main`. Both themes checked in a headless
browser. A capture artifact worth remembering: the aurora heading renders blank in a headless
screenshot because its blur-in reveal never fires — forcing `prefers-reduced-motion`, which
`design.css:658` maps to `opacity: 1`, is what proves the text is actually there. Not visually
verified: the sidebar pill after the extraction, and the copy button itself, both of which sit
behind the sign-in gate.

**Commits (UBS-Doc):** `a3c70c3`, `b393c34`, merged as `38ef723` and `81f8133`. `main` is 4
ahead of `origin/main` — not pushed, not deployed.

## 2026-09-22 — Time reporting follow-ups: CSV export, Time-tab person filter, daily 23:59 report (MERGED AND DEPLOYED)

Three follow-ups on the same day's task time tracking. Spec
`docs/superpowers/specs/2026-09-22-time-reporting-followups-design.md`, plan
`docs/superpowers/plans/2026-09-22-time-reporting-followups.md`, 6 tasks via subagent-driven
development.

- **Daily report (bot).** `services/dailyTimeReport.js` posts each day's per-person totals at
  23:59 in the guild's own timezone to `#time-reports` (auto-created, `@everyone` may read but
  not send). Every approved member is listed, zeros included; the embed discloses that timers
  still running at the cutoff are not counted. Migration 024 adds
  `guildconfig.timeReportChannelId` and `lastTimeReportOn` — the "already posted" guard is a
  persisted column, not an in-memory Map, so a restart near midnight cannot double-post. The
  first pass after deploy adopts the current day silently. A long outage posts once, for the most
  recent due day only, never a backlog.
- **Entries endpoint (CSAAS).** `GET /api/discord/time/entries?discordId=&since=&until=` returns
  ONE person's individual entries — single-person by construction, so "the export is never mixed"
  is an API property, not a UI convention. Self always allowed; anyone else needs
  `view_discord_time`, else 403 (it refuses rather than narrowing, unlike the aggregate report).
- **Site.** The Team → Time tab gains a person filter (options restricted to the caller when the
  report is self-scoped) and a Download CSV button generating the file in the browser from the
  entries already on screen. Per-task breakdown per person.
- **Security fix in shared middleware.** `actorBinding.js` now deletes client-supplied
  `__identityVerified`/`actor_email` before deriving them. `config.js` merges the request body
  wholesale into the auth payload, and the middleware previously only ever *set* those fields —
  so a valid token whose user had no email row could forge them and read another employee's
  hours through the new endpoint's self-path. Pre-existing gap, newly exploitable; the fix also
  makes a `bindActorToToken` misconfiguration fail closed instead of open.

Merges: bot `9dcac65` (1002 tests), CSAAS `b192294` (7 test scripts), site `a09410e` (281 tests,
tsc clean). All pushed and deployed 2026-09-22; migration 024 verified applied in production.
---

## 2026-09-22 — Task time tracking: clock in/out against a task, /log-time, /my-time, /time-report, estimates (MERGED AND DEPLOYED)

Replaces the dead-end shift clock (`/clock-in`/`/clock-out` wrote `clockentry` rows nothing ever
read — and its clock-out was broken by a `ClockEntry` table-name casing bug, so production held
exactly one row, never closed). People now clock against a specific task or general work, correct
their own entries after the fact, and leadership can see where the hours went. Estimates live on
the task and are compared against all-time logged minutes.

- **Data:** migration 023 adds `clockentry.taskId/minutes/note/source/remindedAt`,
  `task.estimateMinutes`, `guildconfig.clockReminderHours/clockCapHours`, two indexes, and
  backfills pre-existing rows (closed rows get real durations; the one legacy open row was closed
  at `minutes = 0, source = 'legacy'` rather than a fabricated 12h — verified in production).
- **Commands:** `/clock-in` (task or General), `/clock-out`, `/log-time` (retroactive, overlap
  warning), `/my-time` (own entries, edit/delete panel; leadership may pass `person:`),
  `/time-report` (leadership only, gated autocomplete). 43 → 46 commands.
- **Watcher:** `clockWatch.js` DMs at 6h and caps a runaway timer at 12h (both per-guild
  configurable via the database), removes the clocked-in role, re-reads before closing so a real
  `/clock-out` racing a pass is never overwritten.
- **No maximum on a single entry** (owner's explicit call) — the only refusal is the INT column's
  storage ceiling, enforced at all four write paths.
- **CSAAS:** `timeLogged`/`estimateMinutes`/`timeByPerson` on every task in the tasks read;
  new `GET /api/discord/time/report` (self-scoped without `view_discord_time`, team-wide with it);
  permission migration `20260922_1_view_discord_time_permission.sql` (Platform Admin + Admin),
  applied automatically by `runMigrationsOnStart.js`.
- **Site:** Time section on the task page (estimate bar, per-person breakdown), duration chips on
  list rows / board cards / the preview popover, and a new Team → Time tab with a week picker.

Spec `docs/superpowers/specs/2026-09-22-task-time-tracking-design.md`, plan
`docs/superpowers/plans/2026-09-22-task-time-tracking.md`. 13 tasks via subagent-driven
development, each task-reviewed, then one whole-branch final review per repo (each found real
defects — see backlog for what was deliberately deferred).

Merges: bot `8d52bb1` (f0609f8..c5af897, 974 tests), CSAAS `b0791b3` (2bbb225..38640d5),
site `db5d434` (bcc5048..ce21dd3, 270 tests). All three pushed and deployed 2026-09-22.
---

## 2026-09-21 — Task hierarchy: subtasks, no finishing over open ones, auto-done parent (built on branches, NOT YET MERGED)

A task can have up to 25 subtasks (one level). A task with an open subtask cannot be finished
(refused in the shared update path; 409 to the site); finishing the last subtask completes the
parent automatically, reopening one reopens a finished parent. Subtasks have no Discord channel
(news goes to the parent's). Discord: Subtasks checklist + Add subtask in the task hub. Site:
checklist in task detail (clickable with the update permission), nested list, "3/5" chips.
Migration 022 (`task.parentTaskId`). Bot `feat/task-hierarchy` (b5e936e, a3c690e; 761 tests) ·
CSAAS `feat/task-hierarchy` (01c6d88) · UBS-Doc `feat/task-hierarchy-ui` (6fa887c; 254 tests).
Deploy order bot → CSAAS → site. See `knowledge/project-tasks-site.md`.

---

## 2026-09-20 — /update-task Find panel + Edit modal, task activity log, creator/updater cards (built on branches, NOT YET MERGED)

`/update-task` with no task opens a Find panel (project, person, paged task list) then an Edit
modal; the buried filter options are gone. Every task update is recorded (`taskactivity`,
migration 021) and the site shows Created by / Last updated by as user cards plus a History list.
Bot `feat/update-task-panel-and-activity` (b82e6c0, c1a6881; 690 tests) · CSAAS `feat/task-activity`
(e907682) · UBS-Doc `feat/task-activity-ui` (2d0042d; 240 tests). Deploy order bot → CSAAS → site.

---

## 2026-09-20 — /update-task filters fixed, Discord avatars and scope badges on the Team site (built on branches, NOT YET MERGED)

`/update-task` `filter_assignee` never filtered (autocomplete `getUser()` is null); fixed, and
the task picker now also searches/labels by project and scope. Member Discord avatars are
stored (`guildmember.avatarUrl`, migration 020), passed through CSAAS, and drawn on the Team
site (task list, board, detail, People). Board cards ~1.5x, scope badge on every card, info
preview popover, filter dropdown arrows fixed.
Bot `feat/update-task-search-and-avatars` (3332e3b, 5dba05d; 650 tests) · CSAAS
`feat/discord-avatars` (c357808) · UBS-Doc `feat/team-avatars-board` (e9382ef; 223 tests).
Deploy order bot → CSAAS → site. See `knowledge/project-tasks-site.md`.

---

## 2026-09-18 — Per-project Discord sections, project-aware meetings, readable task channels (built and reviewed on branch `feat/project-sections`, NOT YET MERGED)

Every project gets its own Discord category (ten channels: members, docs, meetings
+ voice, frontend/backend/database chat + voice) with task channels living inside
it, named after the task instead of six hex characters. Membership is gated by one
role per project, adopted from an existing same-named role only when doing so is
demonstrably safe (no holders, or explicit `adopt_role:true`), fail-closed
otherwise. `/meeting-channel` and `/project-members` infer the project from the
channel they're run in. Built with subagent-driven development across 10 tasks
plus a two-part final fix wave (spec
`docs/superpowers/specs/2026-09-18-project-sections-design.md` — now out of date in
§5/§13, see `.claude/knowledge/project-sections.md`; ledger
`.superpowers/sdd/2026-09-18-project-sections/progress.md`).

- Branch `feat/project-sections`, commit range `7e78f9f..7f40a42` (21 commits),
  suite 340 → 615, every run with `DATABASE_URL=poisoned://no-production-access`.
- Migration `019_project_discord_sections.sql` adds `project.discordCategoryId`,
  `discordRoleId`, `discordChannels` (JSON), `scheduledmeeting.projectId`.
  Migration `020_meeting_project.sql` was written then **dropped** — `020` at
  commit `fa0db35`, deleted at `1ae5dcf` — as a no-op: `meeting.projectId` was
  already in `schema.sql` since the initial commit.
- New: `bot/src/services/projectSection.js` (planner + applier + role sync),
  `bot/src/services/projectMembersPanel.js`, `bot/src/utils/taskChannelName.js`,
  `bot/src/commands/project-setup.js`.
- Changed: `/projects` (section on add), `/project-members` (project inference,
  per-member grant/revoke), `/meeting-channel` (project option + inference, safe
  overwrites inside a project), `/create-task`/`taskTicketChannel.js` (project
  channels), `/create-project-categories` (wraps the new path, lost
  `create_roles`), `/create-project-role` (runs the whole per-project routine),
  `/cleanup` (protects a project's section by id, not just by name).
- A whole-branch review found a MUST-FIX role-adoption Critical (F1) after Task 10;
  a two-part final fix wave (parts A and B) closed it plus 11 other findings —
  see `.claude/knowledge/project-sections.md` for the role model as it actually
  shipped, which is stricter than the spec.
- Not merged. Not deployed. Remaining work, deploy notes, and live-verification
  checklist: `.claude/state/session.md` and `.claude/state/backlog.md` ("Per-project
  sections — follow-ups").

## 2026-09-18 — Team section: people, task detail, dependency graph, kanban board (merged and deployed 2026-09-18)

Turns the read-only `/tools/tasks` page into a four-view Team section, and adds the
site's first *write* back into Discord data: dragging a board card changes the task's
status through the bot, via CSAAS, using the same helper and warnings/notices
`/update-task` already produces. Built with subagent-driven development across 11 tasks
(spec `docs/superpowers/specs/2026-09-18-team-board-previews-design.md`, plan
`docs/superpowers/plans/2026-09-18-team-board-previews.md`, ledger
`.superpowers/sdd/2026-09-18-team-board-previews/progress.md`).

- **Bot** (`Granjur-Discord-Bot`, `feat/team-board`, suite 320 → 340): `0e116e4` —
  migration 018 `guildmember.roleNames`, name sync stores role names,
  `db.guildConfig.findById`. `21e4f9a` — `bot/src/services/taskStatusChange.js`
  (`applyTaskUpdate`, shared by `/update-task` and the new route), `TASK_STATUSES`
  exported from `taskDeps.js`, notifier gains `actorLabel`. `f6528f1` — `POST
  /internal/tasks/status` on the bot's port-4070 HTTP server, guarded by
  `x-internal-secret` / `BOT_INTERNAL_SECRET`, disabled with 503 until the env is set.
  `7045f99` — fix so a bad/`null` JSON body never hangs the route instead of erroring.
- **CSAAS** (`CSAAS_Backend`, `feat/discord-tasks-status`): `c7762b0`, `30931eb` — read
  endpoint gains task detail fields and a top-level `members` list, scoped per guild.
  `534b793`, `481d6c1` — `POST /api/discord/tasks/status` → `DiscordTasksStatus_object`,
  token + actor binding + `requirePortalPermission('update_discord_tasks')`, loopback
  call to the bot, audit label only from a verified identity; migration
  `data/migrations/20260918_1_update_discord_tasks_permission.sql` seeds the permission
  into the Dev and Admin groups and backfills existing users; `sample_env` gained
  `DISCORD_BOT_URL`/`DISCORD_BOT_SECRET`.
- **UBS-Doc** (`UBS-Doc`, `feat/team-section`, vitest 123 → 194): `5149d8a` — pure logic
  (`boardLogic`, `graphLayout`, `teamLogic`, `redirect`, `setTaskStatus` with
  `ApiError`). `a7a1a18` — Team layout, tabs, `/tools/tasks` redirect, nav. `72fa833` —
  People, TaskDetail. `b74888d`, `d886ab9` — Board with drag-to-status, toasts, override
  lifecycle. `e6edc8f`, `0fadfd4` — dependency graph.

Every task passed its own review round (several needed one fix round: bot Task 3's
null-body hang, CSAAS Task 4's guild-scoping and Task 5's actor-binding fixes, site
Task 9's override-clearing race, Task 10's graph accessibility). No Critical findings
survived to the end of any lane.

Knowledge: `.claude/knowledge/project-tasks-site.md` ("Team section and the write path").

**Not merged, not deployed.** Remaining before it can go live: a final whole-branch
review across all three repos, then deploy in order bot → CSAAS → site, hand-setting
`BOT_INTERNAL_SECRET` after the bot deploy and `DISCORD_BOT_URL`/`DISCORD_BOT_SECRET`
after the CSAAS deploy, then live verification (board drag, Discord channel post,
blocked-card toast, unblock notice). See `session.md`.

## 2026-09-17 — Project tasks on the UBS-Doc site (merged and deployed 2026-09-17)

Every task from the bot's database, grouped by project, with multiple assignees,
blocking dependencies, and explicit + inferred project members, shown live at
`/tools/tasks` on the UBS-Doc site. Built with subagent-driven development across 10
tasks (spec + plan in `docs/superpowers/specs/2026-09-17-project-tasks-site-section-design.md`
/ `docs/superpowers/plans/2026-09-17-project-tasks-site-section.md`); bot suite
264 -> 318, 43 slash commands.

Merged to `main` and deployed in order bot -> CSAAS -> site:
- **Bot** (`Granjur-Discord-Bot`, `feat/project-tasks-site`): `15206fd`, `f94c756`
  (migration 017 — `taskdependency`, `projectmember`, `guildmember` name columns; DB
  surface), `e2c98de` (`bot/src/utils/taskDeps.js` — cycle/blocker rules), `c56580c`,
  `d79c023` (member name sync), `3373316` (`/create-task` assignee picker), `b248442`,
  `a89967d` (`/update-task` dependency + assignee options), `7947aec` (notifier
  warnings/unblock notices), `a3cc416` (`/project-members`), `04dfd07` (final-review
  fixes: `set -e` in the deploy workflow, dependencies field cap). Main at `9161c7b`.
- **CSAAS** (`CSAAS_Backend`, `feat/discord-tasks-endpoint`): `ab985c2`, `a6fbb12` —
  `GET /api/discord/tasks`, public, reads `granjur.*` cross-database.
- **UBS-Doc** (`UBS-Doc`, `feat/tasks-screen`): `5cd1b3b`, `6529af1`, `93f8df0` —
  `/tools/tasks` screen, deep link from `/tools/projects`.

One incident during the fix round for the bot's `/update-task` task: a test run against
a pre-fix seam-incomplete version inserted a live `guildconfig` row into production
(`b23782a7c09e433bab78d866b`, `guildId 'guild1'`). Confirmed harmless and read-only;
left in place pending the owner's decision — see `backlog.md`. Closed out with a new
binding rule, `.claude/rules/tests-never-touch-production.md`.

Knowledge: `.claude/knowledge/project-tasks-site.md`.

Verified live: migration 017 applied, 43 commands registered, all 13 members named by
the sync, `curl https://api.gobizzi.com/api/discord/tasks` returns HTTP 200 with
projects. **Remaining:** the Discord-side checks (a `blocked_by` warning and an
unblock notice, `/project-members add` then a page refresh). See `session.md`.

## 2026-09-07 — Live meeting transcription (deployed 2026-09-09, awaiting a live meeting)

Per-speaker live transcript posted into the meeting channel while a meeting records, and
that transcript replaces the per-speaker whole-file upload as what CSAAS analyses.
Meeting channels also gained a pinned guidelines message.

Built with subagent-driven development across 9 tasks; suite 190 -> 246.
Branch `feat/live-transcription` in BOTH repos, not yet merged to `main`.

- Bot `56e1cdd..4f4a534` (14 commits). New: `bot/src/services/transcriptFeed.js`,
  `liveTranscriptPayload.js`, `bot/src/config/meetingGuidelines.js`,
  `bot/src/Database/migrations/016_meeting_utterance.sql`. Modified: `voiceCapture.js`,
  `meetingPipelineStages.js`, `csaasClient.js`, `Database/index.js`, `record.js`,
  `meeting-channel.js`, `meetingAutoChannel.js`.
- CSAAS `4176fa4..9bad076` (2 commits): `POST /api/meeting/workflow/utterance` +
  `data/migrations/20260907_1_meeting_utterances.sql`.

Bugs found and fixed during review that would have shipped silently: a `/playback`
regression producing two `MeetingRecording` rows on a truncated file after any
mid-meeting write error; every meeting creating two CSAAS meetings so the analysis ran
against an empty one; overlapping speech rendering out of spoken order; a five-minute
window where `/record stop` answered "no active recording" while recording; and a test
the plan specified that would have queried the production database on every `npm test`.

Knowledge: `.claude/knowledge/live-meeting-transcription.md`.

**Deployed 2026-09-09.** Bot `main` 9ca532d (auto-deploys via `.github/workflows/deploy.yml`,
which pulls, runs `npm run db:migrate`, then restarts pm2). CSAAS `main` ef24b0a.
Verified on the VM: `meeting_utterances` exists with `meeting_id int` + FK and its ledger
row says applied; bot `meetingutterance` and `meeting.csaasMeetingId` exist; a probe of
`POST /api/meeting/workflow/utterance` reaches the handler (returns our own
"Audio file is required", past the permission check); bot online, 0 unstable restarts.

**Remaining: a live meeting.** Two people, overlapping speech, then confirm the pipeline
took the live path. Steps in the plan's Task 10.

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

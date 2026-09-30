# Knowledge index

- [meeting-audio-recording.md](meeting-audio-recording.md) — how meetings are
  recorded to disk, the DB tables, user↔recording relations, and how `/playback` works.
- [schedule-meetings.md](schedule-meetings.md) — `/schedule`, `/meetings`, `/setup`;
  the timezone model, `parseWhen` NL time parser, Discord-timestamp helpers, and the
  autocomplete plumbing.
- [project-docs.md](project-docs.md) — how UBS-Doc markdown is synced into MySQL and
  browsed from Discord: the two tables, repo-vs-local pages, path-prefix attribution, the
  sync safety rules, and the Discord limits that shape `/docs`.
- [explain.md](explain.md) — /explain: Claude answers from a project's docs on the VM; scoping by cwd; debugging.
- [csaas-meeting-workflow-integration.md](csaas-meeting-workflow-integration.md) —
  planned feature: bot → CSAAS backend meeting pipeline (transcribe → analyze → tasks
  → assign to Discord users, GitHub push optional). What CSAAS already exposes, the
  gaps (endpoint auth/encryption, service URDD, `skip_github`, new `/assign` agent),
  schema differences, and the bot-side orchestration shape. ubs_doc = git clone +
  `UBS_DOC_PATH` mounted read-only in `/docs`.
- [live-meeting-transcription.md](live-meeting-transcription.md) — per-turn live transcript into the meeting channel; capture-time segmentation, ordering rules, the analyze-live handoff and its fallback.
- [project-tasks-site.md](project-tasks-site.md) — bot tasks shown live on the UBS-Doc
  site: the CSAAS cross-database read path, computed-not-stored blocked state,
  dependency/cycle rules, `/project-members` inferred membership, the member name
  sync's `LIMIT 25` trap, deploy order, (Team section) the site's write path back
  into Discord — three-hop status-change with exact headers/env, the
  `update_discord_tasks` permission and its backfill, the board's drop/override rules,
  and the CSAAS error-body shape — and site create/edit: the `/internal/tasks/update`,
  `create` and `subtask` routes, whole-request validation before any write,
  holders-to-`assigneeIds`, and the site actor never being `@mentioned`.
- [project-sections.md](project-sections.md) — per-project Discord sections
  (`feat/project-sections`, not yet merged): the twelve-channel category layout,
  id-based repair and its guarded name fallback, the Discord limits that shape
  the design (2 edits/10min, 50/category, no overwrite cascade), the fail-closed
  role-adoption model with `adopt_role`, merge-never-replace overwrites, project
  inference from a channel, `/project-setup`'s preview/backfill procedure, and
  the Administrator requirement.
- [ticket-archive.md](ticket-archive.md) — the archive divider
  (`feat/archive-divider`, replacing the one-day-old status buckets): the
  vocabulary leaf (`utils/ticketArchive.js`) and why the divider must never look
  like a ticket, the one reorder primitive (`utils/channelOrder.js`,
  `guild.channels.setPositions`), placement at creation, the live placement call
  (`services/ticketArchive.js`) and every `reason` it returns, the Done
  transition and 14-day retention (`ticketRetire.js`), `/project-setup`'s
  divider/reorder steps and its stale-bucket report, `/close-feature` and
  `/resolve-bug`, what clients see, known limitations and the rollout.
- [identity-link.md](identity-link.md) — linking a UBS-Doc account to a Discord
  member (`discord_identity_link`, auto-link by verified email or a `/link` code) and
  scoping what a site user sees/changes to their own projects: `resolveIdentity`'s
  `isAdmin`/`seesAll` split, `visibility.js`'s "my project" rule and hidden-ref stubs,
  the no-cross-database-string-JOIN rule, and the site's link card and admin panel.
- [global-layout.md](global-layout.md) — the shared global channel layout
  (`services/globalLayout.js`) `/init` and `/cleanup` both read: category/channel order,
  what was trimmed (Rules, Archive, Frontend/Backend/Database, Command channels) and why
  nothing depends on it, `/cleanup`'s by-id protections and empty-category rule, and the
  new #feedback channel (`feedbackChannelId`, Verified-only, `/feedback`, `/setup`
  creating it idempotently). The live server is never reordered.
- [repositories-and-issues.md](repositories-and-issues.md) — repositories per scope
  (`project_repos.scope`, migration 030) and a GitHub issue for every task: the one
  `resolveTaskRepo` rule shared by `/create-task`, the site's create route and the
  meeting pipeline; `GITHUB_TOKENS` (per owner) vs `GITHUB_TOKEN` (fallback); issue
  creation, the opt-out and reported failures; `syncIssueState` closing/reopening an
  issue on a task's status change; `checkRepoAccess`; the Mobile scope; the bot (not
  CSAAS) opening meeting-task issues idempotently in `issue_syncing`.
- [client-role.md](client-role.md) — the `Client` role and `guildmember.kind`:
  why a client never gets `Verified`, the two `/verify` acceptance paths, the
  shared `approveMember`, `/set-roles`' refusal, the deny-by-default command
  gate and `clientCommands`, `ensureSupportChannels`' id-first repair, the
  twelve-channel project section and its per-client member overwrites
  (`CLIENT_SECTION_KEYS`, `clientIds`, `staffOnly`), requests as tasks
  (`requestedBy`, attachments, notices), `/request-report`'s filtered
  timeline, and the rollout steps.
- [site-clock.md](site-clock.md) — clock in and out on the site (roadmap sub-project 5):
  the bot's one clock service shared by `/clock-in`, `/clock-out` and the four
  `/internal/clock/*` routes; CSAAS's link-only clock endpoints (no admin bypass), guild
  resolution, `/time/active` scope and redaction; the site's header control, task-page
  button and "Clocked in now" card, and why elapsed ticks from `elapsedSeconds`.
- [task-import.md](task-import.md) — JSON task import on the site (roadmap sub-project 6):
  the user-facing file format and limits (90 KB, 50 tasks), the bot's `checkImport` and
  verdict shape, `status` on create/subtask (done = no channel, no issue, no notify), the
  per-route body cap, CSAAS's `import-check` endpoint, the site's sequential queue,
  unconfirmed steps and leftover file, and the rollout order (bot first).
- [doc-tasks.md](doc-tasks.md) — tasks from a document (roadmap sub-project 7, built, not
  deployed): `docText.js` (types, 10 MB / 60,000 chars / 65,535 bytes, lazy `unpdf`/`mammoth`),
  `/tasks-from-doc` and its document job (`dataJson.source`, `reviewChannelId`, the
  `/analyze-live` text path), a document at `/record start` sent to CSAAS as
  `pre_meeting_notes` (not stored), the `reporting` stage and the notes/report files, and
  the rollout (CSAAS first).

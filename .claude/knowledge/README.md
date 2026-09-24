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
  sync's `LIMIT 25` trap, deploy order, and (Team section) the site's write path back
  into Discord — three-hop status-change with exact headers/env, the
  `update_discord_tasks` permission and its backfill, the board's drop/override rules,
  and the CSAAS error-body shape.
- [project-sections.md](project-sections.md) — per-project Discord sections
  (`feat/project-sections`, not yet merged): the twelve-channel category layout,
  id-based repair and its guarded name fallback, the Discord limits that shape
  the design (2 edits/10min, 50/category, no overwrite cascade), the fail-closed
  role-adoption model with `adopt_role`, merge-never-replace overwrites, project
  inference from a channel, `/project-setup`'s preview/backfill procedure, and
  the Administrator requirement.
- [client-role.md](client-role.md) — the `Client` role and `guildmember.kind`:
  why a client never gets `Verified`, the two `/verify` acceptance paths, the
  shared `approveMember`, `/set-roles`' refusal, the deny-by-default command
  gate and `clientCommands`, `ensureSupportChannels`' id-first repair, the
  twelve-channel project section and its per-client member overwrites
  (`CLIENT_SECTION_KEYS`, `clientIds`, `staffOnly`), requests as tasks
  (`requestedBy`, attachments, notices), `/request-report`'s filtered
  timeline, and the rollout steps.

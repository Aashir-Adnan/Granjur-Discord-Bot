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

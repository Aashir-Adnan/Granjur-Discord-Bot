# Granjur Discord Bot — Claude Instructions

## Project layout

The bot lives in `bot/`. Source is `bot/src/` (ESM, `import`/`export`, `"type": "module"`).
Node + discord.js v14 + `@discordjs/voice`. Custom SQL abstraction layer in
`bot/src/Database/`, Prisma-style call surface exposed via `bot/src/db/index.js`
(`db.meetingRecording.create(...)`, etc.). Migrations in `bot/src/Database/migrations/`.

## Claude Memory System

This repo carries a project-local memory scaffold under `.claude/`. You MUST use it.
Do not keep project knowledge only in your head or in chat — persist it here.

### `.claude/knowledge/` — how this codebase works
Markdown reference docs: architecture, data layer, conventions, protocols, standards,
and recurring "how do I…" topics. Read the relevant file before working in an area;
write or update a file whenever you learn something non-obvious that a future session
would otherwise have to re-derive. One topic per file. Keep an index in
`.claude/knowledge/README.md`.

### `.claude/rules/` — guardrails
Hard constraints and behavioral rules (test discipline, conventions that must not be
broken, things that have caused incidents). Each rule is a short `.md` file. This
`CLAUDE.md` references them below and they are binding.

### `.claude/skills/` — repeatable workflows
Step-by-step procedures for tasks done more than once in this repo (adding a slash
command, writing a migration, adding a voice feature, deploying commands). One skill
per file. Index in `.claude/skills/README.md`.

### `.claude/state/` — what is happening
Exactly three files:

- **`backlog.md`** — every task that still needs doing. Newest/highest priority first.
  Each item: short title, one-line context, and a pointer to relevant knowledge/skill
  files. Move items out when done.
- **`completed.md`** — every finished task. Append newest first with the date
  (absolute, e.g. `2026-08-31`), a one-line summary, and the files/commits touched.
- **`session.md`** — the current working session: what is being worked on right now,
  the plan, which `knowledge/` files and `skills/` are in use for it, and any open
  questions. Overwrite/rewrite this at the start of each session; fold its outcome
  into `completed.md` and `backlog.md` at the end.

### Session discipline

1. **Start of session:** read `.claude/state/session.md`, `.claude/state/backlog.md`,
   and any `knowledge/` files relevant to the task. Rewrite `session.md` with the
   current goal, plan, and the knowledge/skill files you will use.
2. **During:** update `knowledge/` as you learn; follow `rules/`; follow the matching
   `skills/` file if one exists (create one if the task is clearly recurring).
3. **End of session (if meaningful work was done):** move finished items from
   `backlog.md` to `completed.md` (dated), add any newly discovered work to
   `backlog.md`, and clear/update `session.md`.

## Rules (binding — see `.claude/rules/`)

<!-- Add one bullet per rule file, e.g.: -->
<!-- - `.claude/rules/testing.md` — how and when to run/verify tests -->

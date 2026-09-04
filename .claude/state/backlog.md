# Backlog

Outstanding work, highest priority first. Move items to `completed.md` (dated) when done.

---

## /explain — follow-ups
- **Drop `MultiEdit` from `EXTRA_ARGS`** — CLI 2.1.186 warns `deny rule "MultiEdit" matches no
  known tool` on every explain run (harmless, noisy). `explainAgent.js`, spec §4, tests.
- **`CLAUDE_CLI_ARGS_JSON` is an escape hatch** — an operator template containing
  `--dangerously-skip-permissions` would re-open the read jail regardless of
  `skipPermissions:false`. Either strip that flag from the template for explain calls or
  document it as forbidden. Final-review out-of-scope note, 2026-09-05.
- **`spawnSync` blocks the CSAAS event loop** for the whole CLI run (30–90 s). The 110 s
  per-call timeout and the one-in-flight guard bound it; the durable fix is an async spawn.
  Pre-existing for meeting analysis too.
- **`/home/azureuser/.claude/.credentials.json` is root-owned** (root's pm2 refreshes the
  token) — azureuser's own `claude` reports "Not logged in". The endpoint is unaffected.
  Fix: run CSAAS as azureuser, or `chown` after each refresh. Observed 2026-09-05.

**Code as a second source** once the fresh Badar HMS clone is on the VM (`--add-dir` 
or a second `cwd` root; renderer needs a `file:line` form).

**Threads / follow-up mode** (CLI `--resume` per Discord thread, idle timeout).

**Multiple `docsPaths` per project** (only the first is used).


---

## Meeting → tasks integration — remaining gaps
Ran end to end and shipped to production (see `completed.md` 2026-09-04). What is
still unexercised or wrong:
- **Assignment has never been exercised live.** The one live run mirrored an
  unassigned task, so the new per-task ticket channel, the assignee DM and the
  `assigneeIds` write have unit tests but no live run behind them. Next recording
  should assign a task in `/meeting-review` before approving.
- **The GitHub `[Agent Call]` push is untested live** — `issue_syncing` has only run
  with zero github-flagged tasks. It also needs a working `GITHUB_TOKEN` (see below).
- **Project linkage is broken.** CSAAS reports the project as `Badar_HMS`; the
  repository row is named `Badar_HMS_Node`, so `mirroredStage`'s exact-name
  `repository.findFirst` misses and every mirrored task lands with `projectId` and
  `repositoryId` null. Needs fuzzier matching (or a stored alias). Until then
  `issue_syncing` cannot resolve a repo slug either.
- **No project-wise task view.** `/dashboard` groups by module. Nothing lists tasks
  per project, which is what a manager asks for after a meeting.
- **Review lands in the voice channel's own chat** for a `/record` meeting, because
  `meetingchannel.textChannelId` is null unless a dedicated meeting channel was set
  up. Consider falling back to the guild's meeting/summary channel.
- **Seven other `LIMIT ?` sites in `bot/src/Database/index.js`** (lines ~490, 493, 964,
  1027, 1030, 1663, 1716) have the same prepared-statement failure that broke the first
  pipeline tick (`Incorrect arguments to mysqld_stmt_execute`). Pre-existing, outside the
  meeting work; any command that reaches them with a bound LIMIT will error.
- **`/meeting-review latest` unsupported** — no `db.meetingPipelineJob.findLatest`;
  the command needs an explicit meetingId.
- **`stopMeetingRecording` in `voiceCapture.js` is dead code (no callers)** — the
  pipeline enqueue actually fires from `endMeetingSession` (empty-channel grace timer
  + max-duration timer, the real meeting-end paths). Delete it or wire it in.
- **Stale-`working` reaper threshold == `MEETING_STAGE_TIMEOUT_MS`** with no margin
  (`bot/src/Database/index.js` `claim`/`claimBatch`). Fine single-process; give it a
  2x multiplier before running multiple worker processes.
- **Migration `015` leaves a redundant plain `idx_task_externalId`** on fresh installs
  (`014` adds the plain key, `015` no-ops because the unique key from `schema.sql` is
  already present). Harmless; tidy `014` to skip when a unique key exists.

## Live Discord acceptance for the project-docs branch
Task 10 of `docs/superpowers/plans/2026-09-03-project-docs-preview.md` — click through
`/docs`, `/projects`, `/edit-docs` and the `#documentation` channel on branch
`feat/project-docs`. Everything else about that branch is verified automatically; this is the
only unverified part. Procedure is in `session.md`.
## `Task` vs `task` — the table-case bug reached beyond the pipeline
`taskCreate`/`taskUpdate` wrote `` `Task` ``, which MySQL on Linux treats as a
different table. Fixed in `099179d`, but it means task writes had **never** worked on
this server — `/create-task`, `/bug` and `/feature` share those functions. Worth a
sweep for other capitalised table identifiers in `bot/src/Database/index.js`.

## Four commands still read a table with zero rows
`/create-task`, `/feature`, `/project-db` and `/create-project-categories` all read
`db.projectSchema`, i.e. the `projectschema` table, which has **0 rows** in production. The
table holding data is `project_schemas`, an unrelated dump-versioning table with a different
shape. Their project pickers are therefore empty. `/edit-docs` and the `#documentation`
channel had the same bug and were repointed at `docpage` on `feat/project-docs`; these four
were out of that plan's scope. See [[project-docs]].

## Replace the dead `GITHUB_TOKEN`
The token in `.env` returns `401 Bad credentials`. The docs sync detects this, warns once and
continues unauthenticated against the public repository, so documentation still works — but
`/bug` issue creation and any other authenticated GitHub call are broken, and the sync runs on
the 60/hr unauthenticated budget instead of 5000/hr.

## Deferred findings from the project-docs final review
None blocks use; the reviewer triaged each as "can wait".

- **`docsPaths` overlap between projects is unchecked**, and ties resolve by SELECT order, so
  with overlapping prefixes a page can flip owners between syncs. Needs a precedence rule
  (longest prefix wins? first created?) — a product decision. Only one project has
  `docsPaths` today.
- **`/scrap` destroys Discord-authored documentation.** It deletes `guildconfig`, which
  cascades `docpage`. `source='local'` pages exist nowhere else, and the confirmation does not
  mention it.
- **A permanently unfetchable file freezes the delete pass.** One file that 404s forever means
  the head SHA is never recorded, so upstream *deletions* stop propagating until it is fixed.
  Fails toward stale content rather than data loss. A retry counter would bound it.
- **`/edit-docs` says "Updated" on a raced no-op** — `affectedRows` is not inspected.
- **`docId` is not unique-keyed**, so a `foo.md`/`foo.mdx` pair could make the read-and-refuse
  guard inspect the wrong row. No clobber results; the message could mis-fire.
- **`projects.js` swallows a re-attribution failure** into "No synced pages match those paths
  yet", so a database error reads as a normal empty result.
- **`/setup`'s Sync button can outlive Discord's interaction token** on a cold sync, leaving
  the user on "Syncing documentation…". Now that the button forces a full pass, a cold sync is
  reachable again.
- **`rootOptions` truncates at 25 with no paging** — past 25 projects plus sections, entries
  become unreachable.
- **`docs_browse:sec:<section>` customId** would exceed Discord's 100-character cap for a
  section name over ~84 characters.
- **`docPageSearch`'s LIKE fallback does not escape `%` or `_`**, so a search containing `%`
  behaves as a wildcard. The term is bound; there is no injection.
- Minor: no index on `docpage.docId`; `DOCS_SYNC_INTERVAL_MS` is unvalidated (a non-numeric
  value yields a 1 ms interval); migration 012 seeds `docsSlug` with a SQL expression that is
  not `slugify()`; `proj:` and `sec:` scopes nest at different depths; two concurrent
  `/projects` link flows share one flow-store key; `projects` has no `dedicatedChannels` entry.

## Phase 2: write documentation back to UBS-Doc
Deliberately out of scope for Phase 1 and shaped to be additive — the `source` column already
distinguishes local pages, so Phase 2 is "commit the `'local'` rows as a PR per doc, flip them
to `'repo'` on merge". Needs a GitHub PAT with Contents: write and Pull requests: write on
`Aashir-Adnan/UBS-Doc`. A page's site link stays dead until the merge triggers a Vercel build.

## `/meetings` — manager filter is name-based
`isManager()` matches role names `CEO` / `Server Manager` (plus owner / ManageGuild).
If those role names ever change, managers silently lose the all-meetings view. Consider
reusing `guildConfig` role-id lists instead.

## Mixed meeting playback track
`/playback` still plays one speaker's file at a time. No step mixes the per-speaker
`.ogg` files into a single meeting track. Would need ffmpeg `amix` / `amerge`.

## `/schedule` — still open
- Per-user timezone override (deliberately skipped — per-guild only for now).
- Voice-channel picker step (currently `voiceChannelId` is always null).

---

## Dead vendored `bot/src/Database/*` files — remove or repair
15 files under `bot/src/Database/` fail to import (missing `../../SysFunctions/*`,
extension-less relative imports, and a duplicate `getColumnNameFromMapper` declaration
in `executeQueryWithPagination.js` that is a hard SyntaxError). Nothing on the live
path imports them — the real DB layer is only `connection.js`, `helpers.js`,
`index.js`. Decide: delete, or fix if the abstraction is wanted.

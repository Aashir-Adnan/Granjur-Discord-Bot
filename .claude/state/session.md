# Current Session

**Date:** 2026-09-18

## Goal
Task 11 (the last task of `docs/superpowers/plans/2026-09-18-project-sections.md`)
was documentation-only: write down what branch `feat/project-sections` actually
built and shipped, since the design spec drifted from the code during the build
(especially the role-adoption rules in spec §5/§13) and the ledger is the only
complete record otherwise. No code, tests, or config were touched.

## Outcome
- `.claude/knowledge/project-sections.md` — new reference: the ten-channel section
  layout, id-based repair and its three-way-guarded name fallback, the Discord
  limits that shape the whole design (2 edits/10min, 50/category, no overwrite
  cascade onto existing children), the fail-closed role-adoption model built in
  the final fix wave (`adopt_role`, the subset-of-`@everyone` permission test,
  the "elsewhere overwrite" refusal, `rolesFetched`), merge-never-replace
  overwrites and why the checks are presence-only on purpose, shared/meeting
  review channel exclusion, project inference from a channel, duplicate-slug
  refusal, `/project-setup`'s preview/backfill procedure, the Administrator
  requirement, and the tests-plus-poisoned-DATABASE_URL discipline. Indexed in
  `.claude/knowledge/README.md`.
- `.claude/state/backlog.md` — new "Per-project sections — follow-ups" section:
  the `LIMIT 200` roster cap, unscoped `projectFindFirst`, the meeting pipeline's
  write-after-send ordering, dead `feature.js`/`bug.js`, the untyped `@everyone`
  overwrite in the global meeting-voice path, residual name-fallback adoption
  risk, cross-reporting gaps in the result buckets, the `missingOverwrites`/
  `mergedOverwrites` cache-guard mismatch, `/cleanup`'s unrechecked confirm
  handler, a task moved between projects keeping its old channel/role, archiving
  a finished project, and the 12 orphan global-Meetings channels.
- `.claude/state/completed.md` — new entry, commit range `7e78f9f..1ae5dcf`,
  explicitly "NOT YET MERGED."
- This file, rewritten.
- Report: `.superpowers/sdd/2026-09-18-project-sections/task-11-report.md`.

## What remains
1. **Merge** `feat/project-sections` into `main` (18 commits, 610 tests passing,
   whole-branch review clean after the two-part final fix wave — see the ledger's
   last ~60 lines for the full sign-off chain).
2. **Deploy.** Migration 019 runs automatically. Migration 020 does not exist —
   it was written then deleted as a no-op (`meeting.projectId` was already in
   `schema.sql`); if any dev database already applied it, its filename will sit
   harmlessly in that database's applied-migrations ledger. This wave's commits
   changed **no** `SlashCommandBuilder` (`data`) exports, so no re-registration is
   needed for anything final-wave touched — but earlier tasks in this same branch
   DID change command options (`/project-members`, `/meeting-channel`, the new
   `/project-setup`, `/create-project-categories` lost `create_roles`,
   `/create-project-role`), so confirm the registration state at deploy (`pm2
   logs` should show 44 commands after restart).
3. **Backfill**, per project, not `all:true` — `capReply` keeps blocks from the
   FRONT, so a nine-project `all:true` run truncates the LAST projects' warnings
   out of the reply entirely (console still logs everything via `logWarnings`).
   Expect most of the 9 existing projects to REFUSE their legacy role on the
   first pass: only 5 `projectmember` rows exist across 4 of the 9 projects, so
   most legacy roles have holders that aren't project members. That's the safe
   outcome — nobody gains or loses a role, the section is hidden but repairable.
   Use `preview:true adopt_role:true` to see exactly who would change before
   running for real. A legacy role that holds an overwrite on some OTHER channel
   is unadoptable by any command, even with `adopt_role:true` — renaming the
   project or clearing that overwrite is the only way out.
4. **Live checks the test suite cannot cover** (fakes only, by the repo's own
   testing rule):
   - Bot's own role holds Administrator — check this FIRST, before any real
     `/project-setup` run. Every section category denies `@everyone` with no
     allow for the bot at all.
   - `/project-setup project:Framework preview:true`, read the plan, then the
     real run, then `/project-setup all:true` for the rest.
   - A non-member cannot see a project meeting's two channels.
   - A project member who is NOT an assignee CAN see a moved task channel (the
     merged project-role allow).
   - A `bug-triage-*` meeting review channel is left untouched by
     `/project-setup` (topic-based ticket-channel exclusion).
   - `/create-task` a feature in a project → lands in that project's category
     with a readable name; `/meeting-channel` run inside a project channel →
     both new channels land there; `/project-members add` → panel updates and
     the person can see the section.

## Open threads (parked, inherited from before this branch)
- FAQ error-lookup design, section 3.
- `STT_PROVIDER=soniox` experiment on the VM.
- Stray production `guildconfig` row `b23782a7c09e433bab78d866b` (`guildId =
  'guild1'`, inserted 2026-09-17T10:48:49Z by a test that reached production —
  see `.claude/rules/tests-never-touch-production.md`) — confirmed read-only,
  still awaiting the owner's go-ahead to delete. See `.claude/state/backlog.md`
  "Project tasks site — follow-ups" for the exact `DELETE` statement.

# Current Session

**Date:** 2026-09-03

## Goal
Project-based documentation + preview in Discord, sourced from the `UBS-Doc` repo.
Read-only (Phase 1). Design approved; spec written; implementation plan next.

**Spec:** `docs/superpowers/specs/2026-09-03-project-docs-preview-design.md` (uncommitted)

## Shape of the work
GitHub (`Aashir-Adnan/UBS-Doc`, public, `main`) → 15-min sync service → MySQL
(`docpage`, `docsource`) → Discord embeds, with a deep link to
`https://ubs-doc.vercel.app/docs/<docId>` as the fallback for anything long.
New/changed: migration 012, `db.docPage`/`db.docSource`, `services/docsSync.js`,
rebuilt `/docs`, new `/projects`, repurposed `/edit-docs`, rebuilt `docTraversal.js`,
first test suite in `bot/test/` via `node --test`.

## Environment (verified 2026-09-02)
- `npm install` clean, Node v24.15.0; ffmpeg-static binary present and working.
- Remote MySQL 8.0.46 @ 20.120.228.55/granjur; all 11 migrations applied.
- All 36 slash commands build. SSH to the VM works with
  `C:\Users\Dell\Downloads\frame-work_key.pem`.

## Testing approach (user decision)
Stop the VM instance (`pm2 stop granjur-bot`), run the real bot locally against the prod
guild + prod DB, then restart the VM bot. The user runs the pm2 commands.
**Push to `main` auto-deploys** (`.github/workflows/deploy.yml`) — branch for this work.

## Discoveries worth keeping
- `db.projectSchema` (`projectschema` table) has 0 rows; `docTraversal.js` and
  `edit-docs.js` both read it. Dead paths. The live table is `project_schemas`, an
  unrelated dump-versioning table.
- `/repos` collects a project name and discards it; `project_repos` is never written by
  any command. No command creates a project — the 8 rows came from `seed-projects.js`.
- `GITHUB_TOKEN` in `.env` is invalid (401). Phase 1 does not need it.
- UBS-Doc routes every file under `docs/` by URL whether or not `sidebar.ts` lists it,
  but the glob is build-time, so new files need a Vercel rebuild.

## Open questions
- Commit the spec on a branch? (not committed yet — user has not asked)

# Project Soft Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CEO/Server Managers can delete a project from `/projects` — it disappears everywhere, its section and role are removed, its task channels are archived — and reactivate it later with everything restored.

**Architecture:** A `deletedAt` marker on `project` (bot migration 031). The bot's DB layer hides deleted projects and their tasks by default (`includeDeleted` opts back in); write paths refuse them. A new service archives/restores task channels and drives the delete and reactivate flows, reusing `setupOneProject` to rebuild. CSAAS skips deleted projects and their tasks in every site query and refuses writes.

**Tech Stack:** Bot: Node ESM, discord.js v14, `node:test`, MySQL. CSAAS: Node CommonJS, UBS framework, standalone node test scripts.

**Spec:** `docs/superpowers/specs/2026-10-01-project-soft-delete-design.md`

## Global Constraints

- Nothing is ever deleted from the database by this feature; only `project.deletedAt`/`deletedBy` change, and the Discord ids on the project row are nulled on delete.
- The project row is marked deleted BEFORE any Discord change on delete, and un-marked BEFORE the rebuild on reactivate.
- Verbatim strings: `This project is deleted.`; `The name does not match — nothing was deleted.`; `A deleted project has that name — reactivate it or pick another name.`; archive category names `🗄 ARCHIVED PROJECTS`, `🗄 ARCHIVED PROJECTS 2`, …; replies `Deleted **<name>**. Archived N task channels; removed its section and role.` and `Reactivated **<name>**. Rebuilt its section; restored N task channels.` (plus a list of any failed steps).
- A deleted project's tasks never get a new channel; an open task's archived channel is never swept; a finished task's `channelRetireAt` is left unchanged.
- Time already logged still counts in time reports.
- Only CEO and Server Manager (the `/projects` roles) can delete or reactivate.
- Bot tests use fakes for every `db`/`getConfig`/Discord seam — never the default `db`, never a real server (`.claude/rules/tests-never-touch-production.md`; the root `.env` is production). A migration is tested by its SQL text and its guard, never by running it. Never read any `.env`.
- Commits: `git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit ...`; message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` — exactly that.
- A piped test summary can exit 0 while red: read `ℹ fail` (bot), each CSAAS script's own output.
- The bot working tree has an uncommitted stray edit to `docs/superpowers/plans/2026-09-30-json-task-import.md` (not ours) and an untracked `brag-output/`: never stage, edit or revert them.

## Workspaces

- Bot: `D:\Work\Granjur Technologies\Granjur-Discord-Bot`, branch `feat/project-soft-delete` (checked out; spec `3b155bc`). Tasks 1–3, 5.
- CSAAS: `D:\Work\Granjur Technologies\CSAAS_Backend`, create `feat/project-soft-delete` from `main` (leave its untracked `.bridge/`, `.worktrees/`, `data/migrations_completed/*` alone). Task 4.

## Review Focus

1. A deleted project's task must not reappear anywhere through a query that bypasses `db.task.findMany` (a raw SQL read, `findByIds`, a join) — Task 2 test sweep; Task 4 CSAAS tests.
2. Reactivation must see the project's tasks and siblings even though the default queries hide them (the row is un-marked first) — Task 3 test.
3. A delete that fails part-way in Discord must leave the project deleted and the reply honest about what was not done; re-running Delete must not be possible (it is no longer in the live list) — Task 3 test; Reactivate then rebuilds regardless.
4. The docs sync must not unhook a deleted project's docs — Task 2 test.
5. The archive category never exceeds 50 channels — Task 3 test.

---

### Task 1: Bot — the marker and the default hiding

**Files:**
- Create: `bot/src/Database/migrations/031_project_soft_delete.sql`, `bot/src/Database/migration031.test.js`
- Modify: `bot/src/Database/schema.sql`, `bot/src/Database/index.js`
- Test: the DB layer's existing test style (find how `Database/index.js` SQL builders are tested, e.g. `meetingPipelineJobInsert.test.js`)

**Interfaces:**
- Migration: `ALTER TABLE project ADD COLUMN deletedAt DATETIME(3) NULL`, `ADD COLUMN deletedBy VARCHAR(64) NULL`, `ADD KEY idx_project_guild_deleted (guildConfigId, deletedAt)`, each guarded (information_schema) like `026`/`030`.
- `PROJECT_UPDATABLE` gains `deletedAt`, `deletedBy`. Project rows returned by the layer carry `deletedAt` (Date|null) and `deletedBy`.
- `project.findMany({ where })`: adds `AND deletedAt IS NULL` unless `where.includeDeleted === true` (the flag is not a column). `findFirst` and `findByName` unchanged (they return deleted rows).
- `task.findMany`, `task.findByIds`, `ticketDocListWithTask`: add `AND NOT EXISTS (SELECT 1 FROM project p WHERE p.id = task.projectId AND p.deletedAt IS NOT NULL)` (adapt the alias to each query) unless `includeDeleted === true`. Project-less tasks unaffected.
- Export small pure SQL-building helpers for the three task queries and the project query so they are testable without a database.

- [ ] **Step 1: Write the failing tests**: the migration file's statements and guards (text); the project `findMany` SQL with and without `includeDeleted`; each task query's SQL with and without it; `includeDeleted` never appears as a column; `PROJECT_UPDATABLE` includes the two columns.
- [ ] **Step 2: Run** them → FAIL.
- [ ] **Step 3: Implement**; mirror the columns in `schema.sql`.
- [ ] **Step 4: Run** them, then `npm test` → `ℹ fail 0`. Existing tests that assert the exact old SQL of these queries are expected to change — list each (old → new).
- [ ] **Step 5: Commit** `feat(projects): a deletedAt marker, and deleted projects hidden by default`.

---

### Task 2: Bot — callers: opt-ins, reservations, refusals, matching, docs, channels, cleanup

**Files:** the callers named below (and any other you find with a search for `project.findMany`, `task.findMany`, `findByIds`, `findByName`, `project.findFirst`); their tests (added cases).

**Interfaces / required behaviour:**
- **Opt in with `includeDeleted: true`:** the `/projects` list data (so Task 3 can split live/deleted); `docsSync.js` `projectsFor` (and anything else the docs sync uses to attribute pages) — a deleted project's docs stay attributed; `/cleanup`'s protected-project and protected-task lists; `time-report.js`'s project names; `setupProjectSection`'s task and sibling reads (`project-setup.js` ~520, ~550) — so a rebuild of a just-reactivated project sees everything (the row is un-marked first, but siblings may include deleted projects whose ids must still be treated as claimed).
- **Reservations:** `/projects` Add refuses a name held by a deleted project (`findByName` returns it: refuse with `A deleted project has that name — reactivate it or pick another name.`) and a slug held by a deleted project (the same sentence with "slug"). `repos.js` and `create-project-role.js` name lookups refuse a deleted project with `This project is deleted.`
- **Refusals (`This project is deleted.`)** wherever a project id or a task in a project is acted on: the internal create, update (a task in a deleted project, or a move INTO one), subtask, status and import-check routes (`services/internalTaskRoute.js` — use `project.findFirst`/the task's project and check `deletedAt`); `/create-task`, `/update-task`, `/clock-in`, `/log-time`, `/tasks-from-doc`, `/project-members`, `/project-setup` (a deleted project chosen by id), `/meeting-channel` with a deleted project. Where a picker already hides deleted projects (Task 1), the refusal guards the by-id path only.
- **Meetings:** `meetingTaskProject.js` `loadProjectContext` uses live projects only AND drops repository links whose project is deleted, so `matchProject` can never return a deleted project.
- **No new channel:** `taskUpdateNotify.js`'s channel creation (~194) skips a task whose project is deleted.
- **Cleanup:** `commands/cleanup.js` `isProtectedCategory` protects every category whose name starts with `🗄 ARCHIVED PROJECTS`.

- [ ] **Step 1: Write the failing tests** — one per bullet group: the docs sync keeps a deleted project's page attribution (Review Focus 4); the Add refusals (name, slug); each route's refusal; the command refusals (a representative set through their pure/seamed parts — list any command you could only cover by reading); meeting matching with a deleted project and with a live repository linked only to a deleted project; `taskUpdateNotify` creates no channel for a deleted project's task; the cleanup prefix protection; a search-based sweep test is not required, but list every `project.findMany`/`task.findMany` caller you reviewed and whether it needs `includeDeleted` in the report (Review Focus 1).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the touched tests, then `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(projects): deleted projects are refused, unmatched and keep their docs`.

---

### Task 3: Bot — Delete and Reactivate in `/projects`

**Files:**
- Create: `bot/src/services/projectLifecycle.js`, `bot/src/services/projectLifecycle.test.js`
- Modify: `bot/src/commands/projects.js` (buttons, selects, modal, confirm; register their custom ids the way the existing `projects_*` ids are routed), its test

**Interfaces:**
- `ARCHIVE_CATEGORY_BASE = '🗄 ARCHIVED PROJECTS'`; `archiveCategoryName(n)` → base for 1, `base + ' ' + n` otherwise; `async ensureArchiveCategory(guild)` → the first archive category with fewer than 50 children, creating the next one (`@everyone` denied ViewChannel) when all are full (Review Focus 5).
- `async archiveTaskChannel(guild, channel, archiveCategory)`: parent → archive; overwrites replaced by `@everyone` denied ViewChannel and SendMessages. `async restoreTaskChannel(guild, channel, { task, project })`: overwrites rebuilt as `createTaskTicketChannel` builds them (reuse its overwrite builder — export it if needed, do not copy it); a finished task (the existing finished-status helper) then `lockTicketChannel`.
- `async deleteProject({ db, guild, project, actorId, now })` → `{ archived, removed, failures: string[] }`: 1) `project.update(deletedAt, deletedBy)`; 2) archive each task channel of the project (tasks read with `includeDeleted`; a channel that no longer exists is skipped and counted as a failure only if the fetch errored for another reason); 3) delete the section channels (`discordChannels`, including `archiveDivider`), the category, the role; 4) null `discordCategoryId`, `discordRoleId`, `discordChannels`. Each Discord step is caught individually and reported in `failures`; the project stays deleted (Review Focus 3).
- `async reactivateProject({ db, guild, cfg, project, botUserId, setup = setupOneProject })` → `{ restored, failures }`: 1) clear `deletedAt`/`deletedBy`; 2) `setup(guild, freshProject, { db, cfg, botUserId })` (it moves existing task channels back into the new category); if it throws, record `Section rebuild failed — run /project-setup for it.` and continue; 3) `restoreTaskChannel` for each of the project's tasks with a channel; 4) delete any archive category left with no children.
- `/projects`: `Delete project` and `Reactivate project` buttons beside the existing ones (Reactivate shown only when deleted projects exist); Delete → a select of live projects → a modal `Type the project name to confirm` → `deleteProject`; Reactivate → a select of deleted projects → a confirm button → `reactivateProject`. Both defer, then edit the reply with the verbatim result line plus failures. The list shows deleted projects in a separate "Deleted" section.

- [ ] **Step 1: Write the failing tests** (fake guild with channels/categories/roles recording calls, fake db): archive name sequence and the 50 overflow; `archiveTaskChannel` overwrites; `restoreTaskChannel` for open and finished tasks; `deleteProject` marks the row before any Discord call (call-order assertion), archives, deletes, nulls ids, reports a failed step and still leaves the project deleted; `reactivateProject` clears the row before calling `setup` (order), calls `setup` with the fresh project, restores overwrites, relocks finished, removes an empty archive category, and on a `setup` throw still restores and reports; the command's confirm-name mismatch refuses with the sentence and deletes nothing; the list splits live/deleted.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the touched tests, then `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(projects): delete and reactivate a project from /projects`.

---

### Task 4: CSAAS — skip deleted projects and their tasks

Work in `D:\Work\Granjur Technologies\CSAAS_Backend`: `git checkout -b feat/project-soft-delete main`.

**Files:** `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js`, `visibility.js`, `discordProjectStats.js`, `discordClock.js` (through `canSeeTask`), a small shared helper for the column check (e.g. `projectDeletedClause.js` in the same folder); test scripts in `Services/SysScripts/TestScripts/discord-tasks-test/` (new `soft-delete.test.js`, following the siblings' `__setTestHooks` style).

**Interfaces:**
- `async projectsHaveDeletedAt(hooks)` → boolean: checks `information_schema.COLUMNS` for `granjur.project.deletedAt` once and caches the answer (a positive answer forever; a negative one for 5 minutes, so it notices the bot's migration after a deploy).
- When the column exists: the project list queries add `AND deletedAt IS NULL`; the task queries add `AND (t.projectId IS NULL OR t.projectId NOT IN (SELECT id FROM granjur.project WHERE deletedAt IS NOT NULL))` (adapt aliases, including all of `discordTasks.js`'s schema-fallback task variants); `visibility.js` `projectRow` returns the row with `deletedAt`, and `assertCanUseProject` / `assertCanTouchTask` throw 409 `This project is deleted.` for a deleted project; `visibleProjectIdsFor` skips deleted projects; `discordProjectStats.js`'s project list skips them.
- When the column does not exist: every query is exactly as today.
- Time report and entries unchanged.

- [ ] **Step 1: Write the failing test script**: with the column, the payload omits a deleted project and its tasks (no "No project" leak — Review Focus 1); stats omit it; a write to a deleted project's task → 409 with the sentence; clock-in on it refused; without the column, the SQL is exactly today's; the cache (one information_schema query for many calls; a negative answer re-checked after the TTL with an injected clock).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new script and the whole `discord-tasks-test` loop (`for f in …/*.test.js; do node "$f" >/dev/null 2>&1 || echo "FAILED $f"; done` → no `FAILED`) and `npx jest Services/SysScripts/TestScripts/portalAnyUrddPermission.test.js`.
- [ ] **Step 5: Commit** `feat(discord-tasks): hide deleted projects and their tasks; refuse writes to them`.

---

### Task 5: Suites, knowledge and state

- [ ] **Step 1:** bot `npm test` (`ℹ fail 0`); CSAAS the new script, the loop and the jest file.
- [ ] **Step 2: Knowledge** — `.claude/knowledge/project-soft-delete.md` (new) + README index line: the marker and `includeDeleted`; what is hidden and what opts in; the refusals; delete and reactivate step by step; the archive categories; CSAAS's column check; the rollout.
- [ ] **Step 3: State** — backlog: a new item "Project soft delete — BUILT, NOT DEPLOYED", rollout bot → CSAAS; completed: a 2026-10-01 entry with commits per repo; session: current state.
- [ ] **Step 4: Commit** `docs: project soft delete — knowledge and state`.

---

## Rollout (after merge; each push needs the owner's go-ahead)

1. Push the bot's `main`: the deploy runs `npm run db:migrate` (031) before restarting.
2. Push CSAAS `main` (auto-deploys). Its column check makes either order safe.

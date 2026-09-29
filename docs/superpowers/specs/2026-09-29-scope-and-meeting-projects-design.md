# Scope everywhere and meeting-task projects

Sub-project 2 of the owner's roadmap (see `.claude/state/backlog.md`). Design approved in
chat on 2026-09-29.

## Goal

1. Every task carries one of four scopes (`backend`, `frontend`, `qa`, `design`) or none.
   Tasks Claude generates from a meeting never carry free text there.
2. A meeting task lands in the meeting's project automatically. Only a task whose project
   cannot be settled stays unlinked, and the reviewer is asked which project it belongs to.
3. The site's Team Board and Tasks tabs can be filtered by scope.

## Owner decisions

- Claude picks the scope; when it gives none (or an invalid one), the platform decides.
- Old free-text scopes move into Modules.
- "When the bot creates tasks from a meeting, if the meeting is for a project the tasks'
  project should automatically be that; only ambiguous ones should be not associated with
  projects and should ask which project to link."

## Current behaviour (what changes)

- CSAAS `generateMeetingTasks` (`Services/SysScripts/AIScripts/meetingAgents.js`) returns
  `project, platform, feature, sub_feature, …`. No scope.
- Bot `mapMeetingTaskToRow` (`bot/src/services/meetingTaskMap.js`) sets
  `scope = csaasTask.feature` (free text such as "GitSync") and
  `modules = [sub_feature]`.
- Bot `mirroredStage` (`bot/src/services/meetingPipelineStages.js`) sets the task's project
  from `matchProject(csaasTask.project)` only. The meeting's own project (`meeting.projectId`,
  set by `/meeting-channel`) is used for **channel placement only**; the task row does not
  get it.
- The review message (`bot/src/services/meetingReviewUI.js`) shows
  `Scope: feature > sub_feature` and has no project control.
- The site filters tasks in the browser (`applyFilters` in `src/screens/tasksLogic.ts`);
  there is no scope filter.

## Design

### 1. CSAAS: Claude picks the scope

- The task-generation prompt schema gains `"scope": "backend|frontend|qa|design"` with one
  instruction line: pick exactly one of the four, by where the work is done.
- Migration `data/migrations/20260929_1_meeting_tasks_scope.sql` adds
  `meeting_tasks.scope VARCHAR(16) NULL` after `sub_feature`.
- A small pure helper `normalizeMeetingTaskScope(value)` returns the lowercased trimmed
  value if it is one of the four, else `null`. It is applied wherever a `meeting_tasks` row
  is written with a scope: `generateTasks`, `addTask`, and `updateTask` (which gains
  `scope` in its allowed fields and its route's field list).
- `feature` and `sub_feature` are untouched in CSAAS; other CSAAS consumers keep working.
- The bot reads tasks via `SELECT *`, so `scope` reaches the bot with no API change.

### 2. Bot: only the four scopes

- `meetingTaskMap.js` exports `meetingTaskScope(csaasTask)`:
  1. `csaasTask.scope`, if valid (`isValidScope` from `bot/src/utils/taskScope.js`, after
     lowercasing and trimming);
  2. else by platform: `node`, `python` → `backend`; `react`, `react-native` → `frontend`;
  3. else `null`.
- `mapMeetingTaskToRow` uses it for `scope`. `modules` becomes the non-empty, de-duplicated
  list of `[feature, sub_feature]`.
- The review embed shows `Scope: Backend` (via `scopeLabel`) or `Scope: none`, and
  `Modules: GitSync, Task Hierarchy` when there are any.

### 3. Bot: meeting tasks get their project

The project is settled per task in this order:

1. **Meeting project** — `meeting.projectId`, when the meeting has one.
2. **Named project** — `matchProject(csaasTask.project, ctx)`, as today.
3. **Reviewer's pick** — otherwise the task is *unclear*.

A shared helper `loadProjectContext(db, job)` loads `{ projects, repos, links,
meetingProjectId }` once. It's used by both `awaitingReviewStage` and `mirroredStage`.

**At review time** (`awaitingReviewStage`):

- `initReviewState` gains per-task `needsProject` (true only for unclear tasks) and
  `projectId` (`null`).
- Each task embed shows `Project: <name>` for rules 1 and 2, or
  `Project: not set, pick one below` for an unclear task.
- An unclear task gets a string select, `mtg_project:<jobId>:<taskId>`, with placeholder
  "Which project?". Its options are the guild's projects sorted by name, capped at 24, plus
  "No project" (value `none`).
  - Discord allows 25 options, so a guild with more than 24 projects shows the first 24.
  - For a project past the first 24, the reviewer picks "No project" and sets it with
    `/update-task` after approval.
- `applyReviewAction` handles `{ type: 'project', taskId, projectId }`, where `none` is
  stored as `null`. `meetingReview.js` routes the new `mtg_project` kind.
- Page size is a function of state:
  - 1 when any task has `needsProject`, rejected or not;
  - otherwise 2 (today's `PAGE_SIZE`).

  An unclear task uses 3 component rows (assignee, project, buttons) and the footer uses
  1, so two such tasks would exceed Discord's 5-row limit. A rejected task still renders
  its rows, so it still counts. The builder and the page button both read the same
  function, so page numbers stay consistent.
- Approval is not blocked. An unclear task left untouched is approved with no project.

**At mirror time** (`mirroredStage`):

- `projectId` comes from rules 1 → 2 → the reviewer's `projectId` → `null`.
  - `projectName` is that project's row name. It is `null` when there is no project; the
    CSAAS spoken name is no longer kept.
  - `repositoryId` is the match's repository only when the match's project is the chosen
    project, else `null`. Sub-project 4 will pick repositories by scope.
- Channel placement follows the task's `projectId`. The old "placement only" fallback to
  the meeting project is now part of rule 1, and that comment is removed.
- Back-compat: a job already awaiting review at deploy time has no `needsProject` or
  `projectId` in its state. Its tasks resolve by rules 1 and 2, then `null`, which matches
  today's behaviour plus rule 1.

### 4. Bot migration 028: clean up old scopes

`bot/src/Database/migrations/028_task_scope_fixed_values.sql` is plain SQL, run once by
`run-migrations.js` and idempotent. On `task`:

1. A scope that, trimmed and lowercased, is one of the four becomes that value. Compare
   with `BINARY`, because the table collation is case-insensitive.
2. A blank scope becomes `NULL`.
3. Any other scope is appended to `modules`, unless `modules` already contains it. A
   `modules` value that is not a JSON array, including SQL `NULL`, counts as an empty
   array. The rollout preview counts such rows first. Then scope is set to `NULL`.

Afterwards every `task.scope` is one of the four or `NULL`, so a second run changes
nothing.

### 5. Site: Scope filter

- `Filters` gains `scope: 'all' | 'backend' | 'frontend' | 'qa' | 'design' | 'none'`, and
  `DEFAULT_FILTERS.scope = 'all'`.
- In `applyFilters`, a task matches `none` when its lowercased scope is not one of the four
  (null, blank, or legacy text), and matches a named scope on equality after lowercasing.
- `TeamLayout` adds a **Scope** `FilterSelect` (All, Backend, Frontend, QA, Design,
  No scope), shown on the Tasks and Board tabs only.
  - It is mirrored to `?scope=` the same way `?project=` is. An unknown value in the URL
    reads as `all`.
- People passes `scope: 'all'` explicitly (like its other overrides), so its counts are
  unaffected. Stats already builds from `DEFAULT_FILTERS`.
- The Team header's task and blocked counts ignore the scope on tabs without the Scope
  control, so a `?scope=` carried over from Tasks never narrows them invisibly.

## Testing

- **Bot (`node:test`, fakes only, per `tests-never-touch-production.md`):**
  - `meetingTaskScope`: valid, case variant, invalid, platform fallbacks, unknown platform.
  - `mapMeetingTaskToRow`: scope, modules and dedupe.
  - Review UI:
    - project line and select shown only when `needsProject`;
    - options capped at 24 plus "No project";
    - page size 1 versus 2;
    - no message exceeds 5 rows;
    - the `project` action.
  - `parseReviewCustomId` / route for `mtg_project`.
  - `mirroredStage`:
    - the meeting project wins over the named project;
    - named project;
    - reviewer's pick;
    - `none` gives `null` with no `projectName`;
    - `repositoryId` rule;
    - an old state without the new fields.
- **Migration 028:** SQL only, and there is no test database, so it has no unit test.
  - A test asserts the file exists and each statement carries its guard, so a second run
    is a no-op.
  - Before deploy, a read-only preview query counts the rows each step would change. It
    runs on production only with the owner's go-ahead, using env-var credentials.
- **CSAAS:** a standalone test for `normalizeMeetingTaskScope`, plus a mocked-`executeQuery`
  test that `generateTasks`, `addTask` and `updateTask` store only valid scopes.
- **Site (vitest):**
  - `applyFilters` for each scope value, including legacy text as `none`;
  - URL read and write for `?scope=`, including an unknown value;
  - People ignoring the scope.

## Rollout

Bot (runs migration 028) → CSAAS (manual deploy plus its migration) → site (Vercel).

- The new bot with the old CSAAS falls back to the platform.
- The old bot with the new CSAAS ignores the extra column.
- The site filter works on whatever scopes exist.

## Out of scope

- Repositories chosen by scope and GitHub issues per repository (sub-project 4).
- Any change to how `/create-task` or `/update-task` pick a scope. They already use the
  four values.

# JSON task import on the site

Sub-project 6 of the owner's roadmap (see `.claude/state/backlog.md`). Design approved in
chat on 2026-09-30. Touches the bot, CSAAS and the UBS-Doc site. No database change.

## Owner's request

"JSON task import with a documented format — imports only into your projects."

Answers given while designing:
- An imported task is made like a normal task (a Discord channel, and a GitHub issue
  unless switched off), **except a task that is already done: no channel**.
- A done task gets no GitHub issue either.
- One project per import, picked on the import screen. The file names no project.
- A task may carry assignees, modules and subtasks. Dependencies are out.
- Statuses in the file: `open`, `in_progress`, `done`. Missing means `open`.
- The site shows a preview; on confirm, the valid tasks are created and the invalid ones
  are skipped and listed.
- Anyone who can create a task on the site today may import, into a project they can
  create tasks in today.

## Current behaviour

- **Site create** (`src/screens/team/TaskCreate.tsx`, `createTask` in
  `src/components/discordTasks/api.ts`) posts one task to
  `POST /api/discord/tasks/create`.
- **CSAAS** (`DiscordTasks/discordTasksWrite.js` `createTask`): checks the portal
  permission (`PERMISSION`, on any URDD), shapes the body, `resolveIdentity`,
  `assertCanWrite`, `assertCanUseProject`, then `callBot('/internal/tasks/create')` with a
  45 s wait. `addSubtask` does the same for `/internal/tasks/subtask` with
  `{ parentId, title, holderIds }`.
- **Bot** (`services/internalTaskRoute.js` `handleCreateRequest`): `validateCreate`
  (`utils/taskEditRules.js`), the bug repository rule, then `createTask`
  (`services/taskCreate.js`), which always writes `status: 'open'` (feature) or
  `'pending'` (bug), creates the task's Discord channel, and opens a GitHub issue when
  `createIssue !== false` and a repository is found. `handleSubtaskRequest` creates a
  subtask (`services/taskHierarchy.js` `createSubtask`) with `status: 'open'`; a subtask
  has no channel of its own.
- **Limits already in the bot:** title 200, description 2000, 20 modules of 100
  characters, 50 people, 25 subtasks per task (`MAX_SUBTASKS`).
- **Statuses:** `TASK_STATUSES` = open, pending, in_progress, resolved, closed, done;
  `TERMINAL_STATUSES` = closed, done, resolved. The site's board maps all three terminal
  statuses to its Done column.
- There is no way to create several tasks at once, and no way to create a task that is
  already finished.

## Design

### 1. The file format (the contract users are given)

```json
{
  "tasks": [
    {
      "type": "feature",
      "title": "Patient search by CNIC",
      "description": "Staff can find a patient by typing a CNIC number.",
      "scope": "backend",
      "status": "in_progress",
      "modules": ["Patients", "Search"],
      "assignees": ["ali@example.com", "Sara Khan"],
      "subtasks": [
        { "title": "Search API endpoint", "description": "Returns matching patients.",
          "scope": "backend", "status": "done", "assignees": ["ali@example.com"] },
        { "title": "Search screen", "scope": "frontend", "assignees": ["Sara Khan"] }
      ]
    }
  ]
}
```

| Task field | Required | Allowed |
|---|---|---|
| `type` | yes | `feature`, `bug` |
| `title` | yes | text, 1–200 characters after trimming |
| `description` | no | text, up to 2000 characters |
| `scope` | no | `backend`, `frontend`, `mobile`, `qa`, `design` |
| `status` | no | `open` (default), `in_progress`, `done` |
| `modules` | no | up to 20 names of up to 100 characters; features only |
| `assignees` | no | up to 50 people: a verified email, or the Discord display name |
| `subtasks` | no | up to 25; each `title` (required), `description`, `scope`, `status`, `assignees` |

- The top level is an object with a `tasks` array of 1–50 tasks. A bare array is also
  accepted.
- Unknown fields are ignored. A `project`, `id` or `subtasks` inside a subtask is ignored,
  not an error.
- The file may be at most 90 KB. CSAAS's body parser (`express.json()` default, 100 KB) refuses a larger body before any handler runs, and that shared limit was left alone. (The bot's internal routes cap a request at 64 KB
  today; the import-check route alone takes up to 512 KB.)

### 2. Rules a task must pass (the preview's verdicts)

Every rule of the single create applies, through the same `validateCreate`, plus:

- **Assignees.** Each entry is matched within the project's guild against approved staff
  members: first by email (case-insensitive, trimmed), then by display name, then by
  username (case-insensitive, trimmed). Exactly one match is needed. None:
  `No member matches "<entry>".` Several: `"<entry>" matches more than one member — use
  their email.` The same person named twice counts once.
- **Status.** Anything other than the three values: `status must be open, in_progress or
  done.`
- **A done task with a subtask that is not done:** `A done task cannot have unfinished
  subtasks.`
- **Bug repository.** The existing rule: the project needs a repository for the bug's
  scope (`resolveTaskRepo`); otherwise `This project has no repository for this scope.`
  This applies to a done bug too, so every bug row carries its repository.
- **Subtasks.** Title required, the same length limits, at most 25.
- **Warnings (do not block):**
  - `A task with this title already exists in this project.` (case-insensitive match
    against the project's existing top-level tasks), and the same for a title repeated
    inside the file;
  - `No repository for this scope, so no GitHub issue will be opened.` for an open or
    in-progress feature when issues are on and the rule finds none.

A task is **valid** when it and all its subtasks pass. An invalid subtask makes its whole
task invalid: a task is never imported without part of what the file says it has.

### 3. Bot

- **`services/taskImport.js`** (new) — `checkImport({ db, cfg, project, tasks,
  createIssues })` returns `{ tasks: [{ index, ok, errors: [...], warnings: [...],
  fields }] }`, where `fields` is the task in the shape the create route takes
  (`holderIds` resolved, `status`, and `subtasks: [{ title, description, scope, status,
  holderIds }]`). Pure over its `db` seam; creates nothing.
- **`POST /internal/tasks/import-check`** `{ projectId, tasks, createIssues }` →
  `{ ok, tasks }`. 400 for a missing project, a non-array, more than 50 tasks. Uses
  `guarded` and `guildOf`.
- **`POST /internal/tasks/create`** gains one optional field:
  - `status` — `open` (today's behaviour, and the default), `in_progress`, or `done`.
    - `in_progress`: the task is created as today (channel, issue), then its status is
      set through the existing status-change path so the channel's card and the activity
      log agree with the row. No notification DM is sent for that first change.
    - `done`: the row is written with status `done` for both types (the status the
      board's Done column writes), **no channel is created and no issue is opened**;
      `discordChannelId` stays null. `createdBy` is recorded as for any site create.
- **`POST /internal/tasks/subtask`** gains optional `description`, `scope` and `status`
  (`open` | `in_progress` | `done`). A `done` subtask is written finished; nobody is
  notified of it.
- `createTask` and `createSubtask` stay the single writers: the new behaviour is
  parameters on them, not a second create path.

### 4. CSAAS

- **`POST /api/discord/tasks/import-check`** `{ project_id, tasks, create_issues? }`
  (in `discordTasksWrite.js`, the write-object pattern): the same permission, identity,
  `assertCanWrite` and `assertCanUseProject` checks as `createTask`, in the same order;
  shape checks (an array of 1–50 objects, the request at most 90 KB); then
  `callBot('/internal/tasks/import-check')`. It returns the bot's verdicts with `fields`
  so the site can send each valid task to create unchanged.
- **`createTask`** forwards optional `status`.
- **`addSubtask`** forwards optional `description`, `scope` and `status`.
- Nothing new is trusted from the site: a task sent to create after a preview goes
  through every create check again.

### 5. Site

- **Route** `/tools/team/tasks/import` and an **Import tasks** button beside the Tasks
  tab's create button, shown under the same condition as that button.
- **`importLogic.ts`** (pure, tested):
  - `parseImportFile(text)` → `{ tasks }` or `{ error }` (not JSON, no `tasks` array,
    empty, more than 50, over 90 KB), with messages a non-developer can act on;
  - the import queue: given the verdicts, the ordered steps (a task, then each of its
    subtasks), and the reducer that records each step as created / failed / skipped;
  - the summary line (`Imported 12 of 15 tasks. 2 were invalid and 1 failed.`).
- **`TaskImport.tsx`**:
  1. Project select (the projects the create form offers), a file picker (`.json`) and a
     paste box, and an **Open GitHub issues** checkbox (on by default).
  2. **Check file** → the preview: one row per task with its title, type, status, a tick
     or its errors, and any warnings; subtasks listed under it.
  3. **Import N tasks** → runs the queue one request at a time. A task row shows
     created (with a link to the task) or failed with the server's sentence. If a task's
     create fails, its subtasks are skipped. If a subtask fails, the task stays and the
     failure is listed.
  4. Leaving the page mid-import asks for confirmation (`beforeunload`); the list shows
     what was already made.
  5. **Download the failed and invalid tasks** as a JSON file in the same format, to fix
     and import again.
- **Format guide**: a section on the import screen ("File format") with the field table,
  the rules, and a **Download a sample file** button. The same text goes in
  `.claude/knowledge/`.

### 6. What does not change

- The single create form, `/create-task`, the meeting pipeline.
- Permissions: no new permission string.
- The database.

## Testing (fakes only; `.claude/rules/tests-never-touch-production.md`)

- **Bot:**
  - `taskImport.js`: each rule and warning above; assignee matching by email, display
    name and username, none, several, duplicates; the 50 and 25 caps; a done task with an
    open subtask; nothing is written.
  - `createTask` with `status: 'done'`: no channel call, no issue call, the finished
    status, `createdBy`; with `in_progress`: channel and issue as today,
    then the status change; with no `status`: byte-for-byte today's behaviour (existing
    tests unchanged).
  - `createSubtask` with `description`, `scope`, `status`.
  - The routes: auth, validation, pass-through.
- **CSAAS:** import-check's permission, link and project refusals; shape limits; `status`
  forwarded by create; subtask fields forwarded; a test that runs the real
  `resolveIdentity`.
- **Site (vitest):** `importLogic` — parsing and its error messages, the queue order, the
  reducer (created, failed, skipped-after-parent-failure), the summary, the download of
  leftovers.

## Rollout

Bot, then CSAAS, then the site. Each tolerates the next one being old: the site's import
screen against a CSAAS without `import-check` shows "Import is not available yet."; a
CSAAS that forwards `status` to a bot that ignores it would create a done task as an open
one with a channel — so the bot must be live before CSAAS.

## Out of scope

- Dependencies between imported tasks; estimates; test tracks; per-task repositories.
- Importing into several projects from one file.
- Exporting tasks.
- A background job: closing the tab stops the import.

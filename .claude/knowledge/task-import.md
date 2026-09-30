# JSON task import on the site

Roadmap sub-project 6 of 7 (owner roadmap, `.claude/state/backlog.md`). Built across the
bot, CSAAS and the site on branch `feat/task-import`; BUILT, NOT DEPLOYED and not merged
(as of 2026-09-30). No migration anywhere. Spec:
`docs/superpowers/specs/2026-09-30-json-task-import-design.md`. Same trust shape as the
site's other task-write routes (see [[project-tasks-site]]): the bot owns every rule about
the values, CSAAS checks permission and the shape of the request and asks the bot over
loopback, the site renders and drives the queue.

The flow: the user picks a project on `/tools/team/tasks/import`, chooses a JSON file, the
site parses it, asks the backend to **check** it (nothing is written), shows a verdict per
task, and on "Import" creates each valid task through the ordinary create and subtask
routes, one request at a time. There is no bulk-create endpoint and no `imported` flag on a
task.

## The file the user writes

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

This is the site's downloadable sample (`importSampleFile()` in `importLogic.ts`). The top
level is an object with a `tasks` array, or a bare array; a leading BOM is tolerated.

| Task field | Required | Rule |
|---|---|---|
| `type` | yes | `feature` or `bug` |
| `title` | yes | 1-200 characters |
| `description` | no | up to 2000 characters |
| `scope` | no | `backend`, `frontend`, `mobile`, `qa`, `design` |
| `status` | no | `open` (default), `in_progress`, `done` |
| `modules` | no | up to 20 names of up to 100 characters; features only |
| `assignees` | no | up to 50 people, each an email or a Discord name |
| `subtasks` | no | up to 25 |

A subtask takes `title` (required), `description`, `scope`, `status` (same values as a
task's) and `assignees`.

Limits and rules:
- 1-50 tasks per file; the file is at most **90 KB**. The spec first said 256 KB; that is
  not what was built (see "Why 90 KB" below).
- The file names no project: every task goes into the project picked on the screen.
- Unknown fields are ignored. A file cannot set `tracks` or `repositoryIds` (the check
  picks only the documented fields from an entry).
- A subtask cannot have subtasks.
- A done task is recorded as finished: no Discord channel, no GitHub issue. An open or
  in-progress task gets a channel and, unless "Open GitHub issues" is unticked, an issue.
- A done task must have every subtask done (`A done task cannot have unfinished subtasks.`).
- A bug needs a repository for its scope in the project.
- An assignee matches by email first, then display name, then username (case-insensitive,
  trimmed), among approved non-client members of the project's guild. A name that matches
  nobody, or more than one member, makes the task invalid; the same person named twice
  counts once.
- Two duplicate-title warnings, never errors: `A task with this title already exists in
  this project.` (a top-level task already in the project) and `This title appears more
  than once in the file.` They are distinct sentences.
- A feature with no repository for its scope gets the warning `No repository for this
  scope, so no GitHub issue will be opened.` (only when issues are on and the task is not
  done).

## Bot: `checkImport` and the verdict

`bot/src/services/taskImport.js`. `checkImport({ db, cfg, project, tasks, createIssues })`
reads only (members with `all: true`, repositories, the project's links, the project's
existing tasks up to 5000) and returns `{ tasks: [{ index, ok, errors, warnings, fields }] }`,
one verdict per file entry, in order.

- Every task rule is the create route's own: it calls `validateCreate` with only the
  documented fields (`type, title, description, scope, status, modules`, the resolved
  `holderIds`, `repositoryIds: []`). Member rows are filtered by `guildConfigId` in code as
  well as in the query, so another guild's member can never match.
- `ok: true` verdicts carry `fields`: the task's validated fields, an explicit `status`
  (`checkImport` always puts one in, `open` when the file named none), `repositoryIds: []`,
  `tracks` (`apiTests`, `qaTests`, `acceptanceCriteria`, all false), and `subtasks: [{ title, description, scope, status, holderIds }]`. `ok: false` verdicts
  carry `errors` and `fields: null`; subtask errors are prefixed `Subtask N: `.
- `resolveAssignees(entries, members)` is exported (email, then name, then username).
- `MAX_IMPORT_TASKS = 50`.

The route: `handleImportCheckRequest` in `bot/src/services/internalTaskRoute.js`, served at
`POST /internal/tasks/import-check` (wired in `bot/src/server.js`), same secret guard as the
other internal routes. It validates `projectId`, a non-empty `tasks` list of at most 50,
loads the project (`No project matches that id.`), needs the guild to be available (500
otherwise), and passes `createIssues !== false`.

### Body cap: 512 KB for this route only

`bot/src/utils/internalBodyCap.js`: `maxBodyFor(url)` gives the import-check route 512 KB
(`IMPORT_CHECK_MAX_BODY`); every other internal route stays at 64 KB
(`INTERNAL_MAX_BODY`). The bot could take more than the site ever sends; the limit that
actually binds is CSAAS's.

## Bot: `status` on create and on a subtask

`validateCreate` (`bot/src/utils/taskEditRules.js`) includes `fields.status` **only when the
request names one**; a create with no `status` is exactly the request it always was.
`statusOf(value)` returns `[error|null, status]`: missing or null is `open`; anything not in
`IMPORT_STATUSES = ['open', 'in_progress', 'done']` gives `status must be open, in_progress
or done.`

`createTask` (`bot/src/services/taskCreate.js`):
- `open` or no status: today's path. A bug created this way still gets its normal initial
  status, `pending`.
- `done`: the row is written with status `done` (a done bug's row is `done` too, not
  `pending`), with **no channel and no issue**; the result is `channel: null, issue: null`.
- `in_progress`: created normally, then moved through `applyTaskUpdate` with a no-op notify
  (the creation already told everyone). If that move fails the failure is logged and the
  create still succeeds; the task stays open. The `setStatus` seam lets tests fake it.

`createSubtask` (`bot/src/services/taskHierarchy.js`) writes `done` or `in_progress` when the
fields say so, else `open`. A subtask created `done` **notifies nobody and does not re-sync
its parent**: the parent keeps the status it has. Consequence: a task imported as open whose
subtasks are all done stays open until someone finishes it.

Known quirk: a done feature is stored with `implementationStatus: 'not_started'` (the
backlog lists it).

## CSAAS: the endpoint

`Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksWrite.js`. The route
`POST /api/discord/tasks/import-check` is served by the global
`DiscordTasksImport-check_object` (the router keeps the hyphen in the name). Guards, in
the same order as create: `update_discord_tasks` via `requirePortalPermission`, then the
shape (`project_id`, 1-50 plain-object `tasks`, `create_issues` a boolean when present, the
`tasks` JSON at most **90 KB**), then `resolveIdentity`, `assertCanWrite`,
`assertCanUseProject`, `botConfig`, and `callBot('/internal/tasks/import-check')` with a 45 s
timeout. No actor is sent (nothing is written). A bot 404 (an older bot with no such route)
becomes `503 Import is not available yet.` The create and subtask routes now forward
`status` when the request names one (absent is not forwarded).

The framework does not strip payload keys that are not listed in an object's declared
`fields`, so the handlers read the payload directly; the declared `fields` lists for
Create/Subtask do not name the new keys (documentation only, backlog).

### Why 90 KB

CSAAS's body parser (`express.json()` default, 100 KB, `Src/Config/Security/securityConfig.js`)
refuses a larger body before any handler runs. That shared limit was deliberately left
alone, so the file cap is 90 KB, under it. A file with many long descriptions must be split
to fit.

## Site: the import screen

`src/screens/team/TaskImport.tsx` (route `tasks/import`, linked from the Tasks list) and the
pure `src/screens/team/importLogic.ts`; the API wrappers are in
`src/components/discordTasks/api.ts` (`checkImport(projectId, tasks, createIssues)`).

- `parseImportFile(text)` checks size (90 KB), JSON validity, a `tasks` list (or bare array),
  non-empty, at most 50; entries pass through untouched, the backend validates them. A
  backend 404 or 503 on the check shows `Import is not available yet.`
- The queue (`importSteps`) is the valid tasks in file order, each followed by its subtasks,
  and it is **sequential**: one request at a time. `createInputFor` turns a verdict's fields
  into the create wrapper's input (no `tracks`, no `repositoryIds`; the bot resolves the
  repository). A subtask is created with the id of its created parent.
- A task that fails marks its subtasks `skipped` (`The task was not created.`).
- A create that fails with a 5xx or a network error is `unconfirmed` (`createMayHaveSucceeded`):
  it may have been created, so it is kept OUT of the leftover file, counted separately in the
  summary (`N could not be confirmed — check the Tasks list.`), never retried, and its
  subtasks are skipped.
- **Leftover file:** `leftoverFile` returns the original entries that were invalid or whose
  task failed, unchanged and in file order, as `{ tasks }`; downloaded as
  `tasks-not-imported.json`. A created task with failed subtasks is not in it (the task
  exists).
- While an import runs, a full-viewport overlay rendered through a portal to `document.body`
  blocks the app's own navigation (inside the layout's `relative z-10` column it would rank
  below the fixed sidebar), and a `beforeunload` guard warns on closing the tab. The app uses
  `<BrowserRouter>`, so `useBlocker` is unavailable; the browser's Back button is NOT
  blocked.
- The screen also downloads the sample file, shows the format table and rules
  (`FORMAT_TASK_FIELDS`, `FORMAT_SUBTASK_FIELDS`, `FORMAT_RULES`) and refreshes the task
  payload when the run ends.

### Final-review fixes (2026-09-30)

- **Pacing and rate limit:** the queue starts consecutive requests at least 700 ms apart
  (`IMPORT_PACE_MS`, `paceDelay`). CSAAS allows 100 requests a minute per IP and answers the
  rest with a 429 before any handler runs, so a 429 step created nothing: the queue waits
  20 s and retries the same step, at most 3 times (`retryDelayFor`; the row shows
  `Waiting — the server is busy…`). Still 429 after that: a plain `failed` step
  (`The server is busy — too many requests. Try again in a minute.`), so it goes to the
  leftover file.
- **"Created" is a link only after the import finishes.** While it runs it is plain text
  (a link would unmount the screen and abandon the queue), and `#root` is `inert` so focus
  cannot reach the sidebar; the overlay is portalled to `document.body`, outside `#root`.
- **The create `note`** (a failed GitHub issue, a full section falling back) is kept on the
  created step (`createdResult`) and shown under its row in amber.
- **Bot notifier:** `notifyTaskUpdate` does not create a channel for a task that was already
  finished and stays finished, so editing imported history opens nothing. Reopening a done
  task, or closing a task in the update that first assigns it, still creates the channel.

## Rollout order: bot, then CSAAS, then site

1. Bot first (no migration). It MUST be live before CSAAS: a CSAAS that forwards `status` to
   an older bot would create a done task as an open one with a channel (the older bot ignores
   the key).
2. CSAAS (auto-deploys; migrations, none here, run at startup).
3. The site (Vercel). Until the bot and CSAAS are live the site's check shows `Import is not
   available yet.`

## Tests

Bot: `bot/src/services/taskImport.test.js`, `internalTaskRoute.test.js`,
`taskCreate.test.js` and `taskHierarchy.test.js` (status cases), all with `db`/`getConfig`
fakes (see `.claude/rules/tests-never-touch-production.md`). CSAAS:
`CSAAS_Backend/Services/SysScripts/TestScripts/discord-tasks-test/import.test.js` (plus the whole `discord-tasks-test/*.test.js` loop).
Site: `src/screens/team/importLogic.test.ts`.

# JSON Task Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A site user who can create tasks can load a JSON file of up to 50 tasks (with assignees, modules and subtasks), preview each task's verdict, and import the valid ones into one project — open and in-progress tasks made as normal tasks, done tasks recorded as finished with no channel and no issue.

**Architecture:** The bot's one create path (`createTask`, `createSubtask`) gains a `status` parameter, and a new pure service checks a whole file without writing. CSAAS adds one check endpoint with the create endpoint's guards and forwards the new fields. The site parses the file, shows the bot's verdicts, then creates the valid tasks one request at a time through the existing create and subtask endpoints.

**Tech Stack:** Bot: Node ESM, discord.js v14, `node:test`. CSAAS: Node CommonJS, UBS framework, jest + standalone node test scripts. Site: React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-json-task-import-design.md`

## Global Constraints

- A create with no `status` behaves byte-for-byte as today: the existing tests in `bot/src/services/taskCreate.test.js`, `taskHierarchy.test.js` and `internalTaskRoute.test.js` pass unchanged.
- `status` in a file or a create request is `open`, `in_progress` or `done`; anything else is refused with `status must be open, in_progress or done.`
- A `done` task: row status `done` for both types, **no Discord channel, no GitHub issue**, `discordChannelId` null. A `done` subtask is written finished and nobody is notified.
- An `in_progress` task is created as today (channel, issue), then moved to `in_progress` through the existing status-change path with no notification DM.
- Limits: 1–50 tasks per file; 25 subtasks per task; title 1–200; description ≤ 2000; ≤ 20 modules of ≤ 100 characters, features only; ≤ 50 assignees; file ≤ 256 KB.
- Assignee matching, within the project's guild, approved non-client members only: email, then display name, then username (case-insensitive, trimmed); exactly one match. Verbatim: `No member matches "<entry>".` and `"<entry>" matches more than one member — use their email.`
- Other verbatim strings: `A done task cannot have unfinished subtasks.`; `This project has no repository for this scope.`; warnings `A task with this title already exists in this project.`, `This title appears more than once in the file.`, `No repository for this scope, so no GitHub issue will be opened.`; site `Import tasks`, `Check file`, `Open GitHub issues`, `Import is not available yet.`
- An invalid subtask makes its whole task invalid.
- CSAAS import-check uses exactly the create endpoint's guards in the same order: `requirePortalPermission(PERMISSION)` (`update_discord_tasks`), `resolveIdentity`, `assertCanWrite`, `assertCanUseProject`. Any DiscordTasks file that passes hooks to `resolveIdentity` must include `actorIsRoleAdmin` in them, and at least one test per new handler must run the real `resolveIdentity`.
- No database change. No new permission string.
- Bot tests use fakes for every `db`/`getConfig` seam — never the default `db`, never a real server (`.claude/rules/tests-never-touch-production.md`; the root `.env` is production). Never read any `.env`.
- Commits: `git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit ...`; message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` — exactly that.
- A piped test summary can exit 0 while red: read `ℹ fail` (bot), `Tests:` (jest), vitest's `Tests` line.

## Workspaces

- Bot: `D:\Work\Granjur Technologies\Granjur-Discord-Bot`, branch `feat/task-import` (checked out). Tasks 1, 2, 6.
- CSAAS: `D:\Work\Granjur Technologies\CSAAS_Backend`, create `feat/task-import` from `main` (leave its untracked `.bridge/`, `.worktrees/`, `data/migrations_completed/*` alone). Task 3.
- Site: never touch `D:\Work\Granjur Technologies\UBS-Doc`. Worktree `D:\Work\Granjur Technologies\UBS-Doc-task-import`, branch `feat/task-import` from `origin/main`, `npm ci`. Tasks 4, 5.

## Review Focus

1. A file task naming a person who is a client, unapproved, or in another guild must not resolve to them — Task 2 test.
2. A done task must never create a channel or an issue, even when the project has a repository and issues are on — Task 1 test.
3. A preview verdict must not be trusted at create time: a task altered between preview and create (or sent straight to create) goes through every create check again — Task 3 test (status forwarded, guards unchanged) and Task 1 (the route validates `status`).
4. A parent that fails to create must not leave the site creating its subtasks under some other task; a subtask that fails must be reported, not swallowed — Task 4 test.
5. A file that is not JSON, is an empty list, has 51 tasks, or is over the size cap must give a sentence a non-developer can act on, not a stack trace or a silent nothing — Task 4 test.

---

### Task 1: Bot — `status` on create and on subtasks

**Files:**
- Modify: `bot/src/services/taskCreate.js`, `bot/src/services/taskHierarchy.js`, `bot/src/services/internalTaskRoute.js`, `bot/src/utils/taskEditRules.js`
- Test: `bot/src/services/taskCreate.test.js`, `bot/src/services/taskHierarchy.test.js`, `bot/src/services/internalTaskRoute.test.js`, `bot/src/utils/taskEditRules.test.js` (add cases; existing cases unchanged)

**Interfaces:**
- Consumes (existing): `createTask({ db, guild, cfg, fields, project, repo, actor, createChannel, openIssue, getCategory, createIssue })`; `createSubtask({ db, client, guild, parent, fields, actor, notify, apply })`; `applyTaskUpdate` (`services/taskStatusChange.js`); `validateCreate(input, ctx)`.
- Produces:
  - `IMPORT_STATUSES = ['open', 'in_progress', 'done']` and `statusOf(value)` → `[error|null, status]` in `utils/taskEditRules.js` (missing/null → `'open'`; error text `status must be open, in_progress or done.`). `validateCreate` returns `fields.status` (default `'open'`).
  - `createTask` honours `fields.status`:
    - absent or `'open'` → exactly today's code path;
    - `'done'` → the row is written with `status: 'done'` (feature and bug), the ticket doc is still created, **`createChannel` and `openIssue` are not called**, returns `{ task, channel: null, fellBack: null, issueUrl: null, issue: null }`;
    - `'in_progress'` → today's path, then `applyTaskUpdate({ db, client: null-safe, task, updates: { status: 'in_progress' }, actor, guild, notify: async () => {} })` (an injectable `setStatus` seam defaulting to a wrapper over `applyTaskUpdate`, so tests pass a fake); the returned `task` carries the new status. A failure of that status change is logged and does not fail the create (the task exists; it stays open).
  - `createSubtask` honours `fields.description`, `fields.scope` (already stored) and `fields.status`: `'done'` → the child row is written with `status: 'done'` and `notify` is **not** called; `'in_progress'` → written with `status: 'in_progress'`, notify as today; absent → today.
  - `POST /internal/tasks/create` accepts `status` (validated by `validateCreate`); the 200 body's `task.status` is the created status, and `note` omits the placement/issue lines for a done task.
  - `POST /internal/tasks/subtask` accepts optional `description` (string ≤ 2000), `scope` (the five scopes or null) and `status` (`statusOf`); 400 with the rule's sentence otherwise.

- [ ] **Step 1: Write the failing tests** (fakes only, following each file's existing fakes):
  1. `statusOf`: undefined/null → open; the three values; `'closed'`, `''`, `5` → the error sentence. `validateCreate` returns `fields.status`.
  2. `createTask` feature `status: 'done'`: row written with `status: 'done'`; `createChannel` fake never called; `openIssue` fake never called even with a resolvable repository and `createIssue: true`; result `channel: null, issue: null`.
  3. `createTask` bug `status: 'done'`: the same, row `status: 'done'`, repository id still stored.
  4. `createTask` `status: 'in_progress'`: channel and issue as today; the `setStatus` fake called once with `{ status: 'in_progress' }`; a `setStatus` that throws still returns the created task.
  5. `createTask` with no status: the existing tests, untouched, still pass (assert by not editing them).
  6. `createSubtask` `status: 'done'`: child row `status: 'done'`, `notify` fake not called, parent activity still recorded; with `description` and `scope`: stored; with no status: today's behaviour.
  7. Route create: `status: 'done'` passes through to the `create` seam's `fields.status`; `status: 'nope'` → 400 with the sentence; the 200 body has `task.status: 'done'`.
  8. Route subtask: `description`, `scope`, `status` passed to the `addSubtask` seam; bad scope / over-long description / bad status → 400.
- [ ] **Step 2: Run** `node --test bot/src/services/taskCreate.test.js bot/src/services/taskHierarchy.test.js bot/src/services/internalTaskRoute.test.js bot/src/utils/taskEditRules.test.js` → the new cases FAIL, the old ones pass.
- [ ] **Step 3: Implement.** Keep one create path: branch inside `createTask` after the row is written, do not copy the feature/bug blocks.
- [ ] **Step 4: Run** the four files, then `npm test` → `ℹ fail 0`. `git diff` shows no edits to existing test cases (additions only).
- [ ] **Step 5: Commit** `feat(tasks): create a task or subtask with a status; a done task gets no channel and no issue`.

---

### Task 2: Bot — the import check and its route

**Files:**
- Create: `bot/src/services/taskImport.js`, `bot/src/services/taskImport.test.js`
- Modify: `bot/src/services/internalTaskRoute.js` (handler), `bot/src/server.js` (route + a per-route body cap), their tests

**Interfaces:**
- Consumes: `validateCreate`, `statusOf`, the scope/title/description helpers (`utils/taskEditRules.js`); `resolveTaskRepo`, `loadProjectLinks` (`services/taskRepo.js`); `MAX_SUBTASKS` (`utils/taskHierarchy.js`); `db.guildMember.findMany({ where: { guildConfigId, all: true } })` (rows carry `discordId`, `email`, `displayName`, `username`, `status`, `kind`); `db.repository.findMany`; the project's existing top-level tasks (find the db call the tasks payload or `/tasks` command uses to list a project's tasks).
- Produces:
  - `MAX_IMPORT_TASKS = 50`
  - `async checkImport({ db, cfg, project, tasks, createIssues = true })` → `{ tasks: [{ index, ok, errors: string[], warnings: string[], fields: object|null }] }`. `fields` (only when `ok`) = `{ type, title, description, scope, status, modules, holderIds, repositoryIds: [], tracks: {…all false}, subtasks: [{ title, description, scope, status, holderIds }] }`. Writes nothing.
  - `resolveAssignees(entries, members)` → `{ ids: string[], errors: string[] }` (exported for tests): staff = `status === 'approved' && kind !== 'client'`; match email, then displayName, then username, case-insensitive and trimmed; duplicates collapse; the two verbatim error sentences.
  - `handleImportCheckRequest({ headers, body, db, client, secret, check = checkImport })` at `POST /internal/tasks/import-check`, body `{ projectId, tasks, createIssues? }` → 200 `{ ok: true, tasks }`; 400 for a missing/unknown project, `tasks` not an array, empty, or more than 50 (`A file can hold at most 50 tasks.`); 500 when the guild is unavailable.
  - `server.js`: this one route reads up to 512 KB; every other internal route keeps `INTERNAL_MAX_BODY` (64 KB).

- [ ] **Step 1: Write the failing tests** `taskImport.test.js` with an in-memory fake db:
  1. a minimal valid feature → `ok`, `fields.status: 'open'`, `holderIds: []`;
  2. every `validateCreate` refusal surfaces as that task's error (bad type, empty title, title 201, description 2001, bug with modules, 21 modules);
  3. a non-object entry → error `Each task must be an object.`;
  4. assignees: by email (mixed case, spaces), by display name, by username; none → the sentence; two members sharing a display name → the sentence; the same person twice → one id; a client, a pending member, and a member of another guild are never matched (Review Focus 1);
  5. status: bad value → the sentence; `done` parent with an `open` subtask → `A done task cannot have unfinished subtasks.`; `done` parent with all-done subtasks → ok;
  6. subtasks: missing title, 26 subtasks, a bad subtask scope → the parent is not ok and the error names the subtask (`Subtask 2: …`);
  7. bug with no repository for its scope → `This project has no repository for this scope.`; with one → ok;
  8. warnings: an existing project task with the same title (case-insensitive); the same title twice in the file (on the second); an open feature with `createIssues: true` and no repository → the no-issue warning; none of them when `createIssues: false` or the task is done;
  9. nothing is written: the fake db's write methods are never called;
  10. route: auth as the other routes; the 400s; passes `{ cfg, project, tasks, createIssues }` to the `check` seam; a 300 KB body is accepted on this route while `/internal/tasks/create` still rejects it (test the cap selection as a pure function, e.g. `maxBodyFor(url)`, not with a real listener).
- [ ] **Step 2: Run** `node --test bot/src/services/taskImport.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file, `internalTaskRoute.test.js`, `node --check bot/src/server.js`, then `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(import): check a file of tasks without creating anything`.

---

### Task 3: CSAAS — the check endpoint, and forwarding the new fields

Work in `D:\Work\Granjur Technologies\CSAAS_Backend`: `git checkout -b feat/task-import main`.

**Files:**
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksWrite.js`
- Test: `Services/SysScripts/TestScripts/discord-tasks-test/import.test.js` (new, standalone node script in the siblings' style); extend the existing create/subtask test script only by adding cases

**Interfaces:**
- Consumes: the file's own `writeObject`, `__hooks`, `PERMISSION`, `textOf`/`idOf`/`idsOf`/`listOf`, `siteActor`, `actorWithLink`, `callBot`, `botConfig`; `assertCanWrite`, `assertCanUseProject` (`visibility.js`).
- Produces:
  - `POST /api/discord/tasks/import-check` (`global.DiscordTasksImportCheck_object`, registered the way `DiscordTasksCreate_object` is) — payload `{ project_id, tasks, create_issues? }` → `{ tasks: [{ index, ok, errors, warnings, fields }] }` from the bot. Guards in the create endpoint's order. Shape: `project_id` required; `tasks` an array of 1–50 plain objects (`tasks must be a list of 1 to 50 tasks`); `create_issues` boolean when present; the serialized `tasks` at most 256 KB (`The file is too large — 256 KB at most.`). `callBot('/internal/tasks/import-check', { projectId, tasks, createIssues })` with a 45 s wait.
  - `createTask` forwards `status` when the payload has it (`status: textOf(p.status, 'status')`), otherwise not at all.
  - `addSubtask` forwards `description`, `scope`, `status` when present.
  - A bot 404 on the new route (an older bot) → 503 `Import is not available yet.`
  - Before relying on the 256 KB cap, find the framework's own request-body limit (the JSON body parser / the decrypt step) and `callBot`'s. If either is below ~300 KB for this endpoint, report it (DONE_WITH_CONCERNS) with the exact limit and where it is set rather than raising a global limit.

- [ ] **Step 1: Write the failing test script** covering: no permission → 403; unlinked non-admin → the existing write refusal; a project the caller cannot use → the existing refusal, bot never called; each shape 400; the happy path calls the bot route with `{ projectId, tasks, createIssues }` and returns its `tasks`; `create_issues` absent → `createIssues` not sent or true (match the create endpoint's convention); the older-bot 404 → 503 with the sentence; create forwards `status`, and omits it when absent; subtask forwards the three fields, and omits them when absent; one case per handler running the real `resolveIdentity` through the `executeQuery` and `actorIsRoleAdmin` fakes.
- [ ] **Step 2: Run** `node Services/SysScripts/TestScripts/discord-tasks-test/import.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new script and the loop `for f in Services/SysScripts/TestScripts/discord-tasks-test/*.test.js; do node "$f" >/dev/null 2>&1 || echo "FAILED $f"; done` → no `FAILED`; `npx jest Services/SysScripts/TestScripts/portalAnyUrddPermission.test.js` → passes.
- [ ] **Step 5: Commit** `feat(discord-tasks): check a task import file; create with a status`.

---

### Task 4: Site — import logic and API wrappers

Work in the worktree `D:\Work\Granjur Technologies\UBS-Doc-task-import` (see Workspaces).

**Files:**
- Create: `src/screens/team/importLogic.ts`, `src/screens/team/importLogic.test.ts`
- Modify: `src/components/discordTasks/api.ts`

**Interfaces:**
- `api.ts`:
  - `checkImport(projectId: string, tasks: unknown[], createIssues: boolean)` → `{ tasks: ImportVerdict[] }` (`POST /discord/tasks/import-check`, body `{ project_id, tasks, create_issues }`);
  - `createTask` input gains optional `status`; `addSubtask(parentId, title, holderIds, extra?: { description?: string | null; scope?: string | null; status?: string })` — existing callers unchanged;
  - types `ImportFields`, `ImportSubtaskFields`, `ImportVerdict { index: number; ok: boolean; errors: string[]; warnings: string[]; fields: ImportFields | null }`.
- `importLogic.ts` (pure — no React, no fetch, no DOM):
  - `MAX_IMPORT_TASKS = 50`, `MAX_IMPORT_BYTES = 256 * 1024`
  - `parseImportFile(text: string)` → `{ tasks: unknown[] } | { error: string }`. Accepts `{ "tasks": [...] }` or a bare array. Errors, verbatim: `This is not valid JSON: <parser message>`; `The file needs a "tasks" list.`; `The file has no tasks.`; `A file can hold at most 50 tasks — this one has <n>.`; `The file is too large — 256 KB at most.` (size measured in UTF-8 bytes).
  - `ImportStep` = `{ key: string; kind: 'task' | 'subtask'; taskIndex: number; subIndex?: number; title: string }`; `importSteps(verdicts)` → the ordered steps for the valid tasks only: each task, then its subtasks.
  - `StepState` = `'pending' | 'running' | 'created' | 'failed' | 'skipped'`; `ImportRun = Record<string, { state: StepState; message?: string; taskId?: string }>`; `initialRun(steps)`; `applyStepResult(run, steps, key, result)` where result is `{ ok: true; taskId: string } | { ok: false; message: string }` — a failed **task** step marks all of that task's subtask steps `skipped` with `The task was not created.`; a failed subtask marks only itself.
  - `nextStep(run, steps)` → the first `pending` step or null.
  - `importSummary(verdicts, run, steps)` → e.g. `Imported 12 of 15 tasks. 2 were invalid and 1 failed.` (counts tasks, not subtasks; omits the zero parts: `Imported 15 of 15 tasks.`), plus ` <n> subtasks failed.` when any did.
  - `leftoverFile(originalTasks, verdicts, run, steps)` → a `{ tasks: [...] }` object holding, in file order, the original entries that were invalid or whose task step failed (unchanged), and for a created task with failed subtasks nothing (its task exists).
  - `importSampleFile()` → the sample object from the spec's format section.

- [ ] **Step 1: Write the failing tests** for every function: each parse error sentence, the bare-array form, the 50/51 boundary, the byte cap with a multi-byte character; step order for two tasks with subtasks, invalid tasks excluded; the reducer (created, failed task → subtasks skipped, failed subtask → siblings still pending); `nextStep` skipping non-pending; the summary's four shapes; `leftoverFile` contents and order; the sample parses through `parseImportFile`.
- [ ] **Step 2: Run** `npx vitest run src/screens/team/importLogic.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** `feat(team): task import — parsing, the import queue and the API wrappers`.

---

### Task 5: Site — the import screen

**Files:**
- Create: `src/screens/team/TaskImport.tsx`
- Modify: `src/app/routes.tsx` (route `tasks/import`, beside `tasks/new`), `src/screens/team/TasksList.tsx` (the button)

**Interfaces:**
- Consumes: everything Task 4 produces; `useTeam()` (payload, refresh); `useActingPermissions().hasOnAnyRole('update_discord_tasks')`; the project list the create form (`TaskCreate.tsx`) offers — reuse its source, do not re-derive it; `plainRuleMessage`; `Toast`.
- Produces the screen at `/tools/team/tasks/import`:
  1. Header `Import tasks`, a back link to the Tasks tab (keeping the query string).
  2. Project select (preselected from `?projectId=`), a file input (`accept=".json,application/json"`), a paste textarea, and the `Open GitHub issues` checkbox (checked by default). Choosing a file fills the textarea with its text.
  3. `Check file` (disabled without a project or text): runs `parseImportFile`; a parse error is shown in place; otherwise `checkImport`. A 503/404 → `Import is not available yet.`; other errors → the server's sentence.
  4. The preview: one row per task — title, type, status, a tick or its errors (red), warnings (amber), its subtasks indented. Above it: `<v> of <n> tasks can be imported.`
  5. `Import <v> tasks` (disabled at 0, and while running): walks `nextStep` one request at a time — a task step calls `createTask({ ...fields, projectId, createIssue })` and keeps the returned task id; a subtask step calls `addSubtask(parentTaskId, title, holderIds, { description, scope, status })`. Each row shows running / created (a link to `/tools/team/tasks/<id>`) / failed (the sentence) / skipped.
  6. While running: a `beforeunload` guard, and the project/file controls disabled. Changing the file or project after a check clears the preview.
  7. When finished: the `importSummary` line, `refresh()` of the Team payload once, and — when there are leftovers — `Download the tasks that were not imported` (a `.json` from `leftoverFile`).
  8. A collapsible `File format` section: the field table, the rules, and `Download a sample file` (from `importSampleFile`).
- `TasksList.tsx`: an `Import tasks` link beside the existing create button, under the same `canCreate` condition, carrying the current query string.
- Users without the permission who open the URL see the same refusal the create screen shows.

- [ ] **Step 1:** Build the screen on Task 4's logic; no new pure logic goes into the component (add it to `importLogic.ts` with a test if it turns out to be needed).
- [ ] **Step 2: Run** `npx vitest run`, `npx tsc --noEmit`, `npm run build` → all clean.
- [ ] **Step 3: Commit** `feat(team): the task import screen`.

---

### Task 6: Full suites, knowledge and state

**Files:** `.claude/knowledge/task-import.md` (new) + a README index line + a pointer in `project-tasks-site.md`; `.claude/state/backlog.md`, `.claude/state/completed.md`, `.claude/state/session.md`.

- [ ] **Step 1:** bot `npm test` (`ℹ fail 0`); CSAAS `import.test.js` + the discord-tasks script loop + the jest file; site `npx vitest run` and `npx tsc --noEmit` in the worktree.
- [ ] **Step 2: Knowledge** — `task-import.md`: the file format and limits (the user-facing contract); the check service and its verdict shape; how `status` changes `createTask`/`createSubtask` (done = no channel, no issue, no notify); the 512 KB per-route cap; CSAAS's endpoint and guards; the site's queue (one request at a time, a failed task skips its subtasks), leftovers download; rollout order and why the bot goes first.
- [ ] **Step 3: State** — backlog: roadmap item 6 → BUILT, NOT DEPLOYED, rollout bot → CSAAS → site; completed: a 2026-09-30 entry with commits per repo; session: current state.
- [ ] **Step 4: Commit** `docs: JSON task import — knowledge and state`.

---

## Rollout (after merge; each push needs the owner's go-ahead)

1. Push the bot's `main` (no migration). It must be live before CSAAS: a CSAAS that forwards `status` to an older bot would create a done task as an open one with a channel.
2. Push CSAAS `main` (auto-deploys).
3. Push the site (Vercel).

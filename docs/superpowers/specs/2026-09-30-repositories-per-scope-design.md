# Repositories per scope and GitHub issues for every task

Sub-project 4 of the owner's roadmap (see `.claude/state/backlog.md`). Design agreed in
chat on 2026-09-29/30. Touches the bot, CSAAS and the UBS-Doc site.

## Owner's request

"Let a project have multiple repositories and be associated with a scope
(backend/frontend) so a task's scope selects the applicable repo and creates git issue."

Answers given while designing:
- Issues are opened for every task (bugs and features) whose repository is found, with a
  per-task opt-out.
- A project has at most one repository per scope.
- Links are managed in Discord (`/projects`, `/repos add`). The site shows them read-only.
- Add a **Mobile** scope. `react-native` meeting tasks default to Mobile.
- A GitHub bot account's PAT reaches every repository under **ubs-dev-org**. Other owners
  (aashir-adnan, granjurtech, itulahore, ilmversity) keep the existing token.
- The fallback to a project's single untagged repository stays.

## Current behaviour (what changes)

- **`project_repos`** is `project_id, repository_id, createdAt`, with no scope. It is
  written by `/repos add` (optional project) and `/projects` → Link repo. There is no
  way to remove a link.
- **GitHub issues:**
  - Only bugs get an issue, in `taskCreate.js`, using the single repository the creator
    picks from every repository in the server.
  - Failures are swallowed silently.
  - One token, `GITHUB_TOKEN`, is used for every repository (`bot/src/services/github.js`).
- **Meeting-task issues** are opened by CSAAS (`csaasClient.issueSync`, CSAAS's own
  token). The repository is matched by the project name Claude heard. A project with
  more than one linked repository gets no repository (`meetingTaskProject.js`).
- **The meeting review's per-task "GitHub" switch** starts off.
- **The site's create page** has a repository picker listing every repository in the
  server. The CSAAS payload's `repositories` is that same server-wide list.
- **Scopes** are four: backend, frontend, qa, design.

## Design

### 1. Data: a scope on each project–repository link

Bot migration `030_project_repo_scope.sql`:
- adds `project_repos.scope VARCHAR(16) NULL`;
- adds a unique key `(project_id, scope)`. MySQL allows several NULLs under a unique key,
  so untagged links are unaffected.

It is guarded so it can run twice. Existing links stay untagged.

The db layer (`db.projectRepos`) gains:
- `setScope({ project_id, repository_id, scope })`;
- `remove({ project_id, repository_id })`;
- `findManyForProject(projectId)`, returning `{ repositoryId, scope }` rows.

### 2. The Mobile scope

The fixed scopes become `backend`, `frontend`, `mobile`, `qa`, `design` (label "Mobile").
The change reaches every place the list lives:

| Repo | Where |
|---|---|
| Bot | `utils/taskScope.js` `SCOPE_CHOICES`. Its order Backend, Frontend, Mobile, QA, Design drives the Discord pickers. |
| Bot | The meeting platform fallback: `react-native` → `mobile`. `react` stays → `frontend`. |
| CSAAS | `normalizeMeetingTaskScope`'s list; the task-generation prompt's `"scope"` enum and SCOPE RULE (mobile apps, React Native, iOS and Android are `mobile`). |
| Site | `SCOPE_LABEL`, `SCOPE_FILTERS`, the scope tone and colour, and the create/edit form's scope options. |

Migration 028 already ran. `mobile` is valid from now on, and old free-text scopes are
unaffected.

### 3. Which repository a task uses: one rule, in the bot

A new module, `bot/src/services/taskRepo.js`, exports
`resolveTaskRepo({ projectId, scope }, { links, repos })`, which returns
`{ repository, reason }`:

1. The repository linked to `projectId` with `scope` (reason `'scope'`).
2. Otherwise, if the project has exactly one link and that link has no scope, its
   repository (reason `'only-repo'`).
3. Otherwise `null`, with reason `'no-project'`, `'no-scope'` or `'no-repo-for-scope'`.

The rule is used by `/create-task`, the site's create route, and the meeting pipeline.
Rule 2 is also why a project with one untagged repository keeps working until it is
tagged.

### 4. GitHub tokens per owner

`bot/src/services/github.js`:
- **The per-owner map.** A new setting, `GITHUB_TOKENS`, maps owners to tokens:
  `owner:token` pairs separated by commas, owner compared case-insensitively.
  `tokenFor(owner)` returns the owner's token, else `GITHUB_TOKEN`, else none.
- **`createIssue(repoUrl, title, body)` returns** `{ url, number }`, or throws an error
  with a short reason:
  - `No GitHub access to <owner>/<repo>` when there is no token, or GitHub answers 404/403;
  - otherwise GitHub's own message.

  It never returns null silently.
- **Tests** pass a token map and a fake `fetch`. No test reads the real env.
- **The production value** is set by hand in `~/Granjur-Discord-Bot/.env` on the VM:
  `GITHUB_TOKENS=ubs-dev-org:<bot PAT>`. The PAT is never committed or pasted into chat.

### 5. Issues for bugs and features

`taskCreate.js`:
- After the task row and channel exist, if the caller did not opt out and the task
  resolves to a repository, it opens an issue for **bugs and features** alike.
  - The issue body is the task description plus "Scope: …", "Project: …" and a link back
    to the Discord channel.
  - It stores `externalIssueUrl` and `externalIssueNumber` on the task row.
- The result gains `issue: { url } | { error } | null`. `null` means none was wanted, or
  no repository was found.
- An issue failure never fails the create.
- Callers pass `createIssue: boolean` (default `true`) and no longer pass a
  caller-picked repository, except in the fallback below.

**`/create-task`:**
- **Repository found:** after scope and project are chosen, the rule runs. The
  repository step is skipped, and the confirm step shows `Repository: <name> (<Scope>)`
  and an **Issue: on/off** toggle, on by default.
- **No repository found:**
  - a **bug** still asks for a repository, from the project's linked repositories
    (every server repository if the project has none);
  - a **feature** has no repository and no issue.
- The task's `repositoryId` is set from the rule, or from the bug's picked repository.
- **The reply** shows the issue link, or `Issue: not opened — <reason>`.

**The site** (create page, `src/screens/team/TaskCreate.tsx`, `taskFormLogic.ts`):
- The repository picker is replaced by a line showing where the issue goes: "Issue goes
  to **<repo>** (<Scope>)", or "No repository for this project and scope — no issue".
  It is computed with the same rule from the payload.
- An **Open a GitHub issue** checkbox, on by default, is disabled when there is no
  repository. It sends `create_issue`.
- A bug with no resolvable repository is still refused with a clear message, because a
  bug must have a repository.
- The site keeps sending `repository_ids` only in that bug fallback. The bot's internal
  create route resolves the repository with the rule, and passes `createIssue` through.

**CSAAS:**
- The create pass-through (`discordTasksWrite.js`) adds `create_issue` (boolean) to the
  forwarded fields.
- The tasks payload gains `projectRepos: [{ projectId, repositoryId, scope }]`, read from
  `granjur.project_repos` for the visible guilds, next to the existing `repositories`.

### 6. Meeting tasks

- `mirroredStage` sets each task's `repositoryId` with the rule, using the settled
  project (meeting project, the project Claude named, or the reviewer's pick) and the
  task's scope. This replaces the "match's project equals the chosen project" rule in
  `meetingTaskProject.js`.
- **The review's per-task GitHub switch starts on** (`initReviewState`). It is now an
  opt-out.
- **`issue_syncing` opens issues in the bot** with `createIssue`, not through CSAAS:
  - only for tasks the reviewer left on that have a repository and no
    `externalIssueUrl` yet, so a retry is idempotent;
  - it stores the link on the task row;
  - failures go to `dataJson.issueSyncErrors`, which the done summary already reports;
  - the stage still always advances.

  `csaasClient.issueSync` is no longer called. The CSAAS endpoint stays for other callers.

### 7. Managing links in Discord

- **`/projects` → Link repo** gains a Scope step (Backend/Frontend/Mobile/QA/Design/"No
  scope") after the project is picked.
  - Linking an already linked repository updates its scope.
  - If another repository already holds that scope in that project, the link is refused:
    "<Project> already has <Repo> as its <Scope> repository — unlink it or pick another
    scope."
- **`/projects` → Unlink repo** (new) picks a project, then one of its linked
  repositories, and removes the link. Tasks keep their `repositoryId`.
- **`/repos add`** gains an optional `scope` alongside its optional `project`, with the
  same one-per-scope refusal.
- Who can manage links is unchanged: the same roles as `/projects` and `/repos` today.
- **Access check** (owner, 2026-09-30):
  - `/repos add` and `/projects` → Link repo ask GitHub whether the owner's token (§4)
    can see the repository (`GET /repos/{owner}/{repo}`, with a new
    `checkRepoAccess(repoUrl)` in `github.js`).
  - The reply gains `✅ GitHub access OK`, or `⚠️ No GitHub access to <owner>/<repo> —
    issues won't open until a token can reach it` (also for an unparsable URL).
  - The repository is added or linked either way. A GitHub error or timeout reads as
    "couldn't check" and never blocks.

### 8. The issue follows the task's status

Asked for by the owner on 2026-09-30.

**The hook:**
- A new `syncIssueState({ task, before, updates })` in `bot/src/services/taskIssueState.js`
  runs wherever a status change runs its ticket-channel step:
  - `applyTaskUpdate` in `services/taskStatusChange.js`, which covers `/update-task`, the
    task hub, and the site's status route and board moves;
  - `/close-feature`;
  - `/resolve-bug`.
- It acts only when the task has an issue (`externalIssueUrl` or `externalIssueNumber`)
  and the status actually changed.

**What it does:**
- **Task becomes `done`, `closed` or `resolved`:** the issue is closed as *completed*.
- **Task becomes `abandoned`:** the issue is closed as *not planned*.
- **Task moves from any of those back to an active status:** the issue is reopened.
- It calls `PATCH /repos/{owner}/{repo}/issues/{number}` with `state` and `state_reason`,
  using the owner's token from §4 (`github.js` gains `setIssueState(repoUrl, number, {
  state, reason })`).

**Failure:**
- It never blocks or undoes the status change.
- The reply or channel post gains one line, "GitHub issue not closed — <reason>" (or "not
  reopened").
- An issue already in the target state counts as success.

GitHub → Discord (closing the issue on GitHub closes the task) is out of scope.

### 9. Site: repositories shown read-only

The project cards list each linked repository and its scope, e.g. "Framework_Node ·
Backend", from `projectRepos`. There is no editing on the site.

## Testing (fakes only; `.claude/rules/tests-never-touch-production.md`)

- **Bot:**
  - `resolveTaskRepo`: the rules, reasons, and an untagged single repository.
  - `tokenFor` and `GITHUB_TOKENS` parsing; `createIssue`'s errors (no token, 404,
    other) with a fake fetch.
  - `taskCreate`:
    - issues for features and bugs;
    - the opt-out;
    - failure reported without failing the create;
    - `repositoryId` from the rule.
  - `/create-task`: the repository step skipped or asked; the Issue toggle.
  - `/projects` link, scope, refusal and unlink with a fake db; `/repos add` scope.
  - `syncIssueState`: closes as completed on done/closed/resolved, as not planned on
    abandoned, and reopens on the way back. It does nothing when there is no issue or no
    status change, reports failure without throwing, and each of the three call sites
    calls it.
  - Meeting pipeline: `repositoryId` by scope; review switch default on;
    `issue_syncing` via `createIssue`, idempotent, errors recorded.
  - Migration 030: a static guard test, like 028.
- **CSAAS:** the `mobile` scope in `normalizeMeetingTaskScope` and the prompt;
  `create_issue` forwarded; `projectRepos` in the payload.
- **Site (vitest):** the resolved-repository line and checkbox logic; Mobile in the
  scope filter and labels; the repository list on project cards.

## Rollout

1. **Bot.** The deploy runs migration 030.
   - Set `GITHUB_TOKENS=ubs-dev-org:<PAT>` in the VM's `.env`, then restart the bot.
2. **CSAAS.** A push deploys automatically.
3. **Site** (Vercel).
4. **Tag the existing links** with `/projects` → Link repo.
   - Add the ubs-dev-org Badar HMS repositories with `/repos add` (with their scopes).
   - Unlink the old `granjurtech/Badar_HMS_Node`.

Each part tolerates the others' old versions:
- The old site sends `repository_ids` and no `create_issue`, and the bot then applies
  the rule and opens an issue by default.
- The old CSAAS payload has no `projectRepos`, and the site then shows no repository line.

## Out of scope

- Managing links on the site.
- Moving or creating an issue when a task's project or scope changes later.
- Closing a task when its issue is closed on GitHub.

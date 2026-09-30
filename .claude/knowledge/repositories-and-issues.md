# Repositories per scope, and a GitHub issue for every task

Roadmap sub-project 4 of 7 (owner roadmap, `.claude/state/backlog.md`). Built across the
bot, CSAAS and the site on branch `feat/repo-scopes` in each — **not merged, not
deployed**. Spec: `docs/superpowers/specs/2026-09-30-repositories-per-scope-design.md`.
Owner's request: "Let a project have multiple repositories and be associated with a
scope (backend/frontend) so a task's scope selects the applicable repo and creates git
issue."

## Data: a scope on each project–repository link

Bot migration `030_project_repo_scope.sql` adds `project_repos.scope VARCHAR(16) NULL`
and a unique key `(project_id, scope)` — MySQL allows several NULL scopes under a unique
key, so untagged links are unaffected. Guarded with the `information_schema` re-run
pattern (like 028/029), safe to run twice.

`db.projectRepos` gained `setScope({ project_id, repository_id, scope })`,
`remove({ project_id, repository_id })`, `findMany({ where: { project_id } })`
returning `{ repository_id, scope, ... }` rows.

**`bot/src/services/projectRepoLinks.js`** is the one place that reads-then-writes the
"one repository per scope per project" invariant — `/projects` (link/unlink) and
`/repos add` both go through it rather than calling `db.projectRepos` directly:
- `linkRepo({ db, projectId, repositoryId, scope })` refuses (no write) when another
  repository in the project already holds that scope, returning
  `{ ok: false, holderRepositoryId }`; a race that slips past the pre-check surfaces as
  a MySQL duplicate-key error (`errno 1062` / `ER_DUP_ENTRY`) from `setScope`, caught and
  turned into the same refusal shape after a re-read. **A refusal never leaves a stray
  link:** if this call had just inserted the (untagged) row before `setScope` hit the
  race, it removes that row again (best-effort, a failed cleanup only warns).
- `linkUpdatedText(repoName, projectName, scope)` — the `/projects` relink headline,
  `Updated <Repo> in <Project> to <Scope|no scope>.`; `SCOPE_IGNORED_TEXT` — `Scope
  ignored — give a project to link with a scope.`
- `unlinkRepo({ db, projectId, repositoryId })` removes one pair; tasks keep their
  already-set `repositoryId`.
- `linkRefusalText(projectName, repoName, scope)` → `"<Project> already has <Repo> as
  its <Scope> repository — unlink it or pick another scope."`
- `accessLine(result)` turns `checkRepoAccess`'s result into the reply line (below).

## The Mobile scope

Fixed scopes are now five: `backend`, `frontend`, `mobile`, `qa`, `design` — order
Backend/Frontend/Mobile/QA/Design drives every picker. `bot/src/utils/taskScope.js`
(`SCOPE_CHOICES`, `SCOPE_VALUES`, `isValidScope`, `scopeLabel`) is the one source; a
stored value predating the fixed set (free text, or null) is returned as-is by
`scopeLabel` so an old task keeps its label. Meeting fallback:
`react-native` → `mobile`, `react` stays → `frontend` (`meetingTaskMap.js`). CSAAS's
`normalizeMeetingTaskScope` list and the task-generation prompt's scope enum both carry
`mobile` (migration 028 already normalised `task.scope` rows; `mobile` is valid from
here on). Site: `SCOPE_LABEL`, `SCOPE_FILTERS`, tone/colour, and the create/edit form's
scope options all carry it too.

## The rule: which repository a task uses

**`bot/src/services/taskRepo.js`**, `resolveTaskRepo({ projectId, scope }, { links,
repos })` → `{ repository, reason }`:
1. the repository linked to `projectId` with `scope` (reason `'scope'`);
2. else, if the project has exactly one **untagged** link, its repository (reason
   `'only-repo'`). The untagged link takes every scope no tagged link claims. Changed
   2026-09-30 for Badar HMS: `my-destination` holds backend and frontend and a second
   repository holds the mobile app; a link carries one scope, so `my-destination` stays
   untagged beside the Mobile-tagged one. Before this, rule 2 required the project to
   have exactly one link in total. Two or more untagged links still give none;
3. else `null`, with reason `'no-project'`, `'no-scope'` or `'no-repo-for-scope'`
   (`repoReasonText(reason)` turns the last three into a sentence fragment).

`loadProjectLinks(db, projectId)` reads `db.projectRepos.findMany` defensively (`[]` on
a missing model or a failed read, never throws) — used everywhere the rule is applied.

**The rule runs in three places**, always against the same `links`/`repos` shape:
- `bot/src/commands/create-task.js` (`confirmRepository`, `proceedAfterScope`) — see
  "As built" below;
- `bot/src/services/internalTaskRoute.js` `handleCreateRequest` (the site's create
  route) — runs the rule for a bug up front and refuses with 400 ("This project has no
  repository for this scope — pick a repository for the bug.") when it finds nothing and
  the site sent no `repositoryIds[0]` either;
- the meeting pipeline — `bot/src/services/meetingTaskProject.js`
  `resolveMeetingTaskProject(csaasTask, reviewTask, ctx)` calls `resolveTaskRepo` with
  the settled project and `meetingTaskScope(csaasTask)`, replacing the old "match's
  project equals the chosen project" repository rule. **A task with no project has no
  repository, whatever name Claude gave it.**

TypeScript mirror on the site: `src/screens/team/repoLogic.ts` `resolveTaskRepo` is the
identical rule against the payload's `projectRepos`/`repositories`, so the create page's
preview line can never disagree with what the bot will actually do.

## GitHub tokens: `GITHUB_TOKENS` (per owner) and `GITHUB_TOKEN` (fallback)

`bot/src/services/github.js`:
- `parseTokens(raw)` parses `GITHUB_TOKENS="owner:token,owner2:token2"` into a
  lowercase-keyed `Map<owner, token>` — blank/malformed pairs (no `:`, empty owner)
  are dropped; a token containing its own `:` survives (split on the *first* `:` only).
- `tokenFor(owner, { tokens, fallback })` → the per-owner token, else `fallback`
  (`GITHUB_TOKEN`), else `''`.
- `config.github.tokens` reads `process.env.GITHUB_TOKENS`; `config.github.token` reads
  `process.env.GITHUB_TOKEN` (`bot/src/config.js`). Computed once at module load into
  `DEFAULT_TOKENS`/`DEFAULT_FALLBACK`; every exported function takes an opts bag so tests
  pass a fake map and fake `fetch` — **no test reads the real env or hits the network.**
- **Production value, set by hand, never in git:** the owner has already set
  `GITHUB_TOKENS=ubs-dev-org:<bot PAT>` in `~/Granjur-Discord-Bot/.env` on the VM (and
  locally) — every repository under `ubs-dev-org` is reachable with one bot-account PAT.
  Other owners (`aashir-adnan`, `granjurtech`, `itulahore`, `ilmversity`) keep the
  existing single `GITHUB_TOKEN`.
- `createIssue(repoUrl, title, body, opts)` → `{ url, number }`, or throws
  `GitHubError` with a short reason: `no-access` → `` `No GitHub access to <owner>/<repo>` ``
  (no token, or GitHub answers 401/403/404), else `github` with GitHub's own message.
  **Never returns null silently.** 8s `AbortSignal.timeout` so a hung GitHub call can't
  hold a create open long enough to make CSAAS's own wait time out.
- `setIssueState(repoUrl, number, { state, reason }, opts)` — `PATCH
  /repos/{owner}/{repo}/issues/{number}`, same error shape, used by the status sync below.
- `checkRepoAccess(repoUrl, opts)` — `GET /repos/{owner}/{repo}`, **never throws**:
  `{ ok: true }`, or `{ ok: false, code: 'no-access'|'bad-url'|'error', message }`. Used
  by the access check below.

## Issues for bugs and features alike

Before this build, only bugs got an issue, using a single repository the creator picked
from every repository in the server, and failures were swallowed silently. Now:

**`bot/src/services/taskCreate.js`** `createTask({ ..., createIssue: wantIssue = true
})`. After the task row and its channel exist:
- if the caller opted out (`createIssue: false`) → `issue: null`, nothing opened;
- else if the resolved repository has no `url` → `issue: { skipped: <reason text> }`
  (the rule's `no-project`/`no-scope`/`no-repo-for-scope` sentence);
- else `createIssue()` is called; success → `{ issue: { url }, issueUrl }`, stores
  `externalIssueUrl`/`externalIssueNumber` on the task row, and best-effort posts
  `GitHub issue: <url>` into the new channel; **failure never fails the create** —
  `issue: { error: reason }` comes back instead, the task and its channel stand, and the
  failure is also **said in the task's channel** (`GitHub issue not opened — <reason>`,
  best-effort; a skip or an opt-out is not posted). A failed row write after a
  successful issue no longer hides it (its own best-effort try: the issue link is still
  returned and posted).
- The body is the description, then `Scope: <Scope> · Project: <Project>`, the Discord
  channel link, and `Task ID: <id>`.

**Which repository is "used" (`usedRepo`) is a controller ruling, not just the rule's
output:** for a **feature**, `usedRepo = ruled ?? pickedRepo` — if the rule found
nothing but the caller explicitly picked a repository (`fields.repositoryIds[0]`), that
picked repository is used and **gets an issue**. For a **bug**, `usedRepo = ruled ?? repo`
— same shape, `repo` being the caller-picked repository (from the repo step, or the
site's bug fallback). This is deliberate: an explicit pick is treated as good enough to
open an issue against, even when the scope rule itself came up empty.

### `/create-task`, as built (behaviour that changed during review)

- **A bug in a guild with no repositories is refused at the very start**, before the
  first step: `bugStartRefusal(repos)` → `NO_REPOSITORIES_MSG` = `"No repositories. Add
  with **/repos** first."` (`bot/src/commands/create-task.js`).
- **Bugs pick a project first** (or "No project") — `showBugProjectStep` /
  `handleBugProjectSelect` — before scope, so the rule has a project to check.
- **Once scope is known, the rule runs** (`proceedAfterScope`): repository found →
  the repository step is skipped entirely, confirm shows it. Repository not found →
  a **bug** still asks for a repository, but only from **the project's linked
  repositories, falling back to every server repository if the project has none**
  (`showRepoStep`, `fromProject` flag controls the wording); a **feature** with no
  repository just has no repository and no issue — it is never asked.
- **The confirm step's "Repository" field** (`repositoryFieldText(repository, reason,
  scope)`) shows the name plus `(<Scope>)` **only when `reason === 'scope'`** — i.e.
  only when the scope rule itself chose it, never for `'only-repo'` (which says nothing
  about the task's actual scope) or `'picked'` (a human's explicit choice). `None — no
  issue` when there is none.
- **An Issue on/off toggle** on the confirm step, on by default:
  `issueToggleButton(on)` (custom id `create_task_issue_toggle`, label "Issue: on"/"Issue:
  off", Primary/Secondary style), flips `state.createIssue` and re-renders.
- **The reply's last line**, always present, never silent: `issueReplyLine(issue)`
  (`services/taskCreate.js`, re-exported by `/create-task`) → `Issue: <url>` on success,
  `Issue: not opened — <error>` on failure, `Issue: not opened — <skipped reason>` when
  no repository, or `Issue: off` when the toggle was off. **The same function writes the
  site route's `note`** (below).

### The site's create page

`src/screens/team/repoLogic.ts` `issueTargetText(result, scope)` mirrors
`repositoryFieldText` exactly: `Issue goes to <repo>` plus `(<Scope>)` **only when
`reason === 'scope'`**, same reasoning as the bot (an `only-repo` match says nothing
about the task's own scope). `No repository for this project and scope — no issue` when
none. An **Open a GitHub issue** checkbox, on by default, disabled when there's no
repository, sends `create_issue` (`taskFormLogic.ts`: `create_issue: !!resolvedRepo &&
f.createIssue`). **A bug the rule gives no repository now shows a required Repository
picker** (`bugRepoChoices` in `repoLogic.ts`: the project's linked repositories, else
every repository) and sends `repository_ids: [picked]`; the form refuses only when there
is nothing to pick ("This project has no repository — add one in Discord with /repos
add."). A scope-less bug in a project with several links gets the hint "Pick a scope to
choose the repository automatically, or pick one below." The site still sends
`repository_ids` **only in that bug fallback**; every other create lets the bot's
internal route resolve the repository with the rule and pass `createIssue` through
untouched. The success toast reads `Task created.` plus the bot's `note` (shown on
separate lines — `Toast.tsx` uses `whitespace-pre-line`).

**CSAAS** (`discordTasksWrite.js`): `create_issue` (boolean, optional) on the create
pass-through → `body.createIssue`; 400 if present and not a boolean. The tasks payload
(`discordTasks.js` `assembleTasks`) gains `projectRepos: [{ projectId, repositoryId,
scope }]`, read from `granjur.project_repos` scoped to the visible project ids (not
guild-scoped like `repository`, since `project_repos` has no guild column of its own),
next to the existing `repositories` array — `payloadLogic.ts` on the site defaults a
missing `projectRepos` to `[]` so an old CSAAS response still renders (no repository
line, not a crash).

**Bot's internal create route** (`bot/src/services/internalTaskRoute.js`
`handleCreateRequest`): `createIssue: b.createIssue !== false` — an old site sending no
`create_issue` at all still gets an issue by default. For a bug it runs the rule itself
before calling `createTask` and hands it the ruled repository, falling back to the site's
`repositoryIds[0]` only when the rule finds none; 400 when both come up empty.
**The issue outcome rides on the reply's `note`:** CSAAS forwards only `note` to the
site, so the route sets `note` to the placement note and `issueReplyLine(made.issue)`
joined by a newline — `Issue: <url>` / `Issue: not opened — <reason>` / `Issue: off`.

## The issue follows the task's status (owner request, 2026-09-30)

**`bot/src/services/taskIssueState.js`** `syncIssueState({ db, task, updates, setState =
setIssueState })`. Runs from every status-change site that already has a ticket-channel
step:
- `applyTaskUpdate` in `taskStatusChange.js` (covers `/update-task`, the task hub, the
  site's status route and board moves);
- `/close-feature`;
- `/resolve-bug`.

`issueTransition(beforeStatus, afterStatus)` (pure, tested standalone):
`beforeStatus === afterStatus` → `null` (no-op); else, using `isFinished()` from
`utils/ticketArchive.js`: both live → `null`; becoming finished → `{ state: 'closed',
reason: 'not_planned' }` when the new status is `abandoned` else `'completed'`; coming
back from finished to live → `{ state: 'open' }`.

`syncIssueState` itself: does nothing (`{ line: null }`) unless `updates.status` is
present and different from `task.status`, the transition calls for a change, the task
has an issue. **The issue is found from `externalIssueUrl` first** (owner, repo and
number all parsed from the URL, so it closes in the repository it was opened in
whatever `repositoryId` says now); only without a parsable URL does it fall back to
`repositoryId` + `externalIssueNumber` (repository read with
`dbArg.repository.findFirst({ where: { id: task.repositoryId, guildConfigId } })`; a
falsy `repositoryId` is never looked up). When neither resolves it says so instead of
doing nothing: `GitHub issue not closed — the issue's repository is unknown` (or `not
reopened`). `/close-feature` and `/resolve-bug` run this sync **before** `move` archives
and locks the channel, and put its line in the reply too. **Never throws** — a repository-lookup error or `setIssueState` failure both come back as
`{ line: 'GitHub issue not closed — <reason>' }` / `'not reopened — <reason>'`, appended
to the reply or channel post as one extra line; the status change itself always
succeeds regardless. An issue already in the target state counts as success (GitHub's
PATCH is idempotent). GitHub → Discord (closing the issue on GitHub closing the task) is
explicitly out of scope.

## The access check (owner, 2026-09-30)

`/repos add` and `/projects` → Link repo both call `checkRepoAccess(repoUrl)` right
after adding/linking (never blocking it — the repository is added or linked either way):
`accessLine(result)` → `✅ GitHub access OK`, or `⚠️ No GitHub access to <owner>/<repo> —
issues won't open until a token can reach it` (also shown for an unparsable URL, using
the checked URL in place of `<owner>/<repo>` since `checkRepoAccess` never learned an
owner/repo for a URL it couldn't parse), or, on a GitHub error/timeout, "GitHub access
couldn't be checked right now." — never a blocker. **The check asks whether an issue
can actually open, not just whether the repository can be read:** issues switched off
(`has_issues === false`) → `⚠️ Issues are disabled on <owner>/<repo> — issues won't open
until they are turned on in the repository's settings` (`issuesDisabled`); a token that
reads but has neither `push` nor `triage` permission → the same no-access warning.
(Known limit, deferred: a read-only-looking token that can still open issues may get a
false "No GitHub access" warning.)

## Managing links in Discord

- **`/projects` → Link repo** gains a Scope step after the project is picked
  (`projects_link_scope_select`: Backend/Frontend/Mobile/QA/Design/"No scope").
  Re-linking an already-linked repository updates its scope. The one-per-scope refusal
  from `linkRepo` applies.
- **`/projects` → Unlink repo`** (new): picks a project, then one of its linked
  repositories (`repo · scope` label), removes the link. Tasks keep their
  `repositoryId`.
- **`/repos add`** gained an optional `scope` choice alongside its optional `project`,
  same one-per-scope refusal, same access-check line on the reply. A `scope` with no
  `project` is ignored and the reply says so (`Scope ignored — give a project to link
  with a scope.`).
- Who can manage links is unchanged (same roles as `/projects`/`/repos` today).

## Meeting issues, opened by the bot (not CSAAS)

Before this build, CSAAS's `issueSync` opened meeting-task issues on its own token,
matching the repository by the project name Claude heard (broken for a project with
more than one linked repository). Now:

- `mirroredStage` (`meetingPipelineStages.js`) sets each mirrored task's
  `repositoryId` via `resolveMeetingTaskProject` (the settled project + the task's
  scope, same rule as everywhere else) — this REPLACES the old
  "match's project equals the chosen project" repository match in
  `meetingTaskProject.js`.
- **The review's per-task GitHub switch now starts ON** (`initReviewState` in
  `meetingReviewUI.js`) — it is an opt-out now, not an opt-in.
- **`issue_syncing` (a pipeline stage) opens issues in the bot itself**, via
  `createIssue` (test seam `openIssue`), never through CSAAS:
  - only tasks the reviewer left flagged (`m.github`) with a `dbTaskId` and a
    `repositoryId` are candidates (`flagged`);
  - **idempotent by construction**: `todo = flagged.filter((m) => !m.externalIssueUrl)`
    — an entry that already has its issue is skipped on a retry;
  - **each opened issue is persisted immediately** — `entry.externalIssueUrl`/
    `externalIssueNumber` are set on the in-memory `mirrored` entry and written to both
    `db.task.update` and the saved job's `dataJson` **before moving to the next entry**,
    specifically so a crash or retry mid-loop can never reopen an issue whose row-write
    merely failed;
  - **the row update writes `repositoryId` together with the issue url/number** (a
    pre-deploy entry with no `repositoryId` falls back to the task row's), so the
    status sync can always find the repository later;
  - failures are collected into `dataJson.issueSyncErrors` as `{ csaasTaskId, title,
    kind, reason }`, never thrown — the stage always advances (`patch: {}` when nothing
    is flagged, `patch: { dataJson }` otherwise). `kind` is `'skipped'` (no repository
    for the project and scope; `reason` is the rule's own sentence via `repoReasonText`,
    carried on the mirrored entry as `repoReason`) or `'failed'` (a repository read
    error, a repository with no `url`, or `createIssue` throwing); an entry saved before
    `kind` existed reads as a failure;
  - `doneStage`'s final summary embed: `N pushed to GitHub` counts **issues actually
    opened** (mirrored entries with an `externalIssueUrl`), not flagged tasks; each
    issue is a link named by its task title; problems are listed as one `• skipped — no
    repository: <title> (<reason>), …` line apart from one `• failed: <title> —
    <reason>` line per failure. **The text is clamped to Discord's limit**
    (`clampSummary(lines, max = 4000)`, exported from `meetingPipelineStages.js`): cut at
    a line boundary, the count lines always kept, ending with `… (summary shortened)`.
    Without it a meeting with ~16+ issue problems made `EmbedBuilder.setDescription`
    throw (over 4096 characters) on every retry and the review message was never
    rewritten.
  - **CSAAS's `issueSync` is no longer called by the bot.** The CSAAS endpoint itself
    stays in place for any other caller — nothing there was removed.

## Rollout

Facts, not yet executed (each push needs the owner's go-ahead):

1. **Bot** to `main` — the deploy runs migration 030 automatically.
   `GITHUB_TOKENS=ubs-dev-org:<PAT>` is **already set** on the VM's bot `.env` (and
   locally) by the owner — no separate env step needed at this deploy.
2. **CSAAS** to `main` — a push auto-deploys, and CSAAS applies its own migrations at
   startup (`runMigrationsOnStart`) — there is **no CSAAS migration in this
   sub-project** (only code + test changes), so nothing to apply either way.
3. **Site** to `main` — Vercel builds on push.
4. **Owner, after all three are live:** `/projects` → Link repo to tag each existing
   link with its scope; `/repos add` the ubs-dev-org Badar HMS repositories with their
   scopes (new links, under the org whose token now reaches everything); `/projects` →
   Unlink repo the old `granjurtech/Badar_HMS_Node`.

Each part tolerates the others' old version, same shape as every prior rollout in this
series: an old site sends `repository_ids` and no `create_issue` and the bot applies the
rule and opens an issue by default; an old CSAAS payload has no `projectRepos` and the
site shows no repository line.

## Related

[[csaas-meeting-workflow-integration]] ("Scope and meeting-task projects" — the scope
rule this build's repository rule keys off, and where the meeting pipeline's rule 3 used
to stop at "kept only when the match's project is the chosen project" before this build).
[[project-tasks-site.md]] ("Site create, edit and add-subtask" — the internal create
route this build added `createIssue` to).

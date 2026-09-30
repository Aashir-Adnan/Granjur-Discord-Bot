# Repositories per Scope and GitHub Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project links at most one repository per scope (Backend/Frontend/Mobile/QA/Design); every task (bug or feature) whose project + scope finds a repository gets a GitHub issue unless the creator opts out; the issue closes/reopens with the task's status; GitHub tokens are chosen per repository owner.

**Architecture:** One pure rule, `resolveTaskRepo`, picks a task's repository from the project's scoped links; `taskCreate` opens issues for both types through `github.js`, which now picks a token per owner (`GITHUB_TOKENS`, falling back to `GITHUB_TOKEN`) and reports failures instead of hiding them. A status hook beside the existing ticket-channel placement closes/reopens issues. The meeting pipeline uses the same rule and opens its issues in the bot. CSAAS forwards `create_issue` and adds `projectRepos` to the site payload; the site shows where an issue will go.

**Tech Stack:** Bot: Node ESM, discord.js v14, `node:test`, MySQL SQL migrations. CSAAS: Node CommonJS, UBS framework, jest + standalone node test scripts. Site: React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-repositories-per-scope-design.md`

## Global Constraints

- Scopes, in this order everywhere: `backend` (Backend), `frontend` (Frontend), `mobile` (Mobile), `qa` (QA), `design` (Design). `react-native` meeting tasks → `mobile`; `react` → `frontend`; `node`/`python` → `backend`.
- A project has at most one repository per scope (unique `(project_id, scope)`; NULL scope unrestricted).
- Repository rule, in order: (1) the project's link with the task's scope; (2) the project's only link when it has no scope; (3) none.
- Issues: bugs and features alike, on by default, per-task opt-out; an issue failure never fails the create and is always reported (never silent).
- Status sync: `done`/`closed`/`resolved` → close as `completed`; `abandoned` → close as `not_planned`; from those back to any other status → reopen; never blocks the status change.
- Tokens: `GITHUB_TOKENS="owner:token,owner2:token2"` (owner case-insensitive), else `GITHUB_TOKEN`. No test ever reads the real env or calls GitHub; the PAT is never written to any file in git.
- User-facing strings, verbatim: `No GitHub access to <owner>/<repo>`; `Issue: not opened — <reason>`; `GitHub issue not closed — <reason>` / `GitHub issue not reopened — <reason>`; `✅ GitHub access OK`; `⚠️ No GitHub access to <owner>/<repo> — issues won't open until a token can reach it`; link refusal `<Project> already has <Repo> as its <Scope> repository — unlink it or pick another scope.`
- Bot tests use fakes for every `db`/`getConfig`/GitHub seam (`.claude/rules/tests-never-touch-production.md`; the root `.env` is production). Never run `npm run db:migrate`, SQL, or real GitHub calls.
- Commits: `git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit ...`; message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` — exactly that.
- A piped test summary can exit 0 while red: read `ℹ fail` (bot), `Tests:` (jest), vitest's `Tests` line.

## Workspaces

- Bot: `D:\Work\Granjur Technologies\Granjur-Discord-Bot`, branch `feat/repo-scopes` (checked out; spec commits `a5bce89..382e8a9`). Tasks 1–9, 12.
- CSAAS: `D:\Work\Granjur Technologies\CSAAS_Backend`, create `feat/repo-scopes` from `main` (leave its untracked `.bridge/`, `.worktrees/`, `data/migrations_completed/*` alone). Task 10.
- Site: never touch `D:\Work\Granjur Technologies\UBS-Doc` (someone else's uncommitted work). `git -C "D:/Work/Granjur Technologies/UBS-Doc" fetch origin main`, then `git -C "D:/Work/Granjur Technologies/UBS-Doc" worktree add "D:/Work/Granjur Technologies/UBS-Doc-repo-scopes" -b feat/repo-scopes origin/main`, then `npm ci` in the worktree. Task 11.

## Review Focus

1. A task whose project has two repos but neither carries the task's scope must get no issue (not "the first repo") — Task 3 test.
2. An issue failure (no token, 404, timeout) must not fail the create, and the creator must see why — Task 5 + Task 6 tests.
3. A status change on a task with no issue, or a status write that doesn't change the status, must make no GitHub call — Task 8 test.
4. Re-running the meeting `issue_syncing` stage must not open a second issue for a task that already has one — Task 9 test.
5. Linking a repo to a scope another repo already holds in that project must be refused with the verbatim message, and re-linking the same repo must just change its scope — Task 7 test.

---

### Task 1: The Mobile scope (bot)

**Files:**
- Modify: `bot/src/utils/taskScope.js` (`SCOPE_CHOICES`)
- Modify: `bot/src/services/meetingTaskMap.js` (`PLATFORM_SCOPE`)
- Test: `bot/src/utils/taskScope.test.js`, `bot/src/services/meetingTaskMap.test.js`, `bot/src/commands/create-task.test.js` (the "four fixed choices" test)

**Interfaces:** Produces `SCOPE_VALUES = ['backend','frontend','mobile','qa','design']`; `meetingTaskScope({ platform: 'react-native' }) === 'mobile'`.

- [ ] **Step 1: Update tests first**
  - `taskScope.test.js`: assert `SCOPE_CHOICES` is exactly `[{name:'Backend',value:'backend'},{name:'Frontend',value:'frontend'},{name:'Mobile',value:'mobile'},{name:'QA',value:'qa'},{name:'Design',value:'design'}]`; `isValidScope('mobile')` true; `scopeLabel('mobile') === 'Mobile'`.
  - `meetingTaskMap.test.js`: change the expectations for `platform: 'react-native'` (and `'react_native'`, `'React Native'`) from `'frontend'` to `'mobile'`; keep `react` → `frontend`. Add `meetingTaskScope({ scope: 'Mobile' }) === 'mobile'`.
  - `create-task.test.js`: rename `'scope row offers exactly the four fixed choices'` to `'scope row offers exactly the five fixed choices'` and expect the five values in order.
- [ ] **Step 2: Run** `node --test bot/src/utils/taskScope.test.js bot/src/services/meetingTaskMap.test.js bot/src/commands/create-task.test.js` → FAIL.
- [ ] **Step 3: Implement**
  - `SCOPE_CHOICES`: insert `{ name: 'Mobile', value: 'mobile' }` after Frontend; update the file's header comment from "four values" to "five values".
  - `PLATFORM_SCOPE` in `meetingTaskMap.js`: `'react-native': 'mobile'`; update its comment.
  - `grep -rn "four" bot/src/commands/create-task.js bot/src/commands/update-task.js bot/src/utils/taskScope.js` and fix any user-facing or comment text that says "four" scopes.
- [ ] **Step 4: Run** the three test files, then `npm test` from the repo root → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(scope): add the Mobile scope; react-native meeting tasks go to Mobile`.

---

### Task 2: Scoped links in the database

**Files:**
- Create: `bot/src/Database/migrations/030_project_repo_scope.sql`
- Modify: `bot/src/Database/index.js` (`projectRepos*` functions ~line 1150-1175; the `projectRepos` export object ~line 2441)
- Test: `bot/src/Database/migration030.test.js`

**Interfaces:** Produces `db.projectRepos.setScope({ project_id, repository_id, scope })` and `db.projectRepos.remove({ project_id, repository_id })`. `findMany({ where: { project_id } })` rows now carry `scope` (it is `SELECT *`).

- [ ] **Step 1: Write the failing test** `bot/src/Database/migration030.test.js`:

```js
// Migration 030 is plain SQL and there is no test database (the root .env is
// production), so this pins its guards instead of running it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sql = readFileSync(fileURLToPath(new URL('./migrations/030_project_repo_scope.sql', import.meta.url)), 'utf8')
const body = sql.replace(/--.*$/gm, '')

test('adds project_repos.scope only when missing', () => {
  assert.match(body, /COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = 'project_repos' AND COLUMN_NAME = 'scope'/)
  assert.match(body, /ALTER TABLE project_repos ADD COLUMN scope VARCHAR\(16\) DEFAULT NULL/)
})

test('adds the one-repository-per-scope key only when missing', () => {
  assert.match(body, /STATISTICS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = 'project_repos' AND INDEX_NAME = 'uq_project_repos_scope'/)
  assert.match(body, /ADD UNIQUE KEY uq_project_repos_scope \(project_id, scope\)/)
})

test('no destructive statements', () => {
  assert.ok(!/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i.test(body))
})
```

- [ ] **Step 2: Run** `node --test bot/src/Database/migration030.test.js` → FAIL (ENOENT).
- [ ] **Step 3: Implement**
  - `030_project_repo_scope.sql` (same guarded pattern as `025_client_role.sql`):

```sql
-- project_repos.scope: which scope (backend/frontend/mobile/qa/design) a linked
-- repository serves in its project (roadmap sub-project 4, 2026-09-30; spec
-- docs/superpowers/specs/2026-09-30-repositories-per-scope-design.md). At most
-- one repository per scope per project; NULL (untagged) is unrestricted, and
-- existing links stay untagged. Guarded so the file can run twice.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_repos' AND COLUMN_NAME = 'scope');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE project_repos ADD COLUMN scope VARCHAR(16) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_repos' AND INDEX_NAME = 'uq_project_repos_scope');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE project_repos ADD UNIQUE KEY uq_project_repos_scope (project_id, scope)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

  - `Database/index.js`, next to `projectReposAdd`:

```js
async function projectReposSetScope({ project_id, repository_id, scope }) {
  await query(
    "UPDATE `project_repos` SET scope = ? WHERE project_id = ? AND repository_id = ?",
    [scope ?? null, project_id, repository_id],
  );
}
async function projectReposRemove({ project_id, repository_id }) {
  await query(
    "DELETE FROM `project_repos` WHERE project_id = ? AND repository_id = ?",
    [project_id, repository_id],
  );
}
```

    and add `setScope: projectReposSetScope, remove: projectReposRemove` to the `projectRepos` export object.
- [ ] **Step 4: Run** the migration test (3 pass) and `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(db): migration 030 — a scope on each project–repository link`.

---

### Task 3: The repository rule

**Files:**
- Create: `bot/src/services/taskRepo.js`
- Test: `bot/src/services/taskRepo.test.js`

**Interfaces:** Produces `resolveTaskRepo({ projectId, scope }, { links, repos }) → { repository: object|null, reason: 'scope'|'only-repo'|'no-project'|'no-scope'|'no-repo-for-scope' }`; `repoReasonText(reason) → string`; `async loadProjectLinks(db, projectId) → link[]` (never throws; `[]` on failure or no project).

- [ ] **Step 1: Write the failing test** `bot/src/services/taskRepo.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTaskRepo, repoReasonText, loadProjectLinks } from './taskRepo.js'

const R1 = { id: 'r1', name: 'Framework_Node', url: 'https://github.com/ubs-dev-org/Framework_Node' }
const R2 = { id: 'r2', name: 'Framework_React', url: 'https://github.com/ubs-dev-org/Framework_React' }
const repos = [R1, R2]
const link = (repository_id, scope = null, project_id = 'p1') => ({ project_id, repository_id, scope })

test('rule 1: the link with the task scope', () => {
  const out = resolveTaskRepo({ projectId: 'p1', scope: 'frontend' }, { links: [link('r1', 'backend'), link('r2', 'frontend')], repos })
  assert.deepEqual(out, { repository: R2, reason: 'scope' })
})

test('rule 2: the only link, when it has no scope', () => {
  assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope: 'qa' }, { links: [link('r1')], repos }), { repository: R1, reason: 'only-repo' })
  assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope: null }, { links: [link('r1')], repos }), { repository: R1, reason: 'only-repo' })
})

test('a single link tagged with another scope is not used', () => {
  assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope: 'frontend' }, { links: [link('r1', 'backend')], repos }), { repository: null, reason: 'no-repo-for-scope' })
})

test('two links, neither with the scope: none (never "the first")', () => {
  assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope: 'design' }, { links: [link('r1'), link('r2')], repos }), { repository: null, reason: 'no-repo-for-scope' })
})

test('no project, or no scope with several links', () => {
  assert.deepEqual(resolveTaskRepo({ projectId: null, scope: 'backend' }, { links: [], repos }), { repository: null, reason: 'no-project' })
  assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope: null }, { links: [link('r1', 'backend'), link('r2')], repos }), { repository: null, reason: 'no-scope' })
})

test("links of other projects and links to deleted repositories are ignored", () => {
  assert.deepEqual(resolveTaskRepo({ projectId: 'p1', scope: 'backend' }, { links: [link('r1', 'backend', 'p2'), link('gone', 'backend')], repos }), { repository: null, reason: 'no-repo-for-scope' })
})

test('reason text', () => {
  assert.equal(repoReasonText('no-project'), 'the task has no project')
  assert.equal(repoReasonText('no-scope'), 'the task has no scope')
  assert.equal(repoReasonText('no-repo-for-scope'), 'the project has no repository for this scope')
})

test('loadProjectLinks reads one project through the db seam and never throws', async () => {
  const seen = []
  const db = { projectRepos: { findMany: async (q) => { seen.push(q); return [link('r1', 'backend')] } } }
  assert.deepEqual(await loadProjectLinks(db, 'p1'), [link('r1', 'backend')])
  assert.deepEqual(seen, [{ where: { project_id: 'p1' } }])
  assert.deepEqual(await loadProjectLinks(db, null), [])
  const warn = console.warn
  console.warn = () => {}
  try { assert.deepEqual(await loadProjectLinks({}, 'p1'), []) } finally { console.warn = warn }
})
```

- [ ] **Step 2: Run** `node --test bot/src/services/taskRepo.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement** `bot/src/services/taskRepo.js`:

```js
// Which repository a task's GitHub issue goes to (roadmap sub-project 4,
// 2026-09-30). One rule for /create-task, the site's create route and the
// meeting pipeline:
//   1. the project's link carrying the task's scope;
//   2. else the project's ONLY link, when that link has no scope yet (a
//      single-repository project keeps working until it is tagged);
//   3. else none — never "the first of several".

const REASONS = {
  'no-project': 'the task has no project',
  'no-scope': 'the task has no scope',
  'no-repo-for-scope': 'the project has no repository for this scope',
}

export function repoReasonText(reason) {
  return REASONS[reason] ?? 'no repository was found'
}

export function resolveTaskRepo({ projectId, scope }, { links = [], repos = [] } = {}) {
  if (!projectId) return { repository: null, reason: 'no-project' }
  const byId = new Map((repos || []).map((r) => [String(r.id), r]))
  const mine = (links || []).filter((l) => String(l?.project_id) === String(projectId) && byId.has(String(l.repository_id)))
  if (scope) {
    const hit = mine.find((l) => l.scope === scope)
    if (hit) return { repository: byId.get(String(hit.repository_id)), reason: 'scope' }
  }
  if (mine.length === 1 && !mine[0].scope) return { repository: byId.get(String(mine[0].repository_id)), reason: 'only-repo' }
  return { repository: null, reason: scope ? 'no-repo-for-scope' : 'no-scope' }
}

/** The project's links, uncapped (findMany by project_id). Never throws. */
export async function loadProjectLinks(db, projectId) {
  if (!projectId) return []
  try {
    return (await db.projectRepos.findMany({ where: { project_id: projectId } })) ?? []
  } catch (e) {
    console.warn('[taskRepo] project links read failed:', e?.message ?? e)
    return []
  }
}
```

  Note the "deleted repository" test: a link whose repository is not in `repos` is filtered before counting, so a project whose only other link points at a deleted repo still behaves as one link.
- [ ] **Step 4: Run** the test (8 pass) and `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(repos): one rule picks a task's repository by project and scope`.

---

### Task 4: GitHub tokens per owner, reported failures, status and access calls

**Files:**
- Modify: `bot/src/services/github.js`
- Modify: `bot/src/config.js` (`github.tokens`)
- Modify: `.env.example` if the repo has one (add `GITHUB_TOKENS=` with a comment; never a real value)
- Test: `bot/src/services/github.test.js`

**Interfaces:** Produces:
- `parseTokens(raw: string) → Map<string ownerLowercase, string token>` (pairs `owner:token` split on `,`; blanks and malformed pairs ignored; the token is everything after the first `:`).
- `tokenFor(owner, { tokens?, fallback? }) → string` (map hit, else fallback, else `''`).
- `class GitHubError extends Error` with `code: 'no-access' | 'bad-url' | 'github'`.
- `createIssue(repoUrl, title, body, { fetchImpl?, tokens?, fallback? }) → { url, number }` — throws `GitHubError`: bad URL → `bad-url` "Not a GitHub repository URL"; no token, or HTTP 401/403/404 → `no-access` with message exactly `No GitHub access to <owner>/<repo>`; else `github` with GitHub's message. 8 s timeout kept.
- `setIssueState(repoUrl, number, { state: 'open'|'closed', reason?: 'completed'|'not_planned' }, opts?) → void` — `PATCH /repos/{o}/{r}/issues/{n}` with `{ state, state_reason }` (omit `state_reason` for `open`); same errors.
- `checkRepoAccess(repoUrl, opts?) → { ok: true } | { ok: false, code: 'no-access'|'bad-url'|'error', message }` — `GET /repos/{o}/{r}`; never throws; 8 s timeout.
- Every existing helper (`getRepoContents`, `getRepoFileContent`, `getCommits`, …) uses `tokenFor(owner)` instead of the module-level single token; behaviour otherwise unchanged.
- Defaults: `tokens` = `parseTokens(config.github.tokens)` computed once at module load; `fallback` = `config.github.token`.

- [ ] **Step 1: Write the failing tests** — read the existing `github.test.js` first and keep its fake-`fetch` style. Add tests:

```js
test('parseTokens: owner:token pairs, owner case-insensitive, junk ignored', () => {
  const m = parseTokens(' ubs-dev-org:ghp_a , Other:ghp_b:c,, bad ,:x')
  assert.equal(m.get('ubs-dev-org'), 'ghp_a')
  assert.equal(m.get('other'), 'ghp_b:c')
  assert.equal(m.size, 2)
})

test('tokenFor: the owner token, else the fallback, else empty', () => {
  const tokens = parseTokens('ubs-dev-org:ORG')
  assert.equal(tokenFor('UBS-Dev-Org', { tokens, fallback: 'DEF' }), 'ORG')
  assert.equal(tokenFor('aashir-adnan', { tokens, fallback: 'DEF' }), 'DEF')
  assert.equal(tokenFor('x', { tokens: new Map(), fallback: '' }), '')
})

test('createIssue sends the owner token and returns url and number', async () => {
  const calls = []
  const fetchImpl = async (url, opts) => { calls.push([url, opts]); return { ok: true, status: 201, text: async () => JSON.stringify({ html_url: 'https://github.com/ubs-dev-org/R/issues/7', number: 7 }) } }
  const out = await createIssue('https://github.com/ubs-dev-org/R', 'T', 'B', { fetchImpl, tokens: parseTokens('ubs-dev-org:ORG'), fallback: 'DEF' })
  assert.deepEqual(out, { url: 'https://github.com/ubs-dev-org/R/issues/7', number: 7 })
  assert.equal(calls[0][0], 'https://api.github.com/repos/ubs-dev-org/R/issues')
  assert.equal(calls[0][1].headers.Authorization, 'Bearer ORG')
})

test('createIssue: no token or 404/403 is no-access with the exact message; nothing is sent without a token', async () => {
  let called = false
  const never = async () => { called = true; throw new Error('should not fetch') }
  await assert.rejects(() => createIssue('https://github.com/itulahore/E', 'T', 'B', { fetchImpl: never, tokens: new Map(), fallback: '' }),
    (e) => e.code === 'no-access' && e.message === 'No GitHub access to itulahore/E')
  assert.equal(called, false)
  for (const status of [401, 403, 404]) {
    const fetchImpl = async () => ({ ok: false, status, statusText: 'x', text: async () => JSON.stringify({ message: 'Not Found' }) })
    await assert.rejects(() => createIssue('https://github.com/o/r', 'T', 'B', { fetchImpl, tokens: new Map(), fallback: 'DEF' }),
      (e) => e.code === 'no-access' && e.message === 'No GitHub access to o/r')
  }
})

test('createIssue: a bad URL, and another GitHub error, say so', async () => {
  await assert.rejects(() => createIssue('not a url', 'T', 'B', { tokens: new Map(), fallback: 'DEF' }), (e) => e.code === 'bad-url')
  const fetchImpl = async () => ({ ok: false, status: 422, statusText: 'x', text: async () => JSON.stringify({ message: 'Validation Failed' }) })
  await assert.rejects(() => createIssue('https://github.com/o/r', 'T', 'B', { fetchImpl, tokens: new Map(), fallback: 'DEF' }),
    (e) => e.code === 'github' && /Validation Failed/.test(e.message))
})

test('setIssueState closes with a reason and reopens without one', async () => {
  const bodies = []
  const fetchImpl = async (url, opts) => { bodies.push([url, opts.method, JSON.parse(opts.body)]); return { ok: true, status: 200, text: async () => '{}' } }
  const o = { fetchImpl, tokens: new Map(), fallback: 'DEF' }
  await setIssueState('https://github.com/o/r', 7, { state: 'closed', reason: 'not_planned' }, o)
  await setIssueState('https://github.com/o/r', 7, { state: 'open' }, o)
  assert.deepEqual(bodies, [
    ['https://api.github.com/repos/o/r/issues/7', 'PATCH', { state: 'closed', state_reason: 'not_planned' }],
    ['https://api.github.com/repos/o/r/issues/7', 'PATCH', { state: 'open' }],
  ])
})

test('checkRepoAccess never throws', async () => {
  const ok = async () => ({ ok: true, status: 200, text: async () => '{}' })
  const missing = async () => ({ ok: false, status: 404, statusText: 'x', text: async () => '{}' })
  const boom = async () => { throw new Error('timeout') }
  assert.deepEqual(await checkRepoAccess('https://github.com/o/r', { fetchImpl: ok, tokens: new Map(), fallback: 'DEF' }), { ok: true })
  assert.equal((await checkRepoAccess('https://github.com/o/r', { fetchImpl: missing, tokens: new Map(), fallback: 'DEF' })).code, 'no-access')
  assert.equal((await checkRepoAccess('https://github.com/o/r', { fetchImpl: boom, tokens: new Map(), fallback: 'DEF' })).code, 'error')
  assert.equal((await checkRepoAccess('nope', { tokens: new Map(), fallback: 'DEF' })).code, 'bad-url')
  assert.equal((await checkRepoAccess('https://github.com/o/r', { tokens: new Map(), fallback: '' })).code, 'no-access')
})
```

  Update any existing `github.test.js` test that expected `createIssue` to return `null` for a missing token/bad URL so it expects the new rejection instead.
- [ ] **Step 2: Run** `node --test bot/src/services/github.test.js` → FAIL.
- [ ] **Step 3: Implement** in `github.js`: drop the module-level `token`; add `parseTokens`, `tokenFor`, `GitHubError`; make `gh(path, { token, fetchImpl, ...options })` take the token and attach `err.status = res.status` on non-OK responses; route every helper through `tokenFor(p.owner, opts)`; implement `createIssue`, `setIssueState`, `checkRepoAccess` per the Interfaces (401/403/404 → `no-access`). In `config.js`, add `tokens: process.env.GITHUB_TOKENS || ''` under `github`. Then `grep -rn "createIssue(" bot/src --include=*.js | grep -v test` and make every caller either catch the new errors or be updated in Tasks 5/9 (`taskCreate.js` already catches; leave its behaviour to Task 5).
- [ ] **Step 4: Run** `github.test.js` and `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(github): a token per repository owner; failures reported; issue state and access checks`.

---

### Task 5: `taskCreate` opens issues for bugs and features by the rule; the site's create route

**Files:**
- Modify: `bot/src/services/taskCreate.js`
- Modify: `bot/src/services/internalTaskRoute.js` (`handleCreateRequest`)
- Test: `bot/src/services/taskCreate.test.js`, the internal-route test file that covers `handleCreateRequest` (find it with `grep -rln handleCreateRequest bot/src --include=*.test.js`)

**Interfaces:**
- Consumes: `resolveTaskRepo`, `loadProjectLinks`, `repoReasonText` (Task 3); `createIssue` + `GitHubError` (Task 4).
- Produces: `createTask({ …existing…, repo = null, createIssue: wantIssue = true, openIssue = createIssue })` returns `{ task, channel, fellBack, issueUrl, issue }` where `issue` is `{ url }` | `{ error: string }` | `{ skipped: string }` (reason text when no repository) | `null` (opted out). The repository used is `ruled ?? repo` where `ruled = resolveTaskRepo({ projectId: project?.id, scope: fields.scope }, { links: await loadProjectLinks(db, project?.id), repos: await db.repository.findMany({ where: { guildConfigId: cfg.id } }) }).repository`; for a feature with no `ruled`, the caller's first `fields.repositoryIds` entry (looked up in `repos`) is the fallback.
- The row's `repositoryId` = that repository's id (feature: `ruled?.id ?? fields.repositoryIds?.[0] ?? null`, as before when nothing resolves; bug: `ruled?.id ?? repo?.id ?? null`).
- The issue is opened AFTER the channel exists, for both types; the body is `[description || '', '', '---', `Scope: ${scopeLabel(scope) || '—'} · Project: ${project?.name || '—'}`, `Discord: https://discord.com/channels/${guild.id}/${channel.id}`, `Task ID: ${task.id}`].join('\n')`. On success: write `externalIssueUrl`/`externalIssueNumber` on the row and `channel.send({ content: `GitHub issue: ${url}` })` (best-effort). The bug embed's `Repository` field shows the used repository's url; the old pre-channel issue call and the embed's `Issue` field go away.
- `handleCreateRequest`: passes `createIssue: b.createIssue !== false`; for a **bug**, if neither the rule nor `repositoryIds[0]` gives a repository → `bad('This project has no repository for this scope — pick a repository for the bug.')`; the response body gains `issue: made.issue ?? null`.

- [ ] **Step 1: Write the failing tests** — extend `taskCreate.test.js` (follow its existing fakes). Cover, each as its own test:
  1. a feature under a project whose link has the task's scope → `openIssue` called once with that repo's url, the row updated with url/number, `channel.send` got `GitHub issue: <url>`, result `issue: { url }`, row `repositoryId` = ruled id;
  2. a bug → same, with the bug's `Repository` field = ruled url and no `Issue` embed field;
  3. `createIssue: false` → `openIssue` never called, `issue: null`;
  4. no repository (project with two untagged links, scope `design`) → `openIssue` never called, `issue: { skipped: 'the project has no repository for this scope' }`;
  5. `openIssue` throws `new GitHubError('no-access', 'No GitHub access to o/r')` → create still resolves, `issue: { error: 'No GitHub access to o/r' }`, row not updated with an issue;
  6. a bug with no project but an explicit `repo` → that repo is used (the Discord no-project path).
  Extend the create-route test: bug with no resolvable repo and no `repositoryIds` → 400 with the exact message; `createIssue: false` in the body is forwarded; the response carries `issue`.
- [ ] **Step 2: Run** those files → FAIL.
- [ ] **Step 3: Implement** per the Interfaces above. Keep every other behaviour of both functions unchanged (ticket docs, placement, embeds, featureRepositories, notes).
- [ ] **Step 4: Run** the files and `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(tasks): open a GitHub issue for bugs and features in the scope's repository; site route passes the opt-out`.

---

### Task 6: `/create-task` — a project for bugs, the repository by the rule, the Issue toggle

**Files:**
- Modify: `bot/src/commands/create-task.js`
- Modify: `bot/src/handlers/interactions.js` and `bot/src/index.js` only to route/defer the new component ids the same way their `create_task_*` siblings are routed/deferred
- Test: `bot/src/commands/create-task.test.js`

**Interfaces:**
- Consumes: `resolveTaskRepo`, `loadProjectLinks`, `repoReasonText` (Task 3); `createTask(... createIssue ...)` and its `issue` result (Task 5).
- New pure exports (tested): `bugProjectRow(projects, selectedId)` (string select `create_task_bug_project`, the guild's projects sorted by name, max 24, plus `{ label: 'No project', value: 'none' }`), `issueToggleButton(on)` (button `create_task_issue_toggle`, label `Issue: on`/`Issue: off`), `issueReplyLine(issue)` (`{url}` → `Issue: <url>`; `{error}` → `Issue: not opened — <error>`; `{skipped}` → `Issue: not opened — <skipped>`; `null` → `Issue: off`).

Flow changes (the rest of the flow stays as it is):
- **Bug:** the first step becomes `STEP_BUG_PROJECT` (select from `bugProjectRow`) instead of `STEP_REPO`, on both the button path and the fast path (`/create-task type:bug title:…`). Picking stores `state.projectId` (`null` for `none`) and continues to the modal when there is no title yet, otherwise to `proceedAfterScope`.
- In `proceedAfterScope`, for a bug once scope is known and neither `state.repositoryId` nor `state.repoResolved` is set: compute the rule from `state.projectId` + scope. Found → store `state.repo`, `state.repositoryId`, `state.repoResolved = true`, continue as today. Not found → `STEP_REPO`: the existing repo select, but listing the project's linked repositories when it has any, else every guild repository; `handleRepoSelect` then continues via `proceedAfterScope` (title is known by then).
- **Feature:** unchanged steps. At confirm, compute the rule from the first selected project + scope for display.
- **Confirm step:** a field `Repository` = `<name> (<Scope label>)` when a repository will be used (feature: rule, else first picked repo; bug: `state.repo`), else `None — no issue`; and, when a repository will be used, `issueToggleButton(state.createIssue !== false)` in the button row. The toggle flips `state.createIssue` and re-renders the confirm step.
- **`handleCreate`:** passes `project` for bugs too (looked up from `state.projectId`), `repo` = `state.repo`, `createIssue: state.createIssue !== false`; the success embed (both types) ends with `issueReplyLine(result.issue)`.

- [ ] **Step 1: Write the failing tests** in `create-task.test.js`: the three pure helpers (option list, `none` last, 24 cap, labels, the four `issueReplyLine` cases verbatim); and `handleCreate` (it already has seams) with a flow state for a bug with `projectId` whose link carries the scope → `createTask` got that project, `createIssue: true`, reply contains `Issue: <url>`; with `createIssue: false` in state → reply `Issue: off`; with an `openIssue` that throws → reply contains `Issue: not opened — No GitHub access to o/r`. Keep the existing handleCreate tests passing (adapt only fixtures the new project lookup needs).
- [ ] **Step 2: Run** `node --test bot/src/commands/create-task.test.js` → FAIL.
- [ ] **Step 3: Implement** per the flow above. Register the new ids (`create_task_bug_project`, `create_task_issue_toggle`) in `handlers/interactions.js` exactly like `create_task_repo` / an existing `create_task_*` button, and add them to whatever defer/no-defer list in `bot/src/index.js` their siblings are in.
- [ ] **Step 4: Run** the file and `npm test` → `ℹ fail 0`. `node --check` every file you touched.
- [ ] **Step 5: Commit** `feat(create-task): bugs pick a project; the scope picks the repository; an Issue on/off toggle`.

---

### Task 7: Link with a scope, unlink, `/repos add` scope, access check

**Files:**
- Create: `bot/src/services/projectRepoLinks.js`
- Modify: `bot/src/commands/projects.js`, `bot/src/commands/repos.js`, `bot/src/handlers/interactions.js` (route new ids like the existing `projects_link_*` ones)
- Test: `bot/src/services/projectRepoLinks.test.js`, `bot/src/commands/projects.test.js` (only if it already tests the link handlers)

**Interfaces:**
- Consumes: `db.projectRepos.findMany/add/setScope/remove` (Task 2); `checkRepoAccess` (Task 4); `SCOPE_CHOICES`, `scopeLabel` (Task 1).
- Produces (`projectRepoLinks.js`):
  - `async linkRepo({ db, projectId, repositoryId, scope }) → { ok: true, updated: boolean } | { ok: false, holderRepositoryId }` — reads the project's links; if another repository holds `scope` → refuse; else `add` when not linked, then `setScope` (`scope` null for "No scope"); a duplicate-key error (`ER_DUP_ENTRY`, errno 1062) from a race → re-read and return the refusal.
  - `async unlinkRepo({ db, projectId, repositoryId }) → void`.
  - `linkRefusalText(projectName, repoName, scope)` → verbatim `<Project> already has <Repo> as its <Scope> repository — unlink it or pick another scope.` (Scope via `scopeLabel`).
  - `accessLine(result)` → `✅ GitHub access OK` | `⚠️ No GitHub access to <owner>/<repo> — issues won't open until a token can reach it` (for `no-access` and `bad-url`; for bad-url use the url text as `<owner>/<repo>` stand-in: `⚠️ No GitHub access to <url> — …`) | `GitHub access couldn't be checked right now.` (for `error`).
- `/projects`:
  - Link repo: after the project select, a scope select `projects_link_scope_select` (the five scopes + `No scope` value `none`); then `linkRepo`; reply `Linked **<Repo>** to **<Project>** as <Scope|no scope>.` (or `Updated … scope to …` when `updated`) + a blank line + `accessLine(await checkRepoAccess(repo.url))`; refusal → `linkRefusalText(...)`.
  - A new `Unlink repo` button `projects_unlink_repo` (next to Link repo) → project select `projects_unlink_project_select` → that project's linked repositories select `projects_unlink_repo_select` (label `<name> · <Scope|no scope>`) → `unlinkRepo` → `Unlinked **<Repo>** from **<Project>**.`; a project with no links → `**<Project>** has no linked repositories.`
- `/repos add`: a new optional slash option `scope` with the five choices; when a project is also given, the link goes through `linkRepo` with that scope (refusal text appended as the link note); the "Repository added" embed description gains `\n\n${accessLine(...)}` from `checkRepoAccess(url)`.

- [ ] **Step 1: Write the failing tests** `projectRepoLinks.test.js` with a fake `db.projectRepos` (in-memory rows): link new with scope; link the same repo again with another scope → `updated: true` and scope changed; refuse when another repo holds the scope (holder id returned, nothing written); `No scope` stores null and never conflicts; a fake `setScope` throwing `{ errno: 1062 }` → refusal; `unlinkRepo` removes only that pair; `linkRefusalText` and the three `accessLine` cases verbatim.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the service, then wire `/projects` and `/repos add` as described (keep existing behaviour for everything else, including `/repos add`'s create-project-by-name path and its "never reads back as Failed" rule).
- [ ] **Step 4: Run** the tests and `npm test` → `ℹ fail 0`; `node --check` the command files.
- [ ] **Step 5: Commit** `feat(projects): link a repository with a scope, unlink, and check GitHub access`.

---

### Task 8: The issue follows the task's status

**Files:**
- Create: `bot/src/services/taskIssueState.js`
- Modify: `bot/src/services/taskStatusChange.js` (`applyTaskUpdate`), `bot/src/commands/close-feature.js`, `bot/src/commands/resolve-bug.js`
- Test: `bot/src/services/taskIssueState.test.js`; extend `taskStatusChange` tests, `close-feature.test.js`, `resolve-bug.test.js`

**Interfaces:**
- Consumes: `setIssueState` (Task 4).
- Produces:
  - `issueTransition(beforeStatus, afterStatus) → { state: 'closed', reason: 'completed'|'not_planned' } | { state: 'open' } | null` — `done`/`closed`/`resolved` → closed completed; `abandoned` → closed not_planned; from any of those four to any other status → open; same status or both active → null; between two finished statuses (e.g. `resolved` → `abandoned`) → the new target (closed with the new reason).
  - `async syncIssueState({ db, task, updates, setState = setIssueState }) → { line: string|null }` — no-op (`{ line: null }`, no GitHub call) unless `updates.status` differs from `task.status`, `issueTransition` is non-null, the task has an issue number (`externalIssueNumber`, else parsed from `externalIssueUrl` `/issues/(\d+)`), and its repository resolves (`db.repository.findFirst({ where: { id: task.repositoryId, guildConfigId: task.guildConfigId } })`). On failure returns `GitHub issue not closed — <message>` / `GitHub issue not reopened — <message>`; never throws.
- Wiring: `applyTaskUpdate` gains a `syncIssue = syncIssueState` seam; after the placement step, when `updates.status !== undefined`, `const { line } = await syncIssue({ db: dbArg, task, updates })` and push `line` into `extraLines` when non-null. `/close-feature` and `/resolve-bug` gain the same seam; after their `move(...)`, call it with `updates: { status: 'closed' }` / `{ status: 'resolved' }` and, when a line comes back, `channel.send({ content: line })` (best-effort, catch).

- [ ] **Step 1: Write the failing tests** — `taskIssueState.test.js`: every `issueTransition` row above; `syncIssueState` closes with `completed` on `in_progress → done`, `not_planned` on `pending → abandoned`, reopens on `done → in_progress`; no call when the status is unchanged, when there is no issue, when the repo row is missing; number parsed from the url; a throwing `setState` → the exact failure line. Extend the three call sites' tests: the seam is called with the right `updates`; a returned line reaches `extraLines` (applyTaskUpdate) / `channel.send` (the two commands); `updates` without `status` never calls it.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the touched test files and `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(tasks): close or reopen the GitHub issue when a task finishes or comes back`.

---

### Task 9: Meeting tasks — repository by the rule, GitHub on by default, issues opened by the bot

**Files:**
- Modify: `bot/src/services/meetingTaskProject.js` (`resolveMeetingTaskProject`), `bot/src/services/meetingReviewUI.js` (GitHub default), `bot/src/services/meetingPipelineStages.js` (`mirroredStage` mirrored entries; `issueSyncingStage`)
- Test: `bot/src/services/meetingTaskProject.test.js`, `bot/src/services/meetingReviewUI.test.js`, `bot/src/services/meetingPipelineStages.test.js`

**Interfaces:**
- Consumes: `resolveTaskRepo` (Task 3); `meetingTaskScope` (existing); `createIssue` (Task 4). `ctx.links` rows now carry `scope` (Task 2).
- `resolveMeetingTaskProject(csaasTask, reviewTask, ctx)` keeps its project rules and return shape; `repositoryId` now = `resolveTaskRepo({ projectId, scope: meetingTaskScope(csaasTask) }, { links: ctx.links, repos: ctx.repos }).repository?.id ?? null`. Update its header comment (the "sub-project 4 will pick repositories by scope" note is now done).
- `initReviewState` and `buildReviewMessage`'s fallback state: `github: true`.
- `mirroredStage`: each `mirrored` entry also records `repositoryId: row.repositoryId ?? null`.
- `issueSyncingStage({ job, db, csaasClient, openIssue = createIssue })`: for each mirrored entry with `github` and a `dbTaskId`: skip when it already has `externalIssueUrl` (idempotent retry); no `repositoryId` → push `{ csaasTaskId, reason: 'no repository for this project and scope' }`; else repo row by id from `db.repository.findMany({ where: { guildConfigId } })` → `openIssue(repo.url, entry.title, body)` where body = the CSAAS task's intended actions joined by newlines (plus its `code_residence` line when present) + `\n\n---\nFrom meeting: <dataJson.title || meetingId>`; success → `db.task.update({ where: { id: entry.dbTaskId }, data: { externalIssueUrl, externalIssueNumber } })` and set them on the entry; failure → `{ csaasTaskId, reason: e.message }`. `csaasClient.issueSync` is no longer called. Still always advances. `resolveRepoSlug` stays exported (other code/tests may use it).

- [ ] **Step 1: Update/write tests** — `meetingTaskProject.test.js`: replace the "repository kept only when the match's project is the task's project" expectations with rule-based ones (scope link wins; single untagged link used; two untagged → null; meeting-project override picks the meeting project's scope link). `meetingReviewUI.test.js`: new state defaults `github: true` (fix any test that assumed false). `meetingPipelineStages.test.js`: replace the `issue_syncing` tests that mock `csaasClient.issueSync` with ones passing a fake `openIssue`: opens one issue per flagged entry with a repositoryId and writes url/number by `id`; an entry already holding `externalIssueUrl` is skipped (no second call); no repositoryId → error recorded, no call; a throwing `openIssue` → error recorded, stage still advances; `csaasClient.issueSync` is never called (pass a `csaasClient` whose `issueSync` throws). `mirrored` entries carry `repositoryId`.
- [ ] **Step 2: Run** the three files → FAIL.
- [ ] **Step 3: Implement.** Make sure the stage runner passes nothing new in production (default `openIssue`), and that the done-stage summary still renders issue links from the entries.
- [ ] **Step 4: Run** the files and `npm test` → `ℹ fail 0`.
- [ ] **Step 5: Commit** `feat(meetings): repository by project and scope; GitHub on by default; the bot opens meeting issues`.

---

### Task 10: CSAAS — Mobile scope, `create_issue` forwarded, `projectRepos` in the payload

Work in `D:\Work\Granjur Technologies\CSAAS_Backend`: `git checkout -b feat/repo-scopes main`.

**Files:**
- Modify: `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingTaskScope.js` (`MEETING_TASK_SCOPES`), `Services/SysScripts/AIScripts/meetingAgents.js` (prompt schema line + SCOPE RULE), `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksWrite.js` (create field list ~line 215 and the body sent to the bot — mirror how `repository_ids` is mapped), `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js` (payload: add `projectRepos`)
- Test: `Services/SysScripts/TestScripts/meeting-test/meetingTaskScope.test.js` (jest) and the discord-tasks-test node scripts that cover the create pass-through and the payload assembly (find them with `grep -rln "repository_ids\|assembleTasks" Services/SysScripts/TestScripts`)

**Interfaces:**
- `MEETING_TASK_SCOPES = ["backend", "frontend", "mobile", "qa", "design"]`; prompt enum `"scope": "backend|frontend|mobile|qa|design"`; SCOPE RULE adds "mobile apps (React Native, iOS, Android) are mobile" and "web screens and client code are frontend".
- Create pass-through: accepts `create_issue` (boolean) and forwards it to the bot as `createIssue` (same place `repository_ids` becomes `repositoryIds`); absent → not forwarded (the bot defaults to true).
- Payload: `projectRepos: [{ projectId, repositoryId, scope }]` read with `SELECT project_id AS projectId, repository_id AS repositoryId, scope FROM granjur.project_repos WHERE project_id IN (<the payload's visible project ids>)` (skip the query and return `[]` when there are none), placed next to `repositories` in the returned object; hidden projects' links are never included.

- [ ] **Step 1: Tests** — jest: `normalizeMeetingTaskScope('Mobile') === 'mobile'`, `MEETING_TASK_SCOPES` exact, prompt contains `"scope": "backend|frontend|mobile|qa|design"`. Node scripts: `create_issue: false` forwarded as `createIssue: false`, absent → no `createIssue` key; `assembleTasks` (or wherever the payload is built) includes `projectRepos` only for visible projects and `[]` when none.
- [ ] **Step 2: Run** them → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx jest Services/SysScripts/TestScripts/meeting-test/meetingTaskScope.test.js Services/SysScripts/TestScripts/portalAnyUrddPermission.test.js` and `for f in Services/SysScripts/TestScripts/discord-tasks-test/*.test.js; do node "$f" || echo "FAILED $f"; done` → no failures.
- [ ] **Step 5: Commit** `feat(discord-tasks): Mobile scope, create_issue pass-through, projectRepos in the payload`.

---

### Task 11: Site — Mobile, where the issue goes, repositories on project cards

Work in the worktree `D:\Work\Granjur Technologies\UBS-Doc-repo-scopes` (see Workspaces).

**Files:**
- Modify: `src/screens/tasksLogic.ts` (`SCOPE_LABEL`, `ScopeFilter`, `SCOPE_FILTERS`, `ScopeTone`, `fixedScope`), `src/screens/team/ScopeBadge.tsx` (a Mobile colour in both themes), the payload types/normaliser that read `repositories` (add `projectRepos`, default `[]`), `src/screens/team/taskFormLogic.ts`, `src/screens/team/TaskCreate.tsx`, and the project card component(s) on the Tasks tab (find with `grep -rn "docsSlug" src/screens/team/*.tsx`)
- Create: `src/screens/team/repoLogic.ts`
- Test: `src/screens/tasksLogic.test.ts`, `src/screens/team/repoLogic.test.ts`, `src/screens/team/taskFormLogic.test.ts`

**Interfaces:**
- `repoLogic.ts`: `resolveTaskRepo({ projectId, scope }, { projectRepos, repositories })` — the same three rules and reasons as the bot's (Task 3), same reason texts; `projectRepoList(projectId, projectRepos, repositories) → { name, scope }[]` sorted by the scope order then name (untagged last).
- Create form: the repository picker is removed; a line shows `Issue goes to **<repo>** (<Scope>)` or `No repository for this project and scope — no issue`; an `Open a GitHub issue` checkbox (default on, disabled when no repository). The create body sends `create_issue` (boolean) and `repository_ids: []` — except a **bug** with no resolvable repository, which is refused client-side with `This project has no repository for this scope — link one in Discord with /projects → Link repo.` (no request sent).
- Scope: `mobile` everywhere scopes are listed (labels `Mobile`), filter order All, Backend, Frontend, Mobile, QA, Design, No scope.
- Project cards: under the card header, `Repositories: Framework_Node · Backend, Framework_React · Frontend` (or nothing when the project has none).

- [ ] **Step 1: Tests** — `repoLogic.test.ts` mirrors the bot's rule tests (Task 3) and `projectRepoList` ordering; `tasksLogic.test.ts`: Mobile in `SCOPE_FILTERS` order, `fixedScope('Mobile') === 'mobile'`, filter matches; `taskFormLogic.test.ts`: the create body carries `create_issue` and empty `repository_ids`; a bug with no repository is refused with the exact message; a feature with no repository is allowed with `create_issue` false.
- [ ] **Step 2: Run** `npx vitest run <those files>` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` (all), `npx tsc --noEmit`, `npm run build` → all clean.
- [ ] **Step 5: Commit** `feat(team): Mobile scope; show where a task's GitHub issue goes; repositories on project cards`.

---

### Task 12: Full suites, knowledge and state

**Files:** `.claude/knowledge/` (new `repositories-and-issues.md` + README index line; update `project-tasks-site.md` and `csaas-meeting-workflow-integration.md` where they describe repos/issues/scopes), `.claude/state/backlog.md`, `.claude/state/completed.md`, `.claude/state/session.md`.

- [ ] **Step 1:** bot `npm test` (`ℹ fail 0`); CSAAS jest file + discord-tasks node scripts; site `npx vitest run`.
- [ ] **Step 2: Knowledge** — `repositories-and-issues.md`: the scoped links and migration 030; the rule and where it's used; `GITHUB_TOKENS`/`GITHUB_TOKEN` (set by hand in `~/Granjur-Discord-Bot/.env` on the VM; never in git); issue creation for both types, the opt-out and the reported failures; status sync; the access check; meeting issues opened by the bot (CSAAS `issueSync` no longer used by the bot); the Mobile scope.
- [ ] **Step 3: State** — backlog: roadmap item 3 → DEPLOYED 2026-09-29 (the owner ran `/setup` and `/cleanup`); item 4 → BUILT, NOT DEPLOYED with the rollout: push bot (migration 030 on deploy; `GITHUB_TOKENS=ubs-dev-org:<PAT>` already set on the VM by the owner) → push CSAAS → push site → tag existing links with `/projects` → Link repo; add the ubs-dev-org Badar HMS repos with `/repos add` (scope) and unlink `granjurtech/Badar_HMS_Node`. completed: a 2026-09-30 entry with commits per repo. session: current state.
- [ ] **Step 4: Commit** `docs: repositories per scope and GitHub issues — knowledge and state`.

---

## Rollout (after merge; each push needs the owner's go-ahead)

1. Push the bot's `main` — migration 030 runs on deploy; `GITHUB_TOKENS` is already on the VM.
2. Push CSAAS `main` (auto-deploys).
3. Push the site (Vercel).
4. Owner: `/projects` → Link repo to tag each existing link with its scope; `/repos add` the ubs-dev-org Badar HMS repositories with their scopes and link them; `/projects` → Unlink repo the old `granjurtech/Badar_HMS_Node`.

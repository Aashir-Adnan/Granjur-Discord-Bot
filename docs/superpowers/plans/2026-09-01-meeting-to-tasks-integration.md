# Meeting → Tasks Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a bot-recorded meeting ends, drive the existing CSAAS meeting-workflow pipeline over HTTP to produce notes + tasks, use Claude to read who was explicitly assigned to what, post a Discord review UI, and on approval create assigned rows in the bot `task` table (GitHub push optional per task). Also mount the `ubs_doc` markdown repo in `/docs`.

**Architecture:** The CSAAS backend stays the source of truth for transcription/analysis/task-generation/notes. The bot adds a restart-safe job table + 60s worker that walks a linear stage machine, calling CSAAS endpoints via a single `csaasClient` module. Approved tasks are mirrored into the bot `task` table linked by `externalId`. Transport is plaintext localhost with a reused `actionPerformerURDD` field (no new auth for v1).

**Tech Stack:** Node 18 ESM, discord.js v14, `@discordjs/voice`, `node-fetch`, custom hand-written DB layer over `mysql2` (`bot/src/Database/index.js` + `db` object), SQL migrations in `bot/src/Database/migrations/`. CSAAS side: CommonJS, `executeQuery`, declarative `global.*_object` API configs, Jest. New bot test runner: `node:test` (built in, no dependency).

**Spec:** `docs/superpowers/specs/2026-09-01-meeting-to-tasks-integration-design.md` — read it alongside this plan.

## Global Constraints

- **Bot is ESM** (`"type": "module"`), Node >= 18. `import`/`export` only. No new npm dependencies in the bot.
- **Bot test runner:** `node:test` + `node:assert/strict`, files named `*.test.js` next to the module, run with `node --test`. Add `"test": "node --test"` to `package.json` scripts in Task 1.
- **Bot DB access** goes through the `db` object from `bot/src/db/index.js` (re-exports `bot/src/Database/index.js`). New models are plain `async function`s registered in the `db = { ... }` object at `bot/src/Database/index.js:1523`.
- **Bot migrations:** numbered `NNN_name.sql` in `bot/src/Database/migrations/`, applied in filename order by `npm run db:migrate`. Every migration must be idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN` guarded). Also mirror the change into `bot/src/Database/schema.sql` (the from-scratch DDL).
- **CSAAS is CommonJS**, Jest (`npm test` in `CSAAS/Backend`). Migrations: `.sql` in `CSAAS/Backend/data/migrations/` (auto-run on startup).
- **CSAAS auth:** every meeting handler calls `requireMeetingPermission(req, dp, "<verb>", meetingId)`. The bot passes `actionPerformerURDD: <CSAAS_ACTOR_URDD>` (env, provided by the user) in every request body — a URDD holding `add_meetings` + `run_meeting_ai` + `update_meetings`.
- **CSAAS Claude calls** go through `runClaudeAgent({ system, user, maxTokens })` from `Services/SysScripts/AIScripts/claudeAgent.js`, which returns parsed JSON with `__usage` / `__model` attached. Log cost with `logStageCost` from `Services/SysFunctions/logStageCost.js`.
- **Stage names** (exact, used across tasks): `created`, `transcribing`, `analyzing`, `generating_tasks`, `assigning`, `awaiting_review`, `approved`, `mirrored`, `issue_syncing`, `done`, `failed`.
- **customId scheme** for review UI (exact): `mtg_assignee:<jobId>:<taskId>`, `mtg_gh:<jobId>:<taskId>`, `mtg_taskreject:<jobId>:<taskId>`, `mtg_approve:<jobId>`, `mtg_reject:<jobId>`, `mtg_page:<jobId>:<n>`.
- **Never** call `interaction.reply`/`editReply` for the review message — it is a normal channel message edited with the bot token.

---

## File Structure

**Bot — new files**
- `bot/src/services/csaasClient.js` — the only module that knows the CSAAS wire format. Methods per spec §4.3.
- `bot/src/services/csaasClient.test.js`
- `bot/src/services/meetingPipelineWorker.js` — 60s tick, job claim, stage dispatch, retry/backoff.
- `bot/src/services/meetingPipelineWorker.test.js`
- `bot/src/services/meetingPipelineStages.js` — one function per stage transition; pure-ish (takes `{ job, deps }`).
- `bot/src/services/meetingPipelineStages.test.js`
- `bot/src/services/meetingRoster.js` — build the `{ ref, displayName, aliases[] }[]` roster.
- `bot/src/services/meetingRoster.test.js`
- `bot/src/services/meetingTaskMap.js` — pure: `(csaasTask, assignment, review) -> db.task.create args`.
- `bot/src/services/meetingTaskMap.test.js`
- `bot/src/services/meetingReviewUI.js` — pure builders for the review embeds + components + the `applyReviewAction` reducer.
- `bot/src/services/meetingReviewUI.test.js`
- `bot/src/commands/meetingReview.js` — slash commands `/meeting-review`, `/meeting-retry` + interaction handlers.
- `bot/src/services/docRoots.js` — resolve the list of doc roots (bot docs + optional `UBS_DOC_PATH`), path-traversal-safe.
- `bot/src/services/docRoots.test.js`
- `bot/src/Database/migrations/012_meeting_pipeline_job.sql`
- `bot/src/Database/migrations/013_task_external_meeting.sql`

**Bot — modified files**
- `package.json` — add `"test": "node --test"`.
- `bot/src/Database/index.js` — add `meetingPipelineJob` model fns + register; extend `taskCreate` (externalId, meetingId); add `taskFindFirst` where-clauses for `externalId`.
- `bot/src/Database/schema.sql` — new table + task columns.
- `bot/src/commands/docs.js` — use `docRoots.js`; multi-root browse.
- `bot/src/commands/playback.js` — `export` `deriveMeetingName` and `formatMeetingDate` (reused by the worker).
- `bot/src/services/voiceCapture.js` — enqueue a pipeline job when a session completes.
- `bot/src/handlers/interactions.js` — route `mtg_*` customIds and `docs_browse` multi-root values.
- `bot/src/index.js` — start `meetingPipelineWorker`.
- `bot/scripts/deploy-commands.js` (or wherever commands are collected) — pick up `meetingReview.js` (usually automatic; verify).
- `bot/.env.example` / README — new env vars.

**CSAAS — new files**
- `CSAAS/Backend/data/migrations/<date>_meeting_task_assignees.sql`
- `CSAAS/Backend/Services/SysScripts/TestScripts/meeting-test/extractAssignments.test.js` (Jest)
- `CSAAS/Backend/Src/Apis/ProjectSpecificApis/MeetingWorkflow/__tests__/approveSkipGithub.test.js` (Jest) — or colocate per repo convention

**CSAAS — modified files**
- `Services/SysScripts/AIScripts/meetingAgents.js` — add `extractAssignments`, export it.
- `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js` — `assignTasks` handler + `MeetingWorkflowAssign_object`; `skip_github` in `approveTasks` + its `step()` fields; optional `task_ids` filter in `issueSyncHandler`.

---

## Phase 0 — ubs_doc in `/docs` (independent of everything else)

### Task 1: Multi-root `/docs` with optional `UBS_DOC_PATH`

**Files:**
- Create: `bot/src/services/docRoots.js`
- Create: `bot/src/services/docRoots.test.js`
- Modify: `package.json` (scripts.test)
- Modify: `bot/src/commands/docs.js`
- Modify: `bot/src/handlers/interactions.js` (docs_browse value parsing — see Step 7)
- Modify: `bot/.env.example`

**Interfaces:**
- Produces:
  - `listRoots(): { key: string, label: string, dir: string }[]` — always includes `{ key: 'bot', label: 'Bot docs', dir: <bot/docs abs> }`; includes `{ key: 'ubs', label: 'UBS Knowledge Base', dir: <resolved UBS_DOC_PATH> }` iff `process.env.UBS_DOC_PATH` is set and the dir exists.
  - `resolveDocPath(rootKey: string, relativePath: string): string | null` — absolute path, or `null` if the root is unknown or the path escapes the root.
  - `rootByKey(rootKey: string): { key, label, dir } | null`

- [ ] **Step 1: Add the test runner script**

In `package.json` `"scripts"`, add:
```json
"test": "node --test",
```

- [ ] **Step 2: Write the failing test**

Create `bot/src/services/docRoots.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listRoots, resolveDocPath, rootByKey } from './docRoots.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const botDocs = path.resolve(here, '..', '..', 'docs')

test('bot root is always present', () => {
  const roots = listRoots()
  assert.ok(roots.find((r) => r.key === 'bot'))
  assert.equal(rootByKey('bot').dir, botDocs)
})

test('ubs root appears only when UBS_DOC_PATH is set to an existing dir', () => {
  delete process.env.UBS_DOC_PATH
  assert.equal(listRoots().find((r) => r.key === 'ubs'), undefined)
  process.env.UBS_DOC_PATH = here // any existing dir
  assert.ok(listRoots().find((r) => r.key === 'ubs'))
  delete process.env.UBS_DOC_PATH
})

test('resolveDocPath blocks traversal and unknown roots', () => {
  assert.equal(resolveDocPath('bot', '../../../etc/passwd'), null)
  assert.equal(resolveDocPath('nope', 'x.md'), null)
  assert.equal(
    resolveDocPath('bot', 'DEMO_WORKFLOW.md') ?? '',
    path.join(botDocs, 'DEMO_WORKFLOW.md'),
  )
})
```
Wait — `bot/docs/DEMO_WORKFLOW.md` may not exist; the assertion only checks path resolution, not existence, so it is fine. `resolveDocPath` does not stat.

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test bot/src/services/docRoots.test.js`
Expected: FAIL — `Cannot find module './docRoots.js'`.

- [ ] **Step 4: Implement `docRoots.js`**

Create `bot/src/services/docRoots.js`:
```js
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const BOT_DOCS = path.resolve(here, '..', '..', 'docs')

export function listRoots() {
  const roots = [{ key: 'bot', label: 'Bot docs', dir: BOT_DOCS }]
  const ubs = process.env.UBS_DOC_PATH
  if (ubs) {
    const abs = path.resolve(ubs)
    try {
      if (fs.statSync(abs).isDirectory()) {
        roots.push({ key: 'ubs', label: 'UBS Knowledge Base', dir: abs })
      }
    } catch {
      /* not present — skip silently */
    }
  }
  return roots
}

export function rootByKey(key) {
  return listRoots().find((r) => r.key === key) || null
}

export function resolveDocPath(rootKey, relativePath) {
  const root = rootByKey(rootKey)
  if (!root) return null
  const rel = path
    .normalize(relativePath || '')
    .replace(/^(\.\.(\/|\\|$))+/, '')
  const full = path.resolve(path.join(root.dir, rel))
  if (full !== root.dir && !full.startsWith(root.dir + path.sep)) return null
  return full
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test bot/src/services/docRoots.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Rewire `docs.js` onto `docRoots.js`**

In `bot/src/commands/docs.js`:
- Delete the local `DOCS_ROOT` const and the `resolveDocsPath` function.
- `import { listRoots, resolveDocPath, rootByKey } from '../services/docRoots.js'`.
- Change the browse value scheme to carry the root key: `dir:<root>:<relpath>`, `file:<root>:<relpath>`, `back:<root>:<relpath>`.
- `listDocsDir(rootKey, relativePath)` and `readDocFile(rootKey, relativePath)` call `resolveDocPath(rootKey, relativePath)`.
- `execute()`:
  - `const roots = listRoots()`.
  - If `roots.length === 1`, behave as today but seed options for `roots[0].key` at `''`.
  - If `roots.length > 1`, the first screen lists one option per root: `{ label: '📚 ' + r.label, value: 'dir:' + r.key + ':' }`.
- `handleDocsBrowse` parses `value` as `<kind>:<root>:<rest>` (split on first two `:` only — `rest` may contain `:` in theory but doc paths won't; use `const [kind, root, ...restParts] = value.split(':'); const rest = restParts.join(':')`).
- Keep the embed/chunking code unchanged.

- [ ] **Step 7: Update the interactions router comment/handler**

`bot/src/handlers/interactions.js` already routes `docs_browse` to `handleDocsBrowse` (grep for `docs_browse`). No logic change needed — the value parsing moved into `docs.js`. Verify the select-menu branch still calls `docsCmd.handleDocsBrowse(interaction)`.

- [ ] **Step 8: Smoke-check every touched file loads**

Run:
```bash
node --check bot/src/services/docRoots.js && node --check bot/src/commands/docs.js && node -e "import('./bot/src/commands/docs.js').then(()=>console.log('ok'))"
```
Expected: `ok`.

- [ ] **Step 9: Document the env var**

Add to `bot/.env.example` (create if absent):
```
# Absolute or CWD-relative path to a cloned ubs_doc checkout's docs/ folder.
# When set and present, /docs exposes it as "UBS Knowledge Base".
UBS_DOC_PATH=../UBS_Doc/docs
```
Add a short "UBS docs" paragraph to the bot README: `git clone <ubs_doc remote>` on the VM next to the bot, then set `UBS_DOC_PATH`.

- [ ] **Step 10: Commit**

```bash
git add package.json bot/src/services/docRoots.js bot/src/services/docRoots.test.js bot/src/commands/docs.js bot/.env.example bot/README.md
git commit -m "feat(docs): mount optional UBS_DOC_PATH as a second /docs root"
```

---

## Phase 1 — CSAAS backend extensions

> Run these in `C:\Users\adnan\VS_Code\Clones\CSAAS\Backend`. Test with `npm test` (Jest).

### Task 2: `skip_github` flag on `/approve`

**Files:**
- Modify: `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js` (`approveTasks` ~:834–:921 and the `MeetingWorkflowApprove_object` step ~:1726)
- Create: `Src/Apis/ProjectSpecificApis/MeetingWorkflow/__tests__/approveSkipGithub.test.js`

**Interfaces:**
- Produces: `/api/meeting/workflow/approve` accepts optional body field `skip_github` (boolean). When truthy, no GitHub issues are created even if `decision === "approved"` and `GITHUB_PAT` is set. Response shape unchanged (`{ decision, tasks, issueResults }`; `issueResults` is `[]` when skipped).

- [ ] **Step 1: Write the failing test**

Create `Src/Apis/ProjectSpecificApis/MeetingWorkflow/__tests__/approveSkipGithub.test.js`:
```js
// Unit-test the github-gate predicate in isolation.
const shouldCreateIssues = (decision, pat, skip) =>
  decision === 'approved' && !!pat && !skip

describe('approve github gate', () => {
  test('skips when skip_github is true', () => {
    expect(shouldCreateIssues('approved', 'ghp_x', true)).toBe(false)
  })
  test('creates when approved + pat + not skipped', () => {
    expect(shouldCreateIssues('approved', 'ghp_x', false)).toBe(true)
  })
  test('still skips when rejected', () => {
    expect(shouldCreateIssues('rejected', 'ghp_x', false)).toBe(false)
  })
})
```
> This mirrors the guard so a reviewer sees the intended truth table. If the repo has an existing integration harness for meeting endpoints, add a real end-to-end case there too.

- [ ] **Step 2: Run test to verify it passes as written but does not yet reflect the code**

Run: `npx jest approveSkipGithub`
Expected: PASS (the helper is self-contained). This test documents the target; Step 3 makes the real code match it.

- [ ] **Step 3: Edit `approveTasks`**

Find (~:868):
```js
if (decision === "approved" && process.env.GITHUB_PAT) {
```
Replace with:
```js
if (decision === "approved" && process.env.GITHUB_PAT && !decryptedPayload.skip_github) {
```

- [ ] **Step 4: Add the field to the endpoint config**

Find (~:1726):
```js
global.MeetingWorkflowApprove_object = {
  versions: { versionData: [{ "*": { steps: [step(approveTasks, ["meeting_id", "decision"])] } }] },
};
```
Change the fields array to `["meeting_id", "decision", "skip_github"]`.

- [ ] **Step 5: Verify the file parses**

Run: `node --check Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js`
Expected: no output (OK).

- [ ] **Step 6: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js Src/Apis/ProjectSpecificApis/MeetingWorkflow/__tests__/approveSkipGithub.test.js
git commit -m "feat(meeting): skip_github flag on /approve"
```

### Task 3: `extractAssignments` agent + `/assign` endpoint + migration

**Files:**
- Create: `CSAAS/Backend/data/migrations/<YYYYMMDD>_meeting_task_assignees.sql`
- Modify: `Services/SysScripts/AIScripts/meetingAgents.js` (add `extractAssignments`, add to `module.exports`)
- Modify: `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js` (add `assignTasks` handler near the other handlers; add `global.MeetingWorkflowAssign_object` next to the other `*_object` defs)
- Create: `Services/SysScripts/TestScripts/meeting-test/extractAssignments.test.js`

**Interfaces:**
- Consumes: `runClaudeAgent` (existing), `executeQuery` (existing), `requireMeetingPermission` (existing), `logStageCost` (existing).
- Produces:
  - `extractAssignments(transcript: string, analysis: object, tasks: object[], roster: {ref,displayName,aliases[]}[]) -> Promise<{ assignments: {task_id, assignee_ref: string|null, quote: string, confidence: number}[], __usage, __model }>`
  - `POST /api/meeting/workflow/assign` body `{ meeting_id, roster, actionPerformerURDD }` → `{ assignments: [...] }`. Persists `assignee_ref/assignee_quote/assignee_confidence` onto `meeting_tasks`.

- [ ] **Step 1: Write the migration**

Create `data/migrations/<YYYYMMDD>_meeting_task_assignees.sql` (use today's date, match sibling filename style):
```sql
ALTER TABLE meeting_tasks
  ADD COLUMN IF NOT EXISTS assignee_ref        VARCHAR(64)  NULL,
  ADD COLUMN IF NOT EXISTS assignee_quote      TEXT         NULL,
  ADD COLUMN IF NOT EXISTS assignee_confidence DECIMAL(3,2) NULL;
```
> If the CSAAS MySQL version rejects `ADD COLUMN IF NOT EXISTS`, use their standard guarded pattern (check `information_schema.COLUMNS` first — copy from a recent sibling migration).

- [ ] **Step 2: Write the failing agent test**

Create `Services/SysScripts/TestScripts/meeting-test/extractAssignments.test.js`:
```js
const { extractAssignments } = require('../../AIScripts/meetingAgents')

const roster = [
  { ref: '11', displayName: 'Ali Raza', aliases: ['Ali', 'ali'] },
  { ref: '22', displayName: 'Sara Khan', aliases: ['Sara'] },
  { ref: '33', displayName: 'Bilal', aliases: ['Bilal'] },
]
const tasks = [
  { task_id: 'a', goal_of_task: 'Build the login screen' },
  { task_id: 'b', goal_of_task: 'Write the DB migration for sessions' },
  { task_id: 'c', goal_of_task: 'Refactor the logger' },
]
const transcript = `
Ali: I'll take the login screen this sprint.
Sara: I can do the sessions migration.
Bilal: We should refactor the logger at some point.
`

// Requires ANTHROPIC creds / CLAUDE_BACKEND. Skip in CI without them.
const maybe = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.CLAUDE_BACKEND ? test : test.skip

maybe('assigns only explicitly-stated owners', async () => {
  const { assignments } = await extractAssignments(transcript, {}, tasks, roster)
  const byId = Object.fromEntries(assignments.map((a) => [a.task_id, a]))
  expect(byId.a.assignee_ref).toBe('11')
  expect(byId.b.assignee_ref).toBe('22')
  expect(byId.c.assignee_ref).toBe(null) // "at some point" is not an assignment
}, 60000)
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx jest extractAssignments`
Expected: FAIL — `extractAssignments is not a function` (or skipped if no creds; then rely on Step 6 parse check + a manual run).

- [ ] **Step 4: Implement `extractAssignments` in `meetingAgents.js`**

Add near `generateMeetingTasks`:
```js
async function extractAssignments(transcript, analysis, tasks, roster = []) {
  const system = `You extract task ownership that was EXPLICITLY stated in a meeting.
You are given a transcript, the generated task list, and a team roster.
For each task decide whether the transcript explicitly says who will do it:
a named person is assigned ("Ali will do X", "let's give the migration to Sara")
or a named speaker self-assigns ("I'll take X", "I can do X").
Rules:
- Only assign on an explicit statement. Tentative language ("we should", "at some
  point", "someone needs to") is NOT an assignment -> null.
- Match to exactly one roster entry by displayName or an alias (case-insensitive).
  If the named person is not in the roster -> null.
- Never infer from expertise, seniority, or who spoke most.
- Return the shortest verbatim transcript span that justifies the assignment.
Always respond with valid JSON exactly matching:
{
  "assignments": [
    { "task_id": "<id>", "assignee_ref": "<roster.ref or null>",
      "quote": "<verbatim span or ''>", "confidence": 0.0 }
  ]
}
Every task_id from the input MUST appear exactly once in the output.`

  const user = `ROSTER:
${JSON.stringify(roster, null, 2)}

TASKS:
${JSON.stringify(tasks.map((t) => ({ task_id: t.task_id, goal_of_task: t.goal_of_task, feature: t.feature, sub_feature: t.sub_feature })), null, 2)}

TRANSCRIPT:
${String(transcript || '').slice(0, 12000)}

Return the assignments JSON.`

  const result = await runClaudeAgent({ system, user, maxTokens: 2000 })
  const valid = new Set(roster.map((r) => String(r.ref)))
  const seen = new Set()
  const assignments = (result.assignments || [])
    .filter((a) => a && a.task_id && !seen.has(a.task_id) && seen.add(a.task_id))
    .map((a) => ({
      task_id: String(a.task_id),
      assignee_ref: valid.has(String(a.assignee_ref)) ? String(a.assignee_ref) : null,
      quote: typeof a.quote === 'string' ? a.quote.slice(0, 500) : '',
      confidence: Number.isFinite(a.confidence) ? Math.max(0, Math.min(1, a.confidence)) : 0,
    }))
  // Ensure every input task is represented.
  for (const t of tasks) {
    if (!seen.has(String(t.task_id))) {
      assignments.push({ task_id: String(t.task_id), assignee_ref: null, quote: '', confidence: 0 })
    }
  }
  assignments.__usage = result.__usage
  assignments.__model = result.__model
  return { assignments, __usage: result.__usage, __model: result.__model }
}
```
Add `extractAssignments` to the `module.exports` object at the bottom of the file.

- [ ] **Step 5: Implement the `assignTasks` handler**

In `meetingWorkflow.js`, add near `tasksHandler` / `approveTasks`:
```js
async function assignTasks(req, decryptedPayload) {
  const { meeting_id, roster } = decryptedPayload;
  if (!meeting_id) throw new Error("meeting_id is required");
  if (!Array.isArray(roster)) throw new Error("roster array is required");
  await requireMeetingPermission(req, decryptedPayload, "run_meeting_ai", meeting_id);

  const meeting = await getMeeting(meeting_id);
  if (!meeting.transcript) throw new Error("Transcript not found — transcribe first");

  const taskRows = await executeQuery(
    `SELECT task_id, goal_of_task, feature, sub_feature FROM meeting_tasks WHERE meeting_id = ?`,
    [meeting_id]
  );
  if (!taskRows.length) return { assignments: [] };

  let analysis = {};
  try { analysis = meeting.analysis_json ? JSON.parse(meeting.analysis_json) : {}; } catch (_) {}

  const { assignments, __usage, __model } = await extractAssignments(
    meeting.transcript, analysis, taskRows, roster
  );

  for (const a of assignments) {
    await executeQuery(
      `UPDATE meeting_tasks
         SET assignee_ref = ?, assignee_quote = ?, assignee_confidence = ?
       WHERE task_id = ? AND meeting_id = ?`,
      [a.assignee_ref, a.quote || null, a.confidence ?? null, a.task_id, meeting_id]
    );
  }

  try { await logStageCost(meeting_id, "assign", "extractAssignments", __model, __usage); }
  catch (_) {}

  return { assignments };
}
```
> Check `logStageCost`'s real signature in `Services/SysFunctions/logStageCost.js` and match it (the flow doc shows `logStageCost(meetingId, stageName, agentFn, model, usage)` — adjust arg order if the source differs).

- [ ] **Step 6: Register the endpoint**

Near the other `global.MeetingWorkflow*_object` defs:
```js
global.MeetingWorkflowAssign_object = {
  versions: { versionData: [{ "*": { steps: [step(assignTasks, ["meeting_id", "roster"])] } }] },
};
```

- [ ] **Step 7: Parse + test**

Run:
```bash
node --check Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js
node --check Services/SysScripts/AIScripts/meetingAgents.js
npx jest extractAssignments
```
Expected: checks OK; jest test passes if creds present (otherwise run once manually against the real backend and paste the output into the PR description).

- [ ] **Step 8: Commit**

```bash
git add data/migrations Services/SysScripts/AIScripts/meetingAgents.js Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js Services/SysScripts/TestScripts/meeting-test/extractAssignments.test.js
git commit -m "feat(meeting): /assign endpoint + extractAssignments agent"
```

### Task 4: `task_ids` filter on `/issuesync`

**Files:**
- Modify: `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js` (`issueSyncHandler` ~:1066–:1160 and its `step()` fields ~:1832)

**Interfaces:**
- Produces: `/issuesync` POST accepts optional `task_ids: string[]`. When present, only those approved tasks are synced. Absent → current behaviour (all approved tasks).

- [ ] **Step 1: Read the handler**

Open `issueSyncHandler`. Find the query that loads approved tasks (`SELECT ... FROM meeting_tasks WHERE meeting_id = ? AND status = 'approved'` or similar).

- [ ] **Step 2: Add the filter**

After destructuring `decryptedPayload`, add `const taskIds = Array.isArray(decryptedPayload.task_ids) ? decryptedPayload.task_ids.map(String) : null;`. In the approved-tasks query, when `taskIds` is non-null append `AND task_id IN (${taskIds.map(() => '?').join(',')})` and spread `...taskIds` into the params. If `taskIds` is an empty array, return `{ issues: [] }` early.

- [ ] **Step 3: Add the field to the endpoint config**

In `global.MeetingWorkflowIssuesync_object` add `"task_ids"` to the fields array for the POST step.

- [ ] **Step 4: Parse check + commit**

```bash
node --check Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js
git add Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js
git commit -m "feat(meeting): optional task_ids filter on /issuesync"
```

---

## Phase 2 — Bot: CSAAS client

### Task 5: `csaasClient.js`

**Files:**
- Create: `bot/src/services/csaasClient.js`
- Create: `bot/src/services/csaasClient.test.js`
- Modify: `bot/.env.example`

**Interfaces:**
- Consumes: `process.env.CSAAS_API_URL`, `process.env.CSAAS_ACTOR_URDD`. `node-fetch` default import (already a dep) — but Node 18 has global `fetch`; use global `fetch` and global `FormData`/`Blob`.
- Produces (all async, all throw `CsaasError` on failure):
  - `createMeeting({ title, participants }) -> { meeting_id }`
  - `transcribeSegment(meetingId, { buffer, filename, segmentIndex }) -> { preview }`
  - `analyze(meetingId) -> { analysis }`
  - `generateTasks(meetingId) -> { tasks }`
  - `assign(meetingId, roster) -> { assignments }`
  - `fetchNotes(meetingId) -> { notes, html }`
  - `fetchMeeting(meetingId) -> object`
  - `approve(meetingId, { decision, skipGithub }) -> { tasks }`
  - `issueSync(meetingId, { owner, repo, taskIds, dryRun }) -> { issues }`
  - `class CsaasError extends Error { status; body }`
  - `isConfigured(): boolean` — true iff both env vars set.

- [ ] **Step 1: Write the failing test**

Create `bot/src/services/csaasClient.test.js`:
```js
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.CSAAS_API_URL = 'http://csaas.test/api'
process.env.CSAAS_ACTOR_URDD = '999'

let calls
beforeEach(() => {
  calls = []
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return {
      ok: true,
      status: 200,
      async json() {
        return { status: 200, payload: { return: { meeting_id: 'm1', echoedBody: JSON.parse(opts.body) } } }
      },
      async text() { return '' },
    }
  }
})

const { createMeeting, CsaasError, isConfigured } = await import('./csaasClient.js')

test('isConfigured reflects env', () => {
  assert.equal(isConfigured(), true)
})

test('createMeeting unwraps payload.return and injects actionPerformerURDD', async () => {
  const out = await createMeeting({ title: 'T', participants: ['Ali'] })
  assert.equal(out.meeting_id, 'm1')
  assert.equal(calls[0].url, 'http://csaas.test/api/meeting/workflow/create')
  assert.equal(out.echoedBody.actionPerformerURDD, '999')
  assert.equal(out.echoedBody.title, 'T')
})

test('non-200 envelope throws CsaasError', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    async json() { return { status: 500, message: 'boom' } },
    async text() { return '' },
  })
  await assert.rejects(() => createMeeting({ title: 'x' }), (e) => e instanceof CsaasError && /boom/.test(e.message))
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test bot/src/services/csaasClient.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `csaasClient.js`**

```js
const BASE = () => (process.env.CSAAS_API_URL || '').replace(/\/+$/, '')
const URDD = () => process.env.CSAAS_ACTOR_URDD || ''

export function isConfigured() {
  return Boolean(BASE() && URDD())
}

export class CsaasError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'CsaasError'
    this.status = status
    this.body = body
  }
}

function unwrap(json, status) {
  if (!json || (json.status && json.status !== 200)) {
    throw new CsaasError(json?.message || json?.error_message || `CSAAS ${status}`, status, json)
  }
  return json.payload?.return ?? json
}

async function postJson(pathname, body) {
  const res = await fetch(`${BASE()}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, actionPerformerURDD: URDD() }),
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
  if (!res.ok) throw new CsaasError(json?.message || text || res.statusText, res.status, json)
  return unwrap(json, res.status)
}

async function getJson(pathname, query = {}) {
  const qs = new URLSearchParams({ ...query, actionPerformerURDD: URDD() }).toString()
  const res = await fetch(`${BASE()}${pathname}?${qs}`)
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
  if (!res.ok) throw new CsaasError(json?.message || text || res.statusText, res.status, json)
  return unwrap(json, res.status)
}

export const createMeeting = ({ title, participants }) =>
  postJson('/meeting/workflow/create', { title, participants })

export const analyze = (meetingId) =>
  postJson('/meeting/workflow/analyze', { meeting_id: meetingId })

export const generateTasks = (meetingId) =>
  postJson('/meeting/workflow/tasks', { meeting_id: meetingId })

export const assign = (meetingId, roster) =>
  postJson('/meeting/workflow/assign', { meeting_id: meetingId, roster })

export const fetchNotes = (meetingId) =>
  getJson('/meeting/workflow/notes', { meeting_id: meetingId })

export const fetchMeeting = (meetingId) =>
  getJson('/meeting/workflow/meeting', { meeting_id: meetingId })

export const approve = (meetingId, { decision, skipGithub }) =>
  postJson('/meeting/workflow/approve', {
    meeting_id: meetingId, decision, skip_github: !!skipGithub,
  })

export const issueSync = (meetingId, { owner, repo, taskIds, dryRun }) =>
  postJson('/meeting/workflow/issuesync', {
    meeting_id: meetingId, owner, repo,
    ...(taskIds ? { task_ids: taskIds } : {}),
    ...(dryRun ? { dry_run: true } : {}),
  })

export async function transcribeSegment(meetingId, { buffer, filename, segmentIndex }) {
  const form = new FormData()
  form.append('meeting_id', String(meetingId))
  form.append('segment_index', String(segmentIndex))
  form.append('actionPerformerURDD', URDD())
  form.append('file', new Blob([buffer]), filename || `segment-${segmentIndex}.ogg`)
  const res = await fetch(`${BASE()}/meeting/workflow/transcribe`, { method: 'POST', body: form })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
  if (!res.ok) throw new CsaasError(json?.message || text || res.statusText, res.status, json)
  return unwrap(json, res.status)
}
```
> **During implementation confirm the exact endpoint verbs** against `meetingWorkflow.js` (`/analyze` vs `/analyze-live`; whether `/notes` and `/meeting` are GET or accept POST). Adjust `getJson`/`postJson` per endpoint. The flow doc §3 table is the reference.

- [ ] **Step 4: Run to verify passing**

Run: `node --test bot/src/services/csaasClient.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Env docs**

Add to `bot/.env.example`:
```
# CSAAS backend meeting-workflow API (same VM). Bot no-ops the meeting pipeline if unset.
CSAAS_API_URL=http://127.0.0.1:3000/api
CSAAS_ACTOR_URDD=
```

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/csaasClient.js bot/src/services/csaasClient.test.js bot/.env.example
git commit -m "feat(meeting): csaasClient — encrypted-free localhost client for the CSAAS meeting API"
```

---

## Phase 3 — Bot: pipeline data + worker skeleton

### Task 6: `meeting_pipeline_job` table + model

**Files:**
- Create: `bot/src/Database/migrations/012_meeting_pipeline_job.sql`
- Modify: `bot/src/Database/schema.sql`
- Modify: `bot/src/Database/index.js` (model fns + register in `db`)
- Create: `bot/src/Database/meetingPipelineJob.test.js`

**Interfaces:**
- Produces `db.meetingPipelineJob`:
  - `create({ data: { guildConfigId, meetingId } }) -> row` (id via `id()`, `stage='created'`, `status='pending'`; `INSERT IGNORE` semantics on `UNIQUE(meetingId)` — return existing row if present)
  - `findByMeeting(meetingId) -> row | null`
  - `findById(jobId) -> row | null`
  - `claimBatch(limit=3) -> row[]` — `status IN ('pending') AND (nextAttemptAt IS NULL OR nextAttemptAt <= NOW())`, oldest `updatedAt` first
  - `update(jobId, patch) -> row` — patch may set `stage,status,csaasMeetingId,attempts,nextAttemptAt,lastError,reviewMessageId,dataJson` (dataJson auto-`JSON.stringify` if object)
  - `dataJson` is returned parsed (object) from all readers.

- [ ] **Step 1: Migration**

Create `bot/src/Database/migrations/012_meeting_pipeline_job.sql`:
```sql
CREATE TABLE IF NOT EXISTS meeting_pipeline_job (
  id              VARCHAR(36) PRIMARY KEY,
  guildConfigId   VARCHAR(36) NOT NULL,
  meetingId       VARCHAR(36) NOT NULL,
  csaasMeetingId  VARCHAR(64) DEFAULT NULL,
  stage           VARCHAR(32) NOT NULL DEFAULT 'created',
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts        INT NOT NULL DEFAULT 0,
  nextAttemptAt   DATETIME(3) DEFAULT NULL,
  lastError       TEXT DEFAULT NULL,
  reviewMessageId VARCHAR(64) DEFAULT NULL,
  dataJson        JSON DEFAULT NULL,
  createdAt       DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt       DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_meeting (meetingId),
  KEY idx_status (status),
  KEY idx_next (nextAttemptAt),
  CONSTRAINT mpj_guild_fk FOREIGN KEY (guildConfigId) REFERENCES guildconfig(id) ON DELETE CASCADE,
  CONSTRAINT mpj_meeting_fk FOREIGN KEY (meetingId) REFERENCES meeting(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
```
Paste the same `CREATE TABLE IF NOT EXISTS` block into `bot/src/Database/schema.sql` after the `MeetingRecording` block.

- [ ] **Step 2: Write the failing test (logic-level, no DB)**

Create `bot/src/Database/meetingPipelineJob.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backoffMs } from './meetingPipelineJob.helpers.js'

test('backoff grows and caps at 1h', () => {
  assert.equal(backoffMs(1), 60_000)
  assert.equal(backoffMs(2), 5 * 60_000)
  assert.equal(backoffMs(3), 15 * 60_000)
  assert.equal(backoffMs(4), 60 * 60_000)
  assert.equal(backoffMs(9), 60 * 60_000)
})
```

- [ ] **Step 3: Run — fails**

Run: `node --test bot/src/Database/meetingPipelineJob.test.js` → FAIL (module missing).

- [ ] **Step 4: Create the helper**

Create `bot/src/Database/meetingPipelineJob.helpers.js`:
```js
const LADDER = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]
export function backoffMs(attempt) {
  return LADDER[Math.min(attempt, LADDER.length) - 1] ?? LADDER[LADDER.length - 1]
}
export const MAX_ATTEMPTS = 6
```

- [ ] **Step 5: Run — passes**

Run: `node --test bot/src/Database/meetingPipelineJob.test.js` → PASS.

- [ ] **Step 6: Add model functions to `bot/src/Database/index.js`**

After the `MeetingRecordingStatus` block (~:1303), add:
```js
// ---------- meeting_pipeline_job ----------
function _mpjRow(row) {
  if (!row) return null
  let dataJson = null
  try { dataJson = row.dataJson ? (typeof row.dataJson === 'string' ? JSON.parse(row.dataJson) : row.dataJson) : null } catch { dataJson = null }
  return { ...row, dataJson }
}

async function meetingPipelineJobCreate({ data }) {
  const existing = await queryOne("SELECT * FROM `meeting_pipeline_job` WHERE meetingId = ?", [data.meetingId])
  if (existing) return _mpjRow(existing)
  const pk = id()
  await query(
    "INSERT INTO `meeting_pipeline_job` (id, guildConfigId, meetingId) VALUES (?, ?, ?)",
    [pk, data.guildConfigId, data.meetingId],
  )
  return _mpjRow(await queryOne("SELECT * FROM `meeting_pipeline_job` WHERE id = ?", [pk]))
}

async function meetingPipelineJobFindByMeeting(meetingId) {
  return _mpjRow(await queryOne("SELECT * FROM `meeting_pipeline_job` WHERE meetingId = ?", [meetingId]))
}
async function meetingPipelineJobFindById(jobId) {
  return _mpjRow(await queryOne("SELECT * FROM `meeting_pipeline_job` WHERE id = ?", [jobId]))
}
async function meetingPipelineJobClaimBatch(limit = 3) {
  const rows = await query(
    "SELECT * FROM `meeting_pipeline_job` WHERE status = 'pending' AND (nextAttemptAt IS NULL OR nextAttemptAt <= NOW(3)) ORDER BY updatedAt ASC LIMIT ?",
    [limit],
  )
  return rows.map(_mpjRow)
}
async function meetingPipelineJobUpdate(jobId, patch) {
  const cols = ['stage', 'status', 'csaasMeetingId', 'attempts', 'nextAttemptAt', 'lastError', 'reviewMessageId', 'dataJson']
  const sets = []
  const vals = []
  for (const c of cols) {
    if (patch[c] === undefined) continue
    sets.push(`\`${c}\` = ?`)
    vals.push(c === 'dataJson' && patch[c] !== null && typeof patch[c] === 'object' ? JSON.stringify(patch[c]) : patch[c])
  }
  if (!sets.length) return meetingPipelineJobFindById(jobId)
  vals.push(jobId)
  await query(`UPDATE \`meeting_pipeline_job\` SET ${sets.join(', ')} WHERE id = ?`, vals)
  return meetingPipelineJobFindById(jobId)
}
```
Register in the `db` object (near `meetingRecordingStatus`, ~:1663):
```js
  meetingPipelineJob: {
    create: meetingPipelineJobCreate,
    findByMeeting: meetingPipelineJobFindByMeeting,
    findById: meetingPipelineJobFindById,
    claimBatch: meetingPipelineJobClaimBatch,
    update: meetingPipelineJobUpdate,
  },
```

- [ ] **Step 7: Smoke check**

Run: `node --check bot/src/Database/index.js && node -e "import('./bot/src/db/index.js').then(m=>console.log(typeof m.default.meetingPipelineJob.claimBatch))"`
Expected: `function`.

- [ ] **Step 8: Commit**

```bash
git add bot/src/Database/migrations/012_meeting_pipeline_job.sql bot/src/Database/schema.sql bot/src/Database/index.js bot/src/Database/meetingPipelineJob.helpers.js bot/src/Database/meetingPipelineJob.test.js
git commit -m "feat(meeting): meeting_pipeline_job table + db model"
```

### Task 7: `task.externalId` + `task.meetingId`

**Files:**
- Create: `bot/src/Database/migrations/013_task_external_meeting.sql`
- Modify: `bot/src/Database/schema.sql` (`task` table)
- Modify: `bot/src/Database/index.js` (`taskCreate` INSERT, `taskFindFirst` where)
- Create: `bot/src/Database/taskExternal.test.js`

**Interfaces:**
- Produces: `db.task.create({ data })` accepts `externalId` (string|null) and `meetingId` (string|null). `db.task.findFirst({ where: { externalId } })` works.

- [ ] **Step 1: Migration**

Create `bot/src/Database/migrations/013_task_external_meeting.sql`:
```sql
ALTER TABLE `task` ADD COLUMN IF NOT EXISTS externalId VARCHAR(128) DEFAULT NULL;
ALTER TABLE `task` ADD COLUMN IF NOT EXISTS meetingId VARCHAR(36) DEFAULT NULL;
ALTER TABLE `task` ADD KEY IF NOT EXISTS idx_task_externalId (externalId);
ALTER TABLE `task` ADD KEY IF NOT EXISTS idx_task_meetingId (meetingId);
```
> If this MySQL build lacks `ADD COLUMN IF NOT EXISTS` / `ADD KEY IF NOT EXISTS`, follow the guarded `information_schema` pattern used elsewhere in the migrations dir. Mirror the columns + keys into `schema.sql`'s `CREATE TABLE task`.

- [ ] **Step 2: Failing test**

Create `bot/src/Database/taskExternal.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTaskInsertValues } from './taskInsert.helpers.js'

test('externalId + meetingId are included and default to null', () => {
  const full = buildTaskInsertValues({ guildConfigId: 'g', title: 't', externalId: 'csaas:1', meetingId: 'm' })
  assert.equal(full.externalId, 'csaas:1')
  assert.equal(full.meetingId, 'm')
  const bare = buildTaskInsertValues({ guildConfigId: 'g', title: 't' })
  assert.equal(bare.externalId, null)
  assert.equal(bare.meetingId, null)
})
```

- [ ] **Step 3: Run — fails.** `node --test bot/src/Database/taskExternal.test.js`

- [ ] **Step 4: Extract the mapping helper + wire it**

Create `bot/src/Database/taskInsert.helpers.js`:
```js
export function buildTaskInsertValues(data) {
  return {
    externalId: data.externalId ?? null,
    meetingId: data.meetingId ?? null,
  }
}
```
In `taskCreate` (`bot/src/Database/index.js`): add `externalId` and `meetingId` to the column list and the `VALUES (?...)` placeholders and the params array, using `data.externalId ?? null` and `data.meetingId ?? null`. Add a `taskFindFirst` where-branch:
```js
if (where?.externalId) { sql += " AND externalId = ?"; params.push(where.externalId) }
```
(Match the existing `taskFindFirst` structure.)

- [ ] **Step 5: Run — passes.** `node --test bot/src/Database/taskExternal.test.js`

- [ ] **Step 6: Smoke + commit**

```bash
node --check bot/src/Database/index.js
git add bot/src/Database/migrations/013_task_external_meeting.sql bot/src/Database/schema.sql bot/src/Database/index.js bot/src/Database/taskInsert.helpers.js bot/src/Database/taskExternal.test.js
git commit -m "feat(task): externalId + meetingId columns for meeting-sourced tasks"
```

### Task 8: worker skeleton + retry/backoff + wiring

**Files:**
- Create: `bot/src/services/meetingPipelineWorker.js`
- Create: `bot/src/services/meetingPipelineWorker.test.js`
- Modify: `bot/src/index.js`

**Interfaces:**
- Consumes: `db.meetingPipelineJob`, `backoffMs`/`MAX_ATTEMPTS`, a `stageRunners` map (Task 9+; injected for testability).
- Produces:
  - `startMeetingPipelineWorker(client)` — `setInterval(tick, 60_000)`; no-op (logs once) when `!process.env.MEETING_PIPELINE_ENABLED` or `!csaasClient.isConfigured()`.
  - `runTick({ db, stageRunners, client, now })` — exported for tests. Claims a batch, runs one stage per job, applies success/failure transitions.
  - `STAGE_ORDER: string[]` — the linear stage list; `nextStage(stage)` helper.

- [ ] **Step 1: Failing test**

Create `bot/src/services/meetingPipelineWorker.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick, nextStage } from './meetingPipelineWorker.js'

function fakeDb(job) {
  const store = { ...job }
  return {
    meetingPipelineJob: {
      claimBatch: async () => [store],
      update: async (id, patch) => Object.assign(store, patch),
      findById: async () => store,
    },
    _store: store,
  }
}

test('nextStage walks the ladder and stops at done', () => {
  assert.equal(nextStage('created'), 'transcribing')
  assert.equal(nextStage('issue_syncing'), 'done')
  assert.equal(nextStage('done'), 'done')
})

test('successful stage advances stage and clears error', async () => {
  const db = fakeDb({ id: 'j1', stage: 'created', status: 'pending', attempts: 0, dataJson: {} })
  const stageRunners = { created: async () => ({ patch: { csaasMeetingId: 'm9' } }) }
  await runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
  assert.equal(db._store.stage, 'transcribing')
  assert.equal(db._store.status, 'pending')
  assert.equal(db._store.csaasMeetingId, 'm9')
  assert.equal(db._store.lastError, null)
})

test('throwing stage increments attempts and backs off; fails after MAX', async () => {
  const db = fakeDb({ id: 'j1', stage: 'analyzing', status: 'pending', attempts: 5, dataJson: {} })
  const stageRunners = { analyzing: async () => { throw new Error('nope') } }
  await runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
  assert.equal(db._store.status, 'failed')
  assert.match(db._store.lastError, /nope/)
})

test('stage that returns {block:true} sets status blocked', async () => {
  const db = fakeDb({ id: 'j1', stage: 'assigning', status: 'pending', attempts: 0, dataJson: {} })
  const stageRunners = { assigning: async () => ({ patch: {}, block: true, advance: true }) }
  await runTick({ db, stageRunners, client: {}, now: () => new Date('2026-01-01') })
  assert.equal(db._store.stage, 'awaiting_review')
  assert.equal(db._store.status, 'blocked')
})
```

- [ ] **Step 2: Run — fails.** `node --test bot/src/services/meetingPipelineWorker.test.js`

- [ ] **Step 3: Implement `meetingPipelineWorker.js`**

```js
import db from '../db/index.js'
import * as csaasClient from './csaasClient.js'
import { backoffMs, MAX_ATTEMPTS } from '../Database/meetingPipelineJob.helpers.js'
import { stageRunners as defaultRunners } from './meetingPipelineStages.js'

export const STAGE_ORDER = [
  'created', 'transcribing', 'analyzing', 'generating_tasks', 'assigning',
  'awaiting_review', 'approved', 'mirrored', 'issue_syncing', 'done',
]

export function nextStage(stage) {
  const i = STAGE_ORDER.indexOf(stage)
  if (i < 0 || i >= STAGE_ORDER.length - 1) return 'done'
  return STAGE_ORDER[i + 1]
}

export async function runTick({ db, stageRunners, client, now = () => new Date() }) {
  const jobs = await db.meetingPipelineJob.claimBatch(3)
  for (const job of jobs) {
    const runner = stageRunners[job.stage]
    if (!runner) {
      await db.meetingPipelineJob.update(job.id, {
        status: 'failed', lastError: `no runner for stage ${job.stage}`,
      })
      continue
    }
    try {
      const out = (await runner({ job, db, client, csaasClient })) || {}
      const patch = { ...(out.patch || {}), lastError: null, attempts: 0, nextAttemptAt: null }
      if (out.advance !== false) patch.stage = nextStage(job.stage)
      patch.status = out.block ? 'blocked' : (patch.stage === 'done' ? 'done' : 'pending')
      await db.meetingPipelineJob.update(job.id, patch)
    } catch (err) {
      const attempts = (job.attempts || 0) + 1
      const failed = attempts >= MAX_ATTEMPTS
      await db.meetingPipelineJob.update(job.id, {
        attempts,
        status: failed ? 'failed' : 'pending',
        lastError: String(err?.message || err).slice(0, 2000),
        nextAttemptAt: failed ? null : new Date(now().getTime() + backoffMs(attempts)),
      })
      if (failed) await notifyFailure(client, job, err).catch(() => {})
    }
  }
}

async function notifyFailure(client, job, err) {
  // Implemented in Task 18; noop-safe stub for now.
}

let started = false
export function startMeetingPipelineWorker(client) {
  if (started) return
  started = true
  if (!process.env.MEETING_PIPELINE_ENABLED || !csaasClient.isConfigured()) {
    console.log('[meetingPipeline] disabled (MEETING_PIPELINE_ENABLED unset or CSAAS not configured)')
    return
  }
  console.log('[meetingPipeline] worker started (60s tick)')
  const tick = () =>
    runTick({ db, stageRunners: defaultRunners, client }).catch((e) =>
      console.error('[meetingPipeline] tick error:', e?.message || e),
    )
  setInterval(tick, 60_000)
  setTimeout(tick, 5_000)
}
```

- [ ] **Step 4: Create a stub `meetingPipelineStages.js` so the import resolves**

```js
// Stage runners are filled in Tasks 9–16. Each: async ({ job, db, client, csaasClient })
//   -> { patch?, advance?: boolean (default true), block?: boolean }
export const stageRunners = {}
```

- [ ] **Step 5: Run — passes.** `node --test bot/src/services/meetingPipelineWorker.test.js`

- [ ] **Step 6: Wire into `index.js`**

In `bot/src/index.js`, next to `startMeetingReminder(...)`:
```js
import { startMeetingPipelineWorker } from "./services/meetingPipelineWorker.js";
// ... after client is ready / other workers start:
startMeetingPipelineWorker(client);
```

- [ ] **Step 7: Smoke + commit**

```bash
node --check bot/src/services/meetingPipelineWorker.js && node -e "import('./bot/src/index.js').catch(e=>{console.error(e);process.exit(1)})" || true
git add bot/src/services/meetingPipelineWorker.js bot/src/services/meetingPipelineWorker.test.js bot/src/services/meetingPipelineStages.js bot/src/index.js
git commit -m "feat(meeting): pipeline worker skeleton with retry/backoff"
```

---

## Phase 4 — Bot: pipeline stages

### Task 9: roster builder + enqueue hook + `created` stage

**Files:**
- Create: `bot/src/services/meetingRoster.js`
- Create: `bot/src/services/meetingRoster.test.js`
- Modify: `bot/src/services/voiceCapture.js` (enqueue on session complete)
- Modify: `bot/src/services/meetingPipelineStages.js` (`created` runner)
- Modify: `bot/src/commands/playback.js` (`export` `deriveMeetingName`, `formatMeetingDate`)

**Interfaces:**
- Consumes: `db.guildMember.findMany`, `db.meetingRecording.findMany`, a Discord `guild` object.
- Produces:
  - `buildRoster({ guild, guildConfigId, meetingId }) -> Promise<{ ref, displayName, aliases: string[] }[]>` — verified members who were present (have a `MeetingRecording` row for the meeting), falling back to all verified members if none matched.
  - `aliasesFor(member, email) -> string[]` (pure, exported for test).
  - `meetingPipelineStages.created({ job, db, client, csaasClient })`.

- [ ] **Step 1: Failing test**

Create `bot/src/services/meetingRoster.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aliasesFor } from './meetingRoster.js'

test('aliasesFor: displayName words + email local part, deduped, no blanks', () => {
  const a = aliasesFor({ displayName: 'Ali Raza', user: { username: 'alir' } }, 'ali.raza@granjur.com')
  assert.ok(a.includes('Ali'))
  assert.ok(a.includes('Ali Raza'))
  assert.ok(a.includes('ali.raza'))
  assert.ok(a.includes('alir'))
  assert.equal(new Set(a).size, a.length)
})
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement `meetingRoster.js`**

```js
import db from '../db/index.js'

export function aliasesFor(member, email) {
  const out = new Set()
  const dn = member?.displayName || member?.user?.globalName || member?.user?.username || ''
  if (dn) {
    out.add(dn)
    for (const w of dn.split(/\s+/)) if (w.length > 1) out.add(w)
  }
  if (member?.user?.username) out.add(member.user.username)
  if (email && email.includes('@')) out.add(email.split('@')[0])
  return [...out].filter(Boolean)
}

export async function buildRoster({ guild, guildConfigId, meetingId }) {
  const members = await db.guildMember.findMany({ where: { guildConfigId, status: 'verified' } })
  const recs = meetingId
    ? await db.meetingRecording.findMany({ where: { meetingId } })
    : []
  const present = new Set(recs.map((r) => r.memberId))

  const pick = present.size
    ? members.filter((m) => present.has(m.discordId))
    : members

  const roster = []
  for (const gm of pick) {
    let dm = null
    try { dm = await guild.members.fetch(gm.discordId) } catch { /* left the guild */ }
    roster.push({
      ref: gm.discordId,
      displayName: dm?.displayName || gm.email?.split('@')[0] || gm.discordId,
      aliases: aliasesFor(dm || {}, gm.email),
    })
  }
  return roster
}
```

- [ ] **Step 4: Run — passes.**

- [ ] **Step 5: Export the playback helpers**

In `bot/src/commands/playback.js` add `export` in front of `function deriveMeetingName(` and `function formatMeetingDate(`.

- [ ] **Step 6: Implement the `created` stage**

In `meetingPipelineStages.js`:
```js
import { buildRoster } from './meetingRoster.js'
import { deriveMeetingName, formatMeetingDate } from '../commands/playback.js'

async function createdStage({ job, db, csaasClient, client }) {
  const meeting = await db.meeting.findUnique({ where: { id: job.meetingId } })
  const recs = await db.meetingRecording.findMany({ where: { meetingId: job.meetingId } })
  const guild = await client.guilds.fetch(await guildIdFor(db, job.guildConfigId))
  const roster = await buildRoster({ guild, guildConfigId: job.guildConfigId, meetingId: job.meetingId })

  const title = deriveMeetingName(recs[0]?.filePath, job.meetingId) +
    ' — ' + formatMeetingDate(recs[0]?.startedAt || meeting?.createdAt)

  const { meeting_id } = await csaasClient.createMeeting({
    title,
    participants: roster.map((r) => r.displayName),
  })
  return {
    patch: {
      csaasMeetingId: meeting_id,
      dataJson: { ...(job.dataJson || {}), title, roster, uploaded: [] },
    },
  }
}

async function guildIdFor(db, guildConfigId) {
  const cfg = await db.guildConfig?.findUnique?.({ where: { id: guildConfigId } })
  // guildConfig.findUnique only supports {guildId}; fall back to a direct lookup helper.
  return cfg?.guildId ?? (await import('../Database/index.js')).getGuildConfigById(guildConfigId).then((g) => g.guildId)
}

export const stageRunners = { created: createdStage }
```
> Clean this up during implementation: add a `getGuildConfigById` import at top instead of the inline dynamic import. `getGuildConfigById` is already exported from `bot/src/Database/index.js`.

- [ ] **Step 7: Enqueue hook in `voiceCapture.js`**

Find where `endMeetingSession` sets `MeetingRecordingStatus.status = "completed"` (grep `completed`). Immediately after that update succeeds, add:
```js
try {
  const recs = await db.meetingRecording.findMany({ where: { meetingId } })
  if (recs.length && process.env.MEETING_PIPELINE_ENABLED) {
    await db.meetingPipelineJob.create({ data: { guildConfigId: cfg.id, meetingId } })
    console.log(`[meetingPipeline] enqueued job for meeting ${meetingId}`)
  }
} catch (e) {
  console.error('[meetingPipeline] enqueue failed:', e?.message || e)
}
```
Use whatever `cfg`/`guildConfigId` variable is already in scope there; if none, load it via `getOrCreateGuildConfig(guild.id)`.

- [ ] **Step 8: Smoke + commit**

```bash
node --check bot/src/services/meetingRoster.js bot/src/services/meetingPipelineStages.js bot/src/services/voiceCapture.js
node --test bot/src/services/meetingRoster.test.js
git add bot/src/services/meetingRoster.js bot/src/services/meetingRoster.test.js bot/src/services/meetingPipelineStages.js bot/src/services/voiceCapture.js bot/src/commands/playback.js
git commit -m "feat(meeting): roster builder, enqueue hook, created stage"
```

### Task 10: `transcribing` stage (idempotent segment upload)

**Files:**
- Modify: `bot/src/services/meetingPipelineStages.js`
- Create/extend: `bot/src/services/meetingPipelineStages.test.js`

**Interfaces:**
- Produces: `meetingPipelineStages.stageRunners.transcribing` — for each `MeetingRecording` not in `job.dataJson.uploaded`, reads the file and calls `csaasClient.transcribeSegment`. On partial progress it returns `{ advance: false, patch: { dataJson } }` so the next tick continues; when all are uploaded it returns `{ patch: { dataJson } }` (advance). If a file is missing on disk, record it in `dataJson.missing` and skip; if **every** file is missing, throw.

- [ ] **Step 1: Failing test**

Add to `meetingPipelineStages.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stageRunners } from './meetingPipelineStages.js'

test('transcribing uploads only not-yet-uploaded files, idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-'))
  const f1 = path.join(dir, 'ali.ogg'); fs.writeFileSync(f1, 'aaa')
  const f2 = path.join(dir, 'sara.ogg'); fs.writeFileSync(f2, 'bbb')

  const uploaded = []
  const csaasClient = {
    transcribeSegment: async (mid, { filename, segmentIndex }) => {
      uploaded.push({ filename, segmentIndex }); return { preview: 'ok' }
    },
  }
  const db = {
    meetingRecording: { findMany: async () => [
      { id: 'r1', filePath: f1, fileName: 'ali.ogg', startedAt: '2026-01-01T00:00:00Z' },
      { id: 'r2', filePath: f2, fileName: 'sara.ogg', startedAt: '2026-01-01T00:01:00Z' },
    ] },
  }
  const job = { id: 'j', csaasMeetingId: 'm', dataJson: { uploaded: ['r1'] } }
  const out = await stageRunners.transcribing({ job, db, csaasClient, client: {} })
  assert.deepEqual(uploaded.map((u) => u.filename), ['sara.ogg'])
  assert.deepEqual(out.patch.dataJson.uploaded.sort(), ['r1', 'r2'])
})
```

- [ ] **Step 2: Run — fails** (`stageRunners.transcribing` undefined).

- [ ] **Step 3: Implement**

```js
import fs from 'node:fs/promises'

async function transcribingStage({ job, db, csaasClient }) {
  const recs = (await db.meetingRecording.findMany({ where: { meetingId: job.meetingId } }))
    .slice()
    .sort((a, b) => new Date(a.startedAt || 0) - new Date(b.startedAt || 0))
  const data = { uploaded: [], missing: [], ...(job.dataJson || {}) }
  const done = new Set(data.uploaded)
  let index = data.uploaded.length + data.missing.length

  for (const rec of recs) {
    if (done.has(rec.id) || data.missing.includes(rec.id)) continue
    let buffer
    try { buffer = await fs.readFile(rec.filePath) }
    catch { data.missing.push(rec.id); continue }
    const label = (rec.fileName || `speaker-${index}`).replace(/\.ogg$/i, '')
    await csaasClient.transcribeSegment(job.csaasMeetingId, {
      buffer, filename: `${label}.ogg`, segmentIndex: index,
    })
    data.uploaded.push(rec.id)
    done.add(rec.id)
    index++
    return { advance: false, patch: { dataJson: data } } // one file per tick — keeps ticks short
  }

  if (data.uploaded.length === 0) throw new Error('all meeting recording files missing on disk')
  return { patch: { dataJson: data } }
}
```
Register `transcribing: transcribingStage` in `stageRunners`.

> One file per tick makes each tick short and each upload independently retryable. For a small meeting (2–4 speakers) that is 2–4 minutes to walk — acceptable. If that is too slow, batch all uploads in one call inside a `for` loop and return once.

- [ ] **Step 4: Run — passes.**

- [ ] **Step 5: Commit**

```bash
node --check bot/src/services/meetingPipelineStages.js
node --test bot/src/services/meetingPipelineStages.test.js
git add bot/src/services/meetingPipelineStages.js bot/src/services/meetingPipelineStages.test.js
git commit -m "feat(meeting): transcribing stage — idempotent per-speaker segment upload"
```

### Task 11: `analyzing`, `generating_tasks`, `assigning` stages

**Files:**
- Modify: `bot/src/services/meetingPipelineStages.js`
- Modify: `bot/src/services/meetingPipelineStages.test.js`

**Interfaces:**
- Produces three `stageRunners` entries. `analyzing` → `csaasClient.analyze` → store `dataJson.analysis`. `generating_tasks` → `csaasClient.generateTasks` → store `dataJson.tasks` (array). `assigning` → build roster (reuse `dataJson.roster` from `created`), `csaasClient.assign` → store `dataJson.assignments`; returns `{ block: true }` so the job parks at `awaiting_review` for Task 13's runner. **Correction:** `assigning` should advance to `awaiting_review` and NOT block — `awaiting_review`'s own runner (Task 13) posts the UI and then blocks. So `assigning` returns a normal advance.

- [ ] **Step 1: Failing test**

```js
test('analyzing/generating_tasks/assigning store their results on dataJson', async () => {
  const csaasClient = {
    analyze: async () => ({ analysis: { summary: 's' } }),
    generateTasks: async () => ({ tasks: [{ task_id: 't1', goal_of_task: 'g' }] }),
    assign: async () => ({ assignments: [{ task_id: 't1', assignee_ref: '11', quote: 'q', confidence: 0.9 }] }),
  }
  const db = { meetingRecording: { findMany: async () => [] } }
  let job = { id: 'j', meetingId: 'M', csaasMeetingId: 'm', dataJson: { roster: [{ ref: '11', displayName: 'Ali', aliases: ['Ali'] }] } }

  let out = await stageRunners.analyzing({ job, db, csaasClient, client: {} })
  Object.assign(job.dataJson, out.patch.dataJson)
  assert.equal(job.dataJson.analysis.summary, 's')

  out = await stageRunners.generating_tasks({ job, db, csaasClient, client: {} })
  Object.assign(job.dataJson, out.patch.dataJson)
  assert.equal(job.dataJson.tasks[0].task_id, 't1')

  out = await stageRunners.assigning({ job, db, csaasClient, client: {} })
  Object.assign(job.dataJson, out.patch.dataJson)
  assert.equal(job.dataJson.assignments[0].assignee_ref, '11')
})
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement**

```js
async function analyzingStage({ job, csaasClient }) {
  const { analysis } = await csaasClient.analyze(job.csaasMeetingId)
  return { patch: { dataJson: { ...(job.dataJson || {}), analysis } } }
}

async function generatingTasksStage({ job, csaasClient }) {
  const res = await csaasClient.generateTasks(job.csaasMeetingId)
  return { patch: { dataJson: { ...(job.dataJson || {}), tasks: res.tasks || [] } } }
}

async function assigningStage({ job, csaasClient }) {
  const roster = (job.dataJson && job.dataJson.roster) || []
  const { assignments } = await csaasClient.assign(job.csaasMeetingId, roster)
  return { patch: { dataJson: { ...(job.dataJson || {}), assignments: assignments || [] } } }
}
```
Register all three in `stageRunners` (`analyzing`, `generating_tasks`, `assigning`).

- [ ] **Step 4: Run — passes. Commit.**

```bash
node --test bot/src/services/meetingPipelineStages.test.js
git add bot/src/services/meetingPipelineStages.js bot/src/services/meetingPipelineStages.test.js
git commit -m "feat(meeting): analyzing, generating_tasks, assigning stages"
```

### Task 12: review UI builders + `applyReviewAction` reducer

**Files:**
- Create: `bot/src/services/meetingReviewUI.js`
- Create: `bot/src/services/meetingReviewUI.test.js`

**Interfaces:**
- Produces (all pure, no discord.js runtime calls beyond builders):
  - `initReviewState(tasks, assignments) -> { tasks: {taskId, assigneeRef|null, github:false, rejected:false}[], page: 0 }`
  - `applyReviewAction(state, action) -> newState` where `action` is one of
    `{ type:'assignee', taskId, ref }`, `{ type:'toggleGithub', taskId }`,
    `{ type:'rejectTask', taskId }`, `{ type:'page', page }`.
  - `buildReviewMessage({ job, notes, reportPath, state, roster }) -> { embeds, components }` — discord.js `EmbedBuilder`/`ActionRowBuilder` output; paginates tasks 3 per page (each task = 2 rows: an assignee `UserSelectMenuBuilder` row + a buttons row); a footer row with page nav + `mtg_approve` + `mtg_reject`.
  - `summarizeApproval(state, tasks) -> { approved: [...], rejectedCount, githubCount }`

- [ ] **Step 1: Failing test**

Create `bot/src/services/meetingReviewUI.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initReviewState, applyReviewAction, summarizeApproval } from './meetingReviewUI.js'

const tasks = [
  { task_id: 'a', goal_of_task: 'A' },
  { task_id: 'b', goal_of_task: 'B' },
]
const assignments = [
  { task_id: 'a', assignee_ref: '11' },
  { task_id: 'b', assignee_ref: null },
]

test('initReviewState seeds from assignments', () => {
  const s = initReviewState(tasks, assignments)
  assert.equal(s.tasks.find((t) => t.taskId === 'a').assigneeRef, '11')
  assert.equal(s.tasks.find((t) => t.taskId === 'b').assigneeRef, null)
})

test('actions are immutable and targeted', () => {
  let s = initReviewState(tasks, assignments)
  s = applyReviewAction(s, { type: 'assignee', taskId: 'b', ref: '22' })
  s = applyReviewAction(s, { type: 'toggleGithub', taskId: 'a' })
  s = applyReviewAction(s, { type: 'rejectTask', taskId: 'b' })
  assert.equal(s.tasks.find((t) => t.taskId === 'b').assigneeRef, '22')
  assert.equal(s.tasks.find((t) => t.taskId === 'b').rejected, true)
  assert.equal(s.tasks.find((t) => t.taskId === 'a').github, true)
})

test('summarizeApproval excludes rejected, counts github', () => {
  let s = initReviewState(tasks, assignments)
  s = applyReviewAction(s, { type: 'toggleGithub', taskId: 'a' })
  s = applyReviewAction(s, { type: 'rejectTask', taskId: 'b' })
  const sum = summarizeApproval(s, tasks)
  assert.equal(sum.approved.length, 1)
  assert.equal(sum.approved[0].task_id, 'a')
  assert.equal(sum.githubCount, 1)
  assert.equal(sum.rejectedCount, 1)
})
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement `meetingReviewUI.js`**

Implement `initReviewState`, `applyReviewAction` (spread-copy the array, map the one matching task), `summarizeApproval` per the interfaces. Then `buildReviewMessage` using discord.js builders:
- header `EmbedBuilder`: meeting title, `notes` chunked (import `chunkForEmbed`-style logic — copy the small helper from `docs.js` or inline a 4000-char slice), and if `reportPath` a line "Full report: `<reportPath>` (on the VM)".
- Per task on the current page: an `EmbedBuilder` (goal, feature/sub_feature, code_residence, "Assignee: <@ref> / unassigned", quote if any, "⚠️ rejected" if rejected), then a `UserSelectMenuBuilder` with `customId: mtg_assignee:<jobId>:<taskId>`, then an `ActionRowBuilder` of buttons: `mtg_gh:<jobId>:<taskId>` (label "GitHub: on/off", style Success/Secondary), `mtg_taskreject:<jobId>:<taskId>` (label "Drop", Danger).
- Footer `ActionRowBuilder`: `mtg_page:<jobId>:<n-1>` / `mtg_page:<jobId>:<n+1>` when multiple pages, `mtg_approve:<jobId>` (Success "Approve all & assign"), `mtg_reject:<jobId>` (Danger "Reject meeting").
- Respect Discord's max 5 action rows per message: 3 tasks/page × (1 select + 1 buttons) = 6 rows — too many. **Use 2 tasks per page** (4 rows) + 1 footer row = 5. Encode `PAGE_SIZE = 2`.

- [ ] **Step 4: Run — passes.** Adjust `PAGE_SIZE` if the test hard-codes page math.

- [ ] **Step 5: Commit**

```bash
node --check bot/src/services/meetingReviewUI.js
node --test bot/src/services/meetingReviewUI.test.js
git add bot/src/services/meetingReviewUI.js bot/src/services/meetingReviewUI.test.js
git commit -m "feat(meeting): review UI builders + review-state reducer"
```

### Task 13: `awaiting_review` stage (post the UI, block)

**Files:**
- Modify: `bot/src/services/meetingPipelineStages.js`
- Modify: `bot/src/services/meetingPipelineStages.test.js`
- Modify: `bot/.env.example` (`MEETING_REPORTS_DIR`)

**Interfaces:**
- Produces `stageRunners.awaiting_review`: `csaasClient.fetchNotes` → write `html` to `${MEETING_REPORTS_DIR||'bot/meeting-reports'}/<meetingId>.html` (best-effort) → `initReviewState` → `buildReviewMessage` → send to the meeting's text channel (resolve via `db.meetingChannel.findFirst({ where: { guildConfigId, voiceChannelId: meeting.channelId } })` → `textChannelId`; fallbacks: the voice channel object's own text chat, else skip with a logged warning) → store `dataJson.review = state`, `dataJson.notes`, `reviewMessageId` → return `{ block: true }`.

- [ ] **Step 1: Failing test** (channel send mocked)

```js
test('awaiting_review posts a message and blocks', async () => {
  const sent = []
  const channel = { send: async (payload) => { sent.push(payload); return { id: 'msg1' } } }
  const client = { channels: { fetch: async () => channel } }
  const csaasClient = { fetchNotes: async () => ({ notes: 'Notes body', html: '<html></html>' }) }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1', createdAt: '2026-01-01' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    meetingRecording: { findMany: async () => [] },
  }
  const job = { id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
    dataJson: { title: 'T', tasks: [{ task_id: 'a', goal_of_task: 'A' }], assignments: [{ task_id: 'a', assignee_ref: '11' }],
      roster: [{ ref: '11', displayName: 'Ali', aliases: [] }] } }
  const out = await stageRunners.awaiting_review({ job, db, csaasClient, client })
  assert.equal(out.block, true)
  assert.equal(out.patch.reviewMessageId, 'msg1')
  assert.ok(sent.length === 1)
})
```
> `MEETING_REPORTS_DIR` should point at an OS temp dir in the test, or the writer must swallow write errors. Set `process.env.MEETING_REPORTS_DIR = fs.mkdtempSync(...)` at the top of the test.

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement.** Register `awaiting_review: awaitingReviewStage`.

- [ ] **Step 4: Run — passes. Commit.**

```bash
node --test bot/src/services/meetingPipelineStages.test.js
git add bot/src/services/meetingPipelineStages.js bot/src/services/meetingPipelineStages.test.js bot/.env.example
git commit -m "feat(meeting): awaiting_review stage posts the Discord review UI"
```

### Task 14: review interaction handlers

**Files:**
- Create: `bot/src/commands/meetingReview.js`
- Modify: `bot/src/handlers/interactions.js`

**Interfaces:**
- Consumes: `db.meetingPipelineJob`, `applyReviewAction`, `buildReviewMessage`.
- Produces:
  - `handleReviewComponent(interaction)` — routes `mtg_assignee|mtg_gh|mtg_taskreject|mtg_page` : parse `customId`, load job by `<jobId>`, `applyReviewAction` on `job.dataJson.review`, persist, `interaction.update(buildReviewMessage(...))`.
  - `handleApprove(interaction)` — `customId mtg_approve:<jobId>`: conditional flip `db.meetingPipelineJob.update(jobId, { stage:'approved', status:'pending' })` **only if** current `status === 'blocked'` (re-read first; if not blocked, `interaction.reply({ ephemeral, content:'Already processed.' })`); stash nothing else (state already in `dataJson.review`); `interaction.update` the message to a "Processing…" disabled state.
  - `handleReject(interaction)` — `customId mtg_reject:<jobId>`: set `dataJson.review.meetingRejected = true`, `stage:'approved', status:'pending'` (the `approved` stage checks the flag and calls `csaasClient.approve(decision:'rejected')`, then jumps to `done`).
  - slash commands `data` for `/meeting-review` (arg: meeting id or "latest") and `/meeting-retry` (arg: meeting id) + their `execute`.

- [ ] **Step 1: Failing test for the pure routing/parse**

Add `bot/src/commands/meetingReview.test.js`:
```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReviewCustomId } from './meetingReview.js'

test('parseReviewCustomId splits kind/job/task', () => {
  assert.deepEqual(parseReviewCustomId('mtg_assignee:job1:taskA'), { kind: 'mtg_assignee', jobId: 'job1', taskId: 'taskA' })
  assert.deepEqual(parseReviewCustomId('mtg_approve:job1'), { kind: 'mtg_approve', jobId: 'job1', taskId: undefined })
  assert.deepEqual(parseReviewCustomId('mtg_page:job1:2'), { kind: 'mtg_page', jobId: 'job1', taskId: '2' })
})
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement `meetingReview.js`** with `parseReviewCustomId` + the handlers + slash-command `data`/`execute`. For component handlers use `interaction.update(...)` (they arrive as component interactions, already ack-able). For `mtg_assignee` the selected value is `interaction.values[0]` (a user id) — map to `{ type:'assignee', taskId, ref: interaction.values[0] }`.

- [ ] **Step 4: Run — passes.**

- [ ] **Step 5: Wire routing in `interactions.js`**

- In the button branch: `if (customId.startsWith('mtg_')) return (await import('../commands/meetingReview.js')).route(interaction)`.
- In the string-select branch and a new user-select branch (`interaction.isUserSelectMenu?.()`): same `mtg_` prefix → `meetingReview.route`.
- `route(interaction)` internally dispatches on `parseReviewCustomId(...).kind`.

- [ ] **Step 6: Commit**

```bash
node --check bot/src/commands/meetingReview.js bot/src/handlers/interactions.js
node --test bot/src/commands/meetingReview.test.js
git add bot/src/commands/meetingReview.js bot/src/commands/meetingReview.test.js bot/src/handlers/interactions.js
git commit -m "feat(meeting): review UI interaction handlers + /meeting-review /meeting-retry"
```

### Task 15: `approved` + `mirrored` stages + task mapper

**Files:**
- Create: `bot/src/services/meetingTaskMap.js`
- Create: `bot/src/services/meetingTaskMap.test.js`
- Modify: `bot/src/services/meetingPipelineStages.js`
- Modify: `bot/src/services/meetingPipelineStages.test.js`

**Interfaces:**
- Produces:
  - `mapMeetingTaskToRow(csaasTask, reviewTask, { guildConfigId, meetingId, discordChannelId, botUserId, repositoryId }) -> object` (args for `db.task.create({ data })`). Pure.
  - `stageRunners.approved` — if `dataJson.review.meetingRejected`: `csaasClient.approve(decision:'rejected')` then `{ patch:{ stage:'done', status:'done' } , advance:false }`. Else `csaasClient.approve({ decision:'approved', skipGithub:true })` → advance to `mirrored`.
  - `stageRunners.mirrored` — for each non-rejected review task: resolve `repositoryId` from `db.repository.findFirst({ where:{ guildConfigId, name: csaasTask.project } })`; `db.task.create`; collect `{ taskId(dbId), csaasTaskId, assigneeRef, github }` into `dataJson.mirrored`; DM/ping grouped by assignee in the review channel. Advance to `issue_syncing`.

- [ ] **Step 1: Failing test for the mapper**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapMeetingTaskToRow } from './meetingTaskMap.js'

test('maps a csaas task + review row to a task.create payload', () => {
  const row = mapMeetingTaskToRow(
    { task_id: 'ct1', project: 'granjur', feature: 'Auth', sub_feature: 'Login',
      goal_of_task: 'Build login', intended_actions: ['a', 'b'], suggested_commands: ['npm t'],
      code_residence: 'src/auth.js' },
    { taskId: 'ct1', assigneeRef: '11', github: true, rejected: false },
    { guildConfigId: 'g', meetingId: 'M', discordChannelId: 'c', botUserId: 'bot', repositoryId: 'r1' },
  )
  assert.equal(row.guildConfigId, 'g')
  assert.equal(row.is_feature, true)
  assert.equal(row.title, 'Build login')
  assert.deepEqual(row.assigneeIds, ['11'])
  assert.equal(row.externalId, 'csaas:ct1')
  assert.equal(row.meetingId, 'M')
  assert.equal(row.repositoryId, 'r1')
  assert.match(row.description, /a\nb/)
})
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement `meetingTaskMap.js`**

```js
export function mapMeetingTaskToRow(csaasTask, reviewTask, ctx) {
  const actions = Array.isArray(csaasTask.intended_actions) ? csaasTask.intended_actions.join('\n') : ''
  const cmds = Array.isArray(csaasTask.suggested_commands) && csaasTask.suggested_commands.length
    ? `\n\nSuggested commands:\n${csaasTask.suggested_commands.join('\n')}` : ''
  const residence = csaasTask.code_residence ? `\n\nCode: ${csaasTask.code_residence}` : ''
  return {
    guildConfigId: ctx.guildConfigId,
    type: 'feature',
    is_feature: true,
    is_bug: false,
    title: String(csaasTask.goal_of_task || csaasTask.feature || 'Meeting task').slice(0, 200),
    description: `${actions}${cmds}${residence}`.trim().slice(0, 4000) || null,
    status: 'open',
    createdBy: ctx.botUserId || null,
    assigneeIds: reviewTask.assigneeRef ? [reviewTask.assigneeRef] : [],
    projectName: csaasTask.project || null,
    repositoryId: ctx.repositoryId || null,
    scope: csaasTask.feature || null,
    modules: csaasTask.sub_feature ? [csaasTask.sub_feature] : [],
    externalId: `csaas:${csaasTask.task_id}`,
    meetingId: ctx.meetingId,
    discordChannelId: ctx.discordChannelId || null,
  }
}
```

- [ ] **Step 4: Run — passes.**

- [ ] **Step 5: Implement `approved` + `mirrored` stages** in `meetingPipelineStages.js` per interfaces. For pings: group `dataJson.mirrored` by `assigneeRef`, one `channel.send` per assignee: `<@ref> assigned: **title1**, **title2** — /update-task for details`. Unassigned tasks: one summary line.

- [ ] **Step 6: Stage test** (mocked `db.task.create`, `csaasClient.approve`, channel).

- [ ] **Step 7: Commit**

```bash
node --check bot/src/services/meetingTaskMap.js bot/src/services/meetingPipelineStages.js
node --test bot/src/services/meetingTaskMap.test.js bot/src/services/meetingPipelineStages.test.js
git add bot/src/services/meetingTaskMap.js bot/src/services/meetingTaskMap.test.js bot/src/services/meetingPipelineStages.js bot/src/services/meetingPipelineStages.test.js
git commit -m "feat(meeting): approved + mirrored stages — create assigned bot tasks"
```

### Task 16: `issue_syncing` + `done` stages

**Files:**
- Modify: `bot/src/services/meetingPipelineStages.js`
- Modify: `bot/src/services/meetingPipelineStages.test.js`

**Interfaces:**
- Produces:
  - `resolveRepoSlug(repositoryRow) -> { owner, repo } | null` (parse `github.com[:/ ]owner/repo`). Pure, exported.
  - `stageRunners.issue_syncing` — group mirrored tasks with `github === true` by resolved `owner/repo`; for each group `csaasClient.issueSync(csaasMeetingId, { owner, repo, taskIds: [csaasTaskId…] })`; for returned issues, `db.task.update` (add a `taskUpdate` where-by-`externalId` path or update by db id) setting `externalIssueUrl` / `externalIssueNumber`; record failures in `dataJson.issueSyncErrors`. Advance to `done`.
  - `stageRunners.done` — edit the review message (`client.channels.fetch` → `messages.fetch(reviewMessageId)` → `.edit`) to a final summary embed (`summarizeApproval` + issue links + any errors). `advance:false`, `status:'done'`.

- [ ] **Step 1: Failing test for `resolveRepoSlug`**

```js
import { resolveRepoSlug } from './meetingPipelineStages.js'
test('resolveRepoSlug parses ssh + https', () => {
  assert.deepEqual(resolveRepoSlug({ url: 'git@github.com:granjur/bot.git' }), { owner: 'granjur', repo: 'bot' })
  assert.deepEqual(resolveRepoSlug({ url: 'https://github.com/granjur/bot' }), { owner: 'granjur', repo: 'bot' })
  assert.equal(resolveRepoSlug({ url: '' }), null)
})
```

- [ ] **Step 2–4: fail → implement → pass.**

- [ ] **Step 5: Add `taskUpdate` externalId branch** if needed in `bot/src/Database/index.js` (`taskUpdate({ where: { id | externalId }, data: { externalIssueUrl, externalIssueNumber } })`).

- [ ] **Step 6: Commit**

```bash
node --test bot/src/services/meetingPipelineStages.test.js
git add bot/src/services/meetingPipelineStages.js bot/src/services/meetingPipelineStages.test.js bot/src/Database/index.js
git commit -m "feat(meeting): issue_syncing + done stages"
```

### Task 17: failure notification + docs + env + manual E2E checklist

**Files:**
- Modify: `bot/src/services/meetingPipelineWorker.js` (`notifyFailure` real impl)
- Create: `docs/superpowers/plans/meeting-pipeline-e2e-checklist.md`
- Modify: `bot/.env.example`, bot README, `.claude/knowledge/csaas-meeting-workflow-integration.md`, `.claude/state/*`

**Interfaces:**
- Produces: `notifyFailure(client, job, err)` — resolve the meeting's text channel (same logic as `awaiting_review`), send "⚠️ Meeting pipeline failed at **<stage>** — `<error>`. Retry with `/meeting-retry <meetingId>`." Swallows its own errors.

- [ ] **Step 1: Implement `notifyFailure`** (extract the channel-resolution helper used by `awaiting_review` into a shared `resolveMeetingChannel(client, db, job)` in `meetingPipelineStages.js`, import it here).

- [ ] **Step 2: `/meeting-retry`** (from Task 14) sets `status='pending', nextAttemptAt=null, attempts=0, lastError=null` for a `failed` job and replies ephemerally.

- [ ] **Step 3: Write the E2E checklist doc** — the steps from spec §6, plus: set `MEETING_PIPELINE_ENABLED=true`, `CSAAS_*`, `STT_PROVIDER=soniox` on CSAAS; run both migrations; record a 2-person voice test; watch `meeting_pipeline_job.stage`; verify review UI; approve; check `task` rows + pings; toggle one GitHub and verify a `[Agent Call]` issue.

- [ ] **Step 4: Update env docs** — full block in `bot/.env.example`:
```
MEETING_PIPELINE_ENABLED=true
MEETING_REPORTS_DIR=bot/meeting-reports
CSAAS_API_URL=http://127.0.0.1:3000/api
CSAAS_ACTOR_URDD=
UBS_DOC_PATH=../UBS_Doc/docs
```

- [ ] **Step 5: Update the knowledge + state files** — mark the design as implemented in `.claude/state/completed.md` (dated `2026-09-01`), clear the backlog item, note in the knowledge doc that the endpoints/agent now exist.

- [ ] **Step 6: Full test run + commit**

```bash
npm test            # node --test across the bot
node --check bot/src/index.js
git add -A
git commit -m "feat(meeting): failure alerts, docs, E2E checklist; wrap up integration"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task(s) |
|---|---|
| §4.1 transport (plaintext + `actionPerformerURDD`) | Task 5 |
| §4.2.1 Soniox toggle | Task 17 Step 4 (config) + spec note; no code |
| §4.2.2 `skip_github` | Task 2 |
| §4.2.3 `/assign` + `extractAssignments` | Task 3 |
| §4.2.4 CSAAS migration | Task 3 Step 1 |
| §4.2.5 `/issuesync` filter | Task 4 |
| §4.3 `csaasClient` | Task 5 |
| §4.4.1 `meeting_pipeline_job` | Task 6 |
| §4.4.2 enqueue | Task 9 Step 7 |
| §4.4.3 worker loop / backoff | Task 8 |
| §4.4.4 stage table | Tasks 9–16 |
| §4.5 roster | Task 9 |
| §4.6 review UI | Tasks 12 (builders), 13 (post), 14 (handlers) |
| §4.7 task mirroring + bot migration | Tasks 7, 15 |
| §4.8 ubs_doc / `/docs` | Task 1 |
| §7 error handling matrix | Tasks 8, 10, 13, 15, 16, 17 |
| §8 configuration | Tasks 1, 5, 13, 17 |
| §9 testing | every task's test steps + Task 17 checklist |

No gaps.

**2. Placeholder scan** — done; the `notifyFailure` stub in Task 8 is explicitly filled in Task 17; `guildIdFor` inline dynamic import in Task 9 is flagged for cleanup with the concrete replacement named (`getGuildConfigById`, already exported).

**3. Type consistency** — `stageRunners` entry contract `{ patch?, advance?, block? }` is consistent across Tasks 8–16. `runTick` reads `out.advance !== false` and `out.block`. `dataJson` keys (`roster`, `uploaded`, `missing`, `analysis`, `tasks`, `assignments`, `review`, `notes`, `mirrored`, `issueSyncErrors`, `meetingRejected`) are introduced once and reused. Review `customId`s match the Global Constraints list. `mapMeetingTaskToRow` output keys match `taskCreate`'s accepted `data` keys (incl. the new `externalId`/`meetingId` from Task 7).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-01-meeting-to-tasks-integration.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

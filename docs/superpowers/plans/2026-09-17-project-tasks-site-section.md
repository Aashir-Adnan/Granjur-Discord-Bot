# Project Tasks on the UBS-Doc Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the Discord bot's tasks on the UBS-Doc site grouped by project, with project members, several assignees per task, and blocking dependencies; add the bot commands that create that data.

**Architecture:** The bot owns the data (three schema additions, a name sync, new command options). CSAAS gains one read-only endpoint that reads the bot's `granjur` tables directly over the shared MySQL server and returns a fully assembled per-project structure. The UBS-Doc site gains one screen that fetches that endpoint and filters client-side.

**Tech Stack:** Bot: Node 24 ESM, discord.js v14, mysql2, `node:test`. CSAAS: CommonJS, framework `global.X_object` API definitions, plain-assert test scripts. Site: Vite + React 19 + TypeScript + Tailwind, vitest.

**Spec:** `docs/superpowers/specs/2026-09-17-project-tasks-site-section-design.md`

## Global Constraints

- Three repos, three working directories. Bot: `D:\Work\Granjur Technologies\Granjur-Discord-Bot` (branch `feat/project-tasks-site` off `main`). CSAAS: `D:\Work\Granjur Technologies\CSAAS_Backend` (branch `feat/discord-tasks-endpoint` off `origin/main`; run `git fetch` first, `main` has been stale before). Site: `D:\Work\Granjur Technologies\UBS-Doc` (branch `feat/tasks-screen` off `origin/main`).
- **Never `git add -A` or `git add .` in CSAAS or UBS-Doc.** Both working trees carry unrelated uncommitted changes. Stage named files only.
- **Never run `prettier`** in any of the three repos.
- **The bot's root `.env` holds the production `DATABASE_URL`.** No test may reach the default `db` export. Every function that touches the database and is under test takes a `db` seam (`{ db: dbArg = db } = {}`), and tests pass a fake.
- Bot tests: `npm test` from the bot repo root runs `node --test` (bare; the directory form fails on Windows). A single file: `node --test bot/src/utils/taskDeps.test.js`.
- Bot SQL: table names lowercase; `LIMIT` inlined as a clamped integer, never a bound `?`; every insert builds column list and params from **one** ordered array; new tables pin `COLLATE=utf8mb4_general_ci` or foreign keys to `task`/`project` fail.
- Bot commands: never call `setDefaultMemberPermissions`; roles live in `bot/src/config/command-config.json` (`commandGates.test.js` enforces this). Every slash command is deferred ephemerally before `execute` runs, so `execute` uses `interaction.editReply`.
- Terminal statuses are exactly `closed`, `done`, `resolved` (`TERMINAL_STATUSES` in `bot/src/services/taskUpdateNotify.js`).
- Blocked state is computed, never stored.
- CSAAS route rule: `GET /api/discord/tasks` resolves to `global.DiscordTasks_object`. Endpoint config: `encryption: false`, `otp: false`, `accessToken: false`, `permission: null`, `requestMethod: "GET"`.
- CSAAS reads bot tables with fully qualified names: `granjur.guildconfig`, `granjur.project`, `granjur.task`, `granjur.taskdependency`, `granjur.projectmember`, `granjur.guildmember`.
- Site: no new dependencies. Use `c, card, txt, muted, Breadcrumb, chipRed, chipGray, chipIndigo, chipMint, chipAmber` from `src/lib`, `useTheme` from `src/app/ThemeContext`, `AuroraText`, `SearchInput`, icons from `lucide-react`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File map

**Bot**
- Create `bot/src/Database/migrations/017_task_dependencies_project_members.sql` — the two tables and two columns.
- Modify `bot/src/Database/index.js` — `taskDependency.*`, `projectMember.*`, `task.findByIds`, name columns on `guildMember.update`/`upsert`; exported SQL builders.
- Create `bot/src/Database/taskDependency.test.js` — builders line up.
- Create `bot/src/utils/taskDeps.js` + `.test.js` — pure dependency rules and message text.
- Create `bot/src/services/memberNameSync.js` + `.test.js` — names into `guildmember`.
- Modify `bot/src/index.js` — start the sync, handle `GuildMemberUpdate`, drop a stale no-defer entry.
- Modify `bot/src/commands/create-task.js` — assignee user select on the confirm step.
- Modify `bot/src/handlers/interactions.js` — route `create_task_assignees` as a user select; route nothing new otherwise.
- Modify `bot/src/commands/update-task.js` + `.test.js` — four options, dependency writes, warning.
- Modify `bot/src/services/taskUpdateNotify.js` + `.test.js` — blocker warning and unblock notices.
- Create `bot/src/commands/project-members.js` + `.test.js`; register in `commands/index.js` and `command-config.json`.
- Modify `bot/src/Database/schema.sql` — mirror the migration (the backlog notes this file drifted before).

**CSAAS**
- Create `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js` — endpoint + `assembleTasks`.
- Create `Services/SysScripts/TestScripts/discord-tasks-test/assemble.test.js`.

**Site**
- Create `src/components/discordTasks/api.ts`, `src/screens/tasksLogic.ts` + `.test.ts`, `src/screens/Tasks.tsx`.
- Modify `src/app/routes.tsx`, `src/screens/ToolsHub.tsx`, `src/components/Sidebar.tsx`, `src/screens/Projects.tsx`.

**Docs**
- Create `.claude/knowledge/project-tasks-site.md`; update `.claude/knowledge/README.md`, `.claude/state/*`.

---

### Task 1: Schema and database surface

**Files:**
- Create: `bot/src/Database/migrations/017_task_dependencies_project_members.sql`
- Modify: `bot/src/Database/index.js` (guildmember helpers near lines 134–196; task helpers near line 231; add new sections after `project_repos` around line 1035; export object near lines 1996–2100)
- Modify: `bot/src/Database/schema.sql` (append the two tables; add two columns to `guildmember`)
- Test: `bot/src/Database/taskDependency.test.js`

**Interfaces:**
- Produces: `db.taskDependency.add({ data: { guildConfigId, taskId, blockedByTaskId, createdBy } })` → row; `db.taskDependency.remove({ where: { taskId, blockedByTaskId } })` → `{ removed: number }`; `db.taskDependency.findByTask({ where: { taskId } })` → rows; `db.taskDependency.findByBlocker({ where: { blockedByTaskId } })` → rows; `db.taskDependency.findManyForGuild({ where: { guildConfigId } })` → rows. `db.projectMember.add({ data: { guildConfigId, projectId, discordId, role, addedBy } })` → row; `db.projectMember.remove({ where: { projectId, discordId } })` → `{ removed }`; `db.projectMember.findByProject({ where: { projectId } })` → rows. `db.task.findByIds({ where: { guildConfigId, ids } })` → rows. `db.guildMember.update` accepts `displayName`, `username`; `db.guildMember.upsert` writes them from `create`/`update`. Exported builders `taskDependencyInsertSql(data)`, `projectMemberUpsertSql(data)`, `guildMemberUpdateSets(data)`.

- [ ] **Step 1: Write the failing builder tests**

`bot/src/Database/taskDependency.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  taskDependencyInsertSql,
  projectMemberUpsertSql,
  guildMemberUpdateSets,
} from './index.js'

// Column list and params must come from ONE array. The utterance table's
// insert once had two independent lists that drifted; these tests exist so
// that cannot happen again here.

test('taskdependency insert: placeholders equal params, and params follow column order', () => {
  const { sql, params } = taskDependencyInsertSql({
    id: 'dep1', guildConfigId: 'g1', taskId: 'tA', blockedByTaskId: 'tB', createdBy: 'u1',
  })
  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim())
  assert.equal((sql.match(/\?/g) || []).length, params.length)
  assert.deepEqual(cols, ['id', 'guildConfigId', 'taskId', 'blockedByTaskId', 'createdBy'])
  assert.deepEqual(params, ['dep1', 'g1', 'tA', 'tB', 'u1'])
  assert.match(sql, /INSERT IGNORE INTO `taskdependency`/)
})

test('projectmember upsert: re-adding updates the role and nothing else', () => {
  const { sql, params } = projectMemberUpsertSql({
    id: 'pm1', guildConfigId: 'g1', projectId: 'p1', discordId: 'u1', role: 'lead', addedBy: 'u9',
  })
  const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(',').map((s) => s.trim())
  assert.deepEqual(cols, ['id', 'guildConfigId', 'projectId', 'discordId', 'role', 'addedBy'])
  assert.deepEqual(params, ['pm1', 'g1', 'p1', 'u1', 'lead', 'u9'])
  assert.match(sql, /ON DUPLICATE KEY UPDATE role = VALUES\(role\), addedBy = VALUES\(addedBy\)$/)
})

test('projectmember upsert: role defaults to developer and createdBy may be null', () => {
  const { params } = projectMemberUpsertSql({ id: 'x', guildConfigId: 'g', projectId: 'p', discordId: 'u' })
  assert.equal(params[4], 'developer')
  assert.equal(params[5], null)
})

test('guildmember update sets: name columns are written only when given', () => {
  assert.deepEqual(guildMemberUpdateSets({ displayName: 'Nauraiz', username: 'nauraiz_101104' }), {
    sets: ['displayName = ?', 'username = ?'],
    vals: ['Nauraiz', 'nauraiz_101104'],
  })
  assert.deepEqual(guildMemberUpdateSets({ status: 'holding' }), { sets: ['status = ?'], vals: ['holding'] })
  assert.deepEqual(guildMemberUpdateSets({}), { sets: [], vals: [] })
})
```

- [ ] **Step 2: Run it, expect import failures**

Run: `node --test bot/src/Database/taskDependency.test.js`
Expected: FAIL, `taskDependencyInsertSql` is not exported.

- [ ] **Step 3: Write the migration**

`bot/src/Database/migrations/017_task_dependencies_project_members.sql`:

```sql
-- Task dependencies ("A is blocked by B"), explicit project membership, and
-- Discord names on guildmember so the UBS-Doc site can show people, not ids.
-- Blocked state is never stored: a task is blocked while any blocker's status
-- is outside closed / done / resolved.

CREATE TABLE IF NOT EXISTS `taskdependency` (
  `id`              VARCHAR(36) NOT NULL,
  `guildConfigId`   VARCHAR(36) NOT NULL,
  `taskId`          VARCHAR(36) NOT NULL,
  `blockedByTaskId` VARCHAR(36) NOT NULL,
  `createdBy`       VARCHAR(64) DEFAULT NULL,
  `createdAt`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_taskdependency_pair` (`taskId`, `blockedByTaskId`),
  KEY `idx_taskdependency_guild` (`guildConfigId`),
  KEY `idx_taskdependency_blocker` (`blockedByTaskId`),
  CONSTRAINT `fk_taskdependency_guild` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_taskdependency_task` FOREIGN KEY (`taskId`) REFERENCES `task`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_taskdependency_blocker` FOREIGN KEY (`blockedByTaskId`) REFERENCES `task`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `projectmember` (
  `id`            VARCHAR(36) NOT NULL,
  `guildConfigId` VARCHAR(36) NOT NULL,
  `projectId`     VARCHAR(36) NOT NULL,
  `discordId`     VARCHAR(64) NOT NULL,
  `role`          VARCHAR(32) NOT NULL DEFAULT 'developer',
  `addedBy`       VARCHAR(64) DEFAULT NULL,
  `createdAt`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_projectmember_pair` (`projectId`, `discordId`),
  KEY `idx_projectmember_guild` (`guildConfigId`),
  CONSTRAINT `fk_projectmember_guild` FOREIGN KEY (`guildConfigId`) REFERENCES `guildconfig`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_projectmember_project` FOREIGN KEY (`projectId`) REFERENCES `project`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildmember' AND COLUMN_NAME = 'displayName');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `guildmember` ADD COLUMN displayName VARCHAR(100) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildmember' AND COLUMN_NAME = 'username');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `guildmember` ADD COLUMN username VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

Mirror the same two `CREATE TABLE` blocks at the end of `bot/src/Database/schema.sql` and add `displayName VARCHAR(100)` and `username VARCHAR(64)` after `email` in its `guildmember` definition.

- [ ] **Step 4: Database helpers**

In `bot/src/Database/index.js`, replace the body of `guildMemberUpdate` so it uses an exported builder, and extend `guildMemberUpsert`:

```js
export function guildMemberUpdateSets(data = {}) {
  const sets = [];
  const vals = [];
  if (data.status !== undefined) { sets.push("status = ?"); vals.push(data.status); }
  if (data.roleIds !== undefined) { sets.push("roleIds = ?"); vals.push(toJson(data.roleIds)); }
  if (data.email !== undefined) { sets.push("email = ?"); vals.push(data.email); }
  if (data.displayName !== undefined) { sets.push("displayName = ?"); vals.push(data.displayName); }
  if (data.username !== undefined) { sets.push("username = ?"); vals.push(data.username); }
  return { sets, vals };
}

async function guildMemberUpdate({ where, data }) {
  const idVal = where.id;
  const { sets, vals } = guildMemberUpdateSets(data);
  if (sets.length === 0) return guildMemberFindUnique({ where: { id: idVal } });
  vals.push(idVal);
  await query(`UPDATE \`guildmember\` SET ${sets.join(", ")} WHERE id = ?`, vals);
  return guildMemberFindUnique({ where: { id: idVal } });
}
```

In `guildMemberUpsert`, the existing-row branch becomes:

```js
  if (existing) {
    const { sets, vals } = guildMemberUpdateSets({
      email: update.email ?? existing.email,
      status: update.status ?? existing.status,
      displayName: update.displayName,
      username: update.username,
    });
    sets.push("verifiedAt = ?", "updatedAt = CURRENT_TIMESTAMP(3)");
    vals.push(update.verifiedAt ?? existing.verifiedAt);
    vals.push(existing.id);
    await query(`UPDATE \`guildmember\` SET ${sets.join(", ")} WHERE id = ?`, vals);
    return guildMemberFindUnique({ where });
  }
```

and the insert adds the two columns: `INSERT INTO \`guildmember\` (id, guildConfigId, discordId, email, verifiedAt, status, roleIds, displayName, username) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` with `create.displayName ?? null, create.username ?? null` appended to the params.

Add after `taskFindFirst`:

```js
async function taskFindByIds({ where }) {
  const ids = (where?.ids || []).filter(Boolean).map(String);
  if (!where?.guildConfigId || ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return query(
    `SELECT * FROM \`task\` WHERE guildConfigId = ? AND id IN (${placeholders})`,
    [where.guildConfigId, ...ids],
  );
}
```

Add a new section after the `project_repos` helpers:

```js
// ---------- taskdependency ("taskId is blocked by blockedByTaskId") ----------
export function taskDependencyInsertSql(data) {
  const columns = [
    ["id", data.id],
    ["guildConfigId", data.guildConfigId],
    ["taskId", data.taskId],
    ["blockedByTaskId", data.blockedByTaskId],
    ["createdBy", data.createdBy ?? null],
  ];
  return {
    // IGNORE: the unique pair makes a repeat add a no-op rather than an error.
    sql: `INSERT IGNORE INTO \`taskdependency\` (${columns.map(([c]) => c).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    params: columns.map(([, v]) => v),
  };
}
async function taskDependencyAdd({ data }) {
  const { sql, params } = taskDependencyInsertSql({ ...data, id: id() });
  await query(sql, params);
  return queryOne("SELECT * FROM `taskdependency` WHERE taskId = ? AND blockedByTaskId = ?", [data.taskId, data.blockedByTaskId]);
}
async function taskDependencyRemove({ where }) {
  const res = await query("DELETE FROM `taskdependency` WHERE taskId = ? AND blockedByTaskId = ?", [where.taskId, where.blockedByTaskId]);
  return { removed: Number(res?.affectedRows ?? 0) };
}
async function taskDependencyFindByTask({ where }) {
  return query("SELECT * FROM `taskdependency` WHERE taskId = ? ORDER BY createdAt ASC LIMIT 200", [where.taskId]);
}
async function taskDependencyFindByBlocker({ where }) {
  return query("SELECT * FROM `taskdependency` WHERE blockedByTaskId = ? ORDER BY createdAt ASC LIMIT 200", [where.blockedByTaskId]);
}
async function taskDependencyFindManyForGuild({ where }) {
  return query("SELECT * FROM `taskdependency` WHERE guildConfigId = ? LIMIT 5000", [where.guildConfigId]);
}

// ---------- projectmember (explicit project membership) ----------
export const PROJECT_MEMBER_ROLES = ["lead", "developer", "qa", "design"];
export function projectMemberUpsertSql(data) {
  const columns = [
    ["id", data.id],
    ["guildConfigId", data.guildConfigId],
    ["projectId", data.projectId],
    ["discordId", data.discordId],
    ["role", data.role ?? "developer"],
    ["addedBy", data.addedBy ?? null],
  ];
  return {
    sql:
      `INSERT INTO \`projectmember\` (${columns.map(([c]) => c).join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ` +
      "ON DUPLICATE KEY UPDATE role = VALUES(role), addedBy = VALUES(addedBy)",
    params: columns.map(([, v]) => v),
  };
}
async function projectMemberAdd({ data }) {
  const { sql, params } = projectMemberUpsertSql({ ...data, id: id() });
  await query(sql, params);
  return queryOne("SELECT * FROM `projectmember` WHERE projectId = ? AND discordId = ?", [data.projectId, data.discordId]);
}
async function projectMemberRemove({ where }) {
  const res = await query("DELETE FROM `projectmember` WHERE projectId = ? AND discordId = ?", [where.projectId, where.discordId]);
  return { removed: Number(res?.affectedRows ?? 0) };
}
async function projectMemberFindByProject({ where }) {
  return query("SELECT * FROM `projectmember` WHERE projectId = ? ORDER BY role ASC, createdAt ASC LIMIT 200", [where.projectId]);
}
```

Check what `query` returns for a DELETE in `bot/src/Database/connection.js` (it may return `result` or `[rows]`); adjust `affectedRows` access so `removed` is a number. Register in the `db` object: `task.findByIds: taskFindByIds`, and new namespaces `taskDependency: { add, remove, findByTask, findByBlocker, findManyForGuild }` and `projectMember: { add, remove, findByProject }`.

- [ ] **Step 5: Run the tests**

Run: `node --test bot/src/Database/taskDependency.test.js` then `npm test`
Expected: all PASS; suite count rises by 4.

- [ ] **Step 6: Commit**

```bash
git add bot/src/Database/migrations/017_task_dependencies_project_members.sql bot/src/Database/index.js bot/src/Database/schema.sql bot/src/Database/taskDependency.test.js
git commit -m "feat(db): taskdependency and projectmember tables, member display names"
```

---

### Task 2: Dependency rules and message text

**Files:**
- Create: `bot/src/utils/taskDeps.js`
- Test: `bot/src/utils/taskDeps.test.js`

**Interfaces:**
- Consumes: `TERMINAL_STATUSES` from `bot/src/services/taskUpdateNotify.js`.
- Produces: `isTerminal(status)`, `openBlockers(taskId, depRows, tasksById)` → task rows, `wouldCycle(taskId, blockerId, depRows)` → boolean, `blockerWarning(openBlockerTasks)` → string, `unblockNotice(blockerTask, remainingOpenCount)` → string, `STATUS_LABEL`.

- [ ] **Step 1: Failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openBlockers, wouldCycle, blockerWarning, unblockNotice, isTerminal } from './taskDeps.js'

const tasks = {
  A: { id: 'A', title: 'Git Sync', status: 'open' },
  B: { id: 'B', title: 'Router fix', status: 'in_progress' },
  C: { id: 'C', title: 'Error handling', status: 'done' },
  D: { id: 'D', title: 'Components', status: 'open' },
}
const dep = (taskId, blockedByTaskId) => ({ taskId, blockedByTaskId })

test('isTerminal recognises exactly closed, done, resolved', () => {
  for (const s of ['closed', 'done', 'resolved']) assert.equal(isTerminal(s), true)
  for (const s of ['open', 'pending', 'in_progress', '', null, undefined]) assert.equal(isTerminal(s), false)
})

test('openBlockers lists blockers whose status is not terminal, in dependency order', () => {
  const deps = [dep('A', 'C'), dep('A', 'B'), dep('A', 'D')]
  assert.deepEqual(openBlockers('A', deps, tasks).map((t) => t.id), ['B', 'D'])
})

test('openBlockers ignores rows for other tasks and blockers that no longer exist', () => {
  const deps = [dep('D', 'B'), dep('A', 'ZZZ')]
  assert.deepEqual(openBlockers('A', deps, tasks), [])
})

test('wouldCycle: a task cannot block itself', () => {
  assert.equal(wouldCycle('A', 'A', []), true)
})

test('wouldCycle: direct reverse edge is a cycle', () => {
  // B is blocked by A already; making A blocked by B closes the loop.
  assert.equal(wouldCycle('A', 'B', [dep('B', 'A')]), true)
})

test('wouldCycle: two-hop cycle is caught', () => {
  // C blocked by B, B blocked by A; A blocked by C would loop.
  assert.equal(wouldCycle('A', 'C', [dep('C', 'B'), dep('B', 'A')]), true)
})

test('wouldCycle: an unrelated chain is fine', () => {
  assert.equal(wouldCycle('A', 'B', [dep('C', 'D')]), false)
})

test('blockerWarning names each open blocker with its status, empty when none', () => {
  assert.equal(blockerWarning([]), '')
  assert.equal(
    blockerWarning([tasks.B, tasks.D]),
    '⛔ Still blocked by: **Router fix** (in progress), **Components** (open)',
  )
})

test('unblockNotice says how many remain, or that the task is free', () => {
  assert.equal(unblockNotice(tasks.C, 2), '✅ Blocker **Error handling** is done. 2 blockers still open.')
  assert.equal(unblockNotice(tasks.C, 1), '✅ Blocker **Error handling** is done. 1 blocker still open.')
  assert.equal(unblockNotice(tasks.C, 0), '✅ Blocker **Error handling** is done. This task is no longer blocked.')
})
```

- [ ] **Step 2: Run, expect module-not-found**

Run: `node --test bot/src/utils/taskDeps.test.js`

- [ ] **Step 3: Implement**

```js
// Dependency rules for tasks. Pure: no Discord, no database.
//
// "A is blocked by B" is a row { taskId: 'A', blockedByTaskId: 'B' }. Blocked
// state is never stored — it is whether any blocker is still open right now.

import { TERMINAL_STATUSES } from '../services/taskUpdateNotify.js'

export const STATUS_LABEL = {
  open: 'open',
  pending: 'pending',
  in_progress: 'in progress',
  resolved: 'resolved',
  closed: 'closed',
  done: 'done',
}

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(String(status ?? ''))
}

/** Blocker tasks of `taskId` that are still open, in the order the rows were given. */
export function openBlockers(taskId, depRows = [], tasksById = {}) {
  const out = []
  for (const row of depRows) {
    if (String(row.taskId) !== String(taskId)) continue
    const blocker = tasksById[row.blockedByTaskId]
    if (!blocker) continue
    if (!isTerminal(blocker.status)) out.push(blocker)
  }
  return out
}

/**
 * Would recording "taskId is blocked by blockerId" create a cycle?
 * True when blockerId is taskId, or when following blocker edges from
 * blockerId reaches taskId. Depth-first; the graph is tiny.
 */
export function wouldCycle(taskId, blockerId, depRows = []) {
  const t = String(taskId)
  const b = String(blockerId)
  if (t === b) return true
  const edges = new Map()
  for (const row of depRows) {
    const from = String(row.taskId)
    if (!edges.has(from)) edges.set(from, [])
    edges.get(from).push(String(row.blockedByTaskId))
  }
  const seen = new Set()
  const stack = [b]
  while (stack.length) {
    const cur = stack.pop()
    if (cur === t) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const next of edges.get(cur) || []) stack.push(next)
  }
  return false
}

const labelOf = (status) => STATUS_LABEL[String(status)] ?? String(status ?? 'open')

export function blockerWarning(openBlockerTasks = []) {
  if (!openBlockerTasks.length) return ''
  const parts = openBlockerTasks.map((t) => `**${t.title || t.id}** (${labelOf(t.status)})`)
  return `⛔ Still blocked by: ${parts.join(', ')}`
}

export function unblockNotice(blockerTask, remainingOpen = 0) {
  const head = `✅ Blocker **${blockerTask?.title || blockerTask?.id}** is done.`
  if (remainingOpen <= 0) return `${head} This task is no longer blocked.`
  return `${head} ${remainingOpen} blocker${remainingOpen === 1 ? '' : 's'} still open.`
}
```

`taskUpdateNotify.js` imports `taskLabel.js` and `taskTicketChannel.js` only, so importing `TERMINAL_STATUSES` from it creates no cycle. Confirm with `node -e "import('./bot/src/utils/taskDeps.js')"`.

- [ ] **Step 4: Run tests, expect PASS**

Run: `node --test bot/src/utils/taskDeps.test.js`

- [ ] **Step 5: Commit**

```bash
git add bot/src/utils/taskDeps.js bot/src/utils/taskDeps.test.js
git commit -m "feat(tasks): pure dependency rules — open blockers, cycle check, warning text"
```

---

### Task 3: Member name sync

**Files:**
- Create: `bot/src/services/memberNameSync.js`
- Test: `bot/src/services/memberNameSync.test.js`
- Modify: `bot/src/index.js` (imports at top; `ClientReady` handler lines 46–55; event wiring lines 296–298)

**Interfaces:**
- Consumes: `db.guildMember.findMany({ where: { guildConfigId } })` (exists), `db.guildMember.update`, `db.guildMember.upsert` (Task 1 shapes).
- Produces: `toNameUpdates(discordMembers, dbRows)` → `{ updates: [{ id, displayName, username }], inserts: [{ discordId, displayName, username }] }`; `syncGuildMemberNames(guild, { db })`; `syncOneMember(member, { db })`; `startMemberNameSync(client, { db, intervalMs })`.

- [ ] **Step 1: Failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toNameUpdates, syncGuildMemberNames } from './memberNameSync.js'

const m = (id, displayName, username, bot = false) => ({ id, displayName, user: { username, bot } })

test('toNameUpdates: changed names update, unchanged are skipped, unknown members insert, bots ignored', () => {
  const discord = [m('1', 'Nauraiz', 'nauraiz_101104'), m('2', 'Afaq Khawar', 'afaqkhawar9299'), m('3', 'New Person', 'newp'), m('9', 'Helper', 'helper', true)]
  const rows = [
    { id: 'r1', discordId: '1', displayName: 'Nauraiz', username: 'nauraiz_101104' },
    { id: 'r2', discordId: '2', displayName: 'Afaq', username: null },
  ]
  const out = toNameUpdates(discord, rows)
  assert.deepEqual(out.updates, [{ id: 'r2', displayName: 'Afaq Khawar', username: 'afaqkhawar9299' }])
  assert.deepEqual(out.inserts, [{ discordId: '3', displayName: 'New Person', username: 'newp' }])
})

test('toNameUpdates: names are clipped to the column widths', () => {
  const out = toNameUpdates([m('1', 'x'.repeat(150), 'y'.repeat(80))], [])
  assert.equal(out.inserts[0].displayName.length, 100)
  assert.equal(out.inserts[0].username.length, 64)
})

test('syncGuildMemberNames writes updates and pending inserts through the seam', async () => {
  const calls = []
  const db = {
    guildMember: {
      findMany: async () => [{ id: 'r1', discordId: '1', displayName: 'Old', username: 'nauraiz_101104' }],
      update: async (a) => { calls.push(['update', a]) },
      upsert: async (a) => { calls.push(['upsert', a]) },
    },
  }
  const guild = {
    id: 'guild1',
    members: { fetch: async () => new Map([['1', m('1', 'Nauraiz', 'nauraiz_101104')], ['2', m('2', 'Hassan Abid', 'hasxanabid')]]) },
  }
  const cfg = { id: 'g1', guildId: 'guild1' }
  const n = await syncGuildMemberNames(guild, { db, cfg })
  assert.equal(n, 2)
  assert.deepEqual(calls[0], ['update', { where: { id: 'r1' }, data: { displayName: 'Nauraiz', username: 'nauraiz_101104' } }])
  assert.equal(calls[1][0], 'upsert')
  assert.equal(calls[1][1].create.status, 'pending')
  assert.equal(calls[1][1].create.displayName, 'Hassan Abid')
})
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test bot/src/services/memberNameSync.test.js`

- [ ] **Step 3: Implement**

```js
// Keeps guildmember.displayName / username in step with Discord so anything
// that cannot ask Discord (the UBS-Doc site) can show people instead of ids.
//
// Runs at startup, every six hours, and on GuildMemberUpdate for one member.
// A member with no row gets one with status 'pending' — the same state
// memberAdd.js gives every joiner, so nothing new is invented.

import db, { getOrCreateGuildConfig } from '../db/index.js'

export const NAME_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000
const clip = (s, n) => (s == null ? null : String(s).slice(0, n))

/** Pure diff between Discord's members and the stored rows. */
export function toNameUpdates(discordMembers = [], dbRows = []) {
  const byDiscordId = new Map(dbRows.map((r) => [String(r.discordId), r]))
  const updates = []
  const inserts = []
  for (const member of discordMembers) {
    if (member?.user?.bot) continue
    const displayName = clip(member.displayName ?? member.user?.username, 100)
    const username = clip(member.user?.username, 64)
    const row = byDiscordId.get(String(member.id))
    if (!row) {
      inserts.push({ discordId: String(member.id), displayName, username })
      continue
    }
    if (row.displayName !== displayName || row.username !== username) {
      updates.push({ id: row.id, displayName, username })
    }
  }
  return { updates, inserts }
}

/** Sync every non-bot member of one guild. Returns the number of rows written. */
export async function syncGuildMemberNames(guild, { db: dbArg = db, cfg = null } = {}) {
  const config = cfg ?? (await getOrCreateGuildConfig(guild.id))
  const collection = await guild.members.fetch()
  const discordMembers = Array.from(collection.values())
  const rows = await dbArg.guildMember.findMany({ where: { guildConfigId: config.id } })
  const { updates, inserts } = toNameUpdates(discordMembers, rows)
  for (const u of updates) {
    await dbArg.guildMember.update({ where: { id: u.id }, data: { displayName: u.displayName, username: u.username } })
  }
  for (const i of inserts) {
    await dbArg.guildMember.upsert({
      where: { guildId_discordId: { guildId: guild.id, discordId: i.discordId } },
      create: { guildId: guild.id, discordId: i.discordId, status: 'pending', displayName: i.displayName, username: i.username },
      update: { displayName: i.displayName, username: i.username },
    })
  }
  return updates.length + inserts.length
}

/** GuildMemberUpdate handler: one member, one row. */
export async function syncOneMember(member, { db: dbArg = db } = {}) {
  try {
    if (!member?.guild || member.user?.bot) return
    const cfg = await getOrCreateGuildConfig(member.guild.id)
    const rows = await dbArg.guildMember.findMany({ where: { guildConfigId: cfg.id } })
    const mine = rows.filter((r) => String(r.discordId) === String(member.id))
    const { updates, inserts } = toNameUpdates([member], mine)
    for (const u of updates) await dbArg.guildMember.update({ where: { id: u.id }, data: { displayName: u.displayName, username: u.username } })
    for (const i of inserts) {
      await dbArg.guildMember.upsert({
        where: { guildId_discordId: { guildId: member.guild.id, discordId: i.discordId } },
        create: { guildId: member.guild.id, discordId: i.discordId, status: 'pending', displayName: i.displayName, username: i.username },
        update: { displayName: i.displayName, username: i.username },
      })
    }
  } catch (e) {
    console.warn('[memberNameSync] one member:', e?.message ?? e)
  }
}

async function syncAll(client, dbArg) {
  for (const [, guild] of client.guilds.cache) {
    try {
      const n = await syncGuildMemberNames(guild, { db: dbArg })
      if (n) console.log(`[memberNameSync] ${guild.name}: ${n} row(s) updated`)
    } catch (e) {
      console.warn(`[memberNameSync] ${guild?.name ?? guild?.id}:`, e?.message ?? e)
    }
  }
}

export function startMemberNameSync(client, { db: dbArg = db, intervalMs = NAME_SYNC_INTERVAL_MS } = {}) {
  if (!client?.guilds) return
  syncAll(client, dbArg).catch(() => {})
  setInterval(() => syncAll(client, dbArg).catch(() => {}), intervalMs)
}
```

If `db.guildMember.findMany` does not accept `{ where: { guildConfigId } }`, read its signature in `bot/src/Database/index.js` and use whatever filter it supports (it is used by `/reconcile`).

- [ ] **Step 4: Wire it in `bot/src/index.js`**

Add `import { startMemberNameSync, syncOneMember } from "./services/memberNameSync.js";`, call `startMemberNameSync(client);` after `startDocsSync(client);` in the `ClientReady` handler, and add `client.on(Events.GuildMemberUpdate, (_old, member) => syncOneMember(member));` next to the `GuildMemberAdd` line. The `GuildMembers` intent is already enabled.

- [ ] **Step 5: Run tests**

Run: `node --test bot/src/services/memberNameSync.test.js` then `npm test`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/memberNameSync.js bot/src/services/memberNameSync.test.js bot/src/index.js
git commit -m "feat(members): keep Discord display names in guildmember for the site"
```

---

### Task 4: Assignee picker in `/create-task`

**Files:**
- Modify: `bot/src/commands/create-task.js` (imports at top; `showConfirmStep` lines 553–590)
- Modify: `bot/src/handlers/interactions.js` (user-select branch lines 246–252; string-select branch lines 276–279)
- Modify: `bot/src/index.js` (remove `"create_task_assignees"` from `noDeferComponentIds`, line 187)
- Test: `bot/src/commands/create-task.test.js` (new)

**Interfaces:**
- Produces: exported `assigneeRow(state)` → `ActionRowBuilder` holding a `UserSelectMenuBuilder` with custom id `create_task_assignees`.

Facts the implementer needs: `index.js` defers only buttons and string selects; user selects arrive un-acknowledged, and `respond()` in `create-task.js` calls `interaction.update()` for those, which is correct. `handleAssigneesSelect` already checks `STEP_CONFIRM` and re-renders the confirm step; it needs no change.

- [ ] **Step 1: Failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assigneeRow } from './create-task.js'

test('assignee row is a user select allowing up to 25 people with current assignees preselected', () => {
  const row = assigneeRow({ assigneeIds: ['111', '222'] }).toJSON()
  const menu = row.components[0]
  assert.equal(menu.custom_id, 'create_task_assignees')
  assert.equal(menu.type, 5) // ComponentType.UserSelect
  assert.equal(menu.min_values, 0)
  assert.equal(menu.max_values, 25)
  assert.deepEqual(menu.default_values.map((d) => d.id), ['111', '222'])
})

test('assignee row with no assignees has no defaults', () => {
  const menu = assigneeRow({}).toJSON().components[0]
  assert.ok(!menu.default_values || menu.default_values.length === 0)
})
```

- [ ] **Step 2: Run, expect `assigneeRow` not exported**

Run: `node --test bot/src/commands/create-task.test.js`. If importing `create-task.js` pulls in the database module and the test hangs, the module has a top-level side effect; stop and report. (`db/index.js` is imported by many tested commands already and does not connect at import time, so this is not expected.)

- [ ] **Step 3: Implement**

Add `UserSelectMenuBuilder` to the discord.js import in `create-task.js`. Add near `showConfirmStep`:

```js
/** The confirm step's assignee picker. Exported for its test. */
export function assigneeRow(state = {}) {
  const menu = new UserSelectMenuBuilder()
    .setCustomId('create_task_assignees')
    .setPlaceholder('Assignees (optional) — pick anyone on the server')
    .setMinValues(0)
    .setMaxValues(25)
  const current = (state.assigneeIds || []).filter(Boolean).slice(0, 25)
  if (current.length) menu.setDefaultUsers(current)
  return new ActionRowBuilder().addComponents(menu)
}
```

In `showConfirmStep`, change the final `respond` call to include the row for features:

```js
  const components = isFeature ? [assigneeRow(state), rowButtons] : [rowButtons]
  await respond(interaction, { embeds: [embed], components })
```

In `interactions.js`, delete the `create_task_assignees` block from the string-select branch and add to the user-select branch:

```js
    if (customId === "create_task_assignees")
      return runCreateTaskHandler(interaction, (i) =>
        createTaskCmd.handleAssigneesSelect(i),
      );
```

In `index.js`, remove the `"create_task_assignees",` entry from `noDeferComponentIds` (it only ever applied to string selects).

- [ ] **Step 4: Run tests**

Run: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot/src/commands/create-task.js bot/src/commands/create-task.test.js bot/src/handlers/interactions.js bot/src/index.js
git commit -m "feat(create-task): assignee picker on the confirm step, up to 25 people"
```

---

### Task 5: `/update-task` assignee and dependency options

**Files:**
- Modify: `bot/src/commands/update-task.js` (whole file; keep `projectChoices`, `NO_PROJECT`, `autocomplete` structure)
- Test: `bot/src/commands/update-task.test.js` (append)

**Interfaces:**
- Consumes: Task 1 `db.taskDependency.*`, `db.task.findByIds`; Task 2 `wouldCycle`, `openBlockers`, `blockerWarning`.
- Produces: `nextAssignees(current, { replace, add, remove })` → string[]; `applyDependencyChange({ db, cfg, task, blockedById, unblockId, actorId })` → `{ lines: string[], error: string|null }`; `projectChoices(projects, term, { withDetach = true } = {})` (Task 7 uses `withDetach: false`); `execute(interaction, { db, notify } = {})`.

- [ ] **Step 1: Failing tests (append to `update-task.test.js`)**

```js
import { nextAssignees, applyDependencyChange } from './update-task.js'

test('nextAssignees: replace wins, then add and remove apply, no duplicates', () => {
  assert.deepEqual(nextAssignees(['1', '2'], { add: '3' }), ['1', '2', '3'])
  assert.deepEqual(nextAssignees(['1', '2'], { remove: '1' }), ['2'])
  assert.deepEqual(nextAssignees(['1', '2'], { add: '2' }), ['1', '2'])
  assert.deepEqual(nextAssignees(['1', '2'], { remove: '9' }), ['1', '2'])
  assert.deepEqual(nextAssignees(['1'], { replace: ['5', '6'], add: '7', remove: '5' }), ['6', '7'])
  assert.equal(nextAssignees(['1'], {}), null) // nothing asked → no update
})

function fakeDb({ tasks = [], deps = [] } = {}) {
  const calls = []
  return {
    calls,
    task: { findByIds: async ({ where }) => tasks.filter((t) => where.ids.includes(t.id)) },
    taskDependency: {
      findManyForGuild: async () => deps,
      findByTask: async ({ where }) => deps.filter((d) => d.taskId === where.taskId),
      add: async ({ data }) => { calls.push(['add', data]); return data },
      remove: async ({ where }) => { calls.push(['remove', where]); return { removed: 1 } },
    },
  }
}

test('applyDependencyChange refuses self-block and cycles, never writing', async () => {
  const cfg = { id: 'g1' }
  const task = { id: 'A', title: 'Git Sync', status: 'open' }
  const db = fakeDb({ tasks: [task, { id: 'B', title: 'Router fix', status: 'open' }], deps: [{ taskId: 'B', blockedByTaskId: 'A' }] })
  const self = await applyDependencyChange({ db, cfg, task, blockedById: 'A' })
  assert.match(self.error, /itself/)
  const cyc = await applyDependencyChange({ db, cfg, task, blockedById: 'B' })
  assert.equal(cyc.error, '**Router fix** already depends on **Git Sync**, so **Git Sync** cannot be blocked by **Router fix**.')
  assert.equal(db.calls.length, 0)
})

test('applyDependencyChange refuses an unknown blocker', async () => {
  const db = fakeDb({ tasks: [{ id: 'A', title: 'Git Sync', status: 'open' }] })
  const out = await applyDependencyChange({ db, cfg: { id: 'g1' }, task: { id: 'A', title: 'Git Sync' }, blockedById: 'nope' })
  assert.match(out.error, /No task matches/)
})

test('applyDependencyChange writes a blocker and an unblock, reporting both', async () => {
  const task = { id: 'A', title: 'Git Sync', status: 'open' }
  const db = fakeDb({ tasks: [task, { id: 'B', title: 'Router fix', status: 'open' }, { id: 'C', title: 'Old', status: 'open' }], deps: [{ taskId: 'A', blockedByTaskId: 'C' }] })
  const out = await applyDependencyChange({ db, cfg: { id: 'g1' }, task, blockedById: 'B', unblockId: 'C', actorId: 'u1' })
  assert.equal(out.error, null)
  assert.deepEqual(db.calls[0], ['add', { guildConfigId: 'g1', taskId: 'A', blockedByTaskId: 'B', createdBy: 'u1' }])
  assert.deepEqual(db.calls[1], ['remove', { taskId: 'A', blockedByTaskId: 'C' }])
  assert.deepEqual(out.lines, ['**Blocked by:** Router fix', '**Unblocked:** Old'])
})

test('projectChoices can omit the detach entry', () => {
  const out = projectChoices(projects, '', { withDetach: false })
  assert.ok(out.every((c) => c.value !== NO_PROJECT))
  assert.equal(out.length, 3)
})
```

- [ ] **Step 2: Run, expect missing exports**

Run: `node --test bot/src/commands/update-task.test.js`

- [ ] **Step 3: Implement**

Add the options to the builder after `project`:

```js
  .addUserOption((o) => o.setName('add_assignee').setDescription('Add one more assignee').setRequired(false))
  .addUserOption((o) => o.setName('remove_assignee').setDescription('Take one assignee off the task').setRequired(false))
  .addStringOption((o) => o.setName('blocked_by').setDescription('This task cannot proceed until that task is done (pick from the list)').setRequired(false).setAutocomplete(true))
  .addStringOption((o) => o.setName('unblock').setDescription('Remove a blocker from this task (pick from the list)').setRequired(false).setAutocomplete(true))
```

Pure helpers and the dependency writer:

```js
import { idList } from '../utils/taskLabel.js'
import { wouldCycle, openBlockers, blockerWarning } from '../utils/taskDeps.js'

/** Next assignee list, or null when no assignee option was given. Pure. */
export function nextAssignees(current, { replace, add, remove } = {}) {
  if (replace === undefined && !add && !remove) return null
  const out = new Set(idList(replace !== undefined ? replace : current))
  if (add) out.add(String(add))
  if (remove) out.delete(String(remove))
  return [...out]
}

/**
 * Record / remove one dependency for `task`. Validates before writing, so a
 * refused change leaves the table untouched.
 * @returns {{ lines: string[], error: string|null }}
 */
export async function applyDependencyChange({ db: dbArg, cfg, task, blockedById = null, unblockId = null, actorId = null }) {
  const lines = []
  if (blockedById) {
    if (String(blockedById) === String(task.id)) return { lines, error: 'A task cannot be blocked by itself.' }
    const [blocker] = await dbArg.task.findByIds({ where: { guildConfigId: cfg.id, ids: [blockedById] } })
    if (!blocker) return { lines, error: `No task matches **${String(blockedById).slice(0, 80)}**. Start typing a title and pick one from the list.` }
    const deps = await dbArg.taskDependency.findManyForGuild({ where: { guildConfigId: cfg.id } })
    if (wouldCycle(task.id, blocker.id, deps)) {
      return { lines, error: `**${blocker.title}** already depends on **${task.title}**, so **${task.title}** cannot be blocked by **${blocker.title}**.` }
    }
    await dbArg.taskDependency.add({ data: { guildConfigId: cfg.id, taskId: task.id, blockedByTaskId: blocker.id, createdBy: actorId } })
    lines.push(`**Blocked by:** ${blocker.title || blocker.id}`)
  }
  if (unblockId) {
    const [blocker] = await dbArg.task.findByIds({ where: { guildConfigId: cfg.id, ids: [unblockId] } })
    const { removed } = await dbArg.taskDependency.remove({ where: { taskId: task.id, blockedByTaskId: String(unblockId) } })
    if (removed > 0) lines.push(`**Unblocked:** ${blocker?.title || unblockId}`)
  }
  return { lines, error: null }
}
```

`projectChoices` gains the flag:

```js
export function projectChoices(projects, term, { withDetach = true } = {}) {
  ...
  return (withDetach ? [head, ...rest] : rest).slice(0, 25)
}
```

`execute` becomes `export async function execute(interaction, { db: dbArg = db, notify = notifyTaskUpdate } = {})` and uses `dbArg` / `notify` throughout. After the existing option reads:

```js
  const assignees = nextAssignees(task.assigneeIds, {
    replace: assigneesStr !== null && assigneesStr !== undefined ? parseUserIds(assigneesStr) : undefined,
    add: interaction.options.getUser('add_assignee')?.id,
    remove: interaction.options.getUser('remove_assignee')?.id,
  })
  if (assignees) updates.assigneeIds = assignees
```

(remove the old `updates.assigneeIds = parseUserIds(assigneesStr)` line). Then:

```js
  const blockedById = interaction.options.getString('blocked_by')?.trim() || null
  const unblockId = interaction.options.getString('unblock')?.trim() || null
  if (Object.keys(updates).length === 0 && !blockedById && !unblockId) {
    return interaction.editReply({ content: 'Provide at least one field to update (e.g. `status`, `add_assignee`, `blocked_by`).' })
  }
  const dep = await applyDependencyChange({ db: dbArg, cfg, task, blockedById, unblockId, actorId: interaction.user.id })
  if (dep.error) return interaction.editReply({ content: dep.error })
```

Inside the `try`, only call `dbArg.task.update` and `notify` when `Object.keys(updates).length > 0`. Compute the warning once and pass it on:

```js
    let warning = ''
    if (updates.status && updates.status !== task.status && updates.status !== 'open' && updates.status !== 'pending') {
      const rows = await dbArg.taskDependency.findByTask({ where: { taskId: task.id } })
      const blockers = await dbArg.task.findByIds({ where: { guildConfigId: cfg.id, ids: rows.map((r) => r.blockedByTaskId) } })
      const byId = Object.fromEntries(blockers.map((b) => [b.id, b]))
      warning = blockerWarning(openBlockers(task.id, rows, byId))
    }
```

Pass `warning` into `notify({ ..., warning })` (Task 6 reads it), append `dep.lines` as extra embed fields (`name: 'Dependencies', value: dep.lines.join('\n')`), and when `warning` is non-empty set it as the embed description's second line. The `updates` map used for embed fields already renders arrays as mentions.

Autocomplete: the branch `if (focused.name !== 'task') return ...` becomes `if (!['task', 'blocked_by', 'unblock'].includes(focused.name)) return ...`. For `unblock`, if `interaction.options.getString('task')` is a real task id, narrow `rows` to its current blockers:

```js
    let rows = await dbArg.task.findMany({ where: { guildConfigId: cfg.id }, orderBy: { updatedAt: 'desc' }, take: 200 })
    if (focused.name === 'unblock') {
      const taskId = String(interaction.options.getString('task') || '').trim()
      const deps = taskId ? await dbArg.taskDependency.findByTask({ where: { taskId } }) : []
      if (deps.length) {
        const ids = new Set(deps.map((d) => d.blockedByTaskId))
        rows = rows.filter((t) => ids.has(t.id))
      }
    }
```

(`autocomplete` gets the same `{ db: dbArg = db } = {}` second parameter.)

- [ ] **Step 4: Run tests**

Run: `node --test bot/src/commands/update-task.test.js` then `npm test`.

- [ ] **Step 5: Commit**

```bash
git add bot/src/commands/update-task.js bot/src/commands/update-task.test.js
git commit -m "feat(update-task): add/remove one assignee, blocked_by and unblock with cycle refusal"
```

---

### Task 6: Blocker warning and unblock notices in the notifier

**Files:**
- Modify: `bot/src/services/taskUpdateNotify.js` (signature at line 80; channel post block lines 138–147; terminal block lines 158–178)
- Test: `bot/src/services/taskUpdateNotify.test.js` (append)

**Interfaces:**
- Consumes: Task 2 `isTerminal`, `openBlockers`, `unblockNotice`; Task 1 `db.taskDependency.findByBlocker`, `findByTask`, `db.task.findByIds`.
- Produces: `unblockNotices({ db, guildConfigId, blockerTask })` → `[{ channelId, text }]`; `notifyTaskUpdate({ ..., warning = '', db })`.

- [ ] **Step 1: Failing tests (append)**

```js
import { unblockNotices } from './taskUpdateNotify.js'

test('unblockNotices: one notice per task the blocker was holding, counting what remains open', async () => {
  const blocker = { id: 'C', title: 'Error handling', status: 'done' }
  const tasks = {
    A: { id: 'A', title: 'Git Sync', status: 'open', discordChannelId: 'chA' },
    B: { id: 'B', title: 'Router', status: 'open', discordChannelId: null },
    D: { id: 'D', title: 'Other blocker', status: 'in_progress' },
    C: blocker,
  }
  const deps = [
    { taskId: 'A', blockedByTaskId: 'C' }, { taskId: 'A', blockedByTaskId: 'D' },
    { taskId: 'B', blockedByTaskId: 'C' },
  ]
  const db = {
    taskDependency: {
      findByBlocker: async ({ where }) => deps.filter((d) => d.blockedByTaskId === where.blockedByTaskId),
      findByTask: async ({ where }) => deps.filter((d) => d.taskId === where.taskId),
    },
    task: { findByIds: async ({ where }) => where.ids.map((i) => tasks[i]).filter(Boolean) },
  }
  const out = await unblockNotices({ db, guildConfigId: 'g1', blockerTask: blocker })
  assert.deepEqual(out, [
    { channelId: 'chA', text: '✅ Blocker **Error handling** is done. 1 blocker still open.' },
  ])
})
```

The channel-less task B yields no notice: nowhere to post it.

- [ ] **Step 2: Run, expect missing export**

- [ ] **Step 3: Implement**

```js
import { isTerminal, openBlockers, unblockNotice } from '../utils/taskDeps.js'
import db from '../db/index.js'

/**
 * When `blockerTask` reaches a terminal status, what to tell each task it was
 * holding. Only tasks with a channel get a notice.
 */
export async function unblockNotices({ db: dbArg = db, guildConfigId, blockerTask }) {
  const holding = await dbArg.taskDependency.findByBlocker({ where: { blockedByTaskId: blockerTask.id } })
  if (!holding.length) return []
  const blocked = await dbArg.task.findByIds({ where: { guildConfigId, ids: holding.map((r) => r.taskId) } })
  const out = []
  for (const t of blocked) {
    if (!t.discordChannelId) continue
    const rows = await dbArg.taskDependency.findByTask({ where: { taskId: t.id } })
    const others = await dbArg.task.findByIds({ where: { guildConfigId, ids: rows.map((r) => r.blockedByTaskId) } })
    const byId = Object.fromEntries(others.map((o) => [o.id, o]))
    // The blocker is terminal now; count the rest.
    const remaining = openBlockers(t.id, rows, byId).filter((o) => o.id !== blockerTask.id).length
    out.push({ channelId: t.discordChannelId, text: unblockNotice(blockerTask, remaining) })
  }
  return out
}
```

Watch the import: `taskDeps.js` imports `TERMINAL_STATUSES` from this file, and this file now imports from `taskDeps.js`. ESM handles the cycle as long as `TERMINAL_STATUSES` is a `const` evaluated before `taskDeps` functions run, which it is. If `node --test` reports a temporal-dead-zone error, move `TERMINAL_STATUSES` into `taskDeps.js` and re-export it from `taskUpdateNotify.js`.

In `notifyTaskUpdate({ client, guild, task, before, updates, actorId, warning = '', db: dbArg = db })`:
- In the channel post block, after `lines` is built: `if (warning) lines.push(warning)` so the post ends with the warning.
- After the `becameTerminal` DM loop, still inside `if (becameTerminal)`:

```js
    try {
      const cfg = await getOrCreateGuildConfig(guild.id)
      const notices = await unblockNotices({ db: dbArg, guildConfigId: cfg.id, blockerTask: { ...task, ...updates } })
      for (const n of notices) {
        const ch = await client?.channels?.fetch(n.channelId).catch(() => null)
        if (ch?.isTextBased?.()) await ch.send(n.text).catch((e) => console.warn('[taskUpdate] unblock notice failed:', e?.message || e))
      }
    } catch (e) {
      console.warn('[taskUpdate] unblock notices:', e?.message || e)
    }
```

(`getOrCreateGuildConfig` from `../db/index.js`.)

- [ ] **Step 4: Run tests**

Run: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/taskUpdateNotify.js bot/src/services/taskUpdateNotify.test.js
git commit -m "feat(tasks): warn on status changes while blocked, announce when a blocker is done"
```

---

### Task 7: `/project-members`

**Files:**
- Create: `bot/src/commands/project-members.js`
- Test: `bot/src/commands/project-members.test.js`
- Modify: `bot/src/commands/index.js` (import list and `commandModules`)
- Modify: `bot/src/config/command-config.json` (`commandRoles`, and `commandDescriptions` if that map exists there; check the file's shape)

**Interfaces:**
- Consumes: Task 1 `db.projectMember.*`, `PROJECT_MEMBER_ROLES`; Task 5 `projectChoices(..., { withDetach: false })`; `db.task.findMany({ where: { guildConfigId, projectId } })`; `idList` from `taskLabel.js`.
- Produces: `renderMembers({ project, explicit, inferredIds, nameFor })` → string; `inferredMemberIds(tasks, explicitIds)` → string[].

- [ ] **Step 1: Failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMembers, inferredMemberIds } from './project-members.js'

test('inferredMemberIds: assignees of the project tasks not already explicit, deduplicated', () => {
  const tasks = [
    { assigneeIds: ['1', '2'] }, { assigneeIds: '["2","3"]' }, { assigneeIds: [] , taggedMemberIds: ['4'] },
  ]
  assert.deepEqual(inferredMemberIds(tasks, ['1']), ['2', '3', '4'])
})

test('renderMembers groups by role and lists inferred people separately', () => {
  const out = renderMembers({
    project: { name: 'Framework' },
    explicit: [{ discordId: '1', role: 'lead' }, { discordId: '2', role: 'developer' }],
    inferredIds: ['3'],
    nameFor: (id) => ({ 1: 'Aashir', 2: 'Afaq', 3: 'Hassan' })[id],
  })
  assert.equal(out, [
    '**Framework**',
    '**Lead:** Aashir',
    '**Developer:** Afaq',
    '',
    '_Also assigned to tasks here:_ Hassan',
  ].join('\n'))
})

test('renderMembers with nobody says so', () => {
  assert.equal(renderMembers({ project: { name: 'X' }, explicit: [], inferredIds: [], nameFor: () => null }), '**X**\nNo members yet. Add one with `/project-members add`.')
})
```

- [ ] **Step 2: Run, expect module-not-found**

- [ ] **Step 3: Implement**

```js
import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig, PROJECT_MEMBER_ROLES } from '../db/index.js'
import { projectChoices } from './update-task.js'
import { holdersOf } from '../utils/taskLabel.js'

const ROLE_LABEL = { lead: 'Lead', developer: 'Developer', qa: 'QA', design: 'Design' }
const roleChoices = PROJECT_MEMBER_ROLES.map((r) => ({ name: ROLE_LABEL[r], value: r }))
const projectOpt = (o) => o.setName('project').setDescription('Start typing a project name').setRequired(true).setAutocomplete(true)

export const data = new SlashCommandBuilder()
  .setName('project-members')
  .setDescription('Who works on which project — the list the UBS-Doc site shows')
  .addSubcommand((s) => s.setName('add').setDescription('Add someone to a project, or change their role')
    .addStringOption(projectOpt)
    .addUserOption((o) => o.setName('member').setDescription('The person').setRequired(true))
    .addStringOption((o) => o.setName('role').setDescription('Their role on this project (default developer)').setRequired(false).addChoices(...roleChoices)))
  .addSubcommand((s) => s.setName('remove').setDescription('Take someone off a project')
    .addStringOption(projectOpt)
    .addUserOption((o) => o.setName('member').setDescription('The person').setRequired(true)))
  .addSubcommand((s) => s.setName('list').setDescription('Show who is on a project')
    .addStringOption(projectOpt))

/** People holding this project's tasks who are not on the explicit list. Pure. */
export function inferredMemberIds(tasks = [], explicitIds = []) {
  const explicit = new Set(explicitIds.map(String))
  const out = []
  for (const t of tasks) for (const id of holdersOf(t)) {
    if (!explicit.has(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/** The list message. Pure. */
export function renderMembers({ project, explicit = [], inferredIds = [], nameFor = () => null }) {
  const name = (id) => nameFor(id) || `<@${id}>`
  const lines = [`**${project.name}**`]
  if (!explicit.length && !inferredIds.length) {
    lines.push('No members yet. Add one with `/project-members add`.')
    return lines.join('\n')
  }
  for (const role of PROJECT_MEMBER_ROLES) {
    const people = explicit.filter((m) => m.role === role).map((m) => name(m.discordId))
    if (people.length) lines.push(`**${ROLE_LABEL[role]}:** ${people.join(', ')}`)
  }
  if (inferredIds.length) {
    lines.push('', `_Also assigned to tasks here:_ ${inferredIds.map(name).join(', ')}`)
  }
  return lines.join('\n')
}

async function resolveProject(interaction, cfg, dbArg) {
  const raw = String(interaction.options.getString('project') || '').trim()
  const row = raw ? await dbArg.project.findFirst({ where: { id: raw } }).catch(() => null) : null
  if (!row || row.guildConfigId !== cfg.id) {
    await interaction.editReply({ content: `No project matches **${raw.slice(0, 80)}**. Start typing a project name and pick one from the list.` })
    return null
  }
  return row
}

export async function execute(interaction, { db: dbArg = db } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })
  const cfg = await getOrCreateGuildConfig(guild.id)
  const sub = interaction.options.getSubcommand()
  const project = await resolveProject(interaction, cfg, dbArg)
  if (!project) return

  if (sub === 'add') {
    const user = interaction.options.getUser('member')
    const role = interaction.options.getString('role') || 'developer'
    if (user.bot) return interaction.editReply({ content: 'Bots cannot be project members.' })
    await dbArg.projectMember.add({ data: { guildConfigId: cfg.id, projectId: project.id, discordId: user.id, role, addedBy: interaction.user.id } })
    return interaction.editReply({ content: `Added <@${user.id}> to **${project.name}** as **${ROLE_LABEL[role]}**.` })
  }
  if (sub === 'remove') {
    const user = interaction.options.getUser('member')
    const { removed } = await dbArg.projectMember.remove({ where: { projectId: project.id, discordId: user.id } })
    return interaction.editReply({ content: removed ? `Removed <@${user.id}> from **${project.name}**.` : `<@${user.id}> was not on **${project.name}**.` })
  }

  const explicit = await dbArg.projectMember.findByProject({ where: { projectId: project.id } })
  const tasks = await dbArg.task.findMany({ where: { guildConfigId: cfg.id, projectId: project.id }, take: 500 })
  const inferredIds = inferredMemberIds(tasks, explicit.map((m) => m.discordId))
  const nameFor = (id) => guild.members.cache.get(id)?.displayName ?? null
  return interaction.editReply({ content: renderMembers({ project, explicit, inferredIds, nameFor }) })
}

export async function autocomplete(interaction, { db: dbArg = db } = {}) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'project') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getOrCreateGuildConfig(interaction.guild.id)
    const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
    return interaction.respond(projectChoices(projects, focused.value, { withDetach: false })).catch(() => {})
  } catch (e) {
    console.error('[project-members] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}
```

Register in `commands/index.js` (`import * as projectMembersCmd from './project-members.js'`, add to `commandModules` after `setRolesCmd`). In `command-config.json` add `"project-members": ["CEO", "Server Manager", "Project Manager"]` under `commandRoles`; if the file also carries a descriptions map, add a matching entry.

- [ ] **Step 4: Run tests**

Run: `npm test`. `commandGates.test.js` must still pass (no Discord permission on the new command). Expected: PASS; `getCommands().length` is now 43.

- [ ] **Step 5: Commit**

```bash
git add bot/src/commands/project-members.js bot/src/commands/project-members.test.js bot/src/commands/index.js bot/src/config/command-config.json
git commit -m "feat(projects): /project-members add, remove, list"
```

---

### Task 8: CSAAS endpoint `GET /api/discord/tasks`

Working directory: `D:\Work\Granjur Technologies\CSAAS_Backend`. `git fetch origin && git checkout -b feat/discord-tasks-endpoint origin/main` first.

**Files:**
- Create: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js`
- Test: `Services/SysScripts/TestScripts/discord-tasks-test/assemble.test.js`

**Interfaces:**
- Produces: `assembleTasks({ guilds, projects, tasks, deps, members, names })` → `{ generatedAt, projects: [...] }` in the spec §8 shape; `getDiscordTasks(req, decryptedPayload)`; `global.DiscordTasks_object`; `__setTestHooks`.

- [ ] **Step 1: Failing test (plain assert script, like `meeting-test/utterance.test.js`)**

```js
const assert = require("assert");
const { assembleTasks } = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks");

function run() {
  const guilds = [{ id: "g1", guildId: "1476079072584138825" }];
  const projects = [
    { id: "pFW", guildConfigId: "g1", name: "Framework", docsSlug: "framework" },
    { id: "pEmpty", guildConfigId: "g1", name: "Zeta", docsSlug: "zeta" },
  ];
  const tasks = [
    { id: "A", guildConfigId: "g1", projectId: "pFW", title: "Git Sync", type: "feature", status: "open", implementationStatus: null, assigneeIds: '["u2"]', taggedMemberIds: "[]", discordChannelId: "ch1", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z" },
    { id: "B", guildConfigId: "g1", projectId: "pFW", title: "Router fix", type: "feature", status: "in_progress", assigneeIds: '["u1","u2"]', taggedMemberIds: "[]", discordChannelId: null, createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z" },
    { id: "C", guildConfigId: "g1", projectId: "pFW", title: "Done thing", type: "bug", status: "closed", assigneeIds: "[]", taggedMemberIds: '["u3"]', discordChannelId: null, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z" },
    { id: "N", guildConfigId: "g1", projectId: null, title: "Orphan", type: "feature", status: "open", assigneeIds: "[]", taggedMemberIds: "[]", discordChannelId: null, createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" },
  ];
  const deps = [{ taskId: "A", blockedByTaskId: "B" }, { taskId: "A", blockedByTaskId: "C" }];
  const members = [{ projectId: "pFW", discordId: "u1", role: "lead" }];
  const names = [{ guildConfigId: "g1", discordId: "u1", displayName: "Aashir Adnan", username: "__gilf" }, { guildConfigId: "g1", discordId: "u2", displayName: null, username: "afaq" }];

  const out = assembleTasks({ guilds, projects, tasks, deps, members, names });
  assert.ok(out.generatedAt);
  assert.deepStrictEqual(out.projects.map((p) => p.name), ["Framework", "Zeta", "No project"], "by name, No project last");

  const fw = out.projects[0];
  assert.deepStrictEqual(fw.members.map((m) => [m.discordId, m.role, m.source]), [["u1", "lead", "explicit"], ["u2", null, "inferred"], ["u3", null, "inferred"]]);
  assert.strictEqual(fw.members[1].name, "afaq", "falls back to username");
  assert.strictEqual(fw.members[2].name, "Member …u3", "falls back to the last four characters of the id");
  assert.deepStrictEqual(fw.counts, { open: 1, in_progress: 1, pending: 0, done: 1, blocked: 1 });

  assert.deepStrictEqual(fw.tasks.map((t) => t.id), ["A", "C", "B"], "blocked first, then updatedAt desc");
  const a = fw.tasks[0];
  assert.strictEqual(a.isBlocked, true);
  assert.deepStrictEqual(a.blockedBy, [{ id: "B", title: "Router fix", status: "in_progress" }, { id: "C", title: "Done thing", status: "closed" }]);
  assert.strictEqual(a.channelUrl, "https://discord.com/channels/1476079072584138825/ch1");
  assert.deepStrictEqual(a.assignees, [{ discordId: "u2", name: "afaq" }]);
  const b = fw.tasks[2];
  assert.deepStrictEqual(b.blocks, [{ id: "A", title: "Git Sync" }]);
  assert.strictEqual(b.channelUrl, null);

  const none = out.projects[2];
  assert.strictEqual(none.id, null);
  assert.deepStrictEqual(none.tasks.map((t) => t.id), ["N"]);

  // A project with no tasks is still listed (it may have members); "No project" is omitted when empty.
  const out2 = assembleTasks({ guilds, projects, tasks: tasks.filter((t) => t.projectId), deps: [], members, names });
  assert.deepStrictEqual(out2.projects.map((p) => p.name), ["Framework", "Zeta"]);

  console.log("assemble.test.js: all assertions passed");
}
run();
```

- [ ] **Step 2: Run, expect module-not-found**

Run: `node Services/SysScripts/TestScripts/discord-tasks-test/assemble.test.js`

- [ ] **Step 3: Implement**

```js
const { executeQuery } = require("../../../../Services/Integrations/Database/queryExecution");

// Read-only view of the Discord bot's tasks for the UBS-Doc site. The bot's
// tables live in the `granjur` database on this same MySQL server, and this
// service's DB user has grants on *.*, so every query names the schema.
// Nothing here writes.

const __hooks = { executeQuery: (...a) => executeQuery(...a) };
function __setTestHooks(overrides) { Object.assign(__hooks, overrides); }

const TERMINAL = new Set(["closed", "done", "resolved"]);

function idList(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (typeof v === "string" && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter(Boolean).map(String) : []; } catch { return []; } }
  return [];
}
const holdersOf = (t) => { const a = idList(t.assigneeIds); return a.length ? a : idList(t.taggedMemberIds); };
const iso = (d) => (d ? new Date(d).toISOString() : null);

function assembleTasks({ guilds = [], projects = [], tasks = [], deps = [], members = [], names = [] }) {
  const discordGuildIdByCfg = new Map(guilds.map((g) => [g.id, g.guildId]));
  const nameRow = new Map(names.map((n) => [`${n.guildConfigId}:${n.discordId}`, n]));
  const nameFor = (cfgId, discordId) => {
    const n = nameRow.get(`${cfgId}:${discordId}`);
    return n?.displayName || n?.username || `Member …${String(discordId).slice(-4)}`;
  };
  const usernameFor = (cfgId, discordId) => nameRow.get(`${cfgId}:${discordId}`)?.username || null;

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const blockedByOf = new Map();
  const blocksOf = new Map();
  for (const d of deps) {
    const blocker = taskById.get(d.blockedByTaskId);
    const blocked = taskById.get(d.taskId);
    if (!blocker || !blocked) continue;
    if (!blockedByOf.has(d.taskId)) blockedByOf.set(d.taskId, []);
    blockedByOf.get(d.taskId).push({ id: blocker.id, title: blocker.title, status: blocker.status });
    if (!blocksOf.has(d.blockedByTaskId)) blocksOf.set(d.blockedByTaskId, []);
    blocksOf.get(d.blockedByTaskId).push({ id: blocked.id, title: blocked.title });
  }

  const shapeTask = (t) => {
    const blockedBy = blockedByOf.get(t.id) || [];
    const guildId = discordGuildIdByCfg.get(t.guildConfigId);
    return {
      id: t.id, title: t.title, type: t.type, status: t.status,
      implementationStatus: t.implementationStatus ?? null,
      assignees: holdersOf(t).map((id) => ({ discordId: id, name: nameFor(t.guildConfigId, id) })),
      blockedBy,
      blocks: blocksOf.get(t.id) || [],
      isBlocked: blockedBy.some((b) => !TERMINAL.has(String(b.status))),
      channelUrl: t.discordChannelId && guildId ? `https://discord.com/channels/${guildId}/${t.discordChannelId}` : null,
      createdAt: iso(t.createdAt), updatedAt: iso(t.updatedAt),
    };
  };
  const sortTasks = (a, b) => (Number(b.isBlocked) - Number(a.isBlocked)) || String(b.updatedAt).localeCompare(String(a.updatedAt));
  const counts = (list) => ({
    open: list.filter((t) => t.status === "open").length,
    in_progress: list.filter((t) => t.status === "in_progress").length,
    pending: list.filter((t) => t.status === "pending").length,
    done: list.filter((t) => TERMINAL.has(String(t.status))).length,
    blocked: list.filter((t) => t.isBlocked).length,
  });

  const group = (project, cfgId, list) => {
    const shaped = list.map(shapeTask).sort(sortTasks);
    const explicit = project ? members.filter((m) => m.projectId === project.id) : [];
    const explicitIds = new Set(explicit.map((m) => String(m.discordId)));
    const inferred = [];
    for (const t of list) for (const id of holdersOf(t)) if (!explicitIds.has(id) && !inferred.includes(id)) inferred.push(id);
    return {
      id: project ? project.id : null,
      name: project ? project.name : "No project",
      docsSlug: project ? project.docsSlug ?? null : null,
      members: [
        ...explicit.map((m) => ({ discordId: String(m.discordId), name: nameFor(cfgId, m.discordId), username: usernameFor(cfgId, m.discordId), role: m.role, source: "explicit" })),
        ...inferred.map((id) => ({ discordId: id, name: nameFor(cfgId, id), username: usernameFor(cfgId, id), role: null, source: "inferred" })),
      ],
      counts: counts(shaped),
      tasks: shaped,
    };
  };

  const byProject = new Map();
  const orphans = [];
  for (const t of tasks) {
    if (t.projectId && projects.some((p) => p.id === t.projectId)) {
      if (!byProject.has(t.projectId)) byProject.set(t.projectId, []);
      byProject.get(t.projectId).push(t);
    } else orphans.push(t);
  }
  const out = [...projects]
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }))
    .map((p) => group(p, p.guildConfigId, byProject.get(p.id) || []));
  if (orphans.length) out.push(group(null, orphans[0].guildConfigId, orphans));
  return { generatedAt: new Date().toISOString(), projects: out };
}

async function getDiscordTasks(req) {
  const guildFilter = req.query?.guild ? String(req.query.guild) : null;
  const q = __hooks.executeQuery;
  const guilds = guildFilter
    ? await q("SELECT id, guildId FROM granjur.guildconfig WHERE guildId = ?", [guildFilter])
    : await q("SELECT id, guildId FROM granjur.guildconfig", []);
  if (!guilds.length) return assembleTasks({});
  const cfgIds = guilds.map((g) => g.id);
  const ph = cfgIds.map(() => "?").join(", ");
  const [projects, tasks, deps, members, names] = await Promise.all([
    q(`SELECT id, guildConfigId, name, docsSlug FROM granjur.project WHERE guildConfigId IN (${ph})`, cfgIds),
    q(`SELECT id, guildConfigId, projectId, title, type, status, implementationStatus, assigneeIds, taggedMemberIds, discordChannelId, createdAt, updatedAt FROM granjur.task WHERE guildConfigId IN (${ph}) ORDER BY updatedAt DESC LIMIT 2000`, cfgIds),
    q(`SELECT taskId, blockedByTaskId FROM granjur.taskdependency WHERE guildConfigId IN (${ph})`, cfgIds),
    q(`SELECT projectId, discordId, role FROM granjur.projectmember WHERE guildConfigId IN (${ph})`, cfgIds),
    q(`SELECT guildConfigId, discordId, displayName, username FROM granjur.guildmember WHERE guildConfigId IN (${ph})`, cfgIds),
  ]);
  return assembleTasks({ guilds, projects, tasks, deps, members, names });
}

global.DiscordTasks_object = {
  versions: {
    versionData: [
      {
        "*": {
          steps: [
            {
              config: {
                features: { multistep: false, parameters: false, pagination: false },
                communication: { encryption: false },
                verification: { otp: false, accessToken: false },
              },
              data: {
                parameters: { fields: [] },
                apiInfo: {
                  preProcessFunctions: [],
                  query: { queryPayload: null, database: () => "main" },
                  postProcessFunction: getDiscordTasks,
                },
                requestMetaData: { requestMethod: "GET", permission: null },
              },
              response: { successMessage: "Discord tasks retrieved", errorMessage: "Failed to retrieve Discord tasks" },
            },
          ],
        },
      },
    ],
  },
};

module.exports = { DiscordTasks_object: global.DiscordTasks_object, assembleTasks, getDiscordTasks, __setTestHooks };
```

Before finishing, confirm two things by reading code, not by assumption: (1) `Services/Integrations/Database/queryExecution.js` passes the SQL through `db.convertQuery`; check that helper does not rewrite `granjur.task` (read `Services/Integrations/Database/` for the MySQL adapter). (2) `getApiObject` in `Services/Middlewares/config.js` lowercases every character after the first of each segment, so `discord/tasks` resolves to `DiscordTasks_object`, which matches the global set here.

- [ ] **Step 4: Run the test**

Run: `node Services/SysScripts/TestScripts/discord-tasks-test/assemble.test.js`. Expected: `all assertions passed`. Also `node -e "require('./Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js'); console.log(typeof global.DiscordTasks_object)"` prints `object`. Note: `DB_USER` in CSAAS's `.env` is quoted (`'root'`); nothing in this task reads it.

- [ ] **Step 5: Commit (named files only)**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js Services/SysScripts/TestScripts/discord-tasks-test/assemble.test.js
git commit -m "feat(discord): GET /api/discord/tasks — bot tasks by project, members, blockers"
```

---

### Task 9: UBS-Doc `/tools/tasks` screen

Working directory: `D:\Work\Granjur Technologies\UBS-Doc`. `git fetch origin && git checkout -b feat/tasks-screen origin/main` first. `npm install` if `node_modules` is missing (it is present today).

**Files:**
- Create: `src/components/discordTasks/api.ts`, `src/screens/tasksLogic.ts`, `src/screens/tasksLogic.test.ts`, `src/screens/Tasks.tsx`
- Modify: `src/app/routes.tsx` (imports; add a route next to `/tools/projects`), `src/screens/ToolsHub.tsx` (`TOOLS` array), `src/components/Sidebar.tsx` (tools list around lines 44–54), `src/screens/Projects.tsx` (`ProjectsGrid` card actions)

**Interfaces:**
- Consumes: Task 8's response shape.
- Produces: types `TaskRow`, `ProjectGroup`, `TasksPayload`; `fetchDiscordTasks(): Promise<TasksPayload>`; `applyFilters(projects, filters)`, `assigneeOptions(projects)`, `statusTone(task)`, `DEFAULT_FILTERS`.

- [ ] **Step 1: Failing vitest**

`src/screens/tasksLogic.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { applyFilters, assigneeOptions, statusTone, DEFAULT_FILTERS, type ProjectGroup } from './tasksLogic'

const t = (id: string, status: string, assignees: string[], isBlocked = false, title = id) => ({
  id, title, type: 'feature', status, implementationStatus: null,
  assignees: assignees.map((a) => ({ discordId: a, name: `Name ${a}` })),
  blockedBy: [], blocks: [], isBlocked, channelUrl: null, createdAt: '', updatedAt: '',
})
const projects: ProjectGroup[] = [
  { id: 'p1', name: 'Framework', docsSlug: 'framework', members: [], counts: { open: 2, in_progress: 0, pending: 0, done: 1, blocked: 1 },
    tasks: [t('A', 'open', ['u1'], true, 'Git Sync'), t('B', 'open', ['u2']), t('C', 'done', ['u1'])] },
  { id: null, name: 'No project', docsSlug: null, members: [], counts: { open: 1, in_progress: 0, pending: 0, done: 0, blocked: 0 },
    tasks: [t('N', 'open', [])] },
]

describe('applyFilters', () => {
  it('returns everything with the defaults, keeping empty groups out', () => {
    expect(applyFilters(projects, DEFAULT_FILTERS).map((p) => p.tasks.length)).toEqual([3, 1])
  })
  it('status "active" hides terminal tasks and drops a group with nothing left', () => {
    const out = applyFilters(projects, { ...DEFAULT_FILTERS, status: 'active' })
    expect(out[0].tasks.map((x) => x.id)).toEqual(['A', 'B'])
  })
  it('project, assignee, blockedOnly and query narrow independently', () => {
    expect(applyFilters(projects, { ...DEFAULT_FILTERS, projectSlug: 'framework' }).map((p) => p.id)).toEqual(['p1'])
    expect(applyFilters(projects, { ...DEFAULT_FILTERS, assigneeId: 'u2' })[0].tasks.map((x) => x.id)).toEqual(['B'])
    expect(applyFilters(projects, { ...DEFAULT_FILTERS, blockedOnly: true })[0].tasks.map((x) => x.id)).toEqual(['A'])
    expect(applyFilters(projects, { ...DEFAULT_FILTERS, query: 'git' })[0].tasks.map((x) => x.id)).toEqual(['A'])
    expect(applyFilters(projects, { ...DEFAULT_FILTERS, query: 'zzz' })).toEqual([])
  })
})

describe('assigneeOptions', () => {
  it('lists each person once, sorted by name', () => {
    expect(assigneeOptions(projects)).toEqual([{ id: 'u1', name: 'Name u1' }, { id: 'u2', name: 'Name u2' }])
  })
})

describe('statusTone', () => {
  it('blocked beats status; terminal is done; in_progress is active; else idle', () => {
    expect(statusTone(t('x', 'open', [], true))).toBe('bad')
    expect(statusTone(t('x', 'closed', []))).toBe('done')
    expect(statusTone(t('x', 'in_progress', []))).toBe('active')
    expect(statusTone(t('x', 'pending', []))).toBe('idle')
  })
})
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run src/screens/tasksLogic.test.ts`

- [ ] **Step 3: Logic and API**

`src/screens/tasksLogic.ts`:

```ts
export interface TaskPerson { discordId: string; name: string }
export interface TaskRef { id: string; title: string; status?: string }
export interface TaskRow {
  id: string; title: string; type: string; status: string; implementationStatus: string | null
  assignees: TaskPerson[]; blockedBy: TaskRef[]; blocks: TaskRef[]; isBlocked: boolean
  channelUrl: string | null; createdAt: string; updatedAt: string
}
export interface ProjectMember { discordId: string; name: string; username: string | null; role: string | null; source: 'explicit' | 'inferred' }
export interface ProjectGroup {
  id: string | null; name: string; docsSlug: string | null; members: ProjectMember[]
  counts: { open: number; in_progress: number; pending: number; done: number; blocked: number }
  tasks: TaskRow[]
}
export interface TasksPayload { generatedAt: string; projects: ProjectGroup[] }

export type StatusFilter = 'all' | 'active' | 'done'
export interface Filters { status: StatusFilter; projectSlug: string | null; assigneeId: string | null; blockedOnly: boolean; query: string }
export const DEFAULT_FILTERS: Filters = { status: 'all', projectSlug: null, assigneeId: null, blockedOnly: false, query: '' }

const TERMINAL = new Set(['closed', 'done', 'resolved'])
export const isTerminal = (s: string) => TERMINAL.has(s)

export function applyFilters(projects: ProjectGroup[], f: Filters): ProjectGroup[] {
  const needle = f.query.trim().toLowerCase()
  return projects
    .filter((p) => !f.projectSlug || p.docsSlug === f.projectSlug)
    .map((p) => ({
      ...p,
      tasks: p.tasks.filter((t) => {
        if (f.status === 'active' && isTerminal(t.status)) return false
        if (f.status === 'done' && !isTerminal(t.status)) return false
        if (f.assigneeId && !t.assignees.some((a) => a.discordId === f.assigneeId)) return false
        if (f.blockedOnly && !t.isBlocked) return false
        if (needle && !t.title.toLowerCase().includes(needle)) return false
        return true
      }),
    }))
    .filter((p) => p.tasks.length > 0)
}

export function assigneeOptions(projects: ProjectGroup[]): { id: string; name: string }[] {
  const seen = new Map<string, string>()
  for (const p of projects) for (const t of p.tasks) for (const a of t.assignees) if (!seen.has(a.discordId)) seen.set(a.discordId, a.name)
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}

export type Tone = 'done' | 'active' | 'idle' | 'bad'
export function statusTone(t: TaskRow): Tone {
  if (t.isBlocked) return 'bad'
  if (isTerminal(t.status)) return 'done'
  if (t.status === 'in_progress') return 'active'
  return 'idle'
}

export const STATUS_LABEL: Record<string, string> = {
  open: 'Open', pending: 'Pending', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed', done: 'Done',
}
```

`src/components/discordTasks/api.ts`:

```ts
import { mwGet } from '../meetingWorkflow/api'
import type { TasksPayload } from '../../screens/tasksLogic'

// Same transport as the meeting workflow: ${API_BASE_URL}/api + path, response
// unwrapped as payload.return ?? payload ?? data.
export function fetchDiscordTasks(): Promise<TasksPayload> {
  return mwGet('/discord/tasks') as Promise<TasksPayload>
}
```

(`api.js` is JavaScript; if TypeScript complains about the import, add `// @ts-expect-error untyped js module` above it, matching how other `.tsx` screens import `mwGet`. `Meetings.tsx` imports it without a directive, so this is not expected.)

- [ ] **Step 4: Run vitest, expect PASS**

- [ ] **Step 5: The screen**

`src/screens/Tasks.tsx`, following `Meetings.tsx` (aurora background, breadcrumb, `AuroraText` title, search + refresh, error banner, empty card):

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RefreshCw, ExternalLink, Ban } from 'lucide-react'
import AuroraText from '../components/ui/aurora-text'
import SearchInput from '../components/ui/search-input'
import { c, card, txt, muted, Breadcrumb, chipRed, chipGray, chipIndigo, chipMint, chipAmber, inputCls } from '../lib'
import { useTheme } from '../app/ThemeContext'
import type { Theme } from '../types'
import { fetchDiscordTasks } from '../components/discordTasks/api'
import {
  applyFilters, assigneeOptions, statusTone, DEFAULT_FILTERS, STATUS_LABEL,
  type Filters, type ProjectGroup, type TaskRow, type Tone,
} from './tasksLogic'

// Project tasks straight from the Discord bot's database, via CSAAS
// GET /api/discord/tasks. Filtering is client-side: the corpus is a few dozen
// rows and the endpoint returns every status.

const toneChip: Record<Tone, (t: Theme) => string> = { done: chipMint, active: chipIndigo, idle: chipAmber, bad: chipRed }

export default function Tasks() {
  const { theme } = useTheme()
  const d = theme === 'dark'
  const [params, setParams] = useSearchParams()
  const [projects, setProjects] = useState<ProjectGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS, projectSlug: params.get('project') })

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const data = await fetchDiscordTasks()
      setProjects(Array.isArray(data?.projects) ? data.projects : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const set = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch }
    setFilters(next)
    if ('projectSlug' in patch) {
      const p = new URLSearchParams(params)
      if (next.projectSlug) p.set('project', next.projectSlug); else p.delete('project')
      setParams(p, { replace: true })
    }
  }

  const visible = useMemo(() => applyFilters(projects, filters), [projects, filters])
  const people = useMemo(() => assigneeOptions(projects), [projects])
  const total = visible.reduce((n, p) => n + p.tasks.length, 0)
  const blocked = visible.reduce((n, p) => n + p.tasks.filter((t) => t.isBlocked).length, 0)
  const sel = inputCls(theme, 'text-xs py-2 px-3 rounded-xl')

  return (
    <div className={c('min-h-full', d ? 'aurora-dark' : 'aurora-light')}>
      <div className="max-w-[1240px] mx-auto px-4 sm:px-6 lg:px-10 py-8 lg:py-12">
        <Breadcrumb items={['UBS', 'Dev Tools', 'Tasks']} theme={theme} />
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="font-extrabold mb-2 screen-title"><AuroraText>Tasks</AuroraText></h1>
            <p className={c('text-sm font-medium', muted(theme))}>{total} task{total === 1 ? '' : 's'} · {blocked} blocked</p>
          </div>
          <div className="flex items-center gap-3">
            <SearchInput value={filters.query} onChange={(v) => set({ query: v })} placeholder="Search tasks…" width={240} theme={theme} />
            <button type="button" onClick={() => void refresh()} disabled={loading} title="Refresh"
              className={c('p-2.5 rounded-xl tr', d ? 'text-white/50 hover:bg-white/6' : 'text-slate-400 hover:bg-slate-100', loading ? 'opacity-50' : '')}>
              <RefreshCw size={16} className={loading ? 'spin' : ''} />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-6">
          <select className={sel} value={filters.status} onChange={(e) => set({ status: e.target.value as Filters['status'] })}>
            <option value="all">All statuses</option><option value="active">Active</option><option value="done">Done</option>
          </select>
          <select className={sel} value={filters.projectSlug ?? ''} onChange={(e) => set({ projectSlug: e.target.value || null })}>
            <option value="">All projects</option>
            {projects.filter((p) => p.docsSlug).map((p) => <option key={p.docsSlug!} value={p.docsSlug!}>{p.name}</option>)}
          </select>
          <select className={sel} value={filters.assigneeId ?? ''} onChange={(e) => set({ assigneeId: e.target.value || null })}>
            <option value="">Anyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label className={c('flex items-center gap-2 text-xs font-semibold cursor-pointer', muted(theme))}>
            <input type="checkbox" checked={filters.blockedOnly} onChange={(e) => set({ blockedOnly: e.target.checked })} /> Blocked only
          </label>
        </div>

        {error && (
          <div className={c('rounded-xl px-4 py-3 mb-5 text-sm font-medium border', d ? 'bg-red-500/10 border-red-500/25 text-red-300' : 'bg-red-50 border-red-200 text-red-600')}>
            Could not load tasks: {error}
          </div>
        )}
        {!loading && !error && visible.length === 0 && (
          <div className={c(card(theme), 'rounded-2xl px-8 py-14 text-center')}>
            <p className={c('text-sm font-medium', muted(theme))}>{projects.length ? 'No tasks match these filters.' : 'No tasks yet.'}</p>
          </div>
        )}

        <div className="flex flex-col gap-5">
          {visible.map((p) => <ProjectCard key={p.id ?? 'none'} p={p} theme={theme} />)}
        </div>
      </div>
    </div>
  )
}

function ProjectCard({ p, theme }: { p: ProjectGroup; theme: Theme }) {
  const d = theme === 'dark'
  return (
    <section className={c(card(theme), 'rounded-2xl p-5 sm:p-6')}>
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <h2 className={c('font-extrabold text-lg', txt(theme))}>{p.name}</h2>
        <p className={c('text-xs font-semibold', muted(theme))}>
          {p.counts.open} open · {p.counts.in_progress} in progress · {p.counts.done} done{p.counts.blocked ? ` · ${p.counts.blocked} blocked` : ''}
        </p>
      </div>
      {p.members.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {p.members.map((m) => (
            <span key={m.discordId} title={m.source === 'inferred' ? 'Assigned to tasks here' : (m.role ?? undefined)}
              className={c('text-[11px] font-semibold px-2.5 py-1 rounded-full', m.source === 'explicit' ? chipIndigo(theme) : chipGray(theme))}>
              {m.name}{m.role ? ` · ${m.role}` : ''}
            </span>
          ))}
        </div>
      )}
      <ul className={c('divide-y', d ? 'divide-white/6' : 'divide-slate-100')}>
        {p.tasks.map((t) => <TaskLine key={t.id} t={t} theme={theme} />)}
      </ul>
    </section>
  )
}

function TaskLine({ t, theme }: { t: TaskRow; theme: Theme }) {
  const tone = statusTone(t)
  return (
    <li className="py-3 flex flex-wrap items-start gap-x-3 gap-y-1.5">
      <span className={c('text-[11px] font-bold px-2 py-0.5 rounded-md shrink-0', toneChip[tone](theme))}>{STATUS_LABEL[t.status] ?? t.status}</span>
      <div className="flex-1 min-w-[200px]">
        <p className={c('text-sm font-semibold', txt(theme))}>
          {t.title}
          {t.channelUrl && (
            <a href={t.channelUrl} target="_blank" rel="noreferrer" title="Open in Discord" className="inline-flex ml-1.5 align-middle opacity-60 hover:opacity-100">
              <ExternalLink size={12} />
            </a>
          )}
        </p>
        <p className={c('text-xs', muted(theme))}>
          {t.assignees.length ? t.assignees.map((a) => a.name).join(', ') : 'Unassigned'}
          {t.type === 'bug' ? ' · bug' : ''}
        </p>
        {t.isBlocked && (
          <p className={c('text-xs font-semibold mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md', chipRed(theme))}>
            <Ban size={11} /> Blocked by: {t.blockedBy.filter((b) => !['closed', 'done', 'resolved'].includes(b.status ?? '')).map((b) => b.title).join(', ')}
          </p>
        )}
      </div>
    </li>
  )
}
```

Wire it up:
- `routes.tsx`: `import Tasks from '../screens/Tasks'` and `<Route path="/tools/tasks" element={T(<Tasks />)} />` after the `/tools/projects/view` route.
- `ToolsHub.tsx`: add `ListChecks` to the lucide import and `{ label: 'Tasks', desc: 'Project tasks, owners and blockers', Icon: ListChecks, route: '/tools/tasks', from: '#F59E0B', to: '#EF4444' }` after the Projects entry.
- `Sidebar.tsx`: add `ListChecks` to its lucide import and `{ to: '/tools/tasks', label: 'Tasks', Icon: ListChecks }` after the Projects entry in the tools list.
- `Projects.tsx`, in `ProjectsGrid`'s action row, after the Documentation link: a `Link to={`/tools/tasks?project=${encodeURIComponent(p.slug)}`}` styled like the `Open` link with the text `Tasks`. The registry's `badar-hms` slug matches the bot's `docsSlug`; other registry slugs may not and simply show an empty filter.

- [ ] **Step 6: Build and test**

Run: `npx vitest run` and `npx tsc --noEmit -p .` (if the repo has no `tsconfig` for that, `npm run build` is the type check). Expected: clean.

- [ ] **Step 7: Commit (named files only)**

```bash
git add src/components/discordTasks/api.ts src/screens/tasksLogic.ts src/screens/tasksLogic.test.ts src/screens/Tasks.tsx src/app/routes.tsx src/screens/ToolsHub.tsx src/components/Sidebar.tsx src/screens/Projects.tsx
git commit -m "feat(tools): /tools/tasks — Discord tasks by project with members and blockers"
```

---

### Task 10: Knowledge and state

**Files:**
- Create: `.claude/knowledge/project-tasks-site.md`
- Modify: `.claude/knowledge/README.md`, `.claude/state/session.md`, `.claude/state/backlog.md`, `.claude/state/completed.md`

- [ ] **Step 1: Write the knowledge file**

Cover, in this order: the data path (site → CSAAS `/api/discord/tasks` → `granjur.*` cross-database reads, and that this depends on `root@localhost` holding `*.*` grants); the three schema additions and that blocked is computed; the `/update-task` options and the cycle refusal; `/project-members` and inferred members; the name sync and its `pending` insert; the site screen and its deep link; the deploy order (bot, then CSAAS, then site); and the two follow-ups left out (dashboard blocked marker, avatars). Add an index line to `README.md`.

- [ ] **Step 2: State**

Move the item into `completed.md` dated 2026-09-17 with the commit list; add follow-ups to `backlog.md` (dashboard marker; `/close-feature` and `/resolve-bug` change status without going through `notifyTaskUpdate`, so they neither warn nor post unblock notices; a site link from a task to its project docs). Rewrite `session.md`.

- [ ] **Step 3: Commit**

```bash
git add .claude/knowledge/project-tasks-site.md .claude/knowledge/README.md .claude/state/session.md .claude/state/backlog.md .claude/state/completed.md
git commit -m "docs: project tasks site section — knowledge and state"
```

---

## Verification after deploy (not a task; the controller runs it)

1. Bot: merge to `main`, push. On the VM, `pm2 logs granjur-bot --lines 50` shows `Registered 43 slash commands` and `[memberNameSync] ...` lines; `SELECT COUNT(*) FROM guildmember WHERE displayName IS NOT NULL` is non-zero.
2. CSAAS: merge to `main`, push. On the VM, `curl -s https://api.gobizzi.com/api/discord/tasks | head -c 600` shows `"projects"`.
3. Site: merge to `main`, push. Open `https://ubs-doc.vercel.app/tools/tasks`.
4. In Discord: `/update-task task:<A> blocked_by:<B>`, then `/update-task task:<A> status:In progress` shows the warning; `/update-task task:<B> status:Done` posts the unblock notice in A's channel; `/project-members add` then refresh the page.

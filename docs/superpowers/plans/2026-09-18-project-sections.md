# Per-project Discord Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every project its own category of channels (members, documentation, meetings, frontend, backend, database) visible only to that project's role, put its task channels there under readable names, and make meetings started inside a project belong to it.

**Architecture:** One pure planner decides what to create, rename or move for a project given a snapshot of the server; a thin applier performs it, giving each existing channel exactly one edit. Commands (`/project-setup`, `/projects`, `/project-members`, `/meeting-channel`, `/create-task`) call that path. Four new columns let the bot repair what it created by id rather than by name.

**Tech Stack:** Node 24 ESM, discord.js v14, mysql2, `node:test`. One repo: the Discord bot.

**Spec:** `docs/superpowers/specs/2026-09-18-project-sections-design.md`

## Global Constraints

- One repo: `D:\Work\Granjur Technologies\Granjur-Discord-Bot`, branch `feat/project-sections` off `main`. Never `prettier`.
- **Tests never touch production.** The root `.env` holds the live `DATABASE_URL` (binding rule `.claude/rules/tests-never-touch-production.md`). Every function under test that queries takes a `{ db }` seam and, where it needs the guild config, `{ getConfig }`; tests pass fakes for both. Never run a test against a version of the code that does not honour those seams, including to show a failing test first.
- Tests: `npm test` from the repo root (`node --test`, bare). One file: `node --test <path>`.
- SQL: lowercase table names; `LIMIT` inlined, never bound; every insert and update builds its column list and params from **one** ordered array, with a test that asserts they line up; migrations guarded with the `information_schema` pattern from migration 016 and mirrored in `bot/src/Database/schema.sql`.
- Commands: never `setDefaultMemberPermissions` (roles live in `bot/src/config/command-config.json`; `commandGates.test.js` fails a command that declares both). Every slash command is deferred ephemerally before `execute`, so `execute` uses `interaction.editReply`.
- **Discord limits that bind this work:** 50 channels per category; 500 channels per guild; **2 edits per channel per 10 minutes**, so a rename and a move of the same channel must be ONE `edit()` call carrying both. Channel name ≤ 100 characters, category name ≤ 100. An overwrite for a user needs `type: OverwriteType.Member` and for a role `OverwriteType.Role` (passing the wrong one makes Discord silently drop it — that bug hid `feature-f56be0` on 2026-09-04).
- Section channel keys, in creation order: `members`, `documentation`, `meetings`, `meetingVoice`, `frontendChat`, `frontendVoice`, `backendChat`, `backendVoice`, `databaseChat`, `databaseVoice`.
- Category name: `📂 ` + project name upper-cased, cut to 100. Channel name: `<slug>-<suffix>` with the suffixes `members`, `documentation`, `meetings`, `meeting-voice`, `frontend-chat`, `frontend-voice`, `backend-chat`, `backend-voice`, `database-chat`, `database-voice`; truncate the slug, never the suffix.
- A project whose name equals one of the 15 `MANAGED_ROLES` (`bot/src/utils/roleSync.js`) is refused a role, with a message.
- Nothing in this feature deletes a channel or a role.
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File map

- Create `bot/src/Database/migrations/019_project_discord_sections.sql`; modify `schema.sql`.
- Modify `bot/src/Database/index.js`: `projectUpdate` (new), `scheduledMeetingUpdate` gains `projectId`, both registered on `db`.
- Create `bot/src/utils/taskChannelName.js` + test.
- Create `bot/src/services/projectSection.js` (planner + applier) + test.
- Create `bot/src/services/projectMembersPanel.js` + test.
- Create `bot/src/commands/project-setup.js` + test; register in `commands/index.js` and `command-config.json`.
- Modify `bot/src/services/taskTicketChannel.js` (project parent + name) + its test.
- Modify `bot/src/commands/project-members.js` (inference, role grant/revoke, panel) + test.
- Modify `bot/src/commands/meeting-channel.js` (project option + inference) + test.
- Modify `bot/src/commands/projects.js` (build the section on add), `create-project-categories.js`, `create-project-role.js` (wrappers).
- Docs: `.claude/knowledge/project-sections.md` (new), README index, `.claude/state/*`.

---

### Task 1: Schema and DB surface

**Files:**
- Create: `bot/src/Database/migrations/019_project_discord_sections.sql`
- Modify: `bot/src/Database/index.js`, `bot/src/Database/schema.sql`
- Test: `bot/src/Database/projectSection.test.js`

**Interfaces:**
- Produces: `projectUpdateSql(id, data)` → `{ sql, params }` (exported); `db.project.update({ where: { id }, data: { discordCategoryId, discordRoleId, discordChannels, name, docsSlug, docsPaths } })`; `db.scheduledMeeting.update` accepts `projectId`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectUpdateSql } from './index.js'

test('project update: one ordered array drives the SET list and the params', () => {
  const { sql, params } = projectUpdateSql('p1', {
    discordCategoryId: 'c1', discordRoleId: 'r1', discordChannels: { members: 'm1' },
  })
  const sets = sql.match(/SET (.+) WHERE/)[1].split(',').map((s) => s.trim())
  assert.deepEqual(sets, ['discordCategoryId = ?', 'discordRoleId = ?', 'discordChannels = ?'])
  assert.deepEqual(params, ['c1', 'r1', '{"members":"m1"}', 'p1'])
  assert.equal((sql.match(/\?/g) || []).length, params.length)
  assert.match(sql, /^UPDATE `project` SET /)
})

test('project update: only the given fields are written, id is always last', () => {
  const { sql, params } = projectUpdateSql('p2', { name: 'Framework' })
  assert.match(sql, /SET name = \? WHERE id = \?$/)
  assert.deepEqual(params, ['Framework', 'p2'])
})

test('project update: nothing to write returns null', () => {
  assert.equal(projectUpdateSql('p3', {}), null)
})
```

- [ ] **Step 2: Run it** — `node --test bot/src/Database/projectSection.test.js`. Expected: FAIL, `projectUpdateSql` is not exported.

- [ ] **Step 3: Migration**

`019_project_discord_sections.sql`:

```sql
-- Per-project Discord section: the category, the role that sees it, and the
-- channels the bot created. Stored as ids so a channel renamed by hand is still
-- recognised on repair. scheduledmeeting.projectId records the project a meeting
-- was started in.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project' AND COLUMN_NAME = 'discordCategoryId');
SET @sql = IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN discordCategoryId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project' AND COLUMN_NAME = 'discordRoleId');
SET @sql = IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN discordRoleId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project' AND COLUMN_NAME = 'discordChannels');
SET @sql = IF(@col = 0, 'ALTER TABLE `project` ADD COLUMN discordChannels JSON DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scheduledmeeting' AND COLUMN_NAME = 'projectId');
SET @sql = IF(@col = 0, 'ALTER TABLE `scheduledmeeting` ADD COLUMN projectId VARCHAR(36) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
```

Mirror the four columns in `schema.sql` (`project` after `docsPaths`, `scheduledmeeting` after `voiceChannelId`). Check the real table name for scheduled meetings in `schema.sql` first and use it verbatim.

- [ ] **Step 4: DB helpers**

In `bot/src/Database/index.js`, next to the other project helpers:

```js
/** Columns `db.project.update` may write, in one ordered list. */
const PROJECT_UPDATABLE = [
  ["name", (v) => v],
  ["readme", (v) => v],
  ["docsSlug", (v) => v],
  ["docsPaths", (v) => toJson(v)],
  ["discordCategoryId", (v) => v],
  ["discordRoleId", (v) => v],
  ["discordChannels", (v) => toJson(v)],
];

export function projectUpdateSql(id, data = {}) {
  const sets = [];
  const params = [];
  for (const [col, encode] of PROJECT_UPDATABLE) {
    if (data[col] === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(encode(data[col]));
  }
  if (sets.length === 0) return null;
  params.push(id);
  return { sql: `UPDATE \`project\` SET ${sets.join(", ")} WHERE id = ?`, params };
}

async function projectUpdate({ where, data }) {
  const built = projectUpdateSql(where?.id, data);
  if (!built) return projectFindFirst({ where: { id: where?.id } });
  await query(built.sql, built.params);
  return projectFindFirst({ where: { id: where.id } });
}
```

Register `update: projectUpdate` on `db.project`. In `scheduledMeetingUpdate`, add `projectId` the way the function already adds its other fields (read it first and match its style).

- [ ] **Step 5: Run** — `node --test bot/src/Database/projectSection.test.js`, then `npm test`. All pass.
- [ ] **Step 6: Commit** — `feat(db): project Discord section columns and a project update helper`

---

### Task 2: Task channel names

**Files:** Create `bot/src/utils/taskChannelName.js`, `bot/src/utils/taskChannelName.test.js`

**Interfaces:**
- Produces: `taskChannelName({ type, title, taskId, taken = new Set() })` → string; `MAX_CHANNEL_NAME = 100`.

- [ ] **Step 1: Failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskChannelName } from './taskChannelName.js'

const ID = 'a1b2c3d4e5f6a7b8c9d0e1f2'

test('a feature is named after its title', () => {
  assert.equal(taskChannelName({ type: 'feature', title: 'Git Sync', taskId: ID }), 'feature-git-sync')
})

test('a bug uses the bug prefix and squashes punctuation', () => {
  assert.equal(taskChannelName({ type: 'bug', title: 'Login  crash!! (urgent)', taskId: ID }), 'bug-login-crash-urgent')
})

test('an empty or symbol-only title falls back to the short id', () => {
  assert.equal(taskChannelName({ type: 'feature', title: '', taskId: ID }), `feature-${ID.slice(-6)}`)
  assert.equal(taskChannelName({ type: 'feature', title: '!!! ???', taskId: ID }), `feature-${ID.slice(-6)}`)
})

test('a long title is cut to 100 characters and never loses its prefix', () => {
  const name = taskChannelName({ type: 'feature', title: 'x'.repeat(200), taskId: ID })
  assert.equal(name.length, 100)
  assert.ok(name.startsWith('feature-'))
  assert.ok(!name.endsWith('-'))
})

test('a taken name gets four characters of the id, and is stable on repeat', () => {
  const taken = new Set(['feature-git-sync'])
  const a = taskChannelName({ type: 'feature', title: 'Git Sync', taskId: ID, taken })
  assert.equal(a, `feature-git-sync-${ID.slice(0, 4)}`)
  assert.equal(taskChannelName({ type: 'feature', title: 'Git Sync', taskId: ID, taken }), a)
})

test('when the suffixed name is also taken it grows deterministically', () => {
  const taken = new Set(['feature-git-sync', `feature-git-sync-${ID.slice(0, 4)}`])
  const name = taskChannelName({ type: 'feature', title: 'Git Sync', taskId: ID, taken })
  assert.equal(name, `feature-git-sync-${ID.slice(0, 8)}`)
})
```

- [ ] **Step 2: Run, expect module-not-found.**

- [ ] **Step 3: Implement**

```js
// Channel names for task tickets. `feature-0145e3` told nobody anything; the
// title does. The id lives in the channel topic, and nothing resolves a task by
// channel name (/close-feature and /resolve-bug look the row up by channel id).
import { slugify } from './docPath.js'

export const MAX_CHANNEL_NAME = 100

export function taskChannelName({ type, title, taskId, taken = new Set() }) {
  const prefix = type === 'bug' ? 'bug' : 'feature'
  const id = String(taskId ?? '')
  const slug = slugify(title)
  let base = slug ? `${prefix}-${slug}` : `${prefix}-${id.slice(-6)}`
  if (base.length > MAX_CHANNEL_NAME) base = base.slice(0, MAX_CHANNEL_NAME).replace(/-+$/, '')
  if (!taken.has(base)) return base
  // Deterministic: a repair run must land on the same name it chose before.
  for (const n of [4, 8, 12, id.length]) {
    const suffix = `-${id.slice(0, n)}`
    const room = MAX_CHANNEL_NAME - suffix.length
    const candidate = `${base.slice(0, room).replace(/-+$/, '')}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return `${prefix}-${id.slice(-6)}`
}
```

- [ ] **Step 4: Run tests.** - [ ] **Step 5: Commit** — `feat(tasks): name a task channel after its title`

---

### Task 3: The section planner

**Files:** Create `bot/src/services/projectSection.js`, `bot/src/services/projectSection.test.js`

**Interfaces:**
- Consumes: `taskChannelName` (Task 2), `MANAGED_ROLES` from `bot/src/utils/roleSync.js`, `slugify` from `bot/src/utils/docPath.js`.
- Produces: `SECTIONS` (the ten `{ key, suffix, type }` in creation order), `categoryNameFor(project)`, `channelNameFor(project, suffix)`, `planProjectSection(project, observed)` → the plan in spec §7, `CATEGORY_SOFT_CAP = 49`.

Observed shape (a plain snapshot, no Discord objects):
```js
{
  roleId: string|null, roleNames: Map<string,string>,   // name -> id, for reuse
  categoryId: string|null, categoryName: string|null, categoryChannelCount: number,
  channels: { [key]: { id, name, parentId } },          // only what exists
  tasks: [{ id, title, type, channelId, channelName, parentId }],
  takenNames: Set<string>,
}
```

- [ ] **Step 1: Failing tests**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planProjectSection, SECTIONS, categoryNameFor, channelNameFor } from './projectSection.js'

const project = { id: 'p1', name: 'Framework', docsSlug: 'framework' }
const empty = { roleId: null, roleNames: new Map(), categoryId: null, categoryName: null, categoryChannelCount: 0, channels: {}, tasks: [], takenNames: new Set() }

test('names follow the spec', () => {
  assert.equal(categoryNameFor(project), '📂 FRAMEWORK')
  assert.equal(channelNameFor(project, 'frontend-chat'), 'framework-frontend-chat')
  assert.equal(SECTIONS.length, 10)
  assert.deepEqual(SECTIONS.map((s) => s.key).slice(0, 3), ['members', 'documentation', 'meetings'])
})

test('a fresh project creates the role, the category and all ten channels', () => {
  const plan = planProjectSection(project, empty)
  assert.equal(plan.role.action, 'create')
  assert.equal(plan.role.name, 'Framework')
  assert.equal(plan.category.action, 'create')
  assert.equal(plan.channels.length, 10)
  assert.ok(plan.channels.every((c) => c.action === 'create'))
  assert.equal(plan.warnings.length, 0)
})

test('an existing role of the same name is reused, not created again', () => {
  const plan = planProjectSection(project, { ...empty, roleNames: new Map([['Framework', 'r9']]) })
  assert.deepEqual([plan.role.action, plan.role.id], ['reuse', 'r9'])
})

test('a project named after a job role is refused a role, with a reason', () => {
  const plan = planProjectSection({ id: 'p2', name: 'Database', docsSlug: 'database' }, empty)
  assert.equal(plan.role.action, 'refuse')
  assert.match(plan.role.reason, /managed role/i)
  assert.ok(plan.warnings.some((w) => /Database/.test(w)))
})

test('a category renamed by hand is renamed back, found by id', () => {
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: 'old name' })
  assert.deepEqual([plan.category.action, plan.category.id, plan.category.name], ['rename', 'c1', '📂 FRAMEWORK'])
})

test('everything already correct plans nothing', () => {
  const channels = {}
  for (const s of SECTIONS) channels[s.key] = { id: `id-${s.key}`, name: channelNameFor(project, s.suffix), parentId: 'c1' }
  const plan = planProjectSection(project, { ...empty, roleId: 'r1', categoryId: 'c1', categoryName: '📂 FRAMEWORK', channels })
  assert.equal(plan.category.action, 'reuse')
  assert.ok(plan.channels.every((c) => c.action === 'reuse'))
})

test('a section channel in the wrong category is moved, a misnamed one renamed', () => {
  const channels = { members: { id: 'm1', name: 'framework-members', parentId: 'OTHER' },
                     documentation: { id: 'd1', name: 'wrong-name', parentId: 'c1' } }
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', channels })
  const byKey = Object.fromEntries(plan.channels.map((c) => [c.key, c]))
  assert.equal(byKey.members.action, 'move')
  assert.equal(byKey.documentation.action, 'rename')
  assert.equal(byKey.meetings.action, 'create')
})

test('a task outside its project is moved and renamed in one action', () => {
  const tasks = [{ id: 'tA1b2c3d4e5f6', title: 'Git Sync', type: 'feature', channelId: 'ch1', channelName: 'feature-0145e3', parentId: 'FEATURES' }]
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', tasks })
  assert.deepEqual(plan.tasks, [{ taskId: 'tA1b2c3d4e5f6', channelId: 'ch1', action: 'both', name: 'feature-git-sync' }])
})

test('a task already right plans none', () => {
  const tasks = [{ id: 't1', title: 'Git Sync', type: 'feature', channelId: 'ch1', channelName: 'feature-git-sync', parentId: 'c1' }]
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', tasks })
  assert.equal(plan.tasks[0].action, 'none')
})

test('past the category cap, task moves are dropped with a warning; sections still plan', () => {
  const tasks = [{ id: 't1', title: 'Git Sync', type: 'feature', channelId: 'ch1', channelName: 'feature-0145e3', parentId: 'FEATURES' }]
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', categoryChannelCount: 49, tasks })
  assert.equal(plan.tasks[0].action, 'rename')
  assert.ok(plan.warnings.some((w) => /full|cap/i.test(w)))
})
```

- [ ] **Step 2: Run, expect module-not-found.**

- [ ] **Step 3: Implement the planner** in `projectSection.js`: `SECTIONS` (keys and suffixes from the Global Constraints, `type` `'text'` or `'voice'`), `categoryNameFor`, `channelNameFor` (truncate the slug so `<slug>-<suffix>` fits 100), then `planProjectSection` following the tests exactly. Rules: a channel is `reuse` when its name and parent are already right, `rename` when only the name is wrong, `move` when only the parent is, `both` when both are, `create` when absent. A task whose channel is already in the category and already correctly named is `none`. Count task moves against `CATEGORY_SOFT_CAP` minus `categoryChannelCount` minus the channels this plan creates; the excess stays put and is renamed only, with one warning naming the project. Pure: no Discord, no database, no `Date.now()`.

- [ ] **Step 4: Run tests.** - [ ] **Step 5: Commit** — `feat(projects): pure planner for a project's Discord section`

---

### Task 4: The applier

**Files:** Modify `bot/src/services/projectSection.js`; test in the same file's test.

**Interfaces:**
- Produces: `observeProjectSection(guild, project, tasks)` → the `observed` snapshot; `applyProjectSection(guild, project, plan, { db })` → `{ role, category, created: string[], renamed: string[], moved: string[], tasks: number, warnings: string[] }`; `syncProjectRoleMembers(guild, project, members, { roleId })` → `{ granted, revoked, failed }`.

- [ ] **Step 1: Failing tests** — with a fake guild (`{ id, roles: { cache, create }, channels: { cache, create } }`) and fake channel objects recording `edit` calls, assert: creating a fresh section calls `channels.create` ten times with the right parent and the two category overwrites (`@everyone` deny `ViewChannel` with `OverwriteType.Role`, project role allow); **a task needing both a rename and a move produces exactly ONE `edit()` call carrying `{ name, parent }`** (the rate-limit rule — assert `edit` was called once and with both keys); a Discord error on one channel is collected into `warnings` and does not stop the rest; `applyProjectSection` writes `discordCategoryId`, `discordRoleId` and `discordChannels` through the injected `db` exactly once; `syncProjectRoleMembers` grants to members lacking the role and revokes from holders no longer on the project, and reports failures without throwing.

- [ ] **Step 2: Run, expect failures.**

- [ ] **Step 3: Implement.** `observeProjectSection` reads `guild.channels.cache` and `guild.roles.cache` plus the project's stored ids (falling back to a name match only when the stored id does not resolve), and builds `takenNames` from every channel in the guild. `applyProjectSection` performs role → category → channels → tasks in that order, each step in its own try/catch appending to `warnings`, and persists the ids once at the end. Log failures with a `[projectSection]` prefix. Never delete.

- [ ] **Step 4: Run** `npm test`. - [ ] **Step 5: Commit** — `feat(projects): create and repair a project's section in Discord`

---

### Task 5: Members channel panel

**Files:** Create `bot/src/services/projectMembersPanel.js` + test.

**Interfaces:**
- Consumes: `PROJECT_MEMBER_ROLES` from `bot/src/db/index.js`, the `ensureGuidelinesPinned` shape in `bot/src/config/meetingGuidelines.js`.
- Produces: `PANEL_MARKER`, `buildMembersEmbed(project, members, nameFor)` → `EmbedBuilder`, `findPanelPin(messages, botUserId)`, `ensureMembersPanel(channel, project, members, { botUserId, nameFor })`, `postMembershipChange(channel, { name, role, action })`.

- [ ] **Step 1: Failing tests** — `buildMembersEmbed` groups by role in `PROJECT_MEMBER_ROLES` order, uses the readable role labels, says "No members yet" when empty, and carries the footer `Project members · <name>`; `findPanelPin` matches only the bot's own message with that footer; `ensureMembersPanel` edits an existing pin instead of posting a second one, and posts + pins when absent (fake channel with `messages.fetchPinned`, `send`, and a message object with `edit`/`pin`); a throwing channel returns false and does not reject; `postMembershipChange` renders `**Name** joined the project as Backend Developer` and `**Name** left the project`.

- [ ] **Step 2: Run, expect failures.** - [ ] **Step 3: Implement** following `meetingGuidelines.js`. - [ ] **Step 4: Run tests.** - [ ] **Step 5: Commit** — `feat(projects): pinned members panel per project`

---

### Task 6: `/project-setup`

**Files:** Create `bot/src/commands/project-setup.js` + test; modify `bot/src/commands/index.js`, `bot/src/config/command-config.json`.

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces: `execute(interaction, { db, getConfig } = {})`, `autocomplete`, `renderPlan(project, plan)` (pure, tested), `renderResult(project, result)` (pure, tested).

Options: `project` (string, autocomplete, optional), `all` (boolean, optional), `preview` (boolean, optional). Roles: `["CEO", "Server Manager", "Project Manager"]`. Refuses when neither `project` nor `all` is given. With `all`, walks every project, catching per project and continuing. `preview:true` renders the plan and performs nothing.

- [ ] **Step 1: Failing tests** with fake `db`, `getConfig`, guild and interaction: `preview:true` calls no create/edit anywhere and the reply contains the planned actions; a run with `project:` applies and replies with the counts; `all:true` continues past a project that throws and reports it; a refused managed-role name appears in the reply; `renderPlan`/`renderResult` are pure and cover the empty case. Reply text is capped at Discord's 2000 characters (assert with a many-project result).

- [ ] **Step 2: Run, expect failures.** - [ ] **Step 3: Implement.** - [ ] **Step 4: Run** `npm test`; confirm the command count with `node -e "import('./bot/src/commands/index.js').then(m => console.log(m.getCommands().length))"` (expect 44) and paste it in the report. - [ ] **Step 5: Commit** — `feat(projects): /project-setup creates and repairs a project's section`

---

### Task 7: Task channels join their project

**Files:** Modify `bot/src/services/taskTicketChannel.js` + its test; check both call sites (`bot/src/services/taskUpdateNotify.js`, `bot/src/services/meetingPipelineStages.js`) and `bot/src/commands/create-task.js`.

**Interfaces:**
- Consumes: `taskChannelName` (Task 2), the project's stored `discordCategoryId`.
- Produces: `createTaskTicketChannel(guild, { ..., project = null, taskId, title, type })` — with a project it parents to `project.discordCategoryId` (when that id still resolves and the category holds fewer than 50 channels) and names via `taskChannelName`; without one, today's behaviour, unchanged. The topic gains `Task <id>`.

- [ ] **Step 1: Failing tests** — with a project whose category resolves: `channels.create` receives that parent and the title-based name; the per-member overwrites are still present alongside; with no project: the old category and `feature-<6>` name; with a category id that no longer resolves: falls back to the global category with a warning; with a full category (50): falls back and warns.

- [ ] **Step 2: Run, expect failures.** - [ ] **Step 3: Implement**, then update the two callers to pass the task's project (look it up by `task.projectId`; `create-task.js` already resolves `firstProject`). - [ ] **Step 4: Run** `npm test`. - [ ] **Step 5: Commit** — `feat(tasks): task channels live in their project's section`

---

### Task 8: `/project-members` in-project, role sync, panel

**Files:** Modify `bot/src/commands/project-members.js` + test.

**Interfaces:**
- Consumes: Tasks 4 and 5.
- Produces: `projectFromChannel(projects, channel)` (pure, exported, tested) → project or null; `execute(interaction, { db, getConfig } = {})` unchanged in signature.

- [ ] **Step 1: Failing tests** — `projectFromChannel` matches a channel whose `parentId` equals a project's `discordCategoryId`, matches when the channel IS the category, returns null otherwise and for a null channel; `add` without the `project` option inside a project channel resolves that project and does not reply "No project matches"; `add` grants the role and posts to the members channel (fakes record both), and a Discord failure still reports the database write as done; `remove` revokes; `list` is unchanged.

- [ ] **Step 2: Run, expect failures.** - [ ] **Step 3: Implement.** - [ ] **Step 4: Run** `npm test`. - [ ] **Step 5: Commit** — `feat(projects): /project-members knows which project you are in`

---

### Task 9: Project-aware meetings

**Files:** Modify `bot/src/commands/meeting-channel.js` + new test.

**Interfaces:**
- Consumes: `projectFromChannel` (Task 8), the project's `discordCategoryId`, `db.scheduledMeeting.update` (Task 1).
- Produces: `execute(interaction, { db, getConfig } = {})` with a new optional `project` option (string, autocomplete) and channel inference.

- [ ] **Step 1: Failing tests** — with a project (given or inferred), both channels are created with that category as parent and the meeting row is written with `projectId`; with no project, the global `📋 Meetings` category and no `projectId` (today's behaviour, asserted so it cannot silently change); a project whose category no longer resolves falls back to the global category with a note in the reply.

- [ ] **Step 2: Run, expect failures.** - [ ] **Step 3: Implement**; keep `ensureMeetingChannel` and the guidelines pin exactly as they are. - [ ] **Step 4: Run** `npm test`. - [ ] **Step 5: Commit** — `feat(meetings): a meeting started in a project belongs to it`

---

### Task 10: Wire creation and retire the old commands

**Files:** Modify `bot/src/commands/projects.js`, `bot/src/commands/create-project-categories.js`, `bot/src/commands/create-project-role.js`; tests alongside.

- `projects.js` `handleAddModal`: after `db.project.create`, build the section through the Task 4 applier; on failure keep the project row and say the section can be created later with `/project-setup`. The reply names the category when it worked.
- `create-project-categories.js`: replace the `projectschema` body with a call to the same path for every project (what `/project-setup all:true` does), keeping the command name and description.
- `create-project-role.js`: create or reuse the role through the same helper, refusing a managed-role name.

- [ ] **Step 1: Failing tests** — `projects.js` add-flow calls the applier once with the created project and still replies success when it throws; `create-project-categories` walks every project; `create-project-role` refuses `Database`. All with fakes; no real db.
- [ ] **Step 2: Run, expect failures.** - [ ] **Step 3: Implement.** - [ ] **Step 4: Run** `npm test`. - [ ] **Step 5: Commit** — `feat(projects): a new project gets its section immediately`

---

### Task 11: Knowledge and state

Create `.claude/knowledge/project-sections.md`: the layout and names, the id-based repair, the rate-limit rule (one edit per channel carrying name and parent), the category cap and fallback, the role model and the managed-name refusal, project inference from a channel, what `/project-setup` does and how to preview it, and the backfill procedure. Index it in `.claude/knowledge/README.md`. Update `.claude/state/backlog.md` (deferred items from the reviews; archiving a finished project; the 12 orphan meeting channels), `completed.md` (dated 2026-09-18, "built and reviewed on a branch, not yet merged"), and rewrite `session.md`.

- [ ] Commit — `docs: per-project sections — knowledge and state`

---

## Verification after deploy (controller)

1. Merge and push; the deploy runs migration 019 and restarts. `pm2 logs` shows 44 commands.
2. `/project-setup project:Framework preview:true` — read the plan, confirm it names ten channels and the right task moves.
3. `/project-setup project:Framework` — check the category, the role, the members panel.
4. `/project-setup all:true` — the remaining eight projects and the other task channels.
5. `/create-task` a feature in Framework → the channel appears in the Framework category with a readable name. `/meeting-channel` inside a Framework channel → its channels land there. `/project-members add` → the panel updates and the person sees the section.

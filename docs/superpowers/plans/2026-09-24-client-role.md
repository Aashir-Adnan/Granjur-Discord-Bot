# Client Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `Client` role in the Discord bot: clients enter by invitation, are approved without ever receiving `Verified`, see only a global support pair plus a per-project support pair, raise issues and feature requests that become ordinary tasks they can follow, and are shut out of every other command by a deny-by-default gate.

**Architecture:** The isolation rule is "a client never receives `Verified`" — every existing channel and `Verified`-gated command is closed by construction. A global `Client` role gates a `🛟 Support` category; inside each project section two new channels carry one member overwrite per client row (`projectmember.role='client'`), repaired by `/project-setup` and never fed to the project role sync. Requests are `task` rows with `requestedBy` set, using the existing private task channel with the client as a member.

**Tech Stack:** Node 24 ESM, discord.js v14.25, mysql2 with the hand-rolled SQL layer in `bot/src/Database/index.js`, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-09-24-client-role-design.md`

## Global Constraints

- **Tests never touch production.** The root `.env` points at the live database. Every function under test takes `{ db, getConfig }` (and `update` where it writes config) seams and every test passes fakes. Run every suite invocation — including the first deliberately-failing one — as `DATABASE_URL=poisoned://no-production-access node --test <file>` (from `bot/`). See `.claude/rules/tests-never-touch-production.md`.
- **A client never receives `Verified`.** No code path in this plan adds `cfg.verifiedRoleId` to a member approved as a client.
- **Every permission overwrite carries an explicit `type`** — `OverwriteType.Role` for roles and `@everyone` (whose id is `guild.id`), `OverwriteType.Member` for people. Discord silently drops a mistyped overwrite.
- **Merge, never replace; presence-only; never `lockPermissions()`.** Per-member repairs use `permissionOverwrites.edit(id, allow, { type })` and `.delete(id)`, one id at a time, and check only whether an overwrite for that id exists.
- **`guildMember.findMany` caps at 25 rows unless `where.all === true`.**
- **Bind raw `Date` objects** for DATETIME columns in the bot (its pool has no `timezone` option).
- **Nothing time-related is ever posted into a client request's channel.** For a task with `requestedBy`, the `estimate` line is omitted from channel posts.
- **Names, verbatim:** role `Client`; category `🛟 Support`; channels `support` and `support-voice`; section keys `support` / `supportVoice` with suffixes `support` / `support-voice`; commands `report-issue`, `request-feature`, `my-requests`, `request-report`; `guildmember.kind` ∈ {`staff`, `client`}; task status `pending` is labelled **Waiting on you** to clients.
- **Commit messages** end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most likely to bite first. Each has a test pinned to its owning task.

1. **A `Client` role renamed by hand.** The gate must still refuse a client every non-client command when the role's *name* no longer matches — the stored id decides. (Task 2: "client by stored id, renamed role, still denied".)
2. **A client on zero projects raises a request.** No project → no `<slug>-support` channel → the notice must go to `#admin` and the task channel to the global Features/Bugs category, with nothing thrown. (Task 7: "no project: notice goes to the admin channel".)
3. **`/request-report` with another client's request id.** Must be refused with the same message as a non-existent id — no title leaks in the refusal. (Task 8: "another client's request is refused identically to a missing one".)
4. **A staff `@granjur.com` address invited with `client:true`.** `/verify` must treat the invite as authoritative and mark them `kind='client'` — the domain rule does not out-rank leadership's explicit choice. (Task 4: "an allowed-domain email with a client invite still verifies as a client".)
5. **`/project-setup` run when the roster read is truncated at 200.** Client-overwrite revokes must be suppressed exactly as role revokes are, or a client past the cap loses access. (Task 6b: "grantOnly suppresses client revokes".)

---

## File Structure

| File | Responsibility |
|---|---|
| `bot/src/Database/migrations/025_client_role.sql` | Six guarded column adds + one index |
| `bot/src/Database/index.js` | Column plumbing: `kind`, `requestedBy`, `pendinginvite.kind`, three `guildconfig` ids, `pendingInvite.findByEmail`, `PROJECT_MEMBER_ROLES` |
| `bot/src/constants.js` | `ROLE_CLIENT`, colour, support category/channel names, member kinds |
| `bot/src/config/command-config.json` | `clientCommands`, four `commandRoles` entries, four descriptions |
| `bot/src/config/commands.js` | `memberIsClient`, `getClientCommands`, deny-by-default in `canUseCommand` |
| `bot/src/commands/index.js` | Pass `clientRoleId` into the gate; register the two new command modules |
| `bot/src/services/clientManual.js` | `CLIENT_COMMANDS` descriptors and the pinned manual embed (leaf, no db import) |
| `bot/src/services/clientAccess.js` | `ensureClientRole`, `ensureSupportChannels`, `supportOverwrites` |
| `bot/src/utils/clientEmail.js` | `clientEmailAccess` — the two `/verify` acceptance paths |
| `bot/src/commands/invite.js`, `events/memberAdd.js`, `commands/verify.js` | Entry |
| `bot/src/services/approval.js` | `approveMember` — the one approval helper `/approve` and `/backlog` share |
| `bot/src/commands/approve.js`, `backlog.js`, `set-roles.js` | Approval UI changes and the client refusal |
| `bot/src/services/projectSection.js` | Two more `SECTIONS`, `clientAccess` in observe/plan/apply, `storedChannels` export |
| `bot/src/commands/project-setup.js`, `project-members.js`, `services/projectMembersPanel.js` | Roster filter, client role in the picker, per-client overwrite grant/revoke |
| `bot/src/services/clientRequest.js` | `createClientRequest` and its pure helpers |
| `bot/src/commands/client-request.js` | `/report-issue`, `/request-feature` (one module, `data` is an array) |
| `bot/src/utils/clientRequestView.js` | Pure view helpers: status label, timeline filter, list lines |
| `bot/src/commands/client-tracking.js` | `/my-requests`, `/request-report` |
| `bot/src/services/taskUpdateNotify.js` | `omit` option on `changeSummary`; requester DM on status change |
| `bot/src/services/dailyTimeReport.js`, `commands/init.js`, `commands/setup.js`, `commands/cleanup.js` | Exclusions and wiring |
| `.claude/knowledge/client-role.md` | How it all fits, for the next session |

Every command handler in this plan takes `{ db: dbArg = db, getConfig = getOrCreateGuildConfig }` as its second argument — the pattern `project-members.js` already uses — so it can be tested with fakes.

---

### Task 1: Migration 025, constants, and the data layer

**Files:**
- Create: `bot/src/Database/migrations/025_client_role.sql`
- Modify: `bot/src/constants.js` (after line 33, `ROLE_VERIFIED`; and `ROLE_COLORS` at 36-56)
- Modify: `bot/src/Database/index.js` — `updateGuildConfig` (44-), `guildMemberFindMany` (117-134), `guildMemberUpsert` (150-183), `guildMemberInsertSql` (185-203), `guildMemberUpdateSets` (205-216), `taskFindMany` (260-302), `taskInsertSql` (338-376), `pendingInviteCreate` (1458-1465), the `db.pendingInvite` object (2409-)
- Test: `bot/src/Database/clientRole.test.js`

**Interfaces:**
- Produces: constants `ROLE_CLIENT = 'Client'`, `CATEGORY_SUPPORT = '🛟 Support'`, `CHANNEL_SUPPORT = 'support'`, `CHANNEL_SUPPORT_VOICE = 'support-voice'`, `MEMBER_KIND_STAFF = 'staff'`, `MEMBER_KIND_CLIENT = 'client'`; `db.pendingInvite.findByEmail(guildConfigId, email) → rows`; `where.kind` on `guildMember.findMany`; `where.requestedBy` on `task.findMany`; `kind` accepted by `guildMember.upsert/update` and `pendingInvite.create`; `requestedBy` accepted by `task.create`; `updateGuildConfig` accepts `clientRoleId`, `supportChannelId`, `supportVoiceChannelId`.

- [ ] **Step 1: Write the failing tests**

`bot/src/Database/clientRole.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { taskInsertSql, guildMemberInsertSql, guildMemberUpdateSets } from './index.js'
import { ROLE_CLIENT, CATEGORY_SUPPORT, CHANNEL_SUPPORT, CHANNEL_SUPPORT_VOICE, ROLE_COLORS } from '../constants.js'

const here = path.dirname(fileURLToPath(import.meta.url))

test('migration 025 adds every column the client role needs, each behind an information_schema guard', () => {
  const sql = readFileSync(path.join(here, 'migrations', '025_client_role.sql'), 'utf8')
  for (const [table, column] of [
    ['guildconfig', 'clientRoleId'],
    ['guildconfig', 'supportChannelId'],
    ['guildconfig', 'supportVoiceChannelId'],
    ['guildmember', 'kind'],
    ['pendinginvite', 'kind'],
    ['task', 'requestedBy'],
  ]) {
    assert.match(sql, new RegExp(`TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`), `${table}.${column} guard`)
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN ${column} `), `${table}.${column} add`)
  }
  assert.match(sql, /INDEX_NAME = 'idx_task_requestedBy'/)
  assert.match(sql, /ADD INDEX idx_task_requestedBy \(requestedBy\)/)
})

test('task insert carries requestedBy, null by default', () => {
  const { sql, params } = taskInsertSql({ guildConfigId: 'g1', title: 'T' }, 'pk')
  const cols = sql.match(/\((.+?)\) VALUES/)[1].split(',').map((s) => s.trim())
  const at = cols.indexOf('requestedBy')
  assert.ok(at > -1, 'requestedBy column present')
  assert.equal(params[at], null)
  const req = taskInsertSql({ guildConfigId: 'g1', title: 'T', requestedBy: 'u9' }, 'pk')
  assert.equal(req.params[at], 'u9')
})

test('guildmember insert defaults kind to staff and honours client', () => {
  const a = guildMemberInsertSql({ id: 'm1', guildConfigId: 'g1', discordId: 'u1' })
  const cols = a.sql.match(/\((.+?)\) VALUES/)[1].split(',').map((s) => s.trim())
  const at = cols.indexOf('kind')
  assert.ok(at > -1)
  assert.equal(a.params[at], 'staff')
  const b = guildMemberInsertSql({ id: 'm1', guildConfigId: 'g1', discordId: 'u1', kind: 'client' })
  assert.equal(b.params[at], 'client')
})

test('guildmember update sets kind only when given', () => {
  assert.deepEqual(guildMemberUpdateSets({ status: 'approved' }).sets, ['status = ?'])
  const { sets, vals } = guildMemberUpdateSets({ status: 'approved', kind: 'client' })
  assert.deepEqual(sets, ['status = ?', 'kind = ?'])
  assert.deepEqual(vals, ['approved', 'client'])
})

test('the client constants are the names the spec fixes', () => {
  assert.equal(ROLE_CLIENT, 'Client')
  assert.equal(CATEGORY_SUPPORT, '🛟 Support')
  assert.equal(CHANNEL_SUPPORT, 'support')
  assert.equal(CHANNEL_SUPPORT_VOICE, 'support-voice')
  assert.equal(typeof ROLE_COLORS[ROLE_CLIENT], 'number')
})
```

- [ ] **Step 2: Run it to see it fail**

Run (from `bot/`): `DATABASE_URL=poisoned://no-production-access node --test src/Database/clientRole.test.js`
Expected: FAIL — `ENOENT` on the migration file, and `ROLE_CLIENT` is not exported.

- [ ] **Step 3: Write the migration**

`bot/src/Database/migrations/025_client_role.sql`:

```sql
-- The Client role: who is a client, which role and channels are theirs, and
-- which tasks they raised. Every ALTER is guarded so the file can run twice.
--
-- guildmember.kind is what the bot's own logic consults (the daily time report
-- lists "approved members" and must skip clients); the Discord role is what
-- Discord enforces. pendinginvite.kind is what /invite recorded, copied onto
-- the member row at join. task.requestedBy non-null means "a client raised it".

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildconfig' AND COLUMN_NAME = 'clientRoleId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildconfig ADD COLUMN clientRoleId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildconfig' AND COLUMN_NAME = 'supportChannelId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildconfig ADD COLUMN supportChannelId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildconfig' AND COLUMN_NAME = 'supportVoiceChannelId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildconfig ADD COLUMN supportVoiceChannelId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildmember' AND COLUMN_NAME = 'kind');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildmember ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT ''staff''', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pendinginvite' AND COLUMN_NAME = 'kind');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE pendinginvite ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT ''staff''', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND COLUMN_NAME = 'requestedBy');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE task ADD COLUMN requestedBy VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'task' AND INDEX_NAME = 'idx_task_requestedBy');
SET @sql = IF(@idx_exists = 0, 'ALTER TABLE task ADD INDEX idx_task_requestedBy (requestedBy)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

- [ ] **Step 4: Add the constants**

In `bot/src/constants.js`, directly after `export const ROLE_VERIFIED = 'Verified'`:

```js
/** The one role a client holds. Never in MANAGED_ROLES: it is mutually exclusive with all of them. */
export const ROLE_CLIENT = 'Client'
export const MEMBER_KIND_STAFF = 'staff'
export const MEMBER_KIND_CLIENT = 'client'

/** The global support pair — the only channels every client can see. */
export const CATEGORY_SUPPORT = '🛟 Support'
export const CHANNEL_SUPPORT = 'support'
export const CHANNEL_SUPPORT_VOICE = 'support-voice'
```

In `ROLE_COLORS`, after the `[ROLE_VERIFIED]` line:

```js
  [ROLE_CLIENT]: 0x00b0f4,    // sky blue — not a colour any staff role uses
```

- [ ] **Step 5: Plumb the columns through the data layer**

In `bot/src/Database/index.js`:

`updateGuildConfig` — after the `data.adminChannelId` block, add:

```js
  if (data.clientRoleId !== undefined) {
    sets.push("clientRoleId = ?");
    vals.push(data.clientRoleId);
  }
  if (data.supportChannelId !== undefined) {
    sets.push("supportChannelId = ?");
    vals.push(data.supportChannelId);
  }
  if (data.supportVoiceChannelId !== undefined) {
    sets.push("supportVoiceChannelId = ?");
    vals.push(data.supportVoiceChannelId);
  }
```

`guildMemberFindMany` — after the `where?.status` block:

```js
  if (where?.kind) {
    sql += " AND kind = ?";
    params.push(where.kind);
  }
```

`guildMemberUpsert` — inside the `guildMemberUpdateSets({...})` call in the existing-row branch, add `kind: update.kind,` after `avatarUrl: update.avatarUrl,`.

`guildMemberInsertSql` — add `["kind", data.kind ?? "staff"],` after the `avatarUrl` entry.

`guildMemberUpdateSets` — add `if (data.kind !== undefined) { sets.push("kind = ?"); vals.push(data.kind); }` after the `avatarUrl` line.

`taskFindMany` — after the `where?.createdBy` block:

```js
  if (where?.requestedBy) {
    sql += " AND requestedBy = ?";
    params.push(where.requestedBy);
  }
```

`taskInsertSql` — add `["requestedBy", data.requestedBy ?? null],` after the `["createdBy", ...]` entry.

`pendingInviteCreate` — replace the body:

```js
async function pendingInviteCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `pendinginvite` (id, guildConfigId, inviteCode, email, kind) VALUES (?, ?, ?, ?, ?)",
    [pk, data.guildConfigId, data.inviteCode, data.email, data.kind ?? "staff"],
  );
  return queryOne("SELECT * FROM `pendinginvite` WHERE id = ?", [pk]);
}

// Every unclaimed invite for one address, newest first: /verify uses this to
// let an invited client through the email domain rule.
async function pendingInviteFindByEmail(guildConfigId, email) {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e) return [];
  return query(
    "SELECT * FROM `pendinginvite` WHERE guildConfigId = ? AND LOWER(email) = ? ORDER BY createdAt DESC",
    [guildConfigId, e],
  );
}
```

In the `db` object, the `pendingInvite` entry becomes:

```js
  pendingInvite: {
    create: pendingInviteCreate,
    findByGuild: pendingInviteFindByGuild,
    findByEmail: pendingInviteFindByEmail,
    deleteByCode: pendingInviteDeleteByCode,
  },
```

- [ ] **Step 6: Run the test and the whole suite**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/Database/clientRole.test.js`
Expected: PASS (5 tests).
Run: `DATABASE_URL=poisoned://no-production-access npm test`
Expected: all green (1002 + 5).

- [ ] **Step 7: Commit**

```bash
git add bot/src/Database/migrations/025_client_role.sql bot/src/constants.js bot/src/Database/index.js bot/src/Database/clientRole.test.js
git commit -m "feat(client): migration 025 and data-layer plumbing for the client role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The deny-by-default command gate

**Files:**
- Modify: `bot/src/config/command-config.json` (top-level; `commandRoles`; `commandDescriptions`)
- Modify: `bot/src/config/commands.js:51-59`
- Modify: `bot/src/commands/index.js:203-216` (`handleCommand`)
- Test: `bot/src/config/clientGate.test.js`

**Interfaces:**
- Produces: `memberIsClient(member, clientRoleId = null) → boolean`; `getClientCommands() → string[]`; `canUseCommand(member, commandName, { clientRoleId } = {})`.
- Consumes: `ROLE_CLIENT` (Task 1).

- [ ] **Step 1: Write the failing test**

`bot/src/config/clientGate.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canUseCommand, getClientCommands, memberIsClient } from './commands.js'

// A member as canUseCommand sees one: roles as a Collection-like Map with
// `.some` and `.has`, permissions with `.has`, and a guild with an owner.
function member({ roles = [], owner = false, perms = [] } = {}) {
  const cache = new Map(roles.map((r) => [r.id, r]))
  cache.some = (fn) => [...cache.values()].some(fn)
  return {
    id: owner ? 'owner' : 'u1',
    guild: { ownerId: 'owner' },
    permissions: { has: (p) => perms.includes(p) },
    roles: { cache },
  }
}

const CLIENT = { id: 'r-client', name: 'Client' }
const VERIFIED = { id: 'r-verified', name: 'Verified' }

test('clientCommands is exactly the five the spec lists', () => {
  assert.deepEqual(getClientCommands(), ['verify', 'report-issue', 'request-feature', 'my-requests', 'request-report'])
})

test('a client may run only the client commands — an empty role list is not "anyone" for them', () => {
  const m = member({ roles: [CLIENT] })
  assert.equal(canUseCommand(m, 'my-requests'), true)
  assert.equal(canUseCommand(m, 'report-issue'), true)
  assert.equal(canUseCommand(m, 'close-feature'), false, 'close-feature has an empty role list')
  assert.equal(canUseCommand(m, 'time-report'), false)
  assert.equal(canUseCommand(m, 'no-such-command'), false, 'absent from the map is still denied')
})

test('a staff member is unaffected by the client rule', () => {
  const m = member({ roles: [VERIFIED] })
  assert.equal(canUseCommand(m, 'close-feature'), true)
  assert.equal(canUseCommand(m, 'my-requests'), false, 'client commands are gated on Client')
})

test('client by stored id, renamed role, still denied', () => {
  const renamed = { id: 'r-client', name: 'Customer' }
  const m = member({ roles: [renamed, VERIFIED] })
  assert.equal(memberIsClient(m, 'r-client'), true)
  assert.equal(canUseCommand(m, 'close-feature', { clientRoleId: 'r-client' }), false)
  // Without the id the name is all there is, and it no longer matches.
  assert.equal(memberIsClient(m), false)
})

test('the guild owner and Manage Server keep their bypass', () => {
  assert.equal(canUseCommand(member({ owner: true, roles: [CLIENT] }), 'init'), true)
  assert.equal(canUseCommand(member({ perms: ['ManageGuild'], roles: [CLIENT] }), 'init'), true)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/config/clientGate.test.js`
Expected: FAIL — `getClientCommands` is not exported.

- [ ] **Step 3: The config**

In `bot/src/config/command-config.json`, add a top-level key beside `commandRoles`:

```json
  "clientCommands": ["verify", "report-issue", "request-feature", "my-requests", "request-report"],
```

Inside `commandRoles`, add:

```json
    "report-issue": ["Client"],
    "request-feature": ["Client"],
    "my-requests": ["Client"],
    "request-report": ["Client"],
```

Inside `commandDescriptions`, add:

```json
    "report-issue": {
      "summary": "Report something that is broken in your project.",
      "syntax": "/report-issue title:<short title> details:<what happens> [project] [document] [document2] [document3]",
      "detail": "Opens a private channel for the issue where the team can ask you for more. Attach up to three documents."
    },
    "request-feature": {
      "summary": "Ask for something new in your project.",
      "syntax": "/request-feature title:<short title> details:<what you need> [project] [document] [document2] [document3]",
      "detail": "Opens a private channel for the request where the team can ask you for more. Attach up to three documents."
    },
    "my-requests": {
      "summary": "List the issues and requests you have raised, with their status.",
      "syntax": "/my-requests",
      "detail": "Shows each request, its status and a link to its channel. \"Waiting on you\" means the team needs something from you."
    },
    "request-report": {
      "summary": "A report on one of your requests: status, who is handling it, and its history.",
      "syntax": "/request-report request:<pick one>",
      "detail": "Start typing a title to pick the request."
    },
```

- [ ] **Step 4: The gate**

Replace `canUseCommand` in `bot/src/config/commands.js` (lines 50-59) with:

```js
import { ROLE_CLIENT } from '../constants.js'

/** The commands a client may run. Everything else is refused to them. */
export function getClientCommands() {
  const cfg = loadCommandConfig()
  return Array.isArray(cfg.clientCommands) ? cfg.clientCommands : []
}

/**
 * Whether a member is a client: by the stored role id when the caller has one
 * (survives the role being renamed by hand), else by the role's name.
 */
export function memberIsClient(member, clientRoleId = null) {
  const cache = member?.roles?.cache
  if (!cache?.some) return false
  if (clientRoleId && cache.has?.(clientRoleId)) return true
  return cache.some((r) => r?.name === ROLE_CLIENT)
}

/**
 * True if member can use the command. Guild owner and anyone with Manage
 * Server can use any command. A CLIENT may use only `clientCommands` — an
 * empty role list means "anyone" for staff, never for a client.
 */
export function canUseCommand(member, commandName, { clientRoleId = null } = {}) {
  if (!member?.guild) return false
  // Server manager: guild owner or has Manage Server (or Administrator)
  if (member.guild.ownerId === member.id) return true
  if (member.permissions.has?.('ManageGuild') || member.permissions.has?.('Administrator')) return true
  if (memberIsClient(member, clientRoleId)) return getClientCommands().includes(commandName)
  const roles = getCommandRoles(commandName)
  if (roles.length === 0) return true
  return member.roles.cache.some((r) => roles.includes(r.name))
}
```

(The `import` goes at the top of the file with the others.)

In `bot/src/commands/index.js`, add `import { getGuildConfig } from '../db/index.js'` to the imports, and in `handleCommand` replace the two lines from `const member = ...` through the `if (member && !canUseCommand(...))` opener with:

```js
  const member = interaction.guild?.members?.cache?.get(interaction.user.id) ?? await interaction.guild?.members?.fetch(interaction.user.id).catch(() => null)
  // The stored id lets the gate recognise a client whose role was renamed by
  // hand. A failed config read falls back to the role's name, never to "allow".
  const cfg = interaction.guild ? await getGuildConfig(interaction.guild.id).catch(() => null) : null
  if (member && !canUseCommand(member, interaction.commandName, { clientRoleId: cfg?.clientRoleId ?? null })) {
```

- [ ] **Step 5: Run the tests**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/config/clientGate.test.js src/config/commandGates.test.js`
Expected: PASS. (The double-gating test in `commandGates.test.js` still passes: the four new commands have role lists and no Discord permission.)

- [ ] **Step 6: Commit**

```bash
git add bot/src/config/command-config.json bot/src/config/commands.js bot/src/commands/index.js bot/src/config/clientGate.test.js
git commit -m "feat(client): deny-by-default command gate for client members

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The Client role, the global support pair, and the pinned manual

**Files:**
- Create: `bot/src/services/clientManual.js`
- Create: `bot/src/services/clientAccess.js`
- Test: `bot/src/services/clientManual.test.js`, `bot/src/services/clientAccess.test.js`

**Interfaces:**
- Produces: `CLIENT_COMMANDS` (array of `{ name, syntax, summary, example }`), `clientManual() → EmbedBuilder`, `MANUAL_TITLE`; `ensureClientRole(guild, cfg, { update }) → role`; `ensureSupportChannels(guild, cfg, { update, botUserId }) → { role, category, text, voice }`; `CLIENT_TEXT_ALLOW`, `CLIENT_VOICE_ALLOW` (permission arrays); `CLIENT_TEXT_ALLOW_OBJ`, `CLIENT_VOICE_ALLOW_OBJ` (the same as `{ ViewChannel: true, … }` objects for `permissionOverwrites.edit`).
- Consumes: Task 1 constants and `updateGuildConfig`; Task 2 `getClientCommands` (test only).

- [ ] **Step 1: Write the failing tests**

`bot/src/services/clientManual.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientManual, CLIENT_COMMANDS, MANUAL_TITLE } from './clientManual.js'
import { getClientCommands } from '../config/commands.js'

test('the manual names every client command except verify, so a new one cannot ship undocumented', () => {
  const json = clientManual().toJSON()
  const text = [json.title, json.description, ...(json.fields ?? []).flatMap((f) => [f.name, f.value])].join('\n')
  for (const name of getClientCommands().filter((n) => n !== 'verify')) {
    assert.match(text, new RegExp(`/${name}\\b`), `manual mentions /${name}`)
  }
  assert.equal(json.title, MANUAL_TITLE)
})

test('every descriptor is a command the gate allows, with syntax and an example', () => {
  const allowed = new Set(getClientCommands())
  for (const c of CLIENT_COMMANDS) {
    assert.ok(allowed.has(c.name), `${c.name} is in clientCommands`)
    assert.match(c.syntax, new RegExp(`^/${c.name}`))
    assert.ok(c.example.length > 0)
  }
})

test('the manual explains "Waiting on you" and that documents can be attached', () => {
  const json = clientManual().toJSON()
  const text = [json.description, ...(json.fields ?? []).map((f) => f.value)].join('\n')
  assert.match(text, /Waiting on you/)
  assert.match(text, /three documents/i)
})
```

`bot/src/services/clientAccess.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { ensureClientRole, ensureSupportChannels, supportOverwrites } from './clientAccess.js'
import { MANUAL_TITLE } from './clientManual.js'

let nextId = 100
function fakeChannel(name, { type = ChannelType.GuildText, parentId = null, overwrites = [], pinned = [] } = {}) {
  const cache = new Map(overwrites.map((o) => [o.id, o]))
  const ch = {
    id: String(nextId++), name, type, parentId, sent: [], edits: [],
    permissionOverwrites: {
      cache,
      edit: async (id, allow, opts) => { ch.edits.push({ id, allow, opts }); cache.set(id, { id, type: opts?.type }); return ch },
    },
    messages: { fetchPinned: async () => new Map(pinned.map((m, i) => [String(i), m])) },
    send: async (payload) => { const msg = { ...payload, pinned: false, pin: async () => { msg.pinned = true } }; ch.sent.push(msg); return msg },
  }
  return ch
}

function fakeGuild({ roles = [], channels = [] } = {}) {
  const roleCache = new Map(roles.map((r) => [r.id, r]))
  const channelCache = new Map(channels.map((c) => [c.id, c]))
  const guild = {
    id: 'g1',
    roles: {
      cache: roleCache,
      create: async ({ name }) => { const r = { id: `r${nextId++}`, name }; roleCache.set(r.id, r); return r },
    },
    channels: {
      cache: channelCache,
      create: async ({ name, type, parent = null, permissionOverwrites = [] }) => {
        const c = fakeChannel(name, { type, parentId: parent, overwrites: permissionOverwrites })
        channelCache.set(c.id, c)
        return c
      },
    },
  }
  return guild
}

const cfg = (over = {}) => ({ id: 'cfg1', verifiedRoleId: 'r-verified', clientRoleId: null, supportChannelId: null, supportVoiceChannelId: null, ...over })
const recorder = () => { const calls = []; return { calls, update: async (guildId, data) => { calls.push(data) } } }

test('supportOverwrites: @everyone denied, Client and Verified allowed, every entry typed', () => {
  const ows = supportOverwrites({ id: 'g1' }, { clientRoleId: 'rc', verifiedRoleId: 'rv', voice: true })
  assert.deepEqual(ows.map((o) => [o.id, o.type]), [['g1', OverwriteType.Role], ['rc', OverwriteType.Role], ['rv', OverwriteType.Role]])
  assert.deepEqual(ows[0].deny, [PermissionFlagsBits.ViewChannel])
  assert.ok(ows[1].allow.includes(PermissionFlagsBits.Connect))
  const text = supportOverwrites({ id: 'g1' }, { clientRoleId: 'rc', verifiedRoleId: 'rv', voice: false })
  assert.ok(!text[1].allow.includes(PermissionFlagsBits.Connect))
})

test('ensureClientRole creates the role once and stores its id', async () => {
  const guild = fakeGuild()
  const { calls, update } = recorder()
  const role = await ensureClientRole(guild, cfg(), { update })
  assert.equal(role.name, 'Client')
  assert.deepEqual(calls, [{ clientRoleId: role.id }])
  // Second call with the id stored: nothing created, nothing written.
  const again = await ensureClientRole(guild, cfg({ clientRoleId: role.id }), { update })
  assert.equal(again.id, role.id)
  assert.equal(calls.length, 1)
})

test('ensureClientRole adopts a same-named role only when no id is stored, and records it', async () => {
  const existing = { id: 'r-old', name: 'Client' }
  const guild = fakeGuild({ roles: [existing] })
  const { calls, update } = recorder()
  const role = await ensureClientRole(guild, cfg(), { update })
  assert.equal(role.id, 'r-old')
  assert.deepEqual(calls, [{ clientRoleId: 'r-old' }])
})

test('ensureSupportChannels builds the category and both channels, persists ids, pins the manual', async () => {
  const guild = fakeGuild()
  const { calls, update } = recorder()
  const out = await ensureSupportChannels(guild, cfg(), { update, botUserId: 'bot' })
  assert.equal(out.category.name, '🛟 Support')
  assert.equal(out.text.name, 'support')
  assert.equal(out.voice.name, 'support-voice')
  assert.equal(out.voice.type, ChannelType.GuildVoice)
  const last = calls.at(-1)
  assert.equal(last.supportChannelId, out.text.id)
  assert.equal(last.supportVoiceChannelId, out.voice.id)
  assert.equal(out.text.sent.length, 1)
  assert.equal(out.text.sent[0].embeds[0].toJSON().title, MANUAL_TITLE)
  assert.equal(out.text.sent[0].pinned, true)
})

test('ensureSupportChannels reuses stored ids, repairs only a missing overwrite, and does not re-post a pinned manual', async () => {
  const text = fakeChannel('support', {
    overwrites: [{ id: 'g1', type: OverwriteType.Role }, { id: 'r-verified', type: OverwriteType.Role }],
    pinned: [{ author: { id: 'bot' }, embeds: [{ title: MANUAL_TITLE }] }],
  })
  const voice = fakeChannel('support-voice', { type: ChannelType.GuildVoice, overwrites: [{ id: 'g1' }, { id: 'r-client' }, { id: 'r-verified' }] })
  const guild = fakeGuild({ roles: [{ id: 'r-client', name: 'Client' }], channels: [text, voice] })
  const { calls, update } = recorder()
  await ensureSupportChannels(guild, cfg({ clientRoleId: 'r-client', supportChannelId: text.id, supportVoiceChannelId: voice.id }), { update, botUserId: 'bot' })
  assert.deepEqual(text.edits.map((e) => e.id), ['r-client'], 'only the Client allow was missing on the text channel')
  assert.equal(text.edits[0].opts.type, OverwriteType.Role)
  assert.equal(voice.edits.length, 0)
  assert.equal(text.sent.length, 0, 'manual already pinned')
  assert.equal(calls.length, 0, 'nothing to persist')
})

test('a stored channel id that no longer resolves is recreated, never matched by name', async () => {
  const stray = fakeChannel('support') // same name, not ours (no id stored for it)
  const guild = fakeGuild({ roles: [{ id: 'r-client', name: 'Client' }], channels: [stray] })
  const { calls, update } = recorder()
  const out = await ensureSupportChannels(guild, cfg({ clientRoleId: 'r-client', supportChannelId: 'gone', supportVoiceChannelId: null }), { update, botUserId: 'bot' })
  assert.notEqual(out.text.id, stray.id)
  assert.equal(calls.at(-1).supportChannelId, out.text.id)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/services/clientManual.test.js src/services/clientAccess.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: The manual**

`bot/src/services/clientManual.js`:

```js
// The pinned manual in #support: the only place a client is ever told how the
// bot works, because they see no other channel. A leaf module on purpose — no
// db import — so the commands and the sign-in path can both use it.
import { EmbedBuilder } from 'discord.js'

export const MANUAL_TITLE = 'How to work with us here'

/**
 * One entry per client command. The manual is built from this list, and a test
 * checks it against `clientCommands` in command-config.json, so a command added
 * to one and not the other fails the suite.
 */
export const CLIENT_COMMANDS = [
  {
    name: 'report-issue',
    syntax: '/report-issue title:<short title> details:<what happens>',
    summary: 'Report something that is broken.',
    example: '/report-issue title:Login fails on mobile details:After entering the code the page reloads and I am signed out.',
  },
  {
    name: 'request-feature',
    syntax: '/request-feature title:<short title> details:<what you need>',
    summary: 'Ask for something new.',
    example: '/request-feature title:Export bookings to CSV details:We need a monthly export for accounts.',
  },
  {
    name: 'my-requests',
    syntax: '/my-requests',
    summary: 'See everything you have raised and where it stands.',
    example: '/my-requests',
  },
  {
    name: 'request-report',
    syntax: '/request-report request:<start typing a title>',
    summary: 'A full report on one request: status, who has it, and its history.',
    example: '/request-report request:Login fails on mobile',
  },
]

export function clientManual() {
  const embed = new EmbedBuilder()
    .setTitle(MANUAL_TITLE)
    .setDescription(
      'You can see this support channel and the support channels of your projects, and nothing else — ' +
      'so everything you need is here.\n\n' +
      'Use the commands below anywhere you can type. Replies are only visible to you.',
    )
    .setColor(0x00b0f4)
  for (const c of CLIENT_COMMANDS) {
    const extra = c.name === 'report-issue' || c.name === 'request-feature'
      ? ' You can attach up to three documents (`document`, `document2`, `document3`).'
      : ''
    embed.addFields({
      name: `/${c.name} — ${c.summary}`,
      value: `\`${c.syntax}\`${extra}\nExample: \`${c.example}\``,
    })
  }
  embed.addFields(
    {
      name: 'What happens after you raise a request',
      value: 'A private channel opens for it — only you and the team can see it. The team is told, and every status change is posted there and sent to you as a message.',
    },
    {
      name: '"Waiting on you"',
      value: 'A request marked **Waiting on you** means the team needs something from you. Answer in that request\'s channel.',
    },
  )
  return embed
}
```

- [ ] **Step 4: The access service**

`bot/src/services/clientAccess.js`:

```js
// The Client role and the global support pair: created on demand (the live
// server will never be re-inited), found by stored id first, repaired
// presence-only, one overwrite edit at a time — never a whole-array replace.
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { updateGuildConfig } from '../db/index.js'
import {
  ROLE_CLIENT, ROLE_COLORS, CATEGORY_SUPPORT, CHANNEL_SUPPORT, CHANNEL_SUPPORT_VOICE,
} from '../constants.js'
import { clientManual, MANUAL_TITLE } from './clientManual.js'

const F = PermissionFlagsBits
export const CLIENT_TEXT_ALLOW = [F.ViewChannel, F.SendMessages, F.ReadMessageHistory]
export const CLIENT_VOICE_ALLOW = [...CLIENT_TEXT_ALLOW, F.Connect, F.Speak, F.UseVAD, F.Stream]
/** The same sets as the `{ Flag: true }` objects `permissionOverwrites.edit` takes. */
export const CLIENT_TEXT_ALLOW_OBJ = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }
export const CLIENT_VOICE_ALLOW_OBJ = { ...CLIENT_TEXT_ALLOW_OBJ, Connect: true, Speak: true, UseVAD: true, Stream: true }

const REASON = 'Client support'

/** A role by stored id, else by name — the id wins so a hand-rename still resolves. */
function findRole(guild, id, name) {
  const cache = guild?.roles?.cache
  if (!cache) return null
  if (id && cache.get?.(id)) return cache.get(id)
  for (const role of cache.values()) if (role?.name === name) return role
  return null
}

export async function ensureClientRole(guild, cfg, { update = updateGuildConfig } = {}) {
  const existing = findRole(guild, cfg?.clientRoleId, ROLE_CLIENT)
  if (existing) {
    if (existing.id !== cfg?.clientRoleId) await update(guild.id, { clientRoleId: existing.id })
    return existing
  }
  const role = await guild.roles.create({ name: ROLE_CLIENT, color: ROLE_COLORS[ROLE_CLIENT] ?? 0x00b0f4, mentionable: false, reason: REASON })
  await update(guild.id, { clientRoleId: role.id })
  return role
}

/**
 * The overwrite set for a support channel or its category. `@everyone` is the
 * guild id and a ROLE; the wrong type makes Discord drop the entry silently.
 */
export function supportOverwrites(guild, { clientRoleId, verifiedRoleId, voice }) {
  const allow = voice ? CLIENT_VOICE_ALLOW : CLIENT_TEXT_ALLOW
  const out = [{ id: guild.id, type: OverwriteType.Role, deny: [F.ViewChannel] }]
  if (clientRoleId) out.push({ id: clientRoleId, type: OverwriteType.Role, allow })
  if (verifiedRoleId) out.push({ id: verifiedRoleId, type: OverwriteType.Role, allow })
  return out
}

/** A channel by stored id only. A stored id that no longer resolves is "missing", not "find it by name". */
function byStoredId(guild, id, type) {
  if (!id) return null
  const ch = guild.channels?.cache?.get?.(id) ?? null
  return ch && ch.type === type ? ch : null
}

/** Name fallback ONLY when nothing is stored: a bare `support` channel under our category. */
function byName(guild, name, type, categoryId) {
  for (const ch of guild.channels?.cache?.values?.() ?? []) {
    if (ch?.name === name && ch.type === type && (!categoryId || ch.parentId === categoryId)) return ch
  }
  return null
}

function findCategory(guild) {
  for (const ch of guild.channels?.cache?.values?.() ?? []) {
    if (ch?.type === ChannelType.GuildCategory && ch.name === CATEGORY_SUPPORT) return ch
  }
  return null
}

/** Presence-only repair: add whichever required ids the channel lacks, one edit each. */
async function repairOverwrites(channel, required) {
  const cache = channel?.permissionOverwrites?.cache
  if (!cache?.has) return
  for (const o of required) {
    if (cache.has(o.id)) continue
    const allow = Object.fromEntries((o.allow ?? []).map((bit) => [flagName(bit), true]))
    const deny = Object.fromEntries((o.deny ?? []).map((bit) => [flagName(bit), false]))
    await channel.permissionOverwrites.edit(o.id, { ...allow, ...deny }, { type: o.type, reason: REASON })
  }
}

const FLAG_NAMES = new Map(Object.entries(PermissionFlagsBits).map(([name, bit]) => [bit, name]))
const flagName = (bit) => FLAG_NAMES.get(bit)

async function ensureManualPinned(text, botUserId) {
  const pinned = await text.messages?.fetchPinned?.().catch(() => null)
  const have = pinned && [...pinned.values()].some((m) =>
    (!botUserId || m?.author?.id === botUserId) && (m?.embeds ?? []).some((e) => (e?.title ?? e?.data?.title) === MANUAL_TITLE))
  if (have) return
  const msg = await text.send({ embeds: [clientManual()] })
  await msg?.pin?.().catch(() => {})
}

/**
 * Idempotent. Creates whatever is missing, repairs whatever lacks an overwrite,
 * pins the manual if it is not pinned, and persists any id that changed.
 * @returns {Promise<{role: object, category: object, text: object, voice: object}>}
 */
export async function ensureSupportChannels(guild, cfg, { update = updateGuildConfig, botUserId = null } = {}) {
  const role = await ensureClientRole(guild, cfg, { update })
  const ids = { clientRoleId: role.id, verifiedRoleId: cfg?.verifiedRoleId ?? null }

  let text = byStoredId(guild, cfg?.supportChannelId, ChannelType.GuildText)
  let voice = byStoredId(guild, cfg?.supportVoiceChannelId, ChannelType.GuildVoice)
  let category = (text?.parentId && guild.channels.cache.get(text.parentId))
    || (voice?.parentId && guild.channels.cache.get(voice.parentId))
    || findCategory(guild)
  if (!category) {
    category = await guild.channels.create({
      name: CATEGORY_SUPPORT, type: ChannelType.GuildCategory,
      permissionOverwrites: supportOverwrites(guild, { ...ids, voice: true }), reason: REASON,
    })
  } else {
    await repairOverwrites(category, supportOverwrites(guild, { ...ids, voice: true }))
  }

  if (!text && !cfg?.supportChannelId) text = byName(guild, CHANNEL_SUPPORT, ChannelType.GuildText, category.id)
  if (!text) {
    text = await guild.channels.create({
      name: CHANNEL_SUPPORT, type: ChannelType.GuildText, parent: category.id,
      topic: 'Talk to the team here. The pinned message explains the commands you can use.',
      permissionOverwrites: supportOverwrites(guild, { ...ids, voice: false }), reason: REASON,
    })
  } else {
    await repairOverwrites(text, supportOverwrites(guild, { ...ids, voice: false }))
  }

  if (!voice && !cfg?.supportVoiceChannelId) voice = byName(guild, CHANNEL_SUPPORT_VOICE, ChannelType.GuildVoice, category.id)
  if (!voice) {
    voice = await guild.channels.create({
      name: CHANNEL_SUPPORT_VOICE, type: ChannelType.GuildVoice, parent: category.id,
      permissionOverwrites: supportOverwrites(guild, { ...ids, voice: true }), reason: REASON,
    })
  } else {
    await repairOverwrites(voice, supportOverwrites(guild, { ...ids, voice: true }))
  }

  await ensureManualPinned(text, botUserId)

  const changed = {}
  if (text.id !== cfg?.supportChannelId) changed.supportChannelId = text.id
  if (voice.id !== cfg?.supportVoiceChannelId) changed.supportVoiceChannelId = voice.id
  if (Object.keys(changed).length) await update(guild.id, changed)

  return { role, category, text, voice }
}
```

- [ ] **Step 5: Run the tests**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/services/clientManual.test.js src/services/clientAccess.test.js`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/clientManual.js bot/src/services/clientAccess.js bot/src/services/clientManual.test.js bot/src/services/clientAccess.test.js
git commit -m "feat(client): Client role, global support pair, and the pinned manual

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Entry — `/invite client:true`, member join, `/verify`

**Files:**
- Create: `bot/src/utils/clientEmail.js`
- Modify: `bot/src/commands/invite.js` (builder at 43-48; `execute` 50-84; `handleInviteModal` 111-; the `pendingInvite.create` call at ~169)
- Modify: `bot/src/events/memberAdd.js:9-20, 43-55`
- Modify: `bot/src/commands/verify.js` — `handleEmailModal` (151-), `handleOtpModal` (240-)
- Test: `bot/src/utils/clientEmail.test.js`, additions to `bot/src/commands/verify.test.js` and `bot/src/commands/invite.test.js`

**Interfaces:**
- Produces: `clientEmailAccess({ db, cfg, guildId, discordId, email }) → { allowed: boolean, claim: pendingInviteRow|null }`; `handleInviteModal(interaction, rawEmails, { client } = {})`; `handleEmailModal(interaction, { db, getConfig })`; `handleOtpModal(interaction, { code, db, getConfig })`.
- Consumes: `db.pendingInvite.findByEmail`, `kind` columns (Task 1).

- [ ] **Step 1: Write the failing tests**

`bot/src/utils/clientEmail.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientEmailAccess } from './clientEmail.js'

const fake = ({ me = null, invites = [] } = {}) => ({
  guildMember: { findUnique: async () => me },
  pendingInvite: { findByEmail: async (_cfgId, email) => invites.filter((r) => r.email === email) },
})
const cfg = { id: 'cfg1' }

test('a member row marked client with this email is allowed, nothing to claim', async () => {
  const db = fake({ me: { kind: 'client', email: 'Ali@Acme.com' } })
  assert.deepEqual(await clientEmailAccess({ db, cfg, guildId: 'g1', discordId: 'u1', email: 'ali@acme.com' }), { allowed: true, claim: null })
})

test('an unclaimed client invite for the email is allowed and returned to be claimed', async () => {
  const invite = { inviteCode: 'abc', email: 'ali@acme.com', kind: 'client' }
  const db = fake({ invites: [invite] })
  assert.deepEqual(await clientEmailAccess({ db, cfg, guildId: 'g1', discordId: 'u1', email: 'ALI@acme.com' }), { allowed: true, claim: invite })
})

test('a staff invite, a different email, or no row at all is not allowed', async () => {
  assert.deepEqual(await clientEmailAccess({ db: fake({ invites: [{ email: 'ali@acme.com', kind: 'staff' }] }), cfg, guildId: 'g1', discordId: 'u1', email: 'ali@acme.com' }), { allowed: false, claim: null })
  assert.deepEqual(await clientEmailAccess({ db: fake({ me: { kind: 'client', email: 'other@acme.com' } }), cfg, guildId: 'g1', discordId: 'u1', email: 'ali@acme.com' }), { allowed: false, claim: null })
  assert.deepEqual(await clientEmailAccess({ db: fake(), cfg, guildId: 'g1', discordId: 'u1', email: '' }), { allowed: false, claim: null })
})
```

Append to `bot/src/commands/verify.test.js`:

```js
// --- client entry ------------------------------------------------------------

function otpHarness({ email, me = null, invites = [] }) {
  const upserts = []
  const deleted = []
  const db = {
    verificationOtp: {
      findValidByCode: async () => ({ email }),
      delete: async () => {},
    },
    guildMember: {
      findUnique: async () => me,
      upsert: async (args) => { upserts.push(args); return { id: 'm1' } },
    },
    pendingInvite: {
      findByEmail: async (_cfgId, e) => invites.filter((r) => r.email === e),
      deleteByCode: async (_cfgId, code) => { deleted.push(code) },
    },
  }
  const ix = recordingInteraction({ guild: { id: 'g1', members: { fetch: async () => { throw new Error('offline') } } } })
  return { db, ix, upserts, deleted, getConfig: async () => ({ id: 'cfg1', holdingRoleId: null }) }
}

test('an invited client verifies with an outside email: the row is marked client and the invite is claimed', async () => {
  const h = otpHarness({ email: 'ali@acme.com', invites: [{ inviteCode: 'inv1', email: 'ali@acme.com', kind: 'client' }] })
  await handleOtpModal(h.ix, { code: '111111', db: h.db, getConfig: h.getConfig })
  assert.equal(h.upserts.length, 1)
  assert.equal(h.upserts[0].create.kind, 'client')
  assert.equal(h.upserts[0].update.kind, 'client')
  assert.equal(h.upserts[0].update.status, 'holding')
  assert.deepEqual(h.deleted, ['inv1'])
  assert.match(h.ix.replies.at(-1).content, /Verified/)
})

test('an allowed-domain email with a client invite still verifies as a client', async () => {
  const h = otpHarness({ email: 'sam@granjur.com', invites: [{ inviteCode: 'inv2', email: 'sam@granjur.com', kind: 'client' }] })
  await handleOtpModal(h.ix, { code: '111111', db: h.db, getConfig: h.getConfig })
  assert.equal(h.upserts[0].update.kind, 'client')
})

test('a staff email leaves kind alone', async () => {
  const h = otpHarness({ email: 'sam@granjur.com' })
  await handleOtpModal(h.ix, { code: '111111', db: h.db, getConfig: h.getConfig })
  assert.equal(h.upserts[0].update.kind, undefined)
  assert.equal(h.upserts[0].create.kind, undefined)
})
```

(`recordingInteraction` already exists at the top of that file and accepts overrides.)

Append to `bot/src/commands/invite.test.js` — first read the file's existing `recordingInteraction` and any db fake; then add:

```js
test('client:true writes kind=client on every pending invite and says so in the reply', async () => {
  const created = []
  const db = {
    pendingInvite: { create: async ({ data }) => { created.push(data); return data } },
  }
  const ix = recordingInteraction()
  ix.guild.channels = { fetch: async () => new Map([['c1', { id: 'c1', isTextBased: () => true, isThread: () => false }]]) }
  ix.guild.invites = { create: async () => ({ code: 'code1', url: 'https://discord.gg/code1' }) }
  ix.client = { users: { fetch: async () => null } }
  await handleInviteModal(ix, 'ali@acme.com', {
    client: true, db, getConfig: async () => ({ id: 'cfg1', onboardingChannelId: null }),
    sendEmail: async () => ({ ok: true }), findMemberByEmail: async () => null,
  })
  assert.equal(created.length, 1)
  assert.equal(created[0].kind, 'client')
  assert.match(JSON.stringify(ix.replies.at(-1)), /as clients/)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/utils/clientEmail.test.js src/commands/verify.test.js src/commands/invite.test.js`
Expected: FAIL — `clientEmail.js` missing; `handleOtpModal` ignores `getConfig` and `kind`; `handleInviteModal` ignores the third argument.

- [ ] **Step 3: The email helper**

`bot/src/utils/clientEmail.js`:

```js
// The two ways an email outside the allowed domains gets through /verify:
// the caller's own row already says client (the join matched the invite), or
// an unclaimed client invite names the email (the join did not match — the
// bot lacked Manage Server). Claiming the second is the caller's job; this
// only says which it was.
export async function clientEmailAccess({ db, cfg, guildId, discordId, email }) {
  const e = String(email ?? '').trim().toLowerCase()
  if (!e || !cfg?.id) return { allowed: false, claim: null }
  const me = await db.guildMember.findUnique({ where: { guildId_discordId: { guildId, discordId } } }).catch(() => null)
  if (me?.kind === 'client' && String(me.email ?? '').trim().toLowerCase() === e) return { allowed: true, claim: null }
  const rows = await db.pendingInvite.findByEmail(cfg.id, e).catch(() => [])
  const claim = (rows ?? []).find((r) => r?.kind === 'client') ?? null
  return claim ? { allowed: true, claim } : { allowed: false, claim: null }
}
```

- [ ] **Step 4: `/invite`**

In `bot/src/commands/invite.js`:

Builder — add after the `emails` option:

```js
  .addBooleanOption((o) =>
    o.setName('client').setDescription('Invite as a client: any email domain; they will see only the support channels').setRequired(false)
  )
```

`execute` — read the flag and carry it both ways:

```js
    const asClient = interaction.options.getBoolean('client') === true
    const emailsOpt = interaction.options.getString('emails')
    if (emailsOpt && emailsOpt.trim()) {
      return handleInviteModal(interaction, emailsOpt, { client: asClient })
    }
    // The modal path has no options; remember the flag for its submit.
    flowStore.clear(interaction.user.id, guild.id, 'invite')
    flowStore.set(interaction.user.id, guild.id, 'invite', { client: asClient })
```

(Add `import * as flowStore from '../flows/store.js'` if the file does not already import it.) Keep the rest of `execute` as is; the embed description gains one line when `asClient`: `'\n\n**These invites are for clients.**'`.

`handleInviteModal` — new signature and seams:

```js
export async function handleInviteModal(interaction, rawEmails = null, {
  client = null,
  db: dbArg = db,
  getConfig = getOrCreateGuildConfig,
  sendEmail: send = sendEmail,
  findMemberByEmail = guildMemberFindByEmail,
} = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Invalid.' }).catch(() => {})
  const asClient = client ?? Boolean(flowStore.get(interaction.user?.id, guild.id, 'invite')?.client)
```

Replace `getOrCreateGuildConfig(guild.id)` with `getConfig(guild.id)`, `db.pendingInvite.create` with `dbArg.pendingInvite.create({ data: { guildConfigId: cfg.id, inviteCode: invite.code, email, kind: asClient ? 'client' : 'staff' } })`, `sendEmail(` with `send(`, and `guildMemberFindByEmail(` with `findMemberByEmail(`. In the result lines, the sent line becomes:

```js
      lines.push(`**Invites sent (${sent.length})${asClient ? ' as clients' : ''}:** ${sent.map((e) => `\`${e}\``).join(', ')}`)
```

After the reply, `flowStore.clear(interaction.user?.id, guild.id, 'invite')`.

- [ ] **Step 5: Member join**

In `bot/src/events/memberAdd.js`, declare `let kind = null` beside `let email = null`; inside the matched-invite branch set `kind = row.kind === 'client' ? 'client' : 'staff'` next to `email = row.email`; and change the upsert to:

```js
    create: {
      guildId: guild.id,
      discordId: member.id,
      email: email ?? undefined,
      kind: kind ?? undefined,
      status: 'pending',
    },
    update: email ? { email, ...(kind ? { kind } : {}) } : {},
```

- [ ] **Step 6: `/verify`**

In `bot/src/commands/verify.js`, add `import { clientEmailAccess } from '../utils/clientEmail.js'`.

`handleEmailModal` — new signature `export async function handleEmailModal(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {})`. Replace the domain check with:

```js
  const cfgEarly = await getConfig(guild.id).catch(() => null)
  const access = cfgEarly ? await clientEmailAccess({ db: dbArg, cfg: cfgEarly, guildId: guild.id, discordId: interaction.user.id, email }) : { allowed: false }
  if (!isAllowedEmail(email) && !access.allowed) {
    return interaction.editReply({
      content: 'That email domain is not allowed. Use an allowed address (e.g. @granjur.com), or the address you were invited with.',
    }).catch(() => {})
  }
```

and use `dbArg` / `cfgEarly` for the rest of the function (replace `db.` with `dbArg.` and the later `getOrCreateGuildConfig(guild.id)` with `cfgEarly`).

`handleOtpModal` — signature `{ code: rawCode = null, db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}`; replace `const cfg = await getOrCreateGuildConfig(guild.id).catch(() => {})` with `const cfg = await getConfig(guild.id).catch(() => ({}))`, then before the upsert:

```js
    // An invited client's email is outside the allowed domains; the invite is
    // what lets them in, and it out-ranks the domain rule even for an address
    // that would have passed on its own.
    const access = await clientEmailAccess({ db: dbArg, cfg, guildId: guild.id, discordId: interaction.user.id, email })
    const kind = access.allowed ? 'client' : undefined
```

change the upsert's `create` to include `kind,` and `update` to `{ email: email ?? undefined, verifiedAt: new Date(), status: 'holding', kind }`, and after it:

```js
    if (access.claim?.inviteCode) await dbArg.pendingInvite.deleteByCode(cfg.id, access.claim.inviteCode).catch(() => {})
```

- [ ] **Step 7: Run the tests**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/utils/clientEmail.test.js src/commands/verify.test.js src/commands/invite.test.js`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add bot/src/utils/clientEmail.js bot/src/utils/clientEmail.test.js bot/src/commands/invite.js bot/src/commands/invite.test.js bot/src/events/memberAdd.js bot/src/commands/verify.js bot/src/commands/verify.test.js
git commit -m "feat(client): invite as client, carry kind through join, let invited clients verify

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Approval — one shared helper, `/approve`, `/backlog`, `/set-roles`

**Files:**
- Create: `bot/src/services/approval.js`
- Modify: `bot/src/commands/approve.js` (whole flow), `bot/src/commands/backlog.js` (holding list 55-60; `handleBacklogUserSelect` 93-151; `handleBacklogRoleSelect` 153-218; `handleBacklogApproveModal` 298-350), `bot/src/commands/set-roles.js` (`execute` 45-74, `handleMemberSelect` 76-87)
- Test: `bot/src/services/approval.test.js`

**Interfaces:**
- Produces: `approveMember({ guild, member, dbMember, cfg, roleNames, asClient, db, update, ensureClient }) → { asClient, assigned: string[], supportChannelId: string|null }`; `CLIENT_VALUE = '__client__'` (the select value both commands use).
- Consumes: `ensureSupportChannels` (Task 3), `memberIsClient` (Task 2), `ROLE_CLIENT`.

- [ ] **Step 1: Write the failing test**

`bot/src/services/approval.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approveMember } from './approval.js'

function harness({ kind = 'staff', roles = ['Verified', 'Holding', 'Senior Dev'] } = {}) {
  const added = []
  const removed = []
  const updates = []
  const guild = {
    id: 'g1',
    roles: { cache: new Map(roles.map((n, i) => [`r${i}`, { id: `r${i}`, name: n }])) },
  }
  const member = { roles: { add: async (r) => { added.push(r?.id ?? r) }, remove: async (r) => { removed.push(r?.id ?? r) } } }
  const db = { guildMember: { update: async (args) => { updates.push(args); return {} } } }
  const cfg = { id: 'cfg1', holdingRoleId: 'r1', verifiedRoleId: 'r0', clientRoleId: null }
  const ensureClient = async () => ({ role: { id: 'r-client', name: 'Client' }, text: { id: 'chan-support' } })
  return { guild, member, db, cfg, added, removed, updates, ensureClient, dbMember: { id: 'm1', roleIds: [], kind } }
}

test('client approval adds Client, removes Holding, never adds Verified, writes kind=client', async () => {
  const h = harness({ kind: 'client' })
  const out = await approveMember({ ...h, asClient: true, update: async () => {} })
  assert.deepEqual(h.added, ['r-client'])
  assert.deepEqual(h.removed, ['r1'])
  assert.ok(!h.added.includes('r0'), 'Verified must never be added to a client')
  assert.equal(h.updates[0].data.status, 'approved')
  assert.equal(h.updates[0].data.kind, 'client')
  assert.equal(out.supportChannelId, 'chan-support')
  assert.deepEqual(out.assigned, ['Client'])
})

test('staff approval is unchanged and writes kind=staff, never Client', async () => {
  const h = harness()
  const out = await approveMember({ ...h, roleNames: ['Senior Dev'], update: async () => {} })
  assert.deepEqual(h.added, ['r2', 'r0'], 'the picked role, then Verified')
  assert.deepEqual(h.removed, ['r1'])
  assert.equal(h.updates[0].data.kind, 'staff')
  assert.deepEqual(h.updates[0].data.roleIds, ['Senior Dev'])
  assert.deepEqual(out.assigned, ['Senior Dev'])
  assert.equal(out.asClient, false)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/services/approval.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: The helper**

`bot/src/services/approval.js`:

```js
// The one approval routine /approve and /backlog share, so the two cannot
// drift — which matters most for the one rule this file exists to hold: a
// client never receives Verified.
import db, { ensureStringArray, updateGuildConfig } from '../db/index.js'
import { ensureSupportChannels } from './clientAccess.js'
import { ROLE_CLIENT } from '../constants.js'

/** The select value both role pickers use for "approve as a client". */
export const CLIENT_VALUE = '__client__'

export async function approveMember({
  guild, member, dbMember, cfg,
  roleNames = [], asClient = false,
  db: dbArg = db, update = updateGuildConfig, ensureClient = ensureSupportChannels,
}) {
  if (asClient) {
    // Role and support pair on demand: the live server was never re-inited.
    const { role, text } = await ensureClient(guild, cfg, { update })
    await member.roles.add(role.id)
    if (cfg.holdingRoleId) await member.roles.remove(cfg.holdingRoleId).catch((e) => console.warn('[approval] Could not remove holding role:', e.message))
    await dbArg.guildMember.update({ where: { id: dbMember.id }, data: { status: 'approved', kind: 'client' } })
    return { asClient: true, assigned: [ROLE_CLIENT], supportChannelId: text?.id ?? null }
  }

  const assigned = []
  for (const name of roleNames || []) {
    if (name === CLIENT_VALUE) continue
    let role = null
    for (const r of guild.roles.cache.values()) if (r.name.toLowerCase() === String(name).toLowerCase()) { role = r; break }
    if (!role) continue
    try {
      await member.roles.add(role)
      assigned.push(role.name)
    } catch (_) {}
  }
  if (cfg.holdingRoleId) await member.roles.remove(cfg.holdingRoleId).catch((e) => console.warn('[approval] Could not remove holding role:', e.message))
  if (cfg.verifiedRoleId) {
    await member.roles.add(cfg.verifiedRoleId).catch((e) => console.error('[approval] Could not add verified role:', e.message))
  } else {
    console.warn('[approval] No verifiedRoleId configured — user will not see channels')
  }
  const existingRoleIds = ensureStringArray(dbMember.roleIds)
  await dbArg.guildMember.update({
    where: { id: dbMember.id },
    data: { status: 'approved', kind: 'staff', roleIds: [...new Set([...existingRoleIds, ...assigned])] },
  })
  return { asClient: false, assigned, supportChannelId: null }
}
```

Note: the test's `member.roles.add` receives a role object for a picked role and `cfg.verifiedRoleId` (a string) for Verified; the harness normalises with `r?.id ?? r`.

- [ ] **Step 4: `/approve`**

In `bot/src/commands/approve.js`:

- Imports: add `import { approveMember, CLIENT_VALUE } from '../services/approval.js'` and `import { ROLE_CLIENT } from '../constants.js'`.
- `execute`: the option label gains a suffix — `label: \`${mem?.user?.username || m.discordId}${m.kind === 'client' ? ' (client)' : ''}\``.
- `handleUserSelect`: after `const userId = interaction.values[0]`, read the row and branch:

```js
  const dbMember = await db.guildMember.findUnique({ where: { guildId_discordId: { guildId: guild.id, discordId: userId } } })
  const member = await guild.members.fetch(userId).catch(() => null)
  if (dbMember?.kind === 'client') {
    // An invited client: no staff roles to pick. Straight to the confirmation.
    flowStore.set(interaction.user.id, guild.id, 'approve', { ...state, step: 3, targetUserId: userId, roleNames: [], asClient: true })
    const embed = new EmbedBuilder()
      .setTitle('Confirm approval')
      .setDescription(`Approve **${member?.user?.tag || userId}** as a **client**? They will see only the support channels.`)
      .setColor(0x00b0f4)
      .setFooter({ text: 'Step 2 of 2' })
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('approve_confirm').setLabel('Approve as client').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('approve_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    )
    return interaction.editReply({ embeds: [embed], components: [row] })
  }
  flowStore.set(interaction.user.id, guild.id, 'approve', { ...state, step: 2, targetUserId: userId })
```

and the role options become `[{ label: ROLE_CLIENT, value: CLIENT_VALUE, description: 'A client: no staff roles, sees only the support channels' }, ...ROLE_OPTIONS.map(...)]` with `.setMaxValues(roleOptions.length)` unchanged.

- `handleRolesSelect`: after reading `roleNames`:

```js
  const asClient = roleNames.includes(CLIENT_VALUE)
  flowStore.set(interaction.user.id, guild.id, 'approve', { ...state, step: 3, roleNames: asClient ? [] : roleNames, asClient })
```

and the confirmation text: `asClient ? \`Approve **${tag}** as a **client**? Any staff roles you ticked are ignored — a client holds none.\` : <existing text>`.

- `handleConfirm`: replace everything from `const assigned = []` through the `db.guildMember.update(...)` call with:

```js
    const { asClient, assigned, supportChannelId } = await approveMember({
      guild, member, dbMember, cfg, roleNames: state.roleNames || [], asClient: Boolean(state.asClient),
    })
```

and the success embed: `asClient ? \`**${member.user.tag}** is approved as a **client**. They can now see ${supportChannelId ? \`<#${supportChannelId}>\` : 'the support channel'} and the support channels of any project you add them to with **/project-members add … role:Client**.\` : <existing text>`.

- [ ] **Step 5: `/backlog`**

In `bot/src/commands/backlog.js`:

- Imports: `import { approveMember, CLIENT_VALUE } from '../services/approval.js'` and `ROLE_CLIENT` from constants.
- Holding list line (in `execute`): `return \`**${i + 1}.** ${name}${m.kind === 'client' ? ' (client)' : ''} · ${email} · verified ${at}\``.
- `handleBacklogUserSelect`: after `flowStore.set(... { userId, displayName })`, branch:

```js
  if (dbMember.kind === 'client') {
    flowStore.set(interaction.user.id, guild.id, 'backlog_approve', { userId, displayName, selectedRoles: [], asClient: true })
    const embed = new EmbedBuilder()
      .setTitle(`Approve as client · ${displayName}`)
      .setDescription('This person was invited as a **client**. They get no staff roles and will see only the support channels. Click **Approve** to confirm.')
      .setColor(0x00b0f4)
      .setFooter({ text: 'Step 2 of 2' })
    const approveBtn = new ButtonBuilder().setCustomId(`backlog_approve_btn:${userId}`).setLabel('Approve as client').setStyle(ButtonStyle.Success)
    return interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(approveBtn)] }).catch(() => {})
  }
```

and for staff, build `options` with the client entry first: `const options = [{ label: ROLE_CLIENT, value: CLIENT_VALUE, description: 'A client: no staff roles, sees only the support channels' }, ...roles.slice(0, 23).map(...)]` (23, so the add-role entry still fits in 25).

- `handleBacklogRoleSelect`: `const asClient = selectedRoles.includes(CLIENT_VALUE)`; store `{ ...state, selectedRoles: asClient ? [] : selectedRoles, asClient }`; the embed's Selected line reads `Client` when `asClient`. The re-rendered options list gets the same client entry first (in this handler and in `handleBacklogAddRoleModal`).
- `handleBacklogApproveModal`: replace from `const assigned = []` through the `db.guildMember.update(...)` with `const { asClient, assigned, supportChannelId } = await approveMember({ guild, member, dbMember, cfg, roleNames, asClient: Boolean(state?.asClient) })`, and the embed description's roles line becomes `asClient ? \`**Approved as a client.** They can see ${supportChannelId ? \`<#${supportChannelId}>\` : 'the support channel'}.\` : \`**Roles assigned:** …\``; footer `asClient ? 'They see only the support channels.' : 'They now have server access.'`.

- [ ] **Step 6: `/set-roles` refuses clients**

In `bot/src/commands/set-roles.js`, import `memberIsClient` from `../config/commands.js`, and in both `execute` (after fetching `member` for `picked`) and `handleMemberSelect` (after fetching `member`):

```js
  if (memberIsClient(member, cfg?.clientRoleId)) {
    const msg = `**${member.displayName}** is a client and holds no staff roles. To make them staff, remove the **Client** role by hand and run **/approve**.`
    return interaction.editReply ? interaction.editReply({ content: msg, embeds: [], components: [] }) : interaction.update({ content: msg, embeds: [], components: [] }).catch(() => {})
  }
```

(`handleMemberSelect` has no `cfg` in scope — add `const cfg = await getOrCreateGuildConfig(guild.id)` before the check. In `execute`, use `interaction.editReply`; in `handleMemberSelect`, `interaction.update`.)

- [ ] **Step 7: Run the tests and the suite**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/services/approval.test.js`
Expected: PASS (2).
Run: `DATABASE_URL=poisoned://no-production-access npm test`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add bot/src/services/approval.js bot/src/services/approval.test.js bot/src/commands/approve.js bot/src/commands/backlog.js bot/src/commands/set-roles.js
git commit -m "feat(client): approve as client through one shared helper; set-roles leaves clients alone

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6a: Project sections — two support channels and per-client access

**Files:**
- Modify: `bot/src/services/projectSection.js` — `SECTIONS` (51-62), `observeProjectSection` signature and body (~772-935), `planProjectSection` (461-473), `applyProjectSection` step 3 (~1040-1100), `storedChannels` export (513)
- Modify: `bot/src/services/projectSection.test.js:35-59` (the two SECTIONS tests)
- Test: `bot/src/services/projectSectionClients.test.js`

**Interfaces:**
- Produces: `SECTIONS` has 12 entries ending `{ key: 'support', suffix: 'support', type: 'text' }, { key: 'supportVoice', suffix: 'support-voice', type: 'voice' }`; `CLIENT_SECTION_KEYS = ['support', 'supportVoice']`; `observeProjectSection(guild, project, tasks, { rolesFetched, claimedIds, clientIds })` returns `clientAccess: { [key]: { missing: string[], stale: string[] } }`; `planProjectSection(project, observed, { adoptRole, revokeClients = true })` returns `plan.clients = { wanted: string[], grant: [{ key, channelId, memberId }], revoke: [{ key, channelId, memberId }] }`; `applyProjectSection` result gains `clientGranted: string[]`, `clientRevoked: string[]`; `storedChannels(project)` exported.
- Consumes: `CLIENT_TEXT_ALLOW_OBJ`, `CLIENT_VOICE_ALLOW_OBJ` (Task 3).

- [ ] **Step 1: Update the two SECTIONS tests and write the new file**

In `projectSection.test.js`, change `assert.equal(SECTIONS.length, 10)` to `12` and append to the expected table:

```js
      ['support', 'support', 'text'],
      ['supportVoice', 'support-voice', 'voice'],
```

`bot/src/services/projectSectionClients.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, OverwriteType } from 'discord.js'
import { observeProjectSection, planProjectSection, applyProjectSection, CLIENT_SECTION_KEYS, storedChannels } from './projectSection.js'

const project = { id: 'p1', name: 'Framework', docsSlug: 'framework', discordCategoryId: 'cat', discordRoleId: 'role', discordChannels: { support: 'sup', supportVoice: 'supv' } }

function channel(id, name, { type = ChannelType.GuildText, parentId = 'cat', overwrites = [] } = {}) {
  const cache = new Map(overwrites.map((o) => [o.id, o]))
  const ch = {
    id, name, type, parentId, topic: null, edits: [], deletes: [],
    permissionOverwrites: {
      cache,
      edit: async (mid, allow, opts) => { ch.edits.push({ mid, allow, opts }); cache.set(mid, { id: mid, type: opts?.type }) },
      delete: async (mid) => { ch.deletes.push(mid); cache.delete(mid) },
    },
    edit: async () => ch,
  }
  return ch
}
const role = (id) => ({ id, type: OverwriteType.Role })
const member = (id) => ({ id, type: OverwriteType.Member })

function guildWith(channels) {
  const cache = new Map(channels.map((c) => [c.id, c]))
  return {
    id: 'g1',
    roles: { cache: new Map([['role', { id: 'role', name: 'Framework', members: new Map() }]]) },
    channels: { cache, create: async ({ name, type, parent }) => { const c = channel(`new-${name}`, name, { type, parentId: parent }); cache.set(c.id, c); return c } },
    members: { fetch: async () => new Map() },
  }
}

test('CLIENT_SECTION_KEYS and storedChannels are exported for the commands', () => {
  assert.deepEqual(CLIENT_SECTION_KEYS, ['support', 'supportVoice'])
  assert.deepEqual(storedChannels({ discordChannels: '{"support":"s"}' }), { support: 's' })
})

test('observe: a client without an overwrite is missing, a member overwrite that is not a client is stale', () => {
  const sup = channel('sup', 'framework-support', { overwrites: [role('g1'), role('role'), member('u-client-a'), member('u-gone')] })
  const supv = channel('supv', 'framework-support-voice', { type: ChannelType.GuildVoice, overwrites: [role('g1'), role('role')] })
  const cat = channel('cat', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, parentId: null })
  const observed = observeProjectSection(guildWith([cat, sup, supv]), project, [], { rolesFetched: true, clientIds: ['u-client-a', 'u-client-b'] })
  assert.deepEqual(observed.clientAccess.support, { missing: ['u-client-b'], stale: ['u-gone'] })
  assert.deepEqual(observed.clientAccess.supportVoice, { missing: ['u-client-a', 'u-client-b'], stale: [] })
})

test('plan: grants and revokes per channel; revokeClients:false suppresses revokes', () => {
  const observed = {
    roleId: 'role', roleCandidate: null, rolesFetched: true, categoryId: 'cat', categoryName: '📂 FRAMEWORK', categoryChannelCount: 12,
    channels: { support: { id: 'sup', name: 'framework-support', parentId: 'cat', overwriteIds: ['g1', 'role'] } },
    tasks: [], takenNames: new Set(),
    clientAccess: { support: { missing: ['u1'], stale: ['u9'] } },
    clientIds: ['u1'],
  }
  const plan = planProjectSection(project, observed, {})
  assert.deepEqual(plan.clients.grant, [{ key: 'support', channelId: 'sup', memberId: 'u1' }])
  assert.deepEqual(plan.clients.revoke, [{ key: 'support', channelId: 'sup', memberId: 'u9' }])
  assert.deepEqual(plan.clients.wanted, ['u1'])
  const grantOnly = planProjectSection(project, observed, { revokeClients: false })
  assert.deepEqual(grantOnly.clients.revoke, [])
})

test('apply: one typed member edit per grant, one delete per revoke, and a freshly created support channel gets every wanted client', async () => {
  const sup = channel('sup', 'framework-support', { overwrites: [role('g1'), role('role'), member('u9')] })
  const cat = channel('cat', '📂 FRAMEWORK', { type: ChannelType.GuildCategory, parentId: null })
  const guild = guildWith([cat, sup])
  const plan = {
    role: { action: 'reuse', id: 'role', name: 'Framework', gateRoleId: 'role' },
    category: { action: 'reuse', id: 'cat', name: '📂 FRAMEWORK' },
    channels: [
      { key: 'support', action: 'reuse', id: 'sup', name: 'framework-support', type: 'text' },
      { key: 'supportVoice', action: 'create', name: 'framework-support-voice', type: 'voice' },
    ],
    tasks: [], voice: { category: [], channels: [] }, warnings: [],
    clients: { wanted: ['u1'], grant: [{ key: 'support', channelId: 'sup', memberId: 'u1' }], revoke: [{ key: 'support', channelId: 'sup', memberId: 'u9' }] },
  }
  const result = await applyProjectSection(guild, project, plan, { db: { project: { update: async () => {} } } })
  assert.deepEqual(sup.edits.map((e) => [e.mid, e.opts.type]), [['u1', OverwriteType.Member]])
  assert.ok(sup.edits[0].allow.ViewChannel === true && sup.edits[0].allow.Connect === undefined, 'text allow on a text channel')
  assert.deepEqual(sup.deletes, ['u9'])
  const created = guild.channels.cache.get('new-framework-support-voice')
  assert.deepEqual(created.edits.map((e) => e.mid), ['u1'], 'a new support channel is granted to every wanted client')
  assert.equal(created.edits[0].allow.Connect, true)
  assert.deepEqual(result.clientGranted.sort(), ['framework-support', 'framework-support-voice'].sort())
  assert.deepEqual(result.clientRevoked, ['framework-support'])
})
```

- [ ] **Step 2: Run to see it fail**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/services/projectSectionClients.test.js src/services/projectSection.test.js`
Expected: FAIL — `CLIENT_SECTION_KEYS` not exported; SECTIONS length 10.

- [ ] **Step 3: SECTIONS, keys, and the export**

In `projectSection.js`:

```js
/** The twelve section channels, in creation order. */
export const SECTIONS = [
  … the existing ten, unchanged …
  { key: 'support', suffix: 'support', type: 'text' },
  { key: 'supportVoice', suffix: 'support-voice', type: 'voice' },
]

/** The two channels a project's clients can see. Access is a member overwrite per client row. */
export const CLIENT_SECTION_KEYS = ['support', 'supportVoice']
```

Change `function storedChannels(project)` to `export function storedChannels(project)`.

Add the import `import { CLIENT_TEXT_ALLOW_OBJ, CLIENT_VOICE_ALLOW_OBJ } from './clientAccess.js'` at the top. (`clientAccess.js` imports `db/index.js`; `projectSection.js` already does through `projectMembersPanel.js`, so this adds no new database import to a leaf.)

- [ ] **Step 4: Observe**

In `observeProjectSection`, destructure `clientIds = []` from `opts` beside `rolesFetched`. After the `channels` loop (before the `referenceCounts` block) add:

```js
  // Per support channel: which clients lack their member overwrite, and which
  // member overwrites belong to nobody who is still a client row. Null-safe:
  // an unreadable overwrite cache plans nothing, as everywhere else here.
  const wantedClients = [...new Set((clientIds || []).map(String).filter(Boolean))]
  const clientAccess = {}
  for (const key of CLIENT_SECTION_KEYS) {
    const seen = channels[key]
    if (!seen?.id || !Array.isArray(seen.overwriteIds)) continue
    const raw = byId.get(seen.id)
    const memberIds = valuesOf(raw?.permissionOverwrites?.cache)
      .filter((o) => o?.type === OverwriteType.Member)
      .map((o) => String(o.id))
    clientAccess[key] = {
      missing: wantedClients.filter((id) => !seen.overwriteIds.includes(id)),
      stale: memberIds.filter((id) => !wantedClients.includes(id)),
    }
  }
```

and add `clientAccess, clientIds: wantedClients,` to the returned object.

- [ ] **Step 5: Plan**

Add after `planChannels`:

```js
/**
 * Per-client access on the two support channels: a member overwrite per
 * client row. `revokeClients:false` is the twin of the role sync's grant-only
 * mode — a roster that could not be read in full must not take access away.
 */
function planClientAccess(observed, { revokeClients = true } = {}) {
  const wanted = observed?.clientIds ?? []
  const grant = []
  const revoke = []
  for (const key of CLIENT_SECTION_KEYS) {
    const channelId = observed?.channels?.[key]?.id
    const access = observed?.clientAccess?.[key]
    if (!channelId || !access) continue
    for (const memberId of access.missing ?? []) grant.push({ key, channelId, memberId })
    if (revokeClients) for (const memberId of access.stale ?? []) revoke.push({ key, channelId, memberId })
  }
  return { wanted, grant, revoke }
}
```

In `planProjectSection`, add `const clients = planClientAccess(observed, opts)` and return `{ role, category, channels, tasks, voice, clients, warnings }`.

- [ ] **Step 6: Apply**

In `applyProjectSection`, initialise `result.clientGranted = []` and `result.clientRevoked = []` where the other result arrays are set up. Add a helper above the function:

```js
const clientAllowFor = (key) => (key === 'supportVoice' ? CLIENT_VOICE_ALLOW_OBJ : CLIENT_TEXT_ALLOW_OBJ)

/** One typed edit per client; a failure is one warning, not a stopped run. */
async function grantClients(channel, key, memberIds, result) {
  for (const memberId of memberIds) {
    try {
      await channel.permissionOverwrites.edit(memberId, clientAllowFor(key), { type: OverwriteType.Member, reason: REASON })
      result.clientGranted.push(channel.name)
    } catch (e) {
      note(result.warnings, `client access on ${channel.name} for ${memberId}`, e)
    }
  }
}
```

Inside the step-3 loop's `create` branch, after `result.created.push(entry.name)` and before `continue`:

```js
          if (CLIENT_SECTION_KEYS.includes(entry.key) && plan?.clients?.wanted?.length) {
            await grantClients(channel, entry.key, plan.clients.wanted, result)
          }
```

After the step-3 loop (before step 4, the task channels), add:

```js
    // 3b. Per-client access on the support pair. Presence-only, one member at
    //     a time — never a whole-array replace that would drop hand-set entries.
    for (const g of plan?.clients?.grant ?? []) {
      const channel = resolved.get(g.key) ?? guild.channels.cache.get(g.channelId) ?? null
      if (!channel) continue
      await grantClients(channel, g.key, [g.memberId], result)
    }
    for (const r of plan?.clients?.revoke ?? []) {
      const channel = resolved.get(r.key) ?? guild.channels.cache.get(r.channelId) ?? null
      if (!channel) continue
      try {
        await channel.permissionOverwrites.delete(r.memberId, REASON)
        result.clientRevoked.push(channel.name)
        console.warn(`[projectSection] client access on "${channel.name}" removed from ${r.memberId}`)
      } catch (e) {
        note(result.warnings, `client access on ${channel.name} for ${r.memberId}`, e)
      }
    }
```

`result.clientGranted` in the test collapses duplicates only by channel name for a single grant each, so the assertion above holds as written.

- [ ] **Step 7: Run the tests**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/services/projectSectionClients.test.js src/services/projectSection.test.js src/commands/project-setup.test.js`
Expected: PASS. If a `project-setup.test.js` case counts section channels ("10 to create"), update its expected number to 12 and note it in the report.

- [ ] **Step 8: Commit**

```bash
git add bot/src/services/projectSection.js bot/src/services/projectSection.test.js bot/src/services/projectSectionClients.test.js bot/src/commands/project-setup.test.js
git commit -m "feat(client): support pair in every project section with per-client access repair

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6b: Roster filter, `/project-members role:client`, and the picker

**Files:**
- Modify: `bot/src/Database/index.js:1200` (`PROJECT_MEMBER_ROLES`)
- Modify: `bot/src/commands/project-setup.js` — the observe call (~521), the roster reads (540, 560, 630), `renderPlan` (183-), `renderResult` (223-)
- Modify: `bot/src/commands/project-members.js` — `ROLE_LABEL` (8-11), `changeRole` (109-131), `execute` add/remove (152-208)
- Modify: `bot/src/services/projectMembersPanel.js:22` (`ROLE_LABEL`)
- Test: `bot/src/commands/project-members.test.js` (update the six-roles test; add client cases), `bot/src/commands/project-setup.test.js` (roster helpers)

**Interfaces:**
- Produces: `staffOnly(rows)`, `clientIdsOf(rows)` exported from `project-setup.js`; `PROJECT_MEMBER_ROLES` includes `'client'`.
- Consumes: `CLIENT_SECTION_KEYS`, `storedChannels` (Task 6a); `CLIENT_TEXT_ALLOW_OBJ`, `CLIENT_VOICE_ALLOW_OBJ` (Task 3).

- [ ] **Step 1: Tests**

In `project-members.test.js`, rename the picker test to `'the role picker offers all seven roles with readable labels'` and append `['client', 'Client']` to its expected list. Then append:

```js
// --- clients ------------------------------------------------------------------

function clientHarness({ members = [] } = {}) {
  const edits = []
  const deletes = []
  const support = { id: 'sup', name: 'fw-support', permissionOverwrites: { cache: new Map(), edit: async (id, allow, opts) => { edits.push(['sup', id, opts?.type]) }, delete: async (id) => { deletes.push(['sup', id]) } } }
  const supportVoice = { id: 'supv', name: 'fw-support-voice', permissionOverwrites: { cache: new Map(), edit: async (id, allow, opts) => { edits.push(['supv', id, opts?.type, allow.Connect]) }, delete: async (id) => { deletes.push(['supv', id]) } } }
  const roleAdds = []
  const roleRemoves = []
  const guild = {
    id: 'g1',
    roles: { cache: new Map([['role1', { id: 'role1', name: 'Framework' }]]) },
    channels: { cache: new Map([['sup', support], ['supv', supportVoice]]) },
    members: { cache: new Map(), fetch: async (id) => ({ id, roles: { add: async (r) => { roleAdds.push(r) }, remove: async (r) => { roleRemoves.push(r) } } }) },
  }
  const project = { ...PROJECT, discordRoleId: 'role1', discordChannels: { support: 'sup', supportVoice: 'supv' } }
  const db = fakeDb({ project, members })
  return { guild, db, project, edits, deletes, roleAdds, roleRemoves }
}

test('adding a client grants the two support overwrites and never the project role', async () => {
  const h = clientHarness()
  const ix = fakeInteraction({ guild: h.guild, sub: 'add', user: { id: 'u-c', bot: false }, options: { role: 'client', project: 'proj1' } })
  await execute(ix, { db: h.db, getConfig: async () => ({ id: 'g1' }) })
  assert.deepEqual(h.edits, [['sup', 'u-c', OverwriteType.Member], ['supv', 'u-c', OverwriteType.Member, true]])
  assert.deepEqual(h.roleAdds, [])
  assert.match(ix.replies.at(-1).content, /support channels/)
})

test('removing a client revokes the two overwrites and leaves the role alone', async () => {
  const h = clientHarness({ members: [{ discordId: 'u-c', role: 'client' }] })
  const ix = fakeInteraction({ guild: h.guild, sub: 'remove', user: { id: 'u-c', bot: false }, options: { project: 'proj1' } })
  await execute(ix, { db: h.db, getConfig: async () => ({ id: 'g1' }) })
  assert.deepEqual(h.deletes, [['sup', 'u-c'], ['supv', 'u-c']])
  assert.deepEqual(h.roleRemoves, [])
})

test('changing a staff row to client revokes the role and grants access; the reverse undoes it', async () => {
  const h = clientHarness({ members: [{ discordId: 'u1', role: 'developer' }] })
  const ix = fakeInteraction({ guild: h.guild, sub: 'add', user: { id: 'u1', bot: false }, options: { role: 'client', project: 'proj1' } })
  await execute(ix, { db: h.db, getConfig: async () => ({ id: 'g1' }) })
  assert.deepEqual(h.roleRemoves, ['role1'])
  assert.equal(h.edits.length, 2)
})
```

`fakeInteraction` and `fakeDb` exist in that file — read them first and match their option-reading shape (`interaction.options.getUser('member')`, `getString('role')`, `getSubcommand()`). For the "remove" case the harness must return the removed row's prior role: make `fakeDb`'s `projectMember.findByProject` return `members` **before** the remove and `[]` after (a `removed` flag flipped inside `remove`).

Append to `project-setup.test.js`:

```js
import { staffOnly, clientIdsOf } from './project-setup.js'

test('the role-sync roster never contains a client row; clientIdsOf is the complement', () => {
  const rows = [{ discordId: 'a', role: 'lead' }, { discordId: 'c', role: 'client' }, { discordId: 'b', role: 'qa' }]
  assert.deepEqual(staffOnly(rows).map((m) => m.discordId), ['a', 'b'])
  assert.deepEqual(clientIdsOf(rows), ['c'])
  assert.deepEqual(staffOnly(null), [])
})
```

(Merge the import into the file's existing import from `./project-setup.js`.)

- [ ] **Step 2: Run to see them fail**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/commands/project-members.test.js src/commands/project-setup.test.js`
Expected: FAIL — six vs seven roles; `staffOnly` not exported.

- [ ] **Step 3: The role list and labels**

`bot/src/Database/index.js:1200`: `export const PROJECT_MEMBER_ROLES = ["lead", "developer", "backend_developer", "frontend_developer", "qa", "design", "client"];`

`project-members.js` `ROLE_LABEL` and `projectMembersPanel.js` `ROLE_LABEL`: add `client: 'Client',`.

- [ ] **Step 4: `/project-members` grants access instead of the role**

In `project-members.js`, add imports `import { CLIENT_SECTION_KEYS, storedChannels } from '../services/projectSection.js'` (extend the existing import) and `import { CLIENT_TEXT_ALLOW_OBJ, CLIENT_VOICE_ALLOW_OBJ } from '../services/clientAccess.js'`, plus `OverwriteType` from discord.js. Add below `changeRole`:

```js
/**
 * Grant or revoke ONE client's member overwrite on the project's two support
 * channels. Never the project role: that opens all twelve channels. Returns the
 * sentence the reply should carry.
 */
async function changeClientAccess(guild, project, userId, action) {
  const stored = storedChannels(project)
  const targets = CLIENT_SECTION_KEYS.map((key) => [key, stored[key] ? guild.channels?.cache?.get?.(stored[key]) ?? null : null])
  if (targets.every(([, ch]) => !ch)) {
    return 'This project has no support channels yet, so no channel access changed. Run `/project-setup` to add them.'
  }
  const failed = []
  for (const [key, channel] of targets) {
    if (!channel) continue
    try {
      if (action === 'grant') {
        const allow = key === 'supportVoice' ? CLIENT_VOICE_ALLOW_OBJ : CLIENT_TEXT_ALLOW_OBJ
        await channel.permissionOverwrites.edit(userId, allow, { type: OverwriteType.Member, reason: 'Project client' })
      } else {
        await channel.permissionOverwrites.delete(userId, 'Project client')
      }
    } catch (e) {
      failed.push(`${channel.name} (${e?.message || e})`)
    }
  }
  if (failed.length) {
    console.warn(`[project-members] client access ${action} on "${project.name}" (${userId}) failed: ${failed.join('; ')}`)
    return action === 'grant'
      ? `The membership is saved, but I could not open ${failed.join(', ')} to them.`
      : `They are off the project, but I could not close ${failed.join(', ')} to them.`
  }
  return action === 'grant' ? 'They can now see this project\'s support channels.' : 'Their access to this project\'s support channels was taken away.'
}
```

In `execute`'s `add` branch, replace `lines.push(await changeRole(guild, project, user.id, 'grant'))` with:

```js
    const prior = before?.find((m) => m.discordId === user.id) ?? null
    if (role === 'client') {
      if (prior && prior.role !== 'client') lines.push(await changeRole(guild, project, user.id, 'revoke'))
      lines.push(await changeClientAccess(guild, project, user.id, 'grant'))
    } else {
      if (prior?.role === 'client') lines.push(await changeClientAccess(guild, project, user.id, 'revoke'))
      lines.push(await changeRole(guild, project, user.id, 'grant'))
    }
```

(and delete the later duplicate `const prior = …` line inside the `if (roster)` block, reusing this one).

In the `remove` branch, read the roster **before** the delete — `const before = await readRoster(dbArg, project)` as the first line — and replace `else lines.push(await changeRole(guild, project, user.id, 'revoke'))` with:

```js
    else if (before?.find((m) => m.discordId === user.id)?.role === 'client') lines.push(await changeClientAccess(guild, project, user.id, 'revoke'))
    else lines.push(await changeRole(guild, project, user.id, 'revoke'))
```

- [ ] **Step 5: `/project-setup` filters the roster and plans client access**

In `project-setup.js`, add near the other small helpers:

```js
/** The roster the ROLE sync may see: never a client row — the role opens every channel. */
export const staffOnly = (rows) => (rows ?? []).filter((m) => m?.role !== 'client')
/** The clients of a project, for the support-channel overwrites. */
export const clientIdsOf = (rows) => (rows ?? []).filter((m) => m?.role === 'client').map((m) => String(m.discordId))
```

Move the roster read **above** the observe call so both preview and run have it (the read at ~540 moves up; keep its comment):

```js
  const rosterRows = (await dbArg.projectMember.findByProject({ where: { projectId: project.id } })) ?? []
  const revokeClients = !fetchFailure && rosterRows.length < ROSTER_LIMIT
  const observed = observeProjectSection(guild, project, tasks, { rolesFetched, claimedIds, clientIds: clientIdsOf(rosterRows) })
  const plan = planProjectSection(project, observed, { adoptRole, revokeClients })
```

Then `const members = staffOnly(rosterRows)` where `members` was read before; the pre-sync re-read becomes `roster = staffOnly((await dbArg.projectMember.findByProject(...)) ?? [])` with `roster = members` on failure as now; `truncatedRoster` compares `rosterRows.length >= ROSTER_LIMIT`. In `adoptionPreview`, wrap the read: `roster = staffOnly(...)`.

`renderPlan`: after the voice line, add:

```js
  const clients = plan?.clients ?? { grant: [], revoke: [] }
  if (clients.grant.length || clients.revoke.length) {
    lines.push(`Clients: ${clients.grant.length} support-channel access grant(s), ${clients.revoke.length} revoke(s).`)
  }
```

`renderResult`: after the `voiceFixed` block:

```js
  const cg = result?.clientGranted ?? []
  const cr = result?.clientRevoked ?? []
  if (cg.length || cr.length) lines.push(`Clients: opened ${cg.length} support channel(s), closed ${cr.length}.`)
```

(Read the two renderers' local variable names first — they may accumulate into `parts` rather than `lines`; match whichever they use.)

- [ ] **Step 6: Run the tests and the suite**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/commands/project-members.test.js src/commands/project-setup.test.js`
Expected: PASS.
Run: `DATABASE_URL=poisoned://no-production-access npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add bot/src/Database/index.js bot/src/commands/project-setup.js bot/src/commands/project-setup.test.js bot/src/commands/project-members.js bot/src/commands/project-members.test.js bot/src/services/projectMembersPanel.js
git commit -m "feat(client): client project members get support access, never the project role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Raising a request — `/report-issue`, `/request-feature`

**Files:**
- Create: `bot/src/services/clientRequest.js`
- Create: `bot/src/commands/client-request.js`
- Modify: `bot/src/commands/index.js` (import + `commandModules`)
- Test: `bot/src/services/clientRequest.test.js`, `bot/src/commands/client-request.test.js`

**Interfaces:**
- Produces: `createClientRequest({ guild, user, cfg, type, title, details, project, attachments, db, createChannel, dm, nameFor }) → { task, channel, fellBack, noticedIn }`; pure `clientProjects(rows)`, `requestDescription(name, details)`, `attachmentPlan(attachments, limit)`, `MAX_UPLOAD_BYTES`; command module `data: [reportIssue, requestFeature]`, `execute(interaction, deps)`, `autocomplete(interaction, deps)`.
- Consumes: `createTaskTicketChannel`, `dmTaskAssignees`, `storedChannels`, `task.requestedBy` column.

- [ ] **Step 1: Tests**

`bot/src/services/clientRequest.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachmentPlan, clientProjects, createClientRequest, requestDescription, MAX_UPLOAD_BYTES } from './clientRequest.js'

test('clientProjects keeps only client rows', () => {
  assert.deepEqual(clientProjects([{ projectId: 'a', role: 'client' }, { projectId: 'b', role: 'lead' }]).map((r) => r.projectId), ['a'])
})

test('requestDescription leads with the client notice', () => {
  assert.equal(requestDescription('Ali', 'It breaks'), 'Client request — Ali can read this channel.\n\nIt breaks')
})

test('attachmentPlan re-uploads what fits and links what does not', () => {
  const small = { url: 'https://cdn/x.pdf', name: 'x.pdf', size: 10 }
  const big = { url: 'https://cdn/big.zip', name: 'big.zip', size: MAX_UPLOAD_BYTES + 1 }
  assert.deepEqual(attachmentPlan([small, big, null]), {
    files: [{ attachment: 'https://cdn/x.pdf', name: 'x.pdf' }],
    links: [{ name: 'big.zip', url: 'https://cdn/big.zip' }],
  })
})

function harness({ project = null, leads = [] } = {}) {
  const created = []
  const sent = { support: [], admin: [] }
  const dms = []
  const supportChannel = { id: 'sup', send: async (p) => { sent.support.push(p) } }
  const adminChannel = { id: 'admin', send: async (p) => { sent.admin.push(p) } }
  const guild = {
    id: 'g1',
    channels: { cache: new Map([['sup', supportChannel], ['admin', adminChannel]]), fetch: async (id) => (id === 'admin' ? adminChannel : null) },
    members: { cache: new Map([['u-c', { displayName: 'Ali' }]]) },
  }
  const channelSends = []
  const pinned = []
  const channel = {
    id: 'req-chan', name: 'bug-login-fails',
    send: async (p) => { channelSends.push(p); return { pin: async () => {} } },
    messages: { fetch: async () => new Map([['m1', { pin: async () => { pinned.push('m1') } }]]) },
  }
  const db = {
    task: {
      create: async ({ data }) => { created.push(data); return { id: 't1', ...data } },
      update: async () => ({}),
    },
    ticketDoc: { create: async () => ({}) },
    projectMember: { findByProject: async () => leads.map((id) => ({ discordId: id, role: 'lead' })) },
  }
  const createChannel = async (_guild, opts) => { createChannel.opts = opts; return { channel, fellBack: null } }
  const dm = async (_client, ids) => { dms.push(...ids); return ids.length }
  return { guild, db, created, sent, dms, channelSends, pinned, createChannel, dm, project,
    cfg: { id: 'cfg1', adminChannelId: 'admin' }, user: { id: 'u-c', username: 'ali' } }
}

test('a request becomes a task with requestedBy, a channel with the client in it, re-posted files, and a project notice', async () => {
  const h = harness({ project: { id: 'p1', name: 'Framework', discordChannels: { support: 'sup' } }, leads: ['lead1'] })
  const out = await createClientRequest({
    guild: h.guild, user: h.user, cfg: h.cfg, type: 'bug', title: 'Login fails', details: 'After the code, it reloads.',
    project: h.project, attachments: [{ url: 'https://cdn/x.png', name: 'x.png', size: 5 }],
    db: h.db, createChannel: h.createChannel, dm: h.dm, client: {},
  })
  const row = h.created[0]
  assert.equal(row.requestedBy, 'u-c')
  assert.equal(row.createdBy, 'u-c')
  assert.equal(row.type, 'bug'); assert.equal(row.is_bug, 1); assert.equal(row.is_feature, 0)
  assert.equal(row.status, 'open'); assert.equal(row.projectId, 'p1'); assert.equal(row.projectName, 'Framework')
  assert.deepEqual(row.assigneeIds, []); assert.equal(row.estimateMinutes, undefined)
  assert.deepEqual(h.createChannel.opts.memberIds, ['u-c'])
  assert.equal(h.createChannel.opts.project, h.project)
  assert.match(h.createChannel.opts.description, /^Client request — Ali can read this channel\./)
  assert.equal(h.createChannel.opts.closeHint, null)
  assert.deepEqual(h.pinned, ['m1'])
  assert.deepEqual(h.channelSends[0].files, [{ attachment: 'https://cdn/x.png', name: 'x.png' }])
  assert.equal(h.sent.support.length, 1)
  assert.match(h.sent.support[0].content, /New request from \*\*Ali\*\*: \*\*Login fails\*\* → <#req-chan>/)
  assert.deepEqual(h.dms, ['lead1'])
  assert.equal(out.noticedIn, 'sup')
})

test('no project: notice goes to the admin channel, nobody is DMed, the channel falls back globally', async () => {
  const h = harness()
  const out = await createClientRequest({
    guild: h.guild, user: h.user, cfg: h.cfg, type: 'feature', title: 'Export', details: 'CSV please',
    project: null, attachments: [], db: h.db, createChannel: h.createChannel, dm: h.dm, client: {},
  })
  assert.equal(h.created[0].projectId, null)
  assert.equal(h.created[0].is_feature, 1)
  assert.equal(h.createChannel.opts.project, null)
  assert.equal(h.sent.admin.length, 1)
  assert.equal(h.sent.support.length, 0)
  assert.deepEqual(h.dms, [])
  assert.equal(out.noticedIn, 'admin')
  assert.equal(h.channelSends.length, 0, 'no attachments, no second message')
})
```

`bot/src/commands/client-request.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { data, execute, autocomplete, resolveProject } from './client-request.js'

test('two builders, the spec\'s names and options', () => {
  assert.deepEqual(data.map((b) => b.name), ['report-issue', 'request-feature'])
  for (const b of data) {
    const names = b.toJSON().options.map((o) => o.name)
    assert.deepEqual(names, ['title', 'details', 'project', 'document', 'document2', 'document3'])
    assert.equal(b.toJSON().options.find((o) => o.name === 'project').autocomplete, true)
  }
})

test('resolveProject: one client project is used silently; several need a pick; none is null; a foreign id is refused', () => {
  const rows = [{ projectId: 'a', role: 'client' }, { projectId: 'b', role: 'client' }]
  const projects = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'z', name: 'Z' }]
  assert.deepEqual(resolveProject({ rows: rows.slice(0, 1), projects, picked: null }), { project: projects[0], error: null })
  assert.equal(resolveProject({ rows, projects, picked: null }).error, 'pick')
  assert.deepEqual(resolveProject({ rows: [], projects, picked: null }), { project: null, error: null })
  assert.equal(resolveProject({ rows, projects, picked: 'z' }).error, 'foreign')
  assert.deepEqual(resolveProject({ rows, projects, picked: 'b' }), { project: projects[1], error: null })
})

test('execute refuses a project the caller is not a client on, without creating anything', async () => {
  let created = false
  const ix = {
    guild: { id: 'g1' }, user: { id: 'u-c' }, commandName: 'report-issue', replies: [],
    options: { getString: (n) => ({ title: 'T', details: 'D', project: 'z' })[n] ?? null, getAttachment: () => null },
    editReply: async (p) => { ix.replies.push(p) },
  }
  await execute(ix, {
    db: {
      projectMember: { findByMember: async () => [{ projectId: 'a', role: 'client' }] },
      project: { findMany: async () => [{ id: 'a', name: 'A' }, { id: 'z', name: 'Z' }] },
    },
    getConfig: async () => ({ id: 'cfg1' }),
    create: async () => { created = true },
  })
  assert.equal(created, false)
  assert.match(ix.replies[0].content, /not a client on that project/i)
})
```

- [ ] **Step 2: Run to see them fail**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/services/clientRequest.test.js src/commands/client-request.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: The service**

`bot/src/services/clientRequest.js`:

```js
// A client's issue or feature request: an ordinary task row with `requestedBy`
// set, the existing private task channel with the client in it, the client's
// documents re-uploaded there (Discord CDN links expire), and a notice to the
// team. Every Discord side effect after the row is best-effort — the row is
// the request; the rest is how people hear about it.
import db from '../db/index.js'
import { createTaskTicketChannel, dmTaskAssignees } from './taskTicketChannel.js'
import { storedChannels } from './projectSection.js'

/** Discord's upload cap for a bot without boosts. Bigger files are linked, not copied. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

export function clientProjects(rows) {
  return (rows ?? []).filter((r) => r?.role === 'client')
}

/** The channel's opening line: no developer should be surprised who can read it. */
export function requestDescription(name, details) {
  return `Client request — ${name} can read this channel.\n\n${String(details ?? '').trim()}`
}

/** What to re-upload and what to merely link. Pure. */
export function attachmentPlan(attachments, limit = MAX_UPLOAD_BYTES) {
  const files = []
  const links = []
  for (const a of attachments ?? []) {
    if (!a?.url) continue
    const name = a.name || 'document'
    if (Number(a.size ?? 0) > limit) links.push({ name, url: a.url })
    else files.push({ attachment: a.url, name })
  }
  return { files, links }
}

const displayName = (guild, user) =>
  guild?.members?.cache?.get?.(user.id)?.displayName ?? user.globalName ?? user.username ?? user.id

export async function createClientRequest({
  guild, client, user, cfg, type, title, details, project = null, attachments = [],
  db: dbArg = db, createChannel = createTaskTicketChannel, dm = dmTaskAssignees,
}) {
  const isBug = type === 'bug'
  const name = displayName(guild, user)

  const task = await dbArg.task.create({
    data: {
      guildConfigId: cfg.id,
      type: isBug ? 'bug' : 'feature',
      is_bug: isBug ? 1 : 0,
      is_feature: isBug ? 0 : 1,
      title: String(title).trim().slice(0, 200),
      description: String(details).trim(),
      status: 'open',
      createdBy: user.id,
      requestedBy: user.id,
      assigneeIds: [],
      taggedMemberIds: [],
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      modules: [],
    },
  })
  await dbArg.ticketDoc.create({
    data: { guildConfigId: cfg.id, ticketType: isBug ? 'bug' : 'feature', taskId: task.id, title: task.title?.slice(0, 512) || 'Request', content: null },
  }).catch(() => {})

  const { channel, fellBack } = await createChannel(guild, {
    taskId: task.id,
    title: task.title,
    description: requestDescription(name, details),
    memberIds: [user.id],
    project,
    type: isBug ? 'bug' : 'feature',
    // Client-safe: no scope, modules or estimate. The project is the only field.
    fields: project ? [{ name: 'Project', value: project.name, inline: true }] : [],
    closeHint: null,
    onCreated: (made) => dbArg.task.update({ where: { id: task.id }, data: { discordChannelId: made.id } }).catch(() => {}),
  })

  // Pin the opening message so the "client can read this" line stays visible.
  const first = await channel.messages?.fetch?.({ limit: 1 }).catch(() => null)
  const opening = first?.first?.() ?? (first ? [...first.values()][0] : null)
  await opening?.pin?.().catch(() => {})

  const { files, links } = attachmentPlan(attachments)
  if (files.length || links.length) {
    const content = ['Documents from the request:', ...links.map((l) => `• ${l.name}: ${l.url} (too large to copy here)`)].join('\n')
    await channel.send({ content, ...(files.length ? { files } : {}) }).catch((e) => console.warn('[clientRequest] attachments post failed:', e?.message || e))
  }

  // Tell the team. A project request: its support channel (same customer) and
  // a DM to its leads. No project: #admin. Never the global support channel —
  // every company's clients share it.
  let noticedIn = null
  const notice = `New request from **${name}**: **${task.title}** → <#${channel.id}>`
  const supportId = project ? storedChannels(project).support : null
  const supportChannel = supportId ? guild.channels?.cache?.get?.(supportId) ?? null : null
  if (supportChannel) {
    await supportChannel.send({ content: notice }).catch(() => {})
    noticedIn = supportChannel.id
    const roster = await dbArg.projectMember.findByProject({ where: { projectId: project.id } }).catch(() => [])
    const leads = (roster ?? []).filter((m) => m?.role === 'lead').map((m) => String(m.discordId))
    if (leads.length) await dm(client, leads, { title: task.title, channelId: channel.id, note: `A client request${project ? ` on **${project.name}**` : ''}.` })
  } else if (cfg.adminChannelId) {
    const admin = await guild.channels?.fetch?.(cfg.adminChannelId).catch(() => null)
    if (admin?.send) {
      await admin.send({ content: notice + (project ? '' : ' (no project)') }).catch(() => {})
      noticedIn = admin.id
    }
  }

  return { task, channel, fellBack, noticedIn }
}
```

Note: `dmTaskAssignees` wording says "You've been assigned" — acceptable for a lead notice; the `note` line names it as a client request.

- [ ] **Step 4: The commands**

`bot/src/commands/client-request.js`:

```js
import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { createClientRequest, clientProjects } from '../services/clientRequest.js'
import { projectChoices } from './update-task.js'

// Two commands, one implementation. `data` is an array: one module can back
// several slash commands (see meetingReview.js).

function builder(name, description, what) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addStringOption((o) => o.setName('title').setDescription('A short title').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName('details').setDescription(what).setRequired(true).setMaxLength(2000))
    .addStringOption((o) => o.setName('project').setDescription('Which project (needed only if you are on more than one)').setRequired(false).setAutocomplete(true))
    .addAttachmentOption((o) => o.setName('document').setDescription('A document to attach').setRequired(false))
    .addAttachmentOption((o) => o.setName('document2').setDescription('Another document').setRequired(false))
    .addAttachmentOption((o) => o.setName('document3').setDescription('Another document').setRequired(false))
}

export const data = [
  builder('report-issue', 'Report something that is broken', 'What happens, and what you expected'),
  builder('request-feature', 'Ask for something new', 'What you need and why'),
]

/**
 * Which project the request belongs to. Pure.
 * @returns {{project: object|null, error: null|'pick'|'foreign'}}
 */
export function resolveProject({ rows, projects, picked }) {
  const mine = clientProjects(rows)
  const byId = new Map((projects ?? []).map((p) => [String(p.id), p]))
  if (picked) {
    const ok = mine.some((r) => String(r.projectId) === String(picked)) && byId.has(String(picked))
    return ok ? { project: byId.get(String(picked)), error: null } : { project: null, error: 'foreign' }
  }
  const candidates = mine.map((r) => byId.get(String(r.projectId))).filter(Boolean)
  if (candidates.length === 0) return { project: null, error: null }
  if (candidates.length === 1) return { project: candidates[0], error: null }
  return { project: null, error: 'pick' }
}

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig, create = createClientRequest } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })
  const cfg = await getConfig(guild.id)
  const type = interaction.commandName === 'report-issue' ? 'bug' : 'feature'
  const title = interaction.options.getString('title')
  const details = interaction.options.getString('details')
  const picked = interaction.options.getString('project')
  const attachments = ['document', 'document2', 'document3'].map((n) => interaction.options.getAttachment(n)).filter(Boolean)

  const rows = await dbArg.projectMember.findByMember({ where: { guildConfigId: cfg.id, discordId: interaction.user.id } })
  const projects = await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })
  const { project, error } = resolveProject({ rows, projects, picked })
  if (error === 'foreign') return interaction.editReply({ content: 'You are not a client on that project. Leave `project` empty, or start typing to pick one of yours.' })
  if (error === 'pick') return interaction.editReply({ content: 'You are on more than one project — start typing in the `project` option to pick which one this is for.' })

  const out = await create({
    guild, client: interaction.client, user: interaction.user, cfg, type, title, details, project, attachments, db: dbArg,
  })
  const noun = type === 'bug' ? 'issue' : 'request'
  return interaction.editReply({
    content: `Your ${noun} **${out.task.title}** is raised. Its channel is <#${out.channel.id}> — the team will reply there, and you will be messaged when its status changes. See it any time with **/my-requests**.`,
  })
}

export async function autocomplete(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'project') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getConfig(interaction.guild.id)
    const rows = clientProjects(await dbArg.projectMember.findByMember({ where: { guildConfigId: cfg.id, discordId: interaction.user.id } }))
    const ids = new Set(rows.map((r) => String(r.projectId)))
    const projects = (await dbArg.project.findMany({ where: { guildConfigId: cfg.id } })).filter((p) => ids.has(String(p.id)))
    return interaction.respond(projectChoices(projects, focused.value, { withDetach: false })).catch(() => {})
  } catch (e) {
    console.error('[client-request] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}
```

In `bot/src/commands/index.js`, add `import * as clientRequestCmd from './client-request.js'` and `clientRequestCmd,` at the end of `commandModules`.

- [ ] **Step 5: Run the tests**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/services/clientRequest.test.js src/commands/client-request.test.js src/config/commandGates.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/clientRequest.js bot/src/services/clientRequest.test.js bot/src/commands/client-request.js bot/src/commands/client-request.test.js bot/src/commands/index.js
git commit -m "feat(client): /report-issue and /request-feature raise tasks the client can follow

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Tracking — `/my-requests`, `/request-report`, and notifications

**Files:**
- Create: `bot/src/utils/clientRequestView.js`
- Create: `bot/src/commands/client-tracking.js`
- Modify: `bot/src/services/taskUpdateNotify.js` — `changeSummary` (47-73), the channel post (~230-240), after the terminal DM block (~262-)
- Modify: `bot/src/commands/index.js` (register)
- Test: `bot/src/utils/clientRequestView.test.js`, `bot/src/commands/client-tracking.test.js`, additions to `bot/src/services/taskUpdateNotify.test.js`

**Interfaces:**
- Produces: `requestStatusLabel(status)`, `timelineLines(rows, { nameFor, limit = 15 })`, `myRequestsLines(tasks)`; `changeSummary(before, updates, { omit = [] })`; `notifyTaskUpdate` DMs `task.requestedBy` on a status change.
- Consumes: `task.findMany({ requestedBy })`, `taskActivity.findByTask`, `holdersOf`.

- [ ] **Step 1: Tests**

`bot/src/utils/clientRequestView.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestStatusLabel, timelineLines, myRequestsLines } from './clientRequestView.js'

test('pending is "Waiting on you"; every other status keeps its label', () => {
  assert.equal(requestStatusLabel('pending'), 'Waiting on you')
  assert.equal(requestStatusLabel('in_progress'), 'in progress')
  assert.equal(requestStatusLabel('done'), 'done')
})

test('timeline keeps status and assignee changes only, newest last, capped', () => {
  const rows = [
    { createdAt: new Date('2026-09-24T10:00:00Z'), actorLabel: 'Sam', changes: [{ field: 'status', from: 'open', to: 'in_progress' }, { field: 'estimateMinutes', from: null, to: 120 }] },
    { createdAt: new Date('2026-09-23T10:00:00Z'), actorDiscordId: 'u2', changes: [{ field: 'assignees', added: ['u2'], removed: [] }] },
    { createdAt: new Date('2026-09-22T10:00:00Z'), changes: [{ field: 'scope', from: 'a', to: 'b' }] },
  ]
  const lines = timelineLines(rows, { nameFor: (id) => ({ u2: 'Sam' })[id] })
  const at = (iso) => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:d>`
  assert.deepEqual(lines, [
    `${at('2026-09-23T10:00:00Z')} — assigned to Sam`,
    `${at('2026-09-24T10:00:00Z')} — status: open → in progress (Sam)`,
  ])
  assert.ok(!lines.join('\n').includes('120'), 'estimate never renders')
  assert.equal(timelineLines(Array.from({ length: 40 }, (_, i) => ({ createdAt: new Date(2026, 0, 1 + i), changes: [{ field: 'status', from: 'a', to: 'b' }] })), {}).length, 15)
})

test('myRequestsLines shows type, title, project, status and channel', () => {
  const lines = myRequestsLines([
    { type: 'bug', title: 'Login fails', projectName: 'Framework', status: 'pending', discordChannelId: 'c1' },
    { type: 'feature', title: 'Export', projectName: null, status: 'open', discordChannelId: null },
  ])
  assert.deepEqual(lines, [
    '🐞 **Login fails** · Framework · **Waiting on you** · <#c1>',
    '✨ **Export** · no project · open',
  ])
})
```

`bot/src/commands/client-tracking.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { data, execute } from './client-tracking.js'

const ix = (name, opts = {}) => {
  const i = {
    guild: { id: 'g1', members: { cache: new Map([['u-dev', { displayName: 'Sam' }]]) } },
    user: { id: 'u-c' }, commandName: name, replies: [],
    options: { getString: (n) => opts[n] ?? null },
    editReply: async (p) => { i.replies.push(p) },
  }
  return i
}

test('two builders with the spec\'s names', () => {
  assert.deepEqual(data.map((b) => b.name), ['my-requests', 'request-report'])
})

test('my-requests lists only the caller\'s requests, newest first', async () => {
  const db = { task: { findMany: async (args) => { db.args = args; return [{ id: 't1', type: 'bug', title: 'A', status: 'pending', projectName: 'P', discordChannelId: 'c1' }] } } }
  const i = ix('my-requests')
  await execute(i, { db, getConfig: async () => ({ id: 'cfg1' }) })
  assert.equal(db.args.where.requestedBy, 'u-c')
  assert.equal(db.args.orderBy.createdAt, 'desc')
  assert.match(i.replies[0].embeds[0].toJSON().description, /Waiting on you/)
})

test('another client\'s request is refused identically to a missing one', async () => {
  const db = {
    task: { findFirst: async ({ where }) => (where.id === 'theirs' ? { id: 'theirs', requestedBy: 'u-other', title: 'SECRET' } : null) },
    taskActivity: { findByTask: async () => [] },
  }
  const a = ix('request-report', { request: 'theirs' })
  const b = ix('request-report', { request: 'nope' })
  await execute(a, { db, getConfig: async () => ({ id: 'cfg1' }) })
  await execute(b, { db, getConfig: async () => ({ id: 'cfg1' }) })
  assert.equal(a.replies[0].content, b.replies[0].content)
  assert.ok(!a.replies[0].content.includes('SECRET'))
})

test('request-report renders status, handler, dates and a filtered timeline', async () => {
  const db = {
    task: { findFirst: async () => ({ id: 't1', requestedBy: 'u-c', type: 'feature', title: 'Export', projectName: 'P', status: 'in_progress', assigneeIds: ['u-dev'], createdAt: new Date('2026-09-20T00:00:00Z'), updatedAt: new Date('2026-09-24T00:00:00Z') }) },
    taskActivity: { findByTask: async () => [{ createdAt: new Date('2026-09-21T00:00:00Z'), changes: [{ field: 'estimateMinutes', from: null, to: 60 }, { field: 'status', from: 'open', to: 'in_progress' }] }] },
  }
  const i = ix('request-report', { request: 't1' })
  await execute(i, { db, getConfig: async () => ({ id: 'cfg1' }) })
  const json = i.replies[0].embeds[0].toJSON()
  const text = JSON.stringify(json)
  assert.match(text, /Sam/)
  assert.match(text, /in progress/)
  assert.ok(!text.includes('60'), 'estimate never renders')
})
```

Append to `taskUpdateNotify.test.js`:

```js
test('changeSummary can omit a field, so a client request channel never sees the estimate', () => {
  const lines = changeSummary({ status: 'open', estimateMinutes: null }, { status: 'pending', estimateMinutes: 90 }, { omit: ['estimateMinutes'] })
  assert.deepEqual(lines, ['**status**: `open` → `pending`'])
})
```

and, below that file's `harness` / `noQueryDb` definitions (they are declared mid-file, after the `ownsChannel` tests):

```js
test('a status change DMs the requester in their own words, and the channel post omits the estimate', async () => {
  const posts = []
  const channel = {
    id: 'c1', type: ChannelType.GuildText, name: 'bug-login-fails',
    topic: 'Bug: Login fails — Task aaaaaabbbbbbcccccc123456',
    guild: { id: 'g1' },
    send: async (m) => posts.push(m),
    permissionOverwrites: { edit: async () => {}, delete: async () => {} },
  }
  const h = harness({ channel })
  const task = { id: h.taskId, title: 'Login fails', status: 'open', assigneeIds: [], discordChannelId: 'c1', requestedBy: 'u-c', estimateMinutes: null }
  const out = await notifyTaskUpdate({
    client: h.client, guild: h.guild, task, before: task,
    updates: { status: 'pending', estimateMinutes: 90 }, actorId: '99', db: noQueryDb,
  })
  assert.equal(posts.length, 1)
  assert.match(posts[0], /status/)
  assert.ok(!posts[0].includes('estimate'), 'no estimate line in a client request channel')
  const requesterDm = h.dms.find(([id]) => id === 'u-c')
  assert.ok(requesterDm, 'requester DMed')
  assert.match(requesterDm[1], /Waiting on you/)
  assert.ok(out.dmed.includes('u-c'))
})
```

- [ ] **Step 2: Run to see them fail**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/utils/clientRequestView.test.js src/commands/client-tracking.test.js src/services/taskUpdateNotify.test.js`
Expected: FAIL — modules missing; `changeSummary` ignores `omit`.

- [ ] **Step 3: The view helpers**

`bot/src/utils/clientRequestView.js`:

```js
// What a client sees of their request. Pure. The one deliberate difference
// from the staff labels: `pending` reads "Waiting on you" — it is the status a
// developer sets when they need something from the client.
import { STATUS_LABEL } from './taskDeps.js'

export function requestStatusLabel(status) {
  if (status === 'pending') return 'Waiting on you'
  return STATUS_LABEL[status] ?? String(status ?? 'open')
}

const ts = (d) => `<t:${Math.floor(new Date(d).getTime() / 1000)}:d>`

/**
 * Status and assignee changes only, oldest first, at most `limit`. Every other
 * field — estimate above all — is skipped, whatever the row carries.
 */
export function timelineLines(rows, { nameFor = () => null, limit = 15 } = {}) {
  const name = (id) => nameFor(id) || `<@${id}>`
  const out = []
  const ordered = [...(rows ?? [])].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  for (const row of ordered) {
    const changes = Array.isArray(row?.changes) ? row.changes : safeParse(row?.changes)
    const who = row?.actorLabel || (row?.actorDiscordId ? nameFor(row.actorDiscordId) : null)
    for (const c of changes) {
      if (c?.field === 'status') {
        out.push(`${ts(row.createdAt)} — status: ${requestStatusLabel(c.from)} → ${requestStatusLabel(c.to)}${who ? ` (${who})` : ''}`)
      } else if (c?.field === 'assignees') {
        const added = (c.added ?? []).map(name)
        const removed = (c.removed ?? []).map(name)
        if (added.length) out.push(`${ts(row.createdAt)} — assigned to ${added.join(', ')}`)
        if (removed.length) out.push(`${ts(row.createdAt)} — no longer with ${removed.join(', ')}`)
      }
    }
  }
  return out.slice(-limit)
}

function safeParse(raw) {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] }
}

export function myRequestsLines(tasks) {
  return (tasks ?? []).map((t) => {
    const icon = t.type === 'bug' ? '🐞' : '✨'
    const parts = [`${icon} **${t.title}**`, t.projectName || 'no project', t.status === 'pending' ? `**${requestStatusLabel(t.status)}**` : requestStatusLabel(t.status)]
    if (t.discordChannelId) parts.push(`<#${t.discordChannelId}>`)
    return parts.join(' · ')
  })
}
```

- [ ] **Step 4: The commands**

`bot/src/commands/client-tracking.js`:

```js
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { holdersOf } from '../utils/taskLabel.js'
import { myRequestsLines, requestStatusLabel, timelineLines } from '../utils/clientRequestView.js'

export const data = [
  new SlashCommandBuilder().setName('my-requests').setDescription('Your issues and requests, and where each stands'),
  new SlashCommandBuilder().setName('request-report').setDescription('A report on one of your requests')
    .addStringOption((o) => o.setName('request').setDescription('Start typing a title').setRequired(true).setAutocomplete(true)),
]

const NOT_YOURS = 'That is not one of your requests.'
const ts = (d) => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:D>` : '—')

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })
  const cfg = await getConfig(guild.id)
  const nameFor = (id) => guild.members?.cache?.get?.(id)?.displayName ?? null

  if (interaction.commandName === 'my-requests') {
    const tasks = await dbArg.task.findMany({ where: { guildConfigId: cfg.id, requestedBy: interaction.user.id }, orderBy: { createdAt: 'desc' }, take: 25 })
    const lines = myRequestsLines(tasks)
    const embed = new EmbedBuilder()
      .setTitle('Your requests')
      .setDescription(lines.join('\n') || 'You have not raised anything yet. Use **/report-issue** or **/request-feature**.')
      .setColor(0x00b0f4)
      .setFooter({ text: '"Waiting on you" means the team needs something from you — answer in that request\'s channel.' })
    return interaction.editReply({ embeds: [embed] })
  }

  // request-report. The refusal is the same whether the id is someone else's
  // or nobody's: a different message would confirm the id exists.
  const id = interaction.options.getString('request')
  const task = id ? await dbArg.task.findFirst({ where: { id, guildConfigId: cfg.id } }) : null
  if (!task || String(task.requestedBy ?? '') !== String(interaction.user.id)) return interaction.editReply({ content: NOT_YOURS })

  const rows = await dbArg.taskActivity.findByTask({ where: { taskId: task.id } }).catch(() => [])
  const handlers = holdersOf(task).map((h) => nameFor(h) || `<@${h}>`)
  const timeline = timelineLines(rows, { nameFor })
  const embed = new EmbedBuilder()
    .setTitle(`${task.type === 'bug' ? 'Issue' : 'Request'}: ${task.title}`)
    .setColor(task.status === 'pending' ? 0xfee75c : 0x00b0f4)
    .addFields(
      { name: 'Status', value: requestStatusLabel(task.status), inline: true },
      { name: 'Handled by', value: handlers.join(', ') || 'not yet assigned', inline: true },
      { name: 'Project', value: task.projectName || 'no project', inline: true },
      { name: 'Raised', value: ts(task.createdAt), inline: true },
      { name: 'Last updated', value: ts(task.updatedAt ?? task.createdAt), inline: true },
      { name: 'History', value: timeline.join('\n') || 'No changes yet.' },
    )
  if (task.discordChannelId) embed.addFields({ name: 'Channel', value: `<#${task.discordChannelId}>` })
  return interaction.editReply({ embeds: [embed] })
}

export async function autocomplete(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig } = {}) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'request') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getConfig(interaction.guild.id)
    const term = String(focused.value || '').toLowerCase()
    const tasks = await dbArg.task.findMany({ where: { guildConfigId: cfg.id, requestedBy: interaction.user.id }, orderBy: { createdAt: 'desc' }, take: 100 })
    const choices = tasks
      .filter((t) => !term || String(t.title || '').toLowerCase().includes(term))
      .slice(0, 25)
      .map((t) => ({ name: `${String(t.title || t.id).slice(0, 80)} · ${requestStatusLabel(t.status)}`.slice(0, 100), value: String(t.id) }))
    return interaction.respond(choices).catch(() => {})
  } catch (e) {
    console.error('[client-tracking] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}
```

Register in `commands/index.js`: `import * as clientTrackingCmd from './client-tracking.js'` and `clientTrackingCmd,` in `commandModules`.

- [ ] **Step 5: Notifications**

In `taskUpdateNotify.js`:

`changeSummary(before, updates, { omit = [] } = {})` — inside the loop, first line: `if (key === 'assigneeIds' || omit.includes(key)) continue`.

Where the channel post builds lines: `const lines = changeSummary(before, updates, { omit: task.requestedBy ? ['estimateMinutes'] : [] })`.

Add `import { requestStatusLabel } from '../utils/clientRequestView.js'` and, after the `becameTerminal` DM block, before the function returns:

```js
  // The client who raised this hears about every status change, in their own
  // words: `pending` is "Waiting on you" to them.
  const requester = task.requestedBy ? String(task.requestedBy) : null
  if (requester && nextStatus !== undefined && String(nextStatus) !== String(before?.status ?? '')) {
    try {
      const user = await client?.users?.fetch?.(requester)
      const where = out.channelId ? ` — see <#${out.channelId}>` : ''
      await user?.send?.(`Your request **${updates?.title || task.title}** is now **${requestStatusLabel(nextStatus)}**${where}.`)
      out.dmed.push(requester)
    } catch (e) {
      console.warn(`[taskUpdate] requester DM to ${requester} failed:`, e?.message || e)
    }
  }
```

(`nextStatus` is already declared above the terminal block; if it is declared with `const` inside a narrower scope, hoist it.)

- [ ] **Step 6: Run the tests and the suite**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/utils/clientRequestView.test.js src/commands/client-tracking.test.js src/services/taskUpdateNotify.test.js`
Expected: PASS.
Run: `DATABASE_URL=poisoned://no-production-access npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add bot/src/utils/clientRequestView.js bot/src/utils/clientRequestView.test.js bot/src/commands/client-tracking.js bot/src/commands/client-tracking.test.js bot/src/services/taskUpdateNotify.js bot/src/services/taskUpdateNotify.test.js bot/src/commands/index.js
git commit -m "feat(client): /my-requests, /request-report, and requester notifications

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Exclusions and wiring — daily report, `/init`, `/setup`, `/cleanup`, knowledge

**Files:**
- Modify: `bot/src/services/dailyTimeReport.js:305-308`
- Modify: `bot/src/commands/init.js` (roles at 143-145; after the config save at ~328)
- Modify: `bot/src/commands/setup.js` (`execute`, the no-options branch)
- Modify: `bot/src/commands/cleanup.js` (`execute`, the loop at ~200)
- Create: `.claude/knowledge/client-role.md`; Modify: `.claude/knowledge/README.md`
- Test: additions to `bot/src/services/dailyTimeReport.test.js`, `bot/src/commands/cleanup.test.js`

**Interfaces:**
- Consumes: `ensureSupportChannels`, `ensureClientRole` (Task 3); `kind` (Task 1).

- [ ] **Step 1: Tests**

Append to `dailyTimeReport.test.js`:

```js
test('clients are never listed in the daily report, even though they are approved members', async () => {
  const h = harness({
    members: [
      { discordId: '1', displayName: 'Ali', status: 'approved', kind: 'staff' },
      { discordId: '9', displayName: 'Client Co', status: 'approved', kind: 'client' },
    ],
    totals: [{ discordId: '1', minutes: 30 }],
  })
  await runDailyReportPass(h.client, { db: h.db, getConfig: h.getConfig, update: h.update, now: new Date('2026-09-22T23:59:00Z') })
  const text = JSON.stringify(h.sent[0])
  assert.match(text, /Ali/)
  assert.ok(!text.includes('Client Co'))
})
```

Append to `cleanup.test.js` (read its harness first; it has a fake guild with channels and a `db` with `project.findMany`):

```js
test('the support pair and its category are protected by id', async () => {
  const supportCat = category('supcat', '🛟 Support')
  const support = chan('sup', 'support', { parent: supportCat })
  const supportVoice = chan('supv', 'support-voice', { type: ChannelType.GuildVoice, parent: supportCat })
  const orphan = chan('orphan', 'old-chat')
  const guild = fakeGuild([supportCat, support, supportVoice, orphan])
  const it = fakeInteraction(guild)
  const { db } = seams([])
  const cfg = { ...CFG, supportChannelId: 'sup', supportVoiceChannelId: 'supv' }
  const error = console.error
  console.error = () => {}
  try { await execute(it, { db, getConfig: async () => cfg }) } finally { console.error = error }
  const listed = listedForDeletion(it.replies.at(-1))
  assert.ok(!listed.includes('support') && !listed.includes('support-voice'), `support pair listed: ${listed}`)
  assert.ok(listed.includes('old-chat'), 'an unrelated orphan is still listed')
})
```

(`chan`, `category`, `fakeGuild`, `fakeInteraction`, `seams`, `listedForDeletion` and `CFG` all exist at the top of that file.)

- [ ] **Step 2: Run to see them fail**

Run: `DATABASE_URL=poisoned://no-production-access node --test src/services/dailyTimeReport.test.js src/commands/cleanup.test.js`
Expected: the new tests FAIL.

- [ ] **Step 3: The daily report**

In `dailyTimeReport.js`, after the `rows` read:

```js
        // Approved, but not staff: a client has no time to report and must not
        // appear as a permanent 0m line. `kind` defaults to 'staff' for every
        // row that predates migration 025.
        const staffRows = (rows || []).filter((r) => r?.kind !== 'client')
        const members = await hydrateRoster(guild, staffRows)
```

(and remove the old `const members = await hydrateRoster(guild, rows || [])`).

`/time-report` needs no change: its per-person listing is built from `clockentry` rows, and a client has none. Say so in the report.

- [ ] **Step 4: `/init`**

In `init.js`, import `ROLE_CLIENT` and `ensureSupportChannels` (`../services/clientAccess.js`), create the role beside Verified:

```js
  const clientRole = await wrapStep('Creating Client role', () =>
    guild.roles.create({ name: ROLE_CLIENT, color: ROLE_COLORS[ROLE_CLIENT] ?? 0x00b0f4, reason: 'Granjur init' })
  )()
```

add `clientRoleId: clientRole.id,` to the `getOrCreateGuildConfig(guild.id, {...})` save, and **after** that save and the senior/dashboard update (so `verifiedRoleId` and `clientRoleId` are stored and the permission pass has already run):

```js
  await wrapStep('Creating Support category', async () => {
    const cfgNow = await getGuildConfig(guild.id)
    await ensureSupportChannels(guild, cfgNow, { botUserId: interaction.client?.user?.id ?? null })
  })()
```

- [ ] **Step 5: `/setup`**

In `setup.js`, import `ensureSupportChannels`, and in the no-options branch before building the embed:

```js
  // Idempotent: creates the Client role and the support pair if they are
  // missing, repairs their overwrites, re-pins the manual. Cheap when all is well.
  let support = null;
  try {
    support = await ensureSupportChannels(guild, cfg, { botUserId: interaction.client?.user?.id ?? null });
  } catch (e) {
    console.warn("[setup] support channels:", e?.message ?? e);
  }
```

and a field on the embed:

```js
  embed.addFields({
    name: "Client support",
    value: support ? `<#${support.text.id}> and <#${support.voice.id}> · role **${support.role.name}**` : "_could not be set up — check the bot's Manage Channels / Manage Roles permissions_",
    inline: false,
  });
```

- [ ] **Step 6: `/cleanup`**

In `cleanup.js` `execute`, after `const channels = await guild.channels.fetch();` (the fetched map is what the test's fake guild provides — there is no `channels.cache` on it):

```js
  // The global support pair, by id, and whatever category holds it.
  const supportIds = new Set([cfg?.supportChannelId, cfg?.supportVoiceChannelId].filter(Boolean));
  const supportCategoryIds = new Set(
    [...supportIds].map((id) => channels.get(id)?.parentId ?? channels.get(id)?.parent?.id).filter(Boolean),
  );
```

and at the top of the loop body, after `if (section.sectionIds.has(ch.id)) continue;`:

```js
    if (supportIds.has(ch.id) || supportCategoryIds.has(ch.id)) continue;
    if (parentId && supportCategoryIds.has(parentId)) continue;
```

(`parentId` is computed on the next line today — move that computation above this check.)

- [ ] **Step 7: The knowledge file**

Create `.claude/knowledge/client-role.md` covering, in the style of `project-sections.md`: the isolation rule and why `Verified` is never granted; `guildmember.kind` vs the Discord role; the two `/verify` acceptance paths; the shared `approveMember`; the deny-by-default gate and `clientCommands`; the support pair and `ensureSupportChannels`' id-first/name-fallback rule; the twelve-channel section, `CLIENT_SECTION_KEYS`, per-client overwrites and the roster filter (with the sentence "a client row fed to the role sync opens all twelve channels"); requests as tasks with `requestedBy`, attachments re-uploaded, notices; the report's timeline filter; the rollout steps from spec §13; and a Related line to `[[project-sections]]`. Add its line to `.claude/knowledge/README.md`.

- [ ] **Step 8: Run the whole suite**

Run: `DATABASE_URL=poisoned://no-production-access npm test`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add bot/src/services/dailyTimeReport.js bot/src/services/dailyTimeReport.test.js bot/src/commands/init.js bot/src/commands/setup.js bot/src/commands/cleanup.js bot/src/commands/cleanup.test.js .claude/knowledge/client-role.md .claude/knowledge/README.md
git commit -m "feat(client): keep clients out of the daily report; wire init, setup and cleanup; knowledge

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** §3 roles/data → Task 1. §4 entry → Task 4. §5 approval, `/set-roles` → Task 5. §6 support pair, §6.1 manual → Task 3 (+ `/init`, `/setup` in Task 9). §7.1 twelve channels, §7.2 per-client access, §7.3 roster filter → Tasks 6a, 6b. §8 requests → Task 7. §9 tracking, report, requester DM, §8.3 estimate omission → Task 8. §10 gate → Task 2. §11 daily report → Task 9; `/time-report` needs no change (entry-driven) — recorded in Task 9. §12 tests → each task. §13 rollout → knowledge file, Task 9. `/cleanup` protection (§6) → Task 9.

**Deviations from the spec, deliberate:** the manual lives in `services/clientManual.js` (a leaf) rather than `clientRequest.js`, so `clientAccess.js` can pin it without importing the request service; `channel-defaults.json` gets no `support` entry because `ensureSupportChannels` owns the pin on every path. Both are recorded for the implementer of Task 3.

**Type consistency.** `ensureSupportChannels` returns `{ role, category, text, voice }` in Task 3 and is consumed with those names in Tasks 5 and 9. `plan.clients = { wanted, grant, revoke }` in 6a is read by 6b's renderers. `resolveProject` returns `{ project, error }` in both its test and implementation. `changeSummary`'s third argument is `{ omit }` in test and code.

**Review Focus.** Each of the five has its pinned test: (1) Task 2 "client by stored id, renamed role, still denied"; (2) Task 7 "no project: notice goes to the admin channel"; (3) Task 8 "another client's request is refused identically"; (4) Task 4 "an allowed-domain email with a client invite still verifies as a client"; (5) Task 6a "revokeClients:false suppresses revokes" with Task 6b computing `revokeClients` from `fetchFailure` and the `ROSTER_LIMIT`.

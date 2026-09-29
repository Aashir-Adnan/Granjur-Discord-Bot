# Identity Link and Access Scoping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store a link between a UBS-Doc account and a Discord member, and use it so a site user sees and changes only the projects and tasks they are part of (admins and Discord leadership see everything).

**Architecture:** CSAAS owns the link (`discord_identity_link`) and one resolver (`identity.js`) that every Discord-data endpoint calls: it reads the caller's links, auto-links by a single verified-email match, and decides `seesAll` / `isAdmin`. A pure `visibility.js` turns raw rows into the caller's visible projects and tasks; the tasks read and stats filter through it, and the four write endpoints refuse targets outside it. The bot adds `/link` (a one-time code CSAAS redeems) and prefers the linked Discord id CSAAS now sends. The site shows a link card until linked, a "signed in as" line, hidden cross-project references as plain text, and an admin links panel.

**Tech Stack:** Bot — Node ESM, discord.js v14, `node:test`. CSAAS — Node CommonJS, UBS framework API objects, standalone `node` assertion scripts. Site — React 18 + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-identity-link-access-scoping-design.md` (bot repo). Read it before any task.

## Repos and branches

| Repo | Path | Branch |
|---|---|---|
| bot | `D:\Work\Granjur Technologies\Granjur-Discord-Bot` | `feat/identity-link` (exists; spec is on it) |
| CSAAS | `D:\Work\Granjur Technologies\CSAAS_Backend` | `feat/identity-link` (create from `main`) |
| site | worktree `D:\Work\Granjur Technologies\UBS-Doc-identity-link` | `feat/identity-link` (create with `git -C "D:/Work/Granjur Technologies/UBS-Doc" worktree add ../UBS-Doc-identity-link -b feat/identity-link main`, then `npm ci` inside it) |

**The UBS-Doc main checkout holds someone else's uncommitted work** (`LiveTranscribeStage.jsx`, `portal-compat.css`, `audioCapture.js`, `.bridge/`). Never touch, stash or commit those; work only in the worktree; never edit `src/styles/portal-compat.css`. **CSAAS has untracked files that are not yours** (`brag-output/`, `.bridge/`, `.worktrees/`, `data/migrations_completed/*`): stage only files you changed. Read CSAAS `CLAUDE.md` and `.claude/rules/safety.md` before its first task, and the site's `CLAUDE.md` before its first task.

Every commit: `git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit …`, message ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Global Constraints

- **Bot tests never touch production.** The bot repo's root `.env` points at the production database. Every bot test command runs with `DATABASE_URL=poisoned://no-production-access`; every function under test that queries the database takes a `db` seam filled with a fake, including a first "red" run.
- **Gate on `fail 0`.** Full bot suite from the bot repo root: `DATABASE_URL=poisoned://no-production-access npm test` — read the `ℹ fail` line; it must be `0`.
- **CSAAS tests** are standalone scripts: `node Services/SysScripts/TestScripts/discord-tasks-test/<file>.test.js` prints `<file>.test.js: all assertions passed` and exits 0. Nothing opens a DB connection or socket; every handler module exposes `__setTestHooks`. Use the Grep tool, not shell grep, in CSAAS (node_modules).
- **Site:** `npx vitest run <file>`, `npm test`, `npx tsc --noEmit -p .`, `npm run build` in the worktree.
- **Identity comes only from the verified token:** `decryptedPayload.__identityVerified` + `decryptedPayload.actor_email` (set by `actorBinding.js` when the object declares `bindActorToToken: true`). A raw client-supplied email or id never identifies anyone.
- **Never JOIN a CSAAS table with a `granjur.*` table on a string column** (collations can differ; MySQL refuses the comparison). Query each side separately and join in JavaScript.
- **Times for link codes come from MySQL's `NOW()`** on both sides (the bot inserts `DATE_ADD(NOW(), INTERVAL 10 MINUTE)`, CSAAS compares `expiresAt > NOW()`), so no host timezone is involved.
- `seesAll` = site admin (active URDD with role `Admin` or `Platform Admin`, or `actorIsRoleAdmin`, which covers Platform Admin and the admin email allowlist) OR any linked member whose `guildmember.roleNames` contains `CEO` or `Server Manager`. `isAdmin` = the site-admin part alone.
- "My project" = a `projectmember` row for the caller, or at least one task in the project whose `assigneeIds` or `taggedMemberIds` contains the caller.
- Refusal sentences (exact): write outside your projects → 403 `You can only change tasks in projects you are part of.`; bad code → 400 `That code is not valid. Run /link in Discord for a new one.`; Discord member taken → 400 `That Discord account is already linked to another site account. Ask an admin.`; already linked in that server → 400 `Your site account is already linked to a Discord account in that server.`; bot table missing → 503 `Linking by code is not available yet.`; admin endpoints for non-admins → 403 `Only site admins can manage account links.`
- Hidden reference stub (exact): `{ id, title: 'A task in another project', status, hidden: true }`.
- Link codes: 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, valid 10 minutes, single use, compared case-insensitively.

## Review Focus

1. **A caller with no verified email or no link** (a brand-new site user, or someone whose Discord email differs) must see an empty Team section with the link card — never an error page and never everyone's data. Pinned in Task 4 (`getDiscordTasks` unlinked case) and Task 8.
2. **Two Discord members sharing one email** must not auto-link either of them, and must not crash. Pinned in Task 3.
3. **A Discord member already linked to user A** must not be auto-linked or code-linked to user B. Pinned in Task 3.
4. **A task whose blocker lives in a project the caller cannot see** shows "A task in another project", keeps "blocked" correct, and the title never appears anywhere in the response. Pinned in Task 4.
5. **An admin or a CEO/Server Manager** keeps seeing and editing everything exactly as today (no regression for the people running the company). Pinned in Tasks 3, 4 and 6.

---

## Bot (Tasks 1–2) — repo `Granjur-Discord-Bot`, branch `feat/identity-link`

### Task 1: `/link` and its code table

**Files:**
- Create: `bot/src/Database/migrations/027_discord_link_code.sql`
- Modify: `bot/src/Database/index.js` (a `discordLinkCode` namespace on the `db` facade)
- Create: `bot/src/commands/link.js`
- Create: `bot/src/commands/link.test.js`
- Modify: `bot/src/commands/index.js` (import and register `linkCmd`)
- Modify: `bot/src/config/command-config.json` (`commandRoles.link`, `dedicatedChannels.link`, `commandDescriptions.link`)

**Interfaces:**
- Produces (table, read by CSAAS in Task 5): `discordlinkcode(id VARCHAR(36) PK, guildConfigId VARCHAR(36), discordId VARCHAR(64), code CHAR(6) UNIQUE, expiresAt DATETIME, usedAt DATETIME NULL, createdAt DATETIME(3))`.
- Produces: `db.discordLinkCode.issue({ guildConfigId, discordId, code }) → Promise<{ id, code }>` (throws the mysql2 error with `code === 'ER_DUP_ENTRY'` on a code collision).
- Produces: `generateCode(randomInt = crypto.randomInt) → string` and `execute(interaction, { db, getConfig, makeCode })` from `commands/link.js`.

- [ ] **Step 1: Write the failing tests** — `bot/src/commands/link.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { data, execute, generateCode, CODE_ALPHABET } from './link.js'

test('the command is /link with no options', () => {
  const json = data.toJSON()
  assert.equal(json.name, 'link')
  assert.equal((json.options || []).length, 0)
})

test('codes are 6 characters from the unambiguous alphabet', () => {
  assert.equal(CODE_ALPHABET, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789')
  for (let i = 0; i < 200; i++) {
    const c = generateCode()
    assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
  }
  let n = 0
  assert.equal(generateCode(() => n++ % 32), 'ABCDEF')
})

function interaction() {
  const replies = []
  return {
    replies,
    guild: { id: 'G1' },
    user: { id: 'u1' },
    editReply: async (p) => { replies.push(typeof p === 'string' ? p : p.content) },
  }
}

test('issues a code for the caller and replies privately with it', async () => {
  const calls = []
  const db = { discordLinkCode: { issue: async (a) => { calls.push(a); return { id: 'x', code: a.code } } } }
  const i = interaction()
  await execute(i, { db, getConfig: async () => ({ id: 'cfg1' }), makeCode: () => 'ABC234' })
  assert.deepEqual(calls, [{ guildConfigId: 'cfg1', discordId: 'u1', code: 'ABC234' }])
  assert.match(i.replies[0], /\*\*ABC234\*\*/)
  assert.match(i.replies[0], /10 minutes/)
  assert.match(i.replies[0], /UBS-Doc/)
})

test('a code collision is retried with a fresh code', async () => {
  let attempts = 0
  const db = { discordLinkCode: { issue: async (a) => {
    attempts++
    if (attempts < 3) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e }
    return { id: 'x', code: a.code }
  } } }
  const codes = ['AAAAAA', 'BBBBBB', 'CCCCCC']
  const i = interaction()
  await execute(i, { db, getConfig: async () => ({ id: 'cfg1' }), makeCode: () => codes.shift() })
  assert.equal(attempts, 3)
  assert.match(i.replies[0], /\*\*CCCCCC\*\*/)
})

test('after five collisions it gives up with a sentence', async () => {
  const db = { discordLinkCode: { issue: async () => { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e } } }
  const i = interaction()
  await execute(i, { db, getConfig: async () => ({ id: 'cfg1' }), makeCode: () => 'AAAAAA' })
  assert.equal(i.replies[0], 'Could not make a code right now. Try /link again in a moment.')
})

test('outside a server or before /init it says so', async () => {
  const i = { ...interaction(), guild: null }
  await execute(i, { db: {}, getConfig: async () => null, makeCode: () => 'AAAAAA' })
  assert.equal(i.replies[0], 'Use this in a server.')
  const j = interaction()
  await execute(j, { db: {}, getConfig: async () => null, makeCode: () => 'AAAAAA' })
  assert.equal(j.replies[0], 'Server not initialized. Run **/init** first.')
})
```

- [ ] **Step 2: Run to verify it fails**

Run (bot repo root): `DATABASE_URL=poisoned://no-production-access node --test bot/src/commands/link.test.js`
Expected: FAIL — cannot find `./link.js`.

- [ ] **Step 3: Migration** — `bot/src/Database/migrations/027_discord_link_code.sql`:

```sql
-- One-time codes that link a Discord member to a UBS-Doc account.
-- /link writes a row; CSAAS redeems it (reads it and stamps usedAt) when the
-- member types the code on the site. expiresAt is computed by MySQL's NOW()
-- on insert and compared with NOW() on redeem, so no host timezone matters.
-- Same table-level collation as the other bot tables.
CREATE TABLE IF NOT EXISTS discordlinkcode (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  discordId VARCHAR(64) NOT NULL,
  code CHAR(6) NOT NULL,
  expiresAt DATETIME NOT NULL,
  usedAt DATETIME DEFAULT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_discordlinkcode_code (code),
  KEY idx_discordlinkcode_member (guildConfigId, discordId)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
```

- [ ] **Step 4: DB namespace.** In `bot/src/Database/index.js`, next to the other small helpers (e.g. after `taskActivityFindByTask`), add:

```js
// /link codes. Issuing replaces the member's unused code and clears day-old
// rows, so the table stays tiny. The expiry is MySQL's own clock (see migration 027).
async function discordLinkCodeIssue({ guildConfigId, discordId, code }) {
  await query("DELETE FROM `discordlinkcode` WHERE createdAt < NOW() - INTERVAL 1 DAY", []);
  await query("DELETE FROM `discordlinkcode` WHERE guildConfigId = ? AND discordId = ? AND usedAt IS NULL", [guildConfigId, String(discordId)]);
  const pk = id();
  await query(
    "INSERT INTO `discordlinkcode` (id, guildConfigId, discordId, code, expiresAt) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))",
    [pk, guildConfigId, String(discordId), code],
  );
  return { id: pk, code };
}
```
and in the `db` facade object add `discordLinkCode: { issue: discordLinkCodeIssue },`. (`id` and `query` are already in scope in that file — check the names at the top of the file before using them.)

- [ ] **Step 5: The command** — `bot/src/commands/link.js`:

```js
import { randomInt } from 'node:crypto'
import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'

// /link — a one-time code that links this Discord member to a UBS-Doc account.
// The site links accounts by verified email automatically; this is the way in
// when the emails differ (or two members share one). CSAAS redeems the code.

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, 1/I
const CODE_LENGTH = 6
const MAX_ATTEMPTS = 5

export const data = new SlashCommandBuilder()
  .setName('link')
  .setDescription('Get a code to link your Discord account to UBS-Doc')

export function generateCode(pick = randomInt) {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[pick(CODE_ALPHABET.length)]
  return out
}

export async function execute(interaction, { db: dbArg = db, getConfig = getOrCreateGuildConfig, makeCode = generateCode } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })
  const cfg = await getConfig(guild.id)
  if (!cfg) return interaction.editReply({ content: 'Server not initialized. Run **/init** first.' })

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = makeCode()
    try {
      await dbArg.discordLinkCode.issue({ guildConfigId: cfg.id, discordId: interaction.user.id, code })
      return interaction.editReply({
        content: `Your link code is **${code}**. On UBS-Doc, open **Team**, and enter it under **Link your Discord account** within 10 minutes. It works once.`,
      })
    } catch (e) {
      if (e?.code !== 'ER_DUP_ENTRY') throw e
    }
  }
  return interaction.editReply({ content: 'Could not make a code right now. Try /link again in a moment.' })
}
```

- [ ] **Step 6: Register and configure.** In `bot/src/commands/index.js` add `import * as linkCmd from './link.js'` beside the other imports and `linkCmd,` to `commandModules` (after `verifyCmd`). In `bot/src/config/command-config.json` add `"link": ["Verified"]` to `commandRoles`, `"link": false` to `dedicatedChannels` (usable in any channel), and to `commandDescriptions`:

```json
"link": {
  "summary": "Link your Discord account to UBS-Doc.",
  "syntax": "`/link`",
  "detail": "Replies privately with a 6-character code. On UBS-Doc open **Team** and enter it under **Link your Discord account** within 10 minutes; it works once. Most accounts link by email automatically — you only need this if the email you verified with here differs from the one you sign in to UBS-Doc with. Running it again replaces your unused code."
}
```
Check whether deferral for commands is ephemeral by default (look at where `deferReply` is called for slash commands in `bot/src/events/` or `bot/src/index.js`); `/link` must reply privately. If a list of public-reply commands exists, `link` must not be on it.

- [ ] **Step 7: Run**

Run: `DATABASE_URL=poisoned://no-production-access node --test bot/src/commands/link.test.js bot/src/config/commandGates.test.js bot/src/config/clientGate.test.js`
Expected: `ℹ fail 0`. Then the full suite: `DATABASE_URL=poisoned://no-production-access npm test` → `ℹ fail 0` (a test that counts registered commands, if any, must be updated to include `link`).

- [ ] **Step 8: Commit**

```bash
git add bot/src/Database/migrations/027_discord_link_code.sql bot/src/Database/index.js bot/src/commands/link.js bot/src/commands/link.test.js bot/src/commands/index.js bot/src/config/command-config.json
git commit -m "feat(link): /link issues a one-time code to link a UBS-Doc account

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The bot prefers the linked Discord id CSAAS sends

**Files:**
- Modify: `bot/src/services/internalTaskRoute.js` (`siteActor`, ≈L48-61)
- Modify: `bot/src/services/internalTaskRoute.test.js` (append)

**Interfaces:**
- Consumes: the `actor` object CSAAS sends on every internal route: `{ email, name, discordId? }` (Task 6 adds `discordId`).
- Produces: `siteActor(dbArg, guildConfigId, actor) → { label, activityId }` where `activityId = actor.discordId` when it is a non-empty string of digits (≤ 32 chars), else the email match as before.

- [ ] **Step 1: Write the failing tests** — append to `bot/src/services/internalTaskRoute.test.js`:

```js
test('status: a linked Discord id from CSAAS is used as the actor without an email lookup', async () => {
  let looked = 0
  const db2 = {
    task: { findFirst: async () => ({ id: 'A', guildConfigId: 'g1', title: 'Git Sync', status: 'open' }) },
    guildMember: { findByConfigEmail: async () => { looked++; return { discordId: 'u-email' } } },
  }
  let seen
  const r = await handleStatusRequest({
    headers: { 'x-internal-secret': 's3cret' },
    body: { taskId: 'A', status: 'in_progress', actor: { email: 'a@granjur.com', name: 'Aashir', discordId: '123456789012345678' } },
    db: db2, client: {}, secret: 's3cret', apply: async (a) => { seen = a; return { warning: '' } },
  })
  assert.equal(r.status, 200)
  assert.equal(seen.actor.activityId, '123456789012345678')
  assert.equal(seen.actor.discordId, undefined, 'still never a mention')
  assert.equal(looked, 0)
})

test('status: a malformed discordId falls back to the email match', async () => {
  const db2 = {
    task: { findFirst: async () => ({ id: 'A', guildConfigId: 'g1', title: 'Git Sync', status: 'open' }) },
    guildMember: { findByConfigEmail: async () => ({ discordId: 'u-email' }) },
  }
  let seen
  await handleStatusRequest({
    headers: { 'x-internal-secret': 's3cret' },
    body: { taskId: 'A', status: 'in_progress', actor: { email: 'a@granjur.com', discordId: 'not an id' } },
    db: db2, client: {}, secret: 's3cret', apply: async (a) => { seen = a; return { warning: '' } },
  })
  assert.equal(seen.actor.activityId, 'u-email')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `DATABASE_URL=poisoned://no-production-access node --test bot/src/services/internalTaskRoute.test.js`
Expected: the first new test FAILS (`activityId` is `u-email`).

- [ ] **Step 3: Implement.** Replace the body of `siteActor` in `bot/src/services/internalTaskRoute.js`:

```js
async function siteActor(dbArg, guildConfigId, actor) {
  const name = String(actor?.name || actor?.email || 'Someone').slice(0, 100)
  // CSAAS sends the caller's stored Discord link (identity link, 2026-09-28).
  // Trusted like the rest of the body (the shared secret); only its shape is checked.
  const linked = typeof actor?.discordId === 'string' && /^\d{1,32}$/.test(actor.discordId) ? actor.discordId : null
  if (linked) return { label: `${name} (via the site)`, activityId: linked }
  let activityId = null
  const email = String(actor?.email ?? '').trim()
  if (email) {
    try {
      const member = await dbArg.guildMember.findByConfigEmail({ where: { guildConfigId, email } })
      activityId = member?.discordId ?? null
    } catch (e) {
      console.error('[internal] actor lookup:', e?.message ?? e)
    }
  }
  return { label: `${name} (via the site)`, activityId }
}
```

- [ ] **Step 4: Run**

Run: `DATABASE_URL=poisoned://no-production-access node --test bot/src/services/internalTaskRoute.test.js` → `ℹ fail 0`; then the full suite → `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/internalTaskRoute.js bot/src/services/internalTaskRoute.test.js
git commit -m "feat(internal): prefer the linked Discord id CSAAS sends for the site actor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
## CSAAS (Tasks 3–7) — repo `CSAAS_Backend`, branch `feat/identity-link` (create from `main`)

Before Task 3: `git -C "D:/Work/Granjur Technologies/CSAAS_Backend" checkout main && git -C "D:/Work/Granjur Technologies/CSAAS_Backend" checkout -b feat/identity-link`.

Facts the tasks rely on (verified 2026-09-28):
- `actorBinding.js` (`Services/Middlewares/ActorBinding/`) sets `decryptedPayload.actor_email`, `__identityVerified = true` and `actionPerformerURDD` for objects with `requestMetaData.bindActorToToken: true`, on GET and POST alike (the time and stats GETs already use it).
- `portalAuthz.js` exports `actorIsRoleAdmin(req, dp, actorUrdd)` — true for a Platform Admin URDD or an allowlisted email; the org `Admin` role is NOT covered, so Task 3 adds its own role query.
- `users.user_id` is numeric and `0` is a real id (the Platform Admin on this deployment); never test ids with truthiness.
- `granjur.*` ids are `VARCHAR(36)`, Discord ids `VARCHAR(64)`; `granjur.guildmember.roleNames` is a JSON array (string or array from mysql2).
- Every file under `Src/Apis/` is `require()`d at startup; a module without `global.*_object` is harmless (`timeScope.js`, `botLink.js`). `POST /api/discord/identity/link` resolves to `global.DiscordIdentityLink_object`.
- Migrations in `data/migrations/` run automatically at CSAAS startup and move to `data/migrations_completed/`.

### Task 3: The link table and the identity resolver

**Files:**
- Create: `data/migrations/20260929_1_discord_identity_link.sql`
- Create: `Src/Apis/ProjectSpecificApis/DiscordTasks/identity.js`
- Create: `Services/SysScripts/TestScripts/discord-tasks-test/identity.test.js`

**Interfaces:**
- Produces (all take the calling module's `hooks = { executeQuery, actorIsRoleAdmin }`):
  - `verifiedEmail(decryptedPayload) → string | null` (moved here from `timeScope.js`; `timeScope.js` re-exports it in Task 7).
  - `resolveIdentity(req, decryptedPayload, hooks) → Promise<{ userId: number|null, email: string|null, links: { guildConfigId: string, discordId: string, via: 'email'|'code'|'admin' }[], isAdmin: boolean, seesAll: boolean }>`
  - `firstLinkForEmail(email, hooks) → Promise<{ guildConfigId: string|null, discordId: string|null }>` (used by `timeScope.js` in Task 7; auto-links like `resolveIdentity`).
  - `linkByCode(identity, rawCode, hooks) → Promise<{ guildConfigId, discordId, via: 'code' }>` (throws `{ statusCode, message }`).
  - `listLinks(hooks) → Promise<{ userId, email, name, guildConfigId, discordId, discordName, via, linkedAt }[]>`
  - `unlink(userId, guildConfigId, hooks) → Promise<{ removed: number }>`
  - Constants: `LEADERSHIP_ROLES`, `MESSAGES` (the exact sentences from Global Constraints).

- [ ] **Step 1: Migration** — `data/migrations/20260929_1_discord_identity_link.sql`:

```sql
-- The stored link between a UBS-Doc account and a Discord member (identity link,
-- 2026-09-28; spec in the Discord bot repo, docs/superpowers/specs/2026-09-28-
-- identity-link-access-scoping-design.md). One row per account per Discord server;
-- a Discord member links to at most one account. No foreign keys: guild_config_id
-- and discord_id live in the bot's `granjur` database. Same collation as those ids
-- so the values compare cleanly in JavaScript joins (never JOIN across databases).
CREATE TABLE IF NOT EXISTS discord_identity_link (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT          NOT NULL,
  guild_config_id  VARCHAR(36)  NOT NULL,
  discord_id       VARCHAR(64)  NOT NULL,
  linked_via       ENUM('email','code','admin') NOT NULL,
  linked_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_link_user_guild (user_id, guild_config_id),
  UNIQUE KEY uq_link_guild_discord (guild_config_id, discord_id),
  KEY idx_link_discord (discord_id)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
```
Before committing, use the Grep tool on `data/` for the `users` table's `user_id` definition (e.g. pattern `user_id` in the base schema dump or an early migration). If it is not a plain signed `INT`, match it exactly (e.g. `BIGINT UNSIGNED`).

- [ ] **Step 2: Write the failing test** — `Services/SysScripts/TestScripts/discord-tasks-test/identity.test.js`. A small in-memory fake answers each query by its SQL text; nothing touches a database.

```js
const assert = require("assert");
const {
  resolveIdentity, firstLinkForEmail, linkByCode, listLinks, unlink, verifiedEmail, MESSAGES,
} = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/identity");

// A fake of just the tables identity.js reads and writes.
function fakeDb(seed = {}) {
  const s = {
    users: seed.users || [{ user_id: 5, email: "a@granjur.com", status: "active", first_name: "Aashir", last_name: "Khan" }],
    adminRoleUsers: seed.adminRoleUsers || [],
    guilds: seed.guilds || [{ id: "g1" }],
    members: seed.members || [],
    links: seed.links || [],
    codes: seed.codes || [],
    codeTableMissing: !!seed.codeTableMissing,
  };
  const calls = [];
  const executeQuery = async (sql, p = []) => {
    calls.push(sql);
    if (/FROM users WHERE LOWER\(TRIM\(email\)\)/.test(sql)) return s.users.filter((u) => u.email === p[0] && u.status === "active").map((u) => ({ user_id: u.user_id }));
    if (/FROM users WHERE user_id IN/.test(sql)) return s.users.filter((u) => p.includes(u.user_id)).map((u) => ({ user_id: u.user_id, email: u.email, name: `${u.first_name} ${u.last_name}` }));
    if (/r\.role_name IN \('Admin', 'Platform Admin'\)/.test(sql)) return s.adminRoleUsers.includes(p[0]) ? [{ 1: 1 }] : [];
    if (/SELECT guild_config_id AS guildConfigId, discord_id AS discordId, linked_via AS via FROM discord_identity_link WHERE user_id = \?/.test(sql)) return s.links.filter((l) => l.user_id === p[0]).map((l) => ({ guildConfigId: l.guild_config_id, discordId: l.discord_id, via: l.linked_via }));
    if (/SELECT user_id FROM discord_identity_link WHERE guild_config_id = \? AND discord_id = \?/.test(sql)) return s.links.filter((l) => l.guild_config_id === p[0] && l.discord_id === p[1]).map((l) => ({ user_id: l.user_id }));
    if (/^INSERT IGNORE INTO discord_identity_link/.test(sql) || /^INSERT INTO discord_identity_link/.test(sql)) {
      const [user_id, guild_config_id, discord_id] = p;
      const via = /'email'/.test(sql) ? "email" : "code";
      const clash = s.links.some((l) => (l.user_id === user_id && l.guild_config_id === guild_config_id) || (l.guild_config_id === guild_config_id && l.discord_id === discord_id));
      if (clash) { if (/IGNORE/.test(sql)) return { affectedRows: 0 }; const e = new Error("dup"); e.code = "ER_DUP_ENTRY"; throw e; }
      s.links.push({ user_id, guild_config_id, discord_id, linked_via: via, linked_at: new Date("2026-09-29T10:00:00Z") });
      return { affectedRows: 1 };
    }
    if (/SELECT user_id, guild_config_id, discord_id, linked_via, linked_at FROM discord_identity_link/.test(sql)) return s.links.map((l) => ({ ...l }));
    if (/^DELETE FROM discord_identity_link/.test(sql)) { const before = s.links.length; s.links = s.links.filter((l) => !(l.user_id === p[0] && l.guild_config_id === p[1])); return { affectedRows: before - s.links.length }; }
    if (/SELECT id FROM granjur\.guildconfig/.test(sql)) return s.guilds;
    if (/SELECT discordId FROM granjur\.guildmember WHERE guildConfigId = \? AND LOWER\(email\) = \? AND verifiedAt IS NOT NULL/.test(sql)) return s.members.filter((m) => m.guildConfigId === p[0] && m.email === p[1] && m.verified).map((m) => ({ discordId: m.discordId }));
    if (/SELECT roleNames FROM granjur\.guildmember/.test(sql)) return s.members.filter((m) => m.guildConfigId === p[0] && m.discordId === p[1]).map((m) => ({ roleNames: JSON.stringify(m.roleNames || []) }));
    if (/SELECT guildConfigId, discordId, displayName, username FROM granjur\.guildmember WHERE discordId IN/.test(sql)) return s.members.filter((m) => p.includes(m.discordId)).map((m) => ({ guildConfigId: m.guildConfigId, discordId: m.discordId, displayName: m.displayName || null, username: m.username || null }));
    if (/FROM granjur\.discordlinkcode/.test(sql)) {
      if (s.codeTableMissing) { const e = new Error("Table 'granjur.discordlinkcode' doesn't exist"); e.code = "ER_NO_SUCH_TABLE"; throw e; }
      return s.codes.filter((c) => c.code === p[0] && !c.usedAt && c.valid).map((c) => ({ id: c.id, guildConfigId: c.guildConfigId, discordId: c.discordId }));
    }
    if (/^UPDATE granjur\.discordlinkcode SET usedAt/.test(sql)) { const c = s.codes.find((x) => x.id === p[0]); if (c) c.usedAt = new Date(); return { affectedRows: c ? 1 : 0 }; }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { s, calls, hooks: { executeQuery, actorIsRoleAdmin: async () => !!seed.roleAdmin } };
}
const dp = (email = "a@granjur.com") => ({ actor_email: email, __identityVerified: true });
async function thrown(fn) { try { await fn(); } catch (e) { return e; } throw new assert.AssertionError({ message: "expected a rejection" }); }

async function run() {
  // Only a token-verified email identifies anyone.
  assert.strictEqual(verifiedEmail({ actor_email: "a@granjur.com" }), null);
  assert.strictEqual(verifiedEmail(dp(" A@Granjur.com ")), "a@granjur.com");
  let f = fakeDb();
  let id = await resolveIdentity({}, { actor_email: "a@granjur.com" }, f.hooks);
  assert.deepStrictEqual(id, { userId: null, email: null, links: [], isAdmin: false, seesAll: false });

  // Exactly one verified member with the email: linked automatically and stored.
  f = fakeDb({ members: [{ guildConfigId: "g1", discordId: "111", email: "a@granjur.com", verified: true }] });
  id = await resolveIdentity({}, dp(), f.hooks);
  assert.deepStrictEqual(id.links, [{ guildConfigId: "g1", discordId: "111", via: "email" }]);
  assert.strictEqual(f.s.links.length, 1);
  assert.strictEqual(id.userId, 5);
  assert.strictEqual(id.seesAll, false);

  // Two members share the email: nothing is linked.
  f = fakeDb({ members: [
    { guildConfigId: "g1", discordId: "111", email: "a@granjur.com", verified: true },
    { guildConfigId: "g1", discordId: "222", email: "a@granjur.com", verified: true },
  ] });
  id = await resolveIdentity({}, dp(), f.hooks);
  assert.deepStrictEqual(id.links, []);
  assert.strictEqual(f.s.links.length, 0);

  // An unverified member does not count; a member linked to someone else is not stolen.
  f = fakeDb({ members: [{ guildConfigId: "g1", discordId: "111", email: "a@granjur.com", verified: false }] });
  assert.deepStrictEqual((await resolveIdentity({}, dp(), f.hooks)).links, []);
  f = fakeDb({
    members: [{ guildConfigId: "g1", discordId: "111", email: "a@granjur.com", verified: true }],
    links: [{ user_id: 9, guild_config_id: "g1", discord_id: "111", linked_via: "code", linked_at: new Date() }],
  });
  assert.deepStrictEqual((await resolveIdentity({}, dp(), f.hooks)).links, []);

  // user_id 0 is a real account.
  f = fakeDb({ users: [{ user_id: 0, email: "a@granjur.com", status: "active", first_name: "P", last_name: "A" }],
    members: [{ guildConfigId: "g1", discordId: "111", email: "a@granjur.com", verified: true }] });
  id = await resolveIdentity({}, dp(), f.hooks);
  assert.strictEqual(id.userId, 0);
  assert.strictEqual(id.links.length, 1);

  // seesAll: site admin by role, by actorIsRoleAdmin, or Discord leadership.
  f = fakeDb({ adminRoleUsers: [5] });
  id = await resolveIdentity({}, dp(), f.hooks);
  assert.strictEqual(id.isAdmin, true); assert.strictEqual(id.seesAll, true);
  f = fakeDb({ roleAdmin: true });
  id = await resolveIdentity({}, dp(), f.hooks);
  assert.strictEqual(id.isAdmin, true);
  f = fakeDb({ members: [{ guildConfigId: "g1", discordId: "111", email: "a@granjur.com", verified: true, roleNames: ["Verified", "CEO"] }] });
  id = await resolveIdentity({}, dp(), f.hooks);
  assert.strictEqual(id.isAdmin, false); assert.strictEqual(id.seesAll, true);

  // firstLinkForEmail auto-links too.
  f = fakeDb({ members: [{ guildConfigId: "g1", discordId: "111", email: "a@granjur.com", verified: true }] });
  assert.deepStrictEqual(await firstLinkForEmail("a@granjur.com", f.hooks), { guildConfigId: "g1", discordId: "111" });
  assert.deepStrictEqual(await firstLinkForEmail(null, f.hooks), { guildConfigId: null, discordId: null });

  // Code linking.
  f = fakeDb({ codes: [
    { id: "c1", code: "ABC234", guildConfigId: "g1", discordId: "333", valid: true },
    { id: "c3", code: "DEF567", guildConfigId: "g1", discordId: "555", valid: true },
  ] });
  id = await resolveIdentity({}, dp(), f.hooks);
  const link = await linkByCode(id, " abc-234 ", f.hooks);
  assert.deepStrictEqual(link, { guildConfigId: "g1", discordId: "333", via: "code" });
  assert.ok(f.s.codes[0].usedAt, "the code is used up");
  assert.deepStrictEqual(await thrown(() => linkByCode(id, "ABC234", f.hooks)), { statusCode: 400, message: MESSAGES.badCode }, "a used code is not valid");
  id = await resolveIdentity({}, dp(), f.hooks); // now linked in g1
  assert.deepStrictEqual(await thrown(() => linkByCode(id, "DEF567", f.hooks)), { statusCode: 400, message: MESSAGES.alreadyLinked });
  const fresh = await resolveIdentity({}, dp(), fakeDb({ codes: [] }).hooks);
  assert.deepStrictEqual(await thrown(() => linkByCode(fresh, "ZZZ999", fakeDb().hooks)), { statusCode: 400, message: MESSAGES.badCode });
  assert.deepStrictEqual(await thrown(() => linkByCode(fresh, "12", fakeDb().hooks)), { statusCode: 400, message: MESSAGES.badCode });
  f = fakeDb({ codes: [{ id: "c2", code: "QQQ222", guildConfigId: "g1", discordId: "444", valid: true }],
    links: [{ user_id: 9, guild_config_id: "g1", discord_id: "444", linked_via: "email", linked_at: new Date() }] });
  id = await resolveIdentity({}, dp(), f.hooks);
  assert.deepStrictEqual(await thrown(() => linkByCode(id, "QQQ222", f.hooks)), { statusCode: 400, message: MESSAGES.taken });
  f = fakeDb({ codeTableMissing: true });
  id = await resolveIdentity({}, dp(), f.hooks);
  assert.deepStrictEqual(await thrown(() => linkByCode(id, "ABC234", f.hooks)), { statusCode: 503, message: MESSAGES.codesUnavailable });
  assert.deepStrictEqual(await thrown(() => linkByCode({ userId: null, links: [] }, "ABC234", f.hooks)), { statusCode: 401, message: MESSAGES.signIn });

  // Listing and unlinking (joined in JavaScript, never across databases).
  f = fakeDb({ members: [{ guildConfigId: "g1", discordId: "111", email: "a@granjur.com", verified: true, displayName: "Aashir" }],
    links: [{ user_id: 5, guild_config_id: "g1", discord_id: "111", linked_via: "email", linked_at: new Date("2026-09-29T10:00:00Z") }] });
  const all = await listLinks(f.hooks);
  assert.deepStrictEqual(all, [{ userId: 5, email: "a@granjur.com", name: "Aashir Khan", guildConfigId: "g1", discordId: "111", discordName: "Aashir", via: "email", linkedAt: "2026-09-29T10:00:00.000Z" }]);
  assert.ok(!f.calls.some((q) => /JOIN granjur\./.test(q) || /JOIN users/.test(q)), "no cross-database joins");
  assert.deepStrictEqual(await unlink(5, "g1", f.hooks), { removed: 1 });
  assert.strictEqual(f.s.links.length, 0);

  console.log("identity.test.js: all assertions passed");
}
run().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run to verify it fails**

Run (CSAAS root): `node Services/SysScripts/TestScripts/discord-tasks-test/identity.test.js`
Expected: FAIL — cannot find `identity`.

- [ ] **Step 4: Write `Src/Apis/ProjectSpecificApis/DiscordTasks/identity.js`:**

```js
// Who a signed-in UBS-Doc user is in Discord, and how much they may see.
// The ONE resolver every Discord-data endpoint calls (identity link, 2026-09-28;
// spec in the bot repo: docs/superpowers/specs/2026-09-28-identity-link-access-
// scoping-design.md). Declares no API object.
//
// Every function takes the CALLER's hooks ({ executeQuery, actorIsRoleAdmin }) so
// each endpoint's __setTestHooks seam reaches these queries; nothing here opens a
// connection. CSAAS tables and granjur.* tables are never JOINed on string columns
// (their collations can differ, and MySQL then refuses the comparison): each side
// is read on its own and joined here in JavaScript.

const LEADERSHIP_ROLES = ["CEO", "Server Manager"]; // the bot's LEADERSHIP_ROLE_NAMES

const MESSAGES = {
  badCode: "That code is not valid. Run /link in Discord for a new one.",
  taken: "That Discord account is already linked to another site account. Ask an admin.",
  alreadyLinked: "Your site account is already linked to a Discord account in that server.",
  codesUnavailable: "Linking by code is not available yet.",
  signIn: "Sign in again, then link your account.",
  notAdmin: "Only site admins can manage account links.",
  notYours: "You can only change tasks in projects you are part of.",
};

const fail = (statusCode, message) => ({ statusCode, message });

// Only a token-bound identity counts: actorBinding.js sets actor_email and
// __identityVerified solely from the verified token.
function verifiedEmail(decryptedPayload) {
  if (!decryptedPayload || !decryptedPayload.__identityVerified) return null;
  const email = String(decryptedPayload.actor_email || "").toLowerCase().trim();
  return email || null;
}

function parseList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } }
  return [];
}

async function userIdFor(email, hooks) {
  const rows = await hooks.executeQuery(
    "SELECT user_id FROM users WHERE LOWER(TRIM(email)) = ? AND status = 'active' ORDER BY user_id LIMIT 1",
    [email]
  );
  // user_id 0 is a real account (the Platform Admin here): never test with truthiness.
  return rows && rows.length ? Number(rows[0].user_id) : null;
}

// Site admin: Platform Admin / the email allowlist (actorIsRoleAdmin), or the
// org-level Admin role, which actorIsRoleAdmin deliberately does not cover.
async function isSiteAdmin(req, dp, userId, hooks) {
  if (await hooks.actorIsRoleAdmin(req, dp, dp?.actionPerformerURDD ?? null)) return true;
  if (userId === null) return false;
  const rows = await hooks.executeQuery(
    `SELECT 1 FROM user_roles_designations_department urdd
       JOIN roles_designations_department rdd ON rdd.role_designation_department_id = urdd.role_designation_department_id
       JOIN roles r ON r.role_id = rdd.role_id
      WHERE urdd.user_id = ? AND urdd.status = 'active' AND r.role_name IN ('Admin', 'Platform Admin') LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
}

async function readLinks(userId, hooks) {
  const rows = await hooks.executeQuery(
    "SELECT guild_config_id AS guildConfigId, discord_id AS discordId, linked_via AS via FROM discord_identity_link WHERE user_id = ? ORDER BY linked_at",
    [userId]
  );
  return (rows || []).map((r) => ({ guildConfigId: String(r.guildConfigId), discordId: String(r.discordId), via: r.via }));
}

// For every server with no link yet: exactly one verified member with this email,
// not already linked to anyone else, is linked. Returns true when anything was added.
async function autoLinkByEmail(userId, email, links, hooks) {
  const have = new Set(links.map((l) => l.guildConfigId));
  const guilds = await hooks.executeQuery("SELECT id FROM granjur.guildconfig", []);
  let added = false;
  for (const g of guilds || []) {
    if (have.has(String(g.id))) continue;
    const found = await hooks.executeQuery(
      "SELECT discordId FROM granjur.guildmember WHERE guildConfigId = ? AND LOWER(email) = ? AND verifiedAt IS NOT NULL",
      [g.id, email]
    );
    if (!found || found.length !== 1) continue; // none, or two members share the email
    const discordId = String(found[0].discordId);
    const taken = await hooks.executeQuery(
      "SELECT user_id FROM discord_identity_link WHERE guild_config_id = ? AND discord_id = ?",
      [g.id, discordId]
    );
    if (taken && taken.length) continue;
    // IGNORE: a concurrent request may have linked it a moment ago; the re-read below decides.
    await hooks.executeQuery(
      "INSERT IGNORE INTO discord_identity_link (user_id, guild_config_id, discord_id, linked_via) VALUES (?, ?, ?, 'email')",
      [userId, g.id, discordId]
    );
    added = true;
  }
  return added;
}

async function linksFor(userId, email, hooks) {
  let links = await readLinks(userId, hooks);
  if (await autoLinkByEmail(userId, email, links, hooks)) links = await readLinks(userId, hooks);
  return links;
}

async function isDiscordLeader(links, hooks) {
  for (const l of links) {
    const rows = await hooks.executeQuery(
      "SELECT roleNames FROM granjur.guildmember WHERE guildConfigId = ? AND discordId = ? LIMIT 1",
      [l.guildConfigId, l.discordId]
    );
    if (parseList(rows?.[0]?.roleNames).some((n) => LEADERSHIP_ROLES.includes(n))) return true;
  }
  return false;
}

async function resolveIdentity(req, decryptedPayload, hooks) {
  const none = { userId: null, email: null, links: [], isAdmin: false, seesAll: false };
  const email = verifiedEmail(decryptedPayload);
  if (!email) return none;
  const userId = await userIdFor(email, hooks);
  const isAdmin = await isSiteAdmin(req, decryptedPayload, userId, hooks);
  if (userId === null) return { ...none, email, isAdmin, seesAll: isAdmin };
  const links = await linksFor(userId, email, hooks);
  const seesAll = isAdmin || (await isDiscordLeader(links, hooks));
  return { userId, email, links, isAdmin, seesAll };
}

// The time endpoints' "who am I" (timeScope.js). Same linking as resolveIdentity.
async function firstLinkForEmail(email, hooks) {
  const none = { guildConfigId: null, discordId: null };
  if (!email) return none;
  const userId = await userIdFor(email, hooks);
  if (userId === null) return none;
  const links = await linksFor(userId, email, hooks);
  return links[0] ? { guildConfigId: links[0].guildConfigId, discordId: links[0].discordId } : none;
}

async function linkByCode(identity, rawCode, hooks) {
  if (!identity || identity.userId === null || identity.userId === undefined) throw fail(401, MESSAGES.signIn);
  const code = String(rawCode || "").replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw fail(400, MESSAGES.badCode);
  let rows;
  try {
    rows = await hooks.executeQuery(
      "SELECT id, guildConfigId, discordId FROM granjur.discordlinkcode WHERE code = ? AND usedAt IS NULL AND expiresAt > NOW() LIMIT 1",
      [code]
    );
  } catch (e) {
    // The bot's migration 027 has not run yet.
    if (e && (e.code === "ER_NO_SUCH_TABLE" || /doesn't exist/i.test(String(e.message || "")))) throw fail(503, MESSAGES.codesUnavailable);
    throw e;
  }
  const row = rows && rows[0];
  if (!row) throw fail(400, MESSAGES.badCode);
  const guildConfigId = String(row.guildConfigId);
  const discordId = String(row.discordId);
  if (identity.links.some((l) => l.guildConfigId === guildConfigId)) throw fail(400, MESSAGES.alreadyLinked);
  const taken = await hooks.executeQuery(
    "SELECT user_id FROM discord_identity_link WHERE guild_config_id = ? AND discord_id = ?",
    [guildConfigId, discordId]
  );
  if (taken && taken.length && Number(taken[0].user_id) !== identity.userId) throw fail(400, MESSAGES.taken);
  try {
    await hooks.executeQuery(
      "INSERT INTO discord_identity_link (user_id, guild_config_id, discord_id, linked_via) VALUES (?, ?, ?, 'code')",
      [identity.userId, guildConfigId, discordId]
    );
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") throw fail(400, MESSAGES.taken);
    throw e;
  }
  // The one write CSAAS makes to the bot's database: the handshake table only.
  await hooks.executeQuery("UPDATE granjur.discordlinkcode SET usedAt = NOW() WHERE id = ?", [row.id]);
  return { guildConfigId, discordId, via: "code" };
}

async function listLinks(hooks) {
  const links = await hooks.executeQuery(
    "SELECT user_id, guild_config_id, discord_id, linked_via, linked_at FROM discord_identity_link ORDER BY linked_at DESC",
    []
  );
  if (!links || !links.length) return [];
  const userIds = [...new Set(links.map((l) => Number(l.user_id)))];
  const discordIds = [...new Set(links.map((l) => String(l.discord_id)))];
  const users = await hooks.executeQuery(
    `SELECT user_id, email, CONCAT_WS(' ', first_name, last_name) AS name FROM users WHERE user_id IN (${userIds.map(() => "?").join(", ")})`,
    userIds
  );
  const members = await hooks.executeQuery(
    `SELECT guildConfigId, discordId, displayName, username FROM granjur.guildmember WHERE discordId IN (${discordIds.map(() => "?").join(", ")})`,
    discordIds
  );
  const userBy = new Map((users || []).map((u) => [Number(u.user_id), u]));
  const memberBy = new Map((members || []).map((m) => [`${m.guildConfigId}:${m.discordId}`, m]));
  return links.map((l) => {
    const u = userBy.get(Number(l.user_id));
    const m = memberBy.get(`${l.guild_config_id}:${l.discord_id}`);
    return {
      userId: Number(l.user_id),
      email: u?.email ?? null,
      name: u?.name || null,
      guildConfigId: String(l.guild_config_id),
      discordId: String(l.discord_id),
      discordName: m?.displayName || m?.username || null,
      via: l.linked_via,
      linkedAt: l.linked_at ? new Date(l.linked_at).toISOString() : null,
    };
  });
}

async function unlink(userId, guildConfigId, hooks) {
  const res = await hooks.executeQuery(
    "DELETE FROM discord_identity_link WHERE user_id = ? AND guild_config_id = ?",
    [userId, guildConfigId]
  );
  return { removed: Number(res?.affectedRows || 0) };
}

module.exports = {
  LEADERSHIP_ROLES, MESSAGES, fail, verifiedEmail, parseList,
  resolveIdentity, firstLinkForEmail, linkByCode, listLinks, unlink,
};
```

- [ ] **Step 5: Run** — `node Services/SysScripts/TestScripts/discord-tasks-test/identity.test.js` → `identity.test.js: all assertions passed`.

- [ ] **Step 6: Commit**

```bash
git add data/migrations/20260929_1_discord_identity_link.sql Src/Apis/ProjectSpecificApis/DiscordTasks/identity.js Services/SysScripts/TestScripts/discord-tasks-test/identity.test.js
git commit -m "feat(identity): stored Discord link, auto-link by verified email, code linking

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Visibility and the scoped tasks read

**Files:**
- Create: `Src/Apis/ProjectSpecificApis/DiscordTasks/visibility.js`
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js` (`idList`/`holdersOf` imported from `visibility.js`; `assembleTasks` takes `visibility`; `getDiscordTasks` resolves identity; the object gains `bindActorToToken: true`)
- Create: `Services/SysScripts/TestScripts/discord-tasks-test/visibility.test.js`
- Modify: `Services/SysScripts/TestScripts/discord-tasks-test/avatarFallback.test.js` and `repos.test.js` (add a `resolveIdentity` hook — see Step 6)

**Interfaces:**
- Consumes: `resolveIdentity` (Task 3); `actorIsRoleAdmin` from `portalAuthz.js`.
- Produces from `visibility.js`:
  - `HIDDEN_TITLE = 'A task in another project'`; `idList(v)`; `holdersOf(task)`; `keyOf(guildConfigId, discordId)`; `viewerKeys(links) → Set<string>`; `holdsTask(task, keys) → boolean` (either column).
  - `computeVisibility({ tasks, projectMembers, keys }) → { projectIds: Set<string>, taskIds: Set<string> }`.
  - `hiddenRef(row) → { id, title: HIDDEN_TITLE, status, hidden: true }`.
  - `taskRow(taskId, hooks)`, `projectRow(projectId, hooks)`, `projectVisible(identity, guildConfigId, projectId, hooks)`, `assertCanTouchTask(identity, taskId, hooks) → row|null`, `assertCanUseProject(identity, projectId, hooks) → row|null`, `visibleProjectIdsFor(identity, hooks) → Set<string>`, `linkedDiscordId(identity, guildConfigId) → string|null` (Tasks 6 and 7 use these).
- `assembleTasks({ ..., visibility = null })`: with `visibility`, only visible tasks are grouped and shaped, only visible projects listed, references to invisible tasks become `hiddenRef`s (subtask refs also get `assignees: []`), and `members[].projects` is trimmed to visible projects. With `null`, output is exactly as before.
- `getDiscordTasks(req, decryptedPayload)` returns the old payload plus `viewer: { linked, seesAll, isAdmin, discordIds, name }`.

- [ ] **Step 1: Write the failing test** — `Services/SysScripts/TestScripts/discord-tasks-test/visibility.test.js`:

```js
const assert = require("assert");
const vis = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/visibility");
const { assembleTasks, getDiscordTasks, __setTestHooks } = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks");

const guilds = [{ id: "g1", guildId: "1000" }];
const projects = [
  { id: "P1", guildConfigId: "g1", name: "Framework", docsSlug: "framework" },
  { id: "P2", guildConfigId: "g1", name: "Secret", docsSlug: "secret" },
  { id: "P3", guildConfigId: "g1", name: "Assigned", docsSlug: "assigned" },
];
const t = (id, projectId, extra = {}) => ({ id, guildConfigId: "g1", projectId, title: `Task ${id}`, type: "feature", status: "open", assigneeIds: "[]", taggedMemberIds: "[]", createdAt: "2026-09-01", updatedAt: "2026-09-02", ...extra });
const tasks = [
  t("A", "P1"),
  t("B", "P2", { title: "Top secret" }),
  t("C", "P3", { assigneeIds: '["me"]' }),
  t("D", null, { assigneeIds: '["me"]' }),
  t("E", null, { assigneeIds: '["other"]' }),
  t("F", "P1", { parentTaskId: "A" }),
];
const deps = [{ taskId: "A", blockedByTaskId: "B" }];
const projectMembers = [{ guildConfigId: "g1", projectId: "P1", discordId: "me", role: "developer" }, { guildConfigId: "g1", projectId: "P2", discordId: "other", role: "lead" }];
const names = [
  { guildConfigId: "g1", discordId: "me", displayName: "Me", username: "me", roleNames: null, status: "approved", verifiedAt: new Date() },
  { guildConfigId: "g1", discordId: "other", displayName: "Other", username: "other", roleNames: null, status: "approved", verifiedAt: new Date() },
];

async function run() {
  const keys = vis.viewerKeys([{ guildConfigId: "g1", discordId: "me" }]);
  const v = vis.computeVisibility({ tasks, projectMembers, keys });
  assert.deepStrictEqual([...v.projectIds].sort(), ["P1", "P3"], "explicit member of P1, assignee in P3; not P2");
  assert.deepStrictEqual([...v.taskIds].sort(), ["A", "C", "D", "F"], "all of P1 and P3, plus the project-less task I hold");

  const out = assembleTasks({ guilds, projects, tasks, deps, members: projectMembers, names, visibility: v });
  const ids = out.projects.map((p) => p.id);
  assert.ok(ids.includes("P1") && ids.includes("P3") && !ids.includes("P2"));
  const orphan = out.projects.find((p) => p.id === null);
  assert.deepStrictEqual(orphan.tasks.map((x) => x.id), ["D"], "only my project-less task");
  assert.strictEqual(orphan.counts.open, 1);
  const A = out.projects.find((p) => p.id === "P1").tasks.find((x) => x.id === "A");
  assert.deepStrictEqual(A.blockedBy, [{ id: "B", title: "A task in another project", status: "open", hidden: true }]);
  assert.strictEqual(A.isBlocked, true, "blocked state still correct");
  assert.ok(!JSON.stringify(out).includes("Top secret"), "the hidden title never leaves");
  const other = out.members.find((m) => m.discordId === "other");
  assert.deepStrictEqual(other.projects, [], "another member's projects are trimmed to mine");
  assert.strictEqual(out.members.length, 2, "the roster stays complete");

  // No visibility: the output is exactly as before.
  const full = assembleTasks({ guilds, projects, tasks, deps, members: projectMembers, names });
  assert.ok(full.projects.some((p) => p.id === "P2"));
  assert.strictEqual(full.projects.find((p) => p.id === "P1").tasks.find((x) => x.id === "A").blockedBy[0].title, "Top secret");

  // getDiscordTasks: unlinked → empty payload with viewer; seesAll → everything.
  const q = async (sql) => {
    if (sql.includes("FROM granjur.guildconfig")) return guilds;
    if (sql.includes("FROM granjur.project ")) return projects;
    if (sql.includes("FROM granjur.task ")) return tasks;
    if (sql.includes("FROM granjur.taskdependency")) return deps;
    if (sql.includes("FROM granjur.projectmember")) return projectMembers;
    if (sql.includes("FROM granjur.guildmember")) return names;
    return [];
  };
  __setTestHooks({ executeQuery: q, resolveIdentity: async () => ({ userId: 5, email: "a@x", links: [], isAdmin: false, seesAll: false }) });
  let res = await getDiscordTasks({ query: {} }, {});
  assert.deepStrictEqual(res.projects, []);
  assert.deepStrictEqual(res.members, []);
  assert.deepStrictEqual(res.viewer, { linked: false, seesAll: false, isAdmin: false, discordIds: [], name: null });
  __setTestHooks({ resolveIdentity: async () => ({ userId: 5, email: "a@x", links: [{ guildConfigId: "g1", discordId: "me", via: "email" }], isAdmin: false, seesAll: false }) });
  res = await getDiscordTasks({ query: {} }, {});
  assert.ok(!res.projects.some((p) => p.id === "P2"));
  assert.deepStrictEqual(res.viewer, { linked: true, seesAll: false, isAdmin: false, discordIds: ["me"], name: "Me" });
  __setTestHooks({ resolveIdentity: async () => ({ userId: 1, email: "boss@x", links: [], isAdmin: true, seesAll: true }) });
  res = await getDiscordTasks({ query: {} }, {});
  assert.ok(res.projects.some((p) => p.id === "P2"));
  assert.strictEqual(res.viewer.seesAll, true);

  // Write-side helpers.
  const calls = [];
  const hooks = { executeQuery: async (sql, p) => {
    calls.push(sql);
    if (sql.includes("FROM granjur.task WHERE id = ?")) return tasks.filter((x) => x.id === p[0]);
    if (sql.includes("FROM granjur.project WHERE id = ?")) return projects.filter((x) => x.id === p[0]);
    if (sql.includes("FROM granjur.projectmember WHERE guildConfigId = ? AND projectId = ?")) return projectMembers.filter((m) => m.projectId === p[1] && p.slice(2).includes(m.discordId));
    if (sql.includes("FROM granjur.task WHERE guildConfigId = ? AND projectId = ?")) return tasks.filter((x) => x.projectId === p[1]);
    if (sql.includes("FROM granjur.projectmember WHERE guildConfigId = ? AND discordId = ?")) return projectMembers.filter((m) => m.discordId === p[1]);
    if (sql.includes("FROM granjur.task WHERE guildConfigId = ? AND projectId IS NOT NULL")) return tasks.filter((x) => x.projectId);
    return [];
  } };
  const me = { userId: 5, links: [{ guildConfigId: "g1", discordId: "me", via: "email" }], seesAll: false };
  assert.strictEqual((await vis.assertCanTouchTask(me, "A", hooks)).id, "A");
  assert.strictEqual((await vis.assertCanTouchTask(me, "C", hooks)).id, "C");
  assert.strictEqual((await vis.assertCanTouchTask(me, "D", hooks)).id, "D");
  let e; try { await vis.assertCanTouchTask(me, "B", hooks); } catch (x) { e = x; }
  assert.deepStrictEqual(e, { statusCode: 403, message: "You can only change tasks in projects you are part of." });
  e = null; try { await vis.assertCanTouchTask(me, "E", hooks); } catch (x) { e = x; }
  assert.strictEqual(e.statusCode, 403);
  assert.strictEqual(await vis.assertCanTouchTask(me, "ZZ", hooks), null, "a missing task is the bot's 404 to give");
  assert.strictEqual((await vis.assertCanUseProject(me, "P1", hooks)).id, "P1");
  e = null; try { await vis.assertCanUseProject(me, "P2", hooks); } catch (x) { e = x; }
  assert.strictEqual(e.statusCode, 403);
  assert.strictEqual(await vis.assertCanTouchTask({ ...me, seesAll: true }, "B", hooks), null, "seesAll skips the check");
  assert.deepStrictEqual([...(await vis.visibleProjectIdsFor(me, hooks))].sort(), ["P1", "P3"]);
  assert.strictEqual(vis.linkedDiscordId(me, "g1"), "me");
  assert.strictEqual(vis.linkedDiscordId(me, "g9"), null);

  console.log("visibility.test.js: all assertions passed");
}
run().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node Services/SysScripts/TestScripts/discord-tasks-test/visibility.test.js`
Expected: FAIL — cannot find `visibility`.

- [ ] **Step 3: Write `Src/Apis/ProjectSpecificApis/DiscordTasks/visibility.js`:**

```js
// Which Discord projects and tasks a site user may see and change (identity link,
// 2026-09-28). "My project" = a projectmember row for me, or a task in it I hold
// (assigneeIds or taggedMemberIds). Pure functions first; the write-side helpers
// below read only the rows they need, through the caller's hooks.

const HIDDEN_TITLE = "A task in another project";
const NOT_YOURS = "You can only change tasks in projects you are part of.";
const fail = (statusCode, message) => ({ statusCode, message });

function idList(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (typeof v === "string" && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter(Boolean).map(String) : []; } catch { return []; } }
  return [];
}
const holdersOf = (t) => { const a = idList(t.assigneeIds); return a.length ? a : idList(t.taggedMemberIds); };
const keyOf = (guildConfigId, discordId) => `${guildConfigId}:${discordId}`;
const viewerKeys = (links) => new Set((links || []).map((l) => keyOf(l.guildConfigId, l.discordId)));

function holdsTask(task, keys) {
  const ids = [...idList(task.assigneeIds), ...idList(task.taggedMemberIds)];
  return ids.some((id) => keys.has(keyOf(task.guildConfigId, id)));
}

function computeVisibility({ tasks = [], projectMembers = [], keys }) {
  const projectIds = new Set();
  for (const m of projectMembers) if (keys.has(keyOf(m.guildConfigId, m.discordId))) projectIds.add(String(m.projectId));
  for (const t of tasks) if (t.projectId && holdsTask(t, keys)) projectIds.add(String(t.projectId));
  const taskIds = new Set();
  for (const t of tasks) {
    if (t.projectId ? projectIds.has(String(t.projectId)) : holdsTask(t, keys)) taskIds.add(String(t.id));
  }
  return { projectIds, taskIds };
}

const hiddenRef = (row) => ({ id: row.id, title: HIDDEN_TITLE, status: row.status, hidden: true });

async function taskRow(taskId, hooks) {
  const rows = await hooks.executeQuery(
    "SELECT id, guildConfigId, projectId, assigneeIds, taggedMemberIds FROM granjur.task WHERE id = ? LIMIT 1", [taskId]);
  return rows && rows[0] ? rows[0] : null;
}
async function projectRow(projectId, hooks) {
  const rows = await hooks.executeQuery("SELECT id, guildConfigId FROM granjur.project WHERE id = ? LIMIT 1", [projectId]);
  return rows && rows[0] ? rows[0] : null;
}

function linkedDiscordId(identity, guildConfigId) {
  const l = (identity?.links || []).find((x) => x.guildConfigId === String(guildConfigId));
  return l ? l.discordId : null;
}

async function projectVisible(identity, guildConfigId, projectId, hooks) {
  const discordIds = (identity.links || []).filter((l) => l.guildConfigId === String(guildConfigId)).map((l) => l.discordId);
  if (!discordIds.length) return false;
  const member = await hooks.executeQuery(
    `SELECT 1 FROM granjur.projectmember WHERE guildConfigId = ? AND projectId = ? AND discordId IN (${discordIds.map(() => "?").join(", ")}) LIMIT 1`,
    [guildConfigId, projectId, ...discordIds]);
  if (member && member.length) return true;
  const inProject = await hooks.executeQuery(
    "SELECT guildConfigId, assigneeIds, taggedMemberIds FROM granjur.task WHERE guildConfigId = ? AND projectId = ?",
    [guildConfigId, projectId]);
  const keys = viewerKeys(identity.links);
  return (inProject || []).some((t) => holdsTask(t, keys));
}

// The task row when the caller may change it; null when the task does not exist
// (the bot answers 404); throws 403 otherwise. seesAll skips the check (null).
async function assertCanTouchTask(identity, taskId, hooks) {
  if (identity.seesAll) return null;
  const row = await taskRow(taskId, hooks);
  if (!row) return null;
  const ok = row.projectId
    ? await projectVisible(identity, row.guildConfigId, row.projectId, hooks)
    : holdsTask(row, viewerKeys(identity.links));
  if (!ok) throw fail(403, NOT_YOURS);
  return row;
}

async function assertCanUseProject(identity, projectId, hooks) {
  if (identity.seesAll) return null;
  const row = await projectRow(projectId, hooks);
  if (!row) return null; // the bot refuses an unknown project in its own words
  if (!(await projectVisible(identity, row.guildConfigId, row.id, hooks))) throw fail(403, NOT_YOURS);
  return row;
}

// For the stats endpoint: every project id the caller can see, across their links.
async function visibleProjectIdsFor(identity, hooks) {
  const out = new Set();
  const keys = viewerKeys(identity.links);
  for (const l of identity.links || []) {
    const pm = await hooks.executeQuery(
      "SELECT projectId FROM granjur.projectmember WHERE guildConfigId = ? AND discordId = ?", [l.guildConfigId, l.discordId]);
    for (const r of pm || []) out.add(String(r.projectId));
    const ts = await hooks.executeQuery(
      "SELECT projectId, guildConfigId, assigneeIds, taggedMemberIds FROM granjur.task WHERE guildConfigId = ? AND projectId IS NOT NULL", [l.guildConfigId]);
    for (const t of ts || []) if (holdsTask(t, keys)) out.add(String(t.projectId));
  }
  return out;
}

module.exports = {
  HIDDEN_TITLE, NOT_YOURS, idList, holdersOf, keyOf, viewerKeys, holdsTask, computeVisibility, hiddenRef,
  taskRow, projectRow, linkedDiscordId, projectVisible, assertCanTouchTask, assertCanUseProject, visibleProjectIdsFor,
};
```

- [ ] **Step 4: Scope `assembleTasks` in `discordTasks.js`.**
  - Delete its local `idList` and `holdersOf` and add `const { idList, holdersOf, hiddenRef, computeVisibility, viewerKeys } = require("./visibility");` (they are byte-for-byte the same functions).
  - Add `visibility = null` to `assembleTasks`'s destructured parameter and, right after `taskById` is built: `const visible = (id) => !visibility || visibility.taskIds.has(String(id));`
  - In the `deps` loop, push `visible(blocker.id) ? { id: blocker.id, title: blocker.title ?? '', status: blocker.status } : hiddenRef(blocker)` into `blockedByOf`, and `visible(blocked.id) ? { id: blocked.id, title: blocked.title ?? '' } : hiddenRef(blocked)` into `blocksOf`.
  - In `shapeTask`: `parent: parentRow ? (visible(parentRow.id) ? { id: parentRow.id, title: parentRow.title ?? '', status: parentRow.status } : hiddenRef(parentRow)) : null,` and each subtask `visible(k.id) ? { …as today… } : { ...hiddenRef(k), assignees: [] }`.
  - In the `byProject`/`orphans` loop, skip invisible tasks first: `if (!visible(t.id)) continue;`
  - Where the output project list is built from `projects`, use `(visibility ? projects.filter((p) => visibility.projectIds.has(String(p.id))) : projects)`.
  - In `membersOut`'s `projects` filter add `&& (!visibility || visibility.projectIds.has(String(m.projectId)))`.
  - Emit an orphan group only when it has tasks (already the case: `if (orphans.length)`).

- [ ] **Step 5: Scope `getDiscordTasks`.** Add to `__hooks`: `resolveIdentity: (...a) => require("./identity").resolveIdentity(...a)` and `actorIsRoleAdmin: (...a) => require("../../../HelperFunctions/PreProcessingFunctions/ProjectTenancy/portalAuthz").actorIsRoleAdmin(...a)` (lazy requires keep the module graph unchanged at load). Change the signature to `async function getDiscordTasks(req, decryptedPayload)` and:

```js
  const identity = await __hooks.resolveIdentity(req, decryptedPayload, __hooks);
  const viewerOf = (nameRows) => {
    const first = identity.links[0];
    const row = first ? (nameRows || []).find((n) => String(n.guildConfigId) === first.guildConfigId && String(n.discordId) === first.discordId) : null;
    return {
      linked: identity.links.length > 0,
      seesAll: !!identity.seesAll,
      isAdmin: !!identity.isAdmin,
      discordIds: identity.links.map((l) => l.discordId),
      name: row ? (row.displayName || row.username || null) : null,
    };
  };
  // Not linked and not allowed to see everything: nothing to show but the link card.
  if (!identity.seesAll && identity.links.length === 0) return { ...assembleTasks({}), viewer: viewerOf([]) };
```
then keep the existing body, with two changes: when `!identity.seesAll`, restrict the guild list to the caller's linked guilds (`guilds.filter((g) => identity.links.some((l) => l.guildConfigId === String(g.id)))`), and replace the final return with:

```js
  const visibility = identity.seesAll ? null : computeVisibility({ tasks, projectMembers: members, keys: viewerKeys(identity.links) });
  return { ...assembleTasks({ guilds, projects, tasks, deps, members, names, activity, time, repositories, visibility }), viewer: viewerOf(names) };
```
(Use the actual local variable names in the file — the `projectmember` rows are destructured as `members`.) In `DiscordTasks_object`, set `requestMetaData: { requestMethod: "GET", permission: null, bindActorToToken: true }` and update the comment above `verification` to say the read now binds the actor to scope it.

- [ ] **Step 6: Keep the existing read tests meaningful.** `avatarFallback.test.js` and `repos.test.js` call `getDiscordTasks` with no identity; with this change they would get the unlinked empty payload. Add `resolveIdentity: async () => ({ userId: 1, email: "admin@x", links: [], isAdmin: true, seesAll: true })` to each file's `__setTestHooks({...})` call(s). Change nothing else in them.

- [ ] **Step 7: Run every discord-tasks script**

Run: `for f in Services/SysScripts/TestScripts/discord-tasks-test/*.test.js; do node "$f" || echo "FAILED: $f"; done`
Expected: every file prints `… all assertions passed`, no `FAILED:`.

- [ ] **Step 8: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/visibility.js Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasks.js Services/SysScripts/TestScripts/discord-tasks-test/visibility.test.js Services/SysScripts/TestScripts/discord-tasks-test/avatarFallback.test.js Services/SysScripts/TestScripts/discord-tasks-test/repos.test.js
git commit -m "feat(discord-tasks): the tasks read shows only the caller's projects

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Identity endpoints

**Files:**
- Create: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordIdentity.js`
- Create: `Services/SysScripts/TestScripts/discord-tasks-test/identityRoutes.test.js`

**Interfaces:**
- Consumes: `resolveIdentity`, `linkByCode`, `listLinks`, `unlink`, `MESSAGES`, `fail` (Task 3).
- Produces (site-facing; `accessToken: true`, `bindActorToToken: true`, `permission: null`; responses unwrapped by the site as `payload.return`):
  - `GET /api/discord/identity/me` → `{ linked, seesAll, isAdmin, links: [{ guildConfigId, discordId, name, via }] }`
  - `POST /api/discord/identity/link` `{ code }` → same shape as `/me`, after linking.
  - `GET /api/discord/identity/links` (admins) → `{ links: [...listLinks rows] }`
  - `POST /api/discord/identity/unlink` `{ user_id, guild_config_id }` (admins) → `{ removed }`
  - Globals `DiscordIdentityMe_object`, `DiscordIdentityLink_object`, `DiscordIdentityLinks_object`, `DiscordIdentityUnlink_object`; exports `getMe`, `postLink`, `getLinks`, `postUnlink`, `__setTestHooks`.

- [ ] **Step 1: Write the failing test** — `Services/SysScripts/TestScripts/discord-tasks-test/identityRoutes.test.js`:

```js
const assert = require("assert");
const mod = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/discordIdentity");
const { getMe, postLink, getLinks, postUnlink, __setTestHooks } = mod;
const { MESSAGES } = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/identity");

async function thrown(fn) { try { await fn(); } catch (e) { return e; } throw new assert.AssertionError({ message: "expected a rejection" }); }
const me = { userId: 5, email: "a@granjur.com", links: [{ guildConfigId: "g1", discordId: "111", via: "email" }], isAdmin: false, seesAll: false };

async function run() {
  for (const [name, method, fields] of [
    ["DiscordIdentityMe_object", "GET", []],
    ["DiscordIdentityLink_object", "POST", ["code"]],
    ["DiscordIdentityLinks_object", "GET", []],
    ["DiscordIdentityUnlink_object", "POST", ["user_id", "guild_config_id"]],
  ]) {
    const step = global[name].versions.versionData[0]["*"].steps[0];
    assert.strictEqual(step.data.requestMetaData.requestMethod, method, name);
    assert.strictEqual(step.data.requestMetaData.permission, null, name);
    assert.strictEqual(step.data.requestMetaData.bindActorToToken, true, name);
    assert.strictEqual(step.config.verification.accessToken, true, name);
    assert.deepStrictEqual(step.data.parameters.fields, fields, name);
  }

  const q = async (sql, p) => (sql.includes("displayName, username FROM granjur.guildmember WHERE guildConfigId = ? AND discordId = ?") ? [{ displayName: "Aashir", username: "aashir" }] : []);
  __setTestHooks({ executeQuery: q, resolveIdentity: async () => me });
  assert.deepStrictEqual(await getMe({}, {}), { linked: true, seesAll: false, isAdmin: false, links: [{ guildConfigId: "g1", discordId: "111", name: "Aashir", via: "email" }] });

  let linkedWith = null;
  __setTestHooks({
    resolveIdentity: async () => (linkedWith ? { ...me, links: [...me.links, linkedWith] } : { ...me, links: [] }),
    linkByCode: async (identity, code) => { assert.strictEqual(identity.userId, 5); assert.strictEqual(code, "ABC234"); linkedWith = { guildConfigId: "g1", discordId: "111", via: "code" }; return linkedWith; },
  });
  const after = await postLink({}, { code: "ABC234" });
  assert.strictEqual(after.linked, true);
  assert.strictEqual(after.links[after.links.length - 1].via, "code");
  assert.deepStrictEqual(await thrown(() => postLink({}, { code: 5 })), { statusCode: 400, message: MESSAGES.badCode });

  __setTestHooks({ resolveIdentity: async () => me });
  assert.deepStrictEqual(await thrown(() => getLinks({}, {})), { statusCode: 403, message: MESSAGES.notAdmin });
  assert.deepStrictEqual(await thrown(() => postUnlink({}, { user_id: 5, guild_config_id: "g1" })), { statusCode: 403, message: MESSAGES.notAdmin });

  let removed = null;
  __setTestHooks({
    resolveIdentity: async () => ({ ...me, isAdmin: true, seesAll: true }),
    listLinks: async () => [{ userId: 5 }],
    unlink: async (userId, guildConfigId) => { removed = [userId, guildConfigId]; return { removed: 1 }; },
  });
  assert.deepStrictEqual(await getLinks({}, {}), { links: [{ userId: 5 }] });
  assert.deepStrictEqual(await postUnlink({}, { user_id: 0, guild_config_id: "g1" }), { removed: 1 });
  assert.deepStrictEqual(removed, [0, "g1"], "user 0 is a real account");
  for (const bad of [{ user_id: "5", guild_config_id: "g1" }, { user_id: -1, guild_config_id: "g1" }, { user_id: 5 }, { user_id: 5, guild_config_id: "x".repeat(37) }]) {
    const e = await thrown(() => postUnlink({}, bad));
    assert.strictEqual(e.statusCode, 400, JSON.stringify(bad));
  }
  console.log("identityRoutes.test.js: all assertions passed");
}
run().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails** — `node Services/SysScripts/TestScripts/discord-tasks-test/identityRoutes.test.js` → FAIL (module missing).

- [ ] **Step 3: Write `Src/Apis/ProjectSpecificApis/DiscordTasks/discordIdentity.js`:**

```js
const { executeQuery } = require("../../../../Services/Integrations/Database/queryExecution");
const identity = require("./identity");

// GET  /api/discord/identity/me       who am I in Discord (links, seesAll, isAdmin)
// POST /api/discord/identity/link     { code }  redeem a /link code from Discord
// GET  /api/discord/identity/links    (site admins) every stored link
// POST /api/discord/identity/unlink   (site admins) { user_id, guild_config_id }
// Sign-in is the only gate on /me and /link (accessToken + bindActorToToken); the
// admin pair checks isAdmin itself. See identity.js for how links are made.

const __hooks = {
  executeQuery: (...a) => executeQuery(...a),
  actorIsRoleAdmin: (...a) => require("../../../HelperFunctions/PreProcessingFunctions/ProjectTenancy/portalAuthz").actorIsRoleAdmin(...a),
  resolveIdentity: (...a) => identity.resolveIdentity(...a),
  linkByCode: (...a) => identity.linkByCode(...a),
  listLinks: (...a) => identity.listLinks(...a),
  unlink: (...a) => identity.unlink(...a),
};
function __setTestHooks(overrides) { Object.assign(__hooks, overrides); }
const { fail, MESSAGES } = identity;

async function describe(who) {
  const links = [];
  for (const l of who.links) {
    let name = null;
    try {
      const rows = await __hooks.executeQuery(
        "SELECT displayName, username FROM granjur.guildmember WHERE guildConfigId = ? AND discordId = ? LIMIT 1",
        [l.guildConfigId, l.discordId]);
      name = rows?.[0]?.displayName || rows?.[0]?.username || null;
    } catch (_) { name = null; }
    links.push({ guildConfigId: l.guildConfigId, discordId: l.discordId, name, via: l.via });
  }
  return { linked: links.length > 0, seesAll: !!who.seesAll, isAdmin: !!who.isAdmin, links };
}

async function getMe(req, decryptedPayload) {
  return describe(await __hooks.resolveIdentity(req, decryptedPayload, __hooks));
}

async function postLink(req, decryptedPayload) {
  const code = decryptedPayload?.code;
  if (typeof code !== "string") throw fail(400, MESSAGES.badCode);
  const who = await __hooks.resolveIdentity(req, decryptedPayload, __hooks);
  await __hooks.linkByCode(who, code, __hooks);
  console.log(`[discord-identity] ${who.email || "unknown"} linked by code`);
  return describe(await __hooks.resolveIdentity(req, decryptedPayload, __hooks));
}

async function requireAdmin(req, decryptedPayload) {
  const who = await __hooks.resolveIdentity(req, decryptedPayload, __hooks);
  if (!who.isAdmin) throw fail(403, MESSAGES.notAdmin);
  return who;
}

async function getLinks(req, decryptedPayload) {
  await requireAdmin(req, decryptedPayload);
  return { links: await __hooks.listLinks(__hooks) };
}

async function postUnlink(req, decryptedPayload) {
  const who = await requireAdmin(req, decryptedPayload);
  const userId = decryptedPayload?.user_id;
  const guildConfigId = decryptedPayload?.guild_config_id;
  if (!Number.isInteger(userId) || userId < 0) throw fail(400, "user_id must be a whole number");
  if (typeof guildConfigId !== "string" || !guildConfigId.trim() || guildConfigId.length > 36) throw fail(400, "guild_config_id is required");
  const result = await __hooks.unlink(userId, guildConfigId.trim(), __hooks);
  console.log(`[discord-identity] ${who.email || "unknown"} unlinked user ${userId} in ${guildConfigId}`);
  return result;
}

function identityObject(method, fields, handler, successMessage, errorMessage) {
  return {
    versions: { versionData: [{ "*": { steps: [{
      config: {
        features: { multistep: false, parameters: false, pagination: false },
        communication: { encryption: false },
        verification: { otp: false, accessToken: true },
      },
      data: {
        parameters: { fields },
        apiInfo: { preProcessFunctions: [], query: { queryPayload: null, database: () => "main" }, postProcessFunction: handler },
        requestMetaData: { requestMethod: method, permission: null, bindActorToToken: true },
      },
      response: { successMessage, errorMessage },
    }] } }] },
  };
}

global.DiscordIdentityMe_object = identityObject("GET", [], getMe, "Identity retrieved", "Failed to read your Discord link");
global.DiscordIdentityLink_object = identityObject("POST", ["code"], postLink, "Discord account linked", "Failed to link your Discord account");
global.DiscordIdentityLinks_object = identityObject("GET", [], getLinks, "Links retrieved", "Failed to read account links");
global.DiscordIdentityUnlink_object = identityObject("POST", ["user_id", "guild_config_id"], postUnlink, "Link removed", "Failed to remove the link");

module.exports = {
  DiscordIdentityMe_object: global.DiscordIdentityMe_object,
  DiscordIdentityLink_object: global.DiscordIdentityLink_object,
  DiscordIdentityLinks_object: global.DiscordIdentityLinks_object,
  DiscordIdentityUnlink_object: global.DiscordIdentityUnlink_object,
  getMe, postLink, getLinks, postUnlink, __setTestHooks,
};
```

- [ ] **Step 4: Run** `identityRoutes.test.js` and `identity.test.js` → both pass. Use the Grep tool to confirm the four globals are declared only in `discordIdentity.js`.

- [ ] **Step 5: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/discordIdentity.js Services/SysScripts/TestScripts/discord-tasks-test/identityRoutes.test.js
git commit -m "feat(identity): me, link-by-code and admin link endpoints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Writes only inside your projects

**Files:**
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksStatus.js`
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksWrite.js`
- Modify: `Services/SysScripts/TestScripts/discord-tasks-test/status.test.js` and `write.test.js` (add a `resolveIdentity` hook to each file's `hooks()` helper — see Step 4)
- Create: `Services/SysScripts/TestScripts/discord-tasks-test/writeScope.test.js`

**Interfaces:**
- Consumes: `resolveIdentity` (Task 3); `assertCanTouchTask`, `assertCanUseProject`, `linkedDiscordId` (Task 4).
- Produces: every write keeps `requirePortalPermission(..., "update_discord_tasks")` first, then shape checks as today, then (unless `seesAll`):
  - `/status`, `/update`: `assertCanTouchTask(identity, taskId)`; an `/update` with `changes.project_id` set (non-null) also `assertCanUseProject(identity, project_id)`.
  - `/subtask`: `assertCanTouchTask(identity, parentId)`.
  - `/create`: `assertCanUseProject(identity, project_id)` when `project_id` is given (a missing one is the bot's refusal).
  - The actor sent to the bot gains `discordId` = `linkedDiscordId(identity, <task or project guildConfigId>)` when non-null; the key is omitted otherwise (so today's bodies are unchanged for callers with no link).

- [ ] **Step 1: Write the failing test** — `Services/SysScripts/TestScripts/discord-tasks-test/writeScope.test.js`:

```js
const assert = require("assert");
const status = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksStatus");
const write = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksWrite");

const tasks = { A: { id: "A", guildConfigId: "g1", projectId: "P1", assigneeIds: "[]", taggedMemberIds: "[]" }, B: { id: "B", guildConfigId: "g1", projectId: "P2", assigneeIds: "[]", taggedMemberIds: "[]" } };
const projects = { P1: { id: "P1", guildConfigId: "g1" }, P2: { id: "P2", guildConfigId: "g1" } };
const executeQuery = async (sql, p) => {
  if (sql.includes("FROM granjur.task WHERE id = ?")) return tasks[p[0]] ? [tasks[p[0]]] : [];
  if (sql.includes("FROM granjur.project WHERE id = ?")) return projects[p[0]] ? [projects[p[0]]] : [];
  if (sql.includes("FROM granjur.projectmember WHERE guildConfigId = ? AND projectId = ?")) return p[1] === "P1" ? [{ 1: 1 }] : [];
  if (sql.includes("FROM granjur.task WHERE guildConfigId = ? AND projectId = ?")) return [];
  return [{ name: "Aashir Khan" }];
};
const me = { userId: 5, email: "a@granjur.com", links: [{ guildConfigId: "g1", discordId: "111", via: "email" }], isAdmin: false, seesAll: false };
const env = () => ({ DISCORD_BOT_SECRET: "s3cret", DISCORD_BOT_URL: "http://127.0.0.1:4070" });
function wire(mod, who = me) {
  const calls = [];
  mod.__setTestHooks({
    requirePortalPermission: async () => ({ urddId: 7 }),
    resolveIdentity: async () => who,
    executeQuery,
    env,
    fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { status: 200, ok: true, json: async () => ({ ok: true, task: { id: "x", status: "open" } }) }; },
  });
  return calls;
}
const who = { actor_email: "a@granjur.com", __identityVerified: true };
async function thrown(fn) { try { await fn(); } catch (e) { return e; } throw new assert.AssertionError({ message: "expected a rejection" }); }
const NOT_YOURS = { statusCode: 403, message: "You can only change tasks in projects you are part of." };

async function run() {
  // Inside my project: allowed, and the bot gets my linked Discord id.
  let calls = wire(status);
  await status.setTaskStatus({}, { ...who, task_id: "A", status: "done" });
  assert.strictEqual(calls[0].body.actor.discordId, "111");
  // Outside: refused before any bot call.
  calls = wire(status);
  assert.deepStrictEqual(await thrown(() => status.setTaskStatus({}, { ...who, task_id: "B", status: "done" })), NOT_YOURS);
  assert.strictEqual(calls.length, 0);

  calls = wire(write);
  await write.updateTask({}, { ...who, task_id: "A", changes: { title: "x" } });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(await thrown(() => write.updateTask({}, { ...who, task_id: "B", changes: { title: "x" } })), NOT_YOURS);
  assert.deepStrictEqual(await thrown(() => write.updateTask({}, { ...who, task_id: "A", changes: { project_id: "P2" } })), NOT_YOURS, "cannot move a task into a project you are not part of");
  await write.updateTask({}, { ...who, task_id: "A", changes: { project_id: null } });

  assert.deepStrictEqual(await thrown(() => write.addSubtask({}, { ...who, parent_id: "B", title: "x" })), NOT_YOURS);
  await write.addSubtask({}, { ...who, parent_id: "A", title: "x" });

  assert.deepStrictEqual(await thrown(() => write.createTask({}, { ...who, type: "feature", title: "x", project_id: "P2" })), NOT_YOURS);
  calls = wire(write);
  await write.createTask({}, { ...who, type: "feature", title: "x", project_id: "P1" });
  assert.strictEqual(calls[0].body.actor.discordId, "111");

  // seesAll: everything allowed; no link means no discordId key.
  calls = wire(status, { ...me, links: [], isAdmin: true, seesAll: true });
  await status.setTaskStatus({}, { ...who, task_id: "B", status: "done" });
  assert.strictEqual("discordId" in calls[0].body.actor, false);

  console.log("writeScope.test.js: all assertions passed");
}
run().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails** — `node Services/SysScripts/TestScripts/discord-tasks-test/writeScope.test.js` → FAIL (the B status write is not refused).

- [ ] **Step 3: Implement.** In both handler modules add to `__hooks`: `resolveIdentity: (...a) => require("./identity").resolveIdentity(...a)` and `actorIsRoleAdmin: (...a) => require("../../../HelperFunctions/PreProcessingFunctions/ProjectTenancy/portalAuthz").actorIsRoleAdmin(...a)`, and `const { assertCanTouchTask, assertCanUseProject, linkedDiscordId } = require("./visibility");`. Add one helper per file:

```js
// The actor the bot records: the verified name/email, plus the caller's stored
// Discord link in that server when there is one (the bot then skips its email guess).
function withLink(actor, identity, guildConfigId) {
  const discordId = guildConfigId ? linkedDiscordId(identity, guildConfigId) : (identity.links[0]?.discordId ?? null);
  return discordId ? { ...actor, discordId } : actor;
}
```
Then, in each handler, after its existing shape validation and before `botConfig(__hooks)`:
- `setTaskStatus`: `const identity = await __hooks.resolveIdentity(req, decryptedPayload, __hooks); const row = await assertCanTouchTask(identity, taskId, __hooks);` and build the body's actor as `withLink({ email, name }, identity, row?.guildConfigId)`.
- `updateTask`: the same with `task_id`; additionally `if (out.projectId) await assertCanUseProject(identity, out.projectId, __hooks);`.
- `addSubtask`: `const row = await assertCanTouchTask(identity, parentId, __hooks);`.
- `createTask`: `const row = body.projectId ? await assertCanUseProject(identity, body.projectId, __hooks) : null;`.
`siteActor` stays the source of `{ email, name }`; `withLink` wraps it.

- [ ] **Step 4: Keep the existing write tests meaningful.** In `status.test.js`'s and `write.test.js`'s `hooks()` helper, add `resolveIdentity: async () => ({ userId: 1, email: "admin@x", links: [], isAdmin: true, seesAll: true })` to the object passed to `__setTestHooks`. Change nothing else; their body assertions stay valid because a `seesAll` caller with no link adds no `discordId`.

- [ ] **Step 5: Run every discord-tasks script** (the loop from Task 4 Step 7) → all pass.

- [ ] **Step 6: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksStatus.js Src/Apis/ProjectSpecificApis/DiscordTasks/discordTasksWrite.js Services/SysScripts/TestScripts/discord-tasks-test/writeScope.test.js Services/SysScripts/TestScripts/discord-tasks-test/status.test.js Services/SysScripts/TestScripts/discord-tasks-test/write.test.js
git commit -m "feat(discord-tasks): site writes only reach the caller's own projects

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Stats and time use the stored link

**Files:**
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/timeScope.js` (`verifiedEmail` re-exported from `identity.js`; `callerIdentity` delegates to `firstLinkForEmail`)
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordProjectStats.js` (visible projects only, unless `seesAll`)
- Modify: the existing time/stats test scripts whose `executeQuery` fakes answer the old `FROM granjur.guildmember WHERE LOWER(email) = ?` identity query (`timeScope.test.js`, `time.test.js`, `entries.test.js`, `stats.test.js` — check each with the Grep tool for `LOWER(email)`)
- Create: `Services/SysScripts/TestScripts/discord-tasks-test/statsScope.test.js`

**Interfaces:**
- Consumes: `firstLinkForEmail`, `verifiedEmail`, `resolveIdentity` (Task 3); `visibleProjectIdsFor` (Task 4).
- Produces: `timeScope.callerIdentity(email, hooks)` returns the caller's first stored link (auto-linking by email as `resolveIdentity` does); `getProjectStats` keeps only visible projects for callers without `seesAll` (its time-series `scope` self/all rule is unchanged).

- [ ] **Step 1: Write the failing test** — `Services/SysScripts/TestScripts/discord-tasks-test/statsScope.test.js`:

```js
const assert = require("assert");
const stats = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/discordProjectStats");
const timeScope = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/timeScope");

async function run() {
  // callerIdentity now comes from the stored link, not a raw email match.
  const seen = [];
  const hooks = { executeQuery: async (sql, p) => {
    seen.push(sql);
    if (sql.includes("FROM users WHERE LOWER(TRIM(email))")) return [{ user_id: 5 }];
    if (sql.includes("FROM discord_identity_link WHERE user_id = ?")) return [{ guildConfigId: "g1", discordId: "111", via: "code" }];
    return [];
  } };
  assert.deepStrictEqual(await timeScope.callerIdentity("a@granjur.com", hooks), { guildConfigId: "g1", discordId: "111" });
  assert.ok(!seen.some((s) => /FROM granjur\.guildmember WHERE LOWER\(email\) = \?$/.test(s)), "the old email guess is gone");

  // Stats list only the caller's projects.
  const q = async (sql, p) => {
    if (sql.includes("FROM granjur.guildconfig")) return [{ id: "g1" }];
    if (sql.includes("SELECT id, name, docsSlug FROM granjur.project")) return [{ id: "P1", name: "Mine", docsSlug: "mine" }, { id: "P2", name: "Theirs", docsSlug: "theirs" }];
    return [];
  };
  stats.__setTestHooks({
    executeQuery: q,
    requirePortalPermission: async () => { throw { statusCode: 403, message: "no" }; },
    resolveIdentity: async () => ({ userId: 5, links: [{ guildConfigId: "g1", discordId: "111" }], isAdmin: false, seesAll: false }),
    visibleProjectIdsFor: async () => new Set(["P1"]),
  });
  const out = await stats.getProjectStats({ query: {} }, { actor_email: "a@granjur.com", __identityVerified: true });
  assert.deepStrictEqual(out.projects.map((p) => p.id), ["P1"]);

  stats.__setTestHooks({ resolveIdentity: async () => ({ userId: 1, links: [], isAdmin: true, seesAll: true }), visibleProjectIdsFor: async () => { throw new Error("must not be called for seesAll"); } });
  const all = await stats.getProjectStats({ query: {} }, { actor_email: "boss@x", __identityVerified: true });
  assert.deepStrictEqual(all.projects.map((p) => p.id).sort(), ["P1", "P2"]);
  console.log("statsScope.test.js: all assertions passed");
}
run().catch((e) => { console.error(e); process.exit(1); });
```
If `getProjectStats`'s reducer needs more rows to emit a project entry, give `q` the minimal extra rows it needs (read `reduceStats` first); keep both `projects.map` assertions exactly.

- [ ] **Step 2: Run to verify it fails** — FAIL (`callerIdentity` still runs the guildmember email query / stats lists P2).

- [ ] **Step 3: Implement.**
  - `timeScope.js`: replace its own `verifiedEmail` with `const { verifiedEmail, firstLinkForEmail } = require("./identity");` and replace `callerIdentity`'s body with a delegation that keeps its "never fail the request" contract:

```js
async function callerIdentity(email, hooks) {
  if (!email) return { guildConfigId: null, discordId: null };
  try {
    return await firstLinkForEmail(email, hooks);
  } catch (_) {
    return { guildConfigId: null, discordId: null };
  }
}
```
  Keep the `module.exports` names unchanged (`verifiedEmail` is now the re-exported one).
  - `discordProjectStats.js`: add to `__hooks` `resolveIdentity` and `actorIsRoleAdmin` (lazy requires as in Task 4) and `visibleProjectIdsFor: (...a) => require("./visibility").visibleProjectIdsFor(...a)`. In `getProjectStats`, after `projects` is read and before `if (!projects || !projects.length) return empty;`:

```js
  const identity = await __hooks.resolveIdentity(req, decryptedPayload, __hooks);
  if (!identity.seesAll) {
    const mine = await __hooks.visibleProjectIdsFor(identity, __hooks);
    projects = (projects || []).filter((p) => mine.has(String(p.id)));
  }
```
- [ ] **Step 4: Update the existing fakes.** In each existing test script whose fake answers the old identity query (`includes("FROM granjur.guildmember")` returning `{ guildConfigId, discordId }` for a `LOWER(email)` lookup), add branches for the two new queries that return the same person: `sql.includes("FROM users WHERE LOWER(TRIM(email))")` → `[{ user_id: 5 }]` and `sql.includes("FROM discord_identity_link WHERE user_id = ?")` → `[{ guildConfigId: <same>, discordId: <same>, via: "email" }]`. In `stats.test.js` also add `resolveIdentity: async () => ({ userId: 1, links: [], isAdmin: true, seesAll: true })` to its hooks. Do not change any assertion.

- [ ] **Step 5: Run every discord-tasks script** (loop) → all pass.

- [ ] **Step 6: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/timeScope.js Src/Apis/ProjectSpecificApis/DiscordTasks/discordProjectStats.js Services/SysScripts/TestScripts/discord-tasks-test/
git commit -m "feat(discord-tasks): time and stats use the stored Discord link

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
(Stage only files you changed under `discord-tasks-test/`; check `git status` first.)

---
## Site (Tasks 8–10) — worktree `D:\Work\Granjur Technologies\UBS-Doc-identity-link`, branch `feat/identity-link`

Before Task 8, from `D:\Work\Granjur Technologies\UBS-Doc`: `git worktree add ../UBS-Doc-identity-link -b feat/identity-link main`, then `cd ../UBS-Doc-identity-link && npm ci`. Read its `CLAUDE.md`. Never touch the main checkout; never edit `src/styles/portal-compat.css`.

Conventions: class helpers `c`, `card`, `txt`, `muted`, `chipGray`, `chipIndigo` from `src/lib`; `useTheme()` from `src/app/ThemeContext`; buttons `btn-primary`, `btn-outline-indigo` (+ `dark-variant` in dark mode); inputs `input-base` (sets width 100%; size through a wrapper). Pure logic in `*Logic.ts` with a colocated `*.test.ts`. `useTeam()` gives `payload`, `loading`, `error`, `refresh`. `src/components/discordTasks/api.ts` has a private `apiCall<T>(path, init)` that prefers CSAAS's `payload` sentence and throws `ApiError { message, status }` — add new calls in that file so they share it.

### Task 8: Types, identity API calls and identity logic

**Files:**
- Modify: `src/screens/tasksLogic.ts` (≈L14-16 and L54: `hidden` on refs, `Viewer`, `TasksPayload.viewer`)
- Modify: `src/components/discordTasks/api.ts` (append)
- Modify: `src/components/discordTasks/api.test.ts` (append)
- Create: `src/screens/team/identityLogic.ts`
- Create: `src/screens/team/identityLogic.test.ts`

**Interfaces:**
- Consumes: CSAAS `GET /api/discord/tasks` `viewer`, `POST /api/discord/identity/link`, `GET /api/discord/identity/links`, `POST /api/discord/identity/unlink` (Tasks 4–5).
- Produces:
  - Types: `TaskRef.hidden?: boolean`; `TaskSubtask.hidden?: boolean`; `Viewer { linked: boolean; seesAll: boolean; isAdmin: boolean; discordIds: string[]; name: string | null }`; `TasksPayload.viewer?: Viewer`; `IdentityLink { userId: number; email: string | null; name: string | null; guildConfigId: string; discordId: string; discordName: string | null; via: 'email' | 'code' | 'admin'; linkedAt: string | null }`.
  - `api.ts`: `linkDiscord(code: string): Promise<IdentityMe>`, `fetchIdentityLinks(): Promise<{ links: IdentityLink[] }>`, `unlinkDiscord(userId: number, guildConfigId: string): Promise<{ removed: number }>`; `IdentityMe { linked; seesAll; isAdmin; links: { guildConfigId; discordId; name: string | null; via }[] }`.
  - `identityLogic.ts`: `needsLink(payload)`, `viewerLine(viewer)`, `normalizeCode(raw)`, `codeProblem(code)`, `linkErrorText(err)`, `LINK_HELP`.

- [ ] **Step 1: Types.** In `src/screens/tasksLogic.ts`:

```ts
// `hidden`: a task in a project the viewer cannot see — CSAAS sends only its id,
// status and a fixed title ("A task in another project"); render it as plain text.
export interface TaskRef { id: string; title: string; status?: string; hidden?: boolean }
export interface TaskSubtask { id: string; title: string; status: string; assignees: TaskPerson[]; hidden?: boolean }
```
and next to `TasksPayload`:

```ts
// Who is looking (identity link). Absent from an older backend: behave as before.
export interface Viewer { linked: boolean; seesAll: boolean; isAdmin: boolean; discordIds: string[]; name: string | null }
export interface TasksPayload { generatedAt: string; projects: ProjectGroup[]; members: TeamMember[]; repositories?: RepoRef[]; viewer?: Viewer }
```
(Keep every existing field of `TasksPayload`; only add `viewer`.)

- [ ] **Step 2: Write the failing API tests** — append to `src/components/discordTasks/api.test.ts` (extend the dynamic import with `linkDiscord, fetchIdentityLinks, unlinkDiscord`):

```ts
describe('identity calls', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('linkDiscord posts the code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ payload: { return: { linked: true, seesAll: false, isAdmin: false, links: [] } } }))
    const r = await linkDiscord('ABC234')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/discord/identity/link`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ code: 'ABC234' })
    expect(r.linked).toBe(true)
  })

  it('a refused code carries the sentence and status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 400, message: 'Invalid request', payload: 'That code is not valid. Run /link in Discord for a new one.' }, 400))
    await expect(linkDiscord('ZZZ999')).rejects.toMatchObject({ status: 400, message: 'That code is not valid. Run /link in Discord for a new one.' })
  })

  it('fetchIdentityLinks and unlinkDiscord hit the admin endpoints', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ payload: { return: { links: [] } } }))
    await fetchIdentityLinks()
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/discord/identity/links`)
    fetchMock.mockResolvedValueOnce(jsonResponse({ payload: { return: { removed: 1 } } }))
    await unlinkDiscord(0, 'g1')
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe(`${BASE}/api/discord/identity/unlink`)
    expect(JSON.parse(init.body)).toEqual({ user_id: 0, guild_config_id: 'g1' })
  })
})
```

- [ ] **Step 3: Run to verify they fail** — `npx vitest run src/components/discordTasks/api.test.ts` → FAIL (`linkDiscord is not a function`).

- [ ] **Step 4: Add the calls** at the end of `src/components/discordTasks/api.ts`:

```ts
// Identity link (2026-09-28): the site account ↔ Discord member link that scopes
// what the Team section shows. CSAAS links by verified email automatically; these
// calls cover the code fallback and the admin list.
export interface IdentityMe {
  linked: boolean
  seesAll: boolean
  isAdmin: boolean
  links: { guildConfigId: string; discordId: string; name: string | null; via: 'email' | 'code' | 'admin' }[]
}
export interface IdentityLink {
  userId: number
  email: string | null
  name: string | null
  guildConfigId: string
  discordId: string
  discordName: string | null
  via: 'email' | 'code' | 'admin'
  linkedAt: string | null
}

export async function linkDiscord(code: string): Promise<IdentityMe> {
  return apiCall<IdentityMe>('/discord/identity/link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
}

export async function fetchIdentityLinks(): Promise<{ links: IdentityLink[] }> {
  return apiCall<{ links: IdentityLink[] }>('/discord/identity/links')
}

export async function unlinkDiscord(userId: number, guildConfigId: string): Promise<{ removed: number }> {
  return apiCall<{ removed: number }>('/discord/identity/unlink', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: userId, guild_config_id: guildConfigId }),
  })
}
```

- [ ] **Step 5: Write the failing logic tests** — `src/screens/team/identityLogic.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { TasksPayload } from '../tasksLogic'
import { needsLink, viewerLine, normalizeCode, codeProblem, linkErrorText } from './identityLogic'

const base = { generatedAt: '', projects: [], members: [] } as TasksPayload

describe('needsLink', () => {
  it('only when the backend says unlinked and not see-all', () => {
    expect(needsLink(null)).toBe(false)
    expect(needsLink(base)).toBe(false) // an older backend sends no viewer: behave as before
    expect(needsLink({ ...base, viewer: { linked: false, seesAll: false, isAdmin: false, discordIds: [], name: null } })).toBe(true)
    expect(needsLink({ ...base, viewer: { linked: false, seesAll: true, isAdmin: true, discordIds: [], name: null } })).toBe(false)
    expect(needsLink({ ...base, viewer: { linked: true, seesAll: false, isAdmin: false, discordIds: ['1'], name: 'Ana' } })).toBe(false)
  })
})

describe('viewerLine', () => {
  it('names the viewer, or says they see everything', () => {
    expect(viewerLine(undefined)).toBeNull()
    expect(viewerLine({ linked: true, seesAll: false, isAdmin: false, discordIds: ['1'], name: 'Ana' })).toBe('Signed in as Ana')
    expect(viewerLine({ linked: true, seesAll: true, isAdmin: false, discordIds: ['1'], name: 'Ana' })).toBe('Signed in as Ana · viewing every project')
    expect(viewerLine({ linked: false, seesAll: true, isAdmin: true, discordIds: [], name: null })).toBe('Viewing every project')
    expect(viewerLine({ linked: true, seesAll: false, isAdmin: false, discordIds: ['1'], name: null })).toBe('Signed in with your Discord account')
  })
})

describe('codes', () => {
  it('normalizes spaces, dashes and case', () => {
    expect(normalizeCode(' abc-234 ')).toBe('ABC234')
  })
  it('explains a malformed code before sending it', () => {
    expect(codeProblem('ABC234')).toBeNull()
    expect(codeProblem('')).toBe('Enter the 6-character code from /link.')
    expect(codeProblem('ABC23')).toBe('Codes are 6 letters and digits, like ABC234.')
    expect(codeProblem('ABC0I1')).toBe('Codes are 6 letters and digits, like ABC234.')
  })
})

describe('linkErrorText', () => {
  it('shows the server sentence for refusals, a plain one otherwise', () => {
    expect(linkErrorText({ status: 400, message: 'That code is not valid. Run /link in Discord for a new one.' })).toBe('That code is not valid. Run /link in Discord for a new one.')
    expect(linkErrorText({ status: 503, message: 'Linking by code is not available yet.' })).toBe('Linking by code is not available yet.')
    expect(linkErrorText({ status: 401, message: 'x' })).toBe('Sign in again, then link your account.')
    expect(linkErrorText({ status: 502, message: 'x' })).toBe('The server did not answer. Try again in a moment.')
    expect(linkErrorText({ message: 'Failed to fetch' })).toBe('The server did not answer. Try again in a moment.')
  })
})
```

- [ ] **Step 6: Run to verify it fails** — `npx vitest run src/screens/team/identityLogic.test.ts` → FAIL (module missing).

- [ ] **Step 7: Write `src/screens/team/identityLogic.ts`:**

```ts
import type { TasksPayload, Viewer } from '../tasksLogic'

// The link card and the "signed in as" line (identity link, 2026-09-28). The
// backend decides who is linked; this only turns its `viewer` into what to show.

export const LINK_HELP =
  'We link your UBS-Doc account to your Discord member automatically when the email you sign in with matches the one you verified in Discord. If they differ, run /link in the Discord server and enter the code here.'

const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/

export function needsLink(payload: TasksPayload | null | undefined): boolean {
  const v = payload?.viewer
  return !!v && !v.linked && !v.seesAll
}

export function viewerLine(viewer: Viewer | undefined): string | null {
  if (!viewer) return null
  const who = viewer.linked ? (viewer.name ? `Signed in as ${viewer.name}` : 'Signed in with your Discord account') : null
  if (viewer.seesAll) return who ? `${who} · viewing every project` : 'Viewing every project'
  return who
}

export function normalizeCode(raw: string): string {
  return String(raw ?? '').replace(/[\s-]/g, '').toUpperCase()
}

export function codeProblem(code: string): string | null {
  if (!code) return 'Enter the 6-character code from /link.'
  if (!CODE_RE.test(code)) return 'Codes are 6 letters and digits, like ABC234.'
  return null
}

export function linkErrorText(err: { status?: number; message?: string }): string {
  const status = err?.status
  const message = (err?.message ?? '').trim()
  if (status === 401) return 'Sign in again, then link your account.'
  if ((status === 400 || status === 403 || status === 503) && message) return message
  return 'The server did not answer. Try again in a moment.'
}
```

- [ ] **Step 8: Run** — `npx vitest run src/screens/team/identityLogic.test.ts src/components/discordTasks/api.test.ts && npx tsc --noEmit -p .` → pass, clean.

- [ ] **Step 9: Commit**

```bash
git add src/screens/tasksLogic.ts src/components/discordTasks/api.ts src/components/discordTasks/api.test.ts src/screens/team/identityLogic.ts src/screens/team/identityLogic.test.ts
git commit -m "feat(team): identity types, link calls and link logic

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The link card, the viewer line and hidden references

**Files:**
- Create: `src/screens/team/LinkCard.tsx`
- Modify: `src/screens/team/TeamLayout.tsx` (header line ≈L106-111; the `<Outlet context={context} />` at ≈L176)
- Modify: `src/screens/team/TaskDetail.tsx` (the `RefList` links and the "Subtask of" parent link ≈L139-143)
- Modify: `src/screens/team/SubtaskChecklist.tsx` (the subtask `<Link>` ≈L66)

**Interfaces:**
- Consumes: `linkDiscord` (Task 8), `needsLink`, `viewerLine`, `normalizeCode`, `codeProblem`, `linkErrorText`, `LINK_HELP` (Task 8); `TaskRef.hidden`, `TaskSubtask.hidden`.
- Produces: `<LinkCard theme onLinked />`.

- [ ] **Step 1: Write `src/screens/team/LinkCard.tsx`:**

```tsx
import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { c, card, txt, muted } from '../../lib'
import type { Theme } from '../../types'
import { linkDiscord } from '../../components/discordTasks/api'
import { LINK_HELP, codeProblem, linkErrorText, normalizeCode } from './identityLogic'

// Shown instead of the Team tabs while the signed-in account has no Discord link:
// with no link there is nothing the backend will show, so the only useful thing on
// the page is the way to make one.
export default function LinkCard({ theme, onLinked }: { theme: Theme; onLinked: () => Promise<void> }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const normalized = normalizeCode(code)
    const problem = codeProblem(normalized)
    if (problem) { setError(problem); return }
    setBusy(true)
    setError(null)
    try {
      await linkDiscord(normalized)
      await onLinked()
    } catch (err) {
      setError(linkErrorText(err as { status?: number; message?: string }))
      setBusy(false)
    }
  }

  return (
    <div className={c(card(theme), 'rounded-2xl p-6 sm:p-8 max-w-[640px]')}>
      <div className="flex items-center gap-3 mb-3">
        <Link2 size={20} className="text-indigo-500" />
        <h2 className={c('font-extrabold text-lg m-0', txt(theme))}>Link your Discord account</h2>
      </div>
      <p className={c('text-sm mb-2', muted(theme))}>
        Your UBS-Doc account is not linked to a Discord member yet, so there are no projects to show you.
      </p>
      <p className={c('text-sm mb-5', muted(theme))}>{LINK_HELP}</p>
      <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="flex flex-wrap gap-3 items-center">
        <div className="w-[180px]">
          <input className="input-base font-mono tracking-widest uppercase" value={code} maxLength={9}
            placeholder="ABC234" aria-label="Link code" autoComplete="one-time-code"
            onChange={(e) => setCode(e.target.value)} disabled={busy} />
        </div>
        <button type="submit" className="btn-primary px-5 py-2.5 text-sm" disabled={busy}>{busy ? 'Linking…' : 'Link account'}</button>
      </form>
      {error && <p role="alert" className="text-sm font-semibold text-red-500 mt-3 mb-0">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 2: Wire into `TeamLayout.tsx`.** Import `LinkCard from './LinkCard'` and `{ needsLink, viewerLine } from './identityLogic'`. Inside the component compute `const showLinkCard = needsLink(payload)` and `const viewerText = viewerLine(payload?.viewer)`. Under the existing people/tasks/blocked `<p>` in the header add:

```tsx
            {viewerText && <p className={c('text-xs font-semibold mt-1 mb-0', muted(theme))}>{viewerText}</p>}
```
Replace `<Outlet context={context} />` with:

```tsx
        {showLinkCard ? <LinkCard theme={theme} onLinked={refresh} /> : <Outlet context={context} />}
```
(`refresh` is the layout's own `refresh` callback; `muted` and `c` are already imported there — check.)

- [ ] **Step 3: Hidden references render as text.** In `TaskDetail.tsx`'s `RefList`, render a hidden ref without a link:

```tsx
          {r.hidden
            ? <span className={c('text-sm font-semibold', muted(theme))}>{r.title}</span>
            : <Link to={`/tools/team/tasks/${r.id}${search}`} className={c('text-sm font-semibold no-underline hover:underline', txt(theme))}>{r.title}</Link>}
```
and the "Subtask of" line:

```tsx
                {task.parent.hidden
                  ? <span>{task.parent.title}</span>
                  : <Link to={`/tools/team/tasks/${task.parent.id}${search}`} className="text-indigo-500 no-underline hover:underline">{task.parent.title}</Link>}
```
In `SubtaskChecklist.tsx`, when `s.hidden`, render the title in a `<span>` with the same classes as the link instead of the `<Link>`, and keep the checkbox disabled for it (`disabled={!canToggle || busy || !!s.hidden}`).

- [ ] **Step 4: Type-check, test, build** — `npx tsc --noEmit -p . && npm test && npm run build` → clean.

- [ ] **Step 5: Look at it (if you can sign in).** `npm run dev`; an account without a link sees the card instead of the tabs; a linked one sees "Signed in as …". If you cannot sign in to the portal locally, say so in the report; do not claim the check.

- [ ] **Step 6: Commit**

```bash
git add src/screens/team/LinkCard.tsx src/screens/team/TeamLayout.tsx src/screens/team/TaskDetail.tsx src/screens/team/SubtaskChecklist.tsx
git commit -m "feat(team): link card, signed-in line and hidden cross-project references

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Admin account links on the People tab

**Files:**
- Create: `src/screens/team/IdentityLinks.tsx`
- Modify: `src/screens/team/People.tsx` (render `IdentityLinks` above the member cards when `payload?.viewer?.isAdmin`)

**Interfaces:**
- Consumes: `fetchIdentityLinks`, `unlinkDiscord`, `IdentityLink` (Task 8); `linkErrorText` (Task 8).
- Produces: `<IdentityLinks theme />`.

- [ ] **Step 1: Write `src/screens/team/IdentityLinks.tsx`:**

```tsx
import { useCallback, useEffect, useState } from 'react'
import { c, card, txt, muted, chipGray } from '../../lib'
import type { Theme } from '../../types'
import { fetchIdentityLinks, unlinkDiscord, type IdentityLink } from '../../components/discordTasks/api'
import { linkErrorText } from './identityLogic'

// Site admins only: every stored account ↔ Discord link, with Unlink so a person
// who linked the wrong Discord account can link again.
export default function IdentityLinks({ theme }: { theme: Theme }) {
  const [links, setLinks] = useState<IdentityLink[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setLinks((await fetchIdentityLinks()).links)
      setError(null)
    } catch (err) {
      setError(linkErrorText(err as { status?: number; message?: string }))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  async function remove(l: IdentityLink) {
    const who = l.name || l.email || `user ${l.userId}`
    if (!window.confirm(`Unlink ${who} from ${l.discordName || l.discordId}? They can link again afterwards.`)) return
    const key = `${l.userId}:${l.guildConfigId}`
    setBusy(key)
    try {
      await unlinkDiscord(l.userId, l.guildConfigId)
      await load()
    } catch (err) {
      setError(linkErrorText(err as { status?: number; message?: string }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className={c(card(theme), 'rounded-2xl p-5 mb-6')}>
      <h2 className={c('font-extrabold text-base m-0 mb-1', txt(theme))}>Account links</h2>
      <p className={c('text-xs mb-4', muted(theme))}>UBS-Doc accounts and the Discord members they are linked to. Only site admins see this.</p>
      {error && <p role="alert" className="text-sm font-semibold text-red-500 mb-3">{error}</p>}
      {links === null && !error && <p className={c('text-sm m-0', muted(theme))}>Loading…</p>}
      {links && links.length === 0 && <p className={c('text-sm m-0', muted(theme))}>No accounts are linked yet.</p>}
      {links && links.length > 0 && (
        <ul className="list-none p-0 m-0 flex flex-col gap-2">
          {links.map((l) => {
            const key = `${l.userId}:${l.guildConfigId}`
            return (
              <li key={key} className="flex flex-wrap items-center gap-3 text-sm">
                <span className={c('font-semibold', txt(theme))}>{l.name || l.email || `user ${l.userId}`}</span>
                {l.email && l.name && <span className={muted(theme)}>{l.email}</span>}
                <span className={muted(theme)}>↔</span>
                <span className={c('font-semibold', txt(theme))}>{l.discordName || l.discordId}</span>
                <span className={c('text-[11px] font-semibold px-2 py-0.5 rounded-full', chipGray(theme))}>{l.via}</span>
                <button type="button" onClick={() => void remove(l)} disabled={busy === key}
                  className={c('ml-auto text-xs font-semibold text-red-500 hover:underline', busy === key ? 'opacity-50' : '')}>
                  {busy === key ? 'Unlinking…' : 'Unlink'}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
```

- [ ] **Step 2: Render it on the People tab.** In `People.tsx` import `IdentityLinks from './IdentityLinks'`, and in the main return (not the loading/empty early return), as the first child: `{payload?.viewer?.isAdmin && <IdentityLinks theme={theme} />}`.

- [ ] **Step 3: Type-check, test, build** — `npx tsc --noEmit -p . && npm test && npm run build` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/screens/team/IdentityLinks.tsx src/screens/team/People.tsx
git commit -m "feat(team): admins see and remove account links on the People tab

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Knowledge and state (bot repo)

**Files:**
- Create: `.claude/knowledge/identity-link.md`
- Modify: `.claude/knowledge/README.md`, `.claude/knowledge/project-tasks-site.md` (one pointer paragraph), `.claude/state/backlog.md`, `.claude/state/completed.md`, `.claude/state/session.md`

- [ ] **Step 1: Write `.claude/knowledge/identity-link.md`** covering, from the code as built (read the three repos' diffs first; state only what the code does):
  - the problem it solves and the spec path;
  - the CSAAS table `discord_identity_link` and its two unique keys;
  - `identity.js` `resolveIdentity`: token-only identity, `user_id` 0 is real, auto-link by exactly one verified email match not already linked, `isAdmin` (org `Admin`/`Platform Admin` role or `actorIsRoleAdmin`) vs `seesAll` (+ Discord `CEO`/`Server Manager`);
  - `/link` → `granjur.discordlinkcode` (MySQL `NOW()` expiry, single use) → `POST /api/discord/identity/link`, the one CSAAS write into the bot's database;
  - `visibility.js`: "my project" rule, hidden-ref stub shape, write refusals (`403` sentence), `linkedDiscordId` in the actor and the bot's `siteActor` preferring it;
  - the no-cross-database-string-JOIN rule and why;
  - the site's link card, viewer line, hidden refs and admin links panel;
  - rollout: bot → CSAAS (manual deploy) → site; scoping takes effect when CSAAS is live;
  - how to verify: a linked non-admin sees only their projects; a site edit to another project's task is refused; `/link` code works once.
- [ ] **Step 2:** Add an index line for it in `.claude/knowledge/README.md`, and one sentence in `project-tasks-site.md`'s "The bot route has no guild scope" section pointing to `identity-link.md` (the site now scopes by project membership).
- [ ] **Step 3:** State: move roadmap item 1 in `backlog.md` to "built, not deployed" with the rollout steps (bot, then CSAAS by hand, then site; first live check: a non-admin sees only their projects, and an admin still sees all); add any review-deferred items; add a dated entry (2026-09-29 or the actual date) to `completed.md` listing each repo's commits; rewrite `session.md` with the outcome.
- [ ] **Step 4: Commit**

```bash
git add .claude/knowledge/identity-link.md .claude/knowledge/README.md .claude/knowledge/project-tasks-site.md .claude/state/backlog.md .claude/state/completed.md .claude/state/session.md
git commit -m "docs: identity link knowledge and state

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

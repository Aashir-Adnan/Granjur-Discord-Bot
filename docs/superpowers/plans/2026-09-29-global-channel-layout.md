# Global Channel Layout and Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/init` builds a trimmed global layout (Onboarding, Announcements, Casual, Documentation, Feedback, Meetings, Support), a new #feedback channel and `/feedback` command collect improvement ideas from verified staff, and `/setup` + `/cleanup` bring the live server to that layout with a preview before anything is deleted.

**Architecture:** One module, `bot/src/services/globalLayout.js`, defines the global categories and channels; `/init` creates from it and `/cleanup` protects from it, so the two cannot drift. `bot/src/services/feedback.js` finds or creates #feedback (stored id on `guildconfig.feedbackChannelId`, name fallback). `/cleanup` gains by-id protection for task tickets and stored config channels, keeps the global Features/Bugs ticket categories protected, and also removes a category once every channel in it is removed.

**Tech Stack:** Node ESM, discord.js v14, `node:test`, MySQL (plain SQL migrations run by `bot/scripts/run-migrations.js`).

**Spec:** `docs/superpowers/specs/2026-09-29-global-channel-layout-design.md`

## Global Constraints

- Global categories in `/init` order: 📥 Onboarding, 📢 Announcements, 💬 Casual, 📚 Documentation, 💡 Feedback, 📋 Meetings, then 🛟 Support (made by `ensureSupportChannels`, unchanged).
- Removed from the layout: Rules, Archive, the Frontend/Backend/Database categories and every `cmd-*` channel. The discipline roles and the `dedicatedChannels`/`commandDescriptions` config stay.
- #feedback: `@everyone` denied ViewChannel; the Verified role allowed ViewChannel, ReadMessageHistory, SendMessages; nothing for the Client role (clients never hold Verified).
- `/feedback message:<required, ≤1000 chars> type:<Bug|Idea|Process|Other, optional, default Other>`; role list `["Verified"]`; never in `clientCommands`.
- Missing-channel reply, verbatim: `There's no #feedback channel yet — ask an admin to run /setup.`
- Success reply, verbatim: `Thanks — posted in <#CHANNEL_ID>.`
- The live server is never reordered. Nothing is deleted without `/cleanup`'s confirm button.
- Tests use fakes only — never the default `db` export, never a real database (`.claude/rules/tests-never-touch-production.md`; the root `.env` is production). Never run `npm run db:migrate` or any SQL.
- Commits: `git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit ...`; every message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` — exactly that.
- A piped test summary can exit 0 while red: read the `ℹ fail` line.

## Review Focus

1. The live trim must never list a task's ticket channel — in the global Features/Bugs categories (plain or `/migrate`-bold name) or anywhere else a task row points — nor #time-reports / #admin / #feedback by stored id (Task 5 tests).
2. A category that still holds one protected channel (a `/create-channel` room, a ticket) must not be removed with the others (Task 5 test).
3. #feedback renamed, moved or deleted after `/setup`: `/feedback` finds it by stored id, falls back by name inside the Feedback category, and otherwise gives the "run /setup" reply without posting (Task 2 + Task 3 tests).
4. `/setup` run twice creates nothing the second time and keeps the stored id (Task 2 test).
5. A client must not be able to run `/feedback` or see #feedback (Task 2 overwrites test; Task 3 config test).

## Rulings made while planning (the spec is the authority)

- The spec gives each layout entry a "visibility" field. Dropped: `/init`'s existing permission pass already decides visibility by category (Onboarding public, Announcements tiered, everything else Verified-only), and #feedback's overwrites live in `feedback.js`. A field nothing reads would be dead data.
- The spec's "runInit on a fake guild" test becomes a test of the extracted `createGlobalCategories` plus the existing permission pass left as is: `runInit` calls the real `db` config functions with no seam, and adding seams to all of `/init` is outside this sub-project.
- Added beyond the spec, for the live trim to be safe: `/cleanup` protects task ticket channels by id and the channels whose ids `guildconfig` stores, keeps Features/Bugs protected by name, and removes a category only once every channel in it is removed (otherwise the trim leaves six empty categories behind).
- `schema.sql` is not updated: the `guildconfig` columns added by migrations 024–025 are not in it either; migration 029 is the source of truth, as for those.

---

### Task 1: The global layout module

**Files:**
- Modify: `bot/src/constants.js` (add two constants after `CHANNEL_DOCUMENTATION`, ~line 76)
- Create: `bot/src/services/globalLayout.js`
- Test: `bot/src/services/globalLayout.test.js`

**Interfaces:**
- Produces: `CATEGORY_FEEDBACK = '💡 Feedback'`, `CHANNEL_FEEDBACK = 'feedback'` (constants.js); from `globalLayout.js`: `GLOBAL_LAYOUT` (frozen array of `{ category: string, channels: { name, type, topic? }[] }`), `FEEDBACK_TOPIC`, `GLOBAL_TICKET_CATEGORIES = ['Features', 'Bugs']`, `protectedCategoryNames() → Set<string>` (lowercased), `protectedChannelNames() → Set<string>` (lowercased).

- [ ] **Step 1: Write the failing test**

Create `bot/src/services/globalLayout.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType } from 'discord.js'
import {
  GLOBAL_LAYOUT,
  FEEDBACK_TOPIC,
  GLOBAL_TICKET_CATEGORIES,
  protectedCategoryNames,
  protectedChannelNames,
} from './globalLayout.js'
import { CATEGORY_FEEDBACK, CHANNEL_FEEDBACK, CATEGORY_SUPPORT } from '../constants.js'

test('the global layout, in /init order', () => {
  assert.deepEqual(GLOBAL_LAYOUT.map((e) => e.category), [
    '📥 Onboarding', '📢 Announcements', '💬 Casual', '📚 Documentation', '💡 Feedback', '📋 Meetings',
  ])
  const channels = Object.fromEntries(GLOBAL_LAYOUT.map((e) => [e.category, e.channels.map((c) => c.name)]))
  assert.deepEqual(channels['📥 Onboarding'], ['welcome-and-verify'])
  assert.deepEqual(channels['📢 Announcements'], ['announcements-all', 'announcements-verified', 'announcements-leadership', 'admin'])
  assert.deepEqual(channels['💬 Casual'], ['casual-chat', 'off-topic', 'voice-lounge'])
  assert.deepEqual(channels['📚 Documentation'], ['documentation'])
  assert.deepEqual(channels['💡 Feedback'], ['feedback'])
  assert.deepEqual(channels['📋 Meetings'], ['general-meetings', 'meeting-voice', 'upcoming-meetings'])
})

test('voice channels are voice, everything else is text', () => {
  const voice = GLOBAL_LAYOUT.flatMap((e) => e.channels).filter((c) => c.type === ChannelType.GuildVoice).map((c) => c.name)
  assert.deepEqual(voice, ['voice-lounge', 'meeting-voice'])
  for (const c of GLOBAL_LAYOUT.flatMap((e) => e.channels)) {
    assert.ok([ChannelType.GuildText, ChannelType.GuildVoice].includes(c.type), c.name)
  }
})

test('the trimmed categories and channels are gone from the layout', () => {
  const cats = GLOBAL_LAYOUT.map((e) => e.category)
  for (const gone of ['📜 Rules', '📁 Archive', '⚛️ Frontend', '🔧 Backend', '🗄️ Database', '📌 Command channels']) {
    assert.ok(!cats.includes(gone), gone)
  }
  const names = GLOBAL_LAYOUT.flatMap((e) => e.channels.map((c) => c.name))
  assert.ok(!names.some((n) => n.startsWith('cmd-')))
  for (const gone of ['rules', 'meeting-metadata', 'sql-dumps', 'frontend-chat', 'backend-voice', 'database-chat']) {
    assert.ok(!names.includes(gone), gone)
  }
})

test('feedback constants and topic', () => {
  assert.equal(CATEGORY_FEEDBACK, '💡 Feedback')
  assert.equal(CHANNEL_FEEDBACK, 'feedback')
  assert.equal(GLOBAL_LAYOUT.find((e) => e.category === CATEGORY_FEEDBACK).channels[0].topic, FEEDBACK_TOPIC)
  assert.match(FEEDBACK_TOPIC, /\/feedback/)
})

test('protected category names: the layout, its /migrate bold names, the ticket categories and Support', () => {
  const cats = protectedCategoryNames()
  for (const name of ['📥 onboarding', '💡 feedback', '📋 meetings', '<==== 📋 meetings 📋 ====>', '<==== 💬 casual 💬 ====>',
    'features', 'bugs', '<==== ✨ features ✨ ====>', '<==== 🐛 bugs 🐛 ====>', CATEGORY_SUPPORT.toLowerCase()]) {
    assert.ok(cats.has(name), name)
  }
  for (const gone of ['📜 rules', '<==== 📜 rules 📜 ====>', '📁 archive', '⚛️ frontend', '📌 command channels', '🐾 pet pictures']) {
    assert.ok(!cats.has(gone), gone)
  }
  assert.deepEqual(GLOBAL_TICKET_CATEGORIES, ['Features', 'Bugs'])
})

test('protected channel names: every layout channel plus the bare general/voice pair', () => {
  const names = protectedChannelNames()
  for (const n of ['welcome-and-verify', 'admin', 'casual-chat', 'feedback', 'upcoming-meetings', 'general', 'voice']) {
    assert.ok(names.has(n), n)
  }
  for (const gone of ['rules', 'meeting-metadata', 'frontend-chat', 'cmd-create-task']) assert.ok(!names.has(gone), gone)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test bot/src/services/globalLayout.test.js` (from the repo root)
Expected: FAIL — cannot find module `./globalLayout.js`.

- [ ] **Step 3: Implement**

In `bot/src/constants.js`, after `export const CHANNEL_DOCUMENTATION = 'documentation'`, add:

```js
/** Feedback category — staff tell us what to improve (typed, or via /feedback). */
export const CATEGORY_FEEDBACK = '💡 Feedback'
export const CHANNEL_FEEDBACK = 'feedback'
```

Create `bot/src/services/globalLayout.js`:

```js
// The global categories /init builds and /cleanup leaves alone (roadmap
// sub-project 3, 2026-09-29; spec docs/superpowers/specs/2026-09-29-global-
// channel-layout-design.md). One list for both, so they cannot drift apart
// again. Support is not here: ensureSupportChannels owns it, and /cleanup
// protects it by id and name.

import { ChannelType } from 'discord.js'
import {
  CATEGORY_ONBOARDING, CHANNEL_ONBOARDING,
  CATEGORY_ANNOUNCEMENTS, CHANNEL_ANNOUNCEMENTS_ALL, CHANNEL_ANNOUNCEMENTS_VERIFIED,
  CHANNEL_ANNOUNCEMENTS_LEADERSHIP, CHANNEL_ADMIN,
  CATEGORY_CASUAL, CHANNEL_CASUAL_CHAT, CHANNEL_OFF_TOPIC, CHANNEL_VOICE_LOUNGE,
  CATEGORY_DOCUMENTATION, CHANNEL_DOCUMENTATION,
  CATEGORY_FEEDBACK, CHANNEL_FEEDBACK,
  CATEGORY_MEETINGS, CHANNEL_MEETINGS_TEXT, CHANNEL_MEETINGS_VOICE, CHANNEL_UPCOMING_MEETINGS,
  CATEGORY_SUPPORT, CATEGORY_BOLD_NAMES, CHANNEL_BARE_TEXT, CHANNEL_BARE_VOICE,
} from '../constants.js'

export const FEEDBACK_TOPIC = 'What should we improve? Type here, or use /feedback from any channel.'

const text = (name, topic) => (topic ? { name, type: ChannelType.GuildText, topic } : { name, type: ChannelType.GuildText })
const voice = (name) => ({ name, type: ChannelType.GuildVoice })

export const GLOBAL_LAYOUT = Object.freeze([
  { category: CATEGORY_ONBOARDING, channels: [text(CHANNEL_ONBOARDING, 'Run /verify to get a code by email (OTP). Then wait for CEO/Server Manager to approve.')] },
  {
    category: CATEGORY_ANNOUNCEMENTS,
    channels: [
      text(CHANNEL_ANNOUNCEMENTS_ALL, 'Announcements for everyone'),
      text(CHANNEL_ANNOUNCEMENTS_VERIFIED, 'Announcements for verified members'),
      text(CHANNEL_ANNOUNCEMENTS_LEADERSHIP, 'Announcements for leadership'),
      text(CHANNEL_ADMIN, 'Backlog notifications — server owner & CEOs tagged when someone enters holding'),
    ],
  },
  { category: CATEGORY_CASUAL, channels: [text(CHANNEL_CASUAL_CHAT), text(CHANNEL_OFF_TOPIC), voice(CHANNEL_VOICE_LOUNGE)] },
  { category: CATEGORY_DOCUMENTATION, channels: [text(CHANNEL_DOCUMENTATION, 'Browse project documentation — select a project below')] },
  { category: CATEGORY_FEEDBACK, channels: [text(CHANNEL_FEEDBACK, FEEDBACK_TOPIC)] },
  {
    category: CATEGORY_MEETINGS,
    channels: [
      text(CHANNEL_MEETINGS_TEXT, 'General meetings and sync'),
      voice(CHANNEL_MEETINGS_VOICE),
      text(CHANNEL_UPCOMING_MEETINGS, 'Reminders 10 min before meetings — tagged here'),
    ],
  },
])

// The no-project ticket categories (feature/bug tickets live here). Not part of
// the layout — tickets create them on demand — but never ours to trim.
export const GLOBAL_TICKET_CATEGORIES = Object.freeze(['Features', 'Bugs'])

/** Category names /cleanup must leave alone, lowercased: layout, /migrate bold names, ticket categories, Support. */
export function protectedCategoryNames() {
  const names = [...GLOBAL_LAYOUT.map((e) => e.category), ...GLOBAL_TICKET_CATEGORIES, CATEGORY_SUPPORT]
  const withBold = names.flatMap((n) => [n, CATEGORY_BOLD_NAMES[n]].filter(Boolean))
  return new Set(withBold.map((n) => n.toLowerCase()))
}

/** Channel names /cleanup must leave alone inside a protected category, lowercased. */
export function protectedChannelNames() {
  const names = [...GLOBAL_LAYOUT.flatMap((e) => e.channels.map((c) => c.name)), CHANNEL_BARE_TEXT, CHANNEL_BARE_VOICE]
  return new Set(names.map((n) => n.toLowerCase()))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test bot/src/services/globalLayout.test.js`
Expected: 6 tests pass, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add bot/src/constants.js bot/src/services/globalLayout.js bot/src/services/globalLayout.test.js
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "feat(layout): one global layout for /init and /cleanup, with a Feedback category

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: #feedback — stored id, find, ensure, and `/setup`

**Files:**
- Create: `bot/src/Database/migrations/029_guild_feedback_channel.sql`
- Modify: `bot/src/Database/index.js` (`updateGuildConfig`, after the `supportVoiceChannelId` block ~line 111)
- Modify: `bot/src/config/channel-defaults.json` (`pinnedMessages`)
- Create: `bot/src/services/feedback.js`
- Modify: `bot/src/commands/setup.js`
- Test: `bot/src/services/feedback.test.js`

**Interfaces:**
- Consumes: `CATEGORY_FEEDBACK`, `CHANNEL_FEEDBACK` (constants.js), `FEEDBACK_TOPIC` (globalLayout.js), `getChannelPinnedMessage(name)` (`bot/src/config/commands.js`).
- Produces (from `bot/src/services/feedback.js`): `feedbackOverwrites(guild, verifiedRoleId) → overwrite[]`; `async findFeedbackChannel(guild, cfg) → channel | null`; `async ensureFeedbackChannel(guild, cfg, { update }?) → { channel, created: boolean }` (throws `Error('No Verified role is configured — run /init first.')` when `cfg.verifiedRoleId` is missing). `updateGuildConfig(guildId, { feedbackChannelId })` persists the id.

- [ ] **Step 1: Write the failing test**

Create `bot/src/services/feedback.test.js`:

```js
// Fakes only: `ensureFeedbackChannel` takes the config writer as a seam and the
// guild is a plain object. See .claude/rules/tests-never-touch-production.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, PermissionFlagsBits, OverwriteType } from 'discord.js'
import { feedbackOverwrites, findFeedbackChannel, ensureFeedbackChannel } from './feedback.js'

function fakeGuild(channels = []) {
  const cache = new Map(channels.map((c) => [c.id, c]))
  const created = []
  let n = 0
  return {
    id: 'G1',
    created,
    channels: {
      cache,
      fetch: async (id) => cache.get(id) ?? null,
      create: async (opts) => {
        n += 1
        const ch = {
          id: `new${n}`, name: opts.name, type: opts.type, parentId: opts.parent ?? null, opts,
          sent: [],
          send: async (m) => { ch.sent.push(m); return { pin: async () => { ch.pinned = true } } },
        }
        created.push(opts)
        cache.set(ch.id, ch)
        return ch
      },
    },
  }
}
const cat = (id, name) => ({ id, name, type: ChannelType.GuildCategory, parentId: null })
const textCh = (id, name, parentId) => ({ id, name, type: ChannelType.GuildText, parentId })

test('overwrites: @everyone denied, Verified can view, read and send, no Client entry', () => {
  const ow = feedbackOverwrites({ id: 'G1' }, 'VER')
  assert.deepEqual(ow, [
    { id: 'G1', type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: 'VER', type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages] },
  ])
})

test('find: by stored id first', async () => {
  const guild = fakeGuild([textCh('fb', 'renamed-feedback', 'x')])
  assert.equal((await findFeedbackChannel(guild, { feedbackChannelId: 'fb' })).id, 'fb')
})

test('find: falls back to #feedback inside the Feedback category when the stored id is gone', async () => {
  const guild = fakeGuild([cat('c1', '💡 Feedback'), textCh('f1', 'feedback', 'c1'), textCh('other', 'feedback', null)])
  assert.equal((await findFeedbackChannel(guild, { feedbackChannelId: 'deleted' })).id, 'f1')
  assert.equal((await findFeedbackChannel(guild, {})).id, 'f1')
})

test('find: a #feedback outside the Feedback category, or nothing at all, is null', async () => {
  assert.equal(await findFeedbackChannel(fakeGuild([textCh('other', 'feedback', null)]), {}), null)
  assert.equal(await findFeedbackChannel(fakeGuild(), { feedbackChannelId: null }), null)
})

test('ensure: creates the category and channel once, pins the default message, stores the id', async () => {
  const guild = fakeGuild()
  const updates = []
  const update = async (gid, data) => { updates.push([gid, data]) }
  const out = await ensureFeedbackChannel(guild, { verifiedRoleId: 'VER' }, { update })
  assert.equal(out.created, true)
  assert.deepEqual(guild.created.map((o) => [o.name, o.type]), [['💡 Feedback', ChannelType.GuildCategory], ['feedback', ChannelType.GuildText]])
  assert.equal(guild.created[1].parent, 'new1')
  assert.match(guild.created[1].topic, /\/feedback/)
  assert.deepEqual(guild.created[1].permissionOverwrites, feedbackOverwrites(guild, 'VER'))
  assert.equal(out.channel.sent.length, 1)
  assert.equal(out.channel.pinned, true)
  assert.deepEqual(updates, [['G1', { feedbackChannelId: 'new2' }]])
})

test('ensure: a second run creates nothing and keeps the stored id', async () => {
  const guild = fakeGuild([cat('c1', '💡 Feedback'), textCh('f1', 'feedback', 'c1')])
  const updates = []
  const out = await ensureFeedbackChannel(guild, { verifiedRoleId: 'VER', feedbackChannelId: 'f1' }, { update: async (...a) => updates.push(a) })
  assert.equal(out.created, false)
  assert.equal(out.channel.id, 'f1')
  assert.deepEqual(guild.created, [])
  assert.deepEqual(updates, [], 'the stored id was already right')
})

test('ensure: an existing category is reused; a found channel with no stored id gets it stored', async () => {
  const guild = fakeGuild([cat('c1', '💡 Feedback')])
  const updates = []
  const out = await ensureFeedbackChannel(guild, { verifiedRoleId: 'VER' }, { update: async (...a) => updates.push(a) })
  assert.deepEqual(guild.created.map((o) => o.name), ['feedback'])
  assert.equal(guild.created[0].parent, 'c1')
  assert.deepEqual(updates, [['G1', { feedbackChannelId: out.channel.id }]])
})

test('ensure: no Verified role configured is an error, and nothing is created', async () => {
  const guild = fakeGuild()
  await assert.rejects(() => ensureFeedbackChannel(guild, {}, { update: async () => {} }), /No Verified role is configured — run \/init first\./)
  assert.deepEqual(guild.created, [])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test bot/src/services/feedback.test.js`
Expected: FAIL — cannot find module `./feedback.js`.

- [ ] **Step 3: Implement**

1. Create `bot/src/Database/migrations/029_guild_feedback_channel.sql`:

```sql
-- guildconfig.feedbackChannelId: the #feedback channel /feedback posts into
-- (roadmap sub-project 3, 2026-09-29; spec docs/superpowers/specs/2026-09-29-
-- global-channel-layout-design.md). Stored so a renamed or moved #feedback is
-- still found; the name inside the Feedback category is only the fallback.
-- Guarded so the file can run twice.

SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guildconfig' AND COLUMN_NAME = 'feedbackChannelId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE guildconfig ADD COLUMN feedbackChannelId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

2. In `bot/src/Database/index.js` `updateGuildConfig`, after the `supportVoiceChannelId` block, add:

```js
  if (data.feedbackChannelId !== undefined) {
    sets.push("feedbackChannelId = ?");
    vals.push(data.feedbackChannelId);
  }
```

3. In `bot/src/config/channel-defaults.json`, add to `pinnedMessages` (keep valid JSON — add a comma after the previous entry):

```json
    "feedback": "**Feedback** — Tell us what to improve: the server, the bot, UBS-Doc or how we work. Type here, or use **/feedback** from any channel to post a tidy card with a type (Bug, Idea, Process or Other)."
```

4. Create `bot/src/services/feedback.js`:

```js
// #feedback: where staff tell us what to improve (roadmap sub-project 3,
// 2026-09-29). Found by the id stored on guildconfig, falling back to a
// #feedback inside the Feedback category. Verified only — clients never hold
// Verified, so they never see it.

import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { CATEGORY_FEEDBACK, CHANNEL_FEEDBACK } from '../constants.js'
import { FEEDBACK_TOPIC } from './globalLayout.js'
import { getChannelPinnedMessage } from '../config/commands.js'
import { updateGuildConfig } from '../db/index.js'

const REASON = 'Granjur feedback channel'

export function feedbackOverwrites(guild, verifiedRoleId) {
  return [
    { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: verifiedRoleId,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages],
    },
  ]
}

const cached = (guild) => [...(guild.channels?.cache?.values?.() ?? [])]

/** A stored id, cache first then a fetch: a cold cache must not read as "gone". */
async function resolveChannel(guild, id) {
  if (!id) return null
  return guild.channels?.cache?.get?.(id) ?? (await guild.channels?.fetch?.(id).catch(() => null)) ?? null
}

function feedbackCategory(guild) {
  return cached(guild).find((c) => c?.type === ChannelType.GuildCategory && c.name === CATEGORY_FEEDBACK) ?? null
}

export async function findFeedbackChannel(guild, cfg) {
  const stored = await resolveChannel(guild, cfg?.feedbackChannelId)
  if (stored && stored.type === ChannelType.GuildText) return stored
  const category = feedbackCategory(guild)
  if (!category) return null
  return cached(guild).find((c) => c?.type === ChannelType.GuildText && c.name === CHANNEL_FEEDBACK && c.parentId === category.id) ?? null
}

/** Idempotent: creates the Feedback category and #feedback only when missing, and stores the id. */
export async function ensureFeedbackChannel(guild, cfg, { update = updateGuildConfig } = {}) {
  if (!cfg?.verifiedRoleId) throw new Error('No Verified role is configured — run /init first.')
  let channel = await findFeedbackChannel(guild, cfg)
  let created = false
  if (!channel) {
    const permissionOverwrites = feedbackOverwrites(guild, cfg.verifiedRoleId)
    const category = feedbackCategory(guild) ?? await guild.channels.create({
      name: CATEGORY_FEEDBACK, type: ChannelType.GuildCategory, permissionOverwrites, reason: REASON,
    })
    channel = await guild.channels.create({
      name: CHANNEL_FEEDBACK, type: ChannelType.GuildText, parent: category.id, topic: FEEDBACK_TOPIC, permissionOverwrites, reason: REASON,
    })
    created = true
    const pinned = getChannelPinnedMessage(CHANNEL_FEEDBACK)
    if (pinned) {
      try {
        const sent = await channel.send({ content: pinned })
        await sent.pin().catch(() => {})
      } catch (e) {
        console.warn('[feedback] could not pin the default message:', e?.message ?? e)
      }
    }
  }
  if (cfg.feedbackChannelId !== channel.id) await update(guild.id, { feedbackChannelId: channel.id })
  return { channel, created }
}
```

5. In `bot/src/commands/setup.js`:
   - add the import `import { ensureFeedbackChannel } from "../services/feedback.js";`;
   - after the `tickets` try/catch block (before `if (tzInput) {`), add:

```js
  // #feedback, for a server set up before it existed. Idempotent like the
  // support pair: creates the category and channel only when missing.
  let feedback = null;
  let feedbackError = null;
  try {
    feedback = await ensureFeedbackChannel(guild, cfg);
  } catch (e) {
    feedbackError = e?.message ?? String(e);
    console.warn("[setup] feedback channel:", feedbackError);
  }
```

   - after the "Ticket channels" `embed.addFields(...)`, add:

```js
  embed.addFields({
    name: "Feedback",
    value: feedback
      ? `<#${feedback.channel.id}>${feedback.created ? " — created now" : ""}`
      : `_could not be set up — ${feedbackError ?? "unknown error"}_`,
    inline: false,
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test bot/src/services/feedback.test.js`
Expected: 8 tests pass, `ℹ fail 0`.
Then: `node --check bot/src/commands/setup.js` → no output. And `node -e "JSON.parse(require('fs').readFileSync('bot/src/config/channel-defaults.json','utf8'))"` → no output.

- [ ] **Step 5: Commit**

```bash
git add bot/src/Database/migrations/029_guild_feedback_channel.sql bot/src/Database/index.js bot/src/config/channel-defaults.json bot/src/services/feedback.js bot/src/services/feedback.test.js bot/src/commands/setup.js
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "feat(feedback): #feedback channel, stored id, and /setup creates it once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The `/feedback` command

**Files:**
- Create: `bot/src/commands/feedback.js`
- Modify: `bot/src/commands/index.js` (import + `commandModules`, next to `linkCmd`)
- Modify: `bot/src/config/command-config.json` (`commandRoles`, `dedicatedChannels`, `commandDescriptions` — next to each `"link"` entry)
- Test: `bot/src/commands/feedback.test.js`

**Interfaces:**
- Consumes: `findFeedbackChannel(guild, cfg)` (Task 2); `getGuildConfig` from `bot/src/db/index.js` (default seam only).
- Produces: `FEEDBACK_TYPES`, `FEEDBACK_MAX = 1000`, `buildFeedbackEmbed({ type, message, userId, displayName }) → EmbedBuilder`, `execute(interaction, { getConfig }?)`.

- [ ] **Step 1: Write the failing test**

Create `bot/src/commands/feedback.test.js`:

```js
// Fakes only: `execute` takes the guild-config lookup as a seam, and the guild
// is a plain object. See .claude/rules/tests-never-touch-production.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ChannelType } from 'discord.js'
import { data, execute, buildFeedbackEmbed, FEEDBACK_TYPES, FEEDBACK_MAX } from './feedback.js'

const config = JSON.parse(readFileSync(new URL('../config/command-config.json', import.meta.url), 'utf8'))

function setup({ channel = { id: 'fb', type: ChannelType.GuildText, name: 'feedback', parentId: 'c1' }, sendThrows = false } = {}) {
  const posted = []
  if (channel) channel.send = async (m) => { if (sendThrows) throw new Error('Missing Access'); posted.push(m); return {} }
  const cache = new Map(channel ? [[channel.id, channel]] : [])
  const guild = { id: 'G1', channels: { cache, fetch: async (id) => cache.get(id) ?? null } }
  return { guild, posted }
}

function interaction(guild, { message = 'The board is slow', type = null, member = { displayName: 'Ada' } } = {}) {
  const replies = []
  return {
    guild,
    member,
    user: { id: 'U1', username: 'ada', globalName: 'Ada L' },
    options: { getString: (name) => ({ message, type })[name] ?? null },
    replies,
    editReply: async (p) => { replies.push(p); return p },
  }
}
const cfg = async (gid) => { assert.equal(gid, 'G1'); return { feedbackChannelId: 'fb' } }

test('the command: message required with a 1000 cap, type optional with four choices', () => {
  const json = data.toJSON()
  assert.equal(json.name, 'feedback')
  const [message, type] = json.options
  assert.equal(message.name, 'message')
  assert.equal(message.required, true)
  assert.equal(message.max_length, FEEDBACK_MAX)
  assert.equal(FEEDBACK_MAX, 1000)
  assert.equal(type.name, 'type')
  assert.equal(type.required, false)
  assert.deepEqual(type.choices.map((c) => [c.name, c.value]), [['Bug', 'bug'], ['Idea', 'idea'], ['Process', 'process'], ['Other', 'other']])
  assert.deepEqual(FEEDBACK_TYPES, { bug: 'Bug', idea: 'Idea', process: 'Process', other: 'Other' })
})

test('the embed: type title, the text, and who sent it', () => {
  const e = buildFeedbackEmbed({ type: 'idea', message: 'Dark mode', userId: 'U1', displayName: 'Ada' }).toJSON()
  assert.equal(e.title, 'Idea feedback')
  assert.equal(e.description, 'Dark mode')
  assert.deepEqual(e.fields, [{ name: 'From', value: '<@U1> (Ada)', inline: false }])
  assert.equal(buildFeedbackEmbed({ type: 'nonsense', message: 'x', userId: 'U1', displayName: 'Ada' }).toJSON().title, 'Other feedback')
})

test('posts the card in #feedback and thanks the sender privately; type defaults to Other', async () => {
  const { guild, posted } = setup()
  const it = interaction(guild)
  await execute(it, { getConfig: cfg })
  assert.equal(posted.length, 1)
  assert.equal(posted[0].embeds[0].toJSON().title, 'Other feedback')
  assert.equal(posted[0].embeds[0].toJSON().description, 'The board is slow')
  assert.deepEqual(posted[0].allowedMentions, { parse: [] })
  assert.deepEqual(it.replies.at(-1), { content: 'Thanks — posted in <#fb>.' })
})

test('no #feedback yet: the run-/setup reply, nothing posted', async () => {
  const { guild } = setup({ channel: null })
  const it = interaction(guild)
  await execute(it, { getConfig: async () => ({}) })
  assert.deepEqual(it.replies.at(-1), { content: "There's no #feedback channel yet — ask an admin to run /setup." })
})

test('a message over the cap, or blank, is refused before anything is looked up', async () => {
  const { guild, posted } = setup()
  let looked = false
  const it = interaction(guild, { message: 'x'.repeat(FEEDBACK_MAX + 1) })
  await execute(it, { getConfig: async () => { looked = true; return {} } })
  assert.match(it.replies.at(-1).content, /limited to 1000 characters/)
  const blank = interaction(guild, { message: '   ' })
  await execute(blank, { getConfig: async () => { looked = true; return {} } })
  assert.match(blank.replies.at(-1).content, /empty/)
  assert.equal(looked, false)
  assert.equal(posted.length, 0)
})

test('a post Discord refuses gets a clear reply, not a thank-you', async () => {
  const { guild } = setup({ sendThrows: true })
  const it = interaction(guild)
  const warn = console.warn
  console.warn = () => {}
  try { await execute(it, { getConfig: cfg }) } finally { console.warn = warn }
  assert.equal(it.replies.at(-1).content, "I couldn't post in <#fb> — ask an admin to check my permissions there.")
})

test('config: Verified only, no dedicated channel, never a client command, described', () => {
  assert.deepEqual(config.commandRoles.feedback, ['Verified'])
  assert.equal(config.dedicatedChannels.feedback, false)
  assert.ok(!config.clientCommands.includes('feedback'))
  assert.match(config.commandDescriptions.feedback.syntax, /\/feedback/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test bot/src/commands/feedback.test.js`
Expected: FAIL — cannot find module `./feedback.js`.

- [ ] **Step 3: Implement**

1. Create `bot/src/commands/feedback.js`:

```js
// /feedback: post an improvement idea to #feedback from any channel (roadmap
// sub-project 3, 2026-09-29). People can also type in #feedback directly; this
// is the tidy-card path. The reply is private (the default deferral).

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import { getGuildConfig } from '../db/index.js'
import { findFeedbackChannel } from '../services/feedback.js'

export const FEEDBACK_TYPES = Object.freeze({ bug: 'Bug', idea: 'Idea', process: 'Process', other: 'Other' })
export const FEEDBACK_MAX = 1000
const COLORS = { bug: 0xed4245, idea: 0x57f287, process: 0x5865f2, other: 0x99aab5 }

export const data = new SlashCommandBuilder()
  .setName('feedback')
  .setDescription('Tell us what to improve — posted in #feedback')
  .addStringOption((o) =>
    o.setName('message').setDescription('What should we improve?').setRequired(true).setMaxLength(FEEDBACK_MAX),
  )
  .addStringOption((o) =>
    o
      .setName('type')
      .setDescription('What kind of feedback (default: Other)')
      .setRequired(false)
      .addChoices(...Object.entries(FEEDBACK_TYPES).map(([value, name]) => ({ name, value }))),
  )

export function buildFeedbackEmbed({ type, message, userId, displayName }) {
  const key = Object.hasOwn(FEEDBACK_TYPES, type) ? type : 'other'
  return new EmbedBuilder()
    .setTitle(`${FEEDBACK_TYPES[key]} feedback`)
    .setDescription(message)
    .setColor(COLORS[key])
    .addFields({ name: 'From', value: `<@${userId}> (${displayName})`, inline: false })
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction already deferred (ephemeral)
 * @param {{ getConfig?: (guildId: string) => Promise<object|null> }} [deps]
 */
export async function execute(interaction, { getConfig = getGuildConfig } = {}) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const message = (interaction.options.getString('message') ?? '').trim()
  if (!message) return interaction.editReply({ content: 'Write something to send — the message was empty.' })
  if (message.length > FEEDBACK_MAX) {
    return interaction.editReply({ content: `Feedback is limited to ${FEEDBACK_MAX} characters — yours is ${message.length}.` })
  }

  const cfg = await getConfig(guild.id)
  const channel = await findFeedbackChannel(guild, cfg)
  if (!channel) return interaction.editReply({ content: "There's no #feedback channel yet — ask an admin to run /setup." })

  const type = interaction.options.getString('type') ?? 'other'
  const displayName = interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username
  try {
    await channel.send({
      embeds: [buildFeedbackEmbed({ type, message, userId: interaction.user.id, displayName })],
      allowedMentions: { parse: [] },
    })
  } catch (e) {
    console.warn('[feedback] post failed:', e?.message ?? e)
    return interaction.editReply({ content: `I couldn't post in <#${channel.id}> — ask an admin to check my permissions there.` })
  }
  return interaction.editReply({ content: `Thanks — posted in <#${channel.id}>.` })
}
```

2. `bot/src/commands/index.js`: add `import * as feedbackCmd from './feedback.js'` after the `linkCmd` import, and `feedbackCmd,` after `linkCmd,` in `commandModules`.

3. `bot/src/config/command-config.json` (keep valid JSON):
   - `commandRoles`: add `"feedback": ["Verified"],` after `"link": ["Verified"],`;
   - `dedicatedChannels`: add `"feedback": false,` after `"link": false,`;
   - `commandDescriptions`: add after the `"link": { … },` entry:

```json
    "feedback": {
      "summary": "Tell us what to improve.",
      "syntax": "`/feedback message:<text> [type:Bug|Idea|Process|Other]`",
      "detail": "Posts your message in **#feedback** as a card with your name and the type you pick (Other if you pick none). You can also type in #feedback directly. Up to 1000 characters."
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test bot/src/commands/feedback.test.js bot/src/config/commandGates.test.js`
Expected: all pass, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add bot/src/commands/feedback.js bot/src/commands/feedback.test.js bot/src/commands/index.js bot/src/config/command-config.json
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "feat(feedback): /feedback posts a card in #feedback; Verified only, never clients

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `/init` builds the trimmed layout

**Files:**
- Modify: `bot/src/services/globalLayout.js` (add `createGlobalCategories`)
- Modify: `bot/src/commands/init.js`
- Test: `bot/src/services/globalLayout.test.js`

**Interfaces:**
- Consumes: `GLOBAL_LAYOUT` (Task 1); `CHANNEL_FEEDBACK` (Task 1); `updateGuildConfig(…, { feedbackChannelId })` (Task 2).
- Produces: `async createGlobalCategories(guild, entries) → Map<string, channel>` keyed by category name and by channel name.

- [ ] **Step 1: Write the failing test**

Append to `bot/src/services/globalLayout.test.js` (and add `createGlobalCategories` to its import list):

```js
test('createGlobalCategories makes each category, then its channels under it, in order', async () => {
  const calls = []
  let n = 0
  const guild = {
    channels: {
      create: async (opts) => { n += 1; calls.push(opts); return { id: `id${n}`, name: opts.name } },
    },
  }
  const entries = GLOBAL_LAYOUT.filter((e) => e.category !== '📥 Onboarding')
  const made = await createGlobalCategories(guild, entries)
  assert.deepEqual(calls.map((c) => c.name), [
    '📢 Announcements', 'announcements-all', 'announcements-verified', 'announcements-leadership', 'admin',
    '💬 Casual', 'casual-chat', 'off-topic', 'voice-lounge',
    '📚 Documentation', 'documentation',
    '💡 Feedback', 'feedback',
    '📋 Meetings', 'general-meetings', 'meeting-voice', 'upcoming-meetings',
  ])
  assert.equal(calls[0].type, ChannelType.GuildCategory)
  assert.equal(calls[1].parent, 'id1')
  assert.equal(calls[1].topic, 'Announcements for everyone')
  assert.equal(calls.find((c) => c.name === 'voice-lounge').type, ChannelType.GuildVoice)
  assert.equal(made.get('feedback').id, 'id13')
  assert.equal(made.get('📚 Documentation').id, 'id10')
  assert.equal(made.get('documentation').id, 'id11')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test bot/src/services/globalLayout.test.js`
Expected: FAIL — `createGlobalCategories` is not exported.

- [ ] **Step 3: Implement `createGlobalCategories`**

Append to `bot/src/services/globalLayout.js`:

```js
/**
 * Create each category, then its channels under it, in order. Categories
 * append to the bottom of the server list, so creation order IS the order.
 * @returns {Promise<Map<string, object>>} every created channel and category, by name
 */
export async function createGlobalCategories(guild, entries) {
  const made = new Map()
  for (const entry of entries) {
    const category = await guild.channels.create({ name: entry.category, type: ChannelType.GuildCategory })
    made.set(entry.category, category)
    for (const ch of entry.channels) {
      made.set(ch.name, await guild.channels.create({ ...ch, parent: category.id }))
    }
  }
  return made
}
```

- [ ] **Step 4: Use it in `/init`**

In `bot/src/commands/init.js`:

1. Imports from `'../constants.js'`: after the edits below, the file uses exactly `HIERARCHY_ROLES, DISCIPLINE_ROLES, CATEGORY_ONBOARDING, CHANNEL_ONBOARDING, ROLE_HOLDING, ROLE_VERIFIED, ROLE_CLIENT, ROLE_COLORS, CHANNEL_DOCUMENTATION, CATEGORY_ANNOUNCEMENTS, CHANNEL_ANNOUNCEMENTS_ALL, CHANNEL_ANNOUNCEMENTS_VERIFIED, CHANNEL_ANNOUNCEMENTS_LEADERSHIP, CHANNEL_ADMIN, CHANNEL_FEEDBACK` (plus the separate `EPHEMERAL` import) — import those and nothing else from constants. Change the `'../config/commands.js'` import to `import { getChannelPinnedMessage } from '../config/commands.js'`. Add `import { GLOBAL_LAYOUT, createGlobalCategories } from '../services/globalLayout.js'`.

2. In `execute`, replace the embed description with:

```js
        'This will create:\n' +
          '• **Onboarding**, **Announcements** (all, verified, leadership + **admin** for backlog pings), **Casual**, **Documentation** (in-chat doc traversal), **Feedback**, **Meetings**, **Support**\n' +
          '• **Holding** and **Verified** roles + hierarchy & discipline roles\n\n' +
          'New members see onboarding until they verify via **/verify** (OTP). When someone enters holding, server owner and CEOs are tagged in **admin**.'
```

3. In `runInit`, delete from `const frontendRole = …` (the three discipline-role lookups) through the end of the `'Creating Command channels category'` step, and put in their place:

```js
  debug('runInit: global categories', Date.now() - t0, 'ms')
  // Everything after Onboarding, from the one layout /cleanup also reads.
  const made = await wrapStep('Creating global categories', () =>
    createGlobalCategories(guild, GLOBAL_LAYOUT.filter((e) => e.category !== CATEGORY_ONBOARDING))
  )()
  const documentationChannel = made.get(CHANNEL_DOCUMENTATION) ?? null
  const feedbackChannel = made.get(CHANNEL_FEEDBACK) ?? null
```

   (The old `let documentationChannel = null` / reassignment goes away with the deleted block.)

4. Replace the `'Setting channel permissions'` step's `roleLockedCategories` map and loop body with:

```js
  await wrapStep('Setting channel permissions', async () => {
    for (const [, ch] of channels) {
      if (ch.isThread()) continue
      const parentName = ch.parent?.name ?? ''
      const isOnboarding = onboardingIds.has(ch.id) || onboardingIds.has(ch.parent?.id)
      if (isOnboarding) {
        if (ch.id === category.id || ch.id === onboardingChannel.id) {
          await ch.permissionOverwrites.edit(everyoneId, { ViewChannel: true, ReadMessageHistory: true }).catch(() => {})
          if (ch.id === onboardingChannel.id) {
            await ch.permissionOverwrites.edit(everyoneId, { SendMessages: true }).catch(() => {})
          }
        }
        continue
      }
      // Announcements get their tier permissions below.
      if (parentName === CATEGORY_ANNOUNCEMENTS) continue
      // Everything else — Casual, Documentation, Feedback, Meetings — is
      // Verified-only. Clients never hold Verified, so they see none of it.
      try {
        await ch.permissionOverwrites.edit(everyoneId, { ViewChannel: false })
        await ch.permissionOverwrites.edit(verifiedRole.id, { ViewChannel: true, ReadMessageHistory: true })
        if (ch.type === ChannelType.GuildVoice) {
          await ch.permissionOverwrites.edit(verifiedRole.id, { Connect: true, Speak: true }).catch(() => {})
        }
      } catch (_) {}
    }
    await category.permissionOverwrites.edit(everyoneId, { ViewChannel: true, ReadMessageHistory: true })
    await onboardingChannel.permissionOverwrites.edit(everyoneId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
    })
  })()
```

   Keep `const everyoneId = guild.id`, `const channels = await guild.channels.fetch()` and `const onboardingIds = …` above it; delete the `roleLockedCategories` lines.

5. After the `'Updating senior/dashboard roles'` step, add:

```js
  if (feedbackChannel) {
    await wrapStep('Saving feedback channel', () => updateGuildConfig(guild.id, { feedbackChannelId: feedbackChannel.id }))()
  }
```

   The Support step, the Announcements tier step, the documentation traversal message and the pinned-messages step stay exactly as they are (the pinned step now also pins #feedback's default message from `channel-defaults.json`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test bot/src/services/globalLayout.test.js` → 7 pass, `ℹ fail 0`.
Run: `node --check bot/src/commands/init.js` → no output.
Run: `grep -n "CATEGORY_RULES\|CATEGORY_ARCHIVE\|CATEGORY_FRONTEND\|CATEGORY_COMMAND_CHANNELS\|CATEGORY_DOCUMENTATION\|roleLockedCategories\|getDedicatedChannelCommands" bot/src/commands/init.js` → no matches. (Do not import `init.js` in a scratch script: it loads the db module against the production `.env`.)

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/globalLayout.js bot/src/services/globalLayout.test.js bot/src/commands/init.js
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "feat(init): build the trimmed global layout; store #feedback's id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `/cleanup` trims to the layout, safely

**Files:**
- Modify: `bot/src/commands/cleanup.js`
- Test: `bot/src/commands/cleanup.test.js`

**Interfaces:**
- Consumes: `protectedCategoryNames()`, `protectedChannelNames()` (Task 1); `db.task.findMany({ where: { guildConfigId } })` (existing; rows carry `discordChannelId`, `discordThreadId`); cfg ids `onboardingChannelId`, `adminChannelId`, `timeReportChannelId`, `feedbackChannelId`, `supportChannelId`, `supportVoiceChannelId`.
- Produces: the confirm embed lists channels as `- #name (text|voice, under Parent)` (unchanged) and, when any, a second block of categories as `- 📁 Name`; the pending ids are channels first, then categories.

- [ ] **Step 1: Update the test helpers and write the failing tests**

In `bot/src/commands/cleanup.test.js`:

1. Replace the `seams` helper with:

```js
/** A db that knows only the three tables `/cleanup` reads, and throws on any other. */
function seams(projects = [], { projectThrows = false, userChannels = [], tasks = [], taskThrows = false } = {}) {
  const db = new Proxy(
    {
      userChannel: { findMany: async () => userChannels },
      project: {
        findMany: async ({ where }) => {
          if (projectThrows) throw new Error('read timeout')
          return projects.filter((p) => p.guildConfigId === where.guildConfigId)
        },
      },
      task: {
        findMany: async ({ where }) => {
          if (taskThrows) throw new Error('read timeout')
          assert.equal(where.guildConfigId, CFG.id)
          return tasks
        },
      },
    },
    {
      get(target, key) {
        if (key in target) return target[key]
        throw new Error(`test db: unexpected table ${String(key)}`)
      },
    }
  )
  return { db, getConfig: async (gid) => { assert.equal(gid, 'G1'); return CFG } }
}
```

2. Add below `listedForDeletion`:

```js
/** The category names the confirm button would delete, from the reply. */
function categoriesListed(reply) {
  if (!reply.embeds) return []
  const description = reply.embeds[0].data.description
  return [...description.matchAll(/^- 📁 (.+)$/gm)].map((m) => m[1])
}
```

3. Replace the test `'categories themselves are never listed for deletion'` with:

```js
test('a category is listed only once every channel in it is listed', async () => {
  const stray = category('cat-stray', 'Some Old Category')
  const kept = category('cat-kept', 'Has A Room')
  const reply = await run([], [
    stray, chan('junk', 'random-leftover', { parent: stray }),
    kept, chan('u1', 'aashir-room', { parent: kept }), chan('junk2', 'old-notes', { parent: kept }),
  ], { userChannels: [{ textChannelId: 'u1', voiceChannelId: null }] })
  assert.deepEqual(listedForDeletion(reply), ['random-leftover', 'old-notes'])
  assert.deepEqual(categoriesListed(reply), ['Some Old Category'], 'the category keeping a /create-channel room stays')
})
```

4. Append these tests:

```js
// The live server before the trim (roadmap sub-project 3): the new layout, the
// categories being trimmed, the global ticket categories, and stored channels.
function liveServer() {
  const cats = {
    onboarding: category('c-on', '📥 Onboarding'),
    rules: category('c-rules', '📜 Rules'),
    docs: category('c-docs', '📚 Documentation'),
    meetings: category('c-meet', '📋 Meetings'),
    casual: category('c-cas', '💬 Casual'),
    archive: category('c-arch', '📁 Archive'),
    ann: category('c-ann', '📢 Announcements'),
    frontend: category('c-fe', '⚛️ Frontend'),
    cmds: category('c-cmd', '📌 Command channels'),
    features: category('c-feat', '<==== ✨ FEATURES ✨ ====>'),
    bugs: category('c-bugs', 'Bugs'),
    feedback: category('c-fb', '💡 Feedback'),
  }
  return [
    ...Object.values(cats),
    chan('on1', 'welcome-and-verify', { parent: cats.onboarding }),
    chan('r1', 'rules', { parent: cats.rules }),
    chan('d1', 'documentation', { parent: cats.docs }),
    chan('m1', 'general-meetings', { parent: cats.meetings }),
    chan('m2', 'standup-k9-text', { parent: cats.meetings }),
    chan('ca1', 'casual-chat', { parent: cats.casual }),
    chan('a1', 'meeting-metadata', { parent: cats.archive }),
    chan('a2', 'sql-dumps', { parent: cats.archive }),
    chan('an1', 'admin', { parent: cats.ann }),
    chan('fe1', 'frontend-chat', { parent: cats.frontend }),
    chan('fe2', 'frontend-voice', { type: ChannelType.GuildVoice, parent: cats.frontend }),
    chan('cmd1', 'cmd-create-task', { parent: cats.cmds }),
    chan('t1', 'feature-0145e3', { parent: cats.features }),
    chan('t2', 'bug-9a9a9a', { parent: cats.bugs }),
    chan('fb1', 'feedback', { parent: cats.feedback }),
    chan('tr', 'time-reports'),
  ]
}

test('the live trim lists exactly the removed channels and their now-empty categories', async () => {
  const guild = fakeGuild(liveServer())
  const it = fakeInteraction(guild)
  const { db } = seams([])
  const cfg = { ...CFG, timeReportChannelId: 'tr', adminChannelId: 'an1', feedbackChannelId: 'fb1' }
  const error = console.error
  console.error = () => {}
  try { await execute(it, { db, getConfig: async () => cfg }) } finally { console.error = error }
  const reply = it.replies.at(-1)
  assert.deepEqual(listedForDeletion(reply).sort(), ['cmd-create-task', 'frontend-chat', 'frontend-voice', 'meeting-metadata', 'rules', 'sql-dumps'])
  assert.deepEqual(categoriesListed(reply).sort(), ['⚛️ Frontend', '📁 Archive', '📌 Command channels', '📜 Rules'])
})

test('a ticket channel a task points at is protected by id, wherever it sits', async () => {
  const reply = await run([], [chan('t9', 'feature-9f9f9f'), chan('junk', 'random-leftover')], {
    tasks: [{ discordChannelId: 't9', discordThreadId: null }],
  })
  assert.deepEqual(listedForDeletion(reply), ['random-leftover'])
})

test('a failed task read lists nothing at all, rather than every ticket', async () => {
  const reply = await run([], [chan('t9', 'feature-9f9f9f')], { taskThrows: true })
  assert.equal(reply.embeds, undefined, 'no confirm button was offered')
  assert.match(reply.content, /could not read this server's tasks/)
})

test('channels whose ids the config stores are protected by id', async () => {
  const guild = fakeGuild([chan('tr', 'time-reports'), chan('fb', 'renamed-feedback'), chan('junk', 'random-leftover')])
  const it = fakeInteraction(guild)
  const { db } = seams([])
  const cfg = { ...CFG, timeReportChannelId: 'tr', feedbackChannelId: 'fb' }
  await execute(it, { db, getConfig: async () => cfg })
  assert.deepEqual(listedForDeletion(it.replies.at(-1)), ['random-leftover'])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test bot/src/commands/cleanup.test.js`
Expected: FAIL — the new tests fail (no task read, no category listing, trimmed channels still protected); the existing tests may also fail on the new `task` table until Step 3.

- [ ] **Step 3: Implement**

In `bot/src/commands/cleanup.js`:

1. Replace the constants import with only what is still used — `CATEGORY_SUPPORT` — and delete `getProtectedChannelNames`, `getProtectedCategoryNames` and the `getDedicatedChannelCommands` import. Add:

```js
import { protectedCategoryNames, protectedChannelNames } from "../services/globalLayout.js";
```

2. In `execute`, replace `const protectedChannels = getProtectedChannelNames();` / `const protectedCategories = getProtectedCategoryNames();` with:

```js
  // From the one global layout /init builds (services/globalLayout.js).
  const protectedChannels = protectedChannelNames();
  const protectedCategories = protectedCategoryNames();
  // Channels the bot stores by id — whatever they are called and wherever
  // they sit. #time-reports lives at the root, outside every category.
  const storedIds = new Set(
    [cfg?.onboardingChannelId, cfg?.adminChannelId, cfg?.timeReportChannelId, cfg?.feedbackChannelId].filter(Boolean),
  );
```

3. After the project read (`const section = projectSectionGuards(projects);`), add:

```js
  // Every task's ticket channel, by id. Tickets for tasks with no project live
  // in the global Features/Bugs categories, and a trim must never offer one up.
  let tasks;
  try {
    tasks = (await dbArg.task.findMany({ where: { guildConfigId: cfg.id } })) ?? [];
  } catch (e) {
    console.error("[cleanup] task read failed:", e);
    return interaction.editReply({
      content:
        "I could not read this server's tasks, and their ticket channels are exactly what a cleanup has to leave alone. Nothing was listed. Try again in a moment.",
    });
  }
  const ticketIds = new Set(tasks.flatMap((t) => [t?.discordChannelId, t?.discordThreadId]).filter(Boolean));
```

4. Add a helper inside `execute`, after `supportCategoryIds` is built:

```js
  // A category that is ours or a project's: never removed, and its channels
  // are judged by the protected-name rule below.
  const isProtectedCategory = (ch) => {
    const name = ch.name.toLowerCase();
    const stripped = name.replace(/^[^\w]+/, "").trim();
    return (
      section.sectionIds.has(ch.id) ||
      section.categoryIds.has(ch.id) ||
      supportCategoryIds.has(ch.id) ||
      protectedCategories.has(name) ||
      section.names.has(name) ||
      section.names.has(stripped)
    );
  };
```

5. In the channel loop, right after `if (userCreatedIds.has(ch.id)) continue;`, add:

```js
    if (storedIds.has(ch.id) || ticketIds.has(ch.id)) continue;
```

   and replace the whole `if (ch.type === ChannelType.GuildCategory) { … continue; }` block with:

```js
    // Categories are decided after the loop, once their channels are known.
    if (ch.type === ChannelType.GuildCategory) continue;
```

6. After the loop (before `if (toDelete.length === 0)`), add:

```js
  // A category goes only when it is not protected and every channel in it is
  // going — the trim would otherwise leave Rules, Archive and the rest behind
  // as empty shells. One protected channel inside (a /create-channel room, a
  // ticket) keeps it.
  const deleting = new Set(toDelete.map((c) => c.id));
  const emptyCategories = [];
  for (const [, ch] of channels) {
    if (!ch || ch.type !== ChannelType.GuildCategory || isProtectedCategory(ch)) continue;
    const children = [...channels.values()].filter((c) => c && (c.parentId ?? c.parent?.id ?? null) === ch.id);
    if (children.every((c) => deleting.has(c.id))) emptyCategories.push(ch);
  }
```

7. Replace the reply-building section, from `if (toDelete.length === 0)` through `await interaction.editReply({ embeds: [embed], components: [row] });`, with:

```js
  if (toDelete.length === 0 && emptyCategories.length === 0) {
    return interaction.editReply({
      content: "No leftover channels found. Everything looks clean.",
    });
  }

  const list = toDelete
    .slice(0, 25)
    .map((ch) => {
      const type = ch.type === ChannelType.GuildVoice ? "voice" : "text";
      const parent = ch.parent?.name || "no category";
      return `- #${ch.name} (${type}, under ${parent})`;
    })
    .join("\n");
  const remaining = toDelete.length > 25 ? `\n_… and ${toDelete.length - 25} more_` : "";
  const categoryBlock = emptyCategories.length
    ? `\n\n**Categories left empty, removed too:**\n${emptyCategories.map((c) => `- 📁 ${c.name}`).join("\n")}`
    : "";

  // Channels first, then their categories: Discord refuses nothing either way,
  // but a category deleted first would orphan its channels mid-run.
  pendingCleanups.set(guild.id, [...toDelete.map((ch) => ch.id), ...emptyCategories.map((c) => c.id)]);

  const total = toDelete.length + emptyCategories.length;
  const embed = new EmbedBuilder()
    .setTitle("Cleanup — Channels to Remove")
    .setDescription(
      `Found **${toDelete.length}** channel(s)${emptyCategories.length ? ` and **${emptyCategories.length}** empty categor${emptyCategories.length === 1 ? "y" : "ies"}` : ""} to remove:\n\n${list}${remaining}${categoryBlock}\n\nUser-created channels (from /create-channel), task tickets and project sections will NOT be removed.`,
    )
    .setColor(0xed4245)
    .setFooter({ text: "This cannot be undone" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("cleanup_confirm")
      .setLabel(`Delete ${total} item(s)`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("cleanup_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
```

   `handleConfirm` needs no change (it deletes the pending ids in order); change only its final message's word "channel(s)" to "item(s)".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test bot/src/commands/cleanup.test.js`
Expected: every test passes (old and new), `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add bot/src/commands/cleanup.js bot/src/commands/cleanup.test.js
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "feat(cleanup): trim to the global layout; protect tickets and stored channels by id; remove emptied categories

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Full suite, knowledge and state

**Files:**
- Create: `.claude/knowledge/global-layout.md`
- Modify: `.claude/knowledge/README.md` (index line)
- Modify: `.claude/state/backlog.md`, `.claude/state/completed.md`, `.claude/state/session.md`

- [ ] **Step 1: Run the full suite**

Run from the repo root: `npm test 2>&1 | tail -9`
Expected: `ℹ fail 0`.

- [ ] **Step 2: Knowledge**

Create `.claude/knowledge/global-layout.md` covering: `services/globalLayout.js` as the single layout for `/init` and `/cleanup` (categories in order, what was removed and why nothing depends on it); `/cleanup`'s protections (layout names + `/migrate` bold names, Features/Bugs, Support by id+name, project sections by id, task tickets by id, stored config channel ids, `/create-channel` rooms) and its empty-category rule; #feedback (`feedbackChannelId`, name fallback, Verified-only overwrites, `/feedback`, `/setup` creating it idempotently); that the live server is never reordered. Add one index line to `.claude/knowledge/README.md`.

- [ ] **Step 3: State**

- `backlog.md`: roadmap item 3 → "BUILT, NOT DEPLOYED" with the rollout: push the bot (migration 029 runs on deploy, `/feedback` registers on start) → `/setup` → `/cleanup`, read the list, confirm. Record under item 1 that the owner decided (2026-09-29) to leave the org-level Admin role as it is.
- `completed.md`: a `2026-09-29` entry at the top with the commit hashes (`git log --oneline main..HEAD`).
- `session.md`: current state.

- [ ] **Step 4: Commit**

```bash
git add .claude/knowledge .claude/state
git -c user.name="Nauraiz Haider" -c user.email="bsse23047@itu.edu.pk" commit -m "docs: global channel layout knowledge and state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Rollout (after merge; each step needs the owner's go-ahead)

1. Push the bot's `main`: the deploy runs migration 029; the restarted bot registers `/feedback`.
2. Run `/setup` on the live server: #feedback appears (the reply's "Feedback" line says "created now").
3. Run `/cleanup`: check the list is only Rules, Archive, the Frontend/Backend/Database channels, the `cmd-*` channels and their now-empty categories (plus any genuinely stray channel). Confirm only then.

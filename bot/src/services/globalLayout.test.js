import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType } from 'discord.js'
import {
  GLOBAL_LAYOUT,
  FEEDBACK_TOPIC,
  GLOBAL_TICKET_CATEGORIES,
  protectedCategoryNames,
  protectedChannelNames,
  createGlobalCategories,
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

test('a legacy plain "Meetings" is the same category as "📋 Meetings", by their shared /migrate bold name', () => {
  const cats = protectedCategoryNames()
  assert.ok(cats.has('meetings'), 'plain Meetings shares 📋 Meetings\' bold name and must be protected too')
  // Rules was never in the layout, so its own legacy alias (there isn't one —
  // 'Rules' has no plain-name key in CATEGORY_BOLD_NAMES) must stay unprotected.
  assert.ok(!cats.has('rules'), 'rules')
  assert.ok(!cats.has('📜 rules'), '📜 rules')
})

test('protected channel names: every layout channel plus the bare general/voice pair', () => {
  const names = protectedChannelNames()
  for (const n of ['welcome-and-verify', 'admin', 'casual-chat', 'feedback', 'upcoming-meetings', 'general', 'voice']) {
    assert.ok(names.has(n), n)
  }
  for (const gone of ['rules', 'meeting-metadata', 'frontend-chat', 'cmd-create-task']) assert.ok(!names.has(gone), gone)
})

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

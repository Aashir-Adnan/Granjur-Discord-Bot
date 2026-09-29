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

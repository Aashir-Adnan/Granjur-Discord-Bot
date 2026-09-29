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

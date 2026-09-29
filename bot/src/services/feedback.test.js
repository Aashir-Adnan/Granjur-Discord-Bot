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

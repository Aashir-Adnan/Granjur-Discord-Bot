import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, PermissionFlagsBits, OverwriteType } from 'discord.js'
import { createTaskTicketChannel, dmTaskAssignees } from './taskTicketChannel.js'

function fakeGuild() {
  const created = []
  const sends = []
  const guild = {
    id: 'guild1',
    channels: {
      cache: { find: () => null },
      create: async (opts) => {
        created.push(opts)
        if (opts.type === ChannelType.GuildCategory) return { id: 'cat1', name: opts.name }
        return {
          id: 'chan1',
          name: opts.name,
          send: async (m) => {
            sends.push(m)
            return { id: 'msg1' }
          },
        }
      },
    },
  }
  guild._created = created
  guild._sends = sends
  return guild
}

test('createTaskTicketChannel makes a private channel and mentions its members', async () => {
  const guild = fakeGuild()
  const channel = await createTaskTicketChannel(guild, {
    taskId: 'abcdef1234567890',
    title: 'Add booking rules',
    description: 'Do the thing',
    memberIds: ['11', '22', '11', null],
    fields: [{ name: 'Status', value: 'open', inline: true }],
    closeHint: 'Use **/close-feature** in this channel when done.',
  })

  assert.equal(channel.id, 'chan1')
  // Category first, then the text channel.
  assert.equal(guild._created[0].type, ChannelType.GuildCategory)
  assert.equal(guild._created[0].name, 'Features')

  const chan = guild._created[1]
  assert.equal(chan.name, 'feature-567890')
  assert.equal(chan.type, ChannelType.GuildText)
  assert.equal(chan.parent, 'cat1')

  // @everyone denied, each deduped member allowed.
  assert.equal(chan.permissionOverwrites.length, 3)
  assert.equal(chan.permissionOverwrites[0].id, 'guild1')
  assert.deepEqual(chan.permissionOverwrites[0].deny, [PermissionFlagsBits.ViewChannel])
  assert.deepEqual(
    chan.permissionOverwrites.slice(1).map((o) => o.id),
    ['11', '22'],
  )
  // The guild id is a role; the member ids are users. Discord silently discards
  // a user overwrite typed as a role, leaving the channel visible to nobody.
  assert.equal(chan.permissionOverwrites[0].type, OverwriteType.Role)
  assert.deepEqual(
    chan.permissionOverwrites.slice(1).map((o) => o.type),
    [OverwriteType.Member, OverwriteType.Member],
  )

  const sent = guild._sends[0]
  assert.equal(sent.content, '<@11> <@22>')
  const embed = sent.embeds[0].toJSON()
  assert.match(embed.title, /Add booking rules/)
  assert.equal(embed.description, 'Do the thing')
  assert.deepEqual(
    embed.fields.map((f) => f.name),
    ['Status', 'Task ID', 'Close'],
  )
})

test('createTaskTicketChannel tolerates a missing description', async () => {
  const guild = fakeGuild()
  await createTaskTicketChannel(guild, { taskId: 'x1', title: 'T', memberIds: ['9'] })
  assert.equal(guild._sends[0].embeds[0].toJSON().description, 'No description.')
})

test('dmTaskAssignees delivers once per unique id and survives closed DMs', async () => {
  const dms = []
  const client = {
    users: {
      fetch: async (id) => {
        if (id === 'closed') throw new Error('Cannot send messages to this user')
        return { send: async (m) => dms.push([id, m]) }
      },
    },
  }
  const n = await dmTaskAssignees(client, ['11', '11', 'closed', null], {
    title: 'Add booking rules',
    channelId: 'chan1',
  })
  assert.equal(n, 1)
  assert.equal(dms.length, 1)
  assert.equal(dms[0][0], '11')
  assert.match(dms[0][1], /\*\*Add booking rules\*\* — discuss it in <#chan1>/)
})

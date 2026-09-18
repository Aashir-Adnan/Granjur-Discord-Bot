import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, PermissionFlagsBits, OverwriteType } from 'discord.js'
import { createTaskTicketChannel, dmTaskAssignees } from './taskTicketChannel.js'

function fakeGuild() {
  return fakeGuildWithChannels([])
}

/**
 * A guild whose `channels.cache` behaves enough like a discord.js Collection
 * for `resolveParentCategory` (`.get`, `.find`, `.values`) — seeded with
 * `channels`, then extended by every `channels.create` call so a category
 * created mid-test is immediately visible to the next lookup.
 */
function fakeGuildWithChannels(channels = []) {
  const map = new Map(channels.map((c) => [c.id, c]))
  const created = []
  const sends = []
  let nextId = 1
  const guild = {
    id: 'guild1',
    channels: {
      cache: {
        get: (id) => map.get(id) ?? null,
        find: (pred) => [...map.values()].find(pred) ?? null,
        values: () => map.values(),
      },
      create: async (opts) => {
        created.push(opts)
        if (opts.type === ChannelType.GuildCategory) {
          const cat = { id: 'cat1', name: opts.name, parentId: null }
          map.set(cat.id, cat)
          return cat
        }
        const chan = {
          id: `chan${nextId++}`,
          name: opts.name,
          parentId: opts.parent ?? null,
          topic: opts.topic,
          permissionOverwrites: opts.permissionOverwrites,
          send: async (m) => {
            sends.push(m)
            return { id: 'msg1' }
          },
        }
        map.set(chan.id, chan)
        return chan
      },
    },
  }
  guild._created = created
  guild._sends = sends
  guild._map = map
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
  // The id moved out of the name; the topic carries it now.
  assert.match(chan.topic, /Task abcdef1234567890/)

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

test('with a project whose category resolves, the channel is named after the title and parented there', async () => {
  const projectCategory = { id: 'projcat', name: '📂 FRAMEWORK', parentId: null }
  const guild = fakeGuildWithChannels([projectCategory])
  const project = { id: 'p1', name: 'Framework', discordCategoryId: 'projcat' }

  const channel = await createTaskTicketChannel(guild, {
    taskId: 'abcdef1234567890',
    title: 'Add booking rules',
    memberIds: ['11', '22'],
    project,
    type: 'feature',
  })

  // The project's category already existed, so only the channel is created.
  assert.equal(guild._created.length, 1)
  const chan = guild._created[0]
  assert.equal(chan.name, 'feature-add-booking-rules')
  assert.equal(chan.parent, 'projcat')
  assert.match(chan.topic, /Task abcdef1234567890/)
  assert.equal(channel.parentId, 'projcat')

  // Per-member overwrites are still present alongside whatever the category grants.
  assert.equal(chan.permissionOverwrites[0].id, 'guild1')
  assert.equal(chan.permissionOverwrites[0].type, OverwriteType.Role)
  assert.deepEqual(
    chan.permissionOverwrites.slice(1).map((o) => o.id),
    ['11', '22'],
  )
  assert.deepEqual(
    chan.permissionOverwrites.slice(1).map((o) => o.type),
    [OverwriteType.Member, OverwriteType.Member],
  )
})

test('with no project, the channel keeps the global category and the short-id name', async () => {
  const guild = fakeGuild()
  const channel = await createTaskTicketChannel(guild, {
    taskId: 'abcdef1234567890',
    title: 'Add booking rules',
    memberIds: ['11'],
    type: 'feature',
  })
  assert.equal(guild._created[0].name, 'Features')
  const chan = guild._created[1]
  assert.equal(chan.name, 'feature-567890')
  assert.equal(chan.parent, 'cat1')
  assert.equal(channel.name, 'feature-567890')
})

test('a project category id that no longer resolves falls back to the global category, keeps the readable name, and warns', async () => {
  const guild = fakeGuildWithChannels([])
  const project = { id: 'p1', name: 'Framework', discordCategoryId: 'gone' }
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let channel
  try {
    channel = await createTaskTicketChannel(guild, {
      taskId: 'abcdef1234567890',
      title: 'Add booking rules',
      memberIds: ['11'],
      project,
      type: 'feature',
    })
  } finally {
    console.warn = originalWarn
  }

  assert.equal(guild._created[0].type, ChannelType.GuildCategory)
  assert.equal(guild._created[0].name, 'Features')
  const chan = guild._created[1]
  // A project was given, so the name still reads the title — only the parent falls back.
  assert.equal(chan.name, 'feature-add-booking-rules')
  assert.equal(chan.parent, 'cat1')
  assert.equal(channel.parentId, 'cat1')
  assert.ok(warnings.some((w) => w.includes('Framework') && w.includes('Features')))
})

test('a project category at the soft cap falls back to the global category and warns', async () => {
  const projectCategory = { id: 'projcat', name: '📂 FRAMEWORK', parentId: null }
  const packed = Array.from({ length: 49 }, (_, i) => ({ id: `c${i}`, name: `chan-${i}`, parentId: 'projcat' }))
  const guild = fakeGuildWithChannels([projectCategory, ...packed])
  const project = { id: 'p1', name: 'Framework', discordCategoryId: 'projcat' }
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let channel
  try {
    channel = await createTaskTicketChannel(guild, {
      taskId: 'abcdef1234567890',
      title: 'Add booking rules',
      memberIds: ['11'],
      project,
      type: 'feature',
    })
  } finally {
    console.warn = originalWarn
  }

  assert.equal(guild._created[0].type, ChannelType.GuildCategory)
  assert.equal(guild._created[0].name, 'Features')
  const chan = guild._created[1]
  assert.equal(chan.name, 'feature-add-booking-rules')
  assert.equal(chan.parent, 'cat1')
  assert.equal(channel.parentId, 'cat1')
  assert.ok(warnings.some((w) => w.includes('Framework') && w.includes('cap')))
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

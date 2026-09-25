import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, PermissionFlagsBits, OverwriteType } from 'discord.js'
import { createTaskTicketChannel, dmTaskAssignees } from './taskTicketChannel.js'
import { ARCHIVE_DIVIDER_NAME, ARCHIVE_DIVIDER_TOPIC } from '../utils/ticketArchive.js'

function fakeGuild() {
  return fakeGuildWithChannels([])
}

/**
 * A guild whose `channels.cache` behaves enough like a discord.js Collection
 * for `resolveParentCategory` (`.get`, `.find`, `.values`) — seeded with
 * `channels`, then extended by every `channels.create` call so a category
 * created mid-test is immediately visible to the next lookup.
 *
 * Every channel carries a `rawPosition` (creation order, as Discord assigns
 * it) and a `type`, because `textChannelsOf` sorts on the first and filters on
 * the second. `channels.setPositions` records the one reorder call the archive
 * divider costs.
 */
function fakeGuildWithChannels(channels = []) {
  const map = new Map(channels.map((c, i) => [c.id, { rawPosition: i, ...c }]))
  const created = []
  const sends = []
  const positions = []
  let nextId = 1
  const guild = {
    id: 'guild1',
    channels: {
      cache: {
        get: (id) => map.get(id) ?? null,
        find: (pred) => [...map.values()].find(pred) ?? null,
        values: () => map.values(),
      },
      setPositions: async (list) => {
        positions.push(list)
        return undefined
      },
      create: async (opts) => {
        created.push(opts)
        if (opts.type === ChannelType.GuildCategory) {
          const cat = { id: 'cat1', name: opts.name, parentId: null, type: ChannelType.GuildCategory, rawPosition: map.size }
          map.set(cat.id, cat)
          return cat
        }
        const chan = {
          id: `chan${nextId++}`,
          name: opts.name,
          type: opts.type ?? ChannelType.GuildText,
          // Discord puts a new channel last in its category.
          rawPosition: map.size,
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
  guild._positions = positions
  guild._map = map
  return guild
}

/** Run something that warns on purpose, without spraying the test output. */
async function quiet(fn) {
  const real = console.warn
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    console.warn = real
  }
}

test('createTaskTicketChannel makes a private channel and mentions its members', async () => {
  const guild = fakeGuild()
  const { channel } = await createTaskTicketChannel(guild, {
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
  const projectCategory = { id: 'projcat', name: '📂 FRAMEWORK', parentId: null, type: ChannelType.GuildCategory }
  const guild = fakeGuildWithChannels([projectCategory])
  const project = { id: 'p1', name: 'Framework', discordCategoryId: 'projcat' }

  const { channel } = await createTaskTicketChannel(guild, {
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

test('a task channel inside a project section allows the project role explicitly', async () => {
  const projectCategory = { id: 'projcat', name: '📂 FRAMEWORK', parentId: null, type: ChannelType.GuildCategory }
  const guild = fakeGuildWithChannels([projectCategory])
  guild.roles = { cache: new Map([['role1', { id: 'role1', name: 'Framework' }]]) }
  const project = { id: 'p1', name: 'Framework', discordCategoryId: 'projcat', discordRoleId: 'role1' }

  await createTaskTicketChannel(guild, {
    taskId: 'abcdef1234567890',
    title: 'Add booking rules',
    memberIds: ['11'],
    project,
    type: 'feature',
  })

  // Passing an explicit overwrite array makes Discord store EXACTLY that set —
  // nothing is copied from the category and resolution never walks up to it —
  // so without the role entry here the project members this channel belongs to
  // cannot see their own task.
  const chan = guild._created[0]
  assert.deepEqual(
    chan.permissionOverwrites.map((o) => [o.id, o.type]),
    [
      ['guild1', OverwriteType.Role],
      ['role1', OverwriteType.Role],
      ['11', OverwriteType.Member],
    ],
  )
  // Both the role and the member get the six text bits: attachments, embeds
  // and reactions ride with view/send/history, never on @everyone's defaults.
  const six = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AddReactions,
  ]
  assert.deepEqual(chan.permissionOverwrites[1].allow, six)
  assert.deepEqual(chan.permissionOverwrites[2].allow, six)
})

test('a stale project role id is left off the overwrites rather than failing the create', async () => {
  const projectCategory = { id: 'projcat', name: '📂 FRAMEWORK', parentId: null, type: ChannelType.GuildCategory }
  const guild = fakeGuildWithChannels([projectCategory])
  // The role was deleted; the project row still names it.
  guild.roles = { cache: new Map() }
  const project = { id: 'p1', name: 'Framework', discordCategoryId: 'projcat', discordRoleId: 'deleted-role' }

  const out = await createTaskTicketChannel(guild, {
    taskId: 'abcdef1234567890',
    title: 'Add booking rules',
    memberIds: ['11'],
    project,
    type: 'feature',
  })

  // An overwrite for an unknown role can make Discord reject the whole create,
  // and /create-task has already written the row by then.
  assert.equal(out.fellBack, null)
  assert.equal(guild._created[0].parent, 'projcat')
  assert.deepEqual(
    guild._created[0].permissionOverwrites.map((o) => o.id),
    ['guild1', '11'],
  )
})

test('a channel that fell back to the global category does NOT carry the project role', async () => {
  const guild = fakeGuildWithChannels([])
  // The role exists, so only the fallback can be what keeps it off.
  guild.roles = { cache: new Map([['role1', { id: 'role1', name: 'Framework' }]]) }
  const project = { id: 'p1', name: 'Framework', discordCategoryId: 'gone', discordRoleId: 'role1' }
  const out = await quiet(() =>
    createTaskTicketChannel(guild, {
      taskId: 'abcdef1234567890',
      title: 'Add booking rules',
      memberIds: ['11'],
      project,
      type: 'feature',
    }),
  )
  assert.equal(out.fellBack, 'missing')
  // In the global Features category the audience is the assignees, as it has
  // always been. Adding the project role there would grant a whole project
  // access nobody asked for.
  const chan = guild._created[1]
  assert.deepEqual(
    chan.permissionOverwrites.map((o) => o.id),
    ['guild1', '11'],
  )
})

test('a stored category id that resolves to a text channel is not used as a parent', async () => {
  // Passing a text channel as `parent` fails at Discord, and it fails after the
  // task row has already been written.
  const notACategory = { id: 'projcat', name: 'framework-members', parentId: 'somecat', type: ChannelType.GuildText }
  const guild = fakeGuildWithChannels([notACategory])
  const project = { id: 'p1', name: 'Framework', discordCategoryId: 'projcat' }
  const out = await quiet(() =>
    createTaskTicketChannel(guild, {
      taskId: 'abcdef1234567890',
      title: 'Add booking rules',
      memberIds: ['11'],
      project,
      type: 'feature',
    }),
  )
  assert.equal(out.fellBack, 'missing')
  assert.equal(guild._created[0].name, 'Features')
  assert.equal(guild._created[1].parent, 'cat1')
})

test('onCreated runs between the create and the opening embed', async () => {
  const guild = fakeGuild()
  const order = []
  const realSends = guild._sends
  await createTaskTicketChannel(guild, {
    taskId: 'abcdef1234567890',
    title: 'Add booking rules',
    memberIds: ['11'],
    onCreated: async (channel) => {
      // The row is pointed at the channel here, so a `send` that throws cannot
      // leave a channel with nothing pointing at it.
      order.push(['onCreated', channel.id, realSends.length])
    },
  })
  assert.deepEqual(order, [['onCreated', 'chan1', 0]])
  assert.equal(realSends.length, 1)
})

test('with no project, the channel keeps the global category and the short-id name', async () => {
  const guild = fakeGuild()
  const { channel } = await createTaskTicketChannel(guild, {
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
  let out
  try {
    out = await createTaskTicketChannel(guild, {
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
  assert.equal(out.channel.parentId, 'cat1')
  // The reason comes back so /create-task can say it; a console.warn reaches nobody.
  assert.equal(out.fellBack, 'missing')
  assert.ok(warnings.some((w) => w.includes('Framework') && w.includes('Features')))
})

test('a project category at the soft cap falls back to the global category and warns', async () => {
  const projectCategory = { id: 'projcat', name: '📂 FRAMEWORK', parentId: null, type: ChannelType.GuildCategory }
  const packed = Array.from({ length: 49 }, (_, i) => ({ id: `c${i}`, name: `chan-${i}`, parentId: 'projcat' }))
  const guild = fakeGuildWithChannels([projectCategory, ...packed])
  const project = { id: 'p1', name: 'Framework', discordCategoryId: 'projcat' }
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let out
  try {
    out = await createTaskTicketChannel(guild, {
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
  assert.equal(out.channel.parentId, 'cat1')
  assert.equal(out.fellBack, 'cap')
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

test('dmTaskAssignees takes a headline, so a lead is not told they were "assigned" a client request', async () => {
  const dms = []
  const client = { users: { fetch: async (id) => ({ send: async (m) => dms.push([id, m]) }) } }
  await dmTaskAssignees(client, ['lead1'], {
    title: 'Login fails',
    channelId: 'chan1',
    headline: 'A client raised **Login fails**',
  })
  assert.match(dms[0][1], /^A client raised \*\*Login fails\*\* — discuss it in <#chan1>\./)
  assert.ok(!dms[0][1].includes("You've been assigned"))
})

// ---- the archive divider ----------------------------------------------------
const cat = (id, name) => ({ id, name, parentId: null, type: ChannelType.GuildCategory })
const dividerIn = (parentId) => ({
  id: 'div', name: ARCHIVE_DIVIDER_NAME, parentId, type: ChannelType.GuildText, topic: ARCHIVE_DIVIDER_TOPIC,
})
const ticketIn = (id, parentId) => ({ id, name: `feature-${id}`, parentId, type: ChannelType.GuildText, topic: `Feature: X — Task ${id}` })
const dividedProject = () => ({
  id: 'p1', name: 'Framework', discordCategoryId: 'projcat', discordRoleId: 'r1',
  discordChannels: { archiveDivider: 'div' },
})

test('a live ticket created under a category with a divider is ordered just above the line, in one call', async () => {
  const guild = fakeGuildWithChannels([cat('projcat', '📂 FRAMEWORK'), ticketIn('t1', 'projcat'), dividerIn('projcat'), ticketIn('a1', 'projcat')])
  guild.roles = { cache: new Map([['r1', { id: 'r1' }]]) }
  const out = await createTaskTicketChannel(guild, { taskId: 'a1b2c3d4e5f6', title: 'New', memberIds: [], project: dividedProject(), type: 'feature' })
  assert.equal(out.placed, 'section')
  assert.equal(guild._positions.length, 1, 'exactly one setPositions')
  // Discord created it last, below the line; it belongs at the bottom of the
  // live group, and the already-archived ticket stays below the divider.
  assert.deepEqual(guild._positions[0].map((e) => e.channel), ['t1', out.channel.id, 'div', 'a1'])
  assert.deepEqual(guild._positions[0].map((e) => e.position), [0, 1, 2, 3])
})

test('a ticket created already finished is left where Discord put it — below the line, no reorder', async () => {
  const guild = fakeGuildWithChannels([cat('projcat', '📂 FRAMEWORK'), ticketIn('t1', 'projcat'), dividerIn('projcat')])
  const out = await createTaskTicketChannel(guild, { taskId: 'a1', title: 'Old', memberIds: [], project: dividedProject(), type: 'feature', status: 'done' })
  assert.equal(out.placed, 'section')
  assert.deepEqual(guild._positions, [])
})

test('no divider — none stored, gone, not a text channel, or in another category — means no reorder at all', async () => {
  const base = [cat('projcat', '📂 FRAMEWORK'), ticketIn('t1', 'projcat')]
  const cases = [
    ['none stored', base, { ...dividedProject(), discordChannels: {} }],
    ['id no longer resolves', base, dividedProject()],
    ['stored id is a category', [...base, cat('div', 'nope')], dividedProject()],
    ['divider is in another category', [...base, dividerIn('ELSEWHERE')], dividedProject()],
  ]
  for (const [what, channels, project] of cases) {
    const guild = fakeGuildWithChannels(channels)
    await createTaskTicketChannel(guild, { taskId: 'a1', title: 'New', memberIds: [], project, type: 'feature' })
    assert.deepEqual(guild._positions, [], what)
  }
})

test('a refused reorder is one warning, never a failed create', async () => {
  const guild = fakeGuildWithChannels([cat('projcat', '📂 FRAMEWORK'), ticketIn('t1', 'projcat'), dividerIn('projcat')])
  guild.channels.setPositions = async () => { throw new Error('Missing Permissions') }
  const warnings = []
  const real = console.warn
  console.warn = (...a) => warnings.push(a.join(' '))
  let out
  try {
    out = await createTaskTicketChannel(guild, { taskId: 'a1', title: 'New', memberIds: [], project: dividedProject(), type: 'feature' })
  } finally { console.warn = real }
  assert.equal(out.placed, 'section')
  assert.ok(warnings.some((w) => w.includes('archive divider') && w.includes('Missing Permissions')))
  // The opening embed still went out: the ticket is usable, just one row low.
  assert.equal(guild._sends.length, 1)
})

test('with no section category the global category is used, as before, and nothing is reordered', async () => {
  const guild = fakeGuildWithChannels([])
  const out = await quiet(() => createTaskTicketChannel(guild, { taskId: 'a1', title: 'One', memberIds: [], project: dividedProject(), type: 'feature' }))
  assert.equal(out.placed, 'global')
  assert.equal(out.fellBack, 'missing')
  assert.deepEqual(guild._positions, [])
})


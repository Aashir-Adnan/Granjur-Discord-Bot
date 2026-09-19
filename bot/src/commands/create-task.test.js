import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, OverwriteType } from 'discord.js'
import * as flowStore from '../flows/store.js'
import { assigneeRow, scopeRow, handleCreate, channelPlacementNote } from './create-task.js'
import { createTaskTicketChannel } from '../services/taskTicketChannel.js'

test('assignee row is a user select allowing up to 25 people with current assignees preselected', () => {
  const row = assigneeRow({ assigneeIds: ['111', '222'] }).toJSON()
  const menu = row.components[0]
  assert.equal(menu.custom_id, 'create_task_assignees')
  assert.equal(menu.type, 5) // ComponentType.UserSelect
  assert.equal(menu.min_values, 0)
  assert.equal(menu.max_values, 25)
  assert.deepEqual(menu.default_values.map((d) => d.id), ['111', '222'])
})

test('assignee row with no assignees has no defaults', () => {
  const menu = assigneeRow({}).toJSON().components[0]
  assert.ok(!menu.default_values || menu.default_values.length === 0)
})

test('scope row offers exactly the four fixed choices', () => {
  const menu = scopeRow().toJSON().components[0]
  assert.equal(menu.custom_id, 'create_task_scope')
  assert.deepEqual(
    menu.options.map((o) => [o.label, o.value]),
    [['Backend', 'backend'], ['Frontend', 'frontend'], ['QA', 'qa'], ['Design', 'design']],
  )
})

// --- handleCreate, feature branch, through its seams --------------------------
//
// The root .env points at the PRODUCTION database
// (.claude/rules/tests-never-touch-production.md). Every call below passes a
// fake `db` and `getConfig`; neither the default db export nor
// getOrCreateGuildConfig is ever reached.

const getConfig = async (guildId) => ({ id: 'cfg1', guildId })

const PROJECT = { id: 'p1', name: 'Framework', discordCategoryId: 'projcat', discordRoleId: 'role1' }

function fakeDb(log, project = PROJECT) {
  return {
    project: { findFirst: async ({ where }) => (where.id === project?.id ? project : null) },
    feature: {
      create: async ({ data }) => {
        log.push(['feature.create', data])
        return { id: 'task0000abcdef', ...data }
      },
      update: async (args) => {
        log.push(['feature.update', args])
        return null
      },
    },
    featureRepositories: {
      add: async (id, repos) => {
        log.push(['featureRepositories.add', id, repos])
      },
    },
    ticketDoc: {
      create: async ({ data }) => {
        log.push(['ticketDoc.create', data.taskId])
      },
    },
    bugTicket: {
      create: async ({ data }) => {
        log.push(['bugTicket.create', data])
        return { id: 'task0000abcdef', ...data }
      },
      update: async (args) => {
        log.push(['bugTicket.update', args])
        return null
      },
    },
  }
}

function fakeInteraction(guild) {
  const replies = []
  return {
    guild,
    user: { id: 'u-assigner' },
    isMessageComponent: () => true,
    deferred: true,
    replied: false,
    editReply: async (p) => {
      replies.push(p)
      return p
    },
    replies,
  }
}

function seedState(guild, extra = {}) {
  flowStore.set('u-assigner', guild.id, 'create_task', {
    step: 'confirm',
    taskType: 'feature',
    title: 'Add booking rules',
    description: 'Do the thing',
    scope: 'frontend',
    modules: ['Calendar', 'Rules'],
    assigneeIds: ['u1', 'u2', 'u-assigner'],
    projectIds: ['p1'],
    repositoryIds: ['repo1'],
    ...extra,
  })
}

test('handleCreate creates the feature channel through the seam, row first, and says where it went', async () => {
  const log = []
  const guild = { id: 'guild-ct-1' }
  seedState(guild)
  const it = fakeInteraction(guild)
  const channel = { id: 'chan9' }
  let seen = null
  const createChannel = async (g, opts) => {
    seen = opts
    log.push(['channels.create'])
    await opts.onCreated(channel)
    log.push(['channel.send'])
    return { channel, fellBack: 'cap' }
  }

  await handleCreate(it, { db: fakeDb(log), getConfig, createChannel })

  // The row points at the channel BEFORE the opening embed goes out, so a send
  // that throws cannot leave a channel nothing points at.
  assert.deepEqual(
    log.map((e) => e[0]),
    ['feature.create', 'featureRepositories.add', 'ticketDoc.create', 'channels.create', 'feature.update', 'channel.send'],
  )
  assert.deepEqual(log[4][1], { where: { id: 'task0000abcdef' }, data: { discordChannelId: 'chan9' } })

  // The row itself.
  const row = log[0][1]
  assert.equal(row.guildConfigId, 'cfg1')
  assert.equal(row.projectId, 'p1')
  assert.equal(row.projectName, 'Framework')
  assert.equal(row.title, 'Add booking rules')
  assert.deepEqual(row.assigneeIds, ['u1', 'u2', 'u-assigner'])

  // What the helper was asked for: the project, the deduped member list (the
  // assigner first, once), and the same fields the inline code used to post.
  assert.equal(seen.project.id, 'p1')
  assert.equal(seen.type, 'feature')
  assert.equal(seen.taskId, 'task0000abcdef')
  assert.deepEqual(seen.memberIds, ['u-assigner', 'u1', 'u2'])
  assert.deepEqual(seen.fields, [
    { name: 'Status', value: 'open', inline: true },
    { name: 'Assignees', value: '<@u1> <@u2> <@u-assigner>', inline: true },
    { name: 'Scope / Modules', value: 'Frontend · Calendar, Rules', inline: false },
  ])
  assert.match(seen.closeHint, /\/close-feature/)

  // The reply says the channel was diverted, and why (spec §4, §11).
  const description = it.replies.at(-1).embeds[0].toJSON().description
  assert.match(description, /<#chan9>/)
  assert.match(description, /Framework\*\*'s section is at Discord's 49-channel cap/)
  assert.match(description, /global \*\*Features\*\* category/)
  assert.equal(flowStore.get('u-assigner', guild.id, 'create_task'), null)
})

test('handleCreate through the real helper posts the same embed and mention list it always did', async () => {
  const log = []
  const projectCategory = { id: 'projcat', name: '📂 FRAMEWORK', parentId: null, type: ChannelType.GuildCategory }
  const map = new Map([[projectCategory.id, projectCategory]])
  const created = []
  const sends = []
  const guild = {
    id: 'guild-ct-2',
    roles: { cache: new Map([['role1', { id: 'role1', name: 'Framework' }]]) },
    channels: {
      cache: {
        get: (id) => map.get(id) ?? null,
        find: (p) => [...map.values()].find(p) ?? null,
        values: () => map.values(),
      },
      create: async (opts) => {
        created.push(opts)
        const chan = {
          id: 'chanX',
          name: opts.name,
          parentId: opts.parent,
          send: async (m) => {
            log.push(['channel.send'])
            sends.push(m)
          },
        }
        map.set(chan.id, chan)
        return chan
      },
    },
  }
  seedState(guild)
  const it = fakeInteraction(guild)

  await handleCreate(it, { db: fakeDb(log), getConfig, createChannel: createTaskTicketChannel })

  assert.equal(created.length, 1)
  assert.equal(created[0].parent, 'projcat')
  assert.equal(created[0].name, 'feature-add-booking-rules')
  assert.deepEqual(
    created[0].permissionOverwrites.map((o) => [o.id, o.type]),
    [
      ['guild-ct-2', OverwriteType.Role],
      ['role1', OverwriteType.Role],
      ['u-assigner', OverwriteType.Member],
      ['u1', OverwriteType.Member],
      ['u2', OverwriteType.Member],
    ],
  )
  const order = log.map((e) => e[0])
  assert.ok(order.indexOf('feature.update') < order.indexOf('channel.send'), order.join(' -> '))

  const sent = sends[0]
  assert.equal(sent.content, '<@u-assigner> <@u1> <@u2>')
  const embed = sent.embeds[0].toJSON()
  assert.equal(embed.title, 'Feature: Add booking rules')
  assert.equal(embed.description, 'Do the thing')
  assert.deepEqual(
    embed.fields.map((f) => [f.name, f.value]),
    [
      ['Status', 'open'],
      ['Assignees', '<@u1> <@u2> <@u-assigner>'],
      ['Scope / Modules', 'Frontend · Calendar, Rules'],
      ['Task ID', 'task0000abcdef'],
      ['Close', 'Use **/close-feature** in this channel when done.'],
    ],
  )
  const reply = it.replies.at(-1).embeds[0].toJSON().description
  assert.match(reply, /<#chanX> — in \*\*Framework\*\*'s section\./)
})

// --- handleCreate, bug branch, through its seams ------------------------------
// Previously untested, and previously never wired: the bug branch's insert had
// no `scope` key at all, so a bug task could never carry one however it was set.

function fakeBugGuild() {
  const created = []
  const sends = []
  return {
    id: 'guild-ct-bug',
    channels: {
      cache: { find: () => null, get: () => null, values: () => [].values() },
      create: async (opts) => {
        created.push(opts)
        return { id: 'chanBug', send: async (m) => { sends.push(m) } }
      },
    },
    created,
    sends,
  }
}

test('handleCreate writes scope into the bug ticket, and shows it on the opening embed', async () => {
  const log = []
  const guild = fakeBugGuild()
  flowStore.set('u-assigner', guild.id, 'create_task', {
    step: 'confirm',
    taskType: 'bug',
    title: 'Downtime calc is wrong',
    description: 'Off by a day',
    scope: 'qa',
    repositoryId: 'repo1',
    repo: { name: 'api', url: 'https://example.com/api' },
    taggedMemberIds: ['u1'],
  })
  const it = fakeInteraction(guild)

  await handleCreate(it, { db: fakeDb(log), getConfig })

  const row = log.find((e) => e[0] === 'bugTicket.create')[1]
  assert.equal(row.scope, 'qa')

  // The detailed embed goes to the channel, not the interaction reply.
  const embed = guild.sends[0].embeds[0].toJSON()
  assert.deepEqual(
    embed.fields.map((f) => [f.name, f.value]),
    [
      ['Status', 'pending'],
      ['Scope', 'QA'],
      ['Tagged', '<@u1>'],
      ['Repository', 'https://example.com/api'],
      ['Resolve', 'Use **/resolve-bug** in this channel when fixed.'],
    ],
  )
})

test('handleCreate writes a null scope for a bug ticket that never had one set', async () => {
  const log = []
  const guild = fakeBugGuild()
  flowStore.set('u-assigner', guild.id, 'create_task', {
    step: 'confirm',
    taskType: 'bug',
    title: 'Legacy bug with no scope',
    repositoryId: 'repo1',
    repo: { name: 'api' },
    taggedMemberIds: [],
  })
  const it = fakeInteraction(guild)

  await handleCreate(it, { db: fakeDb(log), getConfig })

  const row = log.find((e) => e[0] === 'bugTicket.create')[1]
  assert.equal(row.scope, null)
})

test('channelPlacementNote says where the channel went and why', () => {
  const p = { name: 'Framework' }
  assert.equal(channelPlacementNote('<#1>', null, null), 'Channel: <#1>\nUse **/close-feature** there when done.')
  assert.match(channelPlacementNote('<#1>', p, null), /^Channel: <#1> — in \*\*Framework\*\*'s section\./)
  assert.match(channelPlacementNote('<#1>', p, 'cap'), /49-channel cap, so this went to the global \*\*Features\*\* category instead/)
  assert.match(channelPlacementNote('<#1>', p, 'missing'), /has no Discord section yet[\s\S]*\/project-setup/)
})

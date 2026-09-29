import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, OverwriteType } from 'discord.js'
import * as flowStore from '../flows/store.js'
import {
  assigneeRow, scopeRow, handleCreate, channelPlacementNote,
  bugProjectRow, issueToggleButton, issueReplyLine, confirmRepository,
} from './create-task.js'
import { createTaskTicketChannel } from '../services/taskTicketChannel.js'
import { GitHubError } from '../services/github.js'

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

test('scope row offers exactly the five fixed choices', () => {
  const menu = scopeRow().toJSON().components[0]
  assert.equal(menu.custom_id, 'create_task_scope')
  assert.deepEqual(
    menu.options.map((o) => [o.label, o.value]),
    [['Backend', 'backend'], ['Frontend', 'frontend'], ['Mobile', 'mobile'], ['QA', 'qa'], ['Design', 'design']],
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

// No test may reach GitHub: every handleCreate call passes this (or its own) fake.
const noIssue = async () => {
  throw new Error('openIssue must not be reached in this test')
}

function fakeDb(log, project = PROJECT, { repos = [], links = [] } = {}) {
  return {
    project: { findFirst: async ({ where }) => (where.id === project?.id ? project : null) },
    repository: { findMany: async () => repos },
    projectRepos: { findMany: async ({ where }) => links.filter((l) => String(l.project_id) === String(where.project_id)) },
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

  await handleCreate(it, { db: fakeDb(log), getConfig, createChannel, openIssue: noIssue })

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

  await handleCreate(it, { db: fakeDb(log), getConfig, createChannel: createTaskTicketChannel, openIssue: noIssue })

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
  const opened = []
  const openIssue = async (url, title) => {
    opened.push([url, title])
    return { url: 'https://github.com/o/api/issues/1', number: 1 }
  }

  await handleCreate(it, { db: fakeDb(log), getConfig, openIssue })

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
  )  // The picked repository's issue is opened through the fake, never GitHub.
  assert.deepEqual(opened, [['https://example.com/api', 'Downtime calc is wrong']])
  assert.match(it.replies.at(-1).embeds[0].toJSON().description, /Issue: https:\/\/github\.com\/o\/api\/issues\/1$/)
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

  await handleCreate(it, { db: fakeDb(log), getConfig, openIssue: noIssue })

  const row = log.find((e) => e[0] === 'bugTicket.create')[1]
  assert.equal(row.scope, null)
  assert.doesNotMatch(it.replies.at(-1).embeds[0].toJSON().description, /must not be reached/)
})

test('channelPlacementNote says where the channel went and why', () => {
  const p = { name: 'Framework' }
  assert.equal(channelPlacementNote('<#1>', null, null), 'Channel: <#1>\nUse **/close-feature** there when done.')
  assert.match(channelPlacementNote('<#1>', p, null), /^Channel: <#1> — in \*\*Framework\*\*'s section\./)
  assert.match(channelPlacementNote('<#1>', p, 'cap'), /49-channel cap, so this went to the global \*\*Features\*\* category instead/)
  assert.match(channelPlacementNote('<#1>', p, 'missing'), /has no Discord section yet[\s\S]*\/project-setup/)
})

// --- the bug's project step, the Issue toggle, the reply line -----------------

test('bugProjectRow lists the projects by name, capped at 24, with No project last', () => {
  const menu = bugProjectRow([{ id: 'p2', name: 'Zeta' }, { id: 'p1', name: 'Alpha' }, { id: 'p3', name: 'badar HMS' }]).toJSON().components[0]
  assert.equal(menu.custom_id, 'create_task_bug_project')
  assert.deepEqual(
    menu.options.map((o) => [o.label, o.value]),
    [['Alpha', 'p1'], ['badar HMS', 'p3'], ['Zeta', 'p2'], ['No project', 'none']],
  )
  assert.ok(menu.options.every((o) => !o.default))

  const many = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `Project ${String(i).padStart(2, '0')}` }))
  const capped = bugProjectRow(many).toJSON().components[0].options
  assert.equal(capped.length, 25)
  assert.equal(capped[23].label, 'Project 23')
  assert.equal(capped.at(-1).label, 'No project')
  assert.equal(capped.at(-1).value, 'none')
})

test('bugProjectRow marks the selected project', () => {
  const opts = bugProjectRow([{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }], 'p2').toJSON().components[0].options
  assert.deepEqual(opts.filter((o) => o.default).map((o) => o.value), ['p2'])
  const none = bugProjectRow([], null).toJSON().components[0].options
  assert.deepEqual(none.map((o) => o.value), ['none'])
})

test('issueToggleButton says whether the issue will be opened', () => {
  const on = issueToggleButton(true).toJSON()
  assert.equal(on.custom_id, 'create_task_issue_toggle')
  assert.equal(on.label, 'Issue: on')
  const off = issueToggleButton(false).toJSON()
  assert.equal(off.custom_id, 'create_task_issue_toggle')
  assert.equal(off.label, 'Issue: off')
})

test('issueReplyLine covers every issue outcome', () => {
  assert.equal(issueReplyLine({ url: 'https://github.com/o/r/issues/7' }), 'Issue: https://github.com/o/r/issues/7')
  assert.equal(issueReplyLine({ error: 'No GitHub access to o/r' }), 'Issue: not opened — No GitHub access to o/r')
  assert.equal(issueReplyLine({ skipped: 'the project has no repository for this scope' }), 'Issue: not opened — the project has no repository for this scope')
  assert.equal(issueReplyLine(null), 'Issue: off')
})

// --- confirmRepository: what the confirm step shows is what createTask uses ---

const API_REPO = { id: 'r-api', name: 'api', url: 'https://github.com/o/r' }
const WEB_REPO = { id: 'r-web', name: 'web', url: 'https://github.com/o/web' }
const LINKS = [
  { project_id: 'p1', repository_id: 'r-api', scope: 'backend' },
  { project_id: 'p1', repository_id: 'r-web', scope: 'frontend' },
]

test('confirmRepository: a feature uses the rule on its first project, else its first picked repo', async () => {
  const db = fakeDb([], PROJECT, { repos: [API_REPO, WEB_REPO], links: LINKS })
  const cfg = { id: 'cfg1' }
  assert.equal(await confirmRepository({ taskType: 'feature', scope: 'backend', projectIds: ['p1'], repositoryIds: ['r-web'] }, { db, cfg }), API_REPO)
  assert.equal(await confirmRepository({ taskType: 'feature', scope: 'qa', projectIds: ['p1'], repositoryIds: ['r-web'] }, { db, cfg }), WEB_REPO)
  assert.equal(await confirmRepository({ taskType: 'feature', scope: 'qa', projectIds: ['p1'], repositoryIds: [] }, { db, cfg }), null)
  assert.equal(await confirmRepository({ taskType: 'feature', scope: 'backend', projectIds: [], repositoryIds: [] }, { db, cfg }), null)
})

test('confirmRepository: a bug uses state.repo', async () => {
  const db = fakeDb([], PROJECT, { repos: [API_REPO], links: LINKS })
  assert.equal(await confirmRepository({ taskType: 'bug', scope: 'backend', repo: WEB_REPO }, { db, cfg: { id: 'cfg1' } }), WEB_REPO)
  assert.equal(await confirmRepository({ taskType: 'bug', scope: 'backend' }, { db, cfg: { id: 'cfg1' } }), null)
})

// --- handleCreate, a bug under a project, with the Issue toggle ----------------

function seedBugWithProject(guild, extra = {}) {
  flowStore.set('u-assigner', guild.id, 'create_task', {
    step: 'confirm',
    taskType: 'bug',
    title: 'Login 500s',
    description: 'Every time',
    scope: 'backend',
    projectId: 'p1',
    repositoryId: 'r-api',
    repo: API_REPO,
    repoResolved: true,
    taggedMemberIds: ['u1'],
    ...extra,
  })
}

function projectChannelMaker(seen) {
  return async (g, opts) => {
    seen.push(opts)
    const channel = { id: 'chanP', send: async () => {} }
    await opts.onCreated(channel)
    return { channel, fellBack: null }
  }
}

test('handleCreate files a bug under its project, opens the issue in the scope repository, and says so', async () => {
  const log = []
  const guild = { id: 'guild-ct-bp1' }
  seedBugWithProject(guild)
  const it = fakeInteraction(guild)
  const seen = []
  const opened = []
  const openIssue = async (url, title) => {
    opened.push([url, title])
    return { url: 'https://github.com/o/r/issues/42', number: 42 }
  }

  await handleCreate(it, { db: fakeDb(log, PROJECT, { repos: [API_REPO, WEB_REPO], links: LINKS }), getConfig, createChannel: projectChannelMaker(seen), openIssue })

  const row = log.find((e) => e[0] === 'bugTicket.create')[1]
  assert.equal(row.projectId, 'p1')
  assert.equal(row.repositoryId, 'r-api')
  assert.equal(seen[0].project, PROJECT)
  assert.equal(seen[0].type, 'bug')
  assert.deepEqual(opened, [['https://github.com/o/r', 'Login 500s']])
  const description = it.replies.at(-1).embeds[0].toJSON().description
  assert.match(description, /<#chanP>/)
  assert.match(description, /Issue: https:\/\/github\.com\/o\/r\/issues\/42$/)
  assert.equal(flowStore.get('u-assigner', guild.id, 'create_task'), null)
})

test('handleCreate with the Issue toggle off opens no issue and says Issue: off', async () => {
  const log = []
  const guild = { id: 'guild-ct-bp2' }
  seedBugWithProject(guild, { createIssue: false })
  const it = fakeInteraction(guild)
  const opened = []
  const openIssue = async (url) => {
    opened.push(url)
    return { url: 'x', number: 1 }
  }

  await handleCreate(it, { db: fakeDb(log, PROJECT, { repos: [API_REPO], links: LINKS }), getConfig, createChannel: projectChannelMaker([]), openIssue })

  assert.deepEqual(opened, [])
  assert.match(it.replies.at(-1).embeds[0].toJSON().description, /Issue: off$/)
})

test('handleCreate reports an issue that could not be opened, and still creates the bug', async () => {
  const log = []
  const guild = { id: 'guild-ct-bp3' }
  seedBugWithProject(guild)
  const it = fakeInteraction(guild)
  const openIssue = async () => {
    throw new GitHubError('no-access', 'No GitHub access to o/r')
  }

  await handleCreate(it, { db: fakeDb(log, PROJECT, { repos: [API_REPO], links: LINKS }), getConfig, createChannel: projectChannelMaker([]), openIssue })

  assert.ok(log.some((e) => e[0] === 'bugTicket.create'))
  const reply = it.replies.at(-1)
  assert.equal(reply.embeds[0].toJSON().title, 'Bug task created')
  assert.match(reply.embeds[0].toJSON().description, /Issue: not opened — No GitHub access to o\/r$/)
})

test('handleCreate ends a feature reply with the issue line too', async () => {
  const log = []
  const guild = { id: 'guild-ct-fi' }
  seedState(guild, { scope: 'backend', repositoryIds: [] })
  const it = fakeInteraction(guild)
  const openIssue = async () => ({ url: 'https://github.com/o/r/issues/9', number: 9 })

  await handleCreate(it, { db: fakeDb(log, PROJECT, { repos: [API_REPO], links: LINKS }), getConfig, createChannel: projectChannelMaker([]), openIssue })

  assert.match(it.replies.at(-1).embeds[0].toJSON().description, /\nIssue: https:\/\/github\.com\/o\/r\/issues\/9$/)
})

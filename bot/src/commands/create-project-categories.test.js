// Every test here passes fakes for every seam — db, getConfig, and where the
// shared walk is not the subject, run. The root `.env` points at production;
// see .claude/rules/tests-never-touch-production.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType } from 'discord.js'
import { data, execute } from './create-project-categories.js'
import { runProjectSetup } from './project-setup.js'

function fakeChannel(id, name, { type = ChannelType.GuildText, parentId = null } = {}) {
  const channel = {
    id,
    name,
    type,
    parentId,
    sent: [],
    permissionOverwrites: { cache: new Map() },
    messages: { fetchPinned: async () => [] },
    async send(payload) {
      channel.sent.push(payload)
      return { pin: async () => {} }
    },
    async edit() {
      return channel
    },
  }
  return channel
}

function fakeGuild() {
  const guild = {
    id: 'G1',
    fetchedAll: 0,
    roles: {
      cache: new Map(),
      calls: [],
      async create(opts) {
        guild.roles.calls.push(opts)
        const role = { id: `role-${guild.roles.calls.length}`, name: opts.name, members: new Map() }
        guild.roles.cache.set(role.id, role)
        return role
      },
    },
    channels: {
      cache: new Map(),
      calls: [],
      async create(opts) {
        guild.channels.calls.push(opts)
        const made = fakeChannel(`new-${guild.channels.calls.length}`, opts.name, {
          type: opts.type,
          parentId: opts.parent ?? null,
        })
        guild.channels.cache.set(made.id, made)
        return made
      },
    },
    members: {
      cache: new Map(),
      async fetch() {
        guild.fetchedAll += 1
        return guild.members.cache
      },
    },
  }
  return guild
}

const CFG = { id: 'g1' }
const getConfig = async () => CFG

function fakeDb(projects = []) {
  const calls = []
  return {
    calls,
    project: {
      findMany: async ({ where }) => {
        calls.push(['project.findMany', where])
        return projects
      },
      findFirst: async ({ where }) => projects.find((p) => p.id === where.id) ?? null,
      update: async (args) => {
        calls.push(['project.update', args])
        return { id: args?.where?.id }
      },
    },
    projectSchema: {
      findMany: async () => {
        calls.push(['projectSchema.findMany'])
        return []
      },
    },
    task: { findMany: async () => [] },
    projectMember: { findByProject: async () => [] },
  }
}

function fakeInteraction(guild) {
  const replies = []
  return {
    replies,
    guild,
    client: { user: { id: 'bot1' } },
    options: {
      getString: () => null,
      getBoolean: () => null,
    },
    async editReply(payload) {
      replies.push(payload)
      return payload
    },
  }
}

async function quiet(fn) {
  const warn = console.warn
  const error = console.error
  console.warn = () => {}
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.warn = warn
    console.error = error
  }
}

test('the command keeps its name and description', () => {
  const json = data.toJSON()
  assert.equal(json.name, 'create-project-categories')
  assert.equal(
    json.description,
    'Create a category for each project in the DB — only users with that project role can access'
  )
})

test('it hands the whole run to the shared walk as all:true, with its seams', async () => {
  const db = fakeDb()
  const it = fakeInteraction(fakeGuild())
  const seen = []
  const run = async (...args) => {
    seen.push(args)
  }

  await execute(it, { db, getConfig, run })

  assert.equal(seen.length, 1, 'the shared walk ran once')
  assert.equal(seen[0][0], it)
  assert.deepEqual(seen[0][1], { all: true })
  assert.equal(seen[0][2].db, db)
  assert.equal(seen[0][2].getConfig, getConfig)
  assert.equal(runProjectSetup.name, 'runProjectSetup', 'the default is /project-setup\'s own walk')
})

test('through the shared walk it sets up every project, posting as it goes', async () => {
  const projects = [
    { id: 'p1', name: 'Alpha', docsSlug: 'alpha', guildConfigId: 'g1' },
    { id: 'p2', name: 'Bravo', docsSlug: 'bravo', guildConfigId: 'g1' },
    { id: 'p3', name: 'Charlie', docsSlug: 'charlie', guildConfigId: 'g1' },
  ]
  const db = fakeDb(projects)
  const guild = fakeGuild()
  const it = fakeInteraction(guild)

  await quiet(() => execute(it, { db, getConfig }))

  const updated = db.calls.filter((c) => c[0] === 'project.update').map((c) => c[1].where.id)
  assert.deepEqual(updated, ['p1', 'p2', 'p3'], 'every project was set up')
  assert.equal(guild.fetchedAll, 1, 'the member list was fetched once, before any role sync')
  assert.equal(it.replies.length, 3, 'one incremental reply per project, as /project-setup all:true posts')
  const content = it.replies.at(-1).content
  assert.match(content, /\*\*Alpha\*\*/)
  assert.match(content, /\*\*Charlie\*\*/)
  assert.deepEqual(
    db.calls.filter((c) => c[0] === 'projectSchema.findMany'),
    [],
    'the old projectschema body is gone'
  )
})

test('with no projects it says so and touches nothing', async () => {
  const db = fakeDb([])
  const guild = fakeGuild()
  const it = fakeInteraction(guild)
  await execute(it, { db, getConfig })
  assert.match(it.replies[0].content, /No projects yet/)
  assert.equal(guild.channels.calls.length, 0)
  assert.equal(guild.roles.calls.length, 0)
})

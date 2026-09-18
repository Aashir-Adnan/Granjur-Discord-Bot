// Every test here passes fakes for every seam — db, getConfig, and where the
// real routine is not the subject, setup. The root `.env` points at
// production; see .claude/rules/tests-never-touch-production.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType } from 'discord.js'
import { data, execute } from './create-project-role.js'

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

function fakeDb(projects = []) {
  const calls = []
  return {
    calls,
    project: {
      findByName: async ({ guildConfigId, name }) => {
        calls.push(['project.findByName', name])
        return projects.find((p) => p.guildConfigId === guildConfigId && p.name === name) ?? null
      },
      findMany: async () => {
        calls.push(['project.findMany'])
        return projects
      },
      update: async (args) => {
        calls.push(['project.update', args])
        return { id: args?.where?.id }
      },
    },
    task: { findMany: async () => [] },
    projectMember: { findByProject: async () => [] },
  }
}

function fakeInteraction(guild, project) {
  const replies = []
  return {
    replies,
    guild,
    client: { user: { id: 'bot1' } },
    options: { getString: (name) => (name === 'project' ? project : null) },
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

const FRAMEWORK = { id: 'p1', name: 'Framework', docsSlug: 'framework', guildConfigId: 'g1' }

test('the command keeps its name and its one required project option', () => {
  const json = data.toJSON()
  assert.equal(json.name, 'create-project-role')
  assert.equal(json.options.length, 1)
  assert.equal(json.options[0].name, 'project')
  assert.equal(json.options[0].required, true)
  assert.match(json.description, /section/)
})

for (const name of ['Database', 'database', '  Project Manager ']) {
  test(`"${name}" is a managed role: refused, and nothing is read or created`, async () => {
    const db = fakeDb([{ ...FRAMEWORK, name: 'Database' }])
    const guild = fakeGuild()
    const it = fakeInteraction(guild, name)
    let configs = 0
    let ran = 0
    await execute(it, {
      db,
      getConfig: async () => {
        configs++
        return CFG
      },
      setup: async () => ran++,
    })
    assert.match(it.replies[0].content, /managed job role/)
    assert.match(it.replies[0].content, /Nothing was created/)
    assert.equal(ran, 0, 'the routine never ran')
    assert.equal(configs, 0, 'the guild config was never read')
    assert.deepEqual(db.calls, [], 'the database was never touched')
    assert.equal(guild.roles.calls.length, 0, 'no role')
    assert.equal(guild.channels.calls.length, 0, 'no category, no channel')
  })
}

test('a named project runs the one-project routine once and says it built the section', async () => {
  const db = fakeDb([FRAMEWORK])
  const guild = fakeGuild()
  const it = fakeInteraction(guild, 'Framework')
  const seen = []
  const setup = async (g, project, deps) => {
    seen.push({ g, project, deps })
    return {
      block: '**Framework** — 11 created.',
      result: { role: { id: 'r1', name: 'Framework' }, category: { name: '📂 FRAMEWORK' } },
    }
  }

  await execute(it, { db, getConfig: async () => CFG, setup })

  assert.equal(seen.length, 1)
  assert.equal(seen[0].g, guild)
  assert.equal(seen[0].project, FRAMEWORK)
  assert.equal(seen[0].deps.db, db)
  assert.equal(seen[0].deps.cfg, CFG)
  const content = it.replies.at(-1).content
  assert.match(content, /private section/)
  assert.match(content, /category and channels were created or repaired/)
  assert.match(content, /11 created/)
})

test('a name that differs only in case still finds the project', async () => {
  const db = fakeDb([FRAMEWORK])
  const it = fakeInteraction(fakeGuild(), 'framework')
  const seen = []
  await execute(it, {
    db,
    getConfig: async () => CFG,
    setup: async (g, project) => {
      seen.push(project)
      return { block: 'ok', result: { category: { name: '📂 FRAMEWORK' } } }
    },
  })
  assert.deepEqual(seen, [FRAMEWORK])
})

test('an unknown project name builds nothing and points at /projects', async () => {
  const db = fakeDb([FRAMEWORK])
  const guild = fakeGuild()
  const it = fakeInteraction(guild, 'Nope')
  let ran = 0
  await execute(it, { db, getConfig: async () => CFG, setup: async () => ran++ })
  assert.equal(ran, 0)
  assert.match(it.replies[0].content, /No project named \*\*Nope\*\*/)
  assert.match(it.replies[0].content, /\/projects/)
  assert.equal(guild.roles.calls.length, 0)
})

test('a routine that throws is reported, not thrown', async () => {
  const it = fakeInteraction(fakeGuild(), 'Framework')
  await quiet(() =>
    execute(it, {
      db: fakeDb([FRAMEWORK]),
      getConfig: async () => CFG,
      setup: async () => {
        throw new Error('Missing Permissions')
      },
    })
  )
  assert.match(it.replies[0].content, /Could not set up \*\*Framework\*\*: Missing Permissions/)
  assert.match(it.replies[0].content, /\/project-setup/)
})

test('through the real routine it creates the role and the whole section', async () => {
  const db = fakeDb([FRAMEWORK])
  const guild = fakeGuild()
  const it = fakeInteraction(guild, 'Framework')

  await quiet(() => execute(it, { db, getConfig: async () => CFG }))

  assert.equal(guild.roles.calls.length, 1)
  assert.equal(guild.roles.calls[0].name, 'Framework')
  assert.equal(guild.channels.calls.length, 11, 'a category and its ten channels')
  assert.equal(guild.fetchedAll, 1, 'the member list was fetched before the role sync')
  assert.ok(db.calls.some((c) => c[0] === 'project.update'), 'the ids were saved through the db seam')
  assert.match(it.replies.at(-1).content, /Role \*\*Framework\*\*/)
})

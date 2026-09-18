// Every test here passes fakes for ALL THREE seams of `execute` (db, getConfig,
// ensureMeeting). The root .env points at production; see
// .claude/rules/tests-never-touch-production.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType } from 'discord.js'
import { execute, autocomplete, data } from './meeting-channel.js'

const GUILD_ID = 'guild1'
const CFG = { id: 'cfg1' }
const PROJ_CAT = 'cat-proj'
const GLOBAL_CAT = 'cat-global'

class FakeCache extends Map {
  find(fn) {
    for (const v of this.values()) if (fn(v)) return v
    return undefined
  }
}

function fakeGuild({ channels = [], fetchable = [] } = {}) {
  const cache = new FakeCache(channels.map((c) => [c.id, c]))
  const created = []
  let n = 0
  return {
    id: GUILD_ID,
    client: { user: { id: 'bot' } },
    roles: { everyone: { id: GUILD_ID } },
    created,
    channels: {
      cache,
      fetch: async (id) => fetchable.find((c) => c.id === id) ?? null,
      create: async (opts) => {
        created.push(opts)
        const ch = { id: `new-${++n}`, type: opts.type, name: opts.name, parentId: opts.parent ?? null }
        cache.set(ch.id, ch)
        return ch
      },
    },
  }
}

const category = (id, name = '📂 FRAMEWORK') => ({ id, name, type: ChannelType.GuildCategory, parentId: null })
const globalCategory = () => category(GLOBAL_CAT, '📋 Meetings')
const textIn = (id, parentId) => ({ id, type: ChannelType.GuildText, parentId, isThread: () => false })

const FRAMEWORK = { id: 'p1', name: 'Framework', guildConfigId: CFG.id, discordCategoryId: PROJ_CAT }
const OTHER = { id: 'p2', name: 'Other', guildConfigId: CFG.id, discordCategoryId: 'cat-other' }

/** A db that only knows `project`, and throws on any other table touched. */
function fakeDb(projects = [FRAMEWORK, OTHER]) {
  const project = {
    findMany: async ({ where }) => projects.filter((p) => p.guildConfigId === where.guildConfigId),
    findFirst: async ({ where }) => projects.find((p) => p.id === where.id) ?? null,
  }
  return new Proxy({ project }, {
    get(target, key) {
      if (key in target) return target[key]
      throw new Error(`test db: unexpected table ${String(key)}`)
    },
  })
}

function fakeInteraction(guild, { project = null, name = null, channel = null } = {}) {
  const replies = []
  return {
    guild,
    channel,
    replies,
    options: { getString: (k) => (k === 'project' ? project : k === 'name' ? name : null) },
    editReply: async (r) => { replies.push(r); return r },
  }
}

function seams(projects) {
  const meetingCalls = []
  return {
    meetingCalls,
    deps: {
      db: fakeDb(projects),
      getConfig: async (gid) => { assert.equal(gid, GUILD_ID); return CFG },
      ensureMeeting: async (guild, voiceId, opts) => {
        meetingCalls.push({ voiceId, opts })
        return { meetingId: 'm1' }
      },
    },
  }
}

const withoutName = ({ name, ...rest }) => rest

/** The two creation calls exactly as they were before projects existed. */
function assertTodayShapes(guild, parent) {
  const [text, voice] = guild.created.filter((c) => c.type !== ChannelType.GuildCategory)
  assert.match(text.name, /^meeting-[a-z0-9]+-text$/)
  assert.deepEqual(withoutName(text), {
    type: ChannelType.GuildText,
    parent,
    topic: 'Meeting chat is stored in the database with the sender and timestamp.',
  })
  assert.match(voice.name, /^meeting-[a-z0-9]+-voice$/)
  assert.deepEqual(withoutName(voice), {
    type: ChannelType.GuildVoice,
    parent,
    permissionOverwrites: [
      { id: GUILD_ID, allow: ['ViewChannel', 'Connect', 'Speak', 'UseVAD', 'ReadMessageHistory'] },
    ],
  })
}

function assertProjectShapes(guild) {
  const made = guild.created
  assert.equal(made.length, 2)
  for (const c of made) {
    assert.equal(c.parent, PROJ_CAT)
    assert.equal('permissionOverwrites' in c, false, `${c.name} must inherit the category's overwrites`)
  }
  assert.deepEqual(made.map((c) => c.type), [ChannelType.GuildText, ChannelType.GuildVoice])
}

test('the command offers an optional autocompleted project option', () => {
  const opt = data.toJSON().options.find((o) => o.name === 'project')
  assert.equal(opt.required, false)
  assert.equal(opt.autocomplete, true)
})

test('no project: the global category and the creation calls exactly as today, no projectId', async () => {
  const guild = fakeGuild({ channels: [globalCategory(), textIn('general', null)] })
  const { deps, meetingCalls } = seams()
  const i = fakeInteraction(guild, { channel: guild.channels.cache.get('general') })
  await execute(i, deps)
  assertTodayShapes(guild, GLOBAL_CAT)
  assert.equal(meetingCalls.length, 1)
  assert.equal('projectId' in meetingCalls[0].opts, false)
  assert.equal(meetingCalls[0].opts.textChannelId, 'new-1')
  assert.match(i.replies[0].content, /^Created a dedicated meeting pair for this session\.\nVoice: <#new-2>\nText: <#new-1>\nDB link: meeting m1$/)
})

test('no project and no global category yet: it is created, as today', async () => {
  const guild = fakeGuild()
  const { deps } = seams()
  await execute(fakeInteraction(guild), deps)
  assert.deepEqual(guild.created[0], { name: '📋 Meetings', type: ChannelType.GuildCategory })
  assertTodayShapes(guild, 'new-1')
})

test('named project: both channels in its category, no overwrites, projectId recorded', async () => {
  const guild = fakeGuild({ channels: [category(PROJ_CAT)] })
  const { deps, meetingCalls } = seams()
  const i = fakeInteraction(guild, { project: 'p1' })
  await execute(i, deps)
  assertProjectShapes(guild)
  assert.equal(meetingCalls[0].opts.projectId, 'p1')
  assert.match(i.replies[0].content, /\*\*Framework\*\*/)
  assert.doesNotMatch(i.replies[0].content, /instead/)
})

test('inferred from a channel inside the project category', async () => {
  const guild = fakeGuild({ channels: [category(PROJ_CAT), textIn('fw-chat', PROJ_CAT)] })
  const { deps, meetingCalls } = seams()
  await execute(fakeInteraction(guild, { channel: guild.channels.cache.get('fw-chat') }), deps)
  assertProjectShapes(guild)
  assert.equal(meetingCalls[0].opts.projectId, 'p1')
})

test('inferred from a thread inside a project channel', async () => {
  const parent = textIn('fw-chat', PROJ_CAT)
  const thread = { id: 'th1', parentId: 'fw-chat', isThread: () => true, parent }
  const guild = fakeGuild({ channels: [category(PROJ_CAT), parent] })
  const { deps, meetingCalls } = seams()
  await execute(fakeInteraction(guild, { channel: thread }), deps)
  assertProjectShapes(guild)
  assert.equal(meetingCalls[0].opts.projectId, 'p1')
})

test('an explicit project beats a conflicting inference', async () => {
  const guild = fakeGuild({ channels: [category(PROJ_CAT), category('cat-other', '📂 OTHER'), textIn('other-chat', 'cat-other')] })
  const { deps, meetingCalls } = seams()
  await execute(fakeInteraction(guild, { project: 'p1', channel: guild.channels.cache.get('other-chat') }), deps)
  assertProjectShapes(guild)
  assert.equal(meetingCalls[0].opts.projectId, 'p1')
})

test('stale category: global category with today\'s shapes, a note, projectId still recorded', async () => {
  const guild = fakeGuild({ channels: [globalCategory()] }) // PROJ_CAT no longer exists
  const { deps, meetingCalls } = seams()
  const i = fakeInteraction(guild, { project: 'p1' })
  await execute(i, deps)
  assertTodayShapes(guild, GLOBAL_CAT)
  assert.equal(meetingCalls[0].opts.projectId, 'p1')
  assert.match(i.replies[0].content, /no section yet — run `\/project-setup`/)
})

test('a category id that resolves to something other than a category counts as stale', async () => {
  const guild = fakeGuild({ channels: [globalCategory(), textIn(PROJ_CAT, null)] })
  const { deps, meetingCalls } = seams()
  const i = fakeInteraction(guild, { project: 'p1' })
  await execute(i, deps)
  assertTodayShapes(guild, GLOBAL_CAT)
  assert.equal(meetingCalls[0].opts.projectId, 'p1')
  assert.match(i.replies[0].content, /no section yet/)
})

test('a project with no section at all falls back with a note and keeps projectId', async () => {
  const guild = fakeGuild({ channels: [globalCategory()] })
  const { deps, meetingCalls } = seams([{ ...FRAMEWORK, discordCategoryId: null }])
  const i = fakeInteraction(guild, { project: 'p1' })
  await execute(i, deps)
  assertTodayShapes(guild, GLOBAL_CAT)
  assert.equal(meetingCalls[0].opts.projectId, 'p1')
  assert.match(i.replies[0].content, /no section yet/)
})

test('a category found only by fetch is used', async () => {
  const guild = fakeGuild({ fetchable: [category(PROJ_CAT)] })
  const { deps } = seams()
  await execute(fakeInteraction(guild, { project: 'p1' }), deps)
  assertProjectShapes(guild)
})

test('full category (48 children, +2 > 49): global category and a note', async () => {
  const kids = Array.from({ length: 48 }, (_, k) => textIn(`c${k}`, PROJ_CAT))
  const guild = fakeGuild({ channels: [globalCategory(), category(PROJ_CAT), ...kids] })
  const { deps, meetingCalls } = seams()
  const i = fakeInteraction(guild, { project: 'p1' })
  await execute(i, deps)
  assertTodayShapes(guild, GLOBAL_CAT)
  assert.equal(meetingCalls[0].opts.projectId, 'p1')
  assert.match(i.replies[0].content, /49-channel cap/)
})

test('47 children (+2 = 49) still fits in the project category', async () => {
  const kids = Array.from({ length: 47 }, (_, k) => textIn(`c${k}`, PROJ_CAT))
  const guild = fakeGuild({ channels: [category(PROJ_CAT), ...kids] })
  const { deps } = seams()
  await execute(fakeInteraction(guild, { project: 'p1' }), deps)
  assertProjectShapes(guild)
})

test('a named project that does not exist, or belongs to another server, creates nothing', async () => {
  for (const projects of [[], [{ ...FRAMEWORK, guildConfigId: 'cfg-other' }]]) {
    const guild = fakeGuild({ channels: [globalCategory()] })
    const { deps, meetingCalls } = seams(projects)
    const i = fakeInteraction(guild, { project: 'p1' })
    await execute(i, deps)
    assert.equal(guild.created.length, 0)
    assert.equal(meetingCalls.length, 0)
    assert.match(i.replies[0].content, /No project matches/)
  }
})

test('a failed project read creates nothing rather than a public meeting', async () => {
  const guild = fakeGuild({ channels: [globalCategory(), category(PROJ_CAT), textIn('fw-chat', PROJ_CAT)] })
  const { deps, meetingCalls } = seams()
  deps.db = { project: { findMany: async () => { throw new Error('down') }, findFirst: async () => { throw new Error('down') } } }
  for (const project of [null, 'p1']) {
    const i = fakeInteraction(guild, { project, channel: guild.channels.cache.get('fw-chat') })
    await execute(i, deps)
    assert.match(i.replies[0].content, /could not load the projects/)
  }
  assert.equal(guild.created.length, 0)
  assert.equal(meetingCalls.length, 0)
})

test('two projects claiming one category: no inference, today\'s behaviour', async () => {
  const guild = fakeGuild({ channels: [globalCategory(), category(PROJ_CAT), textIn('fw-chat', PROJ_CAT)] })
  const { deps, meetingCalls } = seams([FRAMEWORK, { ...OTHER, discordCategoryId: PROJ_CAT }])
  await execute(fakeInteraction(guild, { channel: guild.channels.cache.get('fw-chat') }), deps)
  assertTodayShapes(guild, GLOBAL_CAT)
  assert.equal('projectId' in meetingCalls[0].opts, false)
})

test('no guild config: nothing is created', async () => {
  const guild = fakeGuild()
  const { deps, meetingCalls } = seams()
  deps.getConfig = async () => null
  const i = fakeInteraction(guild)
  await execute(i, deps)
  assert.equal(guild.created.length, 0)
  assert.equal(meetingCalls.length, 0)
  assert.match(i.replies[0].content, /Run \*\*\/init\*\*/)
})

test('autocomplete offers the server\'s projects, with no detach entry', async () => {
  const { deps } = seams()
  let answered
  await autocomplete({
    guild: { id: GUILD_ID },
    options: { getFocused: () => ({ name: 'project', value: 'fr' }) },
    respond: async (c) => { answered = c },
  }, { db: deps.db, getConfig: deps.getConfig })
  assert.deepEqual(answered, [{ name: 'Framework', value: 'p1' }])
})

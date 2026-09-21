// Every test here passes fakes for ALL THREE seams of `execute` (db, getConfig,
// ensureMeeting). The root .env points at production; see
// .claude/rules/tests-never-touch-production.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js'
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

function fakeGuild({
  channels = [],
  fetchable = [],
  fetchError = null,
  allChannels = null,
  fullFetchError = null,
} = {}) {
  const cache = new FakeCache(channels.map((c) => [c.id, c]))
  // What Discord actually has, for the no-id `fetch()` that populates the
  // cache in full. Defaults to today's cache plus whatever a single `fetch(id)`
  // can reach, so tests that never rely on a full resync are unaffected.
  const fullList = allChannels ?? [...channels, ...fetchable]
  const created = []
  // How many times the no-id `fetch()` ran. A category already in the cache
  // must not cost one: the gateway delivered every channel at GUILD_CREATE.
  const counts = { fullFetches: 0 }
  let n = 0
  return {
    id: GUILD_ID,
    client: { user: { id: 'bot' } },
    roles: { everyone: { id: GUILD_ID } },
    created,
    counts,
    channels: {
      cache,
      fetch: async (id) => {
        if (fetchError) throw fetchError
        if (id === undefined) {
          counts.fullFetches += 1
          if (fullFetchError) throw fullFetchError
          for (const c of fullList) cache.set(c.id, c)
          return cache
        }
        const found = fetchable.find((c) => c.id === id) ?? null
        if (found) cache.set(found.id, found)
        return found
      },
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

function fakeInteraction(guild, { project = null, name = null, channel = null, member } = {}) {
  const replies = []
  return {
    guild,
    channel,
    member,
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

// ---------------------------------------------------------------------------
// B2: only "Unknown Channel" means the section is gone
// ---------------------------------------------------------------------------

const discordError = (code, message) => Object.assign(new Error(message), { code })

test('a 10003 on the category fetch is a stale section: the global category, with the note', async () => {
  const guild = fakeGuild({
    channels: [globalCategory()],
    fetchError: discordError(RESTJSONErrorCodes.UnknownChannel, 'Unknown Channel'),
  })
  const { deps, meetingCalls } = seams()
  const i = fakeInteraction(guild, { project: 'p1' })
  await execute(i, deps)
  assertTodayShapes(guild, GLOBAL_CAT)
  assert.equal(meetingCalls[0].opts.projectId, 'p1')
  assert.match(i.replies[0].content, /no section yet/)
})

test('any OTHER category fetch error creates nothing and says to try again', async () => {
  // A rate limit or a 5xx is not evidence the section is gone. Treating it as
  // one used to put a project meeting in the public category and tell the
  // operator to repair a section that is not broken.
  for (const e of [discordError(500, 'Internal Server Error'), discordError(undefined, 'ECONNRESET')]) {
    const guild = fakeGuild({ channels: [globalCategory()], fetchError: e })
    const { deps, meetingCalls } = seams()
    const i = fakeInteraction(guild, { project: 'p1' })
    await execute(i, deps)
    assert.equal(guild.created.length, 0, 'nothing was created')
    assert.equal(meetingCalls.length, 0, 'no meeting row')
    assert.match(i.replies[0].content, /Discord could not be reached/)
    assert.match(i.replies[0].content, /Try again/)
  }
})

// ---------------------------------------------------------------------------
// B9: the cap is counted from the category that was found
// ---------------------------------------------------------------------------

test('a category found only by fetch(id) has its children counted only after the full fetch runs', async () => {
  // Real discord.js: `guild.channels.fetch(id)` caches only that one channel,
  // never its siblings, and `CategoryChannelChildManager#cache` is just a
  // filter over `guild.channels.cache` — so the 48 children are invisible
  // until `guild.channels.fetch()` (no id) resyncs the whole cache. A count
  // taken before that resync would say 0 and push this section past the cap.
  const cat = category(PROJ_CAT)
  const kids = Array.from({ length: 48 }, (_, k) => textIn(`c${k}`, PROJ_CAT))
  const guild = fakeGuild({
    channels: [globalCategory()],
    fetchable: [cat],
    allChannels: [globalCategory(), cat, ...kids],
  })
  const { deps } = seams()
  const i = fakeInteraction(guild, { project: 'p1' })
  await execute(i, deps)
  assertTodayShapes(guild, GLOBAL_CAT)
  assert.match(i.replies[0].content, /49-channel cap/)
  assert.equal(guild.counts.fullFetches, 1)
})

test('a category already in the cache is counted from the cache, with no full fetch', async () => {
  // The gateway delivers every channel at GUILD_CREATE, so a cached category's
  // siblings are cached too. Re-fetching them would cost a REST round-trip on
  // every project meeting.
  const cat = category(PROJ_CAT)
  const kids = Array.from({ length: 48 }, (_, k) => textIn(`c${k}`, PROJ_CAT))
  const guild = fakeGuild({ channels: [globalCategory(), cat, ...kids] })
  const { deps } = seams()
  const i = fakeInteraction(guild, { project: 'p1' })
  await execute(i, deps)
  assert.equal(guild.counts.fullFetches, 0)
  assertTodayShapes(guild, GLOBAL_CAT)
  assert.match(i.replies[0].content, /49-channel cap/)
})

test('a failed full fetch creates nothing and says to try again', async () => {
  // Without the resync we do not know the count, and guessing low would create
  // the pair in a category that may be at Discord's hard limit of 50 — which
  // fails halfway and orphans the text channel.
  const cat = category(PROJ_CAT)
  const guild = fakeGuild({
    channels: [globalCategory()],
    fetchable: [cat],
    fullFetchError: discordError(0, 'Service Unavailable'),
  })
  const { deps, meetingCalls } = seams()
  const i = fakeInteraction(guild, { project: 'p1' })
  await execute(i, deps)
  assert.equal(guild.created.length, 0)
  assert.equal(meetingCalls.length, 0)
  assert.match(i.replies[0].content, /could not be reached/)
  assert.match(i.replies[0].content, /nothing was created/)
})

// ---------------------------------------------------------------------------
// B10: a caller outside the project is told the links will not open
// ---------------------------------------------------------------------------

const GATED = { ...FRAMEWORK, discordRoleId: 'role-fw' }
const memberWith = (...roleIds) => ({
  roles: { cache: new Map(roleIds.map((id) => [id, { id }])) },
  permissions: { has: () => false },
})

test('a caller who does not hold the project role is told the two links will not open', async () => {
  const guild = fakeGuild({ channels: [category(PROJ_CAT)] })
  const { deps } = seams([GATED, OTHER])
  const i = fakeInteraction(guild, { project: 'p1', member: memberWith('role-other') })
  await execute(i, deps)
  assertProjectShapes(guild)
  assert.match(i.replies[0].content, /you do not hold it/)
})

test('a caller who holds the project role is told nothing of the kind', async () => {
  const guild = fakeGuild({ channels: [category(PROJ_CAT)] })
  const { deps } = seams([GATED, OTHER])
  const i = fakeInteraction(guild, { project: 'p1', member: memberWith('role-fw') })
  await execute(i, deps)
  assert.doesNotMatch(i.replies[0].content, /you do not hold it/)
})

test('an Administrator can see every section, so no such line', async () => {
  const guild = fakeGuild({ channels: [category(PROJ_CAT)] })
  const { deps } = seams([GATED, OTHER])
  const admin = { roles: { cache: new Map() }, permissions: { has: () => true } }
  const i = fakeInteraction(guild, { project: 'p1', member: admin })
  await execute(i, deps)
  assert.doesNotMatch(i.replies[0].content, /you do not hold it/)
})

// ---------------------------------------------------------------------------
// Final re-review, fix 2: a roleless project's notice names the real remedy
// ---------------------------------------------------------------------------

test('a caller outside a roleless project\'s section is pointed at /project-setup, not /project-members', async () => {
  // FRAMEWORK carries no discordRoleId: the role was refused (or never made),
  // so there is nothing to add the caller to. /project-members add itself
  // answers that case with "no channel access changed" — a dead end — so the
  // notice must not send anyone there.
  const guild = fakeGuild({ channels: [category(PROJ_CAT)] })
  const { deps } = seams([FRAMEWORK, OTHER])
  const i = fakeInteraction(guild, { project: 'p1', member: memberWith() })
  await execute(i, deps)
  assertProjectShapes(guild)
  assert.match(i.replies[0].content, /has no Discord role yet/)
  assert.match(i.replies[0].content, /\/project-setup/)
  assert.doesNotMatch(i.replies[0].content, /\/project-members add/)
})

test('a roleless project named after a managed job role is told to rename it first', async () => {
  const managedNamed = { ...FRAMEWORK, name: 'Database' }
  const guild = fakeGuild({ channels: [category(PROJ_CAT)] })
  const { deps } = seams([managedNamed, OTHER])
  const i = fakeInteraction(guild, { project: 'p1', member: memberWith() })
  await execute(i, deps)
  assertProjectShapes(guild)
  assert.match(i.replies[0].content, /rename the project/)
})

test('a caller who holds the project role is unaffected by the roleless branch', async () => {
  const guild = fakeGuild({ channels: [category(PROJ_CAT)] })
  const { deps } = seams([GATED, OTHER])
  const i = fakeInteraction(guild, { project: 'p1', member: memberWith('role-fw') })
  await execute(i, deps)
  assert.doesNotMatch(i.replies[0].content, /has no Discord role yet/)
})

test('a meeting that fell back to the public category carries no privacy line', async () => {
  const guild = fakeGuild({ channels: [globalCategory()] })
  const { deps } = seams([{ ...GATED, discordCategoryId: null }])
  const i = fakeInteraction(guild, { project: 'p1', member: memberWith() })
  await execute(i, deps)
  assert.doesNotMatch(i.replies[0].content, /you do not hold it/)
})

// --- push-to-talk: the voice channel gets "Use Voice Activity" for the project role ---

/** Make created voice channels carry an overwrite cache and record overwrite edits. */
function withVoiceOverwrites(guild, { inherited = null } = {}) {
  const edits = []
  const original = guild.channels.create
  guild.channels.create = async (opts) => {
    const ch = await original(opts)
    if (opts.type === ChannelType.GuildVoice) {
      ch.permissionOverwrites = {
        cache: new Map(inherited ? [[inherited.id, inherited]] : []),
        edit: async (...args) => { edits.push(args) },
      }
    }
    return ch
  }
  return edits
}
const denyingVad = (roleId) => ({ id: roleId, deny: { has: (p) => p === PermissionFlagsBits.UseVAD } })

test('a meeting voice channel inside a project gets voice activity for the project role, and nothing else', async () => {
  const project = { ...FRAMEWORK, discordRoleId: 'role1' }
  const guild = fakeGuild({ channels: [category(PROJ_CAT)] })
  const edits = withVoiceOverwrites(guild)
  const { deps } = seams([project])
  await execute(fakeInteraction(guild, { project: project.id }), deps)
  assert.equal(edits.length, 1)
  assert.deepEqual(edits[0], ['role1', { UseVAD: true }])
})

test('outside a project the voice channel is created exactly as before and no overwrite is edited', async () => {
  const guild = fakeGuild({ channels: [globalCategory()] })
  const edits = withVoiceOverwrites(guild)
  const { deps } = seams()
  await execute(fakeInteraction(guild), deps)
  assert.equal(edits.length, 0)
  assertTodayShapes(guild, GLOBAL_CAT)
})

test('a project with no role is not touched, and a category that denies voice activity on purpose is respected', async () => {
  const noRole = fakeGuild({ channels: [category(PROJ_CAT)] })
  const noRoleEdits = withVoiceOverwrites(noRole)
  await execute(fakeInteraction(noRole, { project: FRAMEWORK.id }), seams([FRAMEWORK]).deps)
  assert.equal(noRoleEdits.length, 0)

  const project = { ...FRAMEWORK, discordRoleId: 'role1' }
  const denied = fakeGuild({ channels: [category(PROJ_CAT)] })
  const deniedEdits = withVoiceOverwrites(denied, { inherited: denyingVad('role1') })
  await execute(fakeInteraction(denied, { project: project.id }), seams([project]).deps)
  assert.equal(deniedEdits.length, 0)
})

test('a refused overwrite edit does not fail the command', async () => {
  const project = { ...FRAMEWORK, discordRoleId: 'role1' }
  const guild = fakeGuild({ channels: [category(PROJ_CAT)] })
  const original = guild.channels.create
  guild.channels.create = async (opts) => {
    const ch = await original(opts)
    if (opts.type === ChannelType.GuildVoice) ch.permissionOverwrites = { cache: new Map(), edit: async () => { throw new Error('Missing Permissions') } }
    return ch
  }
  const it = fakeInteraction(guild, { project: project.id })
  const warn = console.warn; console.warn = () => {}
  try { await execute(it, seams([project]).deps) } finally { console.warn = warn }
  assert.match(it.replies[0].content, /Created a dedicated meeting pair/)
})

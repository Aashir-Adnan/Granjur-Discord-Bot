// Every test here passes fakes for BOTH seams of `execute` (db, getConfig).
// The root .env points at production; see
// .claude/rules/tests-never-touch-production.md. The seams were added to
// `cleanup.js` before this file existed, for the same reason.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType } from 'discord.js'
import { execute } from './cleanup.js'

const CFG = { id: 'cfg1' }

function chan(id, name, { type = ChannelType.GuildText, parent = null } = {}) {
  return { id, name, type, parentId: parent?.id ?? null, parent }
}

const category = (id, name) => chan(id, name, { type: ChannelType.GuildCategory })

function fakeGuild(channels) {
  return {
    id: 'G1',
    channels: { fetch: async () => new Map(channels.map((c) => [c.id, c])) },
  }
}

function fakeInteraction(guild) {
  const replies = []
  return {
    guild,
    replies,
    editReply: async (payload) => {
      replies.push(payload)
      return payload
    },
  }
}

/** A db that knows only the two tables `/cleanup` reads, and throws on any other. */
function seams(projects = [], { projectThrows = false, userChannels = [] } = {}) {
  const db = new Proxy(
    {
      userChannel: { findMany: async () => userChannels },
      project: {
        findMany: async ({ where }) => {
          if (projectThrows) throw new Error('read timeout')
          return projects.filter((p) => p.guildConfigId === where.guildConfigId)
        },
      },
    },
    {
      get(target, key) {
        if (key in target) return target[key]
        throw new Error(`test db: unexpected table ${String(key)}`)
      },
    }
  )
  return { db, getConfig: async (gid) => { assert.equal(gid, 'G1'); return CFG } }
}

/** The channel names the confirm button would delete, from the reply. */
function listedForDeletion(reply) {
  if (!reply.embeds) return []
  const description = reply.embeds[0].data.description
  return [...description.matchAll(/^- #(\S+)/gm)].map((m) => m[1])
}

async function run(projects, channels, opts) {
  const guild = fakeGuild(channels)
  const it = fakeInteraction(guild)
  const error = console.error
  console.error = () => {}
  try {
    await execute(it, seams(projects, opts))
  } finally {
    console.error = error
  }
  return it.replies.at(-1)
}

// The names the whole-branch review used: every one of them defeats the name
// rule `/cleanup` used to protect sections with.
//   '(Legacy) App' -> '📂 (LEGACY) APP' -> 'legacy) app' after the strip
//   'Éclair'       -> '📂 ÉCLAIR'       -> 'clair'       (JS \w, no u flag)
const LEGACY = {
  id: 'p1',
  name: '(Legacy) App',
  guildConfigId: CFG.id,
  discordCategoryId: 'cat-legacy',
  discordChannels: JSON.stringify({ members: 'sc-members', databaseVoice: 'sc-voice' }),
}
const ECLAIR = {
  id: 'p2',
  name: 'Éclair',
  guildConfigId: CFG.id,
  discordCategoryId: 'cat-eclair',
  discordChannels: { members: 'ec-members' },
}

test("a section whose name the old rule mangles is protected by its category id", async () => {
  const legacyCat = category('cat-legacy', '📂 (LEGACY) APP')
  const eclairCat = category('cat-eclair', '📂 ÉCLAIR')
  const leftover = chan('junk', 'random-leftover')
  const reply = await run(
    [LEGACY, ECLAIR],
    [
      legacyCat,
      chan('sc-members', 'legacy-app-members', { parent: legacyCat }),
      chan('sc-voice', 'legacy-app-database-voice', { type: ChannelType.GuildVoice, parent: legacyCat }),
      // A task channel moved into the section by /project-setup.
      chan('tc1', 'feature-0145e3', { parent: legacyCat }),
      // A meeting pair /meeting-channel created inside the section.
      chan('meet-1-text', 'standup-k9-text', { parent: legacyCat }),
      chan('meet-1-voice', 'standup-k9-voice', { type: ChannelType.GuildVoice, parent: legacyCat }),
      eclairCat,
      chan('ec-members', 'eclair-members', { parent: eclairCat }),
      leftover,
    ]
  )
  assert.deepEqual(listedForDeletion(reply), ['random-leftover'])
})

test('a section channel dragged out of its category is still protected, by its own id', async () => {
  // Recorded in `discordChannels`, so the planner still calls it ours and
  // would move it back. Deleting it would take the project's channel with it.
  const reply = await run([LEGACY], [chan('sc-members', 'legacy-app-members')])
  assert.match(reply.content, /No leftover channels found/)
})

test('a `meet-` channel outside every project section is still listed, as before', async () => {
  const reply = await run([LEGACY], [chan('m9', 'meet-old-standup')])
  assert.deepEqual(listedForDeletion(reply), ['meet-old-standup'])
})

test('the name rule still protects a project category that predates the recorded ids', async () => {
  const legacy = { id: 'p3', name: 'Framework', guildConfigId: CFG.id, discordCategoryId: null }
  const cat = category('cat-fw', '📂 FRAMEWORK')
  const reply = await run([legacy], [cat, chan('fw1', 'framework-members', { parent: cat })])
  assert.match(reply.content, /No leftover channels found/)
})

test('a failed project read lists nothing at all, rather than every section', async () => {
  const cat = category('cat-legacy', '📂 (LEGACY) APP')
  const reply = await run(
    [LEGACY],
    [cat, chan('sc-members', 'legacy-app-members', { parent: cat }), chan('junk', 'random-leftover')],
    { projectThrows: true }
  )
  assert.equal(reply.embeds, undefined, 'no confirm button was offered')
  assert.match(reply.content, /could not read this server's projects/)
})

test('a channel from /create-channel is still protected by id', async () => {
  const reply = await run([], [chan('u1', 'aashir-room')], {
    userChannels: [{ textChannelId: 'u1', voiceChannelId: null }],
  })
  assert.match(reply.content, /No leftover channels found/)
})

test('categories themselves are never listed for deletion', async () => {
  const stray = category('cat-stray', 'Some Old Category')
  const reply = await run([], [stray, chan('junk', 'random-leftover', { parent: stray })])
  assert.deepEqual(listedForDeletion(reply), ['random-leftover'])
})

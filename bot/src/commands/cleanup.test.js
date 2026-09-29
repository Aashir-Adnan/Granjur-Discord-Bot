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

/** A db that knows only the three tables `/cleanup` reads, and throws on any other. */
function seams(projects = [], { projectThrows = false, userChannels = [], tasks = [], taskThrows = false } = {}) {
  const db = new Proxy(
    {
      userChannel: { findMany: async () => userChannels },
      project: {
        findMany: async ({ where }) => {
          if (projectThrows) throw new Error('read timeout')
          return projects.filter((p) => p.guildConfigId === where.guildConfigId)
        },
      },
      task: {
        findMany: async ({ where }) => {
          if (taskThrows) throw new Error('read timeout')
          assert.equal(where.guildConfigId, CFG.id)
          return tasks
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

/** The category names the confirm button would delete, from the reply. */
function categoriesListed(reply) {
  if (!reply.embeds) return []
  const description = reply.embeds[0].data.description
  return [...description.matchAll(/^- 📁 (.+)$/gm)].map((m) => m[1])
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

test('a category is listed only once every channel in it is listed', async () => {
  const stray = category('cat-stray', 'Some Old Category')
  const kept = category('cat-kept', 'Has A Room')
  const reply = await run([], [
    stray, chan('junk', 'random-leftover', { parent: stray }),
    kept, chan('u1', 'aashir-room', { parent: kept }), chan('junk2', 'old-notes', { parent: kept }),
  ], { userChannels: [{ textChannelId: 'u1', voiceChannelId: null }] })
  assert.deepEqual(listedForDeletion(reply), ['random-leftover', 'old-notes'])
  assert.deepEqual(categoriesListed(reply), ['Some Old Category'], 'the category keeping a /create-channel room stays')
})

test('the support pair and its category are protected by id', async () => {
  const supportCat = category('supcat', '🛟 Support')
  const support = chan('sup', 'support', { parent: supportCat })
  const supportVoice = chan('supv', 'support-voice', { type: ChannelType.GuildVoice, parent: supportCat })
  const orphan = chan('orphan', 'old-chat')
  const guild = fakeGuild([supportCat, support, supportVoice, orphan])
  const it = fakeInteraction(guild)
  const { db } = seams([])
  const cfg = { ...CFG, supportChannelId: 'sup', supportVoiceChannelId: 'supv' }
  const error = console.error
  console.error = () => {}
  try { await execute(it, { db, getConfig: async () => cfg }) } finally { console.error = error }
  const listed = listedForDeletion(it.replies.at(-1))
  assert.ok(!listed.includes('support') && !listed.includes('support-voice'), `support pair listed: ${listed}`)
  assert.ok(listed.includes('old-chat'), 'an unrelated orphan is still listed')
})

test('the support category is protected by name too, before any id has ever been stored', async () => {
  // Before the first /init, /setup or client approval, cfg carries no support
  // ids at all — and a /cleanup run then would have swept the pair away.
  const supportCat = category('supcat', '🛟 Support')
  const support = chan('sup', 'support', { parent: supportCat })
  const supportVoice = chan('supv', 'support-voice', { type: ChannelType.GuildVoice, parent: supportCat })
  const reply = await run([], [supportCat, support, supportVoice, chan('orphan', 'old-chat')])
  const listed = listedForDeletion(reply)
  assert.ok(!listed.includes('support') && !listed.includes('support-voice'), `support pair listed: ${listed}`)
  assert.deepEqual(listed, ['old-chat'])
})

test('the archive divider is protected by its id, like every other section channel', async () => {
  // Its id lives in `discordChannels`, so `claimedSectionIds` covers it with no
  // rule of its own — and the category rule protects every ticket beside it.
  const cat = category('cat-legacy', 'whatever it is called now')
  const withDivider = { ...LEGACY, discordChannels: JSON.stringify({ members: 'sc-members', archiveDivider: 'div' }) }
  const reply = await run(
    [withDivider],
    [cat, chan('div', 'the-line'), chan('tc1', 'feature-0145e3', { parent: cat }), chan('junk', 'random-leftover')]
  )
  assert.deepEqual(listedForDeletion(reply), ['random-leftover'])
})

// The live server before the trim (roadmap sub-project 3): the new layout, the
// categories being trimmed, the global ticket categories, and stored channels.
function liveServer() {
  const cats = {
    onboarding: category('c-on', '📥 Onboarding'),
    rules: category('c-rules', '📜 Rules'),
    docs: category('c-docs', '📚 Documentation'),
    meetings: category('c-meet', '📋 Meetings'),
    casual: category('c-cas', '💬 Casual'),
    archive: category('c-arch', '📁 Archive'),
    ann: category('c-ann', '📢 Announcements'),
    frontend: category('c-fe', '⚛️ Frontend'),
    cmds: category('c-cmd', '📌 Command channels'),
    features: category('c-feat', '<==== ✨ FEATURES ✨ ====>'),
    bugs: category('c-bugs', 'Bugs'),
    feedback: category('c-fb', '💡 Feedback'),
  }
  return [
    ...Object.values(cats),
    chan('on1', 'welcome-and-verify', { parent: cats.onboarding }),
    chan('r1', 'rules', { parent: cats.rules }),
    chan('d1', 'documentation', { parent: cats.docs }),
    chan('m1', 'general-meetings', { parent: cats.meetings }),
    chan('m2', 'standup-k9-text', { parent: cats.meetings }),
    chan('ca1', 'casual-chat', { parent: cats.casual }),
    chan('a1', 'meeting-metadata', { parent: cats.archive }),
    chan('a2', 'sql-dumps', { parent: cats.archive }),
    chan('an1', 'admin', { parent: cats.ann }),
    chan('fe1', 'frontend-chat', { parent: cats.frontend }),
    chan('fe2', 'frontend-voice', { type: ChannelType.GuildVoice, parent: cats.frontend }),
    chan('cmd1', 'cmd-create-task', { parent: cats.cmds }),
    chan('t1', 'feature-0145e3', { parent: cats.features }),
    chan('t2', 'bug-9a9a9a', { parent: cats.bugs }),
    chan('fb1', 'feedback', { parent: cats.feedback }),
    chan('tr', 'time-reports'),
  ]
}

test('the live trim lists exactly the removed channels and their now-empty categories', async () => {
  const guild = fakeGuild(liveServer())
  const it = fakeInteraction(guild)
  const { db } = seams([])
  const cfg = { ...CFG, timeReportChannelId: 'tr', adminChannelId: 'an1', feedbackChannelId: 'fb1' }
  const error = console.error
  console.error = () => {}
  try { await execute(it, { db, getConfig: async () => cfg }) } finally { console.error = error }
  const reply = it.replies.at(-1)
  assert.deepEqual(listedForDeletion(reply).sort(), ['cmd-create-task', 'frontend-chat', 'frontend-voice', 'meeting-metadata', 'rules', 'sql-dumps'])
  assert.deepEqual(categoriesListed(reply).sort(), ['⚛️ Frontend', '📁 Archive', '📌 Command channels', '📜 Rules'])
})

test('a ticket channel a task points at is protected by id, wherever it sits', async () => {
  const reply = await run([], [chan('t9', 'feature-9f9f9f'), chan('junk', 'random-leftover')], {
    tasks: [{ discordChannelId: 't9', discordThreadId: null }],
  })
  assert.deepEqual(listedForDeletion(reply), ['random-leftover'])
})

test('a failed task read lists nothing at all, rather than every ticket', async () => {
  const reply = await run([], [chan('t9', 'feature-9f9f9f')], { taskThrows: true })
  assert.equal(reply.embeds, undefined, 'no confirm button was offered')
  assert.match(reply.content, /could not read this server's tasks/)
})

test('channels whose ids the config stores are protected by id', async () => {
  const guild = fakeGuild([chan('tr', 'time-reports'), chan('fb', 'renamed-feedback'), chan('junk', 'random-leftover')])
  const it = fakeInteraction(guild)
  const { db } = seams([])
  const cfg = { ...CFG, timeReportChannelId: 'tr', feedbackChannelId: 'fb' }
  await execute(it, { db, getConfig: async () => cfg })
  assert.deepEqual(listedForDeletion(it.replies.at(-1)), ['random-leftover'])
})

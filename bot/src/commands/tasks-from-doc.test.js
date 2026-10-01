// Every test passes fakes for db, getConfig, the feature gates, download and
// extract. The root .env points at production; see
// .claude/rules/tests-never-touch-production.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessageFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js'
import { data, execute, autocomplete } from './tasks-from-doc.js'
import { DocTextError } from '../services/docText.js'
import { isModalFirstCommand, isPublicReplyCommand, handleCommand } from './index.js'

const CFG = { id: 'cfg1' }
const FILE = { name: 'Sprint plan.pdf', url: 'https://cdn/x', size: 10 }

const POST_PERMS = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles,
]
const BOT_USER = { id: 'bot1' }

function fakeInteraction({ values = {}, file = FILE, channelId = 'chan1', guild = { id: 'guild1' }, botPerms = POST_PERMS } = {}) {
  const permsAsked = []
  const ix = {
    guild, channelId, replies: [], edits: [], deleted: 0, followUps: [], permsAsked,
    client: { user: BOT_USER },
    channel: {
      id: channelId,
      permissionsFor: (who) => { permsAsked.push(who); return new PermissionsBitField(botPerms) },
    },
    options: { getString: (n) => values[n] ?? null, getAttachment: (n) => (n === 'file' ? file : null) },
    reply: async (p) => { ix.replies.push(p) },
    deleteReply: async () => { ix.deleted += 1 },
    followUp: async (p) => { ix.followUps.push(p) },
    editReply: async (p) => { ix.edits.push(p) },
  }
  return ix
}

function fakeDb({ projects = [], openJobs = [] } = {}) {
  const calls = { meeting: [], job: [], jobUpdate: [], openQuery: [] }
  return {
    calls,
    project: { findFirst: async ({ where }) => projects.find((p) => p.id === where.id) ?? null, findMany: async () => projects },
    meeting: { create: async (a) => { calls.meeting.push(a); return { id: 'm1' } } },
    meetingPipelineJob: {
      findUnfinishedByGuild: async (guildConfigId) => { calls.openQuery.push(guildConfigId); return openJobs },
      create: async (a) => { calls.job.push(a); return { id: 'j1' } },
      update: async (id, patch) => { calls.jobUpdate.push([id, patch]); return {} },
    },
  }
}

const deps = (db, over = {}) => ({
  db,
  getConfig: async () => CFG,
  enabled: () => true,
  configured: () => true,
  download: async () => Buffer.from('x'),
  extract: async () => ({ text: 'the document text', chars: 17 }),
  ...over,
})

test('definition: file required, project autocomplete, title max 100, no default permissions; index.js defers it publicly', () => {
  const json = data.toJSON()
  assert.equal(json.name, 'tasks-from-doc')
  assert.equal(json.default_member_permissions ?? null, null)
  const [file, project, title] = json.options
  assert.deepEqual([file.name, file.type, file.required], ['file', 11, true])
  assert.deepEqual([project.name, project.autocomplete, !!project.required], ['project', true, false])
  assert.deepEqual([title.name, title.max_length, !!title.required], ['title', 100, false])
  assert.equal(isModalFirstCommand('tasks-from-doc'), false, 'index.js must acknowledge it first')
  assert.equal(isPublicReplyCommand('tasks-from-doc'), true)
})

test('an unexpected error is masked by handleCommand, never shown publicly', async () => {
  const ix = fakeInteraction()
  ix.user = { id: 'u1' }
  ix.commandName = 'tasks-from-doc'
  ix.deferred = true
  ix.guild = null
  const commands = new Map([['tasks-from-doc', { execute: async () => { throw new Error('ER_SECRET db detail') } }]])
  const realError = console.error
  console.error = () => {}
  try { await handleCommand(ix, commands) } finally { console.error = realError }
  assert.deepEqual(ix.edits, [{ content: 'Something went wrong. Try again in a minute.' }])
})

// A refusal removes the public placeholder and sends an ephemeral follow-up.
const assertRefused = (ix, content) => {
  assert.equal(ix.deleted, 1)
  assert.deepEqual(ix.followUps, [{ content, flags: MessageFlags.Ephemeral }])
  assert.deepEqual(ix.edits, [])
  assert.deepEqual(ix.replies, [])
}

test('refuses ephemerally when the pipeline is off', async () => {
  const ix = fakeInteraction()
  const db = fakeDb()
  await execute(ix, deps(db, { enabled: () => false }))
  assertRefused(ix, 'Tasks from documents are not available on this server yet.')
  assert.equal(db.calls.meeting.length, 0)
})

test('refuses the same way when CSAAS is not configured', async () => {
  const ix = fakeInteraction()
  await execute(ix, deps(fakeDb(), { configured: () => false }))
  assertRefused(ix, 'Tasks from documents are not available on this server yet.')
})

test('an unknown project, or one from another server, is refused ephemerally', async () => {
  for (const values of [{ project: 'nope' }, { project: 'p-other' }]) {
    const ix = fakeInteraction({ values })
    const db = fakeDb({ projects: [{ id: 'p-other', name: 'Other', guildConfigId: 'cfg-x' }] })
    await execute(ix, deps(db))
    assertRefused(ix, 'No project matches that name.')
    assert.equal(db.calls.meeting.length, 0)
  }
})

test('a DocTextError is shown verbatim, ephemerally, and nothing is created', async () => {
  const ix = fakeInteraction()
  const db = fakeDb()
  const seen = []
  await execute(ix, deps(db, {
    download: async (a) => { seen.push(a); return Buffer.from('x') },
    extract: async () => { throw new DocTextError('**Sprint plan.pdf** has no text.') },
  }))
  assert.deepEqual(seen, [FILE])
  assertRefused(ix, '**Sprint plan.pdf** has no text.')
  assert.equal(db.calls.meeting.length, 0)
  assert.equal(db.calls.job.length, 0)
})

test('a download DocTextError is shown verbatim too, and no meeting or job row is created', async () => {
  const ix = fakeInteraction()
  const db = fakeDb()
  await execute(ix, deps(db, { download: async () => { throw new DocTextError('**Sprint plan.pdf** is larger than 10 MB.') } }))
  assertRefused(ix, '**Sprint plan.pdf** is larger than 10 MB.')
  assert.equal(db.calls.meeting.length, 0)
  assert.equal(db.calls.job.length, 0)
})

test('text under 60,000 characters but over 65,535 bytes is refused before any row is written', async () => {
  const text = '—'.repeat(30000) // 30,000 characters, 90,000 bytes
  assert.ok(text.length < 60000 && Buffer.byteLength(text, 'utf8') > 65535)
  const ix = fakeInteraction()
  const db = fakeDb()
  await execute(ix, deps(db, { extract: async () => ({ text, chars: text.length }) }))
  assertRefused(ix, '**Sprint plan.pdf** is too long to store. Split it into smaller files.')
  assert.equal(db.calls.meeting.length, 0)
  assert.equal(db.calls.job.length, 0)
})

test('if the job cannot be created the meeting row is removed and the error propagates', async () => {
  const ix = fakeInteraction()
  const db = fakeDb()
  const deleted = []
  db.meeting.delete = async (a) => { deleted.push(a) }
  db.meetingPipelineJob.create = async () => { throw new Error('insert failed') }
  await assert.rejects(() => execute(ix, deps(db)), /insert failed/)
  assert.deepEqual(deleted, [{ where: { id: 'm1' } }])
  assert.deepEqual(ix.edits, [])
})

test('a failing cleanup delete is logged and does not hide the original error', async () => {
  const db = fakeDb()
  db.meeting.delete = async () => { throw new Error('delete failed') }
  db.meetingPipelineJob.create = async () => { throw new Error('insert failed') }
  const warns = []
  const realWarn = console.warn
  console.warn = (...a) => warns.push(a)
  try {
    await assert.rejects(() => execute(fakeInteraction(), deps(db)), /insert failed/)
  } finally { console.warn = realWarn }
  assert.equal(warns.length, 1)
})

test('accepted: creates the meeting and the job, replies publicly through the deferred reply; title defaults to the file name without its extension', async () => {
  const ix = fakeInteraction()
  const db = fakeDb()
  await execute(ix, deps(db))
  assert.deepEqual(ix.replies, [])
  assert.equal(ix.deleted, 0)
  assert.deepEqual(ix.followUps, [])
  assert.deepEqual(db.calls.meeting, [{ data: { guildConfigId: 'cfg1', channelId: 'chan1', transcript: 'the document text' } }])
  assert.deepEqual(db.calls.job, [{ data: {
    guildConfigId: 'cfg1', meetingId: 'm1',
    dataJson: { source: 'document', reviewChannelId: 'chan1', documentName: 'Sprint plan.pdf', title: 'Sprint plan' },
  } }], 'exactly one create call, carrying the dataJson')
  assert.deepEqual(db.calls.jobUpdate, [], 'no follow-up update')
  assert.deepEqual(ix.edits, [{
    content: 'Reading **Sprint plan.pdf** — the proposed tasks will be posted here for review.',
    allowedMentions: { parse: [] },
  }])
})

// ---- final fix wave (2026-10-01) ----

test('the accepted reply pings nobody, even for a file named after a mention', async () => {
  const ix = fakeInteraction({ file: { ...FILE, name: '@everyone.md' } })
  await execute(ix, deps(fakeDb()))
  assert.equal(ix.edits[0].content, 'Reading **@everyone.md** — the proposed tasks will be posted here for review.')
  assert.deepEqual(ix.edits[0].allowedMentions, { parse: [] })
})

const TOO_LONG = '**Sprint plan.pdf** is too long to store. Split it into smaller files.'

test('text within 64 bytes of the 65,535-byte column is refused (CSAAS prefixes its own marker)', async () => {
  const text = 'a'.repeat(65535 - 63)
  const ix = fakeInteraction()
  const db = fakeDb()
  await execute(ix, deps(db, { extract: async () => ({ text, chars: text.length }) }))
  assertRefused(ix, TOO_LONG)
  assert.equal(db.calls.meeting.length, 0)

  const fits = 'a'.repeat(65535 - 64)
  const ok = fakeInteraction()
  await execute(ok, deps(fakeDb(), { extract: async () => ({ text: fits, chars: fits.length }) }))
  assert.equal(ok.edits.length, 1)
})

test('text whose JSON escaping would pass 95,000 bytes is refused, though its own bytes fit', async () => {
  const text = '"'.repeat(48000) // 48,000 bytes; JSON.stringify doubles every quote -> 96,002
  assert.ok(Buffer.byteLength(text, 'utf8') < 65535 - 64)
  assert.ok(Buffer.byteLength(JSON.stringify(text), 'utf8') > 95_000)
  const ix = fakeInteraction()
  const db = fakeDb()
  await execute(ix, deps(db, { extract: async () => ({ text, chars: text.length }) }))
  assertRefused(ix, TOO_LONG)
  assert.equal(db.calls.meeting.length, 0)
})

const docJobRow = (status) => ({ id: `j-${status}`, status, dataJson: { source: 'document' } })

test('2 document jobs in progress: a third is accepted', async () => {
  const openJobs = [docJobRow('pending'), docJobRow('blocked'), { id: 'rec', status: 'pending', dataJson: {} }]
  const ix = fakeInteraction()
  const db = fakeDb({ openJobs })
  await execute(ix, deps(db))
  assert.deepEqual(db.calls.openQuery, ['cfg1'])
  assert.equal(db.calls.job.length, 1)
  assert.equal(ix.edits.length, 1)
})

test('3 document jobs in progress: refused ephemerally, before any download', async () => {
  const openJobs = [docJobRow('pending'), docJobRow('working'), docJobRow('blocked'), docJobRow('done'), docJobRow('failed')]
  const ix = fakeInteraction()
  const db = fakeDb({ openJobs })
  let downloaded = false
  await execute(ix, deps(db, { download: async () => { downloaded = true; return Buffer.from('x') } }))
  assertRefused(ix, 'This server already has 3 documents being turned into tasks. Try again when one is reviewed.')
  assert.equal(downloaded, false)
  assert.equal(db.calls.meeting.length, 0)
})

test("refused ephemerally when the bot can't attach files in this channel, before any download", async () => {
  for (const botPerms of [
    [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.AttachFiles],
    [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles],
  ]) {
    const ix = fakeInteraction({ botPerms })
    const db = fakeDb()
    let downloaded = false
    await execute(ix, deps(db, { download: async () => { downloaded = true; return Buffer.from('x') } }))
    assertRefused(ix, "I can't post in this channel — run /tasks-from-doc where I can send messages and attach files.")
    assert.equal(downloaded, false)
    assert.equal(db.calls.meeting.length, 0)
  }
})

test('the channel check asks about the bot itself, and passes with all three permissions', async () => {
  const ix = fakeInteraction()
  await execute(ix, deps(fakeDb()))
  assert.deepEqual(ix.permsAsked, [BOT_USER])
  assert.equal(ix.edits.length, 1)
})

test('accepted with a project and a title: the project id goes on the meeting and the title on the job', async () => {
  const ix = fakeInteraction({ values: { project: 'p1', title: '  Kickoff  ' } })
  const db = fakeDb({ projects: [{ id: 'p1', name: 'Apollo', guildConfigId: 'cfg1' }] })
  await execute(ix, deps(db))
  assert.equal(db.calls.meeting[0].data.projectId, 'p1')
  assert.equal(db.calls.job[0].data.dataJson.title, 'Kickoff')
})

test('autocomplete offers the guild projects without the detach choice', async () => {
  let responded = null
  const ix = {
    guild: { id: 'guild1' },
    options: { getFocused: () => ({ name: 'project', value: 'ap' }) },
    respond: async (c) => { responded = c },
  }
  const db = fakeDb({ projects: [{ id: 'p1', name: 'Apollo' }, { id: 'p2', name: 'Zeus' }] })
  await autocomplete(ix, { db, getConfig: async () => CFG })
  assert.deepEqual(responded, [{ name: 'Apollo', value: 'p1' }])
})

test('a deleted project is refused ephemerally, before any download, and nothing is created', async () => {
  const ix = fakeInteraction({ values: { project: 'p1' } })
  const db = fakeDb({ projects: [{ id: 'p1', name: 'Apollo', guildConfigId: 'cfg1', deletedAt: new Date('2026-10-01T09:00:00Z') }] })
  let downloaded = false
  await execute(ix, deps(db, { download: async () => { downloaded = true; return Buffer.from('x') } }))
  assertRefused(ix, 'This project is deleted.')
  assert.equal(downloaded, false)
  assert.equal(db.calls.meeting.length, 0)
  assert.equal(db.calls.job.length, 0)
})

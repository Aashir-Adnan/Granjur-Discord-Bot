import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachmentPlan, clientProjects, createClientRequest, requestDescription, MAX_UPLOAD_BYTES, composeDetails, chunkText, ISSUE_FIELDS, FEATURE_FIELDS } from './clientRequest.js'

test('clientProjects keeps only client rows', () => {
  assert.deepEqual(clientProjects([{ projectId: 'a', role: 'client' }, { projectId: 'b', role: 'lead' }]).map((r) => r.projectId), ['a'])
})

test('requestDescription leads with the client notice', () => {
  assert.equal(requestDescription('Ali', 'It breaks'), 'Client request — Ali can read this channel.\n\nIt breaks')
})

test('attachmentPlan re-uploads what fits and links what does not', () => {
  const small = { url: 'https://cdn/x.pdf', name: 'x.pdf', size: 10 }
  const big = { url: 'https://cdn/big.zip', name: 'big.zip', size: MAX_UPLOAD_BYTES + 1 }
  assert.deepEqual(attachmentPlan([small, big, null]), {
    files: [{ attachment: 'https://cdn/x.pdf', name: 'x.pdf' }],
    links: [{ name: 'big.zip', url: 'https://cdn/big.zip' }],
  })
})

function harness({ project = null, leads = [] } = {}) {
  const created = []
  const sent = { support: [], admin: [] }
  const dms = []
  const supportChannel = { id: 'sup', send: async (p) => { sent.support.push(p) } }
  const adminChannel = { id: 'admin', send: async (p) => { sent.admin.push(p) } }
  const guild = {
    id: 'g1',
    channels: { cache: new Map([['sup', supportChannel], ['admin', adminChannel]]), fetch: async (id) => (id === 'admin' ? adminChannel : null) },
    members: { cache: new Map([['u-c', { displayName: 'Ali' }]]) },
  }
  const channelSends = []
  const pinned = []
  const channel = {
    id: 'req-chan', name: 'bug-login-fails',
    send: async (p) => { channelSends.push(p); return { pin: async () => {} } },
    messages: { fetch: async () => new Map([['m1', { pin: async () => { pinned.push('m1') } }]]) },
  }
  const db = {
    task: {
      create: async ({ data }) => { created.push(data); return { id: 't1', ...data } },
      update: async () => ({}),
    },
    ticketDoc: { create: async () => ({}) },
    projectMember: { findByProject: async () => leads.map((id) => ({ discordId: id, role: 'lead' })) },
  }
  const createChannel = async (_guild, opts) => { createChannel.opts = opts; return { channel, fellBack: null } }
  const dmOpts = []
  const dm = async (_client, ids, opts) => { dms.push(...ids); dmOpts.push(opts); return ids.length }
  return { guild, db, created, sent, dms, dmOpts, channelSends, pinned, createChannel, dm, project,
    cfg: { id: 'cfg1', adminChannelId: 'admin' }, user: { id: 'u-c', username: 'ali' } }
}

test('a request becomes a task with requestedBy, a channel with the client in it, re-posted files, and a project notice', async () => {
  const h = harness({ project: { id: 'p1', name: 'Framework', discordChannels: { support: 'sup' } }, leads: ['lead1'] })
  const out = await createClientRequest({
    guild: h.guild, user: h.user, cfg: h.cfg, type: 'bug', title: 'Login fails', details: 'After the code, it reloads.',
    project: h.project, attachments: [{ url: 'https://cdn/x.png', name: 'x.png', size: 5 }],
    db: h.db, createChannel: h.createChannel, dm: h.dm, client: {},
  })
  const row = h.created[0]
  assert.equal(row.requestedBy, 'u-c')
  assert.equal(row.createdBy, 'u-c')
  assert.equal(row.type, 'bug'); assert.equal(row.is_bug, 1); assert.equal(row.is_feature, 0)
  assert.equal(row.status, 'open'); assert.equal(row.projectId, 'p1'); assert.equal(row.projectName, 'Framework')
  assert.deepEqual(row.assigneeIds, []); assert.equal(row.estimateMinutes, undefined)
  assert.deepEqual(h.createChannel.opts.memberIds, ['u-c'])
  assert.equal(h.createChannel.opts.project, h.project)
  assert.match(h.createChannel.opts.description, /^Client request — Ali can read this channel\./)
  assert.equal(h.createChannel.opts.closeHint, null)
  assert.deepEqual(h.pinned, ['m1'])
  assert.deepEqual(h.channelSends[0].files, [{ attachment: 'https://cdn/x.png', name: 'x.png' }])
  assert.equal(h.sent.support.length, 1)
  assert.match(h.sent.support[0].content, /New request from \*\*Ali\*\*: \*\*Login fails\*\* → <#req-chan>/)
  assert.deepEqual(h.dms, ['lead1'])
  assert.equal(out.noticedIn, 'sup')
})

test('no project: notice goes to the admin channel, nobody is DMed, the channel falls back globally', async () => {
  const h = harness()
  const out = await createClientRequest({
    guild: h.guild, user: h.user, cfg: h.cfg, type: 'feature', title: 'Export', details: 'CSV please',
    project: null, attachments: [], db: h.db, createChannel: h.createChannel, dm: h.dm, client: {},
  })
  assert.equal(h.created[0].projectId, null)
  assert.equal(h.created[0].is_feature, 1)
  assert.equal(h.createChannel.opts.project, null)
  assert.equal(h.sent.admin.length, 1)
  assert.equal(h.sent.support.length, 0)
  assert.deepEqual(h.dms, [])
  assert.equal(out.noticedIn, 'admin')
  assert.equal(h.channelSends.length, 0, 'no attachments, no second message')
})

test('the lead DM says a client raised it, not that they were assigned it', async () => {
  const h = harness({ project: { id: 'p1', name: 'Framework', discordChannels: { support: 'sup' } }, leads: ['lead1'] })
  await createClientRequest({
    guild: h.guild, user: h.user, cfg: h.cfg, type: 'bug', title: 'Login fails', details: 'd',
    project: h.project, attachments: [], db: h.db, createChannel: h.createChannel, dm: h.dm, client: {},
  })
  assert.deepEqual(h.dms, ['lead1'])
  assert.equal(h.dmOpts[0].headline, 'A client raised **Login fails**')
})

// --- the structured fields ----------------------------------------------------

test('composeDetails: grouped short fields share a line, long fields get their own, empties are omitted, then the free text', () => {
  const out = composeDetails(ISSUE_FIELDS, {
    platform: 'Android', os: '14', app_version: '2.4.1', steps: 'open bookings → tap export', expected: 'a CSV download',
    severity: 'Major', frequency: 'Every time', account: 'ali@acme.com',
  }, 'The spinner never ends.')
  assert.equal(out, [
    '**Platform:** Android · **OS:** 14 · **App/Browser:** 2.4.1',
    '**Severity:** Major · **Frequency:** Every time · **Account:** ali@acme.com',
    '**Steps:** open bookings → tap export',
    '**Expected:** a CSV download',
    '',
    'The spinner never ends.',
  ].join('\n'))
})

test('composeDetails with nothing filled is exactly the free text', () => {
  assert.equal(composeDetails(ISSUE_FIELDS, {}, 'Just this'), 'Just this')
  assert.equal(composeDetails(FEATURE_FIELDS, { platform: '', who: '   ' }, 'x'), 'x')
})

test('the field tables are well-formed and in the agreed order', () => {
  for (const f of [...ISSUE_FIELDS, ...FEATURE_FIELDS]) {
    assert.match(f.name, /^[a-z_]+$/)
    assert.ok(f.label && f.description)
    assert.ok(['text', 'choice'].includes(f.kind))
    if (f.kind === 'choice') assert.ok(f.choices.length >= 2 && f.choices.length <= 25)
    else assert.ok(f.max > 0 && f.max <= 6000)
  }
  assert.deepEqual(ISSUE_FIELDS.map((f) => f.name), ['platform', 'os', 'app_version', 'severity', 'frequency', 'when', 'account', 'steps', 'expected'])
  assert.deepEqual(FEATURE_FIELDS.map((f) => f.name), ['platform', 'priority', 'needed_by', 'problem', 'who', 'example'])
})

test('chunkText splits on the limit and yields nothing for nothing', () => {
  assert.deepEqual(chunkText('abcdef', 4), ['abcd', 'ef'])
  assert.deepEqual(chunkText('', 4), [])
})

test('a description longer than the embed shows is also posted in full below it', async () => {
  const h = harness({ project: { id: 'p1', name: 'Framework', discordChannels: { support: 'sup' } } })
  const details = 'x'.repeat(1500)
  await createClientRequest({
    guild: h.guild, user: h.user, cfg: h.cfg, type: 'bug', title: 'Long', details, project: h.project,
    attachments: [], db: h.db, createChannel: h.createChannel, dm: h.dm, client: {},
  })
  const full = h.channelSends.find((m) => String(m.content ?? '').startsWith('**Full details**'))
  assert.ok(full, 'the embed is cut at 1000 characters, so the full text follows as a message')
  assert.ok(full.content.includes('x'.repeat(100)))
})

test('a short description is not repeated below the embed', async () => {
  const h = harness()
  await createClientRequest({
    guild: h.guild, user: h.user, cfg: h.cfg, type: 'feature', title: 'S', details: 'short', project: null,
    attachments: [], db: h.db, createChannel: h.createChannel, dm: h.dm, client: {},
  })
  assert.equal(h.channelSends.length, 0)
})

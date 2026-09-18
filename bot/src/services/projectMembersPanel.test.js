import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PANEL_MARKER,
  buildMembersEmbed,
  findPanelPin,
  ensureMembersPanel,
  postMembershipChange,
} from './projectMembersPanel.js'

const project = { id: 'p1', name: 'Aurora' }
const nameFor = (id) => ({ u1: 'Ada', u2: 'Grace', u3: 'Hedy' })[id] || id

// --- buildMembersEmbed ------------------------------------------------------

test('buildMembersEmbed groups members by role, in PROJECT_MEMBER_ROLES order, with readable labels', () => {
  const members = [
    { discordId: 'u2', role: 'developer' },
    { discordId: 'u1', role: 'lead' },
    { discordId: 'u3', role: 'developer' },
  ]
  const json = buildMembersEmbed(project, members, nameFor).toJSON()
  assert.equal(json.title, 'Members — Aurora')
  assert.equal(json.color, 0x5865f2)
  assert.equal(json.footer.text, `${PANEL_MARKER} · Aurora`)
  // lead comes before developer in PROJECT_MEMBER_ROLES, regardless of input order
  assert.deepEqual(
    json.fields.map((f) => f.name),
    ['Lead', 'Developer'],
  )
  assert.equal(json.fields[0].value, 'Ada')
  assert.equal(json.fields[1].value, 'Grace, Hedy')
})

test('buildMembersEmbed says "No members yet" when the project has nobody on it', () => {
  const json = buildMembersEmbed(project, [], nameFor).toJSON()
  assert.equal(json.description, 'No members yet. Add one with /project-members add.')
  assert.equal(json.fields, undefined)
})

test('buildMembersEmbed caps a field value at 1024 characters', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ discordId: `id${i}`, role: 'qa' }))
  const longNameFor = (id) => `Person-${id}-with-a-long-name`
  const json = buildMembersEmbed(project, many, longNameFor).toJSON()
  const qaField = json.fields.find((f) => f.name === 'QA')
  assert.ok(qaField.value.length <= 1024)
})

test('buildMembersEmbed footer keys the panel to this project, so two projects never match', () => {
  const other = { id: 'p2', name: 'Borealis' }
  const j1 = buildMembersEmbed(project, [], nameFor).toJSON()
  const j2 = buildMembersEmbed(other, [], nameFor).toJSON()
  assert.notEqual(j1.footer.text, j2.footer.text)
})

// --- findPanelPin ------------------------------------------------------------

test('findPanelPin matches only the bot\'s own message with this project\'s footer', () => {
  const mine = { author: { id: 'bot' }, embeds: [{ footer: { text: `${PANEL_MARKER} · Aurora` } }] }
  const theirs = { author: { id: 'someone' }, embeds: [{ footer: { text: `${PANEL_MARKER} · Aurora` } }] }
  const otherProject = { author: { id: 'bot' }, embeds: [{ footer: { text: `${PANEL_MARKER} · Borealis` } }] }
  const noEmbed = { author: { id: 'bot' }, embeds: [] }

  assert.equal(findPanelPin([otherProject, mine], 'bot', project), mine)
  assert.equal(findPanelPin([theirs, otherProject], 'bot', project), null)
  assert.equal(findPanelPin([], 'bot', project), null)
  assert.equal(findPanelPin([noEmbed], 'bot', project), null)
})

// --- ensureMembersPanel -------------------------------------------------------

function fakeMsg(footerText) {
  const msg = {
    author: { id: 'bot' },
    embeds: [{ footer: { text: footerText } }],
    edited: [],
    pinned: false,
  }
  msg.edit = async (payload) => {
    msg.edited.push(payload)
    msg.embeds = payload.embeds.map((e) => e.toJSON())
  }
  msg.pin = async () => { msg.pinned = true }
  return msg
}

test('ensureMembersPanel posts and pins when no panel exists yet', async () => {
  const pins = new Map()
  const channel = {
    messages: { fetchPinned: async () => pins },
    send: async (payload) => {
      const msg = {
        author: { id: 'bot' },
        embeds: payload.embeds.map((e) => e.toJSON()),
        pin: async () => { pins.set(msg.id, msg) },
      }
      msg.id = 'm1'
      return msg
    },
  }
  const result = await ensureMembersPanel(channel, project, [], { botUserId: 'bot', nameFor })
  assert.equal(result, 'posted')
  assert.equal(pins.size, 1)
})

test('ensureMembersPanel edits an existing pin instead of posting a second one', async () => {
  const existing = fakeMsg(`${PANEL_MARKER} · Aurora`)
  const pins = new Map([[existing.id || 'm1', existing]])
  let sent = 0
  const channel = {
    messages: { fetchPinned: async () => pins },
    send: async () => { sent += 1 },
  }
  const members = [{ discordId: 'u1', role: 'lead' }]
  const result = await ensureMembersPanel(channel, project, members, { botUserId: 'bot', nameFor })
  assert.equal(result, 'edited')
  assert.equal(existing.edited.length, 1)
  assert.equal(sent, 0, 'must not post a second message')
})

test('ensureMembersPanel returns false and does not reject when the channel throws', async () => {
  const channel = {
    messages: { fetchPinned: async () => { throw new Error('Missing Access') } },
    send: async () => { throw new Error('Missing Permissions') },
  }
  const result = await ensureMembersPanel(channel, project, [], { botUserId: 'bot', nameFor })
  assert.equal(result, false)
})

// --- postMembershipChange ------------------------------------------------------

test('postMembershipChange announces a join with the readable role label', async () => {
  const sent = []
  const channel = { send: async (payload) => { sent.push(payload) } }
  const ok = await postMembershipChange(channel, { name: 'Ada', role: 'backend_developer', action: 'added' })
  assert.equal(ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].content, '**Ada** joined the project as Backend Developer')
})

test('postMembershipChange announces a departure with no role', async () => {
  const sent = []
  const channel = { send: async (payload) => { sent.push(payload) } }
  const ok = await postMembershipChange(channel, { name: 'Grace', role: 'qa', action: 'removed' })
  assert.equal(ok, true)
  assert.equal(sent[0].content, '**Grace** left the project')
})

test('postMembershipChange is caught and returns false rather than throwing', async () => {
  const channel = { send: async () => { throw new Error('Missing Permissions') } }
  const ok = await postMembershipChange(channel, { name: 'Ada', role: 'lead', action: 'added' })
  assert.equal(ok, false)
})

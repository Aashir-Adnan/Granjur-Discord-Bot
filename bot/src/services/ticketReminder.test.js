import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupTickets, buildReminderBody } from './ticketReminder.js'

const BOT = '1476073532944289842'

test('an assigned ticket goes to its holder, not to the bot that created it', () => {
  const byUser = groupTickets({
    features: [
      { title: 'Fix the APIs', status: 'open', assigneeIds: ['11'], createdBy: BOT, discordChannelId: 'c1' },
    ],
    botUserId: BOT,
  })
  assert.deepEqual([...byUser.keys()], ['11'])
  assert.equal(byUser.get('11').assigned.length, 1)
  assert.equal(byUser.get('11').created.length, 0)
  assert.equal(byUser.get('11').assigned[0].channelId, 'c1')
})

test('an unassigned ticket falls back to whoever opened it', () => {
  const byUser = groupTickets({
    features: [{ title: 'Audit encryption', status: 'open', assigneeIds: [], createdBy: '77' }],
  })
  assert.deepEqual(byUser.get('77').created.map((t) => t.title), ['Audit encryption'])
  assert.equal(byUser.get('77').assigned.length, 0)
})

test('the author of an assigned ticket is not nagged about it', () => {
  const byUser = groupTickets({
    features: [{ title: 'T', status: 'open', assigneeIds: ['11'], createdBy: '77' }],
  })
  assert.deepEqual([...byUser.keys()], ['11'])
})

test('bugs group by tagged members and keep their own status', () => {
  const byUser = groupTickets({
    bugs: [{ title: 'Crash on save', status: 'pending', taggedMemberIds: ['11', '22'] }],
  })
  assert.equal(byUser.get('11').assigned[0].kind, 'bug')
  assert.equal(byUser.get('22').assigned[0].status, 'pending')
})

test('the body says who holds what, and names the status per ticket', () => {
  const body = buildReminderBody('Granjur', {
    assigned: [{ kind: 'feature', title: 'Fix the APIs', status: 'in_progress', channelId: 'c1' }],
    created: [{ kind: 'feature', title: 'Audit encryption', status: 'open', channelId: null }],
  })
  assert.match(body, /\*\*Granjur\*\* — your unfinished tickets/)
  assert.match(body, /\*\*Assigned to you:\*\*/)
  assert.match(body, /`in_progress` Fix the APIs — <#c1>/)
  assert.match(body, /\*\*You opened, nobody assigned:\*\*/)
  assert.match(body, /`open` Audit encryption/)
  assert.match(body, /\/update-task/)
})

test('a section with nothing in it is omitted entirely', () => {
  const body = buildReminderBody('Granjur', {
    assigned: [{ kind: 'feature', title: 'T', status: 'open', channelId: null }],
    created: [],
  })
  assert.ok(!body.includes('You opened'), body)
})

test('nothing to say produces no message', () => {
  assert.equal(buildReminderBody('Granjur', { assigned: [], created: [] }), null)
})

test('a long list is truncated and stays under the DM cap', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    kind: 'feature', title: `Task number ${i}`, status: 'open', channelId: null,
  }))
  const body = buildReminderBody('Granjur', { assigned: many, created: [] })
  assert.ok(body.length <= 2000, `length ${body.length}`)
  assert.match(body, /_… and 25 more_/)
})

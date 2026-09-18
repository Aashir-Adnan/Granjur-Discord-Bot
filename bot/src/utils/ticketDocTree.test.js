import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ticketsRootOption,
  ticketProjectOptions,
  ticketDocOptions,
  ticketDocScopeFor,
  TICKETS_ROOT,
  TICKETS_NO_PROJECT,
} from './ticketDocTree.js'

const rows = [
  { id: 'd1', title: 'Booking rules', projectId: 'p-hms', projectName: 'Badar HMS', taskStatus: 'closed', updatedAt: '2026-09-01T10:00:00Z' },
  { id: 'd2', title: 'Refund flow', projectId: 'p-hms', projectName: 'Badar HMS', taskStatus: 'closed', updatedAt: '2026-09-02T10:00:00Z' },
  { id: 'd3', title: 'Logger refactor', projectId: null, projectName: null, taskStatus: 'done', updatedAt: '2026-09-03T10:00:00Z' },
  { id: 'd4', title: 'Auth tokens', projectId: 'p-fw', projectName: 'Framework', taskStatus: 'closed', updatedAt: null },
]

test('the root entry counts write-ups and is absent when there are none', () => {
  assert.equal(ticketsRootOption([]), null)
  const o = ticketsRootOption(rows)
  assert.equal(o.value, TICKETS_ROOT)
  assert.match(o.description, /4 write-ups/)
})

test('level 1 lists projects alphabetically, then "No project", after a way back', () => {
  const o = ticketProjectOptions(rows)
  assert.equal(o[0].value, 'root:')
  assert.deepEqual(o.slice(1).map((x) => x.value), ['tickets:proj:p-hms', 'tickets:proj:p-fw', TICKETS_NO_PROJECT])
  assert.match(o[1].label, /Badar HMS/)
  assert.match(o[1].description, /2 write-ups/)
  assert.match(o[3].description, /1 write-up$/)
})

test('level 2 lists one bucket with a Back entry and status/date descriptions', () => {
  const o = ticketDocOptions(rows, 'tickets:proj:p-hms')
  assert.equal(o[0].value, TICKETS_ROOT)
  assert.deepEqual(o.slice(1).map((x) => x.value), ['tdoc:d1', 'tdoc:d2'])
  assert.equal(o[1].description, 'closed · 2026-09-01')
  const none = ticketDocOptions(rows, TICKETS_NO_PROJECT)
  assert.deepEqual(none.slice(1).map((x) => x.value), ['tdoc:d3'])
  // a missing updatedAt does not break the description
  const fw = ticketDocOptions(rows, 'tickets:proj:p-fw')
  assert.equal(fw[1].description, 'closed')
})

test('a ticket doc knows which bucket it came from', () => {
  assert.equal(ticketDocScopeFor(rows[0]), 'tickets:proj:p-hms')
  assert.equal(ticketDocScopeFor(rows[2]), TICKETS_NO_PROJECT)
})

test('never more than 25 options at either level', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, title: `T${i}`, projectId: `p${i}`, projectName: `P${i}`, taskStatus: 'closed' }))
  assert.ok(ticketProjectOptions(many).length <= 25)
  const same = Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, title: `T${i}`, projectId: 'p', projectName: 'P', taskStatus: 'closed' }))
  assert.ok(ticketDocOptions(same, 'tickets:proj:p').length <= 25)
})

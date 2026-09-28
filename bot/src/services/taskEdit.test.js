import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdit, applyDependencyChange } from './taskEdit.js'

const task = { id: 'T', guildConfigId: 'g1', title: 'Git Sync', status: 'open', parentTaskId: null }
const cfg = { id: 'g1' }

// A fake db that records every write. Rows are copies so a fake never mutates the caller's snapshot.
function fakeDb({ children = [], known = ['B', 'C'], deps = [] } = {}) {
  const log = []
  return {
    log,
    task: {
      findChildren: async () => children.map((c) => ({ ...c })),
      findByIds: async ({ where }) => where.ids.filter((id) => known.includes(id)).map((id) => ({ id, title: `Task ${id}`, status: 'open' })),
    },
    taskDependency: {
      findManyForGuild: async () => deps.map((d) => ({ ...d })),
      add: async ({ data }) => { log.push(['dep.add', data.blockedByTaskId, data.createdBy]) },
      remove: async ({ where }) => { log.push(['dep.remove', where.blockedByTaskId]); return { removed: 1 } },
    },
    taskActivity: { add: async ({ data }) => { log.push(['activity', data.actorDiscordId, data.actorLabel, data.changes[0].field]) } },
  }
}

test('finishing a task with an open subtask is refused before anything is written', async () => {
  const db = fakeDb({ children: [{ id: 'S', title: 'Sub', status: 'open' }] })
  let applied = 0
  const r = await applyEdit({ db, cfg, task, updates: { status: 'done' }, blockers: { add: ['B'], remove: [] }, apply: async () => { applied++ } })
  assert.match(r.error, /can't be marked done yet/)
  assert.equal(applied, 0)
  assert.deepEqual(db.log, [], 'no blocker row, no activity')
})

test('blockers are added then removed, then one field write with the actor passed through', async () => {
  const db = fakeDb()
  let seen = null
  const actor = { activityId: 'u-match', label: 'Aashir (via the site)' }
  const r = await applyEdit({
    db, cfg, task, updates: { title: 'New' }, blockers: { add: ['B'], remove: ['C'] }, actor,
    apply: async (a) => { seen = a; return { warning: '', notified: { channelId: 'ch', created: false, dmed: [] } } },
  })
  assert.equal(r.error, null)
  assert.deepEqual(r.dep.lines, ['**Blocked by:** Task B', '**Unblocked:** Task C'])
  assert.deepEqual(seen.updates, { title: 'New' })
  assert.equal(seen.actor, actor)
  assert.deepEqual(db.log, [
    ['dep.add', 'B', 'u-match'],
    ['activity', 'u-match', 'Aashir (via the site)', 'blocked_by'],
    ['dep.remove', 'C'],
    ['activity', 'u-match', 'Aashir (via the site)', 'blocked_by'],
  ])
})

test('a blocker the database no longer has is refused and the fields are not written', async () => {
  const db = fakeDb({ known: [] })
  let applied = 0
  const r = await applyEdit({ db, cfg, task, updates: { title: 'New' }, blockers: { add: ['B'], remove: [] }, apply: async () => { applied++ } })
  assert.match(r.error, /No task matches/)
  assert.equal(applied, 0)
})

test('no field updates: only the blockers change and applyTaskUpdate is not called', async () => {
  const db = fakeDb()
  let applied = 0
  const r = await applyEdit({ db, cfg, task, updates: {}, blockers: { add: ['B'], remove: [] }, apply: async () => { applied++ } })
  assert.equal(r.error, null)
  assert.equal(applied, 0)
  assert.equal(r.warning, '')
  assert.deepEqual(r.notified, { channelId: null, created: false, dmed: [] })
})

test('a Discord actor records its own id on blocker rows, as before', async () => {
  const db = fakeDb()
  await applyDependencyChange({ db, cfg, task, blockedById: 'B', actorId: 'u-discord' })
  assert.deepEqual(db.log, [['dep.add', 'B', 'u-discord'], ['activity', 'u-discord', null, 'blocked_by']])
})

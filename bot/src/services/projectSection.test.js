import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  planProjectSection,
  projectFromChannel,
  SECTIONS,
  categoryNameFor,
  channelNameFor,
} from './projectSection.js'

const project = { id: 'p1', name: 'Framework', docsSlug: 'framework' }
const empty = { roleId: null, roleNames: new Map(), categoryId: null, categoryName: null, categoryChannelCount: 0, channels: {}, tasks: [], takenNames: new Set() }

test('names follow the spec', () => {
  assert.equal(categoryNameFor(project), '📂 FRAMEWORK')
  assert.equal(channelNameFor(project, 'frontend-chat'), 'framework-frontend-chat')
  assert.equal(SECTIONS.length, 10)
  assert.deepEqual(SECTIONS.map((s) => s.key).slice(0, 3), ['members', 'documentation', 'meetings'])
})

test('the section table matches the constraints, suffix and type', () => {
  assert.deepEqual(
    SECTIONS.map((s) => [s.key, s.suffix, s.type]),
    [
      ['members', 'members', 'text'],
      ['documentation', 'documentation', 'text'],
      ['meetings', 'meetings', 'text'],
      ['meetingVoice', 'meeting-voice', 'voice'],
      ['frontendChat', 'frontend-chat', 'text'],
      ['frontendVoice', 'frontend-voice', 'voice'],
      ['backendChat', 'backend-chat', 'text'],
      ['backendVoice', 'backend-voice', 'voice'],
      ['databaseChat', 'database-chat', 'text'],
      ['databaseVoice', 'database-voice', 'voice'],
    ]
  )
})

test('a long slug is truncated, the suffix never is, and no hyphen is left dangling', () => {
  const long = { id: 'p3', name: 'Long', docsSlug: 'a'.repeat(120) }
  for (const s of SECTIONS) {
    const name = channelNameFor(long, s.suffix)
    assert.equal(name.length, 100)
    assert.ok(name.endsWith(`-${s.suffix}`), `${name} lost its suffix`)
  }
  // A slug whose cut lands on a hyphen must not produce 'slug--suffix'.
  // 'members' leaves 92 characters for the slug, and character 92 here is the hyphen.
  const hyphen = { id: 'p4', name: 'Hyphen', docsSlug: `${'a'.repeat(91)}-${'b'.repeat(20)}` }
  assert.equal(channelNameFor(hyphen, 'members'), `${'a'.repeat(91)}-members`)
})

test('a fresh project creates the role, the category and all ten channels', () => {
  const plan = planProjectSection(project, empty)
  assert.equal(plan.role.action, 'create')
  assert.equal(plan.role.name, 'Framework')
  assert.equal(plan.category.action, 'create')
  assert.equal(plan.channels.length, 10)
  assert.ok(plan.channels.every((c) => c.action === 'create'))
  assert.equal(plan.warnings.length, 0)
})

test('an existing role of the same name is reused, not created again', () => {
  const plan = planProjectSection(project, { ...empty, roleNames: new Map([['Framework', 'r9']]) })
  assert.deepEqual([plan.role.action, plan.role.id], ['reuse', 'r9'])
})

test('a project named after a job role is refused a role, with a reason', () => {
  const plan = planProjectSection({ id: 'p2', name: 'Database', docsSlug: 'database' }, empty)
  assert.equal(plan.role.action, 'refuse')
  assert.match(plan.role.reason, /managed role/i)
  assert.ok(plan.warnings.some((w) => /Database/.test(w)))
})

test('a category renamed by hand is renamed back, found by id', () => {
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: 'old name' })
  assert.deepEqual([plan.category.action, plan.category.id, plan.category.name], ['rename', 'c1', '📂 FRAMEWORK'])
})

test('everything already correct plans nothing', () => {
  const channels = {}
  for (const s of SECTIONS) channels[s.key] = { id: `id-${s.key}`, name: channelNameFor(project, s.suffix), parentId: 'c1' }
  const plan = planProjectSection(project, { ...empty, roleId: 'r1', categoryId: 'c1', categoryName: '📂 FRAMEWORK', channels })
  assert.equal(plan.category.action, 'reuse')
  assert.ok(plan.channels.every((c) => c.action === 'reuse'))
})

test('a section channel in the wrong category is moved, a misnamed one renamed', () => {
  const channels = { members: { id: 'm1', name: 'framework-members', parentId: 'OTHER' },
                     documentation: { id: 'd1', name: 'wrong-name', parentId: 'c1' } }
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', channels })
  const byKey = Object.fromEntries(plan.channels.map((c) => [c.key, c]))
  assert.equal(byKey.members.action, 'move')
  assert.equal(byKey.documentation.action, 'rename')
  assert.equal(byKey.meetings.action, 'create')
})

test('a task outside its project is moved and renamed in one action', () => {
  const tasks = [{ id: 'tA1b2c3d4e5f6', title: 'Git Sync', type: 'feature', channelId: 'ch1', channelName: 'feature-0145e3', parentId: 'FEATURES' }]
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', tasks })
  assert.deepEqual(plan.tasks, [{ taskId: 'tA1b2c3d4e5f6', channelId: 'ch1', action: 'both', name: 'feature-git-sync' }])
})

test('a task already right plans none', () => {
  const tasks = [{ id: 't1', title: 'Git Sync', type: 'feature', channelId: 'ch1', channelName: 'feature-git-sync', parentId: 'c1' }]
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', tasks })
  assert.equal(plan.tasks[0].action, 'none')
})

test('past the category cap, task moves are dropped with a warning; sections still plan', () => {
  const tasks = [{ id: 't1', title: 'Git Sync', type: 'feature', channelId: 'ch1', channelName: 'feature-0145e3', parentId: 'FEATURES' }]
  const plan = planProjectSection(project, { ...empty, categoryId: 'c1', categoryName: '📂 FRAMEWORK', categoryChannelCount: 49, tasks })
  assert.equal(plan.tasks[0].action, 'rename')
  assert.ok(plan.warnings.some((w) => /full|cap/i.test(w)))
})

test('projectFromChannel matches a channel by its parent category', () => {
  const projects = [{ id: 'p1', name: 'Framework', discordCategoryId: 'c1' }, { id: 'p2', name: 'Badar', discordCategoryId: 'c2' }]
  assert.equal(projectFromChannel(projects, { id: 'ch9', parentId: 'c2' }).id, 'p2')
})

test('projectFromChannel matches the category channel itself', () => {
  const projects = [{ id: 'p1', name: 'Framework', discordCategoryId: 'c1' }]
  assert.equal(projectFromChannel(projects, { id: 'c1', parentId: null }).id, 'p1')
})

test('projectFromChannel is null for anything else', () => {
  const projects = [{ id: 'p1', name: 'Framework', discordCategoryId: 'c1' }]
  assert.equal(projectFromChannel(projects, { id: 'ch9', parentId: 'OTHER' }), null)
  assert.equal(projectFromChannel(projects, null), null)
  assert.equal(projectFromChannel([], { id: 'ch9', parentId: 'c1' }), null)
  assert.equal(projectFromChannel([{ id: 'p3', name: 'No section', discordCategoryId: null }], { id: 'ch9', parentId: null }), null)
})

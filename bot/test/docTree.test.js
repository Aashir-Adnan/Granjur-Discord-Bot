import test from 'node:test'
import assert from 'node:assert/strict'
import { rootOptions, childOptions } from '../src/utils/docTree.js'

const INDEX = [
  { id: 'd1', path: 'docs/api/overview.md', docId: 'api/overview', section: 'api', projectId: null, title: 'Overview', source: 'repo' },
  { id: 'd2', path: 'docs/api/permissions.md', docId: 'api/permissions', section: 'api', projectId: null, title: 'Permissions', source: 'repo' },
  { id: 'd3', path: 'docs/hms-documentation/admin-apis/rooms.md', docId: 'hms-documentation/admin-apis/rooms', section: 'hms-documentation', projectId: 'p1', title: 'Rooms', source: 'repo' },
  { id: 'd4', path: 'docs/projects/badar-hms/Opera_Config.md', docId: 'projects/badar-hms/Opera_Config', section: 'projects', projectId: 'p1', title: 'Opera Config', source: 'repo' },
  { id: 'd5', path: 'docs/projects/badar-hms/notes.md', docId: 'projects/badar-hms/notes', section: 'projects', projectId: 'p1', title: 'Notes', source: 'local' },
]

const PROJECTS = [{ id: 'p1', name: 'Badar HMS' }, { id: 'p2', name: 'CSAAS' }]

test('rootOptions lists projects that have docs, then sections', () => {
  const opts = rootOptions(INDEX, PROJECTS)
  const values = opts.map((o) => o.value)
  assert.ok(values.includes('proj:p1'))
  assert.equal(values.includes('proj:p2'), false, 'a project with no docs is not offered')
  assert.ok(values.includes('sec:api'))
  assert.equal(values.indexOf('proj:p1') < values.indexOf('sec:api'), true, 'projects come first')
})

test('rootOptions shows the doc count in the description', () => {
  const opts = rootOptions(INDEX, PROJECTS)
  const p1 = opts.find((o) => o.value === 'proj:p1')
  assert.match(p1.description, /3 page/)
})

test('childOptions on a project lists its immediate directories and files', () => {
  const { options } = childOptions(INDEX, { scope: 'proj:p1', prefix: '' })
  const values = options.map((o) => o.value)
  assert.ok(values.includes('dir:hms-documentation'))
  assert.ok(values.includes('dir:projects'))
  assert.equal(values.some((v) => v.startsWith('doc:')), false, 'no files at this level')
})

test('childOptions descends into a directory and lists files', () => {
  const { options } = childOptions(INDEX, { scope: 'proj:p1', prefix: 'projects/badar-hms' })
  const values = options.map((o) => o.value)
  assert.ok(values.includes('doc:d4'))
  assert.ok(values.includes('doc:d5'))
  assert.equal(values[0].startsWith('back:'), true, 'first option goes back')
})

test('childOptions marks local docs', () => {
  const { options } = childOptions(INDEX, { scope: 'proj:p1', prefix: 'projects/badar-hms' })
  const notes = options.find((o) => o.value === 'doc:d5')
  assert.match(notes.label, /📝/)
})

test('childOptions on a section scopes to that section only', () => {
  const { options } = childOptions(INDEX, { scope: 'sec:api', prefix: '' })
  const values = options.map((o) => o.value)
  assert.deepEqual(values.sort(), ['doc:d1', 'doc:d2'])
})

test('childOptions pages when there are more than 25 entries', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `m${i}`,
    path: `docs/api/f${i}.md`,
    docId: `api/f${i}`,
    section: 'api',
    projectId: null,
    title: `File ${i}`,
    source: 'repo',
  }))
  const first = childOptions(many, { scope: 'sec:api', prefix: '', page: 0 })
  assert.equal(first.hasMore, true)
  const moreButton = first.options.find(o => o.value.startsWith('more:'))
  assert.ok(moreButton, 'first page has a more button')
  assert.equal(moreButton.value, 'more:api:1')
  const second = childOptions(many, { scope: 'sec:api', prefix: '', page: 1 })
  assert.equal(second.options[0].value.startsWith('doc:'), true)
})

test('pagination yields each entry exactly once across all pages', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `m${i}`,
    path: `docs/api/f${i}.md`,
    docId: `api/f${i}`,
    section: 'api',
    projectId: null,
    title: `File ${i}`,
    source: 'repo',
  }))
  const seen = new Set()
  let page = 0
  let hasMore = true
  while (hasMore) {
    const result = childOptions(many, { scope: 'sec:api', prefix: '', page })
    for (const opt of result.options) {
      if (opt.value.startsWith('doc:')) {
        assert.equal(seen.has(opt.value), false, `duplicate entry on page ${page}: ${opt.value}`)
        seen.add(opt.value)
      }
    }
    hasMore = result.hasMore
    page++
  }
  assert.equal(seen.size, 60, 'all 60 entries found across pages')
})

test('every option value stays inside Discord\'s 100 character cap', () => {
  const longId = 'hms-documentation/major-implementations/landmarks-cities-regions-hotels/landmarks-cities-regions-hotels'
  const index = [
    { id: 'abc123', path: `docs/${longId}.md`, docId: longId, section: 'hms-documentation', projectId: 'p1', title: 'Landmarks', source: 'repo' },
  ]
  const { options } = childOptions(index, {
    scope: 'proj:p1',
    prefix: 'hms-documentation/major-implementations/landmarks-cities-regions-hotels',
  })
  for (const o of options) {
    assert.ok(o.value.length <= 100, `value too long (${o.value.length}): ${o.value}`)
    assert.ok(o.label.length <= 100)
    assert.ok((o.description || '').length <= 100)
  }
})

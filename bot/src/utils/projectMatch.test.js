import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeName, matchProject } from './projectMatch.js'

const projects = [
  { id: 'p-fw', name: 'Framework' },
  { id: 'p-hms', name: 'Badar HMS' },
  { id: 'p-cs', name: 'CSAAS' },
]
const repos = [
  { id: 'r-hmsnode', name: 'Badar_HMS_Node' },
  { id: 'r-fwnode', name: 'Framework_Node' },
  { id: 'r-fwreact', name: 'Framework_React' },
  { id: 'r-csaas', name: 'CSAAS_Backend' },
  { id: 'r-ubs', name: 'UBS-Doc' },
]
const links = [
  { project_id: 'p-hms', repository_id: 'r-hmsnode' },
  { project_id: 'p-fw', repository_id: 'r-fwnode' },
  { project_id: 'p-fw', repository_id: 'r-fwreact' },
  { project_id: 'p-cs', repository_id: 'r-csaas' },
]

test('normalizeName strips case, spaces, underscores and punctuation', () => {
  assert.equal(normalizeName('Badar HMS'), 'badarhms')
  assert.equal(normalizeName('Badar_HMS'), 'badarhms')
  assert.equal(normalizeName('  badar-hms  '), 'badarhms')
  assert.equal(normalizeName(''), '')
  assert.equal(normalizeName(null), '')
})

test('an exact project name matches, whatever the separators', () => {
  const m = matchProject('Badar_HMS', { projects, repos, links })
  assert.deepEqual(m, { projectId: 'p-hms', projectName: 'Badar HMS', repositoryId: 'r-hmsnode' })
})

test('a repository name resolves to its project through project_repos', () => {
  const m = matchProject('Framework_React', { projects, repos, links })
  assert.deepEqual(m, { projectId: 'p-fw', projectName: 'Framework', repositoryId: 'r-fwreact' })
})

test('a project with several repos gets no repositoryId when the name names the project', () => {
  // Two repos are linked; picking one would be a guess.
  const m = matchProject('framework', { projects, repos, links })
  assert.deepEqual(m, { projectId: 'p-fw', projectName: 'Framework', repositoryId: null })
})

test('a name that starts a longer repo name still matches (Badar_HMS vs Badar_HMS_Node)', () => {
  const m = matchProject('badar hms node', { projects, repos, links })
  assert.equal(m.projectId, 'p-hms')
  assert.equal(m.repositoryId, 'r-hmsnode')
})

test('a repo with no project link still returns the repository', () => {
  const m = matchProject('UBS-Doc', { projects, repos, links })
  assert.deepEqual(m, { projectId: null, projectName: null, repositoryId: 'r-ubs' })
})

test('nothing matches -> null, and ambiguity -> null rather than a guess', () => {
  assert.equal(matchProject('Zebra', { projects, repos, links }), null)
  assert.equal(matchProject('', { projects, repos, links }), null)
  // "node" is a substring of two repos in different projects — refuse to pick.
  assert.equal(matchProject('node', { projects, repos, links }), null)
})

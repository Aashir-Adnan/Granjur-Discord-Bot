// Every test passes fakes for every seam of `handleConfirmAdd` — db, getConfig,
// reattribute and checkAccess. The root .env points at production; see
// .claude/rules/tests-never-touch-production.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as flowStore from '../flows/store.js'
import { handleConfirmAdd } from './repos.js'

const CFG = { id: 'g1' }
const DELETED_AT = new Date('2026-10-01T09:00:00Z')

/** A db whose project list hides a deleted project unless the read opts in, as the real one does. */
function fakeDb(projects = []) {
  const calls = []
  return {
    calls,
    repository: {
      create: async ({ data }) => { calls.push(['repository.create', data]); return { id: 'r1', ...data } },
      findFirst: async () => null,
    },
    project: {
      findByName: async ({ guildConfigId, name }) =>
        projects.find((p) => p.guildConfigId === guildConfigId && p.name === name) ?? null,
      findMany: async ({ where }) => projects.filter((p) => where.includeDeleted === true || !p.deletedAt),
      create: async ({ data }) => { calls.push(['project.create', data]); return { id: 'pNew', ...data } },
    },
    projectRepos: {
      findMany: async () => [],
      add: async ({ data }) => { calls.push(['projectRepos.add', data]) },
      setScope: async () => {},
    },
  }
}

function fakeInteraction(guildId) {
  const replies = []
  return {
    replies,
    guild: { id: guildId },
    user: { id: 'u1' },
    editReply: async (payload) => { replies.push(payload); return payload },
  }
}

async function run(guildId, project, projects) {
  flowStore.set('u1', guildId, 'repos_add', { name: 'apollo-api', url: 'https://github.com/g/apollo-api', project })
  const db = fakeDb(projects)
  const it = fakeInteraction(guildId)
  await handleConfirmAdd(it, {
    db,
    getConfig: async () => CFG,
    reattribute: async () => 0,
    checkAccess: async () => ({ ok: true }),
  })
  return { db, text: it.replies.at(-1).embeds[0].data.description }
}

test('/repos add naming a deleted project saves the repository but links nothing, and says the project is deleted', async () => {
  const { db, text } = await run('G-repos-1', 'Apollo', [{ id: 'p9', name: 'Apollo', docsSlug: 'apollo', guildConfigId: 'g1', deletedAt: DELETED_AT }])
  assert.equal(db.calls.filter((c) => c[0] === 'repository.create').length, 1, 'the repository itself is saved')
  assert.deepEqual(db.calls.filter((c) => c[0] === 'projectRepos.add'), [], 'nothing is linked to the deleted project')
  assert.match(text, /This project is deleted\./)
})

test('/repos add does not create a project over a deleted project’s slug', async () => {
  const { db, text } = await run('G-repos-2', 'Apollo', [{ id: 'p9', name: 'Apollo Old', docsSlug: 'apollo', guildConfigId: 'g1', deletedAt: DELETED_AT }])
  assert.deepEqual(db.calls.filter((c) => c[0] === 'project.create'), [])
  assert.deepEqual(db.calls.filter((c) => c[0] === 'projectRepos.add'), [])
  assert.match(text, /A deleted project uses that slug — reactivate it or pick another slug\./)
})

test('/repos add naming a live project still links it', async () => {
  const { db } = await run('G-repos-3', 'Framework', [{ id: 'p1', name: 'Framework', docsSlug: 'framework', guildConfigId: 'g1', deletedAt: null }])
  assert.deepEqual(db.calls.filter((c) => c[0] === 'projectRepos.add'), [['projectRepos.add', { project_id: 'p1', repository_id: 'r1' }]])
})

// Fix round 1 (Task 2 review).
test('/repos add naming a deleted project does not send the operator to Link repo, whose picker hides it', async () => {
  const { text } = await run('G-repos-4', 'Apollo', [{ id: 'p9', name: 'Apollo', docsSlug: 'apollo', guildConfigId: 'g1', deletedAt: DELETED_AT }])
  assert.match(text, /Linking to project \*\*Apollo\*\* did not complete\. This project is deleted\./)
  assert.doesNotMatch(text, /Link repo/)
})

test('/repos add compares the EFFECTIVE slug: a deleted legacy project with a NULL docsSlug still holds slugify(name)', async () => {
  const { db, text } = await run('G-repos-5', 'Apollo', [{ id: 'p9', name: 'Apollo!', docsSlug: null, guildConfigId: 'g1', deletedAt: DELETED_AT }])
  assert.deepEqual(db.calls.filter((c) => c[0] === 'project.create'), [])
  assert.deepEqual(db.calls.filter((c) => c[0] === 'projectRepos.add'), [])
  assert.match(text, /A deleted project uses that slug — reactivate it or pick another slug\./)
})

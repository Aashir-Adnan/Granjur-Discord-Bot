import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listRoots, resolveDocPath, rootByKey } from './docRoots.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const botDocs = path.resolve(here, '..', '..', 'docs')

test('bot root is always present', () => {
  const roots = listRoots()
  assert.ok(roots.find((r) => r.key === 'bot'))
  assert.equal(rootByKey('bot').dir, botDocs)
})

test('ubs root appears only when UBS_DOC_PATH is set to an existing dir', () => {
  delete process.env.UBS_DOC_PATH
  assert.equal(listRoots().find((r) => r.key === 'ubs'), undefined)
  process.env.UBS_DOC_PATH = here // any existing dir
  assert.ok(listRoots().find((r) => r.key === 'ubs'))
  delete process.env.UBS_DOC_PATH
})

test('resolveDocPath blocks traversal and unknown roots', () => {
  assert.equal(resolveDocPath('bot', '../../../etc/passwd'), null)
  assert.equal(resolveDocPath('nope', 'x.md'), null)
  assert.equal(
    resolveDocPath('bot', 'DEMO_WORKFLOW.md') ?? '',
    path.join(botDocs, 'DEMO_WORKFLOW.md'),
  )
})

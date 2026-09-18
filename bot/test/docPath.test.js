import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isDocFile,
  toDocId,
  sectionOf,
  slugify,
  extractTitle,
  attributeProject,
} from '../src/utils/docPath.js'

test('isDocFile accepts md and mdx under docs/', () => {
  assert.equal(isDocFile('docs/api/overview.md'), true)
  assert.equal(isDocFile('docs/intro/Node-Advantages.mdx'), true)
})

test('isDocFile rejects non-docs, non-markdown, and superpowers', () => {
  assert.equal(isDocFile('src/docs/sidebar.ts'), false)
  assert.equal(isDocFile('docs/api/_category_.json'), false)
  assert.equal(isDocFile('docs/intro/Node-Advantages.pdf'), false)
  assert.equal(isDocFile('docs/superpowers/brainstorming/SKILL.md'), false)
  assert.equal(isDocFile('README.md'), false)
})

test('toDocId strips the docs prefix and the extension', () => {
  assert.equal(toDocId('docs/api/overview.md'), 'api/overview')
  assert.equal(
    toDocId('docs/hms-documentation/major-implementations/booking-rules/booking-rules-requirements.md'),
    'hms-documentation/major-implementations/booking-rules/booking-rules-requirements'
  )
  assert.equal(toDocId('docs/init.mdx'), 'init')
})

test('sectionOf returns the first segment under docs/', () => {
  assert.equal(sectionOf('docs/api/overview.md'), 'api')
  assert.equal(sectionOf('docs/init.md'), 'init.md')
})

test('slugify lowercases and hyphenates', () => {
  assert.equal(slugify('Badar HMS'), 'badar-hms')
  assert.equal(slugify('ScholarSpace'), 'scholarspace')
  assert.equal(slugify('  Fit Tour  '), 'fit-tour')
  assert.equal(slugify('C/SAAS'), 'c-saas')
})

test('extractTitle prefers frontmatter title', () => {
  const md = '---\ntitle: Booking Rules\nsidebar_position: 2\n---\n\n# Something else\n'
  assert.equal(extractTitle(md, 'docs/a/b.md'), 'Booking Rules')
})

test('extractTitle falls back to the first heading', () => {
  const md = '---\nsidebar_position: 0\n---\n\n# Standard Issue Resolution Workflow\n\ntext\n'
  assert.equal(extractTitle(md, 'docs/a/b.md'), 'Standard Issue Resolution Workflow')
})

test('extractTitle falls back to a humanized filename', () => {
  assert.equal(extractTitle('no heading here\n', 'docs/a/tenant-seed-data.md'), 'Tenant Seed Data')
  assert.equal(extractTitle('', 'docs/a/OPERA_PMS_Integration.md'), 'OPERA PMS Integration')
})

test('attributeProject matches docs/projects/<docsSlug>/', () => {
  const projects = [{ id: 'p1', docsSlug: 'badar-hms', docsPaths: [] }]
  assert.equal(attributeProject('docs/projects/badar-hms/Opera_Config.md', projects), 'p1')
  assert.equal(attributeProject('docs/projects/other/x.md', projects), null)
})

test('attributeProject matches an extra docsPaths prefix', () => {
  const projects = [{ id: 'p1', docsSlug: 'badar-hms', docsPaths: ['hms-documentation'] }]
  assert.equal(attributeProject('docs/hms-documentation/admin-apis/x.md', projects), 'p1')
  assert.equal(attributeProject('docs/api/overview.md', projects), null)
})

test('attributeProject does not match a partial directory name', () => {
  const projects = [{ id: 'p1', docsSlug: 'hms', docsPaths: [] }]
  assert.equal(attributeProject('docs/projects/hms-other/x.md', projects), null)
})

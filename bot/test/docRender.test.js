import test from 'node:test'
import assert from 'node:assert/strict'
import { renderForDiscord, paginate, docUrl } from '../src/utils/docRender.js'

const SITE = 'https://ubs-doc.vercel.app'

test('docUrl builds a site route from a docId', () => {
  assert.equal(docUrl(SITE, 'api/overview'), 'https://ubs-doc.vercel.app/docs/api/overview')
  assert.equal(docUrl(SITE + '/', 'api/overview'), 'https://ubs-doc.vercel.app/docs/api/overview')
})

test('renderForDiscord strips frontmatter', () => {
  const out = renderForDiscord('---\ntitle: X\n---\n\nBody text\n', { siteUrl: SITE })
  assert.equal(out, 'Body text')
})

test('renderForDiscord converts admonitions to bold + blockquote', () => {
  const md = ':::warning[Heads up]\nDo not do this.\n:::\n'
  const out = renderForDiscord(md, { siteUrl: SITE })
  assert.match(out, /\*\*Heads up\*\*/)
  assert.match(out, /^> Do not do this\./m)
})

test('renderForDiscord labels an untitled admonition with its type', () => {
  const out = renderForDiscord(':::note\nRemember.\n:::\n', { siteUrl: SITE })
  assert.match(out, /\*\*Note\*\*/)
  assert.match(out, /^> Remember\./m)
})

test('renderForDiscord drops MDX imports and bare JSX', () => {
  const md = "import Foo from './Foo'\n\n<Foo bar />\n\nReal text\n"
  const out = renderForDiscord(md, { siteUrl: SITE })
  assert.equal(out.includes('import Foo'), false)
  assert.equal(out.includes('<Foo'), false)
  assert.match(out, /Real text/)
})

test('renderForDiscord rewrites relative doc links to site urls', () => {
  const md = 'See [the other](./other.md) and [up](../api/overview.md).'
  const out = renderForDiscord(md, { siteUrl: SITE, docId: 'backend/tenancy' })
  assert.match(out, /\(https:\/\/ubs-doc\.vercel\.app\/docs\/backend\/other\)/)
  assert.match(out, /\(https:\/\/ubs-doc\.vercel\.app\/docs\/api\/overview\)/)
})

test('renderForDiscord leaves code fences untouched', () => {
  const md = '```js\nconst x = 1 // <Foo />\n```\n'
  const out = renderForDiscord(md, { siteUrl: SITE })
  assert.match(out, /const x = 1 \/\/ <Foo \/>/)
})

test('paginate returns one page when the text fits', () => {
  assert.deepEqual(paginate('short', 100), ['short'])
})

test('paginate splits on paragraph boundaries', () => {
  const text = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].join('\n\n')
  const pages = paginate(text, 90)
  assert.equal(pages.length, 2)
  assert.equal(pages[0].includes('c'.repeat(40)), false)
  assert.ok(pages.every((p) => p.length <= 90))
})

test('paginate never splits inside a code fence', () => {
  const fence = '```js\n' + 'x\n'.repeat(30) + '```'
  const text = 'intro paragraph\n\n' + fence + '\n\ntail paragraph'
  const pages = paginate(text, 60)
  for (const p of pages) {
    const fences = (p.match(/```/g) || []).length
    assert.equal(fences % 2, 0, `unbalanced fence in page: ${JSON.stringify(p)}`)
  }
})

test('paginate hard-splits a single oversized paragraph', () => {
  const pages = paginate('z'.repeat(250), 100)
  assert.equal(pages.length, 3)
  assert.ok(pages.every((p) => p.length <= 100))
})

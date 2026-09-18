import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildExplainEmbed, trimAnswer, referenceLine, MAX_RENDERED_REFERENCES } from './explainRender.js'

const SITE = 'https://ubs-doc.vercel.app'
const titles = { 'hms-documentation/major-implementations/booking-rules/booking-rules-requirements': 'Booking Rules Requirements' }
const lookupTitle = (docId) => titles[docId] ?? null

test('referenceLine links the page title and appends the heading', () => {
  const line = referenceLine(
    { path: 'hms-documentation/major-implementations/booking-rules/booking-rules-requirements.md', heading: 'Cancellation window', quote: 'x' },
    SITE, lookupTitle,
  )
  assert.equal(
    line,
    '📄 [Booking Rules Requirements](https://ubs-doc.vercel.app/docs/hms-documentation/major-implementations/booking-rules/booking-rules-requirements) › Cancellation window',
  )
})

test('referenceLine falls back to the filename when the page is not mirrored', () => {
  const line = referenceLine({ path: 'init.md', heading: '', quote: '' }, SITE, lookupTitle)
  assert.equal(line, '📄 [init](https://ubs-doc.vercel.app/docs/init)')
})

test('referenceLine strips .mdx too and never renders the quote', () => {
  const line = referenceLine({ path: 'intro/start.mdx', heading: '', quote: 'secret' }, SITE, lookupTitle)
  assert.equal(line, '📄 [start](https://ubs-doc.vercel.app/docs/intro/start)')
  assert.ok(!line.includes('secret'))
})

test('trimAnswer leaves short text alone and cuts long text at a paragraph', () => {
  assert.equal(trimAnswer('short', 4000), 'short')
  const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${'x'.repeat(90)}`).join('\n\n')
  const out = trimAnswer(long, 4000)
  assert.ok(out.length <= 4000, `length ${out.length}`)
  assert.ok(out.endsWith('\n\n_…answer trimmed_'), out.slice(-40))
  // cut at a paragraph boundary: the text before the marker ends a paragraph
  const body = out.slice(0, -'\n\n_…answer trimmed_'.length)
  assert.ok(/x{90}$/.test(body), 'cut mid-paragraph')
})

test('trimAnswer hard-cuts when there is no paragraph boundary to use', () => {
  const out = trimAnswer('y'.repeat(5000), 4000)
  assert.ok(out.length <= 4000)
  assert.ok(out.endsWith('_…answer trimmed_'))
})

test('buildExplainEmbed assembles title, description, references and footer', () => {
  const embed = buildExplainEmbed({
    question: 'How does cancellation work?',
    answer: 'Like **this**.',
    references: [{ path: 'init.md', heading: '', quote: '' }],
    scope: 'Badar HMS',
    durationMs: 41250,
    siteUrl: SITE,
  }, lookupTitle).toJSON()
  assert.equal(embed.title, 'How does cancellation work?')
  assert.equal(embed.description, 'Like **this**.')
  assert.equal(embed.fields[0].name, 'References')
  assert.match(embed.fields[0].value, /\[init\]\(https:\/\/ubs-doc\.vercel\.app\/docs\/init\)/)
  assert.equal(embed.footer.text, 'Badar HMS · 41s')
  assert.equal(embed.color, 0x5865f2)
})

test('buildExplainEmbed says so when nothing was cited', () => {
  const embed = buildExplainEmbed({ question: 'q', answer: 'a', references: [], scope: 'All documentation', durationMs: 900, siteUrl: SITE }, lookupTitle).toJSON()
  assert.equal(embed.fields[0].value, '_No specific pages cited._')
  assert.equal(embed.footer.text, 'All documentation · 1s')
})

test('buildExplainEmbed caps references and the title', () => {
  const refs = Array.from({ length: 12 }, (_, i) => ({ path: `p${i}.md`, heading: '', quote: '' }))
  const embed = buildExplainEmbed({ question: 'q'.repeat(300), answer: 'a', references: refs, scope: 's', durationMs: 0, siteUrl: SITE }, lookupTitle).toJSON()
  assert.equal(embed.title.length, 256)
  assert.equal(embed.fields[0].value.split('\n').length, MAX_RENDERED_REFERENCES)
})

test('a single over-long reference line is skipped, not dropping the rest: short, huge, short all considered and both shorts render', () => {
  const refs = [
    { path: 'a.md', heading: '', quote: '' },
    {
      path: `a-very-long-directory-name/${'segment-'.repeat(150)}/huge-file-name.md`,
      heading: 'A heading that is also fairly long to push the line length up past the field cap on its own',
      quote: '',
    },
    { path: 'b.md', heading: '', quote: '' },
  ]
  const embed = buildExplainEmbed({ question: 'q', answer: 'a', references: refs, scope: 's', durationMs: 0, siteUrl: SITE }, lookupTitle).toJSON()
  const lines = embed.fields[0].value.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /\[a\]/)
  assert.match(lines[1], /\[b\]/)
})

test('buildExplainEmbed keeps the references field under the 1024 field cap', () => {
  const refs = Array.from({ length: 8 }, (_, i) => ({
    path: `a-very-long-directory-name-number-${i}/and-another-long-segment/and-a-really-long-file-name-${i}.md`,
    heading: 'A heading that is also fairly long to push the line length up',
    quote: '',
  }))
  const embed = buildExplainEmbed({ question: 'q', answer: 'a', references: refs, scope: 's', durationMs: 0, siteUrl: SITE }, lookupTitle).toJSON()
  assert.ok(embed.fields[0].value.length <= 1024, `field length ${embed.fields[0].value.length}`)
})

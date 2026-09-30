import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DOC_TYPES, MAX_DOC_BYTES, MAX_DOC_CHARS, DocTextError,
  extractDocText, jsonDocText, downloadAttachment,
} from './docText.js'

// No database, Discord or network here: downloads use a fake fetch, and the
// extractors are faked except in the two smoke tests, which only run the
// libraries over bytes built in the test.

const buf = (s) => Buffer.from(s, 'utf8')
const run = (text, fileName, extract) => extractDocText({ buffer: buf(text), fileName, extract })
const fails = (promise, message) => assert.rejects(promise, (e) => e instanceof DocTextError && e.message === message)

test('constants', () => {
  assert.deepEqual(DOC_TYPES, ['.txt', '.md', '.json', '.pdf', '.docx'])
  assert.equal(MAX_DOC_BYTES, 10 * 1024 * 1024)
  assert.equal(MAX_DOC_CHARS, 60_000)
})

test('.txt and .md return trimmed UTF-8 text, case-insensitive, BOM removed', async () => {
  assert.equal((await run('  hello é\n', 'a.txt')).text, 'hello é')
  assert.equal((await run('# Title\n\nBody  \n', 'NOTES.MD')).text, '# Title\n\nBody')
  assert.equal((await run('﻿with bom', 'b.Txt')).text, 'with bom')
  assert.equal((await run('a\r\nb', 'c.txt')).text, 'a\r\nb')
})

test('unknown or missing extension is unsupported', async () => {
  const msg = (f) => `**${f}** is not a supported file. Use .txt, .md, .json, .pdf or .docx.`
  await fails(run('x', 'pic.png'), msg('pic.png'))
  await fails(run('x', 'README'), msg('README'))
})

test('.json transcript shapes', async () => {
  assert.equal((await run(JSON.stringify({ segment_0: { transcription: 'a' }, segment_1: { transcription: 'b' } }), 't.json')).text, 'a\n\nb')
  assert.equal((await run(JSON.stringify([{ text: 'x' }, { content: 'y' }]), 't.json')).text, 'x\n\ny')
  const plain = { name: 'n', n: 1 }
  assert.equal((await run(JSON.stringify(plain), 't.json')).text, JSON.stringify(plain, null, 2))
  assert.equal((await run('﻿{"text":"ok"}', 't.json')).text, 'ok')
  await fails(run('{not json', 't.json'), '**t.json** could not be read.')
})

test('.pdf and .docx go through the extractors', async () => {
  const extract = { pdf: async () => ' pdf text ', docx: async () => 'docx text' }
  assert.equal((await run('x', 'a.pdf', extract)).text, 'pdf text')
  assert.equal((await run('x', 'a.docx', extract)).text, 'docx text')

  const boom = { pdf: async () => { throw new Error('bad') }, docx: () => { throw new Error('bad') } }
  await fails(run('x', 'a.pdf', boom), '**a.pdf** could not be read.')
  await fails(run('x', 'a.docx', boom), '**a.docx** could not be read.')

  const blank = { pdf: async () => '   ', docx: async () => '   ' }
  await fails(run('x', 'a.pdf', blank), '**a.pdf** has no readable text — a scanned PDF has none.')
  await fails(run('x', 'a.docx', blank), '**a.docx** has no readable text.')
})

test('character cap and empty text', async () => {
  assert.equal((await run('a'.repeat(60_000), 'a.txt')).chars, 60_000)
  await fails(run('a'.repeat(60_001), 'a.txt'), '**a.txt** has more than 60,000 characters of text. Split it into smaller files.')
  await fails(run('', 'a.txt'), '**a.txt** has no readable text.')
  await fails(run('  \n ', 'a.md'), '**a.md** has no readable text.')
})

test('a buffer over the byte cap is refused', async () => {
  const buffer = Buffer.alloc(MAX_DOC_BYTES + 1, 97)
  await fails(extractDocText({ buffer, fileName: 'big.txt' }), '**big.txt** is larger than 10 MB.')
})

test('chars equals the text length', async () => {
  const r = await run('  héllo wörld  ', 'a.txt')
  assert.equal(r.chars, r.text.length)
})

test('jsonDocText walks depth-first in insertion order and ignores non-strings', () => {
  assert.equal(jsonDocText([[{ text: 'a' }, [{ content: 'b' }]], { transcription: 'c' }]), 'a\n\nb\n\nc')
  assert.equal(jsonDocText({ z: { text: '1' }, a: { text: '2' } }), '1\n\n2')
  assert.equal(jsonDocText({ text: 5, inner: { text: 'kept', content: null } }), 'kept')
  assert.equal(jsonDocText({ text: 5 }), JSON.stringify({ text: 5 }, null, 2))
  assert.equal(jsonDocText('plain'), '"plain"')
})

test('downloadAttachment', async () => {
  let called = 0
  const spy = async () => { called++; return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } }
  await fails(
    downloadAttachment({ name: 'big.pdf', url: 'u', size: MAX_DOC_BYTES + 1 }, { fetchImpl: spy }),
    '**big.pdf** is larger than 10 MB.',
  )
  assert.equal(called, 0)

  await fails(
    downloadAttachment({ name: 'a.txt', url: 'u' }, { fetchImpl: async () => ({ ok: false, status: 404 }) }),
    '**a.txt** could not be downloaded.',
  )
  await fails(
    downloadAttachment({ name: 'a.txt', url: 'u' }, { fetchImpl: async () => { throw new Error('net') } }),
    '**a.txt** could not be downloaded.',
  )

  let asked
  const bytes = new Uint8Array([104, 105])
  const out = await downloadAttachment(
    { name: 'a.txt', url: 'https://cdn/x', size: 2 },
    { fetchImpl: async (url) => { asked = url; return { ok: true, arrayBuffer: async () => bytes.buffer } } },
  )
  assert.equal(asked, 'https://cdn/x')
  assert.ok(Buffer.isBuffer(out))
  assert.equal(out.toString(), 'hi')
})

// ---- smoke tests: the real libraries over bytes built here ----

function minimalPdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) {
    let c = (crc ^ byte) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

// A zip with stored (uncompressed) entries.
function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const n = Buffer.from(name)
    const d = Buffer.from(content)
    const crc = crc32(d)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(n.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42)
    locals.push(lh, n, d)
    centrals.push(ch, n)
    offset += 30 + n.length + d.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  const count = centrals.length / 2
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

function minimalDocx(text) {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  })
}

test('smoke: the real unpdf reads a minimal PDF', async () => {
  const r = await extractDocText({ buffer: minimalPdf('Hello from a PDF'), fileName: 'mini.pdf' })
  assert.match(r.text, /Hello from a PDF/)
})

test('smoke: the real mammoth reads a minimal .docx', async () => {
  const r = await extractDocText({ buffer: minimalDocx('Hello from a docx'), fileName: 'mini.docx' })
  assert.match(r.text, /Hello from a docx/)
})

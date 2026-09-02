/**
 * Markdown -> Discord-embed text, plus paging.
 *
 * The transformations mirror what the UBS-Doc site does at build time
 * (remarkAdmonitions.ts, remarkDocLinks.ts) so a doc reads the same in
 * both places. Tables and images are left as raw markdown on purpose:
 * Discord will not render them, which is what the "Read full page"
 * button on the embed is for.
 */

const ADMONITION_TYPES = ['note', 'tip', 'info', 'warning', 'caution', 'danger']

/** Build the published URL for a doc id. */
export function docUrl(siteUrl, docId) {
  return `${String(siteUrl || '').replace(/\/+$/, '')}/docs/${docId}`
}

function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? text.slice(m[0].length) : text
}

/** Split into alternating prose / fenced-code segments so we never edit code. */
function splitFences(text) {
  const parts = []
  const re = /```[\s\S]*?(?:```|$)/g
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ code: false, text: text.slice(last, m.index) })
    parts.push({ code: true, text: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) })
  return parts
}

function convertAdmonitions(text) {
  const open = new RegExp(`^:::(${ADMONITION_TYPES.join('|')})(?:\\[(.*?)\\])?\\s*$`, 'i')
  const lines = text.split('\n')
  const out = []
  let inside = false
  for (const line of lines) {
    const m = line.match(open)
    if (m && !inside) {
      inside = true
      const type = m[1].toLowerCase()
      const label = m[2] || type.charAt(0).toUpperCase() + type.slice(1)
      out.push(`**${label}**`)
      continue
    }
    if (inside && /^:::\s*$/.test(line)) {
      inside = false
      continue
    }
    out.push(inside ? `> ${line}` : line)
  }
  return out.join('\n')
}

function stripMdx(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*(import|export)\s+/.test(l))
    .join('\n')
    .replace(/<\/?[A-Z][A-Za-z0-9]*(?:\s[^>]*)?\/?>/g, '')
}

function rewriteLinks(text, siteUrl, docId) {
  const baseDir = docId && docId.includes('/') ? docId.slice(0, docId.lastIndexOf('/')) : ''
  return text.replace(/\]\((\.\.?\/[^)\s]+?)\.mdx?\)/g, (_full, rel) => {
    const segments = `${baseDir}/${rel}`.split('/')
    const stack = []
    for (const s of segments) {
      if (s === '' || s === '.') continue
      if (s === '..') stack.pop()
      else stack.push(s)
    }
    return `](${docUrl(siteUrl, stack.join('/'))})`
  })
}

/** Full markdown -> Discord text pipeline. */
export function renderForDiscord(markdown, { siteUrl = '', docId = '' } = {}) {
  const body = stripFrontmatter(String(markdown || ''))
  const rendered = splitFences(body)
    .map((part) => {
      if (part.code) return part.text
      let t = convertAdmonitions(part.text)
      t = stripMdx(t)
      t = rewriteLinks(t, siteUrl, docId)
      return t
    })
    .join('')
  return rendered.replace(/\n{3,}/g, '\n\n').trim()
}

function hardSplit(chunk, max) {
  const out = []
  let rest = chunk
  while (rest.length > max) {
    out.push(rest.slice(0, max))
    rest = rest.slice(max)
  }
  if (rest.length) out.push(rest)
  return out
}

/**
 * Split an oversized code block into several complete, individually fenced
 * blocks, so no page ever carries an unbalanced ``` marker.
 */
function splitCodeBlock(block, max) {
  const lines = block.split('\n')
  const opener = lines[0].startsWith('```') ? lines[0] : '```'
  const closed = lines[lines.length - 1].trim() === '```'
  const inner = lines.slice(1, closed ? -1 : undefined)
  const wrap = (arr) => [opener, ...arr, '```'].join('\n')

  const availableRoom = max - opener.length - 5

  const pieces = []
  let buf = []
  for (const line of inner) {
    if (buf.length && wrap([...buf, line]).length > max) {
      pieces.push(wrap(buf))
      buf = [line]
    } else {
      buf.push(line)
    }
  }
  if (buf.length) pieces.push(wrap(buf))
  // Handle oversized pieces by splitting inner content and re-wrapping
  return pieces.flatMap((p) => {
    if (p.length <= max) return [p]
    // Degenerate case: max is too small for fence overhead
    if (availableRoom <= 0) return hardSplit(p, max)
    // Extract inner content, split it, and re-wrap each chunk
    const pLines = p.split('\n')
    const pInner = pLines.slice(1, -1).join('\n')
    const innerParts = hardSplit(pInner, availableRoom)
    return innerParts.map(part => [opener, part, '```'].join('\n'))
  })
}

/**
 * Split rendered text into pages of at most `max` characters, breaking on
 * paragraph boundaries. A fenced code block stays whole unless it alone
 * exceeds `max`, in which case it is split into several complete fenced
 * blocks rather than being cut mid-fence.
 */
export function paginate(text, max = 3800) {
  const blocks = []
  for (const part of splitFences(String(text || ''))) {
    if (part.code) blocks.push({ text: part.text, code: true })
    else for (const p of part.text.split(/\n{2,}/)) if (p.trim()) blocks.push({ text: p.trim(), code: false })
  }

  const pages = []
  let current = ''
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block.text}` : block.text
    if (candidate.length <= max) {
      current = candidate
      continue
    }
    if (current) {
      pages.push(current)
      current = ''
    }
    if (block.text.length <= max) {
      current = block.text
      continue
    }
    const pieces = block.code ? splitCodeBlock(block.text, max) : hardSplit(block.text, max)
    pages.push(...pieces.slice(0, -1))
    current = pieces[pieces.length - 1]
  }
  if (current) pages.push(current)
  return pages.length ? pages : ['']
}

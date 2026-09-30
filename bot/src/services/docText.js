// Reads plain text out of a document a person attached in Discord.
// Pure apart from the download: every refusal is a DocTextError whose message is
// the sentence shown to the user.

export const DOC_TYPES = ['.txt', '.md', '.json', '.pdf', '.docx']
export const MAX_DOC_BYTES = 10 * 1024 * 1024
export const MAX_DOC_CHARS = 60_000

export class DocTextError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DocTextError'
  }
}

export const defaultExtractors = {
  pdf: async (buffer) => {
    const { extractText } = await import('unpdf')
    const { text } = await extractText(new Uint8Array(buffer), { mergePages: true })
    return text
  },
  docx: async (buffer) => {
    const mammoth = (await import('mammoth')).default
    const { value } = await mammoth.extractRawText({ buffer })
    return value
  },
}

const TEXT_KEYS = new Set(['transcription', 'text', 'content'])

function collectTextFields(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectTextFields(item, out)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (TEXT_KEYS.has(key) && typeof item === 'string') out.push(item)
      else collectTextFields(item, out)
    }
  }
}

export function jsonDocText(value) {
  const found = []
  collectTextFields(value, found)
  return found.length ? found.join('\n\n') : JSON.stringify(value, null, 2)
}

function extensionOf(fileName) {
  const dot = String(fileName ?? '').lastIndexOf('.')
  return dot < 0 ? '' : fileName.slice(dot).toLowerCase()
}

export async function extractDocText({ buffer, fileName, extract = defaultExtractors }) {
  const ext = extensionOf(fileName)
  if (!DOC_TYPES.includes(ext)) {
    throw new DocTextError(`**${fileName}** is not a supported file. Use .txt, .md, .json, .pdf or .docx.`)
  }
  if (buffer.length > MAX_DOC_BYTES) {
    throw new DocTextError(`**${fileName}** is larger than 10 MB.`)
  }

  let raw
  try {
    if (ext === '.pdf') raw = await extract.pdf(buffer)
    else if (ext === '.docx') raw = await extract.docx(buffer)
    else {
      const decoded = buffer.toString('utf8').replace(/^﻿/, '')
      raw = ext === '.json' ? jsonDocText(JSON.parse(decoded)) : decoded
    }
  } catch {
    throw new DocTextError(`**${fileName}** could not be read.`)
  }

  const text = String(raw ?? '').replace(/^\uFEFF/, '').trim()
  if (!text) {
    throw new DocTextError(ext === '.pdf'
      ? `**${fileName}** has no readable text — a scanned PDF has none.`
      : `**${fileName}** has no readable text.`)
  }
  if (text.length > MAX_DOC_CHARS) {
    throw new DocTextError(`**${fileName}** has more than 60,000 characters of text. Split it into smaller files.`)
  }
  return { text, chars: text.length }
}

export async function downloadAttachment(attachment, { fetchImpl = fetch } = {}) {
  const name = attachment.name
  if (attachment.size > MAX_DOC_BYTES) {
    throw new DocTextError(`**${name}** is larger than 10 MB.`)
  }
  try {
    const res = await fetchImpl(attachment.url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  } catch {
    throw new DocTextError(`**${name}** could not be downloaded.`)
  }
}

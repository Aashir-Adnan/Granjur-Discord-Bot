// Pure builders for the /explain reply. No Discord calls, no database — the
// page-title lookup is injected so this file is testable on its own.
import { EmbedBuilder } from 'discord.js'
import { docUrl } from '../utils/docRender.js'

export const MAX_RENDERED_REFERENCES = 8
const TITLE_MAX = 256
const DESCRIPTION_MAX = 4000
const FIELD_MAX = 1024
const TRIM_MARK = '\n\n_…answer trimmed_'

/** A reference path -> the docId /docs uses (no extension, no leading ./). */
export function refDocId(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\.mdx?$/i, '')
}

/** One line: 📄 [Title](url) › heading. The quote is deliberately not rendered. */
export function referenceLine(ref, siteUrl, lookupTitle) {
  const docId = refDocId(ref.path)
  const title = lookupTitle(docId) || docId.split('/').pop() || docId
  const heading = String(ref.heading || '').trim()
  return `📄 [${title}](${docUrl(siteUrl, docId)})${heading ? ` › ${heading}` : ''}`
}

/**
 * Cap the answer at `max`, cutting at the last paragraph break before the
 * limit so a sentence is not sliced in half. Falls back to a hard cut when the
 * text has no paragraph break early enough.
 */
export function trimAnswer(text, max = DESCRIPTION_MAX) {
  const s = String(text || '')
  if (s.length <= max) return s
  const room = max - TRIM_MARK.length
  const cut = s.lastIndexOf('\n\n', room)
  const body = cut > room / 2 ? s.slice(0, cut) : s.slice(0, room)
  return body + TRIM_MARK
}

function referencesField(references, siteUrl, lookupTitle) {
  const refs = (Array.isArray(references) ? references : []).slice(0, MAX_RENDERED_REFERENCES)
  if (refs.length === 0) return '_No specific pages cited._'
  const lines = []
  let used = 0
  for (const r of refs) {
    const line = referenceLine(r, siteUrl, lookupTitle)
    // A single over-long line is dropped rather than truncated (a truncated
    // markdown link is a broken link) — but skip past it, don't stop: a later,
    // shorter reference must still get a chance to render.
    if (used + line.length + 1 > FIELD_MAX) continue
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n') || '_No specific pages cited._'
}

/**
 * @param {{question:string, answer:string, references:object[], scope:string, durationMs:number, siteUrl:string}} r
 * @param {(docId:string)=>string|null} lookupTitle
 */
export function buildExplainEmbed(r, lookupTitle) {
  const seconds = Math.round((Number(r.durationMs) || 0) / 1000)
  return new EmbedBuilder()
    .setTitle(String(r.question || 'Question').slice(0, TITLE_MAX))
    .setDescription(trimAnswer(r.answer, DESCRIPTION_MAX) || '_No answer._')
    .addFields({ name: 'References', value: referencesField(r.references, r.siteUrl, lookupTitle), inline: false })
    .setFooter({ text: `${r.scope || 'All documentation'} · ${seconds}s` })
    .setColor(0x5865f2)
}

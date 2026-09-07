/**
 * The live meeting transcript feed.
 *
 * Speech-to-text results come back out of order, so nothing is posted until the
 * turns ahead of it have landed: the feed only ever releases a contiguous run
 * starting at its cursor. A turn that never comes back is dropped after
 * STALL_MS so one slow call cannot freeze the feed behind it.
 *
 * This half is pure and fully tested. The live object lives in Task 5.
 */

export const FLUSH_INTERVAL_MS = 6000
export const STALL_MS = 25000
export const GROUP_WINDOW_MS = 60000
export const MAX_MESSAGE_CHARS = 1800
export const MAX_CONCURRENT_STT = 3

const renderable = (e) => e.status === 'done' && String(e.text || '').trim() !== ''

/**
 * Release the longest contiguous run of consumable turns from `nextSeq`.
 * A turn is consumable when it has come back (done or failed) or has been
 * pending longer than `stallMs`. Only `done` turns with text are rendered;
 * the rest are consumed silently so the cursor keeps moving. Sequences are
 * guaranteed contiguous by the caller (a number is only assigned once a turn
 * passes the minimum-duration gate), so a missing entry at the cursor means
 * "not yet arrived", not a permanent hole — takeReady stops there and waits.
 */
export function takeReady(pending, nextSeq, now, stallMs = STALL_MS) {
  const ready = []
  let next = nextSeq
  for (;;) {
    const e = pending.get(next)
    if (!e) break
    const settled = e.status === 'done' || e.status === 'failed'
    const stalled = e.status === 'pending' && now - e.enqueuedAt >= stallMs
    if (!settled && !stalled) break
    if (renderable(e)) ready.push(e)
    next += 1
  }
  return { ready, next }
}

/** Consecutive turns by one speaker, close together in time, become one block. */
export function groupUtterances(entries, windowMs = GROUP_WINDOW_MS) {
  const blocks = []
  for (const e of entries) {
    const last = blocks[blocks.length - 1]
    const gap = last ? new Date(e.startedAt) - new Date(last.lastAt) : Infinity
    if (last && last.speakerRef === e.speakerRef && gap <= windowMs) {
      last.texts.push(String(e.text).trim())
      last.lastAt = e.startedAt
    } else {
      blocks.push({
        speakerRef: e.speakerRef,
        speakerName: e.speakerName || 'Unknown speaker',
        startedAt: e.startedAt,
        lastAt: e.startedAt,
        texts: [String(e.text).trim()],
      })
    }
  }
  return blocks
}

const header = (b) =>
  `**${b.speakerName}** · <t:${Math.floor(new Date(b.startedAt).getTime() / 1000)}:t>`

// Discord renders "> " as a quote; speech containing newlines has to quote each
// line or the block breaks halfway through.
const quote = (text) => text.split('\n').map((l) => `> ${l}`).join('\n')

/**
 * Render blocks into message bodies that each fit within `maxChars`.
 *
 * A block that fits in one message (header + quoted text) is packed together
 * with its neighbors, separated by a blank line, the way a chat log reads
 * naturally. A block too long on its own cannot be packed at all: it is cut
 * into plain, contiguous character slices of its quoted body, each becoming
 * its own message with the header repeated. Because the slices are a straight
 * left-to-right partition of one string — no line reshuffling, no chunk
 * reused — concatenating them back in order reproduces the quoted body
 * exactly once, with nothing duplicated and nothing dropped.
 */
export function renderBlocks(blocks, maxChars = MAX_MESSAGE_CHARS) {
  const messages = []
  let current = ''

  const flush = () => {
    if (current) {
      messages.push(current)
      current = ''
    }
  }

  const appendPart = (part) => {
    if (!current) current = part
    else if (current.length + 2 + part.length <= maxChars) current += `\n\n${part}`
    else {
      flush()
      current = part
    }
  }

  for (const b of blocks) {
    const head = header(b)
    const body = quote(b.texts.join('\n'))
    const whole = `${head}\n${body}`

    if (whole.length <= maxChars) {
      appendPart(whole)
      continue
    }

    // The block alone exceeds the cap: split the quoted body into raw,
    // non-overlapping character slices sized to leave room for a repeated
    // header, and give each slice its own message. Each split part stands
    // alone (not packed with neighboring blocks) so the slicing math stays
    // exact — no interaction with appendPart's own wrapping logic.
    flush()
    const budget = Math.max(1, maxChars - head.length - 1)
    for (let i = 0; i < body.length; i += budget) {
      messages.push(`${head}\n${body.slice(i, i + budget)}`)
    }
  }

  flush()
  return messages
}

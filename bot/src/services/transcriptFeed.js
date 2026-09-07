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

const CONSENT_NOTICE =
  '🎙️ **This meeting is being recorded and transcribed.** ' +
  'Everything said in the voice channel will appear in this channel as text.'

const DEGRADE_AFTER_FAILURES = 3

/**
 * The live feed. One per meeting.
 *
 * `push` is called from the voice capture loop for every accepted utterance and
 * returns immediately — the speech-to-text call runs in the background, at most
 * MAX_CONCURRENT_STT at a time. `flushOnce` posts whatever is releasable.
 */
export function createTranscriptFeed({
  db, csaasClient, channel, guildConfigId, meetingId, csaasMeetingId,
  logger = console,
}) {
  const pending = new Map()
  let sequence = 0
  let next = 1
  let flushed = 0
  let inFlight = 0
  let consecutiveFailures = 0
  let degraded = false
  let disabled = false
  let stopped = false
  let timer = null
  const queue = []
  const waiters = []

  const settle = () => {
    if (inFlight === 0 && queue.length === 0) {
      while (waiters.length) waiters.shift()()
    }
  }

  const pump = () => {
    while (inFlight < MAX_CONCURRENT_STT && queue.length) {
      const entry = queue.shift()
      inFlight += 1
      csaasClient
        .transcribeUtterance(csaasMeetingId, {
          buffer: entry.buffer,
          filename: `utterance-${entry.sequence}.ogg`,
          speakerRef: entry.speakerRef,
          speakerName: entry.speakerName,
          startedAt: entry.startedAt,
          sequence: entry.sequence,
          durationMs: entry.durationMs,
        })
        .then(async ({ text }) => {
          consecutiveFailures = 0
          entry.text = text
          entry.status = 'done'
          entry.buffer = null // release the audio as soon as it is transcribed
          try {
            await db.meetingUtterance.create({
              data: {
                guildConfigId, meetingId,
                sequence: entry.sequence,
                speakerRef: entry.speakerRef,
                speakerName: entry.speakerName,
                startedAt: entry.startedAt,
                durationMs: entry.durationMs,
                text,
              },
            })
          } catch (e) {
            logger.warn?.(`[transcriptFeed] persist failed for seq ${entry.sequence}: ${e?.message || e}`)
          }
        })
        .catch((e) => {
          entry.status = 'failed'
          entry.buffer = null
          consecutiveFailures += 1
          logger.warn?.(`[transcriptFeed] stt failed for seq ${entry.sequence}: ${e?.message || e}`)
          if (consecutiveFailures >= DEGRADE_AFTER_FAILURES) degraded = true
        })
        .finally(() => { inFlight -= 1; settle(); pump() })
    }
    settle()
  }

  const send = async (body) => {
    if (disabled) return false
    try {
      await channel.send({ content: body, allowedMentions: { parse: [] } })
      return true
    } catch (e) {
      // The channel is gone (or the bot lost access). Stop trying every 6 s.
      disabled = true
      logger.warn?.(`[transcriptFeed] channel send failed, disabling feed: ${e?.message || e}`)
      return false
    }
  }

  let warnedDegraded = false

  return {
    push({ speakerRef, speakerName, startedAt, durationMs, buffer }) {
      if (stopped || degraded || disabled) return null
      sequence += 1
      const entry = {
        sequence, speakerRef, speakerName, startedAt, durationMs, buffer,
        text: '', status: 'pending', enqueuedAt: Date.now(),
      }
      pending.set(sequence, entry)
      queue.push(entry)
      pump()
      return sequence
    },

    /** Resolves when every queued speech-to-text call has settled. */
    drain() {
      if (inFlight === 0 && queue.length === 0) return Promise.resolve()
      return new Promise((resolve) => waiters.push(resolve))
    },

    async flushOnce(now = Date.now()) {
      if (disabled) return 0
      if (degraded && !warnedDegraded) {
        warnedDegraded = true
        await send('⚠️ Live transcription is **unavailable** for the rest of this meeting. Recording continues, and the meeting will still be analysed afterwards.')
      }
      const { ready, next: cursor } = takeReady(pending, next, now, STALL_MS)
      for (let s = next; s < cursor; s++) pending.delete(s)
      next = cursor
      if (ready.length === 0) return 0
      const messages = renderBlocks(groupUtterances(ready, GROUP_WINDOW_MS), MAX_MESSAGE_CHARS)
      let sent = 0
      for (const body of messages) {
        if (await send(body)) { sent += 1; flushed += 1 }
      }
      return sent
    },

    async start({ interval = true } = {}) {
      await send(CONSENT_NOTICE)
      if (interval && !timer) {
        timer = setInterval(() => {
          this.flushOnce().catch((e) => logger.warn?.(`[transcriptFeed] flush failed: ${e?.message || e}`))
        }, FLUSH_INTERVAL_MS)
        timer.unref?.()
      }
    },

    async stop() {
      stopped = true
      if (timer) { clearInterval(timer); timer = null }
      await this.drain()
      // Everything settled, so release whatever is left regardless of the stall window.
      await this.flushOnce(Date.now() + STALL_MS + 1)
    },

    stats() { return { sequence, flushed, degraded, disabled } },
  }
}

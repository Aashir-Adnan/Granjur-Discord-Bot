/**
 * Turn the bot's stored utterances into the `meeting_notes` structure that
 * CSAAS `analyze-live` consumes (see analyzeLive in meetingWorkflow.js).
 *
 * Segments are five-minute buckets measured from the first turn, which gives
 * the analysis agent the time structure it expects without the bot needing to
 * know when the meeting nominally started.
 */

export const SEGMENT_MS = 5 * 60 * 1000

const mmss = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function buildAnalyzeLivePayload(utterances) {
  const usable = (utterances || [])
    .filter((u) => String(u.text || '').trim() !== '')
    .slice()
    .sort((a, b) => a.sequence - b.sequence)

  if (usable.length === 0) return { meetingNotes: {}, totalDurationSec: 0 }

  const base = new Date(usable[0].startedAt).getTime()
  const buckets = new Map()
  let endMs = 0

  for (const u of usable) {
    const offset = Math.max(0, new Date(u.startedAt).getTime() - base)
    endMs = Math.max(endMs, offset + (Number(u.durationMs) || 0))
    const index = Math.floor(offset / SEGMENT_MS)
    if (!buckets.has(index)) buckets.set(index, [])
    buckets.get(index).push(`${u.speakerName || 'Unknown speaker'}: ${String(u.text).trim()}`)
  }

  const meetingNotes = {}
  for (const index of [...buckets.keys()].sort((a, b) => a - b)) {
    meetingNotes[`segment_${index}`] = {
      time_range: `${mmss(index * SEGMENT_MS)}-${mmss((index + 1) * SEGMENT_MS)}`,
      transcription: buckets.get(index).join('\n'),
    }
  }

  return { meetingNotes, totalDurationSec: Math.round(endMs / 1000) }
}

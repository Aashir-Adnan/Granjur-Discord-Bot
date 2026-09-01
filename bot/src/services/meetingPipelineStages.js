// Stage runners are filled in Tasks 9-16. Each: async ({ job, db, client, csaasClient })
//   -> { patch?, advance?: boolean (default true), block?: boolean }
// - patch:   shallow-merged into the job row on success
// - advance: when false, the job stays on the same stage (e.g. polling)
// - block:   when true, status becomes 'blocked' instead of 'pending'/'done'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getGuildConfigById } from '../Database/index.js'
import { buildRoster } from './meetingRoster.js'
import { deriveMeetingName, formatMeetingDate } from '../commands/playback.js'
import { initReviewState, buildReviewMessage } from './meetingReviewUI.js'

async function guildIdFor(guildConfigId) {
  const cfg = await getGuildConfigById(guildConfigId)
  if (!cfg?.guildId) throw new Error('created stage: no guildConfig for ' + guildConfigId)
  return cfg.guildId
}

// created: create the CSaaS meeting, snapshot the roster and title onto the job.
async function createdStage({ job, db, csaasClient, client }) {
  const meeting = await db.meeting.findUnique({ where: { id: job.meetingId } })
  const recs = await db.meetingRecording.findMany({ where: { meetingId: job.meetingId } })

  const guildId = await guildIdFor(job.guildConfigId)
  const guild = await client.guilds.fetch(guildId)
  const roster = await buildRoster({
    guild,
    guildConfigId: job.guildConfigId,
    meetingId: job.meetingId,
    db,
  })

  const title =
    deriveMeetingName(recs[0]?.filePath, job.meetingId) +
    ' — ' +
    formatMeetingDate(recs[0]?.startedAt || meeting?.createdAt)

  const { meeting_id } = await csaasClient.createMeeting({
    title,
    participants: roster.map((r) => r.displayName),
  })

  return {
    patch: {
      csaasMeetingId: meeting_id,
      dataJson: { ...(job.dataJson || {}), title, roster, uploaded: [] },
    },
  }
}

// transcribing: idempotent per-speaker segment upload to CSaaS.
// One successful upload per tick (advance:false) so each upload is short and
// independently retryable; advances only once every rec is uploaded-or-missing.
async function transcribingStage({ job, db, csaasClient }) {
  const recs = (await db.meetingRecording.findMany({ where: { meetingId: job.meetingId } }))
    .slice()
    .sort((a, b) => new Date(a.startedAt || 0) - new Date(b.startedAt || 0))

  const data = { uploaded: [], missing: [], ...(job.dataJson || {}) }
  data.uploaded = [...(data.uploaded || [])]
  data.missing = [...(data.missing || [])]
  const done = new Set(data.uploaded)

  for (const rec of recs) {
    if (done.has(rec.id) || data.missing.includes(rec.id)) continue

    // missing files do not consume a CSAAS segment index — first successful upload is always index 0 (overwrite)
    const index = data.uploaded.length
    let buffer
    try {
      buffer = await fs.readFile(rec.filePath)
    } catch {
      // note: a rec id in `missing` is terminal — not retried on later ticks
      data.missing.push(rec.id)
      continue
    }

    const label = (rec.fileName || `speaker-${index}`).replace(/\.ogg$/i, '')
    await csaasClient.transcribeSegment(job.csaasMeetingId, {
      buffer,
      filename: `${label}.ogg`,
      segmentIndex: index,
    })
    data.uploaded.push(rec.id)
    done.add(rec.id)
    return { advance: false, patch: { dataJson: data } }
  }

  if (data.uploaded.length === 0) {
    throw new Error('all meeting recording files missing on disk')
  }
  return { patch: { dataJson: data } }
}

// analyzing: one CSaaS call, store the analysis blob on dataJson.
async function analyzingStage({ job, csaasClient }) {
  const { analysis } = await csaasClient.analyze(job.csaasMeetingId)
  return { patch: { dataJson: { ...(job.dataJson || {}), analysis } } }
}

// generating_tasks: one CSaaS call, store the generated task list on dataJson.
async function generatingTasksStage({ job, csaasClient }) {
  const res = await csaasClient.generateTasks(job.csaasMeetingId)
  return { patch: { dataJson: { ...(job.dataJson || {}), tasks: res.tasks || [] } } }
}

// assigning: one CSaaS call using the roster snapshot; store assignments.
// Advances normally — the awaiting_review runner (Task 13) posts the UI and blocks.
async function assigningStage({ job, csaasClient }) {
  const roster = (job.dataJson && job.dataJson.roster) || []
  const { assignments } = await csaasClient.assign(job.csaasMeetingId, roster)
  return { patch: { dataJson: { ...(job.dataJson || {}), assignments: assignments || [] } } }
}

// Resolve the Discord channel to post the meeting review UI into.
// Preference: dedicated meeting text channel -> the voice channel's own id.
// Returns the fetched channel object, or null when nothing resolves/sends.
// Extracted for reuse (Task 17).
export async function resolveMeetingChannel(client, db, job) {
  const meeting = await db.meeting.findUnique({ where: { id: job.meetingId } })
  const candidates = []

  try {
    const mc = await db.meetingChannel.findFirst({
      where: { guildConfigId: job.guildConfigId, voiceChannelId: meeting?.channelId },
    })
    if (mc?.textChannelId) candidates.push(mc.textChannelId)
  } catch (e) {
    console.warn('[meetingPipeline] meetingChannel lookup failed:', e?.message || e)
  }
  if (meeting?.channelId) candidates.push(meeting.channelId)

  for (const id of candidates) {
    try {
      const channel = await client.channels.fetch(id)
      if (channel && typeof channel.send === 'function') return channel
    } catch (e) {
      console.warn(`[meetingPipeline] channel fetch failed for ${id}:`, e?.message || e)
    }
  }
  return null
}

// awaiting_review: fetch notes, write the HTML report to disk (best-effort),
// post the Discord review UI, and block the job for human review.
async function awaitingReviewStage({ job, db, client, csaasClient }) {
  const data = { ...(job.dataJson || {}) }
  const tasks = data.tasks || []
  const assignments = data.assignments || []
  const roster = data.roster || []

  const { notes, html } = await csaasClient.fetchNotes(job.csaasMeetingId)

  let reportPath = null
  if (html) {
    try {
      const dir = process.env.MEETING_REPORTS_DIR || 'bot/meeting-reports'
      await fs.mkdir(dir, { recursive: true })
      const file = path.resolve(dir, `${job.meetingId}.html`)
      await fs.writeFile(file, html)
      reportPath = file
    } catch (e) {
      console.warn('[meetingPipeline] failed to write meeting report:', e?.message || e)
      reportPath = null
    }
  }

  const state = initReviewState(tasks, assignments)
  data.notes = notes ?? null
  data.review = state

  const patch = { dataJson: data }

  const channel = await resolveMeetingChannel(client, db, job)
  if (channel) {
    try {
      const payload = buildReviewMessage({ job: { ...job, dataJson: data }, notes, reportPath, state, roster })
      const msg = await channel.send(payload)
      patch.reviewMessageId = msg.id
    } catch (e) {
      console.warn('[meetingPipeline] failed to post review message:', e?.message || e)
    }
  } else {
    console.warn(`[meetingPipeline] no channel resolved for meeting ${job.meetingId}; /meeting-review can re-post`)
  }

  return { block: true, patch }
}

// APPEND one key per task; never delete a sibling key.
export const stageRunners = {
  created: createdStage,
  transcribing: transcribingStage,
  analyzing: analyzingStage,
  generating_tasks: generatingTasksStage,
  assigning: assigningStage,
  awaiting_review: awaitingReviewStage,
}

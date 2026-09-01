// Stage runners are filled in Tasks 9-16. Each: async ({ job, db, client, csaasClient })
//   -> { patch?, advance?: boolean (default true), block?: boolean }
// - patch:   shallow-merged into the job row on success
// - advance: when false, the job stays on the same stage (e.g. polling)
// - block:   when true, status becomes 'blocked' instead of 'pending'/'done'
import fs from 'node:fs/promises'
import { getGuildConfigById } from '../Database/index.js'
import { buildRoster } from './meetingRoster.js'
import { deriveMeetingName, formatMeetingDate } from '../commands/playback.js'

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

// APPEND one key per task; never delete a sibling key.
export const stageRunners = {
  created: createdStage,
  transcribing: transcribingStage,
  analyzing: analyzingStage,
  generating_tasks: generatingTasksStage,
  assigning: assigningStage,
}

// Stage runners are filled in Tasks 9-16. Each: async ({ job, db, client, csaasClient })
//   -> { patch?, advance?: boolean (default true), block?: boolean }
// - patch:   shallow-merged into the job row on success
// - advance: when false, the job stays on the same stage (e.g. polling)
// - block:   when true, status becomes 'blocked' instead of 'pending'/'done'
import fs from 'node:fs/promises'
import path from 'node:path'
import { EmbedBuilder } from 'discord.js'
import { getGuildConfigById } from '../Database/index.js'
import { buildRoster } from './meetingRoster.js'
import { deriveMeetingName, formatMeetingDate } from '../commands/playback.js'
import { initReviewState, buildReviewMessage, summarizeApproval } from './meetingReviewUI.js'
import { mapMeetingTaskToRow } from './meetingTaskMap.js'
import { createTaskTicketChannel, dmTaskAssignees } from './taskTicketChannel.js'

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
      // Remember WHERE it went. doneStage edits this message into the final
      // summary, and /meeting-review can re-post it to a different channel —
      // resolving the channel again later finds the wrong one and the edit is
      // silently swallowed.
      data.reviewChannelId = channel.id
    } catch (e) {
      console.warn('[meetingPipeline] failed to post review message:', e?.message || e)
    }
  } else {
    console.warn(`[meetingPipeline] no channel resolved for meeting ${job.meetingId}; /meeting-review can re-post`)
  }

  // Block WITHOUT advancing. The worker advances the stage on any non-false
  // `advance`, which used to leave a review pending at stage 'approved' — a lie:
  // nothing had been approved, a human had not looked yet. Everything that gates
  // on the review checks `stage === 'awaiting_review'` (the component handlers'
  // isActive, and the /meeting-review re-post), so advancing here silently killed
  // the assignee dropdown, the GitHub toggle, the per-task reject, and made
  // /meeting-review answer "not awaiting review (stage: approved)". handleApprove
  // sets stage 'approved' itself when the human actually approves.
  return { block: true, advance: false, patch }
}

// approved: tell CSaaS the human decision. On meeting-level reject, terminate the
// job. Otherwise approve (skipping CSaaS's own GitHub sync — the bot mirrors tasks
// itself) and advance to `mirrored`. The returned tasks are ignored: the bot
// already holds dataJson.tasks.
async function approvedStage({ job, csaasClient }) {
  const meetingRejected = !!job.dataJson?.review?.meetingRejected
  if (meetingRejected) {
    try {
      await csaasClient.approve(job.csaasMeetingId, { decision: 'rejected' })
    } catch (e) {
      console.warn('[meetingPipeline] csaas approve(rejected) failed:', e?.message || e)
    }
    return { advance: false, patch: { stage: 'done', status: 'done' } }
  }
  // Let an approve failure propagate: runTick's retry/backoff must handle it, or
  // we'd mirror tasks for a meeting CSaaS was never told was approved.
  await csaasClient.approve(job.csaasMeetingId, { decision: 'approved', skipGithub: true })
  return { patch: {} }
}

// mirrored: create a bot task row for each non-rejected reviewed task, give each
// assigned task its own private channel the way a /create-task feature ticket
// gets one, record the mapping on dataJson.mirrored, and summarise in the review
// channel.
async function mirroredStage({ job, db, client, csaasClient }) {
  const dataJson = { ...(job.dataJson || {}) }
  const review = dataJson.review || {}
  const reviewTasks = Array.isArray(review.tasks) ? review.tasks : []
  const csaasTasks = Array.isArray(dataJson.tasks) ? dataJson.tasks : []

  const channel = await resolveMeetingChannel(client, db, job)
  const discordChannelId = channel?.id || null
  const botUserId = client?.user?.id

  // A retry after a partial mirror must not create a second channel per task,
  // so carry forward what the previous run already made.
  const prior = new Map(
    (Array.isArray(dataJson.mirrored) ? dataJson.mirrored : []).map((m) => [m.csaasTaskId, m]),
  )

  // The approver plays the assigner's role: on a /create-task feature they get
  // access to the ticket channel alongside the assignees.
  const approverId = dataJson.approvedBy || null

  let guild = channel?.guild || null
  if (!guild) {
    try {
      guild = await client.guilds.fetch(await guildIdFor(job.guildConfigId))
    } catch (e) {
      console.warn('[meetingPipeline] guild fetch for task channels failed:', e?.message || e)
    }
  }

  const mirrored = []
  for (const reviewTask of reviewTasks) {
    if (reviewTask.rejected) continue
    const csaasTask = csaasTasks.find((t) => t.task_id === reviewTask.taskId)
    if (!csaasTask) continue

    let repositoryId = null
    try {
      const repo = await db.repository.findFirst({
        where: { guildConfigId: job.guildConfigId, name: csaasTask.project },
      })
      repositoryId = repo?.id || null
    } catch (e) {
      console.warn('[meetingPipeline] repository lookup failed:', e?.message || e)
      repositoryId = null
    }

    const row = mapMeetingTaskToRow(csaasTask, reviewTask, {
      guildConfigId: job.guildConfigId,
      meetingId: job.meetingId,
      discordChannelId,
      botUserId,
      repositoryId,
    })

    // Idempotency: a retry after a partial mirror must not double-create rows.
    let taskRow = null
    try {
      taskRow = await db.task.findFirst({ where: { externalId: row.externalId } })
    } catch (e) {
      console.warn('[meetingPipeline] task.findFirst (mirror) failed:', e?.message || e)
      taskRow = null
    }
    if (!taskRow) taskRow = await db.task.create({ data: row })

    // Ticket parity: an assigned task gets its own private channel, and the
    // assignee gets a DM pointing at it. An unassigned task has nobody to give
    // the channel to — it is covered by the summary line below instead.
    let taskChannelId = prior.get(csaasTask.task_id)?.taskChannelId || null
    if (!taskChannelId && guild && reviewTask.assigneeRef) {
      try {
        const ticket = await createTaskTicketChannel(guild, {
          taskId: taskRow.id,
          title: row.title,
          description: row.description,
          memberIds: [reviewTask.assigneeRef, approverId],
          fields: [
            { name: 'Status', value: 'open', inline: true },
            { name: 'Assignees', value: `<@${reviewTask.assigneeRef}>`, inline: true },
            { name: 'From meeting', value: dataJson.title || job.meetingId, inline: false },
          ],
          closeHint: 'Use **/close-feature** in this channel when done.',
        })
        taskChannelId = ticket.id
        // Point the row at its own channel rather than the review channel, so
        // /close-feature and /update-task resolve here.
        await db.task.update({ where: { id: taskRow.id }, data: { discordChannelId: ticket.id } })
      } catch (e) {
        console.warn('[meetingPipeline] task channel creation failed:', e?.message || e)
      }
      await dmTaskAssignees(client, [reviewTask.assigneeRef], {
        title: row.title,
        channelId: taskChannelId,
        note: 'Use **/update-task** to change its status.',
      })
    }

    mirrored.push({
      dbTaskId: taskRow.id,
      csaasTaskId: csaasTask.task_id,
      assigneeRef: reviewTask.assigneeRef,
      github: !!reviewTask.github,
      title: row.title,
      taskChannelId,
    })

    // Persist progress after each task so a retry resumes where it stopped.
    dataJson.mirrored = mirrored
    if (db.meetingPipelineJob?.update) {
      try {
        await db.meetingPipelineJob.update(job.id, { dataJson: { ...dataJson } })
      } catch (e) {
        console.warn('[meetingPipeline] mirror progress persist failed:', e?.message || e)
      }
    }
  }

  dataJson.mirrored = mirrored

  if (channel && !dataJson.pinged) {
    const byRef = new Map()
    let unassigned = 0
    for (const m of mirrored) {
      if (m.assigneeRef) {
        if (!byRef.has(m.assigneeRef)) byRef.set(m.assigneeRef, [])
        byRef.get(m.assigneeRef).push(m)
      } else {
        unassigned++
      }
    }
    for (const [ref, items] of byRef) {
      try {
        await channel.send(
          `<@${ref}> you've been assigned: ${items
            .map((m) => (m.taskChannelId ? `**${m.title}** (<#${m.taskChannelId}>)` : `**${m.title}**`))
            .join(', ')} — /update-task for details`,
        )
      } catch (e) {
        console.warn('[meetingPipeline] assignee ping failed:', e?.message || e)
      }
    }
    if (unassigned > 0) {
      try {
        await channel.send(
          `${unassigned} task(s) from this meeting are unassigned — assign with /update-task`,
        )
      } catch (e) {
        console.warn('[meetingPipeline] unassigned summary send failed:', e?.message || e)
      }
    }
    dataJson.pinged = true
  }

  return { patch: { dataJson } }
}

// resolveRepoSlug: parse a repository row's `url` into { owner, repo }.
// Pure. Handles `git@github.com:owner/repo.git` and `https://github.com/owner/repo`.
// Returns null when empty or no github.com match.
export function resolveRepoSlug(repositoryRow) {
  const url = repositoryRow && typeof repositoryRow.url === 'string' ? repositoryRow.url.trim() : ''
  if (!url) return null
  const m = url.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

// issue_syncing: for mirrored tasks flagged github, group by the CSAAS task's
// project -> resolved owner/repo, call csaasClient.issueSync per repo, and write
// the returned issue url/number back onto the bot task rows. Best-effort:
// failures land in dataJson.issueSyncErrors. Always advances to `done`.
async function issueSyncingStage({ job, db, csaasClient }) {
  const gh = (job.dataJson?.mirrored || []).filter((m) => m.github)
  if (gh.length === 0) return { patch: {} }

  const dataJson = { ...(job.dataJson || {}) }
  const csaasTasks = Array.isArray(dataJson.tasks) ? dataJson.tasks : []
  const errors = []

  let repos = []
  try {
    repos = await db.repository.findMany({ where: { guildConfigId: job.guildConfigId } })
  } catch (e) {
    console.warn('[meetingPipeline] repository.findMany failed:', e?.message || e)
    repos = []
  }
  const slugByName = new Map()
  for (const r of repos || []) {
    const slug = resolveRepoSlug(r)
    if (r?.name && slug) slugByName.set(r.name, slug)
  }

  // group gh entries by `owner/repo`
  const groups = new Map() // key -> { owner, repo, entries: [] }
  for (const entry of gh) {
    const csaasTask = csaasTasks.find((t) => t.task_id === entry.csaasTaskId)
    const project = csaasTask?.project
    const slug = project ? slugByName.get(project) : null
    if (!slug) {
      errors.push({ csaasTaskId: entry.csaasTaskId, reason: `no repo for project ${project ?? '(none)'}` })
      continue
    }
    const key = `${slug.owner}/${slug.repo}`
    if (!groups.has(key)) groups.set(key, { owner: slug.owner, repo: slug.repo, entries: [] })
    groups.get(key).entries.push(entry)
  }

  for (const { owner, repo, entries } of groups.values()) {
    let issues = []
    try {
      const res = await csaasClient.issueSync(job.csaasMeetingId, {
        owner,
        repo,
        taskIds: entries.map((g) => g.csaasTaskId),
      })
      issues = Array.isArray(res?.issues) ? res.issues : []
    } catch (e) {
      errors.push({ owner, repo, error: e?.message || String(e) })
      continue
    }

    for (const issue of issues) {
      const csaasTaskId = issue.task_id ?? issue.taskId
      const match = entries.find((g) => g.csaasTaskId === csaasTaskId)
      if (!match) continue
      const url = issue.url ?? issue.github_issue_url ?? null
      const number = issue.number ?? issue.github_issue_number ?? null
      // mutate the mirrored entry in place so `done` can render issue links
      // (entries hold the same object refs as dataJson.mirrored)
      match.externalIssueUrl = url
      match.externalIssueNumber = number
      try {
        await db.task.update({
          where: { externalId: 'csaas:' + csaasTaskId },
          data: { externalIssueUrl: url, externalIssueNumber: number },
        })
      } catch (e) {
        console.warn('[meetingPipeline] task.update (issue sync) failed:', e?.message || e)
      }
    }
  }

  dataJson.issueSyncErrors = errors
  return { patch: { dataJson } }
}

// done: rewrite the review message into a final summary embed, then terminate.
async function doneStage({ job, db, client }) {
  const dataJson = job.dataJson || {}
  const review = job.dataJson?.review?.tasks ? job.dataJson.review : { tasks: [] }
  const summary = summarizeApproval(review, dataJson.tasks || [])
  const mirrored = Array.isArray(dataJson.mirrored) ? dataJson.mirrored : []
  const issueSyncErrors = Array.isArray(dataJson.issueSyncErrors) ? dataJson.issueSyncErrors : []

  const lines = [
    `✅ ${summary.approved.length} task(s) created`,
    `${summary.rejectedCount} rejected`,
    `${summary.githubCount} pushed to GitHub`,
  ]
  const issueLinks = []
  for (const m of mirrored) {
    if (m.externalIssueUrl) issueLinks.push(`• [${m.title || m.csaasTaskId}](${m.externalIssueUrl})`)
  }
  if (issueLinks.length) lines.push('', '**GitHub issues:**', ...issueLinks)
  if (issueSyncErrors.length) {
    lines.push('', `⚠️ ${issueSyncErrors.length} issue-sync problem(s):`)
    for (const err of issueSyncErrors) {
      lines.push(`• ${err.reason || err.error || 'unknown error'}`)
    }
  }

  const summaryEmbed = new EmbedBuilder()
    .setTitle(`Meeting review complete — ${dataJson.title || 'Meeting'}`)
    .setDescription(lines.join('\n'))

  try {
    // Prefer the channel the review was actually posted to; fall back to the
    // meeting's channel for jobs created before reviewChannelId was recorded.
    let channel = null
    if (dataJson.reviewChannelId) {
      channel = await client?.channels?.fetch(dataJson.reviewChannelId).catch(() => null)
    }
    if (!channel) channel = await resolveMeetingChannel(client, db, job)
    if (channel && job.reviewMessageId) {
      const msg = await channel.messages.fetch(job.reviewMessageId).catch(() => null)
      if (msg) await msg.edit({ embeds: [summaryEmbed], components: [] }).catch(() => {})
    }
  } catch (e) {
    console.warn('[meetingPipeline] done stage message edit failed:', e?.message || e)
  }

  return { advance: false, patch: { status: 'done' } }
}

// APPEND one key per task; never delete a sibling key.
export const stageRunners = {
  created: createdStage,
  transcribing: transcribingStage,
  analyzing: analyzingStage,
  generating_tasks: generatingTasksStage,
  assigning: assigningStage,
  awaiting_review: awaitingReviewStage,
  approved: approvedStage,
  mirrored: mirroredStage,
  issue_syncing: issueSyncingStage,
  done: doneStage,
}

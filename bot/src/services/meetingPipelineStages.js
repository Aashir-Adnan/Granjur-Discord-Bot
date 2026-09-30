// Stage runners are filled in Tasks 9-16. Each: async ({ job, db, client, csaasClient })
//   -> { patch?, advance?: boolean (default true), block?: boolean }
// - patch:   shallow-merged into the job row on success
// - advance: when false, the job stays on the same stage (e.g. polling)
// - block:   when true, status becomes 'blocked' instead of 'pending'/'done'
import fs from 'node:fs/promises'
import { AttachmentBuilder, EmbedBuilder } from 'discord.js'
import { getGuildConfigById } from '../Database/index.js'
import { buildRoster } from './meetingRoster.js'
import { deriveMeetingName, formatMeetingDate } from '../commands/playback.js'
import { initReviewState, buildReviewMessage, summarizeApproval, taskKey } from './meetingReviewUI.js'
import { mapMeetingTaskToRow } from './meetingTaskMap.js'
import { createTaskTicketChannel, dmTaskAssignees } from './taskTicketChannel.js'
import { loadProjectContext, settledProject, resolveMeetingTaskProject, reviewProjectOptions } from './meetingTaskProject.js'
import { buildAnalyzeLivePayload } from './liveTranscriptPayload.js'
import { createIssue } from './github.js'
import { repoReasonText } from './taskRepo.js'
import { REPORT_TIMEOUT_MS } from './csaasClient.js'
import { stageTimeoutMs } from '../Database/meetingPipelineJob.helpers.js'

// overrides is a test-only seam, never meant to carry real data: the `db`
// facade passed at runtime (bot/src/db/index.js default export) is a plain
// object literal with no getGuildConfigById key of its own, so passing the
// real `db` here always falls through to the real lookup below. (A
// *namespace* import of that module, `import * as ns from '../db/index.js'`,
// would carry getGuildConfigById as a named re-export — nothing does that
// today, which is why this stays safe, but don't pass such a namespace
// object in as `overrides`.) A test's fake object can supply
// getGuildConfigById to avoid a real network round trip.
async function guildIdFor(guildConfigId, overrides) {
  const cfg = overrides?.getGuildConfigById
    ? await overrides.getGuildConfigById(guildConfigId)
    : await getGuildConfigById(guildConfigId)
  if (!cfg?.guildId) throw new Error('created stage: no guildConfig for ' + guildConfigId)
  return cfg.guildId
}

// created: create the CSaaS meeting, snapshot the roster and title onto the job.
// A document job (/tasks-from-doc) has no recordings: its title is the one the
// command stored, dated with the job's creation time, and everyone verified is
// on the roster (buildRoster falls back to that when no recording matches).
async function createdStage({ job, db, csaasClient, client }) {
  const meeting = await db.meeting.findUnique({ where: { id: job.meetingId } })
  const isDocument = job.dataJson?.source === 'document'
  const recs = isDocument ? [] : await db.meetingRecording.findMany({ where: { meetingId: job.meetingId } })

  const guildId = await guildIdFor(job.guildConfigId, db)
  const guild = await client.guilds.fetch(guildId)
  const roster = await buildRoster({
    guild,
    guildConfigId: job.guildConfigId,
    meetingId: isDocument ? null : job.meetingId,
    db,
  })

  const title = isDocument
    ? `${job.dataJson.title || job.dataJson.documentName || 'Document'} — ${formatMeetingDate(job.createdAt || meeting?.createdAt)}`
    : deriveMeetingName(recs[0]?.filePath, job.meetingId) +
      ' — ' +
      formatMeetingDate(recs[0]?.startedAt || meeting?.createdAt)

  // startMeetingRecording creates the CSAAS meeting so the live transcript has
  // somewhere to post. Only create one here when that did not happen.
  let meeting_id = meeting?.csaasMeetingId || null
  if (!meeting_id) {
    ;({ meeting_id } = await csaasClient.createMeeting({
      title,
      participants: roster.map((r) => r.displayName),
    }))
  }

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
  // A document job has its text already: hand it to analyze-live as one segment.
  // Never the /transcribe path and never the liveTranscriptFailed fallback — any
  // error is rethrown so the worker retries the stage.
  if (job.dataJson?.source === 'document') {
    const meeting = await db.meeting.findUnique({ where: { id: job.meetingId } })
    const text = String(meeting?.transcript || '').trim()
    if (!text) throw new Error('document job has no text')
    const analysis = await csaasClient.analyzeLive(job.csaasMeetingId, {
      meetingNotes: { segment_0: { time_range: '', transcription: text } },
      totalDurationSec: 0,
    })
    return { patch: { dataJson: { ...job.dataJson, liveTranscript: true, analysis } } }
  }

  // Live path: the bot transcribed each turn as it was spoken, so CSAAS gets a
  // real conversation instead of one whole file per speaker. analyze-live both
  // stores the transcript and runs the analysis, so `analyzing` then no-ops.
  const LIVE_MIN_UTTERANCES = 5
  // The fallback below returns advance:false after each file, so this stage is
  // re-entered once per speaker recording. Without a sticky marker every one of
  // those ticks would re-attempt analyze-live (countWithText never drops back
  // below the threshold), each attempt rewriting meetings.transcript on the
  // backend and burning a 30-90 s blocking analysis while the fallback is
  // concurrently building that same transcript.
  let liveFailed = (job.dataJson || {}).liveTranscriptFailed === true
  if (!liveFailed) {
    try {
      const n = (await db.meetingUtterance?.countWithText?.({ meetingId: job.meetingId })) || 0
      if (n >= LIVE_MIN_UTTERANCES) {
        const rows = await db.meetingUtterance.findMany({ where: { meetingId: job.meetingId } })
        const { meetingNotes, totalDurationSec } = buildAnalyzeLivePayload(rows)
        const analysis = await csaasClient.analyzeLive(job.csaasMeetingId, { meetingNotes, totalDurationSec })
        return { patch: { dataJson: { ...(job.dataJson || {}), liveTranscript: true, analysis } } }
      }
    } catch (e) {
      // Anything wrong with the live path drops through to the whole-file upload
      // below — a meeting is never lost because live transcription misbehaved.
      // The flag rides out on whatever patch the fallback returns, so this tick
      // still makes its usual progress.
      liveFailed = true
      console.warn(`[meetingPipeline] live transcript path failed, falling back: ${e?.message || e}`)
    }
  }

  const recs = (await db.meetingRecording.findMany({ where: { meetingId: job.meetingId } }))
    .slice()
    .sort((a, b) => new Date(a.startedAt || 0) - new Date(b.startedAt || 0))

  const data = { uploaded: [], missing: [], ...(job.dataJson || {}) }
  data.uploaded = [...(data.uploaded || [])]
  data.missing = [...(data.missing || [])]
  // Every return below patches dataJson with `data`, so setting it here is what
  // makes the fallback stick across the per-file ticks.
  if (liveFailed) data.liveTranscriptFailed = true
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
  const data = job.dataJson || {}
  // The live path already ran the analysis inside analyze-live.
  if (data.liveTranscript && data.analysis) return { patch: { dataJson: data } }
  const { analysis } = await csaasClient.analyze(job.csaasMeetingId)
  return { patch: { dataJson: { ...data, analysis } } }
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

  // A document job lives in the channel /tasks-from-doc was run in (a text
  // channel, so there is no meetingchannel row to look up). Recorded meetings
  // keep the lookup below.
  const isDocument = job.dataJson?.source === 'document'
  if (isDocument && job.dataJson.reviewChannelId) candidates.push(job.dataJson.reviewChannelId)

  try {
    const mc = isDocument
      ? null
      : await db.meetingChannel.findFirst({
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

// The /report call's timeout: its own 300 s, but always 30 s inside the
// worker's stage cap, so the call gives up before the worker does.
export function reportTimeoutMs() {
  return Math.max(1, Math.min(REPORT_TIMEOUT_MS, stageTimeoutMs() - 30_000))
}

// reporting: ask CSAAS to write the meeting notes and the HTML report (its
// /report step; /notes is empty until this has run). Best-effort and never
// throws: a failed report must not stop the tasks reaching review. Asked once:
// `reported` is saved BEFORE the call, because the worker saves nothing from a
// stage its timeout abandons — the retry then moves on instead of asking again.
async function reportingStage({ job, db, csaasClient }) {
  const data = { ...(job.dataJson || {}) }
  if (data.reported) return { patch: { dataJson: data } }
  data.reported = true
  if (db?.meetingPipelineJob?.update) {
    try {
      await db.meetingPipelineJob.update(job.id, { dataJson: { ...data } })
    } catch (e) {
      console.warn('[meetingPipeline] report marker persist failed:', e?.message || e)
    }
  }
  try {
    await csaasClient.generateReport(job.csaasMeetingId, { timeoutMs: reportTimeoutMs() })
  } catch (e) {
    const message = e?.message || String(e)
    console.warn('[meetingPipeline] report failed:', message)
    data.reportError = message
  }
  return { patch: { dataJson: data } }
}

// YYYY-MM-DD in UTC, or today's date when the value is missing or unparseable.
function utcDateStamp(value) {
  const d = value ? new Date(value) : new Date()
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 10)
}

// The two attachment names for a meeting held on `date` (the date the job's
// title uses).
export function meetingNotesFileNames(date) {
  const stamp = utcDateStamp(date)
  return { notes: `meeting-notes-${stamp}.md`, report: `meeting-report-${stamp}.html` }
}

// awaiting_review: fetch notes, post them (and the HTML report) as files, post
// the Discord review UI, and block the job for human review.
async function awaitingReviewStage({ job, db, client, csaasClient }) {
  const data = { ...(job.dataJson || {}) }
  const tasks = data.tasks || []
  const assignments = data.assignments || []
  const roster = data.roster || []

  const { notes, html } = await csaasClient.fetchNotes(job.csaasMeetingId)

  // Settle each task's project now (meeting project, else the project Claude
  // named) so the review can ask only about the unclear ones. The choices are
  // stored so every re-render offers the same list. When the guild has no
  // projects to offer (or the project read failed), reviewProjects is empty —
  // asking "Which project?" then would mean a select whose only option is "No
  // project", so settle is left unset and every task falls back to legacy
  // behaviour (no needsProject, no page-size drop).
  const projectCtx = await loadProjectContext(db, job)
  const reviewProjects = reviewProjectOptions(projectCtx.projects)
  const settle = reviewProjects.length > 0 ? (t) => settledProject(t, projectCtx) : undefined
  const state = initReviewState(tasks, assignments, settle)
  data.reviewProjects = reviewProjects
  data.notes = notes ?? null
  data.review = state

  const patch = { dataJson: data }

  const channel = await resolveMeetingChannel(client, db, job)
  if (channel) {
    if (!data.notesMessageId && (notes || html)) {
      try {
        // The date the title uses: the first recording's start, else the meeting's.
        let when = null
        try {
          const meeting = await db.meeting.findUnique({ where: { id: job.meetingId } })
          const recs = await db.meetingRecording.findMany({ where: { meetingId: job.meetingId } })
          when = recs[0]?.startedAt || meeting?.createdAt || null
        } catch (e) {
          console.warn('[meetingPipeline] meeting date lookup failed:', e?.message || e)
        }
        const names = meetingNotesFileNames(when)
        const files = []
        if (notes) files.push(new AttachmentBuilder(Buffer.from(notes, 'utf8'), { name: names.notes }))
        if (html) files.push(new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: names.report }))
        // The title is user text (a document job's `title` option): it must not ping.
        const sentNotes = await channel.send({
          content: `**Meeting notes — ${data.title || 'Meeting'}**`,
          files,
          allowedMentions: { parse: [] },
        })
        data.notesMessageId = sentNotes.id
        data.notesChannelId = channel.id
        // Saved BEFORE the review goes out: a crash between the two sends then
        // retries without posting the notes a second time. (The worker only
        // saves the patch once this whole stage returns.)
        if (db.meetingPipelineJob?.update) {
          try {
            await db.meetingPipelineJob.update(job.id, { dataJson: { ...data } })
          } catch (e) {
            console.warn('[meetingPipeline] notes message persist failed:', e?.message || e)
          }
        }
      } catch (e) {
        console.warn('[meetingPipeline] failed to post meeting notes:', e?.message || e)
      }
    }
    try {
      const payload = buildReviewMessage({
        job: { ...job, dataJson: data }, notes, notesAttached: !!data.notesMessageId, state, roster,
      })
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
    (Array.isArray(dataJson.mirrored) ? dataJson.mirrored : []).map((m) => [taskKey(m.csaasTaskId), m]),
  )

  // The approver plays the assigner's role: on a /create-task feature they get
  // access to the ticket channel alongside the assignees.
  const approverId = dataJson.approvedBy || null

  let guild = channel?.guild || null
  if (!guild) {
    try {
      guild = await client.guilds.fetch(await guildIdFor(job.guildConfigId, db))
    } catch (e) {
      console.warn('[meetingPipeline] guild fetch for task channels failed:', e?.message || e)
    }
  }

  // Meeting project, else the project CSaaS named, else the reviewer's pick —
  // see meetingTaskProject.js.
  const projectCtx = await loadProjectContext(db, job)

  const mirrored = []
  for (const reviewTask of reviewTasks) {
    if (reviewTask.rejected) continue
    const csaasTask = csaasTasks.find((t) => taskKey(t.task_id) === taskKey(reviewTask.taskId))
    if (!csaasTask) continue

    const project = resolveMeetingTaskProject(csaasTask, reviewTask, projectCtx)

    const row = mapMeetingTaskToRow(csaasTask, reviewTask, {
      guildConfigId: job.guildConfigId,
      meetingId: job.meetingId,
      discordChannelId,
      botUserId,
      repositoryId: project.repositoryId,
      projectId: project.projectId,
      projectName: project.projectName,
    })

    // Idempotency: a retry after a partial mirror must not double-create rows.
    let taskRow = null
    try {
      taskRow = await db.task.findFirst({ where: { externalId: row.externalId } })
    } catch (e) {
      console.warn('[meetingPipeline] task.findFirst (mirror) failed:', e?.message || e)
      taskRow = null
    }
    if (!taskRow) {
      taskRow = await db.task.create({ data: row })
    } else if (row.assigneeIds.length && !(taskRow.assigneeIds || []).length) {
      // The row survives from an earlier mirror that ran with no assignee. A
      // re-run only happens after the review was corrected, so carry the new
      // assignment onto the existing row rather than leaving it orphaned.
      try {
        await db.task.update({ where: { id: taskRow.id }, data: { assigneeIds: row.assigneeIds } })
      } catch (e) {
        console.warn('[meetingPipeline] assigneeIds backfill failed:', e?.message || e)
      }
    }

    // Ticket parity: an assigned task gets its own private channel, and the
    // assignee gets a DM pointing at it. An unassigned task has nobody to give
    // the channel to — it is covered by the summary line below instead.
    let taskChannelId = prior.get(taskKey(csaasTask.task_id))?.taskChannelId || null
    if (!taskChannelId && guild && reviewTask.assigneeRef) {
      // The channel goes into the section of the project the row settled on
      // (meeting project, named project, or the reviewer's pick).
      const project = row.projectId
        ? projectCtx.projects.find((p) => p.id === row.projectId) ?? null
        : null
      try {
        const { channel: ticket } = await createTaskTicketChannel(guild, {
          taskId: taskRow.id,
          title: row.title,
          description: row.description,
          memberIds: [reviewTask.assigneeRef, approverId],
          project,
          type: row.type,
          status: 'open',
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
      // issue_syncing opens the issue here — the repository the rule gave the row.
      repositoryId: row.repositoryId ?? null,
      // …and, when there is none, says why (repoReasonText).
      repoReason: project.repoReason ?? null,
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
        // Task titles are Claude's words, steerable by a document's text: only
        // the assignee this line is for may be pinged.
        await channel.send({
          content: `<@${ref}> you've been assigned: ${items
            .map((m) => (m.taskChannelId ? `**${m.title}** (<#${m.taskChannelId}>)` : `**${m.title}**`))
            .join(', ')} — /update-task for details`,
          allowedMentions: { users: [ref] },
        })
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

// The body of a meeting task's GitHub issue: what to do, where the code lives,
// and which meeting it came from.
function meetingIssueBody(csaasTask, job) {
  const actions = Array.isArray(csaasTask?.intended_actions) ? csaasTask.intended_actions.join('\n') : ''
  const residence = csaasTask?.code_residence ? `\n\nCode: ${csaasTask.code_residence}` : ''
  return `${actions}${residence}\n\n---\nFrom meeting: ${job.dataJson?.title || job.meetingId}`
}

// issue_syncing (roadmap sub-project 4, 2026-09-30): the bot opens each
// GitHub-flagged task's issue itself, in the repository `mirrored` recorded for
// it (the project + scope rule), and writes the url/number onto the task row.
// CSAAS's issueSync is no longer used. Idempotent: an entry already holding its
// issue is skipped, and each opened issue is persisted at once, so a retry never
// opens a second one. Best-effort: every failure lands in
// dataJson.issueSyncErrors (the `done` summary lists them). Always advances.
// `openIssue` is a test seam; production passes nothing and gets createIssue.
async function issueSyncingStage({ job, db, openIssue = createIssue }) {
  const mirrored = (job.dataJson?.mirrored || []).map((m) => ({ ...m }))
  const flagged = mirrored.filter((m) => m.github && m.dbTaskId)
  if (flagged.length === 0) return { patch: {} }

  const dataJson = { ...(job.dataJson || {}), mirrored }
  const csaasTasks = Array.isArray(dataJson.tasks) ? dataJson.tasks : []
  const errors = []

  const todo = flagged.filter((m) => !m.externalIssueUrl)

  // An entry mirrored before repositories were recorded on it (pre-deploy)
  // has none: the task row's own repositoryId is the next best source.
  if (typeof db.task?.findFirst === 'function') {
    for (const entry of todo) {
      if (entry.repositoryId) continue
      try {
        const row = await db.task.findFirst({ where: { id: entry.dbTaskId } })
        if (row?.repositoryId) entry.repositoryId = row.repositoryId
      } catch (e) {
        console.warn('[meetingPipeline] task.findFirst (issue repo) failed:', e?.message || e)
      }
    }
  }

  let repoById = new Map()
  let repoReadError = null
  if (todo.some((m) => m.repositoryId)) {
    try {
      const repos = await db.repository.findMany({ where: { guildConfigId: job.guildConfigId } })
      repoById = new Map((repos || []).map((r) => [String(r.id), r]))
    } catch (e) {
      repoReadError = e?.message || String(e)
      console.warn('[meetingPipeline] repository.findMany failed:', repoReadError)
    }
  }

  for (const entry of todo) {
    const { csaasTaskId } = entry
    const csaasTask = csaasTasks.find((t) => taskKey(t.task_id) === taskKey(csaasTaskId))
    const title = entry.title || csaasTask?.goal_of_task || `Task ${csaasTaskId}`
    // `skipped`: the rule gave the task no repository — nothing went wrong.
    // `failed`: there was a repository and the issue still did not open.
    const skip = (reason) => errors.push({ csaasTaskId, title, kind: 'skipped', reason })
    const fail = (reason) => errors.push({ csaasTaskId, title, kind: 'failed', reason })
    if (!entry.repositoryId) {
      skip(entry.repoReason ? repoReasonText(entry.repoReason) : 'no repository for this project and scope')
      continue
    }
    if (repoReadError) {
      fail(`repositories could not be read: ${repoReadError}`)
      continue
    }
    const repo = repoById.get(String(entry.repositoryId))
    if (!repo?.url) {
      fail(repo ? `${repo.name || 'the repository'} has no URL` : 'the repository is no longer linked')
      continue
    }
    let res
    try {
      res = await openIssue(repo.url, title, meetingIssueBody(csaasTask, job))
    } catch (e) {
      fail(e?.message || String(e))
      continue
    }
    // The issue exists now: record it on the entry (and the saved job) first,
    // so even a failed row update below cannot make a retry open a second one.
    entry.externalIssueUrl = res?.url ?? null
    entry.externalIssueNumber = res?.number ?? null
    try {
      // repositoryId too, so the row agrees with where its issue lives.
      await db.task.update({
        where: { id: entry.dbTaskId },
        data: { repositoryId: repo.id, externalIssueUrl: entry.externalIssueUrl, externalIssueNumber: entry.externalIssueNumber },
      })
    } catch (e) {
      console.warn('[meetingPipeline] task.update (issue) failed:', e?.message || e)
    }
    if (db.meetingPipelineJob?.update) {
      try {
        // A snapshot: later entries are still being filled in.
        await db.meetingPipelineJob.update(job.id, { dataJson: { ...dataJson, mirrored: mirrored.map((m) => ({ ...m })) } })
      } catch (e) {
        console.warn('[meetingPipeline] issue progress persist failed:', e?.message || e)
      }
    }
  }

  dataJson.issueSyncErrors = errors
  return { patch: { dataJson } }
}

const SUMMARY_NOTE = '… (summary shortened)'

// Discord rejects an embed description over 4096 characters. Keep the text under
// `max`, cutting at a line boundary (the leading count lines survive) and ending
// with a note; a single line longer than the room is cut mid-line.
export function clampSummary(lines, max = 4000) {
  const text = lines.join('\n')
  if (text.length <= max) return text
  const room = max - SUMMARY_NOTE.length - 1
  const kept = []
  let used = 0
  for (const line of lines) {
    const add = line.length + (kept.length ? 1 : 0)
    if (used + add > room) break
    kept.push(line)
    used += add
  }
  if (!kept.length) return `${text.slice(0, room)}\n${SUMMARY_NOTE}`
  return `${kept.join('\n')}\n${SUMMARY_NOTE}`
}

// done: rewrite the review message into a final summary embed, then terminate.
async function doneStage({ job, db, client }) {
  const dataJson = job.dataJson || {}
  const review = job.dataJson?.review?.tasks ? job.dataJson.review : { tasks: [] }
  const summary = summarizeApproval(review, dataJson.tasks || [])
  const mirrored = Array.isArray(dataJson.mirrored) ? dataJson.mirrored : []
  const issueSyncErrors = Array.isArray(dataJson.issueSyncErrors) ? dataJson.issueSyncErrors : []

  const issueLinks = []
  for (const m of mirrored) {
    if (m.externalIssueUrl) issueLinks.push(`• [${m.title || m.csaasTaskId}](${m.externalIssueUrl})`)
  }
  const lines = [
    `✅ ${summary.approved.length} task(s) created`,
    `${summary.rejectedCount} rejected`,
    // Issues that actually opened — not the tasks that were flagged for one.
    `${issueLinks.length} pushed to GitHub`,
  ]
  if (issueLinks.length) lines.push('', '**GitHub issues:**', ...issueLinks)
  if (issueSyncErrors.length) {
    lines.push('', `⚠️ ${issueSyncErrors.length} issue-sync problem(s):`)
    const reasonOf = (err) => err.reason || err.error || 'unknown error'
    const titleOf = (err) => err.title || err.csaasTaskId || 'a task'
    // Entries saved before `kind` existed read as failures.
    const skipped = issueSyncErrors.filter((err) => err.kind === 'skipped')
    const failed = issueSyncErrors.filter((err) => err.kind !== 'skipped')
    if (skipped.length) {
      lines.push(`• skipped — no repository: ${skipped.map((err) => `${titleOf(err)} (${reasonOf(err)})`).join(', ')}`)
    }
    for (const err of failed) {
      lines.push(`• failed: ${titleOf(err)} — ${reasonOf(err)}`)
    }
  }

  const summaryEmbed = new EmbedBuilder()
    .setTitle(`Meeting review complete — ${dataJson.title || 'Meeting'}`)
    .setDescription(clampSummary(lines))

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
  reporting: reportingStage,
  awaiting_review: awaitingReviewStage,
  approved: approvedStage,
  mirrored: mirroredStage,
  issue_syncing: issueSyncingStage,
  done: doneStage,
}

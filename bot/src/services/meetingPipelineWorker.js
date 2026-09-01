import db from '../db/index.js'
import * as csaasClient from './csaasClient.js'
import { backoffMs, MAX_ATTEMPTS } from '../Database/meetingPipelineJob.helpers.js'
import { stageRunners as defaultRunners } from './meetingPipelineStages.js'

export const STAGE_ORDER = [
  'created', 'transcribing', 'analyzing', 'generating_tasks', 'assigning',
  'awaiting_review', 'approved', 'mirrored', 'issue_syncing', 'done',
]

export function nextStage(stage) {
  const i = STAGE_ORDER.indexOf(stage)
  if (i < 0 || i >= STAGE_ORDER.length - 1) return 'done'
  return STAGE_ORDER[i + 1]
}

const DEFAULT_STAGE_TIMEOUT_MS = 360_000

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`stage ${label} timed out after ${ms}ms`)),
      ms,
    )
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export async function runTick({ db, stageRunners, client, now = () => new Date() }) {
  const jobs = await db.meetingPipelineJob.claimBatch(3)
  for (const job of jobs) {
    const runner = stageRunners[job.stage]
    if (!runner) {
      await db.meetingPipelineJob.update(job.id, {
        status: 'failed', lastError: `no runner for stage ${job.stage}`,
      })
      continue
    }
    try {
      const timeoutMs = Number(process.env.MEETING_STAGE_TIMEOUT_MS) || DEFAULT_STAGE_TIMEOUT_MS
      const out = (await withTimeout(
        Promise.resolve().then(() => runner({ job, db, client, csaasClient })),
        timeoutMs,
        job.stage,
      )) || {}
      const patch = { ...(out.patch || {}), lastError: null, attempts: 0, nextAttemptAt: null }
      if (out.advance !== false) patch.stage = nextStage(job.stage)
      const effectiveStage = patch.stage ?? job.stage
      patch.status = out.block ? 'blocked' : (effectiveStage === 'done' ? 'done' : 'pending')
      await db.meetingPipelineJob.update(job.id, patch)
    } catch (err) {
      const attempts = (job.attempts || 0) + 1
      const failed = attempts >= MAX_ATTEMPTS
      await db.meetingPipelineJob.update(job.id, {
        attempts,
        status: failed ? 'failed' : 'pending',
        lastError: String(err?.message || err).slice(0, 2000),
        nextAttemptAt: failed ? null : new Date(now().getTime() + backoffMs(attempts)),
      })
      if (failed) await notifyFailure(client, job, err).catch(() => {})
    }
  }
}

// Task 17 fills this in. Noop-safe stub for now.
async function notifyFailure(client, job, err) {
  return undefined
}

let started = false
export function startMeetingPipelineWorker(client) {
  if (started) return
  started = true
  if (!process.env.MEETING_PIPELINE_ENABLED || !csaasClient.isConfigured()) {
    console.log('[meetingPipeline] disabled (MEETING_PIPELINE_ENABLED unset or CSAAS not configured)')
    return
  }
  console.log('[meetingPipeline] worker started (60s tick)')
  const tick = () =>
    runTick({ db, stageRunners: defaultRunners, client }).catch((e) =>
      console.error('[meetingPipeline] tick error:', e?.message || e),
    )
  const interval = setInterval(tick, 60_000)
  interval.unref?.()
  setTimeout(tick, 5_000).unref?.()
}

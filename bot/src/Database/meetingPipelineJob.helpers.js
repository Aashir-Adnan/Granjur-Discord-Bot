const LADDER = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]

export function backoffMs(attempt) {
  return LADDER[Math.min(attempt, LADDER.length) - 1] ?? LADDER[LADDER.length - 1]
}

export const MAX_ATTEMPTS = 6

// The worker's cap on one stage run. Stages that make a long call (reporting's
// /report) size their own timeout under it, so they read the same value.
export function stageTimeoutMs() {
  return Number(process.env.MEETING_STAGE_TIMEOUT_MS) || 360_000
}

// Strict truthiness for the pipeline kill switch: only 1/true/yes/on enable it.
// MEETING_PIPELINE_ENABLED="false" / "0" / "" -> disabled.
export function meetingPipelineEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.MEETING_PIPELINE_ENABLED ?? '').trim())
}

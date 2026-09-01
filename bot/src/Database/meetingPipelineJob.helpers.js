const LADDER = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]

export function backoffMs(attempt) {
  return LADDER[Math.min(attempt, LADDER.length) - 1] ?? LADDER[LADDER.length - 1]
}

export const MAX_ATTEMPTS = 6

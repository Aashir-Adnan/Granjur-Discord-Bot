/**
 * Discord API rate limit handling.
 * Error may be: "Request with opcode 8 was rate limited. Retry after 12.301 seconds."
 * or code 429 / rawError?.code === 429.
 */

/**
 * @param {unknown} e
 * @returns {boolean}
 */
export function isRateLimitError(e) {
  if (!e || typeof e !== 'object') return false
  const code = e.code ?? e.status
  if (code === 429) return true
  const msg = (e.message ?? String(e)).toLowerCase()
  return msg.includes('rate limit') || msg.includes('retry after')
}

/**
 * Parse "Retry after X.XXX seconds" from error message.
 * @param {unknown} e
 * @returns {{ seconds: number } | null}
 */
export function getRetryAfter(e) {
  if (!e || typeof e !== 'object') return null
  const msg = e.message ?? e.reason ?? String(e)
  const match = /retry\s+after\s+([\d.]+)\s*seconds?/i.exec(msg)
  if (match) {
    const seconds = Math.ceil(parseFloat(match[1])) || 1
    return { seconds: Math.min(seconds, 60) }
  }
  if (e.retryAfter != null) return { seconds: Math.min(Number(e.retryAfter), 60) }
  return null
}

export const RATE_LIMIT_MESSAGE = 'Discord is rate limiting requests. Please wait ~15 seconds and try again.'

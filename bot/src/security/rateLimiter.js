/**
 * Minimal in-memory fixed-window rate limiter keyed by an arbitrary string (e.g. client IP).
 * No external deps — intentional, given the bot only needs this for one raw http.Server.
 */
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs
    this.max = max
    this.hits = new Map() // key -> { count, resetAt }
  }

  /** Returns { allowed, retryAfterMs } and records the hit if allowed. */
  check(key) {
    const now = Date.now()
    const entry = this.hits.get(key)
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      return { allowed: true, retryAfterMs: 0 }
    }
    if (entry.count >= this.max) {
      return { allowed: false, retryAfterMs: entry.resetAt - now }
    }
    entry.count += 1
    return { allowed: true, retryAfterMs: 0 }
  }

  /** Drops expired entries so the map doesn't grow unbounded. Call on an interval. */
  sweep() {
    const now = Date.now()
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key)
    }
  }
}

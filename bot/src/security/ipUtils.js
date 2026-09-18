/**
 * Resolves the client IP for a request. Only trusts X-Forwarded-For when trustProxy
 * is explicitly enabled (i.e. a reverse proxy we control sets it) — otherwise a caller
 * could spoof the header to dodge rate limiting or an IP whitelist.
 */
export function getClientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for']
    if (forwarded) return forwarded.split(',')[0].trim()
  }
  return req.socket.remoteAddress || 'unknown'
}

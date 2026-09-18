/**
 * Minimal HTTP server for verification callback.
 * Context app (or backend) calls POST /verify with { token, email } after user signs in.
 * Optional: set BOT_VERIFY_PORT in env (default 4070).
 */
import http from 'http'
import { completeVerification } from './commands/verify.js'
import { config } from './config.js'
import { RateLimiter } from './security/rateLimiter.js'
import { getClientIp } from './security/ipUtils.js'
import { handleStatusRequest } from './services/internalTaskRoute.js'

const { port: PORT, allowedOrigin: ALLOWED_ORIGIN, trustProxy: TRUST_PROXY, maxBodyBytes: MAX_BODY_BYTES, rateLimit: RATE_LIMIT } =
  config.verifyServer

function setCors(res, origin) {
  if (ALLOWED_ORIGIN === '*' || origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  }
}

function send(res, status, body) {
  res.writeHead(status)
  res.end(JSON.stringify(body))
}

/** Reads the request body, aborting once it exceeds maxBytes to bound memory use. */
async function readBody(req, maxBytes) {
  let body = ''
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > maxBytes) {
      const err = new Error('Payload too large')
      err.code = 'PAYLOAD_TOO_LARGE'
      throw err
    }
    body += chunk
  }
  return body
}

export function startVerifyServer(discordClient) {
  const limiter = new RateLimiter(RATE_LIMIT)
  const sweepInterval = setInterval(() => limiter.sweep(), RATE_LIMIT.windowMs).unref()

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin
    res.setHeader('Content-Type', 'application/json')

    if (req.method === 'OPTIONS') {
      setCors(res, origin)
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'POST' && req.url === '/internal/tasks/status') {
      try {
        req.setEncoding('utf8')
        let ibody = ''
        for await (const chunk of req) ibody += chunk
        let idata
        try {
          idata = JSON.parse(ibody)
        } catch {
          res.writeHead(400)
          res.end(JSON.stringify({ ok: false, message: 'Invalid JSON' }))
          return
        }
        const r = await handleStatusRequest({
          headers: req.headers,
          body: idata,
          client: discordClient,
          secret: process.env.BOT_INTERNAL_SECRET || '',
        })
        res.writeHead(r.status)
        res.end(JSON.stringify(r.body))
      } catch (e) {
        console.error('[internal] status route:', e?.message ?? e)
        if (!res.headersSent) {
          res.writeHead(500)
          res.end(JSON.stringify({ ok: false, message: 'internal error' }))
        }
      }
      return
    }
    if (req.method !== 'POST' || req.url !== '/verify') {
      send(res, 404, { ok: false, message: 'Not found' })
      return
    }

    const ip = getClientIp(req, TRUST_PROXY)
    const { allowed, retryAfterMs } = limiter.check(ip)
    if (!allowed) {
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000).toString())
      send(res, 429, { ok: false, message: 'Too many requests' })
      return
    }

    // Cross-origin browser callers must come from the configured origin. Non-browser
    // callers (no Origin header) fall through to be checked further downstream.
    if (origin && ALLOWED_ORIGIN !== '*' && origin !== ALLOWED_ORIGIN) {
      send(res, 403, { ok: false, message: 'Forbidden origin' })
      return
    }

    let body
    try {
      body = await readBody(req, MAX_BODY_BYTES)
    } catch (err) {
      if (err.code === 'PAYLOAD_TOO_LARGE') {
        send(res, 413, { ok: false, message: 'Payload too large' })
        return
      }
      throw err
    }

    let data
    try {
      data = JSON.parse(body)
    } catch {
      send(res, 400, { ok: false, message: 'Invalid JSON' })
      return
    }

    const { token, email } = data || {}
    if (!token || !email) {
      send(res, 400, { ok: false, message: 'token and email required' })
      return
    }

    const result = await completeVerification(token, email, discordClient)
    setCors(res, origin)
    send(res, 200, result)
  })

  // Mitigate slowloris-style connection exhaustion: cap how long a client can take
  // to send headers/the full request, and how long an idle keep-alive socket lingers.
  server.headersTimeout = 10_000
  server.requestTimeout = 15_000
  server.keepAliveTimeout = 5_000

  server.on('close', () => clearInterval(sweepInterval))

  server.listen(PORT, () => {
    console.log(`Verify callback server on port ${PORT}`)
    console.log(process.env.BOT_INTERNAL_SECRET ? '[internal] status route enabled' : '[internal] status route disabled: BOT_INTERNAL_SECRET unset')
  })
  return server
}

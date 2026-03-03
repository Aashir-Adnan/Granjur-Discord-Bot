/**
 * Minimal HTTP server for verification callback.
 * Context app (or backend) calls POST /verify with { token, email } after user signs in.
 * Optional: set BOT_VERIFY_PORT in env (default 4070).
 */
import http from 'http'
import { completeVerification } from './commands/verify.js'

const PORT = parseInt(process.env.BOT_VERIFY_PORT || '4070', 10)

export function startVerifyServer(discordClient) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method !== 'POST' || req.url !== '/verify') {
      res.writeHead(404)
      res.end(JSON.stringify({ ok: false, message: 'Not found' }))
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    let data
    try {
      data = JSON.parse(body)
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ ok: false, message: 'Invalid JSON' }))
      return
    }
    const { token, email } = data || {}
    if (!token || !email) {
      res.writeHead(400)
      res.end(JSON.stringify({ ok: false, message: 'token and email required' }))
      return
    }
    const result = await completeVerification(token, email, discordClient)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.writeHead(200)
    res.end(JSON.stringify(result))
  })

  server.listen(PORT, () => {
    console.log(`Verify callback server on port ${PORT}`)
  })
  return server
}

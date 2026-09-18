import 'dotenv/config'

const allowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS || 'granjur.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    guildId: process.env.DISCORD_GUILD_ID || null,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  api: {
    baseUrl: (process.env.API_BASE_URL || '').replace(/\/$/, ''),
  },
  allowedDomains,
  github: {
    token: process.env.GITHUB_TOKEN || '',
  },
  transcription: {
    apiKey: process.env.TRANSCRIPTION_API_KEY || '',
    service: process.env.TRANSCRIPTION_SERVICE || 'openai',
  },
  email: {
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
    from: process.env.EMAIL_FROM || '',
  },
  verifyServer: {
    port: parseInt(process.env.BOT_VERIFY_PORT || '4070', 10),
    // Origin allowed to call the verify endpoint from a browser (the hosted verify page).
    // Falls back to '*' only if unset, so existing deployments keep working until configured.
    allowedOrigin: process.env.VERIFY_BASE_URL || process.env.BOT_VERIFY_ALLOWED_ORIGIN || '*',
    // Set BOT_TRUST_PROXY=1 only if this server sits behind a reverse proxy that sets X-Forwarded-For.
    trustProxy: process.env.BOT_TRUST_PROXY === '1',
    maxBodyBytes: parseInt(process.env.BOT_VERIFY_MAX_BODY_BYTES || '10240', 10), // 10kb
    rateLimit: {
      windowMs: parseInt(process.env.BOT_VERIFY_RATE_WINDOW_MS || '60000', 10),
      max: parseInt(process.env.BOT_VERIFY_RATE_MAX || '20', 10),
    },
  },
}

export function isAllowedEmail(email) {
  if (!email || typeof email !== 'string') return false
  const domain = email.split('@')[1]?.toLowerCase()
  return domain ? allowedDomains.includes(domain) : false
}

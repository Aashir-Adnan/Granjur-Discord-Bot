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
}

export function isAllowedEmail(email) {
  if (!email || typeof email !== 'string') return false
  const domain = email.split('@')[1]?.toLowerCase()
  return domain ? allowedDomains.includes(domain) : false
}

/**
 * Send email via nodemailer (Gmail). Logs to email_log if guildConfigId provided.
 * Uses bot Database layer (ESM). Set EMAIL_USER and EMAIL_PASS in .env.
 */
import 'dotenv/config'
import nodemailer from 'nodemailer'
import { query } from '../Database/connection.js'
import { id } from '../Database/helpers.js'

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
function debug(...args) {
  if (DEBUG) console.log(`[${new Date().toISOString()}]`, ...args)
}

export async function sendEmail(userEmail, subject, htmlBody, options = {}) {
  const { guildConfigId = null } = options
  const from = process.env.EMAIL_FROM || `Granjur <${process.env.EMAIL_USER || 'noreply@granjur.com'}>`

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    debug('sendEmail: EMAIL_USER or EMAIL_PASS not set, skipping send')
    return { ok: false, message: 'Email not configured' }
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'Gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    })

    const mailOptions = {
      from,
      to: userEmail,
      subject: subject || 'Notification',
      html: htmlBody || `
        <html><body style="font-family: Arial, sans-serif;">
          <p>${subject || 'Notification'}</p>
          <p>Thank you for using Granjur.</p>
        </body></html>
      `,
    }

    const info = await transporter.sendMail(mailOptions)
    debug('Email sent:', info.response)

    try {
      const pk = id()
      await query(
        'INSERT INTO `email_log` (id, guildConfigId, recipient_email, subject, content) VALUES (?, ?, ?, ?, ?)',
        [pk, guildConfigId, userEmail, subject || null, (htmlBody || '').slice(0, 2000)]
      )
    } catch (logErr) {
      debug('email_log insert failed:', logErr?.message)
    }

    return { ok: true, messageId: info.messageId }
  } catch (error) {
    console.error('Send email error:', error?.message || error)
    return { ok: false, message: error?.message || String(error) }
  }
}

/** Build HTML body for server invite (used by /invite) */
export function inviteEmailHtml(inviteUrl, serverName = 'Granjur') {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; background-color: #f9f9f9; color: #333; margin: 0; padding: 0; }
    .container { padding: 20px; background: #fff; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 30px auto; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h2 { color: #5865f2; margin-bottom: 20px; }
    p { line-height: 1.6; margin-bottom: 15px; }
    a.btn { display: inline-block; padding: 12px 24px; background: #5865f2; color: #fff; text-decoration: none; border-radius: 6px; margin: 10px 0; }
    .footer { font-size: 12px; color: #888; margin-top: 20px; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <h2>You're invited to ${serverName}</h2>
    <p>Click the link below to join the server on Discord:</p>
    <p><a href="${inviteUrl}" class="btn">Join server</a></p>
    <p>Or copy this link: ${inviteUrl}</p>
    <div class="footer">Granjur • This invite was sent to an @granjur.com address.</div>
  </div>
</body>
</html>
  `.trim()
}

/** Build plain text for OTP code (used by /verify OTP) */
export function otpEmailHtml(code, expiresMinutes = 10) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; padding: 20px;">
  <h2>Your verification code</h2>
  <p><strong>${code}</strong></p>
  <p>This code expires in ${expiresMinutes} minutes. Use it in Discord to verify your email.</p>
  <p class="footer" style="color:#888;font-size:12px;">Granjur verification</p>
</body>
</html>
  `.trim()
}

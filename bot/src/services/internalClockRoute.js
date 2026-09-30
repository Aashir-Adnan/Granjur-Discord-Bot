// Loopback routes through which CSAAS clocks a signed-in site user in or out,
// reads their clock, or lists who is clocked in. Same guard as the task routes
// (shared secret, disabled when unset); the rules live in services/clock.js.
import db from '../db/index.js'
import { guarded, guildOf } from './internalTaskRoute.js'
import { ClockError, clockIn as realClockIn, clockOut as realClockOut, clockStatus as realClockStatus, clockedInNow as realClockedInNow } from './clock.js'

const bad = (message) => ({ status: 400, body: { ok: false, message } })
const NO_STAFF = 'No staff member matches that Discord account.'
const NO_SERVER = 'The Discord server is not available to the bot right now.'

/** A ClockError is the caller's to read (409); anything else falls through to `guarded`'s logged 500. */
async function clockGuarded(args, handler) {
  return guarded(args, async (b) => {
    try {
      return await handler(b)
    } catch (e) {
      if (e instanceof ClockError) return { status: 409, body: { ok: false, message: e.message } }
      throw e
    }
  })
}

/**
 * The guild config and Discord guild named by the body, plus (when `needMember`)
 * the staff member its `discordId` names. Returns `{ error }` with the response
 * to send when any of that does not hold. Approved clients are not staff; a row
 * from before the `kind` column counts as staff, as it does in the daily report.
 */
async function resolve(dbArg, client, b, needMember) {
  const guildConfigId = typeof b.guildConfigId === 'string' ? b.guildConfigId.trim() : ''
  if (!guildConfigId) return { error: bad('guildConfigId is required') }
  const { cfg, guild } = await guildOf(dbArg, client, guildConfigId)
  if (!cfg) return { error: bad('No server matches that guildConfigId.') }
  if (!guild) return { error: { status: 500, body: { ok: false, message: NO_SERVER } } }
  if (!needMember) return { cfg, guild }

  const discordId = b.discordId
  if (typeof discordId !== 'string' || !/^\d{1,32}$/.test(discordId)) return { error: bad('discordId must be a Discord user id.') }
  const row = await dbArg.guildMember.findUnique({ where: { guildId_discordId: { guildId: cfg.guildId, discordId } } })
  if (!row || row.status !== 'approved' || row.kind === 'client') return { error: bad(NO_STAFF) }
  return { cfg, guild, discordId }
}

export async function handleClockInRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, clockIn = realClockIn, clockStatus = realClockStatus }) {
  return clockGuarded({ headers, body, secret, route: 'clock/in' }, async (b) => {
    const r = await resolve(dbArg, client, b, true)
    if (r.error) return r.error
    let taskId = null
    if (b.taskId !== undefined && b.taskId !== null) {
      if (typeof b.taskId !== 'string' || !b.taskId.trim() || b.taskId.length > 64) return bad('taskId must be a task id or null.')
      taskId = b.taskId.trim()
    }
    const { cfg, guild, discordId } = r
    const result = await clockIn({ db: dbArg, cfg, guild, discordId, taskId })
    const status = await clockStatus({ db: dbArg, cfg, guild, discordId })
    return { status: 200, body: { ok: true, outcome: result.outcome, stopped: result.stopped ?? null, status } }
  })
}

export async function handleClockOutRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, clockOut = realClockOut }) {
  return clockGuarded({ headers, body, secret, route: 'clock/out' }, async (b) => {
    const r = await resolve(dbArg, client, b, true)
    if (r.error) return r.error
    if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') return bad('note must be text.')
    const { cfg, guild, discordId } = r
    const result = await clockOut({ db: dbArg, cfg, guild, discordId, note: b.note ?? undefined })
    return {
      status: 200,
      body: { ok: true, minutes: result.minutes, taskTitle: result.task?.title ?? null, taskTotalMinutes: result.taskTotalMinutes ?? null },
    }
  })
}

export async function handleClockStatusRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, clockStatus = realClockStatus }) {
  return clockGuarded({ headers, body, secret, route: 'clock/status' }, async (b) => {
    const r = await resolve(dbArg, client, b, true)
    if (r.error) return r.error
    const { cfg, guild, discordId } = r
    return { status: 200, body: { ok: true, status: await clockStatus({ db: dbArg, cfg, guild, discordId }) } }
  })
}

export async function handleClockActiveRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, clockedInNow = realClockedInNow }) {
  return clockGuarded({ headers, body, secret, route: 'clock/active' }, async (b) => {
    const r = await resolve(dbArg, client, b, false)
    if (r.error) return r.error
    return { status: 200, body: { ok: true, people: await clockedInNow({ db: dbArg, cfg: r.cfg }) } }
  })
}

// Loopback-only route through which CSAAS asks the bot to change a task's
// status on behalf of a signed-in website user. Guarded by a shared secret
// compared in constant time; disabled entirely when the secret is unset.
import { timingSafeEqual } from 'node:crypto'
import db from '../db/index.js'
import { applyTaskUpdate } from './taskStatusChange.js'
import { TASK_STATUSES } from '../utils/taskDeps.js'

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

export async function handleStatusRequest({ headers = {}, body = {}, db: dbArg = db, client, secret, apply = applyTaskUpdate }) {
  if (!secret) return { status: 503, body: { ok: false, message: 'internal route not configured' } }
  if (!safeEqual(headers['x-internal-secret'], secret)) return { status: 401, body: { ok: false, message: 'unauthorized' } }
  try {
    // A default parameter only fires on `undefined`; a JSON body of `null` (or
    // any non-object) must not reach `.taskId` below, so it's normalized here.
    const b = body && typeof body === 'object' ? body : {}
    const taskId = String(b.taskId ?? '').trim()
    const status = String(b.status ?? '').trim()
    if (!taskId) return { status: 400, body: { ok: false, message: 'taskId is required' } }
    if (taskId.length > 64) return { status: 400, body: { ok: false, message: 'taskId is too long (max 64)' } }
    if (!TASK_STATUSES.includes(status)) return { status: 400, body: { ok: false, message: `status must be one of ${TASK_STATUSES.join(', ')}` } }
    const task = await dbArg.task.findFirst({ where: { id: taskId } })
    if (!task) return { status: 404, body: { ok: false, message: 'Task not found' } }
    if (task.status === status) return { status: 200, body: { ok: true, task: { id: task.id, status }, warning: '', unchanged: true } }
    const name = String(b.actor?.name || b.actor?.email || 'Someone').slice(0, 100)
    const { warning } = await apply({ db: dbArg, client, task, updates: { status }, actor: { label: `${name} (via the site)` } })
    return { status: 200, body: { ok: true, task: { id: task.id, status }, warning: warning || '', unchanged: false } }
  } catch (e) {
    console.error('[internal] status route:', e?.message ?? e)
    return { status: 500, body: { ok: false, message: e?.message || 'internal error' } }
  }
}

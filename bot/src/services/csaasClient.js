// The ONLY module that knows the CSAAS meeting-workflow wire format.
// Transport is plaintext localhost (endpoints are encryption:false -> plain JSON).
// Every request carries actionPerformerURDD (POST: body/multipart field, GET: query param).
// Responses are wrapped { status, message, payload: { return: {...} } } -> unwrapped to payload.return.

const BASE = () => (process.env.CSAAS_API_URL || '').replace(/\/+$/, '')
const URDD = () => process.env.CSAAS_ACTOR_URDD || ''

export function isConfigured() {
  return Boolean(BASE() && URDD())
}

export class CsaasError extends Error {
  constructor(message, status, body) {
    super(message)
    this.name = 'CsaasError'
    this.status = status
    this.body = body
  }
}

function parseBody(text) {
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { raw: text }
  }
}

function unwrap(json, status) {
  if (!json || (json.status && json.status !== 200)) {
    throw new CsaasError(json?.message || json?.error_message || `CSAAS ${status}`, status, json)
  }
  return json.payload?.return ?? json
}

async function postJson(pathname, body) {
  const res = await fetch(`${BASE()}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, actionPerformerURDD: URDD() }),
  })
  const text = await res.text()
  const json = parseBody(text)
  if (!res.ok) throw new CsaasError(json?.message || text || res.statusText, res.status, json)
  return unwrap(json, res.status)
}

async function getJson(pathname, query = {}) {
  const qs = new URLSearchParams({ ...query, actionPerformerURDD: URDD() }).toString()
  const res = await fetch(`${BASE()}${pathname}?${qs}`)
  const text = await res.text()
  const json = parseBody(text)
  if (!res.ok) throw new CsaasError(json?.message || text || res.statusText, res.status, json)
  return unwrap(json, res.status)
}

export const createMeeting = ({ title, participants }) =>
  postJson('/meeting/workflow/create', { title, participants })

export const analyze = (meetingId) =>
  postJson('/meeting/workflow/analyze', { meeting_id: meetingId })

export const generateTasks = (meetingId) =>
  postJson('/meeting/workflow/tasks', { meeting_id: meetingId })

export const assign = (meetingId, roster) =>
  postJson('/meeting/workflow/assign', { meeting_id: meetingId, roster })

export const fetchNotes = (meetingId) =>
  getJson('/meeting/workflow/notes', { meeting_id: meetingId })

export const fetchMeeting = (meetingId) =>
  getJson('/meeting/workflow/meeting', { meeting_id: meetingId })

export const approve = (meetingId, { decision, skipGithub }) =>
  postJson('/meeting/workflow/approve', {
    meeting_id: meetingId, decision, skip_github: !!skipGithub,
  })

export const issueSync = (meetingId, { owner, repo, taskIds, dryRun }) =>
  postJson('/meeting/workflow/issuesync', {
    meeting_id: meetingId, owner, repo,
    ...(taskIds ? { task_ids: taskIds } : {}),
    ...(dryRun ? { dry_run: true } : {}),
  })

export async function transcribeSegment(meetingId, { buffer, filename, segmentIndex }) {
  const form = new FormData()
  form.append('meeting_id', String(meetingId))
  form.append('segment_index', String(segmentIndex))
  form.append('actionPerformerURDD', URDD())
  form.append('file', new Blob([buffer]), filename || `segment-${segmentIndex}.ogg`)
  const res = await fetch(`${BASE()}/meeting/workflow/transcribe`, { method: 'POST', body: form })
  const text = await res.text()
  const json = parseBody(text)
  if (!res.ok) throw new CsaasError(json?.message || text || res.statusText, res.status, json)
  return unwrap(json, res.status)
}

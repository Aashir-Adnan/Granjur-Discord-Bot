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

function requestTimeoutMs() {
  return Number(process.env.CSAAS_REQUEST_TIMEOUT_MS) || 300000
}

// AbortSignal.timeout aborts the fetch itself so a hung request stops consuming
// resources (and a timed-out /transcribe does not later append a duplicate segment).
function timeoutSignal() {
  return AbortSignal.timeout(requestTimeoutMs())
}

function isAbort(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError' ||
    /aborted|timed out/i.test(String(err?.message || ''))
}

async function runFetch(url, init) {
  try {
    return await fetch(url, { ...init, signal: timeoutSignal() })
  } catch (err) {
    if (isAbort(err)) {
      throw new CsaasError(`CSAAS request timed out after ${requestTimeoutMs()}ms: ${url}`, 0, null)
    }
    throw err
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
  const res = await runFetch(`${BASE()}${pathname}`, {
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
  const res = await runFetch(`${BASE()}${pathname}?${qs}`, {})
  const text = await res.text()
  const json = parseBody(text)
  if (!res.ok) throw new CsaasError(json?.message || text || res.statusText, res.status, json)
  return unwrap(json, res.status)
}

// CSAAS create returns { meeting: <meetings row>, scope_repo_ids }. The id lives
// at meeting.meeting_id (verified in meetingWorkflow.js createMeeting -> getMeeting).
export const createMeeting = async ({ title, participants }) => {
  const out = await postJson('/meeting/workflow/create', { title, participants })
  return { meeting_id: out?.meeting?.meeting_id ?? out?.meeting_id }
}

export const analyze = (meetingId) =>
  postJson('/meeting/workflow/analyze', { meeting_id: meetingId })

export const generateTasks = (meetingId) =>
  postJson('/meeting/workflow/tasks', { meeting_id: meetingId })

export const assign = (meetingId, roster) =>
  postJson('/meeting/workflow/assign', { meeting_id: meetingId, roster })

// CSAAS /notes returns { notes: <meeting_notes row|null>, latestHtml: <string|null> }.
// The row carries edited_notes / raw_notes; prefer the edited text. Be defensive:
// tolerate `notes` already being a plain string, or the alt key `html`.
export const fetchNotes = async (meetingId) => {
  const out = await getJson('/meeting/workflow/notes', { meeting_id: meetingId })
  const row = out?.notes
  const notes = typeof row === 'string'
    ? row
    : (row?.edited_notes ?? row?.raw_notes ?? '')
  const html = out?.latestHtml ?? out?.html ?? null
  return { notes, html }
}

export const fetchMeeting = (meetingId) =>
  getJson('/meeting/workflow/meeting', { meeting_id: meetingId })

export const approve = (meetingId, { decision, skipGithub }) =>
  postJson('/meeting/workflow/approve', {
    meeting_id: meetingId, decision, skip_github: !!skipGithub,
  })

// CSAAS /issuesync returns { results: [ { task_id, issue_url, issue_number,
// skipped?, error?, ... } ], dry_run }. Normalize each result to a flat shape.
export const issueSync = async (meetingId, { owner, repo, taskIds, dryRun }) => {
  const out = await postJson('/meeting/workflow/issuesync', {
    meeting_id: meetingId, owner, repo,
    ...(taskIds ? { task_ids: taskIds } : {}),
    ...(dryRun ? { dry_run: true } : {}),
  })
  const results = Array.isArray(out?.results) ? out.results : []
  return {
    issues: results.map((r) => ({
      task_id: r.task_id,
      url: r.issue_url ?? r.url ?? null,
      number: r.issue_number ?? r.number ?? null,
      skipped: !!r.skipped,
      error: r.error ?? null,
    })),
  }
}

export async function transcribeSegment(meetingId, { buffer, filename, segmentIndex }) {
  const form = new FormData()
  form.append('meeting_id', String(meetingId))
  form.append('segment_index', String(segmentIndex))
  form.append('actionPerformerURDD', URDD())
  form.append('file', new Blob([buffer]), filename || `segment-${segmentIndex}.ogg`)
  const res = await runFetch(`${BASE()}/meeting/workflow/transcribe`, { method: 'POST', body: form })
  const text = await res.text()
  const json = parseBody(text)
  if (!res.ok) throw new CsaasError(json?.message || text || res.statusText, res.status, json)
  return unwrap(json, res.status)
}

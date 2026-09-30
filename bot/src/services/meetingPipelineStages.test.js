import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChannelType } from 'discord.js'
import { stageRunners, resolveRepoSlug, clampSummary, meetingNotesFileNames, resolveMeetingChannel } from './meetingPipelineStages.js'
import { formatMeetingDate } from '../commands/playback.js'

test('resolveRepoSlug parses ssh + https', () => {
  assert.deepEqual(resolveRepoSlug({ url: 'git@github.com:granjur/bot.git' }), { owner: 'granjur', repo: 'bot' })
  assert.deepEqual(resolveRepoSlug({ url: 'https://github.com/granjur/bot' }), { owner: 'granjur', repo: 'bot' })
  assert.equal(resolveRepoSlug({ url: '' }), null)
  assert.equal(resolveRepoSlug(null), null)
  assert.equal(resolveRepoSlug({ url: 'https://gitlab.com/a/b' }), null)
})

// issue_syncing (roadmap sub-project 4, 2026-09-30): the bot opens the issues
// itself in each task's repository. CSAAS's issueSync is never called — every
// test passes a csaasClient whose issueSync throws, and a fake openIssue.
const noCsaasSync = { issueSync: async () => { throw new Error('csaasClient.issueSync must not be called') } }
const SYNC_REPOS = [
  { id: 'r-be', name: 'granjur-bot', url: 'https://github.com/granjur/bot' },
  { id: 'r-fe', name: 'granjur-site', url: 'https://github.com/granjur/site' },
]
function syncDb({ repos = SYNC_REPOS, failUpdate = false } = {}) {
  const updates = []
  const persisted = []
  const reads = []
  const db = {
    repository: { findMany: async (q) => { reads.push(q); return repos } },
    task: { update: async (opts) => { if (failUpdate) throw new Error('db down'); updates.push(opts); return {} } },
    meetingPipelineJob: { update: async (id, patch) => { persisted.push([id, patch]); return {} } },
  }
  return { db, updates, persisted, reads }
}
function fakeOpenIssue({ fail = {} } = {}) {
  const calls = []
  let n = 40
  const openIssue = async (url, title, body) => {
    calls.push({ url, title, body })
    if (fail[title]) throw new Error(fail[title])
    n += 1
    return { url: `${url}/issues/${n}`, number: n }
  }
  return { openIssue, calls }
}
const syncJob = (mirrored, extra = {}) => ({
  id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
  dataJson: {
    title: 'Sprint sync',
    tasks: [
      { task_id: 'a', goal_of_task: 'Do A', intended_actions: ['Add the endpoint', 'Write the test'], code_residence: 'bot/src/api.js' },
      { task_id: 'b', goal_of_task: 'Do B', intended_actions: ['Build the page'] },
      { task_id: 'c', goal_of_task: 'Do C', intended_actions: ['Something'] },
    ],
    mirrored,
    ...extra,
  },
})

test('issue_syncing advances with no github-flagged mirrored tasks', async () => {
  const { db } = syncDb()
  const { openIssue, calls } = fakeOpenIssue()
  const job = syncJob([{ csaasTaskId: 'a', dbTaskId: 'db1', github: false, repositoryId: 'r-be', title: 'Do A' }])
  const out = await stageRunners.issue_syncing({ job, db, client: {}, csaasClient: noCsaasSync, openIssue })
  assert.equal(calls.length, 0)
  assert.notEqual(out.advance, false)
  assert.deepEqual(out.patch, {})
})

test('issue_syncing opens one issue per flagged task in its repository and writes url/number by id', async () => {
  const { db, updates, reads } = syncDb()
  const { openIssue, calls } = fakeOpenIssue()
  const job = syncJob([
    { csaasTaskId: 'a', dbTaskId: 'db1', github: true, repositoryId: 'r-be', title: 'Do A' },
    { csaasTaskId: 'b', dbTaskId: 'db2', github: true, repositoryId: 'r-fe', title: 'Do B' },
    { csaasTaskId: 'c', dbTaskId: 'db3', github: false, repositoryId: 'r-be', title: 'Do C' },
  ])
  const out = await stageRunners.issue_syncing({ job, db, client: {}, csaasClient: noCsaasSync, openIssue })
  assert.deepEqual(reads, [{ where: { guildConfigId: 'g' } }])
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], {
    url: 'https://github.com/granjur/bot',
    title: 'Do A',
    body: 'Add the endpoint\nWrite the test\n\nCode: bot/src/api.js\n\n---\nFrom meeting: Sprint sync',
  })
  assert.deepEqual(calls[1], {
    url: 'https://github.com/granjur/site',
    title: 'Do B',
    body: 'Build the page\n\n---\nFrom meeting: Sprint sync',
  })
  // F2: the row's repositoryId is written with the issue, so it agrees with where the issue lives.
  assert.deepEqual(updates, [
    { where: { id: 'db1' }, data: { repositoryId: 'r-be', externalIssueUrl: 'https://github.com/granjur/bot/issues/41', externalIssueNumber: 41 } },
    { where: { id: 'db2' }, data: { repositoryId: 'r-fe', externalIssueUrl: 'https://github.com/granjur/site/issues/42', externalIssueNumber: 42 } },
  ])
  assert.notEqual(out.advance, false)
  const m = out.patch.dataJson.mirrored
  assert.deepEqual([m[0].externalIssueUrl, m[0].externalIssueNumber], ['https://github.com/granjur/bot/issues/41', 41])
  assert.deepEqual([m[1].externalIssueUrl, m[1].externalIssueNumber], ['https://github.com/granjur/site/issues/42', 42])
  assert.equal(m[2].externalIssueUrl, undefined)
  assert.deepEqual(out.patch.dataJson.issueSyncErrors, [])
  // The job passed in is not mutated.
  assert.equal(job.dataJson.mirrored[0].externalIssueUrl, undefined)
})

test('issue_syncing falls back to the meeting id when the meeting has no title', async () => {
  const { db } = syncDb()
  const { openIssue, calls } = fakeOpenIssue()
  const job = syncJob([{ csaasTaskId: 'b', dbTaskId: 'db2', github: true, repositoryId: 'r-fe', title: 'Do B' }], { title: undefined })
  await stageRunners.issue_syncing({ job, db, client: {}, csaasClient: noCsaasSync, openIssue })
  assert.equal(calls[0].body, 'Build the page\n\n---\nFrom meeting: M')
})

test('issue_syncing skips a task that already has its issue (a retry opens no second one)', async () => {
  const { db, updates } = syncDb()
  const { openIssue, calls } = fakeOpenIssue()
  const job = syncJob([
    { csaasTaskId: 'a', dbTaskId: 'db1', github: true, repositoryId: 'r-be', title: 'Do A', externalIssueUrl: 'https://github.com/granjur/bot/issues/7', externalIssueNumber: 7 },
    { csaasTaskId: 'b', dbTaskId: 'db2', github: true, repositoryId: 'r-fe', title: 'Do B' },
  ])
  const out = await stageRunners.issue_syncing({ job, db, client: {}, csaasClient: noCsaasSync, openIssue })
  assert.deepEqual(calls.map((c) => c.title), ['Do B'])
  assert.deepEqual(updates.map((u) => u.where.id), ['db2'])
  assert.equal(out.patch.dataJson.mirrored[0].externalIssueUrl, 'https://github.com/granjur/bot/issues/7')
  assert.deepEqual(out.patch.dataJson.issueSyncErrors, [])
})

test('issue_syncing persists each opened issue so a retry after a crash resumes, not repeats', async () => {
  const { db, persisted } = syncDb()
  const { openIssue } = fakeOpenIssue()
  const first = syncJob([
    { csaasTaskId: 'a', dbTaskId: 'db1', github: true, repositoryId: 'r-be', title: 'Do A' },
    { csaasTaskId: 'b', dbTaskId: 'db2', github: true, repositoryId: 'r-fe', title: 'Do B' },
  ])
  await stageRunners.issue_syncing({ job: first, db, client: {}, csaasClient: noCsaasSync, openIssue })
  assert.equal(persisted.length, 2)
  assert.equal(persisted[0][0], 'j')
  assert.equal(persisted[0][1].dataJson.mirrored[0].externalIssueUrl, 'https://github.com/granjur/bot/issues/41')
  assert.equal(persisted[0][1].dataJson.mirrored[1].externalIssueUrl, undefined)
  // A retry from the state saved after the first issue opens only the second.
  const retry = fakeOpenIssue()
  const resumed = { ...first, dataJson: persisted[0][1].dataJson }
  const out = await stageRunners.issue_syncing({ job: resumed, db, client: {}, csaasClient: noCsaasSync, openIssue: retry.openIssue })
  assert.deepEqual(retry.calls.map((c) => c.title), ['Do B'])
  assert.equal(out.patch.dataJson.mirrored[0].externalIssueUrl, 'https://github.com/granjur/bot/issues/41')
})

test('issue_syncing records a task with no repository and opens nothing for it', async () => {
  const { db, updates } = syncDb()
  const { openIssue, calls } = fakeOpenIssue()
  const job = syncJob([{ csaasTaskId: 'a', dbTaskId: 'db1', github: true, repositoryId: null, title: 'Do A' }])
  const out = await stageRunners.issue_syncing({ job, db, client: {}, csaasClient: noCsaasSync, openIssue })
  assert.equal(calls.length, 0)
  assert.equal(updates.length, 0)
  assert.deepEqual(out.patch.dataJson.issueSyncErrors, [{ csaasTaskId: 'a', title: 'Do A', kind: 'skipped', reason: 'no repository for this project and scope' }])
  assert.notEqual(out.advance, false)
})

// F4 (final review, 2026-09-30): a precise, named reason, and skips kept apart from failures.
test("issue_syncing records the rule's own reason for a task with no repository", async () => {
  const { db } = syncDb()
  const { openIssue, calls } = fakeOpenIssue()
  const job = syncJob([
    { csaasTaskId: 'a', dbTaskId: 'db1', github: true, repositoryId: null, repoReason: 'no-scope', title: 'Do A' },
    { csaasTaskId: 'b', dbTaskId: 'db2', github: true, repositoryId: null, repoReason: 'no-repo-for-scope', title: 'Do B' },
  ])
  const out = await stageRunners.issue_syncing({ job, db, client: {}, csaasClient: noCsaasSync, openIssue })
  assert.equal(calls.length, 0)
  assert.deepEqual(out.patch.dataJson.issueSyncErrors, [
    { csaasTaskId: 'a', title: 'Do A', kind: 'skipped', reason: 'the task has no scope' },
    { csaasTaskId: 'b', title: 'Do B', kind: 'skipped', reason: 'the project has no repository for this scope' },
  ])
})

test("issue_syncing: a pre-deploy entry with no repositoryId falls back to the task row's repositoryId", async () => {
  const { db, updates } = syncDb()
  const reads = []
  db.task.findFirst = async (q) => { reads.push(q); return { id: 'db1', repositoryId: 'r-fe' } }
  const { openIssue, calls } = fakeOpenIssue()
  const job = syncJob([{ csaasTaskId: 'a', dbTaskId: 'db1', github: true, title: 'Do A' }]) // no repositoryId key at all
  const out = await stageRunners.issue_syncing({ job, db, client: {}, csaasClient: noCsaasSync, openIssue })
  assert.deepEqual(reads, [{ where: { id: 'db1' } }])
  assert.deepEqual(calls.map((c) => c.url), ['https://github.com/granjur/site'])
  assert.equal(updates[0].data.repositoryId, 'r-fe')
  assert.deepEqual(out.patch.dataJson.issueSyncErrors, [])
})

test('issue_syncing: a pre-deploy entry whose task row has no repository either is a named skip', async () => {
  const { db } = syncDb()
  db.task.findFirst = async () => ({ id: 'db1', repositoryId: null })
  const { openIssue } = fakeOpenIssue()
  const job = syncJob([{ csaasTaskId: 'a', dbTaskId: 'db1', github: true, title: 'Do A' }])
  const out = await stageRunners.issue_syncing({ job, db, client: {}, csaasClient: noCsaasSync, openIssue })
  assert.deepEqual(out.patch.dataJson.issueSyncErrors, [{ csaasTaskId: 'a', title: 'Do A', kind: 'skipped', reason: 'no repository for this project and scope' }])
})

test('issue_syncing records a repository that is no longer there', async () => {
  const { db } = syncDb({ repos: [] })
  const { openIssue, calls } = fakeOpenIssue()
  const job = syncJob([{ csaasTaskId: 'a', dbTaskId: 'db1', github: true, repositoryId: 'r-gone', title: 'Do A' }])
  const out = await stageRunners.issue_syncing({ job, db, client: {}, csaasClient: noCsaasSync, openIssue })
  assert.equal(calls.length, 0)
  assert.equal(out.patch.dataJson.issueSyncErrors.length, 1)
  assert.equal(out.patch.dataJson.issueSyncErrors[0].csaasTaskId, 'a')
  assert.equal(out.patch.dataJson.issueSyncErrors[0].kind, 'failed')
  assert.equal(out.patch.dataJson.issueSyncErrors[0].title, 'Do A')
  assert.notEqual(out.advance, false)
})

test('a failing openIssue is recorded with its message; the other tasks still get theirs and the stage advances', async () => {
  const { db, updates } = syncDb()
  const { openIssue, calls } = fakeOpenIssue({ fail: { 'Do A': 'No GitHub access to granjur/bot' } })
  const job = syncJob([
    { csaasTaskId: 'a', dbTaskId: 'db1', github: true, repositoryId: 'r-be', title: 'Do A' },
    { csaasTaskId: 'b', dbTaskId: 'db2', github: true, repositoryId: 'r-fe', title: 'Do B' },
  ])
  const out = await stageRunners.issue_syncing({ job, db, client: {}, csaasClient: noCsaasSync, openIssue })
  assert.equal(calls.length, 2)
  assert.deepEqual(updates.map((u) => u.where.id), ['db2'])
  assert.deepEqual(out.patch.dataJson.issueSyncErrors, [{ csaasTaskId: 'a', title: 'Do A', kind: 'failed', reason: 'No GitHub access to granjur/bot' }])
  assert.equal(out.patch.dataJson.mirrored[0].externalIssueUrl, undefined)
  assert.notEqual(out.advance, false)
})

test('an opened issue stays on the entry even if the task row update fails, so a retry does not reopen it', async () => {
  const { db } = syncDb({ failUpdate: true })
  const { openIssue, calls } = fakeOpenIssue()
  const job = syncJob([{ csaasTaskId: 'a', dbTaskId: 'db1', github: true, repositoryId: 'r-be', title: 'Do A' }])
  const out = await stageRunners.issue_syncing({ job, db, client: {}, csaasClient: noCsaasSync, openIssue })
  assert.equal(calls.length, 1)
  assert.equal(out.patch.dataJson.mirrored[0].externalIssueUrl, 'https://github.com/granjur/bot/issues/41')
  assert.notEqual(out.advance, false)
})

test('issue_syncing with a failed repository read records every flagged task and still advances', async () => {
  const db = { repository: { findMany: async () => { throw new Error('db down') } }, task: { update: async () => ({}) } }
  const { openIssue, calls } = fakeOpenIssue()
  const job = syncJob([{ csaasTaskId: 'a', dbTaskId: 'db1', github: true, repositoryId: 'r-be', title: 'Do A' }])
  const out = await stageRunners.issue_syncing({ job, db, client: {}, csaasClient: noCsaasSync, openIssue })
  assert.equal(calls.length, 0)
  assert.equal(out.patch.dataJson.issueSyncErrors.length, 1)
  assert.notEqual(out.advance, false)
})

test('done renders the issue links and the issue problems from the entries', async () => {
  let edited = null
  const msg = { edit: async (p) => { edited = p } }
  const channel = { id: 'tc1', send: async () => ({}), messages: { fetch: async () => msg } }
  const client = { channels: { fetch: async () => channel }, user: { id: 'bot' } }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
  }
  const job = {
    id: 'j', meetingId: 'M', guildConfigId: 'g', reviewMessageId: 'rm1',
    dataJson: {
      title: 'Sprint sync', reviewChannelId: 'tc1',
      tasks: [{ task_id: 'a' }, { task_id: 'b' }],
      review: { tasks: [{ taskId: 'a', github: true }, { taskId: 'b', github: true }] },
      mirrored: [
        { csaasTaskId: 'a', title: 'Do A', github: true, externalIssueUrl: 'https://github.com/granjur/bot/issues/41' },
        { csaasTaskId: 'b', title: 'Do B', github: true },
      ],
      issueSyncErrors: [{ csaasTaskId: 'b', reason: 'no repository for this project and scope' }],
    },
  }
  await stageRunners.done({ job, db, client, csaasClient: {} })
  const desc = edited.embeds[0].data.description
  assert.match(desc, /\[Do A\]\(https:\/\/github\.com\/granjur\/bot\/issues\/41\)/)
  assert.match(desc, /no repository for this project and scope/)
})

// F3 + F4 (final review, 2026-09-30).
function doneHarness(dataJson) {
  let edited = null
  const msg = { edit: async (p) => { edited = p } }
  const channel = { id: 'tc1', send: async () => ({}), messages: { fetch: async () => msg } }
  const client = { channels: { fetch: async () => channel }, user: { id: 'bot' } }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
  }
  const job = { id: 'j', meetingId: 'M', guildConfigId: 'g', reviewMessageId: 'rm1', dataJson: { title: 'Sprint sync', reviewChannelId: 'tc1', ...dataJson } }
  return { job, db, client, description: () => edited.embeds[0].data.description }
}

test('done counts only the tasks whose issue actually opened as pushed to GitHub', async () => {
  const h = doneHarness({
    tasks: [{ task_id: 'a' }, { task_id: 'b' }, { task_id: 'c' }],
    review: { tasks: [{ taskId: 'a', github: true }, { taskId: 'b', github: true }, { taskId: 'c', github: true }] },
    mirrored: [
      { csaasTaskId: 'a', title: 'Do A', github: true, externalIssueUrl: 'https://github.com/granjur/bot/issues/41' },
      { csaasTaskId: 'b', title: 'Do B', github: true },
      { csaasTaskId: 'c', title: 'Do C', github: true },
    ],
    issueSyncErrors: [
      { csaasTaskId: 'b', title: 'Do B', kind: 'skipped', reason: 'the task has no scope' },
      { csaasTaskId: 'c', title: 'Do C', kind: 'failed', reason: 'No GitHub access to granjur/bot' },
    ],
  })
  await stageRunners.done({ job: h.job, db: h.db, client: h.client, csaasClient: {} })
  const desc = h.description()
  assert.match(desc, /^1 pushed to GitHub$/m)
  assert.doesNotMatch(desc, /3 pushed to GitHub/)
})

test('done lists skipped tasks apart from failed ones, each by title', async () => {
  const h = doneHarness({
    tasks: [{ task_id: 'a' }, { task_id: 'b' }, { task_id: 'c' }],
    review: { tasks: [{ taskId: 'a', github: true }, { taskId: 'b', github: true }, { taskId: 'c', github: true }] },
    mirrored: [
      { csaasTaskId: 'a', title: 'Do A', github: true },
      { csaasTaskId: 'b', title: 'Do B', github: true },
      { csaasTaskId: 'c', title: 'Do C', github: true },
    ],
    issueSyncErrors: [
      { csaasTaskId: 'a', title: 'Do A', kind: 'skipped', reason: 'the task has no scope' },
      { csaasTaskId: 'b', title: 'Do B', kind: 'skipped', reason: 'the project has no repository for this scope' },
      { csaasTaskId: 'c', title: 'Do C', kind: 'failed', reason: 'No GitHub access to granjur/bot' },
    ],
  })
  await stageRunners.done({ job: h.job, db: h.db, client: h.client, csaasClient: {} })
  const lines = h.description().split('\n')
  assert.ok(lines.includes('• skipped — no repository: Do A (the task has no scope), Do B (the project has no repository for this scope)'), lines.join('\n'))
  assert.ok(lines.includes('• failed: Do C — No GitHub access to granjur/bot'), lines.join('\n'))
})

test('done still renders an issue problem saved before kind/title existed, as a failure', async () => {
  const h = doneHarness({
    tasks: [{ task_id: 'b' }],
    review: { tasks: [{ taskId: 'b', github: true }] },
    mirrored: [{ csaasTaskId: 'b', github: true }],
    issueSyncErrors: [{ csaasTaskId: 'b', reason: 'boom' }],
  })
  await stageRunners.done({ job: h.job, db: h.db, client: h.client, csaasClient: {} })
  assert.ok(h.description().split('\n').includes('• failed: b — boom'))
})

test('clampSummary leaves a short summary unchanged', () => {
  const lines = ['a', 'b', '', 'c']
  assert.equal(clampSummary(lines), lines.join('\n'))
})

test('clampSummary shortens a long summary at a line boundary and keeps the counts', () => {
  const lines = ['✅ 3 task(s) created', '0 rejected', '0 pushed to GitHub']
  for (let i = 0; i < 100; i++) lines.push(`• failed: ${'t'.repeat(200)} — boom ${i}`)
  const out = clampSummary(lines)
  assert.ok(out.length <= 4000, String(out.length))
  const outLines = out.split('\n')
  assert.deepEqual(outLines.slice(0, 3), lines.slice(0, 3))
  assert.equal(outLines[outLines.length - 1], '… (summary shortened)')
  assert.equal(outLines[3], lines[3])
})

test('clampSummary cuts a single oversized line rather than exceeding the limit', () => {
  const out = clampSummary(['x'.repeat(9000)])
  assert.ok(out.length <= 4000)
  assert.ok(out.endsWith('… (summary shortened)'))
})

test('done with 40 failing issue syncs does not throw and stays within the embed limit', async () => {
  const errors = []
  for (let i = 0; i < 40; i++) errors.push({ csaasTaskId: `t${i}`, title: 'T'.repeat(200), kind: 'failed', reason: 'No GitHub access to granjur/bot' })
  const h = doneHarness({
    tasks: [{ task_id: 'a' }],
    review: { tasks: [{ taskId: 'a', github: true }] },
    mirrored: [{ csaasTaskId: 'a', title: 'Do A', github: true }],
    issueSyncErrors: errors,
  })
  await stageRunners.done({ job: h.job, db: h.db, client: h.client, csaasClient: {} })
  const desc = h.description()
  assert.ok(desc.length <= 4096, String(desc.length))
  assert.ok(desc.startsWith('✅ 0 task(s) created') || desc.startsWith('✅'))
  assert.ok(desc.endsWith('… (summary shortened)'))
})

test('done edits the review message and terminates', async () => {
  let edited = null
  const msg = { edit: async (p) => { edited = p } }
  const channel = { id: 'tc1', send: async () => ({}), messages: { fetch: async () => msg } }
  const client = { channels: { fetch: async () => channel }, user: { id: 'bot' } }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
  }
  const job = {
    id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g', reviewMessageId: 'rm1',
    dataJson: {
      tasks: [{ task_id: 'a', goal_of_task: 'A' }],
      review: { tasks: [{ taskId: 'a', rejected: false, github: true }] },
      mirrored: [{ csaasTaskId: 'a', github: true, title: 'A' }],
      issueSyncErrors: [],
    },
  }
  const out = await stageRunners.done({ job, db, client, csaasClient: {} })
  assert.equal(out.advance, false)
  assert.deepEqual(out.patch, { status: 'done' })
  assert.ok(edited)
  assert.ok(Array.isArray(edited.embeds))
  assert.deepEqual(edited.components, [])
})

test('done does not throw when no channel resolves', async () => {
  const client = { channels: { fetch: async () => { throw new Error('no channel') } } }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => null },
  }
  const job = {
    id: 'j', meetingId: 'M', guildConfigId: 'g', reviewMessageId: 'rm1',
    dataJson: { tasks: [], review: { tasks: [] }, mirrored: [] },
  }
  const out = await stageRunners.done({ job, db, client, csaasClient: {} })
  assert.equal(out.advance, false)
  assert.deepEqual(out.patch, { status: 'done' })
})

test('transcribing uploads only not-yet-uploaded files, idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-'))
  const f1 = path.join(dir, 'ali.ogg'); fs.writeFileSync(f1, 'aaa')
  const f2 = path.join(dir, 'sara.ogg'); fs.writeFileSync(f2, 'bbb')

  const uploaded = []
  const csaasClient = {
    transcribeSegment: async (mid, { filename, segmentIndex }) => {
      uploaded.push({ filename, segmentIndex }); return { preview: 'ok' }
    },
  }
  const db = {
    meetingRecording: { findMany: async () => [
      { id: 'r1', filePath: f1, fileName: 'ali.ogg', startedAt: '2026-01-01T00:00:00Z' },
      { id: 'r2', filePath: f2, fileName: 'sara.ogg', startedAt: '2026-01-01T00:01:00Z' },
    ] },
  }
  const job = { id: 'j', csaasMeetingId: 'm', dataJson: { uploaded: ['r1'] } }
  const out = await stageRunners.transcribing({ job, db, csaasClient, client: {} })
  assert.deepEqual(uploaded.map((u) => u.filename), ['sara.ogg'])
  assert.equal(uploaded[0].segmentIndex, 1) // uploaded.length was 1
  assert.deepEqual(out.patch.dataJson.uploaded.sort(), ['r1', 'r2'])
})

test('transcribing one successful upload per tick, advance false on partial progress', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-'))
  const f1 = path.join(dir, 'ali.ogg'); fs.writeFileSync(f1, 'aaa')
  const f2 = path.join(dir, 'sara.ogg'); fs.writeFileSync(f2, 'bbb')

  const calls = []
  const csaasClient = {
    transcribeSegment: async (mid, opts) => { calls.push(opts); return {} },
  }
  const db = {
    meetingRecording: { findMany: async () => [
      { id: 'r2', filePath: f2, fileName: 'sara.ogg', startedAt: '2026-01-01T00:01:00Z' },
      { id: 'r1', filePath: f1, fileName: 'ali.ogg', startedAt: '2026-01-01T00:00:00Z' },
    ] },
  }
  const job = { id: 'j', csaasMeetingId: 'm', dataJson: {} }

  const t1 = await stageRunners.transcribing({ job, db, csaasClient, client: {} })
  assert.equal(t1.advance, false)
  assert.deepEqual(calls.map((c) => c.filename), ['ali.ogg']) // sorted by startedAt asc
  assert.equal(calls[0].segmentIndex, 0)
  assert.deepEqual(t1.patch.dataJson.uploaded, ['r1'])

  const job2 = { ...job, dataJson: t1.patch.dataJson }
  const t2 = await stageRunners.transcribing({ job: job2, db, csaasClient, client: {} })
  assert.equal(t2.advance, false)
  assert.deepEqual(calls.map((c) => c.filename), ['ali.ogg', 'sara.ogg'])
  assert.equal(calls[1].segmentIndex, 1)

  const job3 = { ...job, dataJson: t2.patch.dataJson }
  const t3 = await stageRunners.transcribing({ job: job3, db, csaasClient, client: {} })
  assert.notEqual(t3.advance, false) // advance to analyzing
  assert.deepEqual(t3.patch.dataJson.uploaded.sort(), ['r1', 'r2'])
})

test('transcribing records unreadable files in missing, keeps segment indexes contiguous', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-'))
  const f2 = path.join(dir, 'sara.ogg'); fs.writeFileSync(f2, 'bbb')
  const gone = path.join(dir, 'nope.ogg')

  const calls = []
  const csaasClient = {
    transcribeSegment: async (mid, opts) => { calls.push(opts); return {} },
  }
  const db = {
    meetingRecording: { findMany: async () => [
      { id: 'r1', filePath: gone, fileName: 'nope.ogg', startedAt: '2026-01-01T00:00:00Z' },
      { id: 'r2', filePath: f2, fileName: 'sara.ogg', startedAt: '2026-01-01T00:01:00Z' },
    ] },
  }
  const job = { id: 'j', csaasMeetingId: 'm', dataJson: {} }
  const out = await stageRunners.transcribing({ job, db, csaasClient, client: {} })
  // missing file skipped in same tick, second file uploaded
  assert.deepEqual(out.patch.dataJson.missing, ['r1'])
  assert.deepEqual(out.patch.dataJson.uploaded, ['r2'])
  assert.equal(calls[0].segmentIndex, 0) // missing files do not consume an index — first success is index 0
  assert.equal(out.advance, false)
})

test('transcribing throws when every file is missing', async () => {
  const db = {
    meetingRecording: { findMany: async () => [
      { id: 'r1', filePath: '/no/such/a.ogg', fileName: 'a.ogg', startedAt: '2026-01-01T00:00:00Z' },
      { id: 'r2', filePath: '/no/such/b.ogg', fileName: 'b.ogg', startedAt: '2026-01-01T00:01:00Z' },
    ] },
  }
  const job = { id: 'j', csaasMeetingId: 'm', dataJson: {} }
  const csaasClient = { transcribeSegment: async () => { throw new Error('should not be called') } }
  await assert.rejects(
    () => stageRunners.transcribing({ job, db, csaasClient, client: {} }),
    /all meeting recording files missing on disk/,
  )
})

test('stageRunners still exposes the created stage', () => {
  assert.equal(typeof stageRunners.created, 'function')
})

test('analyzing/generating_tasks/assigning store their results on dataJson', async () => {
  const csaasClient = {
    analyze: async () => ({ analysis: { summary: 's' } }),
    generateTasks: async () => ({ tasks: [{ task_id: 't1', goal_of_task: 'g' }] }),
    assign: async () => ({ assignments: [{ task_id: 't1', assignee_ref: '11', quote: 'q', confidence: 0.9 }] }),
  }
  const db = { meetingRecording: { findMany: async () => [] } }
  let job = { id: 'j', meetingId: 'M', csaasMeetingId: 'm', dataJson: { roster: [{ ref: '11', displayName: 'Ali', aliases: ['Ali'] }] } }

  let out = await stageRunners.analyzing({ job, db, csaasClient, client: {} })
  Object.assign(job.dataJson, out.patch.dataJson)
  assert.equal(job.dataJson.analysis.summary, 's')

  out = await stageRunners.generating_tasks({ job, db, csaasClient, client: {} })
  Object.assign(job.dataJson, out.patch.dataJson)
  assert.equal(job.dataJson.tasks[0].task_id, 't1')

  out = await stageRunners.assigning({ job, db, csaasClient, client: {} })
  Object.assign(job.dataJson, out.patch.dataJson)
  assert.equal(job.dataJson.assignments[0].assignee_ref, '11')

  // prior keys survive, assigning does not block
  assert.deepEqual(job.dataJson.roster[0].ref, '11')
  assert.notEqual(out.block, true)
})

function reviewJob() {
  return {
    id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
    dataJson: {
      title: 'T',
      tasks: [{ task_id: 'a', goal_of_task: 'A' }],
      assignments: [{ task_id: 'a', assignee_ref: '11' }],
      roster: [{ ref: '11', displayName: 'Ali', aliases: [] }],
    },
  }
}

test('awaiting_review posts a message and blocks', async () => {
  const sent = []
  const channel = { send: async (payload) => { sent.push(payload); return { id: 'msg1' } } }
  const fetched = []
  const client = { channels: { fetch: async (id) => { fetched.push(id); return channel } } }
  const csaasClient = { fetchNotes: async () => ({ notes: 'Notes body', html: '<html></html>' }) }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1', createdAt: '2026-01-01' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    meetingRecording: { findMany: async () => [] },
  }
  const out = await stageRunners.awaiting_review({ job: reviewJob(), db, csaasClient, client })
  assert.equal(out.block, true)
  assert.equal(out.patch.reviewMessageId, 'msg1')
  assert.equal(sent.length, 2)
  assert.equal(fetched[0], 'tc1')
  assert.equal(typeof out.patch.dataJson.review, 'object')
  assert.ok(Array.isArray(out.patch.dataJson.review.tasks))
  assert.equal(out.patch.dataJson.notes, 'Notes body')
})

test('awaiting_review posts even without html report', async () => {
  const sent = []
  const channel = { send: async (payload) => { sent.push(payload); return { id: 'msg2' } } }
  const client = { channels: { fetch: async () => channel } }
  const csaasClient = { fetchNotes: async () => ({ notes: 'Only notes' }) }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    meetingRecording: { findMany: async () => [] },
  }
  const out = await stageRunners.awaiting_review({ job: reviewJob(), db, csaasClient, client })
  assert.equal(out.block, true)
  assert.equal(out.patch.reviewMessageId, 'msg2')
  assert.equal(sent.length, 2)
  const desc = sent[1].embeds[0].data.description
  assert.ok(!/Full report:/.test(desc))
})

test('awaiting_review still blocks when channel resolution fails', async () => {
  const client = { channels: { fetch: async () => { throw new Error('no channel') } } }
  const csaasClient = { fetchNotes: async () => ({ notes: 'N', html: '<html></html>' }) }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => null },
    meetingRecording: { findMany: async () => [] },
  }
  const out = await stageRunners.awaiting_review({ job: reviewJob(), db, csaasClient, client })
  assert.equal(out.block, true)
  assert.equal(out.patch.reviewMessageId, undefined)
  assert.equal(typeof out.patch.dataJson.review, 'object')
})

test('approved reject path calls csaas approve(rejected) and terminates', async () => {
  const calls = []
  const csaasClient = { approve: async (mid, opts) => { calls.push([mid, opts]); return { tasks: [] } } }
  const job = { id: 'j', csaasMeetingId: 'm', dataJson: { review: { meetingRejected: true } } }
  const out = await stageRunners.approved({ job, db: {}, client: {}, csaasClient })
  assert.deepEqual(calls, [['m', { decision: 'rejected' }]])
  assert.equal(out.advance, false)
  assert.deepEqual(out.patch, { stage: 'done', status: 'done' })
})

test('approved happy path approves with skipGithub and advances', async () => {
  const calls = []
  const csaasClient = { approve: async (mid, opts) => { calls.push([mid, opts]); return { tasks: [] } } }
  const job = { id: 'j', csaasMeetingId: 'm', dataJson: { review: { tasks: [] } } }
  const out = await stageRunners.approved({ job, db: {}, client: {}, csaasClient })
  assert.deepEqual(calls, [['m', { decision: 'approved', skipGithub: true }]])
  assert.notEqual(out.advance, false)
  assert.deepEqual(out.patch, {})
})

test('approved happy path lets an approve error propagate for retry', async () => {
  const csaasClient = { approve: async () => { throw new Error('csaas down') } }
  const job = { id: 'j', csaasMeetingId: 'm', dataJson: { review: { tasks: [] } } }
  await assert.rejects(
    () => stageRunners.approved({ job, db: {}, client: {}, csaasClient }),
    /csaas down/,
  )
})

test('mirrored creates a task per non-rejected review task and pings assignees', async () => {
  const created = []
  const sent = []
  const channel = { id: 'tc1', send: async (m) => { sent.push(m); return { id: 'x' } } }
  const client = { user: { id: 'bot' }, channels: { fetch: async () => channel } }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    repository: { findMany: async () => [{ id: 'r1', name: 'granjur' }, { id: 'r2', name: 'granjur-web' }] },
    project: { findMany: async () => [{ id: 'p1', name: 'granjur' }] },
    projectRepos: {
      findMany: async () => [
        { project_id: 'p1', repository_id: 'r1', scope: 'backend' },
        { project_id: 'p1', repository_id: 'r2', scope: 'frontend' },
      ],
    },
    task: { findFirst: async () => null, create: async ({ data }) => { created.push(data); return { id: `db${created.length}` } } },
    meetingPipelineJob: { update: async () => ({}) },
  }
  const job = {
    id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
    dataJson: {
      tasks: [
        { task_id: 'a', goal_of_task: 'Do A', project: 'granjur', platform: 'node' },
        { task_id: 'b', goal_of_task: 'Do B' },
      ],
      review: {
        tasks: [
          { taskId: 'a', assigneeRef: '11', github: true, rejected: false },
          { taskId: 'b', assigneeRef: '11', rejected: true },
        ],
      },
    },
  }
  const out = await stageRunners.mirrored({ job, db, client, csaasClient: {} })
  assert.equal(created.length, 1)
  assert.equal(created[0].externalId, 'csaas:a')
  // The project's backend link: node -> backend (the repository rule).
  assert.equal(created[0].repositoryId, 'r1')
  assert.equal(created[0].discordChannelId, 'tc1')
  assert.equal(out.patch.dataJson.mirrored.length, 1)
  assert.equal(out.patch.dataJson.mirrored[0].dbTaskId, 'db1')
  assert.equal(out.patch.dataJson.mirrored[0].repositoryId, 'r1')
  assert.equal(out.patch.dataJson.mirrored[0].github, true)
  assert.equal(out.patch.dataJson.mirrored[0].title, 'Do A')
  assert.equal(sent.length, 1)
  assert.match(sent[0].content, /<@11> you've been assigned: \*\*Do A\*\*/)
})

test('the assignee ping mentions only the assignee, even when a task title holds a mention', async () => {
  const sent = []
  const channel = { id: 'tc1', send: async (m) => { sent.push(m); return { id: 'x' } } }
  const client = { user: { id: 'bot' }, channels: { fetch: async () => channel } }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    repository: { findMany: async () => [] },
    project: { findMany: async () => [] },
    projectRepos: { findMany: async () => [] },
    task: { findFirst: async () => null, create: async () => ({ id: 'db1' }) },
    meetingPipelineJob: { update: async () => ({}) },
  }
  const job = {
    id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
    dataJson: {
      tasks: [{ task_id: 'a', goal_of_task: 'Tell @everyone and <@&42> and <@77>' }],
      review: { tasks: [{ taskId: 'a', assigneeRef: '11', rejected: false }] },
    },
  }
  await stageRunners.mirrored({ job, db, client, csaasClient: {} })
  assert.equal(sent.length, 1)
  assert.match(sent[0].content, /^<@11> you've been assigned: \*\*Tell @everyone/)
  assert.deepEqual(sent[0].allowedMentions, { users: ['11'] })
})

test('mirrored is idempotent on re-run: reuses existing task, no re-ping when pinged', async () => {
  const created = []
  const sent = []
  const channel = { id: 'tc1', send: async (m) => { sent.push(m); return { id: 'x' } } }
  const client = { user: { id: 'bot' }, channels: { fetch: async () => channel } }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    repository: { findMany: async () => [] },
    project: { findMany: async () => [] },
    projectRepos: { findMany: async () => [] },
    task: {
      findFirst: async ({ where }) =>
        where.externalId === 'csaas:a' ? { id: 'existing1' } : null,
      create: async ({ data }) => { created.push(data); return { id: 'new' } },
    },
    meetingPipelineJob: { update: async () => ({}) },
  }
  const job = {
    id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
    dataJson: {
      pinged: true,
      tasks: [{ task_id: 'a', goal_of_task: 'Do A' }],
      review: { tasks: [{ taskId: 'a', assigneeRef: '11', rejected: false }] },
    },
  }
  const out = await stageRunners.mirrored({ job, db, client, csaasClient: {} })
  assert.equal(created.length, 0) // existing row reused
  assert.equal(out.patch.dataJson.mirrored.length, 1)
  assert.equal(out.patch.dataJson.mirrored[0].dbTaskId, 'existing1')
  assert.equal(sent.length, 0) // already pinged -> no re-ping
})

test('mirrored posts an unassigned summary line', async () => {
  const sent = []
  const channel = { id: 'tc1', send: async (m) => { sent.push(m); return { id: 'x' } } }
  const client = { user: { id: 'bot' }, channels: { fetch: async () => channel } }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => null },
    repository: { findMany: async () => [] },
    project: { findMany: async () => [] },
    projectRepos: { findMany: async () => [] },
    task: { findFirst: async () => null, create: async () => ({ id: 'db1' }) },
    meetingPipelineJob: { update: async () => ({}) },
  }
  const job = {
    id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
    dataJson: {
      tasks: [{ task_id: 'a', goal_of_task: 'Do A' }],
      review: { tasks: [{ taskId: 'a', assigneeRef: null, rejected: false }] },
    },
  }
  await stageRunners.mirrored({ job, db, client, csaasClient: {} })
  assert.equal(sent.length, 1)
  assert.match(sent[0], /1 task\(s\) from this meeting are unassigned/)
})

test('mirrored gives each assigned task its own channel, DMs the assignee, and repoints the row', async () => {
  const created = []
  const updated = []
  const sent = []
  const dms = []
  const guildCreates = []
  const chanSends = []
  const reviewChannel = { id: 'tc1', send: async (m) => { sent.push(m); return { id: 'x' } } }
  const guild = {
    id: 'g1',
    channels: {
      cache: { find: () => null },
      create: async (opts) => {
        guildCreates.push(opts)
        if (opts.type === 4) return { id: 'cat1', name: opts.name }
        return { id: `task-${guildCreates.length}`, send: async (m) => { chanSends.push(m); return { id: 'm' } } }
      },
    },
  }
  reviewChannel.guild = guild
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async () => reviewChannel },
    users: { fetch: async (id) => ({ send: async (m) => dms.push([id, m]) }) },
  }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    repository: { findMany: async () => [] },
    project: { findMany: async () => [] },
    projectRepos: { findMany: async () => [] },
    task: {
      findFirst: async () => null,
      create: async ({ data }) => { created.push(data); return { id: 'dbtask1' } },
      update: async ({ where, data }) => { updated.push([where, data]); return {} },
    },
    meetingPipelineJob: { update: async () => ({}) },
  }
  const job = {
    id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
    dataJson: {
      title: 'Sprint sync',
      approvedBy: '99',
      tasks: [{ task_id: 'a', goal_of_task: 'Do A' }],
      review: { tasks: [{ taskId: 'a', assigneeRef: '11', rejected: false }] },
    },
  }
  const out = await stageRunners.mirrored({ job, db, client, csaasClient: {} })

  // A private channel per assigned task, holding the assignee and the approver.
  const taskChan = guildCreates[1]
  assert.equal(taskChan.name, 'feature-btask1')
  assert.deepEqual(taskChan.permissionOverwrites.slice(1).map((o) => o.id), ['11', '99'])
  assert.match(chanSends[0].content, /<@11> <@99>/)

  // The row now points at its own channel, not the review channel.
  assert.equal(created[0].discordChannelId, 'tc1')
  assert.deepEqual(updated[0][1], { discordChannelId: 'task-2' })
  assert.equal(out.patch.dataJson.mirrored[0].taskChannelId, 'task-2')

  // And the assignee is DMed a pointer at it.
  assert.equal(dms.length, 1)
  assert.equal(dms[0][0], '11')
  assert.match(dms[0][1], /<#task-2>/)

  // The review-channel summary links the new channel.
  assert.match(sent[0].content, /<@11> you've been assigned: \*\*Do A\*\* \(<#task-2>\)/)
})

test('mirrored gives a matched task its channel inside the project, named after its title', async () => {
  // `type` matters: a stored category id that resolves to a text channel is
  // no longer accepted as a parent.
  const projectCategory = { id: 'projcat', name: '📂 FRAMEWORK', parentId: null, type: ChannelType.GuildCategory }
  const catMap = new Map([[projectCategory.id, projectCategory]])
  const guildCreates = []
  const chanSends = []
  const reviewChannel = { id: 'tc1', send: async () => ({ id: 'x' }) }
  const guild = {
    id: 'g1',
    channels: {
      cache: {
        get: (id) => catMap.get(id) ?? null,
        find: () => null,
        values: () => catMap.values(),
      },
      create: async (opts) => {
        guildCreates.push(opts)
        return { id: `chan-${guildCreates.length}`, parentId: opts.parent, send: async (m) => { chanSends.push(m); return { id: 'm' } } }
      },
    },
  }
  reviewChannel.guild = guild
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async () => reviewChannel },
    users: { fetch: async () => ({ send: async () => {} }) },
  }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    repository: { findMany: async () => [] },
    project: { findMany: async () => [{ id: 'p1', name: 'Framework', discordCategoryId: 'projcat' }] },
    projectRepos: { findMany: async () => [] },
    task: {
      findFirst: async () => null,
      create: async ({ data }) => { assert.equal(data.projectId, 'p1'); return { id: 'dbtask1', type: data.type } },
      update: async () => ({}),
    },
    meetingPipelineJob: { update: async () => ({}) },
  }
  const job = {
    id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
    dataJson: {
      title: 'Sprint sync',
      approvedBy: '99',
      tasks: [{ task_id: 'a', goal_of_task: 'Add booking rules', project: 'Framework' }],
      review: { tasks: [{ taskId: 'a', assigneeRef: '11', rejected: false }] },
    },
  }
  await stageRunners.mirrored({ job, db, client, csaasClient: {} })

  // Only the task channel was created — the project's category already existed.
  assert.equal(guildCreates.length, 1)
  assert.equal(guildCreates[0].name, 'feature-add-booking-rules')
  assert.equal(guildCreates[0].parent, 'projcat')
})

test('mirrored does not create a second channel when one already exists', async () => {
  const guildCreates = []
  const dms = []
  const reviewChannel = { id: 'tc1', send: async () => ({ id: 'x' }) }
  reviewChannel.guild = {
    id: 'g1',
    channels: { cache: { find: () => null }, create: async (o) => { guildCreates.push(o); return { id: 'c', send: async () => ({}) } } },
  }
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async () => reviewChannel },
    users: { fetch: async (id) => ({ send: async (m) => dms.push([id, m]) }) },
  }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    repository: { findMany: async () => [] },
    project: { findMany: async () => [] },
    projectRepos: { findMany: async () => [] },
    task: { findFirst: async () => ({ id: 'dbtask1' }), create: async () => ({ id: 'nope' }), update: async () => ({}) },
    meetingPipelineJob: { update: async () => ({}) },
  }
  const job = {
    id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
    dataJson: {
      pinged: true,
      tasks: [{ task_id: 'a', goal_of_task: 'Do A' }],
      review: { tasks: [{ taskId: 'a', assigneeRef: '11', rejected: false }] },
      mirrored: [{ csaasTaskId: 'a', dbTaskId: 'dbtask1', taskChannelId: 'already' }],
    },
  }
  const out = await stageRunners.mirrored({ job, db, client, csaasClient: {} })
  assert.equal(guildCreates.length, 0)
  assert.equal(dms.length, 0)
  assert.equal(out.patch.dataJson.mirrored[0].taskChannelId, 'already')
})

test('mirrored matches numeric csaas task ids against string review ids', async () => {
  const created = []
  const guildCreates = []
  const reviewChannel = { id: 'tc1', send: async () => ({ id: 'x' }) }
  reviewChannel.guild = {
    id: 'g1',
    channels: {
      cache: { find: () => null },
      create: async (o) => {
        guildCreates.push(o)
        return { id: `c${guildCreates.length}`, send: async () => ({}) }
      },
    },
  }
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async () => reviewChannel },
    users: { fetch: async () => ({ send: async () => {} }) },
  }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    repository: { findMany: async () => [] },
    project: { findMany: async () => [] },
    projectRepos: { findMany: async () => [] },
    task: {
      findFirst: async () => null,
      create: async ({ data }) => { created.push(data); return { id: 'dbA', assigneeIds: data.assigneeIds } },
      update: async () => ({}),
    },
    meetingPipelineJob: { update: async () => ({}) },
  }
  const job = {
    id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
    dataJson: {
      tasks: [{ task_id: 2, goal_of_task: 'Fix the APIs' }],
      review: { tasks: [{ taskId: '2', assigneeRef: '11', rejected: false }] },
    },
  }
  const out = await stageRunners.mirrored({ job, db, client, csaasClient: {} })
  assert.equal(created.length, 1)
  assert.equal(created[0].externalId, 'csaas:2')
  assert.deepEqual(created[0].assigneeIds, ['11'])
  assert.equal(out.patch.dataJson.mirrored[0].taskChannelId, 'c2')
})

test('mirrored backfills assigneeIds onto a row mirrored before it had an assignee', async () => {
  const updates = []
  const reviewChannel = { id: 'tc1', send: async () => ({ id: 'x' }) }
  reviewChannel.guild = {
    id: 'g1',
    channels: { cache: { find: () => null }, create: async () => ({ id: 'c', send: async () => ({}) }) },
  }
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async () => reviewChannel },
    users: { fetch: async () => ({ send: async () => {} }) },
  }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    repository: { findMany: async () => [] },
    project: { findMany: async () => [] },
    projectRepos: { findMany: async () => [] },
    task: {
      findFirst: async () => ({ id: 'existing', assigneeIds: [] }),
      create: async () => { throw new Error('should not create') },
      update: async ({ where, data }) => { updates.push([where, data]); return {} },
    },
    meetingPipelineJob: { update: async () => ({}) },
  }
  const job = {
    id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
    dataJson: {
      tasks: [{ task_id: 2, goal_of_task: 'Fix the APIs' }],
      review: { tasks: [{ taskId: '2', assigneeRef: '11', rejected: false }] },
    },
  }
  await stageRunners.mirrored({ job, db, client, csaasClient: {} })
  assert.deepEqual(updates[0], [{ id: 'existing' }, { assigneeIds: ['11'] }])
})

test('created reuses the CSAAS meeting made when recording started', async () => {
  let created = false
  const db = {
    meeting: { findUnique: async () => ({ id: 'm', csaasMeetingId: 'csaas-existing' }) },
    meetingRecording: { findMany: async () => [{ filePath: '/r/abc-standup/a.ogg', startedAt: new Date('2026-09-07T10:00:00Z') }] },
    guildMember: { findMany: async () => [] },
    // guildIdFor's real lookup (getGuildConfigById) is a raw, unmocked network
    // call unrelated to this fake db — createdStage's guildIdFor(id, db) checks
    // for this first so the test never touches the real database.
    getGuildConfigById: async () => ({ guildId: 'g' }),
  }
  const csaasClient = { createMeeting: async () => { created = true; return { meeting_id: 'csaas-new' } } }
  const client = { guilds: { fetch: async () => ({ id: 'g', members: { fetch: async () => ({}) } }) } }
  const out = await stageRunners.created({ job: { meetingId: 'm', guildConfigId: 'g' }, db, client, csaasClient })
  assert.equal(created, false, 'must not create a second CSAAS meeting')
  assert.equal(out.patch.csaasMeetingId, 'csaas-existing')
})

test('created calls createMeeting when no CSAAS meeting was made at recording start', async () => {
  let created = false
  const db = {
    meeting: { findUnique: async () => ({ id: 'm', csaasMeetingId: null }) },
    meetingRecording: { findMany: async () => [{ filePath: '/r/abc-standup/a.ogg', startedAt: new Date('2026-09-07T10:00:00Z') }] },
    guildMember: { findMany: async () => [] },
    getGuildConfigById: async () => ({ guildId: 'g' }),
  }
  const csaasClient = { createMeeting: async () => { created = true; return { meeting_id: 'csaas-new' } } }
  const client = { guilds: { fetch: async () => ({ id: 'g', members: { fetch: async () => ({}) } }) } }
  const out = await stageRunners.created({ job: { meetingId: 'm', guildConfigId: 'g' }, db, client, csaasClient })
  assert.equal(created, true, 'must create a CSAAS meeting when none exists yet')
  assert.equal(out.patch.csaasMeetingId, 'csaas-new')
})

test('transcribing takes the live path when there are enough utterances', async () => {
  let uploaded = 0
  let liveArgs = null
  const db = {
    meetingUtterance: {
      countWithText: async () => 7,
      findMany: async () => ([
        { sequence: 1, speakerName: 'A', text: 'one', durationMs: 1000, startedAt: new Date('2026-09-07T10:00:00Z') },
        { sequence: 2, speakerName: 'B', text: 'two', durationMs: 1000, startedAt: new Date('2026-09-07T10:00:04Z') },
      ]),
    },
    meetingRecording: { findMany: async () => [{ id: 'r1', filePath: '/nope.ogg', fileName: 'a.ogg' }] },
  }
  const csaasClient = {
    transcribeSegment: async () => { uploaded += 1 },
    analyzeLive: async (mid, args) => { liveArgs = [mid, args]; return { summary: 'ok' } },
  }
  const job = { meetingId: 'm', csaasMeetingId: 'c', dataJson: {} }
  const out = await stageRunners.transcribing({ job, db, csaasClient })

  assert.equal(uploaded, 0, 'the whole-file path is skipped')
  assert.equal(liveArgs[0], 'c')
  assert.equal(liveArgs[1].meetingNotes.segment_0.transcription, 'A: one\nB: two')
  assert.equal(out.patch.dataJson.liveTranscript, true)
  assert.equal(out.patch.dataJson.analysis.summary, 'ok')
  assert.notEqual(out.advance, false, 'the stage completes in one tick')
})

test('too few utterances falls back to the whole-file upload', async () => {
  let uploaded = 0
  let liveCalled = false
  const db = {
    meetingUtterance: { countWithText: async () => 4, findMany: async () => [] },
    meetingRecording: { findMany: async () => [{ id: 'r1', filePath: '/nope.ogg', fileName: 'a.ogg' }] },
  }
  const csaasClient = {
    transcribeSegment: async () => { uploaded += 1 },
    analyzeLive: async () => { liveCalled = true; return {} },
  }
  const job = { meetingId: 'm', csaasMeetingId: 'c', dataJson: {} }
  await assert.rejects(
    () => stageRunners.transcribing({ job, db, csaasClient }),
    /all meeting recording files missing on disk/,
    'it really did run the old path (the fake file does not exist)'
  )
  assert.equal(liveCalled, false)
  assert.equal(uploaded, 0)
})

test('an analyze-live failure falls back rather than failing the meeting', async () => {
  const db = {
    meetingUtterance: {
      countWithText: async () => 9,
      findMany: async () => ([{ sequence: 1, speakerName: 'A', text: 'one', durationMs: 1000, startedAt: new Date() }]),
    },
    meetingRecording: { findMany: async () => [] },
  }
  const csaasClient = {
    transcribeSegment: async () => {},
    analyzeLive: async () => { throw new Error('csaas down') },
  }
  const job = { meetingId: 'm', csaasMeetingId: 'c', dataJson: {} }
  await assert.rejects(
    () => stageRunners.transcribing({ job, db, csaasClient }),
    /all meeting recording files missing on disk/,
    'fell through to the whole-file path, which then found no recordings'
  )
})

test('a failed analyze-live is not retried on every fallback tick', async () => {
  // The fallback uploads one file per tick and returns advance:false, so the
  // stage is re-entered once per speaker. countWithText never drops back below
  // the threshold, so without a sticky marker every tick would run analyze-live
  // again — each one a blocking 30-90 s analysis that rewrites the transcript the
  // fallback is building at the same time.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-'))
  const f1 = path.join(dir, 'ali.ogg'); fs.writeFileSync(f1, 'aaa')
  const f2 = path.join(dir, 'sara.ogg'); fs.writeFileSync(f2, 'bbb')

  let liveCalls = 0
  const db = {
    meetingUtterance: {
      countWithText: async () => 9,
      findMany: async () => ([{ sequence: 1, speakerName: 'A', text: 'one', durationMs: 1000, startedAt: new Date() }]),
    },
    meetingRecording: { findMany: async () => [
      { id: 'r1', filePath: f1, fileName: 'ali.ogg', startedAt: '2026-01-01T00:00:00Z' },
      { id: 'r2', filePath: f2, fileName: 'sara.ogg', startedAt: '2026-01-01T00:01:00Z' },
    ] },
  }
  const csaasClient = {
    transcribeSegment: async () => ({}),
    analyzeLive: async () => { liveCalls += 1; throw new Error('claude quota exceeded') },
  }

  const job = { id: 'j', meetingId: 'm', csaasMeetingId: 'c', dataJson: {} }
  const t1 = await stageRunners.transcribing({ job, db, csaasClient, client: {} })
  assert.equal(liveCalls, 1)
  assert.equal(t1.advance, false)
  assert.equal(t1.patch.dataJson.liveTranscriptFailed, true, 'the failure is recorded on the job')
  assert.deepEqual(t1.patch.dataJson.uploaded, ['r1'], 'the tick still made its usual progress')

  const t2 = await stageRunners.transcribing({ job: { ...job, dataJson: t1.patch.dataJson }, db, csaasClient, client: {} })
  assert.equal(liveCalls, 1, 'the live path is not attempted again')
  assert.deepEqual(t2.patch.dataJson.uploaded, ['r1', 'r2'])
  assert.equal(t2.patch.dataJson.liveTranscriptFailed, true, 'the marker survives later ticks')

  const t3 = await stageRunners.transcribing({ job: { ...job, dataJson: t2.patch.dataJson }, db, csaasClient, client: {} })
  assert.equal(liveCalls, 1)
  assert.notEqual(t3.advance, false, 'the stage still completes')
})

test('analyzing does not call CSAAS twice when the live path already analysed', async () => {
  let called = false
  const csaasClient = { analyze: async () => { called = true; return { analysis: {} } } }
  const job = { csaasMeetingId: 'c', dataJson: { liveTranscript: true, analysis: { summary: 'ok' } } }
  const out = await stageRunners.analyzing({ job, csaasClient, db: {} })
  assert.equal(called, false)
  assert.equal(out.patch.dataJson.analysis.summary, 'ok')
})

test('analyzing still calls CSAAS on the fallback path', async () => {
  let called = false
  const csaasClient = { analyze: async () => { called = true; return { analysis: { summary: 'from-analyze' } } } }
  const out = await stageRunners.analyzing({ job: { csaasMeetingId: 'c', dataJson: {} }, csaasClient, db: {} })
  assert.equal(called, true)
  assert.equal(out.patch.dataJson.analysis.summary, 'from-analyze')
})

// ---------------------------------------------------------------------------
// B11: the meeting's own project places a task CSaaS could not attribute
// ---------------------------------------------------------------------------

test("a task CSaaS could not attribute is placed in the MEETING's project section", async () => {
  // CSaaS never sees `meeting.projectId`, so `matchProject` cannot produce it.
  // Without this the task channel lands in the global Features category even
  // though the meeting was held inside the project's own section.
  const guildCreates = []
  const cache = new Map([['cat-fw', { id: 'cat-fw', name: '📂 FRAMEWORK', type: ChannelType.GuildCategory }]])
  const guild = {
    id: 'g1',
    channels: {
      cache: Object.assign(cache, { find: () => null }),
      create: async (opts) => {
        guildCreates.push(opts)
        if (opts.type === ChannelType.GuildCategory) return { id: 'cat-new', name: opts.name }
        return { id: `task-${guildCreates.length}`, send: async () => ({ id: 'm' }) }
      },
    },
  }
  const reviewChannel = { id: 'tc1', guild, send: async () => ({ id: 'x' }) }
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async () => reviewChannel },
    users: { fetch: async () => ({ send: async () => {} }) },
  }
  const project = { id: 'p1', name: 'Framework', docsSlug: 'framework', discordCategoryId: 'cat-fw' }
  const createdRows = []
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1', projectId: 'p1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    repository: { findMany: async () => [] },
    project: { findMany: async () => [project] },
    projectRepos: { findMany: async () => [] },
    task: {
      findFirst: async () => null,
      create: async ({ data }) => { createdRows.push(data); return { id: 'dbtask1', ...data } },
      update: async () => ({}),
    },
    meetingPipelineJob: { update: async () => ({}) },
  }
  const job = {
    id: 'j',
    meetingId: 'M',
    csaasMeetingId: 'm',
    guildConfigId: 'g',
    dataJson: {
      title: 'Sprint sync',
      approvedBy: '99',
      // No `project` on the CSaaS task: matchProject finds nothing.
      tasks: [{ task_id: 'a', goal_of_task: 'Do A' }],
      review: { tasks: [{ taskId: 'a', assigneeRef: '11', rejected: false }] },
    },
  }

  await stageRunners.mirrored({ job, db, client, csaasClient: {} })

  const taskChannel = guildCreates.find((c) => c.type !== ChannelType.GuildCategory)
  assert.equal(taskChannel.parent, 'cat-fw', 'the channel went into the project section')
  assert.equal(guildCreates.filter((c) => c.type === ChannelType.GuildCategory).length, 0, 'no global category was made')
  assert.equal(createdRows[0].projectId, 'p1', 'the meeting project is now the task row project too')
})

test('a meeting with no project still places the task channel exactly as before', async () => {
  const guildCreates = []
  const guild = {
    id: 'g1',
    channels: {
      cache: Object.assign(new Map(), { find: () => null }),
      create: async (opts) => {
        guildCreates.push(opts)
        if (opts.type === ChannelType.GuildCategory) return { id: 'cat-new', name: opts.name }
        return { id: `task-${guildCreates.length}`, send: async () => ({ id: 'm' }) }
      },
    },
  }
  const reviewChannel = { id: 'tc1', guild, send: async () => ({ id: 'x' }) }
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async () => reviewChannel },
    users: { fetch: async () => ({ send: async () => {} }) },
  }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1', projectId: null }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    repository: { findMany: async () => [] },
    project: { findMany: async () => [] },
    projectRepos: { findMany: async () => [] },
    task: { findFirst: async () => null, create: async () => ({ id: 'dbtask1' }), update: async () => ({}) },
    meetingPipelineJob: { update: async () => ({}) },
  }
  const job = {
    id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
    dataJson: {
      approvedBy: '99',
      tasks: [{ task_id: 'a', goal_of_task: 'Do A' }],
      review: { tasks: [{ taskId: 'a', assigneeRef: '11', rejected: false }] },
    },
  }

  await stageRunners.mirrored({ job, db, client, csaasClient: {} })

  assert.equal(guildCreates.filter((c) => c.type === ChannelType.GuildCategory).length, 1, 'the global category, as today')
})

// ---------------------------------------------------------------------------
// Roadmap sub-project 2 (2026-09-29): meeting tasks get their project
// ---------------------------------------------------------------------------

const FW = { id: 'p1', name: 'Framework' }
const HMS = { id: 'p2', name: 'Badar HMS' }

function reviewDb({ meetingProjectId = null, projects = [FW, HMS] } = {}) {
  return {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1', projectId: meetingProjectId }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    meetingRecording: { findMany: async () => [] },
    project: { findMany: async () => projects },
    repository: { findMany: async () => [] },
    projectRepos: { findMany: async () => [] },
  }
}
const twoTaskJob = () => ({
  id: 'j', meetingId: 'M', csaasMeetingId: 'm', guildConfigId: 'g',
  dataJson: {
    title: 'Sync',
    tasks: [
      { task_id: 'a', goal_of_task: 'Do A', project: 'Framework' },
      { task_id: 'b', goal_of_task: 'Do B', project: 'Something unheard of' },
    ],
    assignments: [],
    roster: [],
  },
})

test('awaiting_review asks for a project only where the rules settle none, and stores the choices', async () => {
  const sent = []
  const channel = { id: 'tc1', send: async (p) => { sent.push(p); return { id: 'msg1' } } }
  const client = { channels: { fetch: async () => channel } }
  const csaasClient = { fetchNotes: async () => ({ notes: 'N' }) }
  const out = await stageRunners.awaiting_review({ job: twoTaskJob(), db: reviewDb(), csaasClient, client })
  const [a, b] = out.patch.dataJson.review.tasks
  assert.deepEqual([a.needsProject, a.projectLabel], [false, 'Framework'])
  assert.deepEqual([b.needsProject, b.projectId], [true, null])
  assert.deepEqual(out.patch.dataJson.reviewProjects, [{ id: 'p2', name: 'Badar HMS' }, { id: 'p1', name: 'Framework' }])
  // One task per page while b needs a project: page 1 is a, with no select.
  assert.match(sent[1].embeds[0].data.description, /Page 1\/2/)
})

test('awaiting_review asks nothing when the guild has no projects to offer', async () => {
  const sent = []
  const channel = { id: 'tc1', send: async (p) => { sent.push(p); return { id: 'msg1' } } }
  const client = { channels: { fetch: async () => channel } }
  const csaasClient = { fetchNotes: async () => ({ notes: 'N' }) }
  const out = await stageRunners.awaiting_review({ job: twoTaskJob(), db: reviewDb({ projects: [] }), csaasClient, client })
  assert.ok(out.patch.dataJson.review.tasks.every((t) => t.needsProject === false))
  assert.deepEqual(out.patch.dataJson.reviewProjects, [])
  // No task needs a project, so the legacy page size (2) applies to both tasks: one page.
  assert.match(sent[1].embeds[0].data.description, /Page 1\/1/)
})

test("awaiting_review asks nothing when the meeting has a project", async () => {
  const channel = { id: 'tc1', send: async () => ({ id: 'msg1' }) }
  const out = await stageRunners.awaiting_review({
    job: twoTaskJob(), db: reviewDb({ meetingProjectId: 'p1' }),
    csaasClient: { fetchNotes: async () => ({ notes: 'N' }) }, client: { channels: { fetch: async () => channel } },
  })
  assert.ok(out.patch.dataJson.review.tasks.every((t) => !t.needsProject && t.projectLabel === 'Framework'))
})

function mirrorDb({ meetingProjectId = null } = {}) {
  const created = []
  const db = {
    ...reviewDb({ meetingProjectId }),
    task: { findFirst: async () => null, create: async ({ data }) => { created.push(data); return { id: `db${created.length}` } }, update: async () => ({}) },
    meetingPipelineJob: { update: async () => ({}) },
  }
  return { db, created }
}
const mirrorClient = () => ({ user: { id: 'bot' }, channels: { fetch: async () => ({ id: 'tc1', send: async () => ({ id: 'x' }) }) } })
const mirrorJob = (reviewTasks) => ({ ...twoTaskJob(), dataJson: { ...twoTaskJob().dataJson, review: { tasks: reviewTasks } } })

test("mirrored: the meeting's project wins for every task", async () => {
  const { db, created } = mirrorDb({ meetingProjectId: 'p2' })
  await stageRunners.mirrored({ job: mirrorJob([{ taskId: 'a' }, { taskId: 'b' }]), db, client: mirrorClient(), csaasClient: {} })
  assert.deepEqual(created.map((r) => [r.projectId, r.projectName]), [['p2', 'Badar HMS'], ['p2', 'Badar HMS']])
})

test("mirrored: a named project is matched, and an unclear task takes the reviewer's pick", async () => {
  const { db, created } = mirrorDb()
  await stageRunners.mirrored({
    job: mirrorJob([{ taskId: 'a', needsProject: false, projectId: null }, { taskId: 'b', needsProject: true, projectId: 'p2' }]),
    db, client: mirrorClient(), csaasClient: {},
  })
  assert.deepEqual(created.map((r) => [r.projectId, r.projectName]), [['p1', 'Framework'], ['p2', 'Badar HMS']])
})

test('mirrored: an unclear task left on "No project" (or a legacy review) has no project and no name', async () => {
  const { db, created } = mirrorDb()
  await stageRunners.mirrored({ job: mirrorJob([{ taskId: 'b', needsProject: true, projectId: null }]), db, client: mirrorClient(), csaasClient: {} })
  const legacy = mirrorDb()
  await stageRunners.mirrored({ job: mirrorJob([{ taskId: 'b' }]), db: legacy.db, client: mirrorClient(), csaasClient: {} })
  for (const row of [created[0], legacy.created[0]]) {
    assert.equal(row.projectId, null)
    assert.equal(row.projectName, null)
  }
})

test('mirrored entries carry the repositoryId the row was created with (null when none)', async () => {
  const { db, created } = mirrorDb()
  db.repository = { findMany: async () => [{ id: 'r-fw', name: 'framework', url: 'https://github.com/granjur/framework' }] }
  db.projectRepos = { findMany: async () => [{ project_id: 'p1', repository_id: 'r-fw', scope: null }] }
  const out = await stageRunners.mirrored({
    job: mirrorJob([{ taskId: 'a', github: true }, { taskId: 'b', needsProject: true, projectId: null, github: true }]),
    db, client: mirrorClient(), csaasClient: {},
  })
  assert.deepEqual(created.map((r) => r.repositoryId), ['r-fw', null])
  assert.deepEqual(out.patch.dataJson.mirrored.map((m) => m.repositoryId), ['r-fw', null])
  // F4: the rule's reason rides along, so issue_syncing can say why there is no repository.
  assert.deepEqual(out.patch.dataJson.mirrored.map((m) => m.repoReason), ['only-repo', 'no-project'])
})

// ---------------------------------------------------------------------------
// Meeting notes as files (2026-09-30): reporting stage + notes message
// ---------------------------------------------------------------------------

test('reporting asks CSAAS for the report once and records it', async () => {
  const calls = []
  const csaasClient = { generateReport: async (id) => { calls.push(id); return {} } }
  const job = { id: 'j', csaasMeetingId: 'm7', dataJson: { title: 'T' } }
  const out = await stageRunners.reporting({ job, csaasClient })
  assert.deepEqual(calls, ['m7'])
  assert.equal(out.patch.dataJson.reported, true)
  assert.equal(out.patch.dataJson.reportError, undefined)
  assert.equal(out.patch.dataJson.title, 'T')
  assert.notEqual(out.advance, false)
  assert.notEqual(out.block, true)
})

test('reporting advances when the report fails, recording the error and logging once', async () => {
  const warns = []
  const realWarn = console.warn
  console.warn = (...a) => warns.push(a)
  try {
    const csaasClient = { generateReport: async () => { throw new Error('claude down') } }
    const out = await stageRunners.reporting({ job: { id: 'j', csaasMeetingId: 'm7', dataJson: {} }, csaasClient })
    assert.equal(out.patch.dataJson.reported, true)
    assert.equal(out.patch.dataJson.reportError, 'claude down')
    assert.notEqual(out.advance, false)
    assert.equal(warns.length, 1)
    assert.equal(warns[0][0], '[meetingPipeline] report failed:')
  } finally {
    console.warn = realWarn
  }
})

test('reporting does not call CSAAS again when already reported', async () => {
  let called = false
  const csaasClient = { generateReport: async () => { called = true } }
  const out = await stageRunners.reporting({
    job: { id: 'j', csaasMeetingId: 'm7', dataJson: { reported: true } }, csaasClient,
  })
  assert.equal(called, false)
  assert.equal(out.patch.dataJson.reported, true)
})

// ---- final fix wave (2026-10-01): /report is marked BEFORE it is called ----

function reportingDb() {
  const writes = []
  return { writes, db: { meetingPipelineJob: { update: async (id, patch) => { writes.push([id, structuredClone(patch)]); return {} } } } }
}

test('reporting saves reported:true on the job before it calls /report', async () => {
  const { db, writes } = reportingDb()
  let writesAtCall = null
  const csaasClient = { generateReport: async () => { writesAtCall = writes.length; return {} } }
  const job = { id: 'j', csaasMeetingId: 'm7', dataJson: { title: 'T' } }
  await stageRunners.reporting({ job, db, csaasClient })
  assert.equal(writesAtCall, 1, 'the write happened before the call')
  assert.deepEqual(writes[0], ['j', { dataJson: { title: 'T', reported: true } }])
})

test('a retry after an aborted /report (stage timeout) advances without calling it again', async () => {
  const { db, writes } = reportingDb()
  let calls = 0
  // First run: the call never returns (the worker's stage timeout abandons it).
  const hung = { generateReport: () => { calls += 1; return new Promise(() => {}) } }
  const job = { id: 'j', csaasMeetingId: 'm7', dataJson: { title: 'T' } }
  void stageRunners.reporting({ job, db, csaasClient: hung })
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 1)
  // The worker's error path keeps the saved dataJson; the retry reads it.
  const saved = writes.at(-1)[1].dataJson
  const retry = { generateReport: async () => { calls += 1; return {} } }
  const out = await stageRunners.reporting({ job: { ...job, dataJson: saved }, db, csaasClient: retry })
  assert.equal(calls, 1, '/report was not called a second time')
  assert.notEqual(out.advance, false)
  assert.equal(out.patch.dataJson.reported, true)
})

test('a retry after a thrown /report advances without calling it again', async () => {
  const { db, writes } = reportingDb()
  let calls = 0
  const realWarn = console.warn
  console.warn = () => {}
  try {
    const job = { id: 'j', csaasMeetingId: 'm7', dataJson: {} }
    const aborting = { generateReport: async () => { calls += 1; throw new Error('This operation was aborted') } }
    await stageRunners.reporting({ job, db, csaasClient: aborting })
    const out = await stageRunners.reporting({ job: { ...job, dataJson: writes.at(-1)[1].dataJson }, db, csaasClient: aborting })
    assert.equal(calls, 1)
    assert.notEqual(out.advance, false)
  } finally {
    console.warn = realWarn
  }
})

test('the /report timeout is clamped to 30 s under the worker stage timeout', async () => {
  const prev = process.env.MEETING_STAGE_TIMEOUT_MS
  const seen = []
  const csaasClient = { generateReport: async (id, opts) => { seen.push(opts?.timeoutMs); return {} } }
  const run = () => stageRunners.reporting({ job: { id: 'j', csaasMeetingId: 'm7', dataJson: {} }, db: reportingDb().db, csaasClient })
  try {
    delete process.env.MEETING_STAGE_TIMEOUT_MS
    await run() // default stage timeout 360 s -> min(300 s, 330 s)
    process.env.MEETING_STAGE_TIMEOUT_MS = '200000'
    await run() // min(300 s, 170 s)
    process.env.MEETING_STAGE_TIMEOUT_MS = '900000'
    await run() // min(300 s, 870 s)
  } finally {
    if (prev === undefined) delete process.env.MEETING_STAGE_TIMEOUT_MS
    else process.env.MEETING_STAGE_TIMEOUT_MS = prev
  }
  assert.deepEqual(seen, [300_000, 170_000, 300_000])
})

test('meetingNotesFileNames uses the UTC date, and today when the date is unusable', () => {
  assert.deepEqual(meetingNotesFileNames('2026-09-30T23:30:00Z'), {
    notes: 'meeting-notes-2026-09-30.md', report: 'meeting-report-2026-09-30.html',
  })
  assert.equal(meetingNotesFileNames(new Date('2026-01-05T00:00:00Z')).notes, 'meeting-notes-2026-01-05.md')
  const today = new Date().toISOString().slice(0, 10)
  assert.equal(meetingNotesFileNames(null).notes, `meeting-notes-${today}.md`)
  assert.equal(meetingNotesFileNames('nonsense').report, `meeting-report-${today}.html`)
})

// One channel + db fake that logs the order of sends and job writes.
function notesHarness({ notes, html, dataJson = {}, failNotes = false, startedAt = '2026-03-02T10:00:00Z' } = {}) {
  const events = []
  const sent = []
  const channel = {
    id: 'tc1',
    send: async (payload) => {
      if (payload.files && failNotes) throw new Error('upload refused')
      const id = payload.files ? 'notes-msg' : 'review-msg'
      sent.push(payload)
      events.push(`send:${id}`)
      return { id }
    },
  }
  const client = { channels: { fetch: async () => channel } }
  const db = {
    meeting: { findUnique: async () => ({ id: 'M', channelId: 'vc1', createdAt: '2020-01-01T00:00:00Z' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'tc1' }) },
    meetingRecording: { findMany: async () => [{ startedAt }] },
    meetingPipelineJob: {
      update: async (id, patch) => { events.push(`update:${patch.dataJson.notesMessageId ?? 'none'}`); return {} },
    },
  }
  const csaasClient = { fetchNotes: async () => ({ notes, html }) }
  const job = reviewJob()
  job.dataJson = { ...job.dataJson, ...dataJson }
  return { events, sent, client, db, csaasClient, job }
}

const notesMessages = (h) => h.sent.filter((p) => p.files)
const fileNames = (p) => p.files.map((f) => f.name)

test('awaiting_review posts the notes message with both files before the review', async () => {
  const h = notesHarness({ notes: '# Notes', html: '<html>r</html>' })
  const out = await stageRunners.awaiting_review(h)
  const [m] = notesMessages(h)
  assert.equal(notesMessages(h).length, 1)
  assert.equal(m.content, '**Meeting notes — T**')
  assert.deepEqual(fileNames(m), ['meeting-notes-2026-03-02.md', 'meeting-report-2026-03-02.html'])
  assert.equal(m.files[0].attachment.toString('utf8'), '# Notes')
  assert.equal(m.files[1].attachment.toString('utf8'), '<html>r</html>')
  assert.equal(out.patch.dataJson.notesMessageId, 'notes-msg')
  assert.equal(out.patch.dataJson.notesChannelId, 'tc1')
  assert.equal(out.patch.reviewMessageId, 'review-msg')
  assert.match(h.sent.at(-1).embeds[0].data.description, /Full notes are attached above\./)
  assert.equal(out.block, true)
})

test('the notes message pings nobody, whatever the title says', async () => {
  const h = notesHarness({ notes: '# Notes', html: null, dataJson: { title: '@everyone <@&123>' } })
  await stageRunners.awaiting_review(h)
  const [m] = notesMessages(h)
  assert.equal(m.content, '**Meeting notes — @everyone <@&123>**')
  assert.deepEqual(m.allowedMentions, { parse: [] })
  // The review message carries no content at all (embeds only), so nothing in it pings.
  assert.equal(h.sent.at(-1).content, undefined)
})

test('awaiting_review attaches only the notes when there is no html', async () => {
  const h = notesHarness({ notes: 'just notes', html: null })
  await stageRunners.awaiting_review(h)
  assert.deepEqual(fileNames(notesMessages(h)[0]), ['meeting-notes-2026-03-02.md'])
})

test('awaiting_review attaches only the report when there are no notes', async () => {
  const h = notesHarness({ notes: '', html: '<html></html>' })
  const out = await stageRunners.awaiting_review(h)
  assert.deepEqual(fileNames(notesMessages(h)[0]), ['meeting-report-2026-03-02.html'])
  assert.equal(out.patch.dataJson.notesMessageId, 'notes-msg')
})

test('awaiting_review posts no notes message when notes and html are both empty', async () => {
  const h = notesHarness({ notes: '', html: null })
  const out = await stageRunners.awaiting_review(h)
  assert.equal(notesMessages(h).length, 0)
  assert.equal(out.patch.dataJson.notesMessageId, undefined)
  assert.doesNotMatch(h.sent[0].embeds[0].data.description, /attached above/)
  assert.equal(out.patch.reviewMessageId, 'review-msg')
})

test('awaiting_review uses the meeting creation date when there is no recording', async () => {
  const h = notesHarness({ notes: 'n', html: null })
  h.db.meetingRecording.findMany = async () => []
  await stageRunners.awaiting_review(h)
  assert.deepEqual(fileNames(notesMessages(h)[0]), ['meeting-notes-2020-01-01.md'])
})

test('awaiting_review saves notesMessageId before it sends the review', async () => {
  const h = notesHarness({ notes: 'n', html: '<p/>' })
  await stageRunners.awaiting_review(h)
  assert.deepEqual(h.events, ['send:notes-msg', 'update:notes-msg', 'send:review-msg'])
})

test('awaiting_review does not post the notes again when notesMessageId is already set (a retry)', async () => {
  const h = notesHarness({ notes: 'n', html: '<p/>', dataJson: { notesMessageId: 'earlier' } })
  const out = await stageRunners.awaiting_review(h)
  assert.equal(notesMessages(h).length, 0)
  assert.equal(h.sent.length, 1)
  assert.equal(out.patch.dataJson.notesMessageId, 'earlier')
  assert.match(h.sent[0].embeds[0].data.description, /Full notes are attached above\./)
})

test('awaiting_review still posts the review when the notes send throws', async () => {
  const warns = []
  const realWarn = console.warn
  console.warn = (...a) => warns.push(a)
  try {
    const h = notesHarness({ notes: 'n', html: '<p/>', failNotes: true })
    const out = await stageRunners.awaiting_review(h)
    assert.equal(out.patch.reviewMessageId, 'review-msg')
    assert.equal(out.patch.dataJson.notesMessageId, undefined)
    assert.equal(out.block, true)
    assert.doesNotMatch(h.sent[0].embeds[0].data.description, /attached above/)
    assert.ok(warns.some((w) => /failed to post meeting notes/.test(w[0])))
  } finally {
    console.warn = realWarn
  }
})

// ---- document jobs (/tasks-from-doc) ----

const docJob = (extra = {}, dataExtra = {}) => ({
  id: 'j', meetingId: 'm', guildConfigId: 'g', csaasMeetingId: 'csaas-1',
  createdAt: new Date('2026-09-07T10:00:00Z'),
  dataJson: { source: 'document', reviewChannelId: 'tc1', documentName: 'spec.pdf', title: 'spec', ...dataExtra },
  ...extra,
})

test('created for a document job: titled from dataJson.title and the job date, roster is all verified members, dataJson kept', async () => {
  let createArgs = null
  let rosterQuery = null
  const db = {
    meeting: { findUnique: async () => ({ id: 'm', csaasMeetingId: null, transcript: 'text' }) },
    // A document job has no recordings; reading them would be a bug.
    meetingRecording: { findMany: async () => { throw new Error('no recordings for a document job') } },
    guildMember: { findMany: async (q) => { rosterQuery = q; return [{ discordId: 'u1', email: 'ali@x.io' }, { discordId: 'u2', email: 'sara@x.io' }] } },
    getGuildConfigById: async () => ({ guildId: 'g' }),
  }
  const csaasClient = { createMeeting: async (a) => { createArgs = a; return { meeting_id: 'csaas-new' } } }
  const client = { guilds: { fetch: async () => ({ id: 'g', members: { fetch: async (id) => ({ displayName: id === 'u1' ? 'Ali' : 'Sara' }) } }) } }
  const out = await stageRunners.created({ job: docJob({ csaasMeetingId: null }), db, client, csaasClient })
  const when = formatMeetingDate(new Date('2026-09-07T10:00:00Z'))
  assert.equal(out.patch.dataJson.title, `spec — ${when}`)
  assert.equal(createArgs.title, `spec — ${when}`)
  assert.deepEqual(createArgs.participants, ['Ali', 'Sara'])
  assert.deepEqual(out.patch.dataJson.roster.map((r) => r.ref), ['u1', 'u2'])
  assert.equal(rosterQuery.where.verifiedAt.not, null)
  assert.equal(out.patch.csaasMeetingId, 'csaas-new')
  assert.equal(out.patch.dataJson.source, 'document')
  assert.equal(out.patch.dataJson.reviewChannelId, 'tc1')
  assert.equal(out.patch.dataJson.documentName, 'spec.pdf')
})

test('transcribing for a document job sends the transcript to analyze-live as one segment and never touches /transcribe', async () => {
  let args = null
  const db = { meeting: { findUnique: async () => ({ id: 'm', transcript: 'Ali: ship it by Friday.' }) } }
  const csaasClient = {
    analyzeLive: async (id, payload) => { args = [id, payload]; return { summary: 'ok' } },
    transcribeSegment: async () => { throw new Error('transcribeSegment must not be called') },
  }
  const out = await stageRunners.transcribing({ job: docJob(), db, csaasClient, client: {} })
  assert.deepEqual(args, ['csaas-1', {
    meetingNotes: { segment_0: { time_range: '', transcription: 'Ali: ship it by Friday.' } },
    totalDurationSec: 0,
  }])
  assert.equal(out.patch.dataJson.liveTranscript, true)
  assert.deepEqual(out.patch.dataJson.analysis, { summary: 'ok' })
  assert.equal(out.patch.dataJson.source, 'document')
  assert.notEqual(out.advance, false)
})

test('transcribing for a document job rethrows an analyze-live failure, never falls back or flags liveTranscriptFailed', async () => {
  const db = { meeting: { findUnique: async () => ({ id: 'm', transcript: 'some text' }) } }
  const csaasClient = {
    analyzeLive: async () => { throw new Error('csaas 502') },
    transcribeSegment: async () => { throw new Error('transcribeSegment must not be called') },
  }
  await assert.rejects(() => stageRunners.transcribing({ job: docJob(), db, csaasClient, client: {} }), /csaas 502/)
})

test('transcribing for a document job with an empty transcript throws', async () => {
  const db = { meeting: { findUnique: async () => ({ id: 'm', transcript: '  ' }) } }
  const csaasClient = { analyzeLive: async () => { throw new Error('must not be called') } }
  await assert.rejects(() => stageRunners.transcribing({ job: docJob(), db, csaasClient, client: {} }), /document job has no text/)
})

test('resolveMeetingChannel: a document job uses dataJson.reviewChannelId even with no meetingchannel row', async () => {
  const db = {
    meeting: { findUnique: async () => ({ id: 'm', channelId: 'tc1' }) },
    meetingChannel: { findFirst: async () => { throw new Error('no lookup for a document job') } },
  }
  const sent = { id: 'tc1', send: async () => {} }
  const client = { channels: { fetch: async (id) => (id === 'tc1' ? sent : null) } }
  assert.equal(await resolveMeetingChannel(client, db, docJob()), sent)
})

test('resolveMeetingChannel: a recorded meeting keeps the meetingchannel lookup, ignoring reviewChannelId', async () => {
  const db = {
    meeting: { findUnique: async () => ({ id: 'm', channelId: 'vc1' }) },
    meetingChannel: { findFirst: async () => ({ textChannelId: 'text-mc' }) },
  }
  const fetched = []
  const client = { channels: { fetch: async (id) => { fetched.push(id); return { id, send: async () => {} } } } }
  const ch = await resolveMeetingChannel(client, db, { meetingId: 'm', guildConfigId: 'g', dataJson: { reviewChannelId: 'elsewhere' } })
  assert.equal(ch.id, 'text-mc')
  assert.deepEqual(fetched, ['text-mc'])
})

test('awaiting_review for a document job posts into dataJson.reviewChannelId with no meetingchannel row', async () => {
  const sends = []
  const channel = { id: 'tc1', send: async (p) => { sends.push(p); return { id: `msg${sends.length}` } } }
  const db = {
    meeting: { findUnique: async () => ({ id: 'm', channelId: 'tc1' }) },
    meetingChannel: { findFirst: async () => { throw new Error('no lookup for a document job') } },
    meetingRecording: { findMany: async () => [] },
    project: { findMany: async () => [] },
  }
  const csaasClient = { fetchNotes: async () => ({ notes: null, html: null }) }
  const client = { channels: { fetch: async () => channel } }
  const job = docJob({}, { tasks: [{ task_id: 1, goal_of_task: 'Do it' }], assignments: [], roster: [] })
  const out = await stageRunners.awaiting_review({ job, db, client, csaasClient })
  assert.equal(out.patch.reviewMessageId, 'msg1')
  assert.equal(out.patch.dataJson.reviewChannelId, 'tc1')
})

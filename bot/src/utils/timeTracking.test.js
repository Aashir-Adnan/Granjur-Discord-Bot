import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDuration, formatDuration, entryMinutes, runawayState, weekStart, dayStart, rangeFor,
  sumByTask, sumByPerson, overlaps, DEFAULT_REMIND_HOURS, DEFAULT_CAP_HOURS,
} from './timeTracking.js'

test('parseDuration accepts every shape a person will type', () => {
  assert.equal(parseDuration('2h30m'), 150)
  assert.equal(parseDuration('2h 30m'), 150)
  assert.equal(parseDuration('2.5h'), 150)
  assert.equal(parseDuration('90m'), 90)
  assert.equal(parseDuration('90'), 90)
  assert.equal(parseDuration('1:30'), 90)
  assert.equal(parseDuration('  2H  '), 120)
})

test('parseDuration refuses what is not a positive duration, and has NO upper bound', () => {
  for (const bad of ['', '   ', 'soon', '0', '0m', '-5', '-2h', 'NaN', 'Infinity', '1:xx', null, undefined]) {
    assert.equal(parseDuration(bad), null, String(bad))
  }
  // Deliberate: a long entry is somebody's real week, not an error.
  assert.equal(parseDuration('200h'), 12000)
  assert.equal(parseDuration('5000m'), 5000)
})

test('formatDuration reads the way a person says it', () => {
  assert.equal(formatDuration(200), '3h 20m')
  assert.equal(formatDuration(120), '2h')
  assert.equal(formatDuration(45), '45m')
  assert.equal(formatDuration(0), '0m')
  assert.equal(formatDuration(null), '—')
  assert.equal(formatDuration(undefined), '—')
})

test('entryMinutes rounds, never goes negative, and is null while the entry is open', () => {
  const at = (s) => new Date(`2026-09-22T${s}:00.000Z`)
  assert.equal(entryMinutes(at('09:00'), at('10:30')), 90)
  assert.equal(entryMinutes(at('09:00'), null), null)
  assert.equal(entryMinutes(at('10:00'), at('09:00')), 0, 'a clock skew must not invent negative time')
  assert.equal(entryMinutes(new Date('2026-09-22T09:00:00.000Z'), new Date('2026-09-22T09:00:29.000Z')), 0)
  assert.equal(entryMinutes(new Date('2026-09-22T09:00:00.000Z'), new Date('2026-09-22T09:00:31.000Z')), 1)
})

test('runawayState escalates ok -> remind -> stop, and stop wins', () => {
  const start = new Date('2026-09-22T00:00:00.000Z')
  const after = (h) => new Date(start.getTime() + h * 3600000)
  const opts = { remindAfterMin: 360, capMin: 720 }
  const open = { clockInAt: start, clockOutAt: null, remindedAt: null }
  assert.equal(runawayState(open, after(1), opts), 'ok')
  assert.equal(runawayState(open, after(6), opts), 'remind')
  assert.equal(runawayState(open, after(13), opts), 'stop')
  assert.equal(runawayState({ ...open, remindedAt: after(6) }, after(7), opts), 'ok', 'reminded once, not every pass')
  assert.equal(runawayState({ ...open, remindedAt: after(6) }, after(13), opts), 'stop', 'the cap still applies')
  assert.equal(runawayState({ ...open, clockOutAt: after(1) }, after(13), opts), 'ok', 'a closed entry is never chased')
})

test('runawayState falls back to the documented defaults when no options are given', () => {
  const start = new Date('2026-09-22T00:00:00.000Z')
  const after = (h) => new Date(start.getTime() + h * 3600000)
  const open = { clockInAt: start, clockOutAt: null, remindedAt: null }
  assert.equal(runawayState(open, after(5.9)), 'ok')
  assert.equal(runawayState(open, after(6)), 'remind')
  assert.equal(runawayState(open, after(12)), 'stop')
})

test('weeks start Monday in the guild timezone', () => {
  // A Sunday in UTC belongs to the week that began the previous Monday.
  assert.equal(weekStart(new Date('2026-09-20T12:00:00.000Z'), 'UTC').toISOString(), '2026-09-14T00:00:00.000Z')
  assert.equal(weekStart(new Date('2026-09-21T00:30:00.000Z'), 'UTC').toISOString(), '2026-09-21T00:00:00.000Z')
})

test('rangeFor covers today, week, month and all', () => {
  const now = new Date('2026-09-22T15:00:00.000Z')
  assert.equal(rangeFor('today', now, 'UTC').since.toISOString(), '2026-09-22T00:00:00.000Z')
  assert.equal(rangeFor('week', now, 'UTC').since.toISOString(), '2026-09-21T00:00:00.000Z')
  assert.equal(rangeFor('month', now, 'UTC').since.toISOString(), '2026-09-01T00:00:00.000Z')
  assert.equal(rangeFor('all', now, 'UTC').since.getTime(), 0)
  assert.equal(rangeFor('nonsense', now, 'UTC').label, rangeFor('week', now, 'UTC').label, 'unknown falls back to this week')
})

test('sums group by task and by person, ignoring entries still running', () => {
  const entries = [
    { taskId: 't1', discordId: 'u1', minutes: 60 },
    { taskId: 't1', discordId: 'u2', minutes: 30 },
    { taskId: null, discordId: 'u1', minutes: 15 },
    { taskId: 't1', discordId: 'u1', minutes: null },
  ]
  assert.equal(sumByTask(entries).get('t1'), 90)
  assert.equal(sumByTask(entries).get(null), 15)
  assert.equal(sumByPerson(entries).get('u1'), 75)
  assert.equal(sumByPerson(entries).get('u2'), 30)
})

test('overlaps reports a person double-booked, and never pairs two different people', () => {
  const e = (id, discordId, from, to) => ({ id, discordId, clockInAt: new Date(from), clockOutAt: new Date(to) })
  const a = e('a', 'u1', '2026-09-22T09:00:00Z', '2026-09-22T11:00:00Z')
  const b = e('b', 'u1', '2026-09-22T10:00:00Z', '2026-09-22T12:00:00Z')
  const c = e('c', 'u2', '2026-09-22T10:00:00Z', '2026-09-22T12:00:00Z')
  const d = e('d', 'u1', '2026-09-22T11:00:00Z', '2026-09-22T12:00:00Z')
  assert.deepEqual(overlaps([a, b, c]).map((p) => p.map((x) => x.id)), [['a', 'b']])
  assert.deepEqual(overlaps([a, d]), [], 'touching at the boundary is not an overlap')
})

test('the defaults are the documented ones', () => {
  assert.equal(DEFAULT_REMIND_HOURS, 6)
  assert.equal(DEFAULT_CAP_HOURS, 12)
})

// ---- Additions: timezones. Every expected instant below was worked out by hand
// from the zone's UTC offset, not taken from the implementation's output.

const iso = (d) => d.toISOString()

test('an unset or unknown timezone means UTC', () => {
  const now = new Date('2026-09-22T15:00:00.000Z')
  for (const tz of [undefined, null, '', 'Not/AZone']) {
    assert.equal(iso(dayStart(now, tz)), '2026-09-22T00:00:00.000Z', String(tz))
    assert.equal(iso(weekStart(now, tz)), '2026-09-21T00:00:00.000Z', String(tz))
    assert.equal(iso(rangeFor('month', now, tz).since), '2026-09-01T00:00:00.000Z', String(tz))
  }
})

test('milliseconds on the input do not shift a boundary', () => {
  assert.equal(iso(dayStart(new Date('2026-09-22T00:00:00.999Z'), 'UTC')), '2026-09-22T00:00:00.000Z')
  assert.equal(iso(weekStart(new Date('2026-09-21T00:00:00.001Z'), 'UTC')), '2026-09-21T00:00:00.000Z')
})

test('Asia/Karachi (UTC+5, no DST): the day, week and month roll over at local midnight', () => {
  const tz = 'Asia/Karachi'
  // 20:00Z on Tue 22 Sep is already 01:00 on Wed 23 Sep in Karachi.
  assert.equal(iso(dayStart(new Date('2026-09-22T20:00:00.000Z'), tz)), '2026-09-22T19:00:00.000Z')
  // 18:59:59Z is still 23:59:59 on the 22nd; 19:00:00Z is the 23rd.
  assert.equal(iso(dayStart(new Date('2026-09-22T18:59:59.000Z'), tz)), '2026-09-21T19:00:00.000Z')
  assert.equal(iso(dayStart(new Date('2026-09-22T19:00:00.000Z'), tz)), '2026-09-22T19:00:00.000Z')
  // Mon 21 Sep 00:00 PKT = Sun 20 Sep 19:00Z. 00:30 PKT Monday is in the new week...
  assert.equal(iso(weekStart(new Date('2026-09-20T19:30:00.000Z'), tz)), '2026-09-20T19:00:00.000Z')
  // ...but 23:30 PKT Sunday is still the week that began Mon 14 Sep 00:00 PKT = 13 Sep 19:00Z.
  assert.equal(iso(weekStart(new Date('2026-09-20T18:30:00.000Z'), tz)), '2026-09-13T19:00:00.000Z')
  // 01:00 PKT on 1 Oct = 20:00Z on 30 Sep; the month began 1 Oct 00:00 PKT = 30 Sep 19:00Z.
  assert.equal(iso(rangeFor('month', new Date('2026-09-30T20:00:00.000Z'), tz).since), '2026-09-30T19:00:00.000Z')
  assert.equal(iso(rangeFor('today', new Date('2026-09-22T20:00:00.000Z'), tz).since), '2026-09-22T19:00:00.000Z')
  assert.equal(iso(rangeFor('week', new Date('2026-09-22T20:00:00.000Z'), tz).since), '2026-09-20T19:00:00.000Z')
})

test('Asia/Kolkata (UTC+5:30): a half-hour offset is honoured', () => {
  // 19:00Z = 00:30 IST on 23 Sep; that day began 18:30Z on the 22nd.
  assert.equal(iso(dayStart(new Date('2026-09-22T19:00:00.000Z'), 'Asia/Kolkata')), '2026-09-22T18:30:00.000Z')
})

test('America/New_York in summer (EDT, UTC-4)', () => {
  const tz = 'America/New_York'
  const now = new Date('2026-09-22T15:00:00.000Z') // 11:00 EDT, Tuesday
  assert.equal(iso(dayStart(now, tz)), '2026-09-22T04:00:00.000Z')
  assert.equal(iso(weekStart(now, tz)), '2026-09-21T04:00:00.000Z')
  assert.equal(iso(rangeFor('month', now, tz).since), '2026-09-01T04:00:00.000Z')
  // 03:59:59Z is 23:59:59 EDT on the 22nd; 04:00:00Z is the 23rd.
  assert.equal(iso(dayStart(new Date('2026-09-23T03:59:59.000Z'), tz)), '2026-09-22T04:00:00.000Z')
  assert.equal(iso(dayStart(new Date('2026-09-23T04:00:00.000Z'), tz)), '2026-09-23T04:00:00.000Z')
})

test('America/New_York across the autumn change (clocks go back Sun 1 Nov 2026)', () => {
  const tz = 'America/New_York'
  // Midnight on Sunday 1 Nov is still EDT (04:00Z), though by 10:00 the zone is EST (UTC-5).
  const sunday = new Date('2026-11-01T15:00:00.000Z') // 10:00 EST
  assert.equal(iso(dayStart(sunday, tz)), '2026-11-01T04:00:00.000Z')
  // That Sunday's week began Mon 26 Oct 00:00 EDT = 04:00Z, not an hour late.
  assert.equal(iso(weekStart(sunday, tz)), '2026-10-26T04:00:00.000Z')
  assert.equal(iso(rangeFor('month', sunday, tz).since), '2026-11-01T04:00:00.000Z')
  // Monday 2 Nov is wholly EST: midnight is 05:00Z, and it starts its own week.
  const monday = new Date('2026-11-02T12:00:00.000Z')
  assert.equal(iso(dayStart(monday, tz)), '2026-11-02T05:00:00.000Z')
  assert.equal(iso(weekStart(monday, tz)), '2026-11-02T05:00:00.000Z')
  // Midweek in EST the week still starts on the EST Monday.
  assert.equal(iso(weekStart(new Date('2026-11-04T15:00:00.000Z'), tz)), '2026-11-02T05:00:00.000Z')
  // A month that spans the change starts in EDT; the following month in EST.
  assert.equal(iso(rangeFor('month', new Date('2026-11-15T12:00:00.000Z'), tz).since), '2026-11-01T04:00:00.000Z')
  assert.equal(iso(rangeFor('month', new Date('2026-12-15T12:00:00.000Z'), tz).since), '2026-12-01T05:00:00.000Z')
})

test('America/New_York across the spring change (clocks go forward Sun 8 Mar 2026)', () => {
  const tz = 'America/New_York'
  // Midnight on Sunday 8 Mar is still EST (05:00Z), though by 11:00 the zone is EDT.
  const sunday = new Date('2026-03-08T15:00:00.000Z') // 11:00 EDT
  assert.equal(iso(dayStart(sunday, tz)), '2026-03-08T05:00:00.000Z')
  // Its week began Mon 2 Mar 00:00 EST = 05:00Z.
  assert.equal(iso(weekStart(sunday, tz)), '2026-03-02T05:00:00.000Z')
  // The following Monday is EDT: midnight is 04:00Z, and the whole week keys off it.
  assert.equal(iso(dayStart(new Date('2026-03-09T12:00:00.000Z'), tz)), '2026-03-09T04:00:00.000Z')
  assert.equal(iso(weekStart(new Date('2026-03-11T15:00:00.000Z'), tz)), '2026-03-09T04:00:00.000Z')
  assert.equal(iso(weekStart(new Date('2026-03-15T15:00:00.000Z'), tz)), '2026-03-09T04:00:00.000Z')
  // March began in EST (05:00Z); April in EDT (04:00Z).
  assert.equal(iso(rangeFor('month', new Date('2026-03-20T12:00:00.000Z'), tz).since), '2026-03-01T05:00:00.000Z')
  assert.equal(iso(rangeFor('month', new Date('2026-04-10T12:00:00.000Z'), tz).since), '2026-04-01T04:00:00.000Z')
})

test('rangeFor reaches one minute past now, so an entry made this second is included', () => {
  const now = new Date('2026-09-22T15:00:00.000Z')
  for (const k of ['today', 'week', 'month', 'all']) {
    assert.equal(iso(rangeFor(k, now, 'UTC').until), '2026-09-22T15:01:00.000Z', k)
  }
  assert.equal(rangeFor('TODAY ', now, 'UTC').label, 'today', 'the keyword is trimmed and case-insensitive')
})

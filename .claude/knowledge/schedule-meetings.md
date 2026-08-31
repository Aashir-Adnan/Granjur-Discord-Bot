# `/schedule`, `/meetings`, `/setup` — scheduled meetings

## `/schedule` flow ([bot/src/commands/schedule.js](../../bot/src/commands/schedule.js))

Roles: `CEO` / `Server Manager` ([command-config.json](../../bot/src/config/command-config.json)).

1. **`/schedule topic:<text> when:<text>`** — both options **required**. `when` has
   **autocomplete** that previews the resolved date (in the server timezone) as you type.
2. **Step 2** — member select `schedule_members`. Options use `member.displayName`
   (nickname → global name → username) as the label, `@username` as the description,
   sorted, first 25.
3. **Step 3** — confirm buttons `schedule_confirm` / `schedule_cancel` →
   `db.scheduledMeeting.create`.

State between steps: in-memory `flowStore` (`userId:guildId:schedule`), 30-min TTL.

`voiceChannelId` is always `null` (no step sets it) ⇒ `recordingEnabled` stored
`false`. Recording still happens because `meetingAutoChannel` creates a fresh channel
and calls `startMeetingRecording` regardless.

## `/meetings` — list / reschedule / cancel ([bot/src/commands/meetings.js](../../bot/src/commands/meetings.js))

`/meetings` → select menu of your upcoming non-cancelled meetings
(`db.scheduledMeeting.findUpcoming`). CEO / Server Manager / owner / ManageGuild see
everyone's (`isManager()` in the file). Select one → embed + buttons:
- `meetings_cancel:<id>` → `db.scheduledMeeting.update(id, { cancelled: true })`.
- `meetings_reschedule:<id>` → modal `meetings_reschedule_modal:<id>` (one `when`
  field) → `parseWhen` → `update(id, { scheduledAt, reminderSentAt: null })` (nulling
  reminder so the 10-min ping re-fires).

`meetings_reschedule` is in `noDeferComponentIds` in index.js (it opens a modal).

## `/setup` — server config ([bot/src/commands/setup.js](../../bot/src/commands/setup.js))

Roles: `CEO` / `Server Manager`. `/setup` with no options shows current settings;
`/setup timezone:<IANA>` validates + saves `guildConfig.timezone`. `timezone` option
has autocomplete over `Intl.supportedValuesOf("timeZone")`. Extend this command for
future server-wide settings.

## Timezone model ([bot/src/utils/timezone.js](../../bot/src/utils/timezone.js))

- Stored on `guildConfig.timezone` (IANA string, nullable). Migration
  `010_guild_timezone.sql`.
- `guildZone(cfg)` → `cfg.timezone` if valid, else the **bot host's** local zone.
- `zonedWallTimeToDate({y,mo,d,h,mi}, zone)` converts a wall-clock time in `zone` to a
  UTC `Date` via an iterative Intl-offset solve (handles DST). `partsInZone`,
  `nowInZone`, `isValidZone`, `zoneLabel` round it out. **No dependency.**
- Per-guild only — no per-user override (decided 2026-08-31).

## Time parsing ([bot/src/utils/parseWhen.js](../../bot/src/utils/parseWhen.js))

`parseWhen(input, now = new Date(), zone = localZone()) -> Date | null`. Wall-clock
inputs are interpreted in `zone`; `"in 2 hours"` and `"...T14:00Z"` are absolute.
Handles ISO, relative (`in 1h30m`, `in 1 day 6 hours`, `in 2 weeks`),
`today/tonight/tomorrow [at] <time>`, weekdays (`next fri 14:00`), month/day
(`mar 3 2pm`), bare times (`3pm` → today or tomorrow if past). Date-only → 09:00.

Callers pass the guild zone: `schedule.js` (execute + autocomplete), `meetings.js`
(reschedule modal), `setup.js` (the "tomorrow 3pm means…" sample).

## Displaying meeting times — ALWAYS Discord timestamps

[bot/src/utils/discordTime.js](../../bot/src/utils/discordTime.js):
`discordTime(date,style)`, `discordRelative`, `discordDateTime` (`<t:..:F> (<t:..:R>)`),
`plainDateTime(date, zone?)` (plain text — autocomplete labels / logs only).
`<t:UNIX:style>` renders in each viewer's own zone. Call sites using it: schedule
embeds, `meetings.js`, `meetingReminder.js`, `fetch-my.js`, `dashboard.js`.
NOT `admin-panel.js` (times inside a ``` code block — `<t:>` won't resolve there).

## Autocomplete plumbing

`interaction.isAutocomplete()` routed in [bot/src/index.js](../../bot/src/index.js)
(before the deferReply block — autocomplete must never be deferred) →
`handleAutocomplete` in [bot/src/commands/index.js](../../bot/src/commands/index.js) →
the command module's `autocomplete(interaction)` export. Commands: `schedule.when`,
`setup.timezone`.

## The two 60s loops that consume `scheduledmeeting`

- [meetingReminder.js](../../bot/src/services/meetingReminder.js) — 10-min-out ping,
  sets `reminderSentAt`. Skips `cancelled` rows.
- [meetingAutoChannel.js](../../bot/src/services/meetingAutoChannel.js) —
  `findDueToStart`: `scheduledAt` between `now-30min` and `now`, `autoChannelId IS
  NULL`, `cancelled = FALSE` → private voice+text channel, join, record. The 30-min
  floor (`MISSED_GRACE_MS`) stops a long downtime from spawning a flood of channels.

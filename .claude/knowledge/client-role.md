# The Client role

Built on branch `feat/client-role`. Read this before touching `/invite`, `/verify`,
`/approve`, `/backlog`, `/set-roles`, `/project-members`, `/project-setup`,
`services/clientAccess.js`, `services/clientRequest.js`, `services/clientManual.js`,
`config/commands.js`, `services/dailyTimeReport.js`, or `commands/client-request.js` /
`commands/client-tracking.js`.

The design record is `docs/superpowers/specs/2026-09-24-client-role-design.md`. This file
describes the code as built; read it alongside `.claude/knowledge/project-sections.md`
(builds on that branch's role model) — `[[project-sections]]`.

## The one rule everything else follows

**A client never receives the `Verified` role.** Every channel a team member sees is
granted to `Verified` (directly or through the project role), so a client without it
sees nothing by construction — nothing new has to be remembered when the next channel
or command is added. What a client *can* see (the global support pair, their project's
support pair) is then granted explicitly through the `Client` role and per-member
overwrites, and the list of places that grant it is short and enumerated below. This is
enforced at the one place a client is ever approved (`approveMember`, below) rather than
audited after the fact.

## `guildmember.kind` vs the Discord role

`guildmember.kind VARCHAR(16) NOT NULL DEFAULT 'staff'` (`staff` | `client`, migration
`025_client_role.sql`) is a **second, independent** signal from the `Client` Discord
role. Discord enforces channel access through the role; `kind` is what the bot's own
logic consults wherever it iterates the member roster without touching Discord's
permission system at all — `dailyTimeReport.js`, `/time-report`, `/approve`'s and
`/backlog`'s holding list. The two must never disagree in practice (`approveMember`
sets both together), but they answer different questions: the role is what Discord
shows the user; `kind` is what a database query filters on without an API round-trip.
`pendinginvite.kind` carries the same value from `/invite` through to the member row
memberAdd.js copies it onto.

### Daily report and `/time-report`: the exclusion, and the one that needed none

`dailyTimeReport.js`'s `runDailyReportPass`, after reading the approved roster:

```js
const staffRows = (rows || []).filter((r) => r?.kind !== 'client')
const members = await hydrateRoster(guild, staffRows)
```

A client has no time to report and must not appear as a permanent `0m` line — and
`kind` defaults to `'staff'` for every row written before migration 025, so nothing
already in the database silently disappears from the report. `/time-report` needed
**no equivalent change**: its per-person listing is built from `clockentry` rows, and a
client has none, so the existing query already excludes them without a filter.

## Getting in: `/invite`, `/verify`, two acceptance paths

`/invite` gains an optional `client:true`, which writes the `pendinginvite` row with
`kind='client'`. **`/invite` itself runs no email-domain check** — it never did, and the
design's "the domain check is skipped for a client" describes a check that is not there
(`isAllowedEmail` and `allowedDomains` were dead imports in `invite.js` until this was
noticed; they are gone). Acceptance of an outside email happens entirely in `/verify`,
below. Member join (`events/memberAdd.js`) copies `kind` onto the `guildmember` row it
upserts when the join matches the invite by email.

`/verify` accepts an email when the ordinary `isAllowedEmail(email)` holds, **or** when
`clientEmailAccess()` (`bot/src/utils/clientEmail.js`) says the email is a client's —
one of two paths, checked in order:

1. **the caller's own `guildmember` row already says `kind='client'`** for this email —
   the normal case, where `memberAdd.js`'s join already matched the invite; or
2. **an unclaimed `pendinginvite` row** with `kind='client'` names this email — the join
   did not match (the documented weak spot when the bot lacks Manage Server). Verifying
   claims it: `handleOtpModal` deletes the `pendinginvite` row by its invite code and
   sets the member's `kind`/`email` from the OTP row's email.

Either way the person lands in Holding exactly as staff do — nothing else in `/verify`
changes, and a client is never told apart from staff until `/approve`.

`handleOtpModal(interaction, { db, getConfig, notify })`'s `notify` seam exists so a
test can exercise the client-vs-staff branching (which calls `clientEmailAccess`, which
touches the database) without reaching the real `notifyBacklogUpdate` dynamic import,
which calls the real `getOrCreateGuildConfig` internally. Production passes `notify:
null` and keeps today's dynamic-import behaviour; a test always passes a fake.

## Approval: the shared `approveMember`

`/approve` and `/backlog` both approve members; they cannot drift because both call the
one function, `approveMember` in `bot/src/services/approval.js` — the same reason they
already shared `MANAGED_ROLES`. Its header comment states the rule this file opens
with: "a client never receives Verified."

For a holding member whose row has `kind='client'`, the picker step is replaced by a
single confirmation. On accepting (`approveMember({ ..., asClient: true })`):

1. `ensureSupportChannels` (below) runs first — the role and the global support pair are
   created on demand, since the live server will never be re-inited;
2. the member gets `Client`, loses `Holding`, and **never gets `Verified`**;
3. `guildmember` is written `status='approved', kind='client'` — `roleIds` is left alone,
   since it tracks managed staff roles a client has none of.

A staff approval (`asClient: false`) is the picker path as before, with `kind='staff'`
now written explicitly.

`/set-roles` refuses to act on a member holding `Client` (`memberIsClient`, both add and
remove branches): *"This member is a client and holds no staff roles. To make them
staff, remove the Client role by hand and run /approve."* Conversion between client and
staff is deliberately not automated — it is rare, and an automated version risks handing
someone either every channel or none.

## The command gate: deny-by-default, `clientCommands`

`config/commands.js`'s `canUseCommand` is **deny-by-default for a member holding
`Client`**: the guild owner and Manage Server bypasses are checked first (a client never
has them), then `memberIsClient(member, clientRoleId)` — if true, the *only* question is
whether `commandName` is in `getClientCommands()` (`command-config.json`'s
`clientCommands: ["verify", "report-issue", "request-feature", "my-requests",
"request-report"]`). This runs **before** the command's own `commandRoles` entry is even
read, which is what closes commands with an empty role list (`close-feature`,
`resolve-bug` — empty means "anyone" for staff, but never for a client) and every
command absent from the map entirely.

`memberIsClient` is the **stored-id-then-name rule**: it checks the member's roles by
the stored `clientRoleId` first (survives the role being renamed by hand), and falls
back to matching the role by its name (`ROLE_CLIENT`, `'Client'`) — the same pattern
`roleGate.js` established for `Verified`. The pinned test for this is a client held by
stored id whose role was renamed: still denied every command outside `clientCommands`.

Client commands themselves are gated on `Client` in `commandRoles`. That gate is the
bot's, not Discord's: Discord still offers `/report-issue` and the rest to everyone, so
**staff are refused if they try** — and leadership with Manage Server passes
`canUseCommand`'s bypass before the client check is ever reached, so they *can* run
them. Nothing hides a client command from a staff member's command list.

`handleAutocomplete` carries the same gate as `handleCommand`, through
`autocompleteAllowed(member, commandName, { clientRoleId })`. Autocomplete answers from
the database before any command body runs — project names, task titles, doc pages — so
a gate on `execute` alone handed a client the whole server through the option list. A
client reaching the autocomplete of anything outside `getClientCommands()` gets an empty
list. `memberProjectIdsOf` (`utils/timeAccess.js`) drops `role: 'client'` rows for the
same reason: a client membership opens that project's two support channels, never its
task list in /clock-in's picker.

## The support pair: `ensureSupportChannels`

`bot/src/services/clientAccess.js` owns the global `🛟 Support` category and its two
channels (`support` text, `support-voice` voice) plus the `Client` role itself
(`ensureClientRole`). Everything is **id-first**:

- `findRole(guild, id, name)` checks the stored id, only falling back to a name match
  when no id resolves — "the id wins so a hand-rename still resolves."
- `byStoredId(guild, id, type)` for a channel: a stored id that no longer resolves is
  treated as **missing**, never as "go find it by name."
- `byName(...)` is the **name fallback used only when nothing is stored at all** — a
  bare `support` channel under the support category, for the very first run before any
  id has ever been written.

Repair is **presence-only**, exactly like the project-section repair in
`project-sections.md`: `repairOverwrites` adds whichever of `@everyone`-deny,
`Client`-allow, `Verified`-allow the channel is missing, one `permissionOverwrites.edit`
per missing id, never a whole-array replace.

### The three holes `Verified` does not close: `denyClientOnPublicChannels`

"A client without `Verified` sees nothing" is true of everything granted to `Verified`
— but `/init` grants **`@everyone: ViewChannel`** on three things, and a client is an
ordinary guild member, so `@everyone` reaches them: the onboarding channel
(`cfg.onboardingChannelId`), the whole `📜 Rules` category *and its children*, and
`#announcements-all`. `denyClientOnPublicChannels(guild, cfg, clientRoleId)` in
`clientAccess.js` adds `{ ViewChannel: false }` for the `Client` role on exactly those,
**presence-only** like `repairOverwrites` (skip if any overwrite for that role id is
already there, one id per `permissionOverwrites.edit`, explicit `OverwriteType.Role`).
It runs from `ensureSupportChannels`, so `/init`, `/setup` and the first client approval
all close it, and returns the channel names it newly denied (`result.denied`).

Someone still in **Holding** is unaffected: they do not hold `Client` yet, and
onboarding is the one channel they need. This is also what makes the pinned manual's
"you see this support channel and the support channels of your projects, and nothing
else" literally true.

`byStoredId` resolves **cache then `channels.fetch(id)`**: a cold cache after a restart
is not "the channel is gone", and reading only the cache built a duplicate support
channel beside the real one. `ensureManualPinned` likewise distinguishes a `fetchPinned`
**rejection** from "no pins" — read as the latter it re-posted and re-pinned the manual
on every single call; a rejection now logs at warn and leaves the channel alone.

The pinned manual (`ensureManualPinned`, content from `clientManual()` in
`services/clientManual.js`) is posted and pinned **once**, identified by
**title and author**: it fetches the channel's pinned messages and treats the manual as
already there only if a pinned message's embed title matches `MANUAL_TITLE` **and**
(when `botUserId` is given) that message's author is the bot itself — so a client
quoting the manual's title in their own pinned message can never be mistaken for it.
`botUserId` must always be passed for this check to mean anything; `/init` and `/setup`
both pass `interaction.client?.user?.id ?? null` (`/init` uses `guild.client?.user?.id`,
the same client instance, since `runInit` only receives the `guild`).

`ensureSupportChannels(guild, cfg, { update, botUserId })` is called by the first client
approval, by `/init` (after the permission pass and the senior/dashboard config update,
so `verifiedRoleId` and the freshly-saved `clientRoleId` are both in the config it
reads), and by `/setup`'s no-options branch (idempotent — cheap when everything already
exists; a failure there is caught and reported on the embed rather than aborting the
whole command).

## The twelve-channel project section

`projectSection.js`'s `SECTIONS` grew from ten entries to **twelve**: `support` and
`supportVoice` (suffixes `support`, `support-voice`) join `members`, `documentation`,
`meetings`, `meetingVoice`, the frontend/backend/database chat+voice pairs. They are
created like the other ten and so copy the category's overwrites at creation time —
`@everyone` denied, the project role allowed — exactly the same "copied only at
creation, never cascaded" gotcha `project-sections.md` documents for the rest of the
section.

`CLIENT_SECTION_KEYS = ['support', 'supportVoice']` names the two channels a project's
own clients can see. Access to them is **not** the project role — it is one
`OverwriteType.Member` overwrite per client row, granted/revoked by
`planClientAccess(observed, { revokeClients })` in `projectSection.js`:

- `observed.clientIds` is the roster of client discord ids for this project, or
  **`null` when the roster was never read this run**. `planClientAccess` treats `null`
  as "plan nothing" — `{ wanted: [], grant: [], revoke: [] }` — rather than guess at who
  should keep or lose access. This is the same fail-closed shape as the role sync's own
  roster-read failure.
- With an array, `grant`/`revoke` are computed per support channel from
  `observed.clientAccess[key].missing` / `.stale` — a member overwrite present that
  matches no current client row is stale; a client row with no overwrite yet is missing.
- `revokeClients: false` is the **twin of the role sync's grant-only mode**: a roster
  that could only be read partially (truncated at `ROSTER_LIMIT`) or not at all must
  never take access away, only add it. `project-setup.js` computes it as
  `revokeClients = !fetchFailure && rosterRows.length < ROSTER_LIMIT`.
- The applier reports `clientGranted`/`clientRevoked` (channel names) in its result,
  the same shape as the role-overwrite `grant`/`opens` repair.

**A client row fed to the role sync opens all twelve channels** — the project role's
overwrite is on every section channel, where a client's own overwrite opens only the
two support channels. `staffOnly` — at the one line in `project-setup.js` that feeds
`syncProjectRoleMembers` (`staffOnly(roster)`, filtering out `role === 'client'` rows)
— is the only thing standing between a client and the whole section. Every other read
of the roster in that file (the pinned members panel, `observeProjectSection`'s
`clientIds`) is deliberately **unfiltered**: the pinned members panel shows the **full**
roster, clients included and labelled `Client`, because staff need to see who a
client-facing channel is open to; it is only the role sync that is staff-only.

`revokeClients` is also `false` whenever the roster read that feeds it failed or came
back truncated — never take access away on an incomplete picture, for the client
overwrites exactly as for the project role.

### `/project-members add role:client` revokes the project role unconditionally

`project-members.js`'s `add` handler, when the new role is `'client'`, calls
`changeRole(guild, project, user.id, 'revoke')` **whenever the prior role is not already
known to be `'client'`** — including when the prior roster read itself failed (`before`
came back `null`). `roles.remove` is idempotent, so a member who never held the project
role loses nothing by an extra, unneeded revoke call; the one outcome this must never
risk is a converted client **silently keeping** the project role — all twelve channels —
because a roster read blipped. The revoke is skipped only when re-adding someone already
a client, who never held the role either. `/project-members remove`, symmetrically, runs
**both** the role revoke and the client-overwrite revoke when the prior role could not be
read at all, since which mechanism they held is unknown and both revokes are idempotent.

## Requests as tasks

`/report-issue` and `/request-feature` share `createClientRequest` in
`services/clientRequest.js`. A request is an ordinary `task` row from the moment it is
raised — no second record type:

- `task.requestedBy` is set to the client's discord id, **kept separate from
  `createdBy`** (also the client here) so a developer can later raise a request on a
  client's behalf without the row lying about who actually typed it. `requestedBy` is
  what every client-facing query and every gate below keys on.
- The task's channel is created via the existing `createTaskTicketChannel` with
  `memberIds: [user.id]`, landing it in the project's section (or the global
  Features/Bugs category with no project) with the client's own member overwrite. Its
  opening line, `requestDescription`, reads "Client request — `<name>` can read this
  channel" so no developer is later surprised who is in the channel; the message is
  pinned.
- **Attachments are re-uploaded by the bot into the channel**, not linked by their
  Discord CDN URL: `attachmentPlan(attachments, limit)` splits them into `files` (posted
  as an actual upload) and `links` (too large for the bot's upload cap, posted as a URL
  with a note) — CDN URLs expire, so the channel itself has to be the durable store,
  never a URL written to the database.
- **Notice routing**, in order: a project request posts one line into that project's own
  `<slug>-support` channel (`storedChannels(project).support`) and DMs each `role='lead'`
  project member (`dmTaskAssignees`) — the same customer's support pair, never the
  *global* one, which every company's clients share. A request with no project instead
  notices `cfg.adminChannelId` (`#admin`). The global support pair is never used for a
  per-request notice either way.

**No other task's title ever reaches a request channel.** A client sits in their
request's channel, so anything posted there naming a *different* task is a leak. Two
places had to be closed and both key on `task.requestedBy`:

- `notifyTaskUpdate` does **not** push `warning` (the `blockerWarning(...)`
  `taskStatusChange.js` passes it, e.g. "Still blocked by: **Router**") into the channel
  post for a task with `requestedBy`. The warning still comes back in the function's
  return and reaches the command reply, which is ephemeral to the developer.
- `unblockNotices` **skips** any blocked task whose row has `requestedBy` — the notice
  quotes the blocker's title by construction.

The lead DM for a new request passes `headline: `A client raised **<title>**`` to
`dmTaskAssignees`, whose default opening clause is "You've been assigned" — a lead was
not assigned anything.

`notifyTaskUpdate` already DMs task holders on assignment/close; for a task with
`requestedBy` set, the requester is added to that DM list on every status change,
worded in the client's own terms (`requestStatusLabel`, where `pending` reads "Waiting
on you").

## `/request-report`: identical refusal, filtered timeline

`/my-requests` lists the caller's own `requestedBy` tasks, newest first. `/request-report
request:<id>` looks the task up by id and **refuses with the exact same message,
`NOT_YOURS`, whether the id belongs to another client or does not exist at all** — a
different message for "not yours" versus "no such request" would confirm to a client
that an id they guessed is real, so both dead ends read identically.

Its timeline is `timelineLines(rows, { nameFor, limit })` in
`utils/clientRequestView.js`: **status and assignee changes only**, oldest sorted then
sliced to the most recent `limit` (15) — `estimateMinutes`, time fields and anything
else are never rendered here, whatever a `taskactivity` row carries. This is a second,
independent restriction from `changeSummary`'s own `omit`: `taskUpdateNotify.js` calls
`changeSummary(before, updates, { omit: task.requestedBy ? ['estimateMinutes'] : [] })`
when posting a task-channel change summary, so a request's own channel never shows an
estimate changing either — the two mechanisms (a rendering filter on the report side, an
`omit` list on the channel-post side) both exist because they run over different data
(`taskactivity` rows vs. an in-flight `updates` object) but enforce the identical rule.

## Rollout (spec §13)

One repo, one deploy. Migration `025_client_role.sql` self-applies on boot,
idempotent in the `information_schema` style of 023/024. Then, by hand, once:

1. `/setup` (or simply approving the first client) creates the global support pair.
2. `/project-setup project:<X> preview:true`, then for real, per project that has
   clients — this adds the project's own two support-pair channels. Projects with no
   clients can wait; nothing forces them to run it.
3. `/invite emails:<…> client:true`; the client verifies; `/approve` confirms them as a
   client.
4. `/project-members add member:@client project:<X> role:client`.

Existing task channels are untouched by any of this, and nothing changes for staff
until step 3 brings in the first client.

## The manual is pinned in every project support channel too (2026-09-24)

`applyProjectSection` step 3a calls `ensureManualPinned` (exported from `clientAccess.js`) on
the resolved `support` channel after the section-channel loop — the same embed `#support`
carries, presence-only by title and bot author, so a created channel gets it at once, the
existing sections get it on their next `/project-setup`, and a deleted pin comes back on the run
after. A failure is one warning line. The manual also says clients may post more documents or
screenshots in a request's channel at any time — the request channel is the durable home for
documents; there is no `/attach` command by design.

## Related

[[project-sections]]

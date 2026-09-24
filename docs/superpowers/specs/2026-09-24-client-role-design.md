# Client role — design

**Date:** 2026-09-24
**Scope:** the Discord bot only. The UBS-Doc site and CSAAS are untouched; `guildmember.kind`
is written so they can exclude clients later without a second migration.
**Builds on:** `docs/superpowers/specs/2026-09-18-project-sections-design.md` as corrected by
`.claude/knowledge/project-sections.md` (the role model as built), and the task time tracking
shipped 2026-09-22.

## 1. Purpose

Clients — the people a project is being built for — need a narrow window into the server: a
place to talk to the team, and a way to raise issues and feature requests and follow what happens
to them. They must see nothing else: not the team's channels, not other projects, not time data.

The through-line of this design is one rule: **a client never receives the `Verified` role.**
Everything a team member sees is granted to `Verified`, so a client without it sees nothing by
construction, and nothing new has to be remembered when the next channel or command is added.
What a client *can* see is then granted explicitly, and the list is short.

## 2. What the user asked for, and the decisions made

Asked for: a client role assigned at approval and per project; clients see only support text and
voice channels, globally and per project; their own commands to raise issues and feature requests
with documents attached; developers can ask the client for more; clients can track their requests
and see a report on each.

Decided during design (each was put to the owner):

- **A request is an ordinary task from the moment it is raised**, marked as client-originated.
  Developers use `/update-task`, the board and everything else they already have; no second record
  type, no triage inbox.
- **Clients enter by invitation only.** `/invite` marks the invite as a client's; nobody becomes a
  client without leadership inviting them.
- **The report shows status, handler and a timeline** — never time or estimates.
- **Project-level access is per person, not per role**: one global `Client` role, and inside a
  project a member overwrite per client on that project's two support channels. No per-project
  client roles, so none of the role-adoption logic in `projectSection.js` is touched.

## 3. Roles and data

### 3.1 The `Client` role

A new role named `Client`, id stored in `guildconfig.clientRoleId`. It is **not** added to
`MANAGED_ROLES`: that list is the staff role picker and its `roleDiff` arithmetic, and `Client` is
mutually exclusive with every entry in it. It gets its own constant `ROLE_CLIENT = 'Client'` in
`bot/src/constants.js` beside `ROLE_VERIFIED`, and its own colour in `ROLE_COLORS`.

Created by `/init` for a new server. For the existing server — which will never be re-inited —
it is created on demand by the first client approval (§5), the same lazy pattern as
`#time-reports`. Every creation path stores the id; every consumer reads the id and falls back to
the role *name* only when the stored id no longer resolves (the `roleGate.js` lesson).

### 3.2 `guildmember.kind`

`guildmember.kind VARCHAR(16) NOT NULL DEFAULT 'staff'`, values `staff` | `client`. Discord
enforces channel access through the role; `kind` is what the bot's own logic consults where it
iterates members: the daily time report, `/time-report`, `/approve` and `/backlog`. Set at join
from the invite (§4), and set by approval (§5) regardless of how the person arrived.

### 3.3 Other columns

- `pendinginvite.kind VARCHAR(16) NOT NULL DEFAULT 'staff'` — what `/invite` recorded.
- `guildconfig.supportChannelId VARCHAR(64)`, `guildconfig.supportVoiceChannelId VARCHAR(64)` —
  the global pair (§6).
- `task.requestedBy VARCHAR(64) DEFAULT NULL`, indexed — the client's Discord id. **Non-null means
  client request.** Kept separate from `createdBy` so a developer can later raise a request on a
  client's behalf without the row lying about who typed it.
- `projectmember.role` is a free `VARCHAR(32)`; `PROJECT_MEMBER_ROLES` gains `'client'` with label
  `Client` in `/project-members`. No schema change.
- `project.discordChannels` (JSON map) gains the keys `support` and `supportVoice`. No schema change.

All of this is migration `025_client_role.sql`, idempotent in the `information_schema` style of
023 and 024. `updateGuildConfig`'s allow-list gains the three new `guildconfig` columns.

## 4. Getting in

`/invite` gains an optional boolean `client`. With `client:true`:

- the email domain check is skipped for those addresses (it is what stops outside emails today);
- each `pendinginvite` row is written with `kind='client'`;
- the invite email is the same.

Member join (`events/memberAdd.js`) already matches the used invite to its email; it now also
copies `kind` onto the `guildmember` row it upserts.

`/verify` accepts an email when **either** `isAllowedEmail(email)` holds (today's rule) **or** the
email is a client's. "Is a client's" means one of:

1. the caller's own `guildmember` row has `kind='client'` and this email (the normal case — the
   join matched the invite), or
2. a `pendinginvite` row with `kind='client'` and this email is still **unclaimed** (the join did
   not match — the documented weak spot when the bot lacks Manage Server). Verifying claims it: the
   row is deleted and the member's `kind` and `email` are set.

Either way the person lands in Holding exactly as staff do. Nothing else in `/verify` changes.

## 5. Approval

`/approve` and `/backlog` both approve; they change identically, through one shared helper so they
cannot drift (the same reason they share `MANAGED_ROLES`).

For a holding member whose row has `kind='client'`, **step 2 (the staff role picker) is replaced**
by a single confirmation: "Approve **<name>** as a **client**? They will see only the support
channels." For a member with `kind='staff'`, the picker is as today with one addition at the top:
a `Client` option. Choosing it deselects everything else (min 1, max 1 when it is picked — the
handler enforces this even if the select allows more, and re-prompts).

On confirming a client approval:

1. ensure the `Client` role exists (§3.1) and the global support pair exists (§6);
2. add `Client`; remove `Holding`; **do not add `Verified`**;
3. `guildmember`: `status='approved'`, `kind='client'`, `roleIds` unchanged (it lists managed
   roles, of which a client has none);
4. reply names the support channel they can now see.

A staff approval is unchanged, except that it also sets `kind='staff'` explicitly.

`/set-roles` refuses to act on a member holding `Client`: "This member is a client and holds no
staff roles. To make them staff, remove the Client role by hand and run /approve." Conversion in
either direction is deliberately not automated — it is rare, and getting it wrong hands someone
either every channel or none.

## 6. Global support channels

A category `🛟 Support` (`CATEGORY_SUPPORT`) with `support` (`CHANNEL_SUPPORT`, text) and
`support-voice` (`CHANNEL_SUPPORT_VOICE`). Overwrites, every entry with an explicit
`OverwriteType`:

- `@everyone` (the guild id, `OverwriteType.Role`): deny `ViewChannel`;
- `Client`: allow `ViewChannel`, `SendMessages`, `ReadMessageHistory`, and on the voice channel
  also `Connect`, `Speak`, `UseVAD`, `Stream`;
- `Verified`: the same allows — staff must be there to answer.

`/init` creates them. `ensureSupportChannels(guild, cfg)` — idempotent, id-based with a
name-fallback only when no id is stored, one `edit()` per channel at most — is called by the first
client approval and by `/setup` (so an operator can also just run `/setup`). Ids are stored in
`guildconfig`. `/cleanup` protects them by id like the section channels.

### 6.1 The client manual

The `support` channel holds a **pinned manual** for clients — the only place they will ever be told
how the bot works, since they see no other channel. It is a single embed, posted and pinned by
`ensureSupportChannels`, and re-posted if the pinned message is ever missing (deleted by hand, or
the channel recreated), so it is always there.

Its content, built by `clientManual()` in `services/clientRequest.js` from the command definitions
themselves rather than typed out twice:

- what a client can and cannot see, in two sentences;
- each client command with its syntax and one example — `/report-issue`, `/request-feature`,
  `/my-requests`, `/request-report` — and, for the raising commands, that up to three documents
  can be attached;
- what happens after a request is raised: a private channel opens for it, the team is told, and
  status changes are posted there and DMed;
- what **"Waiting on you"** means and what to do about it (answer in the request's channel).

A test asserts the manual names every command in `clientCommands` except `verify`, so adding a
client command without documenting it fails the suite. The pinned message is also what
`channel-defaults.json` points at for `support`, so `/init` and the lazy path post the same text.

The project support channels (§7.1) get a one-line pinned pointer to the global manual, not a copy.

**This pair is shared by every client of every company.** Nothing about an individual request is
ever posted there, and the bot never @-mentions a client there.

## 7. Project level

### 7.1 Two more section channels

`SECTIONS` in `projectSection.js` gains `support` and `supportVoice` (suffixes `support`,
`support-voice`), making twelve. They are created like the other ten, so they copy the category's
overwrites at creation: `@everyone` denied, the project role allowed. Existing sections gain them
on their next `/project-setup` run through the planner's normal "missing channel" path. The
`CATEGORY_SOFT_CAP` stays 49, so 37 task channels now fit in a section before the global
Features/Bugs fallback kicks in, down from 39.

### 7.2 Per-client access

A client on a project is a `projectmember` row with `role='client'`. Access is one
`OverwriteType.Member` overwrite per client on each of the two support channels, allowing the same
set as §6.

- `/project-members add member:@x role:client` writes the row and grants the two overwrites
  immediately. It **never** grants the project role. Changing an existing staff row to `client`
  revokes the project role and grants the overwrites; changing a client row to a staff role does
  the reverse. Both go through the existing single-member grant/revoke path.
- `/project-members remove` deletes the row and revokes the two overwrites.
- `/project-setup` repairs: `observeProjectSection` reports, per support channel, which client
  rows lack an overwrite (`clientGaps`) and which member overwrites belong to nobody who is still
  a client row (`clientStale`). `planChannels` turns these into `grant`/`revoke` entries; the
  applier uses `permissionOverwrites.edit` / `.delete` per member — merge-never-replace,
  presence-only, exactly as the section-channel repair does for the role. Revocation obeys the
  same `grantOnly` flag the role sync does: a truncated or unreadable roster revokes nobody.
- A client may be on several projects; each project's pair gets its own overwrite.

### 7.3 The roster filter

`project-setup.js` reads the `projectmember` roster in two places (the pre-build read and the
fresh pre-sync read) and hands it to `syncProjectRoleMembers`. **Both reads filter out
`role='client'` rows** before the sync sees them. Without this the sync grants a client the
project role, and with it all twelve channels — the one way this design can fail completely. A
test asserts it directly.

## 8. Raising a request

### 8.1 Commands

Two commands, one shared implementation (`services/clientRequest.js`):

- `/report-issue title details [project] [document] [document2] [document3]` → task type `bug`
- `/request-feature title details [project] [document] [document2] [document3]` → task type `feature`

`title` ≤ 200, `details` ≤ 2000 (matching `/create-task`). `project` autocompletes over the
projects where the caller has a `role='client'` row; when there is exactly one it is used without
asking; when there are none the request has no project. The three attachment options are Discord
`Attachment` options (a modal cannot carry files, and one option carries one file).

### 8.2 What is created

1. A `task` row: `type`, `title`, `description=details`, `status='open'`, `createdBy` and
   `requestedBy` both the client's id, `projectId`/`projectName` when there is one, no assignees,
   no scope, no modules, no estimate.
2. A `ticketdoc` row as `/create-task` writes for a feature.
3. The task's channel via `createTaskTicketChannel` with `memberIds: [clientId]` and the project,
   so it lands in the project's section (or the global Features/Bugs category with no project)
   with the client's member overwrite. The opening embed is **client-safe**: title, details,
   project, request id — no scope, modules or estimate fields — and its first line reads
   "Client request — <name> can read this channel", so no developer is surprised later. The bot
   pins that message.
4. The attachments are **re-uploaded by the bot into the channel** as a second message — Discord
   CDN URLs expire, so the channel is the durable store and no URL is written to the database.
   A file over the bot's upload limit is posted as a link with a note that it could not be copied.
5. Notice: a line in the project's `<slug>-support` channel ("New request from <name>: **<title>**
   → <#channel>"), and a best-effort DM to each `role='lead'` member of the project via
   `dmTaskAssignees`. With no project, the notice goes to `#admin` (`adminChannelId`) instead.

The ephemeral reply links the channel and says what happens next.

### 8.3 What the client's channel must never carry

The request channel is the one place a client reads that developers also use. Nothing
time-related is posted into task channels today (`/my-time` is an ephemeral panel; the daily
report has its own channel) and this design adds nothing that would be. `notifyTaskUpdate`'s
change summary can name `estimateMinutes` when it changes; for a task with `requestedBy` set,
that line is omitted from the channel post.

## 9. Tracking, asking for more, and the report

**Asking for more** is the way developers already work: post in the channel and run
`/update-task status:pending`. `pending` is the one status the client's views label
**"Waiting on you"**; every other status keeps its existing label.

**Status changes reach the client.** `notifyTaskUpdate` already posts into the task's channel; for
a task with `requestedBy` set, the requester is added to the DM list it already sends to holders.

`/my-requests` — ephemeral. The caller's tasks where `requestedBy` = caller, newest first, up to
25: type, title, project, status ("Waiting on you" for `pending`), channel link. Empty state names
the two raising commands.

`/request-report [request]` — ephemeral. `request` autocompletes over the caller's own requests.
One embed: title, type, project, status, handler (assignees' display names, or "not yet
assigned"), raised on, last updated, and a **timeline** of up to 15 `taskactivity` rows for the
task, **filtered to `status` and `assigneeIds` changes only** — `estimateMinutes`, time fields and
anything else never render. Any task whose `requestedBy` is not the caller is refused with the
same "not your request" message whether or not it exists.

## 10. The command gate

`command-config.json` gains `"clientCommands": ["verify", "report-issue", "request-feature",
"my-requests", "request-report"]`. `canUseCommand` becomes **deny-by-default for a member holding
the `Client` role**: if the member holds it (by stored id, or by name when the id is stale) and
the command is not in `clientCommands`, refuse — before the ordinary role check, and regardless of
the command's own `commandRoles` entry. This is what closes the three commands with an empty role
list (`close-feature`, `resolve-bug`; `verify` stays open) and every command absent from the map.
The guild-owner and Manage Server bypasses stay; a client never has them.

Client commands themselves are gated on `Client` in `commandRoles`, so staff do not see them.

## 11. Everything that iterates "approved members"

- `services/dailyTimeReport.js` lists approved `guildmember` rows: **skip `kind='client'`**.
- `/time-report`'s per-person listing: the same.
- `memberNameSync` is unchanged (it mirrors Discord roles; a client's `roleNames` will read
  `["Client"]`, which is correct).
- `/approve` and `/backlog` holding lists show a `(client)` suffix on client rows.

## 12. Testing

`node:test`, every function under test takes `{ db, getConfig }` seams with fakes, and every run
sets `DATABASE_URL=poisoned://no-production-access` — see
`.claude/rules/tests-never-touch-production.md`.

- gate: a `Client` holder is refused every command not in `clientCommands`, including one with an
  empty `commandRoles` entry and one absent from the map; a staff member is unaffected.
- approval: the client path adds `Client`, removes `Holding`, never adds `Verified`, writes
  `kind='client'`; the staff path never adds `Client`.
- verify: an outside email is accepted with a client `guildmember` row, accepted and claimed with
  an unclaimed client invite, refused otherwise.
- roster filter: a roster with a client row reaches `syncProjectRoleMembers` without it.
- support-overwrite plan: missing overwrite → grant; stale overwrite → revoke; `grantOnly`
  suppresses revokes; a stored id that resolves is used over a name.
- request creation: task row fields, `requestedBy`, `memberIds` passed to the channel creator,
  attachments re-posted, the notice target with and without a project.
- report scoping: another client's request id is refused; the timeline omits estimate and time
  changes.
- daily report and `/time-report` skip client rows.
- manual: `clientManual()` names every command in `clientCommands` except `verify`.

## 13. Rollout

One repo, one deploy. Migration 025 self-applies on boot. Then, by hand, once:

1. `/setup` (or approve the first client) to create the global support pair.
2. `/project-setup project:<X> preview:true`, then for real, per project with clients — this adds
   the two section channels. Projects without clients can wait.
3. `/invite emails:<…> client:true`; the client verifies; `/approve`.
4. `/project-members add member:@client project:<X> role:client`.

Existing task channels are untouched. Nothing changes for staff until step 3.

## 14. Out of scope, deliberately

Converting a client to staff or back (by hand); a client raising a request against a project they
are not on; editing or withdrawing a request (the channel is the place to say so); per-company
segregation of the global support pair (one channel, by the owner's request); any site or CSAAS
change beyond the `kind` column being available to them.

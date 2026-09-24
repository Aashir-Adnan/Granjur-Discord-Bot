# Per-project Discord sections

Built on branch `feat/project-sections` (base `7e78f9f`, head `7f40a42`, 21
commits, 615 tests). **Not yet merged** at the time of writing — see
`.claude/state/session.md`. Read this before touching `bot/src/services/projectSection.js`,
`/project-setup`, `/projects`, `/project-members`, `/meeting-channel`,
`/create-task`, `/create-project-categories`, `/create-project-role`, or `/cleanup`.

The design record is `docs/superpowers/specs/2026-09-18-project-sections-design.md`.
**It is out of date in §5 and §13** — the role model shipped is stricter than what
it describes. This file describes the code as built; the spec stays as history.
The build's full ruling-by-ruling record is
`.superpowers/sdd/2026-09-18-project-sections/progress.md`.

## The section layout

One category per project: `📂 ` + the project name upper-cased, cut to Discord's
100-character cap (`categoryNameFor`, `bot/src/services/projectSection.js`).
Thirteen channels inside it, in creation order (`SECTIONS`), plus the archive
divider that `/project-setup` creates after them:

```
members, documentation, meetings, meetingVoice,
frontendChat, frontendVoice, backendChat, backendVoice,
databaseChat, databaseVoice, support, supportVoice
```

Channel name: `<slug>-<suffix>` (`channelNameFor`), suffixes `members`,
`documentation`, `meetings`, `meeting-voice`, `frontend-chat`, `frontend-voice`,
`backend-chat`, `backend-voice`, `database-chat`, `database-voice`, `support`,
`support-voice`. The slug is truncated to make room, never the suffix. The last
two (`CLIENT_SECTION_KEYS`) are the pair a project's own clients can see — not to
be confused with the *global* support pair `ensureSupportChannels` maintains
outside any project section; see `client-role.md`. The slug is the project's
**effective** slug (`projectSlug`): its stored `docsSlug`, or `slugify(name)` when
that is null. Comparing raw `docsSlug` columns instead of the effective slug is
exactly the bug that let `UBS-Doc` and a NULL-slugged `UBS Doc` fight over the
same thirteen channels (fixed as final-wave A6/D4 — see "Duplicate slugs" below).

**Task channels live in the section category, ordered around a read-only divider
channel** (`────archive────`): live tickets above it, finished ones below it.
A ticket's parent is always this category; only its position says whether it is
finished. See [[ticket-archive]] for the whole feature: the divider, the one
reorder primitive (`guild.channels.setPositions`), placement at creation, the
live placement call, and the 14-day Done retention. (Between 2026-09-24 and
2026-09-25 the same grouping was three sibling *categories* per project; that
layout is gone, and `/project-setup` reports the leftovers rather than deleting
them.)

`taskChannelName({ type, title, taskId, taken })`: `feature`/`bug` prefix +
`slugify(title)`; an empty/symbol-only title falls back to `<prefix>-<last 6 of
id>`; collisions get `-<first 4/8/12/all of the id>` appended, in that order,
deterministically, so a repair run lands on the same name twice.

## Repair is by id, never by name — and the guarded name fallback

Every observer function reads a project's **stored** ids first
(`project.discordCategoryId`, `discordRoleId`, `discordChannels` — a JSON map
`{ key: channelId }`). An id that no longer resolves (deleted, or belongs to
another guild) is treated as **missing**, not broken — the applier recreates it.
A category or channel an operator renamed by hand is still found and repaired,
because the id, not the name, is what matters.

The **name fallback** (`observeProjectSection`, `bot/src/services/projectSection.js`
~:760-800) only fires for a project with no stored id yet — the first
`/project-setup` on a project that predates this branch. It is guarded three ways,
each closing a real incident found during the build:

1. **Never adopt an id another project already claims.** `claimedSectionIds(projects,
   exceptId)` collects every OTHER project's `discordCategoryId` and the ids inside
   its `discordChannels`; the observer skips any channel/category in that set. Must
   be read **fresh** at observation time (`setupProjectSection` re-reads
   `dbArg.project.findMany` per project during an `all:true` walk), because a list
   loaded before the walk started would miss a category project A just wrote.
2. **Never adopt a channel that has a topic.** The fallback used to allow through
   any channel whose topic was not a *ticket* topic (`!(c.topic &&
   isTicketChannel(c))`). Adoption now merges the project role's allow into the
   channel, so a hand-made **private** channel named e.g. `framework-meetings`
   would become visible to every role holder. Fixed (final-wave A/D2) to plain
   `!c.topic` — any topic at all disqualifies a channel from name-based adoption.
3. **Task channels can't be adopted by name at all**, in effect: the observer's
   task loop refuses any channel more than one task row points at, or that fails
   `isTicketChannel` — see "Shared/meeting review channels" below. This is what
   stops a project slugged `feature` from grabbing another project's task channel
   named `feature-members`.

Known residual gap (parked, final-wave A concern 1): `claimedSectionIds` only
covers ids stored on **project** rows (category + thirteen section channels), not task
channel ids, which live on `task` rows — reading every project's tasks per project
would be a second full scan. The ticket-topic guard above closes the realistic
case; a channel whose topic was wiped by hand AND whose name exactly matches a
section channel name could still be misadopted. Nobody has produced that state
except by hand.

## Discord's limits, and how they shape the design

- **Two channel edits per ten minutes.** This is why every existing channel gets
  exactly ONE `edit()` call carrying everything it needs: `{ name, parent }` for a
  section channel being renamed/moved, plus `topic` and `permissionOverwrites` for
  a task channel (`applyProjectSection`, step 3 and step 4). A rename followed by a
  separate move would burn the whole ten-minute budget on one channel and leave a
  doubly-wrong channel stuck until the next run. Every plan entry (except `reuse`)
  therefore carries its **final** desired name regardless of *why* it's changing.
- **50 channels per category** → `CATEGORY_SOFT_CAP = 49` (`bot/src/constants.js`).
  Thirteen are the section itself and one is the archive divider; task channels
  beyond the cap fall back to the global `Features`/`Bugs` category (or, for
  `/meeting-channel`, the global `📋 Meetings`), with a warning/note explaining
  why. Section channels are always created first so they can never be crowded
  out by tasks, and `planTasks` counts every channel this run brings into the
  category — the divider included — against the cap before it plans a single
  ticket move. Thirty-five ticket slots are left.
- **A category's overwrites are copied onto a channel only AT CREATION, never
  cascaded.** Discord has no server-side "sync now" for API edits — that button is
  client-only. This is *the* central gotcha of the whole feature: a section built
  while its role was refused gets thirteen channels that copy the deny-only category and
  stay deny-only **forever**, even after the role is later adopted and the category
  itself is fixed. That's why section channels need their own repair pass
  (`planChannels`'s `grant`/`opens` actions, described below) — the twin of the
  task-channel repair the spec already called for.
- **500 channels per guild.** Backfilling all 9 real projects takes the guild from
  ~95 to ~194.

## `OverwriteType.Role` vs `OverwriteType.Member`

Every role overwrite (the project role, `@everyone`) is sent with
`type: OverwriteType.Role`; every per-user overwrite (a task assignee) with
`type: OverwriteType.Member`. `@everyone`'s id **is the guild's own id**
(`guild.id`), not a separate constant. Passing the wrong `type` makes Discord
silently **drop** the overwrite with no error — that bug hid channel
`feature-f56be0` from its assignee on 2026-09-04, and it is the reason every
overwrite-building helper in this codebase (`categoryOverwrites`,
`roleAllowMerged`, `taskTicketChannel.js`) writes `type` explicitly on every entry
it constructs.

One case outside this branch's control still omits it on purpose: the global
(non-project) `/meeting-channel` voice path's `@everyone` allow
(`meeting-channel.js`) has no explicit `type` — kept byte-for-byte from the
pre-existing code and left as a backlog item (discord.js infers it correctly
today; see backlog).

## The role model as built (spec §5/§13 are out of date — read this instead)

The spec said "reuse a role of that exact name." The shipped code refuses to do
that automatically whenever it could hurt someone, because a same-named role held
by people who are not project members is the single most dangerous state this
feature can walk into: adopting it both (a) shows the new private section to every
current holder, and (b) the very next role sync **strips the role from every
holder who is not a `projectmember` row**. This was caught live in the final
whole-branch review with a concrete repro (role `Marketing`, held by u1/u2; adding
a project named `Marketing` replied "2 revoked").

`planRole` (`projectSection.js` ~:175-274), in order:

0. **Managed name refusal.** A project named after one of the 15 `MANAGED_ROLES`
   (`bot/src/utils/roleSync.js`) always refuses a role. If the project already had
   a stored role (`observed.roleId`), that role is **kept** — a rename onto a
   managed job-role name does not strip the section of its existing gate. If it
   never had one, the section is built **hidden**: `@everyone` denied, no allow at
   all — this is the one refusal case that can never itself get a role, ever
   (renaming the project and re-running is the only way out; that then creates a
   real role and repairs the section). Earlier in the build this case left the
   category fully **public** (no overwrites at all) on the theory that "hidden with
   no way back" was worse than open — that trade was reversed in the final wave
   once section-channel repair (below) made hidden *recoverable*.
1. **The project's own stored `discordRoleId`** is always reused — untouched by
   everything below.
2. **Nothing of that name exists** → create it. Affects nobody else.
3. Otherwise a same-named role (`observed.roleCandidate`, built by
   `describeRoleCandidate`) is checked, and refused (fail-closed) unless it passes
   ALL of:
   - **not `@everyone`** (`candidate.isEveryone`),
   - **not managed** (bot/integration role),
   - **not over-permissioned**: `role.permissions` must be a **subset** of
     `@everyone`'s permissions (`overPermissioned`, a bitmask subset test, not a
     deny-list — a deny-list was tried first and reviewers kept finding gaps:
     MoveMembers, MuteMembers, DeafenMembers, ManageWebhooks, ManageNicknames,
     ManageThreads, ManageEvents, ViewAuditLog were all missing from the first
     attempt). An unreadable bitfield on either side counts as over-permissioned
     (refuse, don't guess).
   - **holds no overwrite on any channel outside the project's own category**
     (`candidate.elsewhere`) — allows *and* denies alike. A dormant role with an
     allow on some unrelated private channel would hand every project member that
     channel too if adopted; a deny-only overwrite can't open anything but the
     refusal is worded to say "carries overwrites on channels outside this
     project," not that those channels would be handed out.
   - **the member list was actually fetched** (`observed.rolesFetched === true`).
     Holder counts come from `role.members`, which only reflects reality after
     `guild.members.fetch()`. `rolesFetched` **defaults to false** in
     `observeProjectSection`, so a caller that forgets to fetch fails closed rather
     than silently treating an unfetched cache as "nobody holds it" (which is
     exactly the leak this whole rule exists to close). `prepareSectionRun`
     (`project-setup.js`) fetches members on **every** run including previews.
   - **it has no holders**, OR **`adopt_role:true` was passed**.
4. If it has holders and `adopt_role` was not passed: refused, with a warning
   naming the role, its holder count, and both ways out (rename the project/role,
   or run `/project-setup adopt_role:true`, ideally with `preview:true` first).

`adopt_role` (an optional boolean, `/project-setup` **only**) overrides exactly one
refusal — "someone holds it." It does **not** override `@everyone`, managed,
over-permissioned, or elsewhere-overwrite refusals; those say "adopt_role does not
override this" in the warning. `/projects` → Add project, `/create-project-categories`
and `/create-project-role` (the two retired-command wrappers) call the shared
one-project routine with `adoptRole: false` hardcoded — **a new project, or an
operator using the old commands, can never adopt a held role or trigger a revoke.**

`gateRoleId` on the role plan is the single value both `planChannels` and the
applier read for "which role gates this section" — this closed a real bug where
`lacksRoleAllow` said "no role" for a `refuse` decision while the applier still put
a *kept* role's allow on moved task channels, i.e. the planner and the applier
disagreed with each other about the same run.

**Preview** with `adopt_role:true` prints, by display name, exactly who would gain
and who would lose the role, before anything happens (`adoptionPreview`,
`project-setup.js`).

### Section-channel repair (final-wave A1) — the twin of task-channel repair

Because a category's overwrites are copied onto a channel only at creation
(above), a section built while the role was refused has thirteen channels that stay
deny-only forever unless something explicitly repairs them. `planChannels` now
checks each of the thirteen channels for the gate role's overwrite
(`lacksRoleAllow`/`needsAllow`) and, per channel:
- already correctly named/placed but missing the allow → standalone `grant`
  action (one `edit()`, overwrites only);
- being renamed or moved anyway → the allow rides in that **same** single edit
  (`opens: true` on the plan entry).

Task channels get the identical treatment (`planTasks`, same `grant`/`opens`
logic) for the case where a task channel was created before the role existed, the
role was deleted and recreated under a new id, or role creation failed after the
category was made.

All of this uses **merge, never replace** — see next section — and is presence-only:
it checks whether the overwrite id is present, not whether its allow/deny bits
still match. See "Merge, never replace" for why that's deliberate.

The same repair pass covers the section's client-facing pair
(`CLIENT_SECTION_KEYS = ['support', 'supportVoice', 'casual']`), but with a per-**member**
overwrite instead of the role-level one every other section channel gets: each
row in `plan.clients` (computed from the project's client roster, `clientIds`)
grants or revokes one client's own overwrite on those two channels
(`clientGranted`/`clientRevoked` in the applier's result). `clientIds: null` means
the roster could not be read this run, and the planner plans no client change at
all rather than guess — see `client-role.md` for the full read/plan/apply path
and why a client never reaches the other ten.

## Merge, never replace; never `lockPermissions()`

Discord's REST API treats `permission_overwrites` on an edit as a **whole-array
replace**, not a merge. Sending just "the required pair" would silently drop any
overwrite a human added by hand (a single-member grant, a moderator role) or any
per-assignee overwrite already on a task channel. Every place this code writes
overwrites therefore reads the channel/category's *current* cache and merges:

- `mergedOverwrites(category, required)` — for the category repair.
- `roleAllowMerged(channel, roleId)` — for section-channel `grant`/`opens` and for
  task-channel moves into the section; returns `null` (no edit) when the role
  doesn't resolve, the overwrite cache is unreadable, or the channel already
  carries an overwrite for that role id (never overrule a hand-set one).

`lockPermissions()` (which would sync a channel to its category, replacing
everything) is **never called anywhere** in this feature — it would drop
per-assignee member overwrites on a task channel.

**Presence-only, deliberately.** These checks ask "is there an overwrite for this
id at all," never "does its allow/deny still match what we'd send." Repairing by
value would silently re-close a category an admin had deliberately reopened by
hand, on every run, with no way to opt out short of editing the bot's source. The
security claim stays narrow and true: the bot always *creates* the deny; only a
deliberate human edit can ever remove it, and that removal is respected, not
fought. (Ruled explicitly in the ledger as a parked minor, not a bug.)

One inconsistency exists between the two presence checks and is **known, not a
bug**: `missingOverwrites` guards on `cache?.has`, `mergedOverwrites` guards on
`cache?.values`. Both exist on a real discord.js `Collection`, so they agree today;
a future cache-like object exposing only one of the two methods would make them
disagree about whether the cache is "readable." Parked in the backlog.

## Shared/meeting review channels are never treated as task channels

An unassigned meeting task's `discordChannelId` points at the meeting's **shared**
review channel, not a channel of its own. Renaming that to `feature-<title>` and
moving it into one project's category would take the whole meeting's review away
from everyone else who uses it. `observeProjectSection` builds a reference count
per channel id across all of a project's task rows and excludes any channel that
either (a) more than one task row points at, or (b) fails `isTicketChannel`
(covers the single-unassigned-task case, where the reference count alone would be
1 and wrongly pass).

`isTicketChannel(channel)` (`bot/src/utils/taskChannelName.js`) is the shared
definition, used by both the observer and `ownsChannel` in
`taskUpdateNotify.js`. **The topic decides; the name is only a fallback for a
channel with no topic at all.** Every ticket channel the bot has ever created
carries a `Feature:`/`Bug:` topic — that's the bot's own signature. A *name* like
`feature-`/`bug-` is not: `/meeting-channel name:"Bug triage"` creates
`bug-triage-<ts>-text`, a meeting review channel with topic `"Meeting chat is
stored…"`, which would otherwise get renamed into a project's section and have an
assignee's overwrite added to a channel the whole meeting still uses. Only a
`GuildText` channel qualifies at all (a voice channel has no topic).

## Project inference from a channel

`projectFromChannel(projects, channel)` (`projectSection.js`) — shared by
`/project-members`, `/meeting-channel`, and `/create-task`'s eventual channel
placement. Resolves a **thread** to its parent channel first (a thread's
`parentId` is the text channel it lives in, not the category), then matches on
`discordCategoryId === channel.parentId` (or `=== channel.id`, for a command run
directly on the category — not applicable to text/voice children but kept for
symmetry). That is the whole rule again: since [[ticket-archive]] a ticket
channel is parented to the section category, so a command run inside one reaches
its project through the category id. (It briefly also matched the three
status-bucket ids, for the one day tickets lived in those categories.)
**Returns `null` when two projects claim the same id** — nothing makes
`discordCategoryId` unique (migration 019 has no unique index) —
rather than guessing and possibly handing someone the wrong project's role. The
caller then falls back to its normal picker. An uncached thread parent also fails
closed to "pick a project," never a wrong guess.

## Duplicate slugs (spec §13, previously unimplemented)

Two projects whose **effective** slugs collide (`projectSlug`) would want the same
thirteen channel names forever, dragging the same channels back and forth between
categories on every run. `setupProjectSection` now checks this against a
**fresh** per-project read of sibling rows and refuses outright — `refused: true`,
nothing touched — with a message telling the operator to give one of them a
different docs slug in `/projects`. `/create-project-role` and `/projects` → Add
project print that refusal line instead of the generic "run /project-setup once
the bot has permissions" message (final-wave D3) when they hit it.

## What `/project-setup` does, and how to preview it

`/project-setup [project] [all] [preview] [adopt_role]` (CEO, Server Manager,
Project Manager). One shared per-project routine (`setupOneProject`/
`setupProjectSection`) is used by this command, `/projects` → Add project,
`/create-project-categories` (now effectively `all:true`, `create_roles` option
removed — the role is now *always* created via the shared path), and
`/create-project-role` (runs the whole one-project routine, because a role without
its category gates nothing; a managed name is refused before anything is
created).

- `preview:true` performs **nothing** — no Discord call, no DB write — and prints
  the plan: role decision, category action, per-channel actions, task moves, and
  (with `adopt_role:true`) exactly who gains/loses the role by name. Members are
  still fetched on a preview (needed to make the role decision honestly), but
  nothing else happens.
- A real run (no `preview`) applies the plan (`applyProjectSection`), re-reads the
  project's member roster **immediately before** the role sync (not the one read
  at the top of the function — the apply itself can take minutes across ~30
  rate-limited edits, and a `/project-members add`/`remove` mid-run would otherwise
  be silently undone or re-granted by a sync against a stale list), and syncs the
  role in both directions.
- `all:true` walks every project in the guild; a per-project failure is caught and
  reported, and the walk continues. Replies post **incrementally** (one edit per
  project) so a very long walk (12+ Discord calls per project × 9 projects) that
  outlives the 15-minute interaction token still leaves a partial, readable record
  instead of losing everything.
- The bot's own `Administrator` permission is checked (`botLacksAdministrator`,
  `guild.members.me.permissions.has(PermissionFlagsBits.Administrator)`) and, if
  absent, the reply carries a standing warning — never a refusal — because every
  section category denies `@everyone` with **no allow for the bot**, so a
  non-Administrator bot cannot see the sections it just built (pins fail silently,
  posts fail, meeting recording can't join the voice channel). Deliberately not
  fixed by adding a bot-member overwrite instead: a non-admin bot may not be
  allowed to grant itself permissions in one, so that "fix" could fail in exactly
  the situation it targets.

### Backfill procedure

Run it **per project**, not `all:true`. Refusal warnings are long (250-400
characters each, because they have to tell an operator exactly what to do), and
`capReply` keeps blocks from the **front** of the list when a reply would exceed
Discord's 2000-character cap — so on a nine-project `all:true` run, the **last**
projects' warnings never appear in any posted version (this reverses an earlier,
wrong belief in the ledger that incremental posting made "nothing lost" — capReply
truncates each *individual* posted block too). Run projects one at a time, or read
`console.warn` output (`logWarnings` mirrors every merged warning there
specifically so a backfill stays diagnosable after the reply truncates).

Expect **most of the 9 existing projects to REFUSE** their legacy role on first
run: only 5 `projectmember` rows exist across 4 of the 9 projects, and the old
`/create-project-role` told operators to hand-assign roles, so the typical legacy
role has holders that are not `projectmember` rows. That's the *safe* default:
nobody gains or loses a role, the section is built hidden (repairable), and task
channels move in keeping their own per-assignee overwrites. Use
`/project-setup project:<X> preview:true adopt_role:true` to see exactly who would
change, then run for real with `adopt_role:true` once satisfied.

**A legacy role carrying an overwrite on a channel outside its own project's
category is unadoptable by ANY command, even with `adopt_role:true`.** Renaming
the project (or clearing that overwrite by hand) is the only way out — `adopt_role`
explicitly does not override this refusal.

## The bot needs Administrator

Every section category is created with `@everyone` denied `ViewChannel` and **no
allow for the bot** — only an Administrator bypasses channel overwrites entirely.
The pre-existing task-channel pattern (`taskTicketChannel.js`) already denies
`@everyone` with only assignee allows and the bot has always been able to post
into all 35 production ticket channels, which is why the build proceeded on the
assumption the bot already holds Administrator in this guild — no invite link in
the repo confirms it directly, so **this is the first live check after deploy**.
`/project-setup` warns (never refuses) when it can read its own permissions and
Administrator is absent.

## Tests: fakes, plus a poisoned second guard

Every function under test takes `{ db, getConfig }` seams (or, for the voice
listener glue, an explicit `ensureMeeting`) and every test passes fakes for both —
see `.claude/rules/tests-never-touch-production.md`. On top of that, this build ran
the **entire** suite with `DATABASE_URL=poisoned://no-production-access` as a
second, independent guard: `bot/src/Database/connection.js:8-10` throws unless the
URL starts with `mysql://`, so even a seam mistake that reached the default `db`
export would blow up loudly instead of touching production. The final
whole-branch review went one step further and instrumented `getPool()` (the single
choke point for every query) to record a stack trace on every call, ran the whole
suite, and confirmed **zero** calls — nothing in this branch's tests reaches the
pool at all, swallowed or otherwise.

`/cleanup` had no seams before this branch (final-wave B1) — they were added
before its test file was written, per the same rule.

## `/cleanup` protects a project's own section by id

`/cleanup`'s old protection matched category/channel names against project names
by lowercasing and stripping `/^[^\w]+/` — which fails for `(Legacy) App`,
`[Client] Portal`, `.NET Rewrite`, `#1 Client`, accented names (`Éclair`, `Ünité`,
JS `\w` has no `u` flag), `日本 Portal`, `Straße` (case round-trip is not
identity), names over ~97 characters, and any category renamed by hand — every one
of those would list the *entire* section (and any moved task channels) for
deletion behind the confirm button. Fixed to protect by id first: any category
whose id is a project's `discordCategoryId`, its thirteen `claimedSectionIds`, and
anything whose `parentId` is one of those categories — the same by-id principle
the rest of this feature runs on. The archive divider needs no rule of its own:
its id is in `discordChannels`, so `claimedSectionIds` covers it exactly as it
covers a section channel, and every ticket beside it is covered by the category
rule — see [[ticket-archive]]. The name rule is kept as a
fallback for categories that predate the recorded ids. `handleConfirm` (the actual delete) was
**not** touched in this fix — it still deletes whatever `execute` listed with no
re-check at confirm time (backlog item).

The *global* support pair (`ensureSupportChannels`, not part of any project
section) gets the same by-id treatment, added separately: `cfg.supportChannelId`/
`supportVoiceChannelId` and whatever category holds them are excluded before the
name rule ever runs, so `/cleanup` can never offer the one channel pair every
client depends on for deletion. See `client-role.md`.

## Push-to-talk and screen sharing in meeting voice channels (2026-09-21)

`Connect` + `Speak` include neither **Use Voice Activity** (`UseVAD`) nor **Video**
(`Stream` — screen share and camera). Nothing in the bot ever granted `Stream`, and only the
non-project `/meeting-channel` path granted `UseVAD`, so in every other voice channel the bot
makes both depend on the server's `@everyone` role: a project's voice channels (the section's
four, and every `/meeting-channel` voice created inside the category with no overwrites of its
own, which inherit the category's project-role allow) and the private rooms from
`/create-channel` and `meetingAutoChannel` (per-member allows of View/Connect/Speak only).
Where `@everyone` lacks them: push-to-talk only, no screen sharing.

Fixed: `ROLE_ALLOW` includes both (new sections); the private-room member allows and the
non-project `/meeting-channel` `@everyone` allow include both; `/meeting-channel` merges
whichever the project role's inherited overwrite does not already DENY into the new voice
channel (a deny is a human's policy); and `observeProjectSection` lists the category and any
voice channel in it whose project-role overwrite neither allows nor denies one of them
(`voiceGaps`, per permission). `planProjectSection` passes that through as `plan.voice`,
`/project-setup` previews it ("Voice: N voice channel(s)… will let the project role use voice
activity and screen sharing") and `applyProjectSection` repairs it with one merged
`permissionOverwrites.edit(roleId, { UseVAD: true, Stream: true })` each, only the missing ones
(`result.voiceFixed`). Presence-only checks elsewhere would not catch this — the role overwrite
already existed — hence the bit-level test.

Existing channels are repaired by running `/project-setup project:<name>` (preview first);
Discord never re-copies a category's overwrites onto existing children. Private rooms created
before the fix keep their old member allows.

## A casual chat per project, open to its clients (2026-09-24)

`SECTIONS` gained a thirteenth entry, `{ key: 'casual', suffix: 'casual-chat', type: 'text' }`,
and `CLIENT_SECTION_KEYS` lists it beside the support pair. Nothing else changed: the per-client
member overwrites, `/project-members add role:client`, the `/project-setup` grant/revoke repair
and the `clientAllowFor` text/voice split all iterate that list. Existing sections get the
channel on their next `/project-setup`, and a client already on the project is granted it in the
same run (`plan.clients.wanted` on a freshly created client-key channel). `CATEGORY_SOFT_CAP`
stays 49, so 36 task channels now fit before the global fallback.

## Related

[[project-tasks-site]], [[project-docs]], [[client-role]], [[ticket-archive]]

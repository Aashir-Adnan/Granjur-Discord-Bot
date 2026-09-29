# Global channel layout and #feedback

Roadmap sub-project 3 (`docs/superpowers/specs/2026-09-29-global-channel-layout-design.md`).
Built on branch `feat/global-channel-layout` (base `44d80a4`, commits `65e09db..997dc26`;
spec `65e09db`, plan `819d334`, code `913b8e3..997dc26`).
**Built, not deployed** — see `.claude/state/backlog.md` for the rollout.

## `services/globalLayout.js` — the one layout `/init` and `/cleanup` both read

`GLOBAL_LAYOUT` is an ordered array of `{ category, channels }` entries; each channel is
`{ name, type, topic? }` built by the module's own `text()`/`voice()` helpers. Creation
order is display order — categories append to the bottom of the channel list, so the
table order in the spec is also the order they appear in Discord:

0. 📥 Onboarding — #welcome-and-verify (kept out of `GLOBAL_LAYOUT`'s slice for `/init`
   because it needs bespoke `@everyone` permissions; still listed for `/cleanup`).
1. 📢 Announcements — #announcements-all/verified/leadership, #admin.
2. 💬 Casual — #casual-chat, #off-topic, voice #voice-lounge.
3. 📚 Documentation — #documentation.
4. 💡 Feedback (new) — #feedback.
5. 📋 Meetings — #general-meetings, voice #meeting-voice, #upcoming-meetings.

Support (`🛟 Support`) is deliberately **not** in the layout: `ensureFeedbackChannel`'s
sibling, `ensureSupportChannels` (`services/clientAccess.js`), owns it end to end, and
`/cleanup` protects it separately by id-then-name (see below).

**Removed from the old `/init` layout, and why nothing depends on it:** Rules, Archive
(#meeting-metadata, #sql-dumps), the Frontend/Backend/Database categories with their
chat+voice channels, and the Command channels category (one `cmd-<name>` per
`command-config.json`'s `dedicatedChannels`). Confirmed dead before removal: nothing in
the bot reads any of those channels — the dedicated-channel config only drove their
*creation*, no command is gated to running inside its `cmd-*` channel, and the
Frontend/Backend/Database **roles** (`DISCIPLINE_ROLES`) and the `dedicatedChannels`/
`commandDescriptions` config all stay, because other features (role assignment, command
descriptions) still use them independently of the channels.

`createGlobalCategories(guild, entries)` is the shared creation primitive: one category
per entry, then its channels under it, returning a `Map<name, channel>` so callers (like
`/init`, which slices Onboarding off the front) can pull out `documentationChannel` /
`feedbackChannel` by name afterward.

`protectedCategoryNames()` / `protectedChannelNames()` are what `/cleanup` calls — see
next section.

## `/cleanup`'s protections

Everything `/cleanup` must never offer for deletion, all matched **by id first**, name
only as a fallback for what predates an id being stored:

- **Layout category/channel names**, lowercased, from `globalLayout.js` directly — so a
  layout change can never make `/init` and `/cleanup` disagree again.
- **`/migrate`'s bold names** (`CATEGORY_BOLD_NAMES`, `constants.js`): every layout
  category name is also protected under its `<==== 📋 MEETINGS 📋 ====>`-style bold form.
- **Legacy aliases of a protected category.** `CATEGORY_BOLD_NAMES` maps several old
  plain names to the *same* bold name — e.g. both `'Meetings'` and `'📋 Meetings'` map to
  `'<==== 📋 MEETINGS 📋 ====>'`. `protectedCategoryNames()` walks that map and adds any
  alias whose bold target is already protected, so a plain `Meetings` category left over
  from before the emoji was added is protected too, without hand-listing every alias.
- **`Features`/`Bugs`** (`GLOBAL_TICKET_CATEGORIES`) — the no-project ticket categories,
  created on demand by ticket creation, never by `/init`, but never `/cleanup`'s to trim.
- **Support**, by id (`supportChannelId`/`supportVoiceChannelId` on guild config, plus
  whatever category holds them) **and** by name (`🛟 Support`) — the id-only window
  before the first `/init`/`/setup`/client-approval has run would otherwise let the pair
  through.
- **Project sections**, by id: `claimedSectionIds(projects, null)` for the section
  category and its own channels, plus every category id recorded on a project row (so
  everything parented under it — the thirteen section channels, the archive divider,
  every ticket channel, per-section meeting pairs — is covered without re-deriving the
  list). A failed project read is treated as "protect everything", not "protect
  nothing": it aborts with a message instead of returning `[]`.
- **Task tickets**, by id: every `task.discordChannelId`/`discordThreadId` in the guild.
  The read explicitly takes `1_000_000` rows (`db.task.findMany({ ..., take: 1_000_000
  })`) because the default `taskFindMany` caps at 500 — a guild with more than 500 tasks
  would otherwise have its older tickets silently reclassified as leftovers.
- **Stored config channel ids**: `onboardingChannelId`, `adminChannelId`,
  `timeReportChannelId`, `feedbackChannelId` — whatever they are named or wherever they
  sit (`#time-reports` lives at the guild root, outside any category).
- **`/create-channel` rooms**: `userChannel.textChannelId`/`voiceChannelId` rows for the
  guild (a failed read is swallowed to an empty set — a known, pre-existing gap noted in
  `backlog.md`, not fixed by this branch).

**The empty-category rule.** A category is offered for removal only when it is *not*
already protected **and** every one of its child channels is also going. `/cleanup`
computes `toDelete` (channels) first, then walks every category once more checking
`children.every((c) => deleting.has(c.id))` — so Rules, Archive, Frontend/Backend/
Database and Command channels are removed as categories once their contents are all in
`toDelete`, rather than left behind as empty shells. `handleConfirm` re-derives this at
delete time too: right before deleting a category it re-fetches the guild's channels and
skips the category if anything is still parented there (a sibling channel's delete
failed earlier in the same run), incrementing a `skipped` counter reported back as
"Kept N category(ies) that still had channels." Channels are always deleted before their
categories in the same run.

**Known gap, not closed by this branch:** the pre-existing `meet-*` rule
(`name.startsWith('meet-')`) is checked *before* the protected-category check for that
channel and lists a leftover `meet-*` room for deletion even when it sits inside the
protected 📋 Meetings category. It is real orphan cleanup (auto-created per-meeting
channels the design never intended to keep forever), but the owner must read the actual
list before confirming a live trim, in case a `meet-*` name is doing double duty as
something else.

## #feedback

- **Found by id first**: `guildconfig.feedbackChannelId` (migration
  `029_guild_feedback_channel.sql`, `VARCHAR(64) NULL`, exposed through `updateGuildConfig`
  like `adminChannelId`), cache-then-fetch so a cold cache never reads as "gone"
  (`findFeedbackChannel` → `resolveChannel`). **Name fallback**: a text channel named
  `feedback` inside a `💡 Feedback` category, for a server whose config predates the
  column or lost the stored id.
- **Overwrites** (`feedbackOverwrites`, `services/feedback.js`): `@everyone` denies
  `ViewChannel`; the Verified role gets `ViewChannel` + `ReadMessageHistory` +
  `SendMessages`. Clients never hold Verified (see `client-role.md`), so they never see
  #feedback — no explicit Client deny is needed or written.
- **`/init` builds it as part of the layout**, then does a second, explicit pass: after
  the generic "everything non-onboarding, non-announcements is Verified ViewChannel +
  ReadMessageHistory" loop, it checks `if (feedbackChannel && ch.id === feedbackChannel.id)`
  and also grants Verified `SendMessages` — a deliberate addition made during review
  (commit `cd167df`) so `/init`'s overwrites match `ensureFeedbackChannel`'s exactly; the
  generic loop alone would have left #feedback read-only for Verified.
- **`/feedback` command** (`commands/feedback.js`): `message` (required, ≤1000 chars,
  trimmed, empty rejected) + `type` (`Bug`/`Idea`/`Process`/`Other`, default Other via
  `buildFeedbackEmbed`'s `Object.hasOwn` guard). Posts an embed (`allowedMentions: {
  parse: [] }` so the `<@userId>` "From" field never pings) and replies privately. No
  channel → "There's no #feedback channel yet — ask an admin to run /setup." and nothing
  is posted. Registered `commandRoles.feedback = ["Verified"]` in `command-config.json`,
  not in `clientCommands`, so the existing deny-by-default client gate refuses it.
- **`/setup` creates it idempotently** via `ensureFeedbackChannel(guild, cfg)`: throws if
  `cfg.verifiedRoleId` is unset (run `/init` first); if a channel is found, only the
  stored id is (re-)written; otherwise it creates the category (reusing one found by
  name) and channel with the overwrites above, pins the default message from
  `channel-defaults.json`'s `"feedback"` entry, and stores the id. `/setup`'s reply shows
  `<#id> — created now` on first creation, or just `<#id>` on a repeat run.

## The live server is never reordered

Nothing in this branch calls `guild.channels.setPositions` or otherwise moves an
existing category/channel. `/init` only runs once per fresh server (categories append at
the bottom, so creation order is display order there); `/setup` and `/cleanup` only
create, repair-by-id, or delete — a live server keeps whatever order an operator has
already arranged. This was an explicit design constraint (spec "Out of scope": "Reordering
existing servers") because the layout ships to an already-organized production server.

## Rollout

See `.claude/state/backlog.md` roadmap item 3. In order, each step needing the owner's
go-ahead: push the bot's `main` (deploy runs migration 029; the restarted bot registers
`/feedback`) → `/setup` on the live server (#feedback appears, reply says "created now")
→ `/cleanup`, read the list (expect Rules, Archive, the Frontend/Backend/Database
channels, `cmd-*` channels, their now-empty categories, plus any leftover `meet-*` rooms
and stray channels — read this list before confirming, per the known gap above) →
confirm only then.

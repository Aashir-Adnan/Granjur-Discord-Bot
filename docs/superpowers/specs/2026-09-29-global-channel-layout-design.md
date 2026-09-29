# Global channel layout and feedback

Sub-project 3 of the owner's roadmap (see `.claude/state/backlog.md`). Design approved in
chat on 2026-09-29. Bot repo only.

## Owner's request

- "Trim staff/onboarding channels global level to only announcement and casual (with
  documentation following)."
- "Create a feedback channel to where we get feedback on what to improve on global level."

Answers given while designing:
- Meetings stays.
- Support stays; it is the clients' channel, not a staff channel.
- Rules and the command channels go.
- Feedback is a channel plus a `/feedback` command, and people can also type in the
  channel directly.
- Clients must not see #feedback.
- The live server is not reordered.

## Current behaviour

`/init` (`bot/src/commands/init.js`, `runInit`) creates these global categories:
- Onboarding
- Rules
- Documentation
- Meetings
- Casual
- Archive
- Announcements
- Frontend, Backend and Database (role-locked)
- Command channels (one `cmd-<name>` per entry in `command-config.json`'s
  `dedicatedChannels`)
- Support (`ensureSupportChannels`)

`/cleanup` (`bot/src/commands/cleanup.js`) offers to delete every channel outside that
layout:
- It keeps name lists that duplicate `/init`'s: `getProtectedChannelNames`,
  `getProtectedCategoryNames`.
- It protects project sections, the ticket channels in them, Support, and user-created
  channels recorded in the DB.
- It shows the list and deletes only after a confirm button.

Nothing in the bot reads the Rules, Archive, Frontend/Backend/Database or `cmd-*`
channels. The dedicated-channel config only drives their creation. No command is
restricted to its `cmd-*` channel.

## Design

### 1. One shared definition of the global layout

A new module, `bot/src/services/globalLayout.js`, is the single source of truth for the
global categories and their channels, in order. Each entry holds:
- the category name;
- its channels (name, type, topic);
- its visibility (`public`, `verified`, `leadership`, `feedback`, or per-channel for
  Announcements).

Both `/init` and `/cleanup` read it, so they cannot drift apart again.

| # | Category | Channels |
|---|---|---|
| 0 | 📥 Onboarding | #welcome-and-verify |
| 1 | 📢 Announcements | #announcements-all, #announcements-verified, #announcements-leadership, #admin (unchanged) |
| 2 | 💬 Casual | #casual-chat, #off-topic, voice #voice-lounge |
| 3 | 📚 Documentation | #documentation |
| 4 | 💡 Feedback (new) | #feedback |
| 5 | 📋 Meetings | #general-meetings, voice #meeting-voice, #upcoming-meetings |
| — | 🛟 Support | unchanged; still made by `ensureSupportChannels` |

Removed from the layout:
- Rules;
- Archive (#meeting-metadata, #sql-dumps);
- the Frontend, Backend and Database categories with their chat and voice channels;
- the Command channels category and every `cmd-*` channel.

What stays:
- The discipline roles (Frontend, Backend, Database) and the `dedicatedChannels` /
  `commandDescriptions` config. Other features use those.
- The Pet Pictures and Foodie names drop out of `/cleanup`'s protected lists, because
  `/init` never creates them.

### 2. `/init` builds from the layout

- `runInit` creates the categories and channels from `globalLayout.js`, in table order.
- It keeps every existing side effect:
  - onboarding permissions;
  - the Verified-only default for staff channels;
  - Announcements tier permissions and storing `adminChannelId`;
  - the documentation traversal message;
  - pinned default messages;
  - Support creation;
  - roles;
  - guild config.
- The confirm embed's description lists the new layout.

### 3. #feedback

- **Permissions:**
  - `@everyone` is denied view;
  - Verified can view, read history and send messages;
  - Client gets nothing, so clients never see it.
- **Pinned message** (`channel-defaults.json`): explains that anyone can type here, or use
  `/feedback` from anywhere for a tidy card.
- **Command:** `/feedback message:<text, required, ≤1000 chars> type:<Bug | Idea | Process
  | Other, optional, default Other>`.
  - Posts an embed in #feedback: the type as the title, the text, and the sender's
    mention and display name.
  - Replies to the sender privately: "Thanks — posted in #feedback."
  - If #feedback does not exist, it replies privately "There's no #feedback channel yet —
    ask an admin to run /setup." and posts nothing.
  - Registration:
    - `command-config.json` `commandRoles.feedback = ["Verified"]`;
    - a `commandDescriptions` entry;
    - not in `clientCommands`, so the existing client gate refuses it to clients.
- The channel is found by the id stored on the guild config (`feedbackChannelId`, new
  column), falling back to the name `feedback` inside the Feedback category.

### 4. Live server: `/setup` adds, `/cleanup` trims

- **`/setup`** (the existing CEO/Server Manager repair command) gains an idempotent
  `ensureFeedbackChannel(guild, cfg)` step:
  - It creates the Feedback category and #feedback with the permissions above, pins the
    default message, and stores `feedbackChannelId`.
  - If they already exist, it only re-stores the id.
  - Its reply lists what it did.
- **`/cleanup`**, now reading `globalLayout.js`, lists the removed channels (Rules,
  Archive, Frontend/Backend/Database, `cmd-*`) alongside whatever else it already finds.
  - It keeps every existing protection (project sections and their tickets, Support, DB
    user channels, the bare `general`/`voice` pair).
  - Nothing is deleted until the confirm button.
- **No reordering** of the live server's categories.

### 5. Data

Bot migration `029_guild_feedback_channel.sql` adds `guildconfig.feedbackChannelId
VARCHAR(64) NULL`. The db layer exposes it like `adminChannelId`.

## Testing (node:test, fakes only; `.claude/rules/tests-never-touch-production.md`)

- **`globalLayout.js`:**
  - the exact category order and channel names;
  - no Rules, Archive, discipline or `cmd-*` entries;
  - Feedback's visibility excludes Client.
- **`/cleanup`'s delete list** on a fake guild shaped like the live server:
  - removed channels are listed;
  - layout channels, project sections, tickets, Support and DB user channels are not;
  - a failed project read still lists nothing (existing guard).
- **`runInit`** on a fake guild:
  - creates exactly the layout;
  - #feedback denies `@everyone` and allows Verified;
  - stores `feedbackChannelId` and `adminChannelId`.
- **`/feedback`:**
  - the embed content and type default;
  - the private reply;
  - a missing channel gives the "run /setup" reply and posts nothing;
  - the 1000-character limit.
- **`ensureFeedbackChannel`:**
  - creates once;
  - a second run creates nothing and keeps the id.

## Rollout

1. Push the bot. The deploy runs migration 029, and the restarted bot registers
   `/feedback` on startup (`bot/src/commands/index.js` registers the command list with
   Discord).
2. Run `/setup` on the live server. #feedback appears.
3. Run `/cleanup`, read its list, and confirm only if it shows just the channels meant
   to go.

## Out of scope

- Reordering existing servers.
- Storing feedback in the database, or any site view of feedback.
- Removing the discipline roles or the `dedicatedChannels` config.

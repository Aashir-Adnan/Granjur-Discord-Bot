# Per-project Discord sections, project-aware meetings, and readable task channels

**Date:** 2026-09-18
**Status:** approved design, not yet implemented
**Repo touched:** Granjur-Discord-Bot only

---

## 1. Goal

Every project gets its own section of the server — members, documentation, meetings,
frontend, backend, database, and its task channels — created automatically and visible
only to the people on that project. A meeting started inside a project lands in that
project. Task channels are named after their task instead of six hex characters.

## 2. What exists today

- **The server has one global set of sections** (`📚 Documentation`, `📋 Meetings`,
  `⚛️ Frontend`, `🔧 Backend`, `🗄️ Database`, each with a chat channel and, for the last
  three, a voice channel), one flat `Features` category with 28 channels named
  `feature-0145e3`, and `Bugs` with 3. 95 channels, 13 categories.
- **Nothing links a channel to a project.** `createTaskTicketChannel` puts every feature
  in `Features` and every bug in `Bugs` (`getOrCreateCategory`, matching by name with the
  bold `/migrate` variants as aliases). `/meeting-channel` always creates under
  `📋 Meetings`. `scheduledmeeting` has no project column.
- **`project` has no Discord columns.** `/projects` → *Add project* writes a row and
  re-attributes docs; it creates nothing in Discord.
- **`/create-project-categories`** reads `projectschema`, which has **0 rows**, and builds
  a different layout (`📂 Name` + one `name-chat` channel). It has never done anything.
  `/create-project-role` creates a role named exactly after the project.
- **Task lookups never use a channel name:** `/close-feature` and `/resolve-bug` find the
  row by `discordChannelId`, so renaming is safe.
- **9 projects, 35 tasks** (32 feature, 3 bug), 33 of them carrying a `projectId`, all 35
  with a channel. 5 `projectmember` rows across 4 projects.
- Reusable pattern: `ensureGuidelinesPinned` in `bot/src/config/meetingGuidelines.js`
  finds its own pin by an embed footer marker and posts one if absent.

## 3. Decisions

| Question | Decision |
|---|---|
| Shape | One category per project, holding the same channel set as the global sections. Discord cannot nest categories, so five categories per project was the alternative and was rejected as too long a sidebar. |
| Access | One Discord role per project. The category denies `@everyone`, allows the role; channels inherit. |
| Membership | `/project-members` infers the project when run inside one of its channels. Each project has a `#<slug>-members` channel carrying a pinned, auto-updated panel; joins and departures are posted there. |
| Task channels | Live in their project's category. `feature-<title-slug>` / `bug-<title-slug>`, id in the topic. Tasks with no project stay in the global `Features` / `Bugs`. |
| Meetings | `/meeting-channel` gains an optional `project` and infers one from the channel it is run in; its channels then land in that project's category and `scheduledmeeting.projectId` records it. |
| Existing projects | A `/project-setup` command creates or repairs a project's section, including moving and renaming existing task channels. `preview:true` prints the plan without acting. |
| Old commands | `/create-project-categories` and `/create-project-role` become wrappers for the new path. |

Out of scope: archiving a finished project's category; moving the 12 existing channels in
the global `📋 Meetings` category into projects (nothing records which project they were
for); renaming a project (no flow exists today).

## 4. The section

For a project named `Framework` (slug `framework`, from the existing `slugify`):

```
📂 FRAMEWORK                       category, @everyone denied, Framework role allowed
   # framework-members             pinned members panel; join/leave posts
   # framework-documentation
   # framework-meetings
   🔊 framework-meeting-voice
   # framework-frontend-chat
   🔊 framework-frontend-voice
   # framework-backend-chat
   🔊 framework-backend-voice
   # framework-database-chat
   🔊 framework-database-voice
   ✨ feature-git-sync             task channels, same category
   🐛 bug-login-crash
```

Ten channels plus tasks. Framework, the busiest project, reaches 23 of Discord's 50 per
category. **Cap handling:** when a category holds 49 or more channels, a new task channel
is created in the global `Features`/`Bugs` category instead and the command's reply says
so; the section channels are created first so they can never be crowded out.

Category name: `📂 ` + the project name upper-cased, cut to Discord's 100 characters.
Channel names: `<slug>-<suffix>` where the suffixes are `members`, `documentation`,
`meetings`, `meeting-voice`, `frontend-chat`, `frontend-voice`, `backend-chat`,
`backend-voice`, `database-chat`, `database-voice`. A slug long enough to push a name past
100 characters is truncated on the slug, never the suffix.

## 5. Access

One role per project, named after the project exactly (what `/create-project-role` already
does). Refused, with a message, when that name is one of the 15 `MANAGED_ROLES` in
`bot/src/utils/roleSync.js` — those are job roles and must not become project gates.

The category carries two overwrites: `@everyone` denied `ViewChannel`, the project role
allowed `ViewChannel`, `SendMessages`, `ReadMessageHistory`, `Connect`, `Speak`. Channels
are created without their own overwrites so they inherit. Task channels keep their existing
per-member overwrites **in addition**, so a task channel stays visible to an assignee who
is not on the project.

`/project-members add` grants the role and `remove` revokes it, best-effort: a Discord
failure is reported in the reply and never rolls back the database row. `/project-setup`
re-syncs the role against `projectmember` in both directions (grant to members missing it,
revoke from holders who are no longer members).

## 6. Data model — migration `019_project_discord_sections.sql`

Guarded with the `information_schema` pattern, mirrored in `schema.sql`.

- `project.discordCategoryId VARCHAR(64) NULL`
- `project.discordRoleId VARCHAR(64) NULL`
- `project.discordChannels JSON NULL` — `{ "members": "<id>", "documentation": "<id>", … }`
- `scheduledmeeting.projectId VARCHAR(36) NULL`

The bot repairs what it created **by id**, never by matching names, so a channel someone
renamed by hand is still recognised. An id that no longer resolves is treated as missing
and recreated.

DB surface: `db.project.update({ where: { id }, data: { discordCategoryId, discordRoleId,
discordChannels } })` (the existing `projectUpdate` gains the three columns, built from one
ordered array as the repo requires) and `db.scheduledMeeting.update` gains `projectId`.

## 7. The planner — `bot/src/services/projectSection.js`

Pure decision, impure application, so the decision is testable without Discord.

```js
planProjectSection(project, observed) → {
  role:     { action: 'create' | 'reuse' | 'refuse', name, reason? },
  category: { action: 'create' | 'reuse' | 'rename', id?, name },
  channels: [{ key, action: 'create' | 'reuse' | 'rename' | 'move', id?, name, type }],
  tasks:    [{ taskId, channelId, action: 'rename' | 'move' | 'both' | 'none', name }],
  warnings: string[],
}
```

`observed` is a plain snapshot the caller gathers: `{ roleId, roleNames, categoryId,
categoryChannelCount, channels: { key: { id, name, parentId } }, tasks: [{ id, title, type,
channelId, channelName, parentId }], takenNames: Set }`. No Discord objects.

`applyProjectSection(guild, plan, { db })` performs it in order — role, category,
channels, task moves — and returns what it did. **Each existing task channel receives
exactly one `edit()` carrying name and parent together**, because Discord allows two
channel edits per ten minutes and a rename plus a move would burn both.

## 8. Task channel names — `bot/src/utils/taskChannelName.js`

`taskChannelName({ type, title, taskId, taken })`:

- `feature` or `bug` prefix, then `slugify(title)`.
- Empty or symbol-only titles fall back to `<prefix>-<last 6 of the task id>` (today's name).
- Trimmed to 100 characters on the title, never the prefix.
- When `taken` already holds the result, append `-<first 4 of the task id>`; if that is
  also taken, append more of the id. Deterministic, so a repair run produces the same name.

`createTaskTicketChannel` takes the new optional `project` and `nameFor` inputs; when a
project is given it parents the channel there and names it this way. With no project it
behaves exactly as today. The topic gains `Task <id>` so the id is still one click away.

## 9. Members channel and panel — `bot/src/services/projectMembersPanel.js`

`buildMembersEmbed(project, members, nameFor)` renders the roster grouped by role in
`PROJECT_MEMBER_ROLES` order, with an `Project members · <name>` footer as its marker.
`ensureMembersPanel(channel, project, members, botUserId)` finds its own pin by that footer
and edits it, or posts and pins one when absent — the `ensureGuidelinesPinned` shape.
`postMembershipChange(channel, { member, role, action })` posts one line per change.

Both are best-effort: a missing channel or a failed edit is logged with a
`[projectSection]` prefix and never fails the command that triggered it.

## 10. Commands

**`/project-setup [project] [all] [preview]`** — CEO, Server Manager, Project Manager.
Builds `observed`, calls the planner, and either prints the plan (`preview:true`) or applies
it, then reports per project: role, category, channels created or repaired, task channels
moved and renamed, members synced, warnings. Idempotent. With `all:true` it walks every
project; a per-project failure is reported and the walk continues.

**`/projects` → Add project** calls the same path right after the row is created, so a new
project has its section immediately. A Discord failure leaves the project row in place and
says the section can be created later with `/project-setup`.

**`/project-members`** gains project inference: when the `project` option is absent and the
command runs in a channel whose category is a project's `discordCategoryId`, that project is
used. Otherwise the picker behaves as now. `add`/`remove` also grant/revoke the role and
post to the members channel; `list` still prints the roster.

**`/meeting-channel`** gains an optional `project` option, and infers the project from the
channel it was run in the same way. With a project it creates the meeting's channels in that
project's category and stores `projectId` on the meeting row; without one, today's
behaviour is unchanged.

**`/create-project-categories`** becomes `/project-setup all:true` in effect;
**`/create-project-role`** creates the role through the same helper. Both keep their names
so nothing anyone has learned disappears.

## 11. Errors

Missing `Manage Channels` or `Manage Roles` is caught per project and reported in the reply
with the permission named; other projects continue. A category at 49+ channels sends new
task channels to the global category with a note. A Discord rate limit surfaces as the
library's own error and the run reports which projects were not finished, so the command can
be run again. Nothing in this feature deletes a channel or a role.

## 12. Testing

Pure and tested: `planProjectSection` (fresh project; everything already correct; a
renamed-by-hand category; a missing channel; a task in the wrong category; a task already
right; the refused managed-role name; the 49-channel cap), `taskChannelName` (plain,
collision, empty title, over-length, deterministic repeat), `buildMembersEmbed` (grouping
and the marker), and the project-from-channel inference.

Against a database seam, never the real one: the `/project-members` and `/meeting-channel`
option handling.

Live, after deploy: `/project-setup project:Framework preview:true` read and checked, then
the real run, then `/project-setup all:true`, then a `/create-task` in Framework, a
`/meeting-channel` inside a project channel, and a `/project-members add` with the panel
updating.

## 13. Risks

- **31 existing task channels move and rename.** One edit each, inside the library's rate
  limiter. A run that stops halfway is safe to repeat: the planner recomputes from what it
  observes.
- **A project role name may already exist** for an unrelated reason; the bot reuses a role
  of that exact name rather than creating a second one, which is what `/create-project-role`
  already does.
- **Two projects with the same slug** would collide on channel names; `/projects` already
  refuses a duplicate docs slug, and `/project-setup` refuses with a message if it sees one.
- **Channel count** rises from 95 to roughly 185 of Discord's 500.

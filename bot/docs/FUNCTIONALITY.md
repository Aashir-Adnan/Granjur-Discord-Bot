# Granjur Discord Bot — Server Functionality

This document lists all functionality the Granjur Discord bot server is designed to fulfill: commands, roles, channels, background services, and data models.

---

## 1. Roles

### 1.1 System roles (created by `/init`)

| Role            | Purpose |
|-----------------|--------|
| **Holding**     | New members who have verified email but not yet approved. Restricts access until approval. |
| **Verified**    | Members who have been approved (Holding removed, Verified added). Grants access to most channels and commands. |

### 1.2 Hierarchy roles (assignable via `/approve` or `/backlog`)

- Intern  
- Temp  
- Junior Dev  
- Senior Dev  
- Associate Engineer  
- Quality Assurance  
- Project Manager  
- Server Manager  
- CEO  

### 1.3 Discipline roles (assignable via `/approve` or `/backlog`)

- Frontend  
- UI/UX  
- Designer  
- Server  
- Full-Stack  
- Database  

### 1.4 Special role usage

- **CEO**, **Server Manager**: Can run `/init`, `/scrap`, `/invite`, `/backlog`, `/approve`, `/repos`, `/dashboard`, `/faq-answer`; get backlog pings in **#admin**; can access leadership announcement channels.
- **Senior Dev**: Can run `/ticket`, `/evaluate`, `/edit-docs`, `/sql-dump` in addition to Verified commands.
- **Dashboard roles** (stored in guild config, typically CEO + Server Manager): Can use `/dashboard` and see admin modules.
- **Senior role IDs** (stored in guild config): Used for senior-only features (e.g. evaluate).

---

## 2. Commands

Commands are slash commands. Permission is enforced by **role**: if a command has required roles in `command-config.json`, the user must have one of those roles (or be server owner / have Manage Server). Descriptions and syntax below come from the command config and code.

### 2.1 Setup & administration (CEO / Server Manager)

| Command   | Required roles        | Description |
|----------|------------------------|-------------|
| **/init**   | CEO, Server Manager  | Set up server: roles, onboarding channel, verification flow, categories (Onboarding, Rules, Documentation, Announcements, Meetings, Casual, Pet Pictures, Foodie, Archive), role-locked Frontend/Backend/Database categories, and Command channels. Run once per server; use `/scrap` first if already initialized. |
| **/scrap**  | CEO, Server Manager  | Reset server to bare bones: one text channel (`general`), one voice channel (`voice`). Deletes all custom roles and Granjur-created channels. Use before re-running `/init`. |
| **/invite** | CEO, Server Manager  | Send a server invite to an @granjur.com email. Button opens modal to enter email; invite is sent by email and by DM if the user is already in the server. |
| **/backlog**| CEO, Server Manager  | View users in Holding; select a user and approve via modal (roles comma-separated + optional notes). Assigns roles, removes Holding, adds Verified, and notifies in admin channel. |
| **/approve**| CEO, Server Manager  | Step-by-step approval: (1) select user in Holding, (2) select roles (multi-select), (3) confirm. Alternative to `/backlog`. |
| **/repos**  | CEO, Server Manager  | Add or list repositories (URL + optional project name). Manage Guild permission also allowed. |
| **/dashboard** | CEO, Server Manager | CEO/Server Manager dashboard: access admin modules (implementation-specific). |
| **/faq-answer** | CEO, Server Manager | Answer FAQ questions: select an open FAQ and submit an answer (modal). |

### 2.2 Verification (everyone or role-specific)

| Command    | Required roles | Description |
|-----------|----------------|-------------|
| **/verify** | Everyone      | Verify email via OTP. User clicks “Request verification code”, enters @granjur.com email, receives 6-digit code by email, enters code in Discord. Nickname is set from email; user is put in **Holding** until approved. Triggers backlog notification to #admin. |

### 2.3 Tickets & tasks (Verified or Senior+)

| Command   | Required roles                    | Description |
|----------|-----------------------------------|-------------|
| **/bug**   | Verified                         | Create a bug ticket: select repo, enter title/description, optionally tag members. Creates a private Discord channel and optionally a GitHub issue. |
| **/ticket**| Senior Dev, CEO, Server Manager   | List or manage bug tickets: view tickets and update status (e.g. pending → resolved/abandoned). |
| **/feature** | Verified                       | Create a feature task: modal for title and description, then select repository or project. Creates a feature record and a dedicated channel. |
| **/close-feature** | Context-only (feature channel) | Use **only** inside a feature ticket channel. Optional attachment: MD file describing the implementation. Closes the feature ticket and saves the doc. No dedicated command channel. |
| **/resolve-bug** | Context-only (bug channel)     | Use **only** inside a bug ticket channel. Optional attachment: MD file describing the solution. Resolves the bug ticket and saves the doc. No dedicated command channel. |

### 2.4 Scheduling & time (Verified)

| Command     | Required roles | Description |
|------------|----------------|-------------|
| **/schedule** | Verified    | Schedule a meeting: modal for topic and when (e.g. `2025-03-01 14:00` or `in 2 days`), then optionally select invitees. Stored in DB; reminders run via background service. |
| **/clock-in**  | Verified  | Clock in: start tracking time (recorded in DB). |
| **/clock-out** | Verified  | Clock out: stop tracking time and log the session. |

### 2.5 Documentation & knowledge (Verified or Senior+)

| Command       | Required roles                    | Description |
|--------------|------------------------------------|-------------|
| **/docs**      | Verified                          | Search .md files in repos. Select repository, then optionally enter search term. Requires GitHub token. |
| **/faq**       | Verified                          | Ask or search FAQs: **Ask** (submit question, optional repo) or **Search** (query existing FAQs). |
| **/project-db**| Verified                          | View or save project database schema. Select project to view schema, or “New project” to paste and store a schema. |
| **/edit-docs** | CEO, Server Manager, Senior Dev   | Edit project or repo documentation (README). Select project or repo, then submit new README/content. Projects: stored in DB; repos: use GitHub. |
| **/sql-dump**  | Senior Dev, CEO, Server Manager   | Placeholder: “Versioned SQL dumps per project are planned.” Currently points users to #sql-dumps and `/project-db`. |

### 2.6 Personal & evaluation

| Command     | Required roles                    | Description |
|------------|------------------------------------|-------------|
| **/fetch-my** | Verified                         | Get your bugs, features, and meetings: select category (bugs/tickets, features, meeting schedules, or all), then view list. |
| **/evaluate** | Senior Dev, CEO, Server Manager  | Evaluate a user (select user; flow is implementation-specific). |

### 2.7 Dedicated command channels

The following commands get a dedicated channel under the category **📌 Command channels** when `/init` runs (from `command-config.json`):

- init, scrap, verify, invite, backlog, approve  
- bug, ticket, feature  
- schedule, project-db, docs, faq, repos, dashboard, edit-docs  
- clock-in, clock-out, sql-dump  

`close-feature` and `resolve-bug` do **not** have dedicated channels; they are valid only inside the relevant ticket channel.

---

## 3. Channels & categories (after `/init`)

### 3.1 Categories and channels

| Category / Channel | Purpose |
|--------------------|--------|
| **📥 Onboarding** | |
| `welcome-and-verify` | Welcome message; instructs users to use `/verify`. Pinned message explains OTP flow and Holding. |
| **📜 Rules** | |
| `rules` | Server rules; pinned message references `/verify` and approval. |
| **📚 Documentation** | |
| `documentation` | Browse/search project docs, repo READMEs, meeting notes. Dropdown for doc traversal (repo/project). Edit with `/edit-docs`. |
| **📋 Meetings** | |
| `general-meetings` | General meeting channel; schedule with `/schedule`. |
| `upcoming-meetings` | Reminders posted here ~10 minutes before each meeting, tagging invitees. |
| `meeting-voice` | Voice for meetings. |
| **💬 Casual** | |
| `casual-chat`, `off-topic`, `voice-lounge` | Casual and off-topic. |
| **🐾 Pet Pictures** | `pet-pics` |
| **🍴 Foodie** | `foodie-blog` |
| **📁 Archive** | |
| `meeting-metadata` | Meeting notes and metadata archived here. |
| `sql-dumps` | Versioned SQL dumps; use `/sql-dump` to view/search/submit. |
| **📢 Announcements** | |
| `announcements-all` | Server-wide. |
| `announcements-verified` | Verified members only. |
| `announcements-leadership` | Leadership only (dashboard roles). |
| `admin` | Backlog notifications: when someone enters Holding, server owner and dashboard roles are tagged. Use `/backlog` to approve. |
| **⚛️ Frontend** / **🔧 Backend** / **🗄️ Database** | Role-locked: only the matching discipline role (and Verified) can view. Each has chat + voice. |
| **📌 Command channels** | One channel per command (see above); pinned message describes the command and allowed roles. |

### 3.2 Project categories

After init/seed, project categories (e.g. Fittour, Edarete, Framework) can exist; structure is defined by seed/ubs_doc.

---

## 4. Events

| Event | Handler | Behavior |
|-------|---------|----------|
| **GuildMemberAdd** | `memberAdd.js` | Add **Holding** role, upsert `GuildMember` (status `pending`), send welcome message in onboarding channel with instructions for `/verify`. |

---

## 5. Background services

| Service | Purpose |
|--------|--------|
| **Meeting reminder** | Every minute, finds meetings in the next 10 minutes that have not been reminded, posts to `#upcoming-meetings` and tags invited members. Sets `reminderSentAt` so each meeting is reminded once. |
| **Ticket reminder** | Once per day (24h interval), for each guild: finds open features and pending bug tickets, groups by involved user (creator + assignees/tagged), DMs each user a list of their open tickets. |
| **Backlog notify** | Called when a user completes verification (enters Holding): sends a message to the guild’s admin channel tagging server owner and `dashboardRoleIds` (e.g. CEO, Server Manager) with text: “Backlog update: … entered Holding. Use **/backlog** …” |

---

## 6. Interaction handlers (modals, buttons, selects)

- **Modals**: bug details, feature title, repos add, schedule, docs search, FAQ ask/search, FAQ answer, project-db schema, invite email, verify email/OTP, backlog approve, edit-docs.  
- **Buttons**: init confirm/cancel, bug cancel/create, feature create/cancel, repos add/list/confirm/cancel, scrap confirm/cancel, dashboard modules, FAQ ask/search, verify get-code/enter-OTP, invite enter-email, approve confirm/cancel, doc traversal refresh/back.  
- **Selects**: bug repo/members, feature project/assignees, backlog user, approve user/roles, ticket select/status, schedule members/confirm/cancel, project-db project, evaluate user, docs repo, faq-answer FAQ, dashboard module, fetch-my category, doc traversal select, edit-docs select.  

(Exact `customId` values are in `handlers/interactions.js`.)

---

## 7. Data (database entities)

- **GuildConfig**: guildId, onboardingChannelId, holdingRoleId, verifiedRoleId, adminChannelId, allowedDomains, dashboardRoleIds, seniorRoleIds.  
- **GuildMember**: discordId, guildId, email, verifiedAt, status (e.g. pending, approved), roleIds (JSON).  
- **Repository**: name, url, projectName, projectId (per guild).  
- **BugTicket**: repositoryId, title, description, status (pending, resolved, abandoned), taggedMemberIds, createdBy, discordChannelId, externalIssueUrl/Number.  
- **Feature**: repositoryId, projectId, projectName, title, description, createdBy, assigneeIds, discordChannelId, status (open, in_progress, done).  
- **Task**: type, featureId, bugTicketId, modules, handlerId, scope, implementationStatus, passedApiTests, passedQaTests, passedAcceptanceCriteria.  
- **TicketDoc**: ticketType, featureId, bugTicketId, title, content (for close-feature / resolve-bug docs).  
- **ScheduledMeeting**: topic, scheduledAt, memberIds, createdBy, reminderSentAt.  
- **ProjectSchema**: projectId, projectName, schemaContent, readme (per guild).  
- **Faq**: repositoryId, question, answer, askedBy, answeredBy, answeredAt, status (open/answered).  
- **VerificationToken** / **VerificationOtp**: for email/link and in-Discord OTP verification.  
- **ClockEntry**: guildId, discordId, clockInAt, clockOutAt.  
- **Meeting** / **MeetingChannel**: meeting metadata and voice↔text channel mapping for meeting notes/transcription.  
- **email_log**: guildId, recipient_email, subject, content.  

---

## 8. Configuration files

- **`bot/src/config/command-config.json`**: `commandRoles`, `dedicatedChannels`, `commandDescriptions` per command name.  
- **`bot/src/config/channel-defaults.json`**: `pinnedMessages` per channel name for default pin content.  
- **`bot/src/constants.js`**: Role names (HIERARCHY_ROLES, DISCIPLINE_ROLES), channel/category names, colors, invite domain (e.g. @granjur.com), bug/feature status enums.  

---

## 9. External / optional

- **GitHub**: Used for repo README/docs and optional bug issue creation (token required).  
- **Verify base URL**: Optional external verify server (e.g. link-based verification).  
- **Transcription**: Optional (e.g. Whisper) for meeting voice in `meetingListener.js`.  

This document reflects the behavior implemented in the codebase as of the listed structure (commands, config, events, services, and DB layer).

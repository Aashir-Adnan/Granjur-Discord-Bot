# Granjur Discord Bot

Discord-only bot for a dev house: roles, email verification, bug tickets, features, meetings, FAQs, and analytics. **All commands are multi-step with embeds, select menus, buttons, and modals** for clear visual flow.

Runs on a **regular server**; connects to **MySQL on localhost** (or your DB host). No Docker.

## Quick start

1. **MySQL on localhost:** Create database and user (e.g. `CREATE DATABASE granjur;` and a user with access).

2. **Configure and run:**

```bash
cp .env.example .env
# Edit .env: DISCORD_TOKEN, DISCORD_CLIENT_ID, DATABASE_URL (mysql://user:pass@localhost:3306/granjur), GOOGLE_CLIENT_ID
npm install
npm run db:init            # creates MySQL tables (uses DATABASE_URL)
npm run deploy:commands   # optional: set DISCORD_GUILD_ID for one server
npm start
```

3. **Verify page (separate terminal):** Serves the link the bot sends for Google sign-in.

```bash
cd verify-page && npm install && npm start
```

- Bot: runs on this machine (verify callback on port 4070).
- Verify page: `http://localhost:3080` (set `VERIFY_BASE_URL=http://localhost:3080`, `BOT_VERIFY_URL=http://localhost:4070` in `.env`).

## Commands (all multi-step with UI)

| Command | Flow |
|--------|------|
| **/init** | Step 1: Embed + [Confirm setup] [Cancel] → Step 2: Run setup and show result |
| **/verify** | Step 1: Embed + [Get verification link] → Step 2: "Check your DMs" (link sent to DMs) |
| **/approve** | Step 1: Select user (holding) → Step 2: Multi-select roles → Step 3: [Approve] [Cancel] |
| **/repos** | Step 1: [Add repository] [List repositories] → Add: modal (name, URL, project) → confirm |
| **/bug** | Step 1: Select repo → Step 2: Modal (title, description) → Step 3: Select members to tag → Step 4: [Create ticket] (private channel + doc page) |
| **/resolve-bug** | (Only in a bug ticket channel) Attach MD file → resolves ticket and saves solution doc |
| **/ticket** | Step 1: Select ticket → Step 2: Select status (pending/resolved/abandoned) |
| **/feature** | Step 1: Modal (title, description) → Step 2: Select repo/project → Step 3: Select assignees → [Create ticket] (private channel + doc page) |
| **/close-feature** | (Only in a feature ticket channel) Attach MD file → closes ticket and saves doc |
| **/fetch-my** | Step 1: Select category (Bugs, Features, Meetings, All) → Step 2: Embed with your items |
| **/schedule** | Step 1: Modal (topic, when) → Step 2: Select members → Step 3: [Schedule] [Cancel] |
| **/project-db** | Step 1: Select project (or "+ New project") → view schema; or New: modal to paste schema |
| **/evaluate** | (Senior/CEO/Server Manager) Step 1: Select user → Step 2: Embed with bugs, features, commits |
| **/docs** | Step 1: Select repo → Step 2: Modal (search query) → Step 3: Embed with .md results (GitHub API) |
| **/faq** | Step 1: [Ask a question] [Search FAQs] → Ask: modal → recorded; Search: modal → embed results |
| **/faq-answer** | Step 1: Select unanswered FAQ → Step 2: Modal (answer) → saved |
| **/dashboard** | (CEO/Server Manager) Select what to view: Overview, **Tasks** (grouped by module), Bugs, Features, Meetings, FAQs → Embed |
| **/scrap** | Step 1: Embed + [Yes, reset server] [Cancel] → Step 2: Roles/channels removed, config cleared |

## Verification

A **verify page** is included in this repo (`verify-page/`). It serves the link the bot sends to users.

1. New members see only the **Onboarding** channel; bot assigns **Holding**.
2. They run **/verify** → click **Get verification link** → receive a DM with `VERIFY_BASE_URL/verify?token=...&discord_id=...&guild_id=...`.
3. They open that URL (e.g. `http://localhost:3080/verify?token=...`) and sign in with **Google**. The page checks the email domain (e.g. @granjur.com) and then `POST`s `{ token, email }` to the bot’s callback (`BOT_VERIFY_URL/verify`).
4. The bot marks them verified and keeps them in **Holding** until CEO/Server Manager runs **/approve** and assigns roles.

**Discord privileged intents (required):** In [Discord Developer Portal](https://discord.com/developers/applications) → your application → **Bot** → enable:
- **SERVER MEMBERS INTENT** (for `/approve`, new-member verification, and member lists)
- **MESSAGE CONTENT INTENT** (if you add features that read message text)

Without these, the bot will log in with "Used disallowed intents" and exit.

**Invite the bot with slash-command scope:** When generating the bot invite URL (OAuth2 → URL Generator), include the **applications.commands** scope. Without it, slash commands will not appear in the server. For faster command updates during testing, set `DISCORD_GUILD_ID` to your test server ID and run `npm run deploy:commands` once.

**Testing:** See [TESTING.md](TESTING.md) for step-by-step testing and why commands might not show up.

**Verify page setup:** From the repo root run `cd verify-page && npm install && npm start`. It reads `.env` from the repo root (`VERIFY_PAGE_PORT`, `BOT_VERIFY_URL`, `GOOGLE_CLIENT_ID`, `ALLOWED_EMAIL_DOMAINS`). **Google Sign-In:** Create a [Google Cloud OAuth 2.0 Web client ID](https://console.cloud.google.com/apis/credentials), set `GOOGLE_CLIENT_ID` in `.env`, and add the verify page origin (e.g. `http://localhost:3080`) to authorized JavaScript origins.

## Environment

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token |
| `DISCORD_CLIENT_ID` | Application ID |
| `DISCORD_GUILD_ID` | (Optional) Guild for registering slash commands in dev |
| `DATABASE_URL` | MySQL URL (e.g. `mysql://user:pass@localhost:3306/granjur`) |
| `ALLOWED_EMAIL_DOMAINS` | Comma-separated (e.g. `granjur.com`) |
| `VERIFY_BASE_URL` | Base URL of the verify page (link sent to users), e.g. `http://localhost:3080` |
| `BOT_VERIFY_URL` | Bot’s verify callback URL (used by verify page to POST), e.g. `http://localhost:4070` |
| `BOT_VERIFY_PORT` | Port for bot’s verify callback server (default 4070) |
| `VERIFY_PAGE_PORT` | Port for the verify page server (default 3080) |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 Web client ID (for verify page Sign in with Google) |
| `GITHUB_TOKEN` | (Optional) For creating issues from /bug and /docs, /evaluate (repo contents, commits) |

## Database

MySQL on localhost (or set `DATABASE_URL` to your MySQL server). Schema is in `bot/src/Database/schema.sql`. Run `npm run db:init` after creating the DB to create tables. Projects and schemas are stored in the bot DB; GitHub is optional for issues and repo contents.

**New tables:** `Task` (modules, type, handler, scope, implementation status, API/QA/acceptance) and `TicketDoc` (doc page per feature/bug ticket). For existing DBs, see migration comments at the bottom of `bot/src/Database/schema.sql` (e.g. `ALTER TABLE Feature ADD COLUMN assigneeIds ...`, `ALTER TABLE BugTicket ADD COLUMN description ...`).

**Seed dummy tasks:** `node bot/scripts/seed-tasks.js` (requires at least one GuildConfig from `/init`).

## Demo workflow

See **[DEMO_WORKFLOW.md](DEMO_WORKFLOW.md)** for a step-by-step flow: new user joins → verify → approve → use dashboard (tasks grouped by module), feature/bug tickets (private channels, doc pages), close-feature / resolve-bug with MD upload, and daily DM reminder for open tickets.

## /scrap

Resets the server: removes Granjur-created roles and channels, deletes guild config and related data. Run **/init** again to rebuild.

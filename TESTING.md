# How to test the Granjur Discord bot

## 1. Why slash commands might not show

**Slash commands not appearing is usually one of these:**

### A. Bot wasn’t invited with “applications.commands”

The invite link must include the **applications.commands** scope so the bot can register slash commands in your server.

1. Open [Discord Developer Portal](https://discord.com/developers/applications) → your app → **OAuth2** → **URL Generator**.
2. Under **SCOPES** tick: **bot** and **applications.commands**.
3. Under **BOT PERMISSIONS** tick what you need (e.g. Manage Roles, Manage Channels, Send Messages, Use Slash Commands, etc.).
4. Copy the **Generated URL** and open it in a browser. Choose your test server and authorize.

Re-invite the bot with this URL if you previously invited it without **applications.commands**.

### B. Commands are registered globally (slow)

If **DISCORD_GUILD_ID** is not set in `.env`, the bot registers commands **globally**. Global commands can take **up to 1 hour** to show in all servers.

**Fix:** Set your test server’s ID so commands register for that server only (they show up in about 1 minute).

1. In Discord: **User Settings** → **Advanced** → turn on **Developer Mode**.
2. Right‑click your test server icon → **Copy Server ID**.
3. In `.env` add: `DISCORD_GUILD_ID=that_server_id`.
4. Restart the bot (or run the deploy-commands script once).

### C. Register commands once with the script

You can register slash commands **without** running the full bot:

```bash
# From project root, with .env filled (DISCORD_TOKEN, DISCORD_CLIENT_ID, and optionally DISCORD_GUILD_ID)
node bot/scripts/deploy-commands.js
```

- With **DISCORD_GUILD_ID** set: registers commands for that server (fast).
- Without it: registers global commands (can take up to 1 hour).

Use this if the bot starts but commands still don’t appear (e.g. registration failed silently on startup).

---

## 2. Quick checklist before testing

- [ ] **.env** has: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` (and optionally `DISCORD_GUILD_ID` for fast commands).
- [ ] Bot was invited with **applications.commands** scope (see 1A).
- [ ] In Developer Portal → **Bot**: **SERVER MEMBERS INTENT** and **MESSAGE CONTENT INTENT** are enabled.
- [ ] MySQL is running on localhost; `npm start` and verify-page (`cd verify-page && npm start`) run without errors.
- [ ] Run `node bot/scripts/deploy-commands.js` once if you want to register commands immediately.

---

## 3. Step-by-step testing flow

### Start the stack

```bash
npm start
# In another terminal (optional, for /verify): cd verify-page && npm start
```

Wait until you see the bot log “Logged in as …” (and the verify page on port 3080 if you started it).

### 1) Invite the bot and run /init

1. In your test server, run **/init** (you need admin).
2. Click **Confirm setup**.
3. You should see: new **Onboarding** category, **welcome-and-verify** channel, and roles (Holding, Verified, hierarchy, discipline).

### 2) Test verification (optional)

1. Use an alt account or leave and rejoin with another account.
2. That account should only see the onboarding channel.
3. Run **/verify** → **Get verification link** → check DMs for the link.
4. Open the link (e.g. `http://localhost:3080/verify?token=...`), sign in with Google (allowed domain).
5. Back in Discord, that user should be in “Holding”. As admin, run **/approve** → select the user → select roles → **Approve**. They should then see the rest of the server.

### 3) Test repos and bug

1. Run **/repos** → **Add repository** → fill name, URL, optional project → confirm.
2. Run **/bug** → choose repo → enter title/description → choose members to tag → **Create ticket**. A new channel and (if GitHub is set) an issue should be created.

### 4) Other commands

- **/repos** → **List repositories** to see what you added.
- **/feature** → enter title/description → choose repo or project.
- **/fetch-my** → choose Bugs / Features / Meetings / All.
- **/schedule** → enter topic and time → choose members.
- **/ticket** → pick a ticket → set status.
- **/faq** → Ask or Search.
- **/dashboard** (CEO/Server Manager roles) → pick a module.
- **/scrap** (admin) resets the server so you can run **/init** again.

---

## 4. If commands still don’t appear

1. Confirm **applications.commands** was in the invite (1A).
2. Set **DISCORD_GUILD_ID** and run `node bot/scripts/deploy-commands.js`, then wait 1–2 minutes and type `/` in the server.
3. Check bot logs for “Slash command registration warning” or other errors on startup.
4. In Developer Portal → **Bot** → **Reset Token** if the token might be wrong, then update **DISCORD_TOKEN** and restart.

# Identity link and access scoping — design

**Date:** 2026-09-28
**Repos:** Granjur-Discord-Bot (bot), CSAAS_Backend (CSAAS), UBS-Doc (site)
**Status:** approved in conversation 2026-09-28; this is the written spec.
**Roadmap position:** sub-project 1 of 7 (see "Roadmap" at the end).

## Goal

Resolve the Discord-id vs site-login mismatch by storing a link between a UBS-Doc
account and a Discord member, and use it so a site user sees and changes only the
projects and tasks they are part of. Owner's words: "persisting a mapping between a
Discord identity and a UBS Doc profile/URDD so a user can see and make changes only in
their tasks and projects they are part of, not make changes to any other projects or
even filter them out."

## Today (facts this design changes)

- The only bridge is an email string. The bot's `/verify` stores whatever email the
  member typed after an emailed OTP (`guildmember.email`, non-unique); CSAAS matches the
  portal user's verified email against it (`timeScope.js` `callerIdentity`,
  `internalTaskRoute.js` `siteActor`). One email can match two Discord ids; the match
  picks one arbitrarily. CSAAS has no stored link to a Discord id.
- `GET /api/discord/tasks` returns every project, task and member in every guild to any
  signed-in caller. The write endpoints (`/status`, `/create`, `/update`, `/subtask`)
  check only `update_discord_tasks`.
- The Time tab already narrows to "self" without `view_discord_time`, by email match.

## Decisions taken with the owner

| Question | Answer |
|---|---|
| How a link is made | Automatically by verified email when exactly one Discord member matches; otherwise a code from `/link` in Discord entered on the site; admins can see and remove links |
| Who sees everything | Site Platform Admin / Admin, and anyone whose linked Discord account holds CEO or Server Manager |
| What "my project" means | A project where the user is an explicit member (`projectmember`) or holds at least one task (assignee/tagged) — the membership Discord already shows |

## Design

### 1. The link table (CSAAS)

New migration `data/migrations/20260929_1_discord_identity_link.sql`:

```sql
CREATE TABLE IF NOT EXISTS discord_identity_link (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT          NOT NULL,          -- users.user_id
  guild_config_id  VARCHAR(36)  NOT NULL,          -- granjur.guildconfig.id
  discord_id       VARCHAR(32)  NOT NULL,
  linked_via       ENUM('email','code','admin') NOT NULL,
  linked_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_link_user_guild (user_id, guild_config_id),
  UNIQUE KEY uq_link_guild_discord (guild_config_id, discord_id),
  KEY idx_link_discord (discord_id)
);
```

The column types of `user_id` and the charset/collation must match `users.user_id` and
the `granjur` ids; the plan checks them against the live schema definitions in the repo
before writing the migration. No foreign key across databases.

### 2. Resolving the caller (CSAAS, one module)

New `Src/Apis/ProjectSpecificApis/DiscordTasks/identity.js`, the one home for "who is
this site user in Discord", replacing `timeScope.js`'s `callerIdentity` and the bot-side
email guess for attribution:

`resolveIdentity(req, decryptedPayload, hooks) → { userId, email, links: [{ guildConfigId, discordId, via }], seesAll }`

1. The user comes from the verified token only (`__identityVerified`, `actor_email`,
   and the user id `actorBinding.js` resolves). No verified user → no identity.
2. Existing links for that `user_id` are read.
3. For each guild with no link: `SELECT discordId FROM granjur.guildmember WHERE
   guildConfigId = ? AND LOWER(email) = ? AND verifiedAt IS NOT NULL`. Exactly one row,
   and that `discordId` not already linked to another user → insert a link with
   `linked_via = 'email'` (`INSERT IGNORE`, so two concurrent requests cannot fail).
   Zero or several rows → no link for that guild.
4. `seesAll` is true when the user is a site admin — an active URDD whose role is
   `Admin` or `Platform Admin`, or an email in the admin allowlist (`actorIsRoleAdmin`
   alone covers only Platform Admin and the allowlist, not the org `Admin` role) — or
   when any linked member's `guildmember.roleNames` contains `CEO` or `Server Manager`
   (the bot's `LEADERSHIP_ROLE_NAMES`). The admin part alone is `isAdmin`, which gates
   the link-management endpoints.
5. CSAAS tables and the bot's `granjur.*` tables are never JOINed on string columns
   (their collations can differ, which makes MySQL refuse the comparison); each side is
   queried separately and joined in JavaScript.

### 3. Linking by code (bot + CSAAS + site)

- **Bot:** new migration `027_discord_link_code.sql`, table `discordlinkcode`
  (`id`, `guildConfigId`, `discordId`, `code` CHAR(6) unique, `expiresAt`, `usedAt`,
  `createdAt`). New `/link` command (role gate `Verified`, same as `/create-task`):
  replies ephemerally with a fresh code from an unambiguous alphabet (no `0/O/1/I`),
  valid 10 minutes; running it again replaces the member's unused code.
- **CSAAS:** `POST /api/discord/identity/link` `{ code }` (accessToken,
  bindActorToToken, no permission beyond sign-in): reads `granjur.discordlinkcode`
  (unused, not expired, case-insensitive), refuses if that Discord member is linked to
  another user or this user already has a link in that guild (400 with a sentence),
  otherwise inserts the link (`linked_via = 'code'`) and marks the code used
  (`UPDATE granjur.discordlinkcode SET usedAt = NOW()` — the one write CSAAS makes to the
  bot's database, on a table that exists only for this handshake).
- **CSAAS:** `GET /api/discord/identity/me` → `{ linked: bool, links: [{ guildConfigId,
  discordId, name, avatarUrl, via }], seesAll }`.
- **CSAAS (admin):** `GET /api/discord/identity/links` and `POST
  /api/discord/identity/unlink` `{ user_id, guild_config_id }` — both require
  `isAdmin` (section 2); unlink deletes the row so the person can link again.

### 4. Reading, scoped (CSAAS)

`GET /api/discord/tasks` gains `bindActorToToken` and filters by `resolveIdentity`:

- `seesAll` → unchanged output.
- Otherwise, for the caller's linked `(guildConfigId, discordId)` pairs:
  - **visible projects** = projects with a `projectmember` row for the caller, plus
    projects containing a task whose holders include the caller;
  - **visible tasks** = every task in a visible project, plus tasks the caller holds that
    have no project (holding a task in a project already makes that project visible);
  - a reference to an invisible task (`blockedBy`, `blocks`, `parent`, `subtasks`) is
    reduced to `{ id, title: 'A task in another project', status, hidden: true }` — the
    real title and people never leave CSAAS; the status stays so "blocked" still reads
    correctly — and the site renders it as plain text, not a link;
  - `members[]` stays the full roster (assigning anyone remains possible), but each
    member's `projects` list is trimmed to visible projects;
  - `repositories` unchanged.
- Not linked and not `seesAll` → `{ projects: [], members: [], repositories: [], linked: false }`.
- The response gains `viewer: { linked, seesAll, discordIds: [...] }` so the site knows
  who is looking.

`GET /api/discord/projects/stats` applies the same visible-project set.
`timeScope.js` keeps its self/all rule but takes the caller's Discord id from
`resolveIdentity`'s links instead of an email match.

### 5. Writing, scoped (CSAAS)

All four write handlers keep `requirePortalPermission(..., "update_discord_tasks")` and
then, unless `seesAll`:

- `/status`, `/update`: the task must be visible to the caller (section 4's rule);
  an `/update` whose `project_id` changes must also target a visible project.
- `/subtask`: the parent must be visible.
- `/create`: the `project_id` must be a visible project.

Refusal → 403 with `You can only change tasks in projects you are part of.` The check
reads the task/project rows with the same queries as section 4 (one helper,
`visibility.js`, shared by read and write paths).

The actor sent to the bot gains `discordId` (the caller's link in the task's guild);
the bot's `siteActor` uses it as `activityId` when present and only falls back to the
email match when it is absent (older CSAAS). Channel posts still name, never mention.

### 6. Site

- `api.ts`: `fetchIdentity()`, `linkDiscord(code)`, admin `fetchLinks()`,
  `unlinkDiscord(userId, guildConfigId)`.
- Team section: while `payload.viewer.linked === false` and not `seesAll`, a "Link your
  Discord account" card replaces the tab content: one line explaining email matching is
  tried first, how to run `/link` in Discord, a code box, and the sentence from any
  refusal. On success, `refresh()`.
- Header: "Signed in as <Discord name>" (from `viewer`), or "Viewing everything" for
  `seesAll`.
- Hidden refs render as "a task in another project" (no link).
- People tab, admins only: link status per member and an Unlink button.

## Error handling

| Case | Result |
|---|---|
| Two Discord members share the user's email | No automatic link; the card asks for a `/link` code |
| Code wrong / expired / used | 400 `That code is not valid. Run /link in Discord for a new one.` |
| Discord member already linked to someone else | 400 `That Discord account is already linked to another site account. Ask an admin.` |
| Write to a task outside your projects | 403 `You can only change tasks in projects you are part of.` |
| Link table missing | Cannot happen in a running CSAAS: migrations run at startup before it serves requests, so there is no fallback path |
| Bot older than CSAAS (no `discordlinkcode` table) | `/identity/link` answers 503 `Linking by code is not available yet.`; email linking still works |

## Testing

- CSAAS node scripts (hooks, no DB): identity resolution (one match links, two matches
  don't, an already-linked Discord id isn't stolen, seesAll by role and by Discord
  leadership), code linking (valid, expired, used, taken), visibility (explicit member,
  assignee-only, holder of a project-less task, hidden refs, trimmed member projects),
  every write handler's 403, stats filtering.
- Bot `node:test` with fakes and `DATABASE_URL=poisoned://no-production-access`:
  `/link` code creation/replacement, `siteActor` preferring `actor.discordId`.
- Site vitest: link-card state logic, hidden-ref rendering helper.

## Rollout

Bot (migration 027, `/link`) → CSAAS (migration, identity, filters — **manual deploy**,
pushes do not deploy CSAAS) → site. Scoping takes effect when CSAAS is live; until then
the site behaves as today.

## Roadmap (the other six sub-projects, in order; each gets its own spec)

2. **Scope everywhere** — scope filter on Board and Tasks; Claude-generated tasks forced
   to the four scope values.
3. **Global channel layout** — trim the global staff/onboarding channels to
   announcements and casual (plus documentation); add a global feedback channel. Deletes
   live channels, so it ships with a preview.
4. **Repositories per project with a scope** — a task's scope selects the repository and
   opens the GitHub issue (today only bugs open one).
5. **Clock in / out on the site** — needs this sub-project's identity.
6. **JSON task import** with a documented format — imports only into your projects.
7. **Meeting docs/JSON → Claude → tasks** without a meeting, and a document field when
   a meeting starts.

# Identity link and access scoping

Built 2026-09-29 on `feat/identity-link` in all three repos (bot, CSAAS, site);
**not merged or deployed anywhere**. Spec
`docs/superpowers/specs/2026-09-28-identity-link-access-scoping-design.md`, plan
`docs/superpowers/plans/2026-09-28-identity-link-access-scoping.md`, ledger
`.superpowers/sdd/2026-09-28-identity-link-access-scoping/progress.md` (every ruling
made during the build, task by task).

## The problem

Owner: "persisting a mapping between a Discord identity and a UBS Doc profile/URDD so
a user can see and make changes only in their tasks and projects they are part of."
Before this, the only bridge between a site login and a Discord member was an email
string match, computed fresh on every request (`timeScope.js`'s old `callerIdentity`,
the bot's `siteActor` email guess) — no stored link, one email could match two Discord
ids arbitrarily, and `GET /api/discord/tasks` returned every project, task and member
in every guild to any signed-in caller regardless of match.

## The CSAAS table: `discord_identity_link`

`data/migrations/20260929_1_discord_identity_link.sql`, CSAAS repo:

```sql
CREATE TABLE discord_identity_link (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  guild_config_id VARCHAR(36) NOT NULL,
  discord_id VARCHAR(64) NOT NULL,
  linked_via ENUM('email','code','admin') NOT NULL,
  linked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_link_user_guild (user_id, guild_config_id),
  UNIQUE KEY uq_link_guild_discord (guild_config_id, discord_id),
  KEY idx_link_discord (discord_id)
);
```

Two unique keys, each closing a different half of "one link per pair": a site account
gets at most one Discord member per guild (`uq_link_user_guild`), and a Discord member
links to at most one site account per guild (`uq_link_guild_discord`). No foreign keys
— `guild_config_id`/`discord_id` live in the bot's `granjur` database, not CSAAS's.

A sibling table, `discord_identity_link_block (user_id, guild_config_id)`, records that
an admin unlinked this pair on purpose — see "Rulings" below.

## `identity.js`: `resolveIdentity` (CSAAS, the one resolver)

`Src/Apis/ProjectSpecificApis/DiscordTasks/identity.js`. Every Discord-data endpoint
calls this; nothing else queries `discord_identity_link` directly.

- **Token-only.** `verifiedEmail(decryptedPayload)` reads `actor_email` only when
  `__identityVerified` is true — a value `actorBinding.js` sets solely from the
  verified access token, never from request body/query.
- **`user_id` 0 is a real account** (Platform Admin) — `userIdFor` returns `null` for
  "no match" and never treats `0` as falsy.
- **Auto-link by email**, once per guild with no existing link: `SELECT discordId FROM
  granjur.guildmember WHERE guildConfigId = ? AND LOWER(TRIM(email)) = ? AND
  verifiedAt IS NOT NULL`. Links only when **exactly one** row comes back and that
  Discord id is not already linked to a different user (`INSERT IGNORE`, so two
  concurrent requests can't race into an error). Two matching members, or zero,
  means no automatic link for that guild — the site falls back to a `/link` code.
- **`isAdmin` vs `seesAll`.** `isAdmin` = `actorIsRoleAdmin` (Platform Admin / the
  email allowlist) **or** an active URDD holding the org `Admin` role — deliberately
  wider than `actorIsRoleAdmin` alone, because that helper does not cover the org
  `Admin` role. `seesAll` = `isAdmin` **or** any of the caller's linked members has
  `CEO` or `Server Manager` in `guildmember.roleNames` (the bot's own
  `LEADERSHIP_ROLE_NAMES`, duplicated here as `LEADERSHIP_ROLES`). `isAdmin` alone
  gates the link-management endpoints (`/identity/links`, `/identity/unlink`);
  `seesAll` gates read/write scoping.

## `/link` → `discordlinkcode` → `POST /api/discord/identity/link`

The one CSAAS write into the bot's own database.

- **Bot:** migration `027_discord_link_code.sql`, table `discordlinkcode` (`id`,
  `guildConfigId`, `discordId`, `code` CHAR(6) UNIQUE, `expiresAt DATETIME`, `usedAt`,
  `createdAt`). `bot/src/commands/link.js`: `/link` generates a 6-character code from
  an unambiguous alphabet (`CODE_ALPHABET`, no `0/O/1/I`), `db.discordLinkCode.issue`
  first sweeps day-old rows and the member's own unused code, then inserts a fresh one
  with `expiresAt = DATE_ADD(NOW(), INTERVAL 10 MINUTE)` — **MySQL's own clock, not
  Node's**, so it can't drift and, per Ruling below, running `/link` again always
  replaces the unused code rather than stacking a second one. **Single use**: CSAAS
  claims it with `UPDATE ... SET usedAt = NOW() WHERE id = ? AND usedAt IS NULL AND
  expiresAt > NOW()`, checking `affectedRows === 1`, *before* doing anything else with
  the row — a second concurrent redemption of the same code claims zero rows instead
  of racing past the check.
- **CSAAS:** `POST /api/discord/identity/link` (`discordIdentity.js` `postLink`,
  `accessToken: true`, `bindActorToToken: true`, no `permission`) calls
  `identity.linkByCode(who, code, hooks)`. Refuses with `400` if the code is bad/
  expired/used/wrong-shape, if the caller already has a link in that guild
  (`alreadyLinked`), or if the Discord member is already linked to someone else
  (`taken`); a bot older than migration 027 (`ER_NO_SUCH_TABLE`) answers `503
  Linking by code is not available yet.` A successful redemption also `DELETE`s any
  row in `discord_identity_link_block` for that `(user_id, guild_config_id)` pair.
  **Rate-limited**: `discordIdentity.js` tracks failed (400-only) attempts per
  `userId` in an in-memory map, 10 failures per 15-minute window, then `429 Too many
  attempts. Wait a few minutes, then run /link again.` A success clears the counter;
  a 401/503 from `linkByCode` does not count as a guess.

## `visibility.js`: "my project", hidden refs, write refusals

`Src/Apis/ProjectSpecificApis/DiscordTasks/visibility.js`, shared by the read
endpoint and every write handler.

- **"My project"** = a `projectmember` row for the caller's linked `(guildConfigId,
  discordId)`, **or** a task in that project the caller holds (`assigneeIds`, falling
  back to `taggedMemberIds`). A dangling project id (a task/`projectmember` row
  pointing at a project id not among the ones actually loaded) never counts as
  visible on its own — the task instead follows the project-less rule: visible only
  because the caller holds it.
- **Hidden-ref stub shape:** `{ id, title: 'A task in another project', status,
  hidden: true }` (`hiddenRef`). Real titles and people never leave CSAAS for a task
  outside the caller's visible set; `status` is kept so "blocked" still reads
  correctly. Applied to `blockedBy`/`blocks`/`parent`/`subtasks` entries in the tasks
  read (`discordTasks.js`), and to activity-log `blocked_by`/`subtask` changes by
  **title match** against the guild's visible-title set (the bot's activity log
  stores titles, not ids — see "Deferred" below) and `project` changes by name match
  (falls back to `"another project"`, not the hidden sentence, for the from/to
  fields).
- **Write refusals:** `assertCanTouchTask`/`assertCanUseProject` (both 404 `Task not
  found` for a missing row, 403 `You can only change tasks in projects you are part
  of.` for a visible-but-not-yours one, `seesAll` skips the membership check but
  **still reads the row** — needed so the caller's own guild for *this* task is known,
  not a link from some other guild). `assertCanAddBlockers` only checks **newly
  added** blocker ids against visibility; an existing hidden blocker already on the
  task is never re-checked, so an ordinary save that doesn't touch blockers can't be
  broken by one.
- **`linkedDiscordId`/`actorWithLink`**: the actor sent to the bot gains `discordId`
  only when the caller has a link in the **task's own guild** (no `links[0]`
  fallback — a link in a different guild would name the wrong Discord account).
  Exception: `/create` with no project and exactly one link uses that link.
- **Writes need a link** (`assertCanWrite`, final-review F4): a non-seesAll caller
  with no links gets 403 `Link your Discord account to change tasks.` on `/status`,
  `/update`, `/create` and `/subtask`, before any bot call.
- **`hiddenRelatedTaskIds`** (final-review F1): for a non-seesAll caller, the ids of
  the target task's blockers, the tasks it blocks and its subtasks that the caller
  cannot see (same rule as `assertCanTouchTask`), capped at 200. `/status`, `/update`
  and `/subtask` send them to the bot as `hiddenTaskIds` (key omitted when empty).
  The bot (`redactSetFrom` in `internalTaskRoute.js`, threaded as `redact` through
  `applyEdit`/`applyTaskUpdate`/`assertCanFinish`) names those tasks "A task in
  another project" in the three reply texts that can carry a title back: the
  blocker warning (`blockerWarning`), the unblock line (`applyDependencyChange`) and
  the "can't be finished" refusal (`finishBlockMessage`). The Discord channel post
  and the activity row keep the real titles; with no set the texts are unchanged.

## The bot's `siteActor` prefers the linked id

`bot/src/services/internalTaskRoute.js` `siteActor(dbArg, guildConfigId, actor)`: if
`actor.discordId` is present and looks like a Discord id (`/^\d{1,32}$/`), it is used
directly as `activityId` — CSAAS sends the caller's own stored link, trusted like the
rest of the body (the shared internal secret already gates the whole request). Only
when absent does it fall back to the old `guildmember.email` lookup. This is the one
line of bot code this feature touches beyond `/link` itself.

## The no-cross-database-string-JOIN rule

CSAAS's own tables (`discord_identity_link`, `users`, `discord_identity_link_block`)
and the bot's `granjur.*` tables are **never JOINed in SQL**, anywhere in this
feature — every query reads one side, and the two result sets are joined in
JavaScript. Reason: the two databases' string columns can have different collations,
and MySQL refuses to compare them across a JOIN. This is a hard rule, not a style
preference — see `identity.js`'s module comment and every function in it.

## The site: link card, viewer line, hidden refs, admin panel

- **`normalizePayload`** (`src/screens/team/payloadLogic.ts`) turns the raw
  `/discord/tasks` response into a trusted `TasksPayload`, keeping `viewer` and
  `repositories` as optional fields present only when the backend sends them (an
  older CSAAS omits both). This also fixed a pre-existing bug: `TeamLayout.refresh()`
  had been dropping `repositories` on every refresh (rebuilding the payload from
  `generatedAt`/`projects`/`members` only), which is why the site-task-edit create
  page's repository list was always empty on `main` — refreshing now keeps it.
- **Link card** (`LinkCard.tsx`): shown instead of the Outlet on the People, Tasks
  and Board tabs only (`showsLinkCard(payload, tab)` in `identityLogic.ts` —
  `needsLink(payload)`, i.e. `viewer.linked` and `viewer.seesAll` both false, and the
  tab is one of those three). Time and Stats follow `view_discord_time`, not the
  link, so they render normally while unlinked; the tab bar always shows, and the
  filter/search controls are hidden only where the card shows (`TeamLayout.tsx`).
  Explains email auto-linking, takes a 6-character code, calls `linkDiscord(code)`,
  and re-runs `refresh()` on success.
- **Signed-in line** (`viewerLine` in `identityLogic.ts`): "Signed in as <name>",
  "Signed in with your Discord account" (linked, no name yet), "Viewing every
  project" for `seesAll`, or both combined.
- **Hidden refs** render as plain, non-clickable text using the stub's `title`
  ("A task in another project") wherever a task reference can appear: `TaskDetail`
  (parent line, subtask checklist rows), `SubtaskChecklist`, and `DependencyGraph`
  (a hidden node is drawn but not clickable; an unresolved-but-not-hidden ref is
  drawn as its own stub node with a title, which used to be silently dropped).
- **Admin links panel** (`IdentityLinks.tsx`, on `People.tsx`, gated on
  `payload.viewer.isAdmin`): every stored link (name/email ↔ Discord name/id, `via`),
  with an Unlink button that confirms, then calls `unlinkDiscord(userId,
  guildConfigId)` and reloads the list.

## Rulings that changed behaviour vs the original spec

- **An admin unlink blocks email re-linking for that account+server** until a `/link`
  code redemption proves the person owns the Discord account again
  (`discord_identity_link_block`, cleared by `linkByCode`). Not in the original spec
  text (which only said "the person links again with a code"); added because the bot
  keeps a `guildmember`'s `verifiedAt` set when an invite rejoin overwrites its
  `email` — without the block, the very next `resolveIdentity` call could silently
  re-create the link the admin just removed, via a stale/wrong email match. See
  "Deferred" below for the bot-side root cause this papers over.
- **Code redemption claims the code first** (`UPDATE ... usedAt = NOW() WHERE usedAt
  IS NULL AND expiresAt > NOW()`, checking `affectedRows`), before doing anything
  else with it — closes a race where two concurrent redemptions of the same code
  could otherwise both pass an initial `SELECT`-based check.
- **Hidden refs keep their `status` field** and use the exact title `'A task in
  another project'` (not a generic placeholder) — status is needed so a hidden
  blocker still renders as "blocked" correctly on a task the caller *can* see.
- **The org `Admin` role counts as a site admin** for this feature's purposes
  (`isSiteAdmin` in `identity.js`), even though `actorIsRoleAdmin` — the framework's
  existing admin check, used elsewhere — does not cover it. `isAdmin` here is
  `actorIsRoleAdmin OR org Admin role`.

## Rollout

Bot (migration 027 runs on deploy) → site (Vercel, builds on push) → CSAAS (**manual
deploy** — pushes to CSAAS's `main` do not auto-deploy; migration runs at CSAAS startup,
before it serves any request). The site ships before CSAAS because the new site works against the old CSAAS (no `viewer` in the payload, so no link card and nothing changes), while the old site against the new CSAAS would leave unlinked users on an empty page with no way to link. Scoping has no effect until CSAAS is live;
until then the site behaves exactly as before this feature. See `backlog.md` for the
full rollout/first-live-check list.

## How to verify

- A linked non-admin, non-leadership site user sees only the projects they are an
  explicit member of or hold a task in — every other project, task, and cross-project
  reference is gone or shown as a hidden stub.
- An admin (or anyone whose linked Discord account holds CEO/Server Manager) still
  sees everything, unchanged from before this feature.
- `/link` in Discord produces a code; entering it on the site's link card succeeds
  once and a second attempt with the same code fails (`That code is not valid...`).
- A site edit to a task outside the caller's visible projects is refused with `403
  You can only change tasks in projects you are part of.`

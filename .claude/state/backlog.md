# Backlog

Outstanding work, highest priority first. Move items to `completed.md` (dated) when done.

---

## Owner roadmap, 2026-09-28 — seven sub-projects, in build order (each: spec → plan → build)
1. **Identity link and access scoping — DEPLOYED (2026-09-29).** Spec
   `docs/superpowers/specs/2026-09-28-identity-link-access-scoping-design.md`, knowledge
   `.claude/knowledge/identity-link.md`. Merged and pushed in all three repos; the owner
   confirmed CSAAS is deployed. Site users see and change only their projects/tasks.
   - **Owner decision (2026-09-29): leave the org-level `Admin` role as it is** — it
     keeps `seesAll` and link management alongside `Platform Admin`, matching what
     shipped (`isAdmin = actorIsRoleAdmin OR org Admin role`, `identity-link.md`). Closes
     the open question raised during this build and carried into sub-project 2.
   - **First live checks (still worth doing once):** a linked non-admin sees only their own projects; an admin (or
     anyone whose linked Discord account holds CEO/Server Manager) still sees everything;
     a `/link` code works once (a second attempt with the same code fails); unlink then
     re-link needs a fresh `/link` code (email auto-link is blocked after an admin unlink).
   - **Bonus from this deploy:** the site create page's repository list, which has been
     empty on `main` since the site-task-edit build (`TeamLayout.refresh()` was dropping
     `repositories` from the payload), starts working the moment the site's `feat/identity-link`
     build ships — `normalizePayload` fixed it as a side effect.
   - **Deferred (review-flagged, not required for rollout):**
     - The bot keeps a `guildmember`'s `verifiedAt` when an invite rejoin overwrites its
       `email` — the root cause behind the admin-unlink-blocks-email-relink rule in
       `identity-link.md`. Worth fixing in the bot directly (clear or re-check `verifiedAt`
       on a rejoin that changes the stored email) so CSAAS's block table is only a
       safety net, not the only thing preventing a silent wrong re-link.
     - The bot's task activity log records blocker/subtask **titles**, not ids
       (`taskactivity.changes`). CSAAS's visibility scrubbing has to match hidden refs by
       **title text** against the guild's visible-title set — workable, but a title
       collision (a visible task sharing a hidden task's exact title) would show that
       title even though it's coincidental. Recording ids in the activity log instead
       would make this exact rather than heuristic.
     - The visual check of the link card and the admin People-tab links panel was never
       done — no portal sign-in was available during the build (same limitation noted on
       earlier site work). Do a real sign-in pass, light and dark, before calling this done.
2. **Scope everywhere and meeting-task projects — DEPLOYED 2026-09-29.** Bot deploy applied
   migration 028 (post-check: 0 scopes outside the four, all lowercase, `updatedAt`
   preserved); CSAAS applied `20260929_2` at startup (`meeting_tasks.scope` present); site
   pushed to Vercel. Remaining: a live meeting to see the "Which project?" select and the
   Scope/Modules lines, and a look at the site's Scope filter. Spec
   `docs/superpowers/specs/2026-09-29-scope-and-meeting-projects-design.md`, plan
   `docs/superpowers/plans/2026-09-29-scope-and-meeting-projects.md`, knowledge
   `.claude/knowledge/csaas-meeting-workflow-integration.md` ("Scope and meeting-task
   projects") and `.claude/knowledge/project-tasks-site.md` ("Scope filter"). Branch
   `feat/scope-meeting-projects` (bot), `feat/meeting-task-scope` (CSAAS), `feat/scope-filter`
   (site), merged into each local `main` on 2026-09-29 (bot `f62baa4`, CSAAS `09b2f61`, site
   `4f6dc09`); not pushed yet. Every task carries one of
   `backend`/`frontend`/`qa`/`design` or none (Claude picks, the platform falls back by
   language, old free text moves into Modules); a meeting task gets the meeting's own
   project automatically, falling back to the project Claude named, and only a task neither
   settles asks the reviewer which project; the site's Team Board and Tasks tabs gain a
   Scope filter.
   - **Rollout, in order (bot → CSAAS → site), each step needing the owner's go-ahead. The preview runs BEFORE the bot's `main` is pushed — pushing
     deploys the bot, and the deploy workflow runs `npm run db:migrate`, so migration 028
     must not reach production unreviewed:**
     1. **Preview migration 028 on production first** (read-only, credentials only from env
        vars), BEFORE pushing the bot. **DONE 2026-09-29:** 146 tasks, rows_touched 81
        (case_fixed 2, moved_to_modules 79, blank 0), non_array_modules 0, has_ctrl_ws 0.

       ```sql
       SELECT
         SUM(LOWER(TRIM(scope)) IN ('backend','frontend','qa','design')
             AND CAST(scope AS BINARY) <> CAST(LOWER(TRIM(scope)) AS BINARY)) AS case_fixed,
         SUM(scope IS NOT NULL AND TRIM(scope) = '')                         AS blank_to_null,
         SUM(scope IS NOT NULL AND TRIM(scope) <> ''
             AND LOWER(TRIM(scope)) NOT IN ('backend','frontend','qa','design')) AS moved_to_modules,
         SUM(modules IS NOT NULL AND JSON_TYPE(modules) <> 'ARRAY')          AS non_array_modules,
         SUM(scope REGEXP '[\t\r\n]')                                        AS has_ctrl_ws,
         SUM(scope IS NOT NULL AND (CAST(scope AS BINARY) <> CAST(LOWER(TRIM(scope)) AS BINARY)
             OR LOWER(TRIM(scope)) NOT IN ('backend','frontend','qa','design'))) AS rows_touched
       FROM task;
       ```

        `non_array_modules` must be 0; if not, stop and show the owner those rows (the
        migration's step 3 would replace a non-array `modules` value with a fresh array).
        `has_ctrl_ws` flags a scope containing a tab or newline: MySQL's `TRIM()` strips only
        spaces, so such a value would fail both the blank-check and the fixed-value match and
        get moved into `modules` instead of normalising — worth showing the owner alongside
        the `non_array_modules` rows, though not itself a reason to stop. `rows_touched` is
        the total number of rows migration 028 will rewrite.
     2. **Bot** to `main` — runs migration 028 automatically on its usual deploy path.
     3. **CSAAS** to `main` — a push deploys automatically (the "Deploy to Azure"
        workflow), and `Src/server.js` runs `runMigrationsOnStart()` before serving, so
        `data/migrations/20260929_2_meeting_tasks_scope.sql` adds the column before the new
        code (whose `meeting_tasks` INSERT names it) handles a request. No separate step.
     4. **Site** to `main` — Vercel builds on push.
     5. **Post-deploy check**, after the bot deploy finishes:

       ```sql
       SELECT COUNT(*) FROM task WHERE scope IS NOT NULL AND scope NOT IN ('backend','frontend','qa','design');
       ```

        Must be 0 — catches a meeting mirrored by the old process between `db:migrate`
        running and the bot process restarting. If non-zero, re-running 028's four
        statements by hand is safe (idempotent).
     - Each order tolerates the others' old version: the new bot with the old CSAAS falls
       back to the platform for scope; the old bot ignores the new CSAAS column; the site
       filter works on whatever scopes already exist.
   - The usman@granjur.com permission fix (CSAAS `20856ae`, site `a594551`) is pushed, so
     it deployed with those pushes. (The org-level `Admin` role question carried from
     sub-project 1 is resolved — see item 1 above.)
3. **Global channel layout and feedback — DEPLOYED 2026-09-29.** Trims `/init`'s global
   layout to Onboarding/Announcements/Casual/Documentation/Feedback/Meetings (Rules,
   Archive, Frontend/Backend/Database and Command channels dropped — nothing reads them);
   adds a global `#feedback` channel (Verified only, never clients) and `/feedback`.
   Spec `docs/superpowers/specs/2026-09-29-global-channel-layout-design.md`, knowledge
   `.claude/knowledge/global-layout.md`. Branch `feat/global-channel-layout` (base
   `44d80a4`, commits `65e09db..997dc26`; spec `65e09db`, plan `819d334`, code
   `913b8e3..997dc26`), bot repo only, migration 029 (`guildconfig.feedbackChannelId`).
   Suite 1375 tests (final-review fix wave 2026-09-29 added 3 to `cleanup.test.js`), `fail 0`.
   Merged, pushed and deployed; the owner ran `/setup` then `/cleanup` on the live server
   on 2026-09-29, confirming the preview list before deleting.
   - **Rollout that was followed, each step taken with the owner's go-ahead:**
     1. Pushed the bot's `main` — the deploy ran migration 029, and the restarted bot
        registered `/feedback`.
     2. Ran `/setup` on the live server — `#feedback` appeared (the reply's "Feedback"
        line said "created now").
     3. Ran `/cleanup` and **read the list before confirming**: Rules, Archive,
        the Frontend/Backend/Database channels, the `cmd-*` channels, their now-emptied
        categories, plus any genuinely stray channel. `/cleanup`'s pre-existing `meet-*`
        rule also lists leftover meeting rooms even when they sit inside the (protected)
        📋 Meetings category — those were checked by name before confirming.
        **Final-review fix wave (2026-09-29):** the preview shows every channel,
        grouped by category (or, past Discord's embed size limit, as per-category counts
        plus an attached `cleanup-preview.txt` with the full list) — the old preview cut
        off at 25 channels with "…and N more" while the confirm button still deleted all
        of them, so the `meet-*` rooms above could not actually be checked by name before.
        `/cleanup` also now fails closed if the `/create-channel` read errors, and never
        lists a category that was already empty before the trim (only ones this trim is
        actually emptying out).
   - **Deferred from the final review (not needed for the live trim, which renders at ~1900
     chars):**
     - `/cleanup`'s 3800-char switch to the attachment measures only the grouped lines, not
       the whole embed description, so a preview of ~207–210 channels errors instead of
       rendering (fails safe — nothing is deleted). Measure the full description, and set
       `pendingCleanups` only after the embed is built (today a stale earlier preview's
       button could act on the newer list after such an error).
     - The attachment path (`cleanup-preview.txt`) has no test.
4. **Repositories per project with a scope, and a GitHub issue for every task — DEPLOYED
   2026-09-30** (bot `f2be0ab` then `89d53bf`, CSAAS `c2c0829`, site `befffcf`; migration
   030 applied). Rule 2 was widened the same day for Badar HMS: the project's one
   untagged link takes every scope no tagged link claims (bot `8c59916`, site `a6ed57c`).
   **Left for the owner:** tag Edarete's 2 and Framework's 3 links with scopes (several
   untagged links give no automatic issue); `/repos add` the Badar HMS mobile repository
   with scope Mobile. CSAAS's deploy was not verified live (no migration to look for).
   `project_repos` gains a scope (migration 030); one rule
   (`resolveTaskRepo`/`taskRepo.js`) picks a task's repository by project + scope in
   `/create-task`, the site's create route and the meeting pipeline; issues now open for
   bugs and features alike, with a per-task opt-out, a token per repo owner
   (`GITHUB_TOKENS`), and failures always reported rather than swallowed; a task's issue
   now closes/reopens with its status (`syncIssueState`); `/repos add` and `/projects` →
   Link repo check GitHub access; a new Mobile scope; meeting-task issues now open from
   the bot itself (`issue_syncing`), not CSAAS's `issueSync`. Spec
   `docs/superpowers/specs/2026-09-30-repositories-per-scope-design.md`, knowledge
   `.claude/knowledge/repositories-and-issues.md`. Branch `feat/repo-scopes` in all three
   repos, not merged.
   - **Bot** (base `main` `744ea34`; `git log --oneline 744ea34..HEAD`): spec/plan docs;
     `8e4cae9` Mobile scope; `0a41a57` migration 030; `9ef6e8f` `taskRepo.js`'s one rule;
     `05c208e` `github.js` — a token per owner, `createIssue`'s reported errors,
     `checkRepoAccess`; `bb94d62` issues for bugs and features, site route passes the
     opt-out; `547f622`/`7513665` `/create-task` — bugs pick a project, the scope picks
     the repository, an Issue on/off toggle (plus the fix-wave rulings below);
     `a2b851b` `/projects` link-with-scope/unlink, `/repos add` scope, the access check;
     `53f0d73` `syncIssueState` closes/reopens the issue with the task's status;
     `f22177a` meeting repository by project and scope, GitHub on by default, the bot
     opens meeting issues via `issue_syncing`. Final fix pass: `576ea57` the issue
     outcome reaches the site's `note` and a failed issue is said in the channel;
     `094db6b` status sync finds the issue from its URL and says when its repository is
     unknown, `/close-feature`/`/resolve-bug` sync before archiving; `7fe062d` the meeting
     done summary counts opened issues and names skipped/failed apart; `2c36da1` no stray
     link on a scope race, clearer link texts, stricter access check; then the done
     summary is clamped to Discord's limit. Suite 1492 tests, `fail 0`.
   - **CSAAS** (worktree `D:\Work\Granjur Technologies\CSAAS_Backend`, branch
     `feat/repo-scopes` from `main` `09b2f61`): `aab5f8e` — Mobile scope in
     `normalizeMeetingTaskScope`/the task-generation prompt, `create_issue` forwarded on
     the create pass-through, `projectRepos` in the tasks payload. Jest file
     `meeting-test/meetingTaskScope.test.js` 8/8 pass; all 18 `discord-tasks-test/*.test.js`
     assert-scripts pass when run with `node` (they are not real jest tests — see the
     backlog's "assert-based scripts" item below).
   - **Site** (worktree `D:\Work\Granjur Technologies\UBS-Doc-repo-scopes`, branch
     `feat/repo-scopes` from `main` `4f6dc09`; `git log --oneline 42069c0..7505783`):
     `42069c0` Mobile scope, "Issue goes to …" line (`repoLogic.ts`), repositories shown
     read-only on project cards; `544176a` fix — the line's `(<Scope>)` shows only when
     the scope rule actually chose the repository; `b2b36d6` a bug the rule gives no
     repository picks one (required picker: the project's linked repositories, else all;
     refused only when there are none), the toast shows the bot's `note`; `7505783` the
     toast keeps a multi-line message on separate lines.
   - **Behaviour that changed during review, documented as built** (full detail in
     `.claude/knowledge/repositories-and-issues.md`): a bug in a guild with no
     repositories is refused at the very start ("No repositories. Add with **/repos**
     first."); bugs pick a project first (or "No project"); when the scope rule finds
     nothing, a bug picks from the project's linked repositories, else every server
     repository; the confirm step's "Repository" shows "(<Scope>)" only when the scope
     rule itself chose it (never for the only-untagged-repo fallback or a human's own
     pick); a feature or bug with no rule match but an explicitly picked repository
     still uses that repository and gets an issue (a controller ruling, not the rule's
     own output); `issue_syncing` (meetings) saves each opened issue to the job
     immediately so a retry can never reopen one; the site's create line adds
     "(<Scope>)" under the identical condition.
   - **Behaviour changed in the final fix pass (2026-09-30):** a site-created task's
     `note` carries the issue outcome (`Issue: <url>` / `Issue: not opened — <reason>` /
     `Issue: off`) and an issue failure is also posted in the task's channel; status sync
     finds the issue from `externalIssueUrl` (owner/repo/number), falling back to
     `repositoryId` + `externalIssueNumber`, and says "the issue's repository is unknown"
     when neither resolves; meeting issue sync writes `repositoryId` with the issue; the
     meeting done summary counts issues actually opened, names each task, lists
     "skipped — no repository" apart from failures and is clamped to Discord's limit;
     the site's create page has a required repository picker for a bug the rule gives no
     repository; `/close-feature` and `/resolve-bug` run the issue sync before archiving
     and show a failure in the reply; `/repos add` says when a scope was ignored; the
     access check reports disabled issues and read-only tokens; a refused link never
     leaves a stray untagged link.
   - **Rollout, in order (bot → CSAAS → tag links in Discord → site), each step needing
     the owner's go-ahead:**
     1. Push the bot's `main` — the deploy runs migration 030;
        `GITHUB_TOKENS=ubs-dev-org:<PAT>` is **already set** on the VM's bot `.env` (and
        locally) by the owner, so no env step is needed at this push.
     2. Push CSAAS `main` — a push auto-deploys; CSAAS runs its own migrations at
        startup, and this sub-project adds none, so nothing else to do here.
     3. Owner, in Discord, once the bot is live: `/projects` → Link repo to tag each
        existing link with its scope; `/repos add` the ubs-dev-org Badar HMS repositories
        with their scopes; `/projects` → Unlink repo the old `granjurtech/Badar_HMS_Node`.
     4. Push the site (Vercel builds on push) — last, so its repository picker already
        sees the tagged links.
   - **Deferred (not required for rollout):**
     - A possible false "No GitHub access" warning from the access check for a read-only
       token that can still open issues.
     - No "GitHub: all off" button in the meeting review — the first meetings may open
       many issues (the per-task switch starts on).
     - Duplicate-issue edge cases on overlapping `issue_syncing` retries.
     - `create_task_edit` is deferred by `index.js` but opens a modal (pre-existing).
     - The `/create-task` and `/projects` handlers are untested.
   - **A pre-existing, unrelated note surfaced while reading CSAAS's test layout:** the
     `discord-tasks-test/*.test.js` files use plain `assert`, not jest's `describe`/`test`
     — jest's `testMatch` still picks them up and counts each as one failing "suite" with
     zero tests, so `npm test`/`npx jest` alone does not show them green. They must be
     run individually with `node <file>.test.js` (as `completed.md` has done for every
     prior CSAAS build in this series). Not new to this build — see the pre-existing
     backlog item under "Time reporting follow-ups" ("The 7 assert-based scripts …").
5. **Clock in / out on the site** — **MERGED AND PUSHED 2026-09-30.** Spec
   `docs/superpowers/specs/2026-09-30-site-clock-in-out-design.md`, knowledge
   `.claude/knowledge/site-clock.md`. Merges: bot `b219a65` (commits `db00433` one clock
   service for `/clock-in`, `/clock-out` and the site; `3059e16` the four
   `/internal/clock/*` routes), CSAAS `59d84af` (`4923a51`, `be3f821`), site `03d8da3`
   (`bde1fd8`, `d9a8c2c`, `2e496ac`). No migration.
   - **Deploy evidence:** bot "Deploy to VM" run succeeded; site Vercel status success.
     CSAAS was pushed (it auto-deploys) but its deploy was NOT observed — with no
     migration there is no ledger row to check; the site's header reading "Clock
     unavailable" for everyone would mean CSAAS is still on the old build.
   - **Follow-ups shipped 2026-09-30 (site only, Vercel success):** `eaf5e12` — the
     header's link text is a button opening the link card, so an unlinked admin can enter
     a `/link` code; `d3a0491` — a clocked-in tag on board cards (own clock for everyone,
     other people's for `view_discord_time` holders). Showing teammates' tags to everyone
     would need a CSAAS change; not asked for.
   - **Not yet done:** a live pass in a browser (clock in on general work, switch to a
     task, clock out with a note, the Time tab card), and a Discord smoke test of
     `/clock-in`, a task switch and `/clock-out` on the new service.
   - **Deferred:**
     - A clock-in with no task uses the caller's first link only, so someone linked in two
       guilds can end up with a second clock running in another guild.
     - `clockedInNow` has no row cap override and does its task lookups one at a time.
     - The site UI was never exercised in a browser against a live backend.
     - The "Clocked in now" card on the Time tab does not refetch after a clock action
       from the header.
     - Nothing stops two open entries for one member: `clockIn` reads the active entry and
       then creates one, with no unique key. A `/clock-in` and a site clock-in at the same
       instant leave an orphan that runs until the 12 h cap (the race predates the site).
     - The site's task picker can list a task the bot then refuses (the bot needs project
       membership, holding the task, or leadership); the user gets the refusal sentence.
     - The bot's clock routes accept only an approved, non-client `guildmember`; Discord's
       `/clock-in` lets any non-client through. A pending member sees the bot's sentence
       in the header pill instead of a clock.
6. **JSON task import** on the site with a documented format — only into the user's
   projects. **MERGED AND PUSHED 2026-09-30** — bot `db92164`, CSAAS `35fdc47`, site
   `3bed224`, in that order (the bot first: a CSAAS that forwards `status` to an older bot
   would create a done task as an open one with a channel).
   Spec `docs/superpowers/specs/2026-09-30-json-task-import-design.md`, knowledge
   `.claude/knowledge/task-import.md`. No migration.
   - **Deploy evidence:** bot "Deploy to VM" run succeeded; site Vercel status success.
     CSAAS was pushed (it auto-deploys) but its deploy was NOT observed; the import screen
     answering `Import is not available yet.` would mean CSAAS or the bot is still old.
   - **Not yet done:** a live pass in a browser. Start with a small file: one open feature,
     one done bug, one task with mixed subtasks.
   - **Deferred:**
     - A done feature is stored with `implementationStatus: 'not_started'`.
     - An edit of a task that was already finished no longer creates a channel for it
       (reopening still does; a task closed in the same update that first assigns it still
       gets one, as before).
     - A 50-task import can fill a project's section (49 channels) and then the global Features/Bugs category (Discord's 50-per-category limit is not checked there); the create then fails after the row is written and the site shows it as unconfirmed — pre-existing, reachable in one import.
     - Each open or in-progress imported subtask with assignees sends a DM, unspaced.
     - The site UI was never exercised in a browser against a live backend.
     - The browser's Back button is not blocked during an import (the app's own navigation
       and closing the tab are).
     - A CSAAS 404 for an unknown project on the check shows `Import is not available yet.`
     - CSAAS's declared `fields` lists for Create/Subtask do not name the new keys
       (documentation only).
     - A file with many long descriptions must be split to fit 90 KB (CSAAS's body parser
       limit, deliberately left alone).
7. **Meeting docs/JSON → Claude → tasks** without a meeting, plus a document field when a
   meeting starts, plus meeting notes as files — **BUILT, NOT DEPLOYED (not merged either),
   2026-10-01.** Branch `feat/doc-tasks` in the bot and CSAAS. Spec
   `docs/superpowers/specs/2026-09-30-doc-tasks-and-meeting-notes-design.md`, plan
   `docs/superpowers/plans/2026-09-30-doc-tasks-and-meeting-notes.md`, knowledge
   `.claude/knowledge/doc-tasks.md`. No migration. `/tasks-from-doc` (Verified), a document
   at `/record start` (sent to CSAAS as `pre_meeting_notes`), and the `reporting` stage that
   finally makes the meeting notes and HTML report exist (posted as files).
   - **Rollout, in order (CSAAS → bot), each step needing the owner's go-ahead:**
     1. Merge, then push CSAAS `main` (auto-deploys; harmless alone, `/create` just accepts
        `pre_meeting_notes`).
     2. Merge, then push the bot's `main`: the deploy runs `npm install --production`
        (installs `unpdf` and `mammoth`), `npm run db:migrate` (nothing new) and restarts
        pm2; `loadCommands` re-registers the slash commands at startup when the list changed.
     3. Owner check: `node --version` on the VM must be >= 22 for PDFs (`unpdf`).
   - **Not yet done:** a live pass: `/tasks-from-doc` with a small .md and a PDF, a
     `/record start` with a document, and a finished meeting showing the notes and report files.
   - **Deferred:**
     - The VM's Node version must be >= 22 for PDF reading (`unpdf` declares it; on an older
       Node only PDFs fail, with a sentence). Unknown today.
     - `/record start` waits for the document read, up to 20 s, before recording starts.
     - `Using <file> as background` is shown even when the brief is later lost (the brief
       is not stored, so a CSAAS that cannot create the meeting at the start drops it).
     - A failed file read after the public defer is ephemeral now, but a role denial for
       `/tasks-from-doc` is public (as for `/explain`).
     - After `/meeting-review` re-posts a review, a document job's later notices follow the
       new channel.
     - Files posted in the meeting channel during a meeting are still not read.

## Site create/edit — rollout (branch `feat/site-task-edit` in all three repos, 2026-09-28)

- Deploy order bot → CSAAS → site. No new env values (BOT_INTERNAL_SECRET / DISCORD_BOT_SECRET + DISCORD_BOT_URL already cover the new routes).
- Bot first: `pm2 logs granjur-bot` shows the internal task routes enabled.
- CSAAS: the `Deploy to Azure` workflow has not run on `main` since 2026-09-12 — confirm how CSAAS is actually deployed before relying on a push.
- First live check: create a feature on the site, see its channel in the project's section; edit it and see one "(via the site) updated this task" post; add a subtask.
- The edit form and create page were never looked at in a browser during the build (no portal sign-in available) — do a visual pass in light and dark mode.
- Before a second Discord server is onboarded: the update and add-subtask routes (like the status route) find tasks by id with no guild scope, so an update_discord_tasks holder could edit another server's tasks.
- A site-created task's opening channel message @mentions the email-matched creator (like /create-task's invoker).
- Deferred minors from review: create page's ?project= preselect re-selects after the user clears the project select (guard with a ref); key TaskEditForm by task.id so back/forward while editing cannot show the previous task's form; memoize formFromTask in TaskEditForm; member picker has no arrow-key navigation; applyEdit's unblock loop ignores dep.error (unblock never errors today); guarded() 500 returns raw error text to CSAAS.

---

## Six-bit text allow — rollout and follow-ups (branch `feat/attach-files`, 2026-09-25)
See "Text permissions" in `.claude/knowledge/project-sections.md`.

- The M3 member-only `grant` on a ticket the cap left outside the section is worded
  "to open to the project role" in the preview and "opened to the project role" in the
  reply, though no role allow is written there — reword for member-only grants.
- `/setup`'s global ticket walk includes every category named Features/Bugs, not only the
  first one `getOrCreateCategory` would pick; a hand-made duplicate is walked too (effect:
  three extra allow bits for members who can already view).
- `grantClients` no longer adds Connect/Speak to an existing viewing `supportVoice` entry
  that lacks them (presence-only by design; no test either way).
- `/setup` runs the global ticket walk before its invalid-timezone early return.
- **Before deploy:** the bot's own role must hold Attach Files, Embed Links and Add
  Reactions (or Administrator). Discord refuses an overwrite carrying a bit the bot itself
  lacks, so without them every ticket/section/support channel creation and every repair
  edit fails with Missing Permissions.
- **Rollout:** merge, deploy, `/setup` once (support pair + the global Features/Bugs ticket
  channels, reply line "Ticket channels upgraded: N"), then `/project-setup` per project
  (preview first) or `all:true`. First live check: a client attaches a file in a request channel.
- Channels no repair path reaches keep three bits until recreated: `/create-channel` private
  rooms and meeting auto-channels (`meetingAutoChannel.js`).
- The category repair now MERGES a present `@everyone` entry instead of replacing it, so a
  hand-cleared `@everyone` deny on a section category is no longer restored by a run that
  edits the category for another reason (pinned by a test). Decide whether that is wanted.
- The voice-activity pass (`voiceGaps`) offers UseVAD/Stream to a role entry that only
  denies ViewChannel (pre-existing, not changed here; seen while testing the deny-only case).
- On a project support/casual channel a short client entry can be upgraded twice in one run
  (step 3's merged `grant` edit, then step 3b) when the cache has not caught up; step 3b now
  sends only the bits still missing, so with a live discord.js cache it skips.
- Overwrite edits that still carry no explicit `type` (all edit EXISTING entries, where
  discord.js infers it): `lockTicketChannel`/`unlockTicketChannel` (`utils/channels.js`), the
  voice-activity repair in `applyProjectSection` 4b, `commands/fix.js`.
- `repairOverwrites` upgrades a short `Verified` entry on the global support pair as well as
  `Client` (the design named Client; both are bot-owned allow entries).

## Archive divider — deferred follow-ups (branch `feat/archive-divider`, 2026-09-25)
See `.claude/knowledge/ticket-archive.md`. The items that outlived the status buckets, plus
what this branch added. Newest first.

- `dividerRoleNeedsRepair` heals a wrong deny set but never a missing ALLOW: a role
  overwrite on the divider with `allow: 0` and the full deny set reads as healthy, so a
  divider the project cannot see is never repaired. One-line extension: also require the
  `DIVIDER_ROLE_ALLOW` bits.
- The "orphan above the line stays above" half of the step-4d test in
  `projectSection.test.js` is vacuous: the orphan and the divider share `rawPosition: 20`
  and the id tie-break puts the orphan below. Give it `rawPosition: 19` so the
  `i <= lineIndex` branch is actually exercised.
- A topic-only repair of the divider is not reported in the run's result (it is neither a
  grant nor a rename), so a successful one is invisible in the reply.
- **Delete the three leftover bucket categories in the real guild by hand.** Nothing in
  the bot will ever do it: `/project-setup` reports each one once, in the run that empties
  it, and then drops the stored id and forgets it.
- A task assigned and marked done in the same edit gets an unlocked, unstamped archived
  channel: `applyTaskUpdate` runs the placement before `notify`, and it is
  `notifyTaskUpdate` that opens the channel for the new assignee — so the placement saw no
  channel to lock, and the channel that appears a moment later never enters the Done
  transition. It is created below the line (the creation step reads the new status), just
  writable and with no 14-day stamp, until the next status write.
- A ticket a human drags to the wrong side of the divider stays there until either its own
  status changes or `/project-setup` runs: the live placement reads which side each other
  ticket is on off the divider's position, never off the database.
- Two reorders racing (two status writes, or a status write during a `/project-setup`)
  both send the whole category list; the later one wins with no read-modify-write lock.
  Harmless while the order is derived from the divider each time, worth knowing.
- A voice channel can share a position number with a text channel: `applyOrder` is only
  ever handed the category's *text* channels, so voice ones keep whatever positions they
  had. Harmless while Discord sorts voice as a separate list below every text channel in a
  category — an assumption about Discord's rendering that no test here can prove. If it
  ever stops holding, `textChannelsOf` has to become "every child, text first".
- Discord's normalisation of U+2500 in the divider name `────archive────` is unverified
  (the name has no spaces, which would become hyphens). Costs nothing if it normalises:
  the observer looks the divider up by stored id first and only falls back to the exact
  name. First live check after deploy.
- Several "ten section channels" strings remain in `projectSection.js` (pre-existing
  inconsistency, not introduced here) — there are thirteen, plus the divider.
- The identical two-line comment explaining the placement call is duplicated in
  `close-feature.js` and `resolve-bug.js`.
- The hoisted guild lookup in `applyTaskUpdate` (`taskStatusChange.js`) now catches a
  `guildConfig` read failure separately so `notify` still runs with `guild: null`
  (brief-mandated behaviour change, not a defect).
- `taskUpdateNotify` uses `??` for the placement status and `||` for the embed's Status field —
  the same fallback as before this branch, just two different idioms for it.
- The meeting mirror's idempotent retry reuses an existing task row but passes `status: 'open'`
  literally (plan-mandated); a row whose status had drifted would be misplaced until the next
  `/project-setup`.
- `retireTicketChannel`/`reviveTicketChannel` wrap the lock/unlock call in a redundant outer
  try/catch — `lockTicketChannel`/`unlockTicketChannel` never throw for a single refused edit,
  they count it as `failed` instead.
- `db.task.findRetirable` treats `take: 0` as 100 (falsy check) — matches the brief verbatim,
  just worth knowing if a caller ever means "give me zero rows."

## Client role — deferred follow-ups (branch `feat/client-role`, 2026-09-24)
See `.claude/knowledge/client-role.md`. Ordered by how much they matter.

**Worth doing first**
- **Both gates fail OPEN when the member cannot be resolved.** `handleCommand` (pre-existing)
  and the new `handleAutocomplete` gate skip the check when `members.fetch` fails. Read
  `interaction.member` first — Discord populates it for guild interactions — so a fetch hiccup
  cannot let a client enumerate names. (Final re-review; Ruling 15.)
- **After deploy, run `/setup` once** so clients approved before the fix wave get the
  public-channel denies; nothing re-runs `denyClientOnPublicChannels` for existing clients
  (`#time-reports` alone self-heals on the bot's first tick after a restart).
- **`pendinginvite` rows never expire** — a `kind:'client'` row keeps letting that address through
  `/verify` after the 7-day Discord invite dies. Age them out. (Ruling 12.)

**Correctness, narrow**
- `/project-setup` does not repair a client manager's overwrites on existing request channels
  (only `/project-members add/remove` writes them). If one goes missing, remove and re-add the
  manager. A `planClientAccess`-style pass over request channels would close it.
- `project-setup.js` passes `rosterRows = []` as `members` when BOTH roster reads fail, so the
  pinned members panel is rewritten empty. `members: rosterReadFailure ? undefined : rosterRows`.
  (Ruling 14.)
- `denyClientOnPublicChannels` runs before the support-pair id persist in `ensureSupportChannels`;
  move it below so a throw there can never skip recording a newly created channel. (Ruling 16.)
- Denying each `📜 Rules` child desyncs it from its category; denying the category alone would do.
  (Ruling 17.)
- `set-roles` `handleApply` does not re-check `memberIsClient` between picker and apply — a
  two-operator race can add staff roles on top of `Client`.
- Converting client → staff with a failed prior roster read leaves the stale support overwrites
  (`project-members.js` add branch, non-client path) — harmless, they are staff now.

**Robustness / polish**
- `changeClientAccess` and `clientRequest.js` resolve support channels via `guild.channels.cache`
  only; a cold cache reads as "not set up" / falls back to `#admin` and skips lead DMs.
- `commands/index.js`: member fetch + `getGuildConfig` run sequentially per dispatch (and now per
  autocomplete keystroke); `getGuildConfig` failure is swallowed without a log line.
- `backlog.js` builds the `[Client, ...roles]` option array in three places — extract a helper.
- `CLIENT_TEXT_ALLOW_OBJ`/`CLIENT_VOICE_ALLOW_OBJ` are hand-duplicates of the bit arrays.
- Discord timestamp formatter duplicated in `clientRequestView.js` (`:d`) and
  `client-tracking.js` (`:D`).
- `verify.js` `getConfig(...).catch(() => ({}))` swallows into `{}` rather than `null`
  (pre-existing shape).

**Tests missing**
- No `setup.test.js` / `init.test.js`: the `ensureSupportChannels` wiring on both rollout entry
  points is untested.
- No execute-level tests for the `/approve`/`/backlog` `asClient` branching (the invariant is
  unit-tested in `approval.test.js`).
- `project-members.test.js` "the reverse undoes it" only exercises staff → client; no test for the
  `Clients:` render lines or `revokeClients=false` under truncation; no negative-path test for
  the requester-DM guard.

**Spec vs. code, recorded**
- Spec §5 asked the `Client` picker option to re-prompt; the build discards ticked staff roles and
  says so in the confirmation (Ruling 11). Spec §4 and §10 carry dated corrections.

## Project Stats — deferred follow-ups
From the 2026-09-23 build (implemented on branches, not merged — see `completed.md` and
`session.md`). See `.claude/knowledge/project-tasks-site.md` ("Stats tab and
project-filtered time").

**CSAAS**
- `discordTasks.js` emits `timeLogged`/`timeByPerson` with no `view_discord_time` gate —
  pre-existing exposure surfaced by spec §7; for the owner to decide.
- The overview request (no `project`) runs the unbounded `task`, `JSON_SEARCH` and
  `MAX(createdAt)` queries it never renders — gate on `project` or bound them before any
  large guild.
- `/api/discord/tasks` caps at 2000 tasks while stats reads all (they diverge past 2000).
- `soft()` failures on `taskactivity`/`clockentry` are invisible to the client — consider
  a `degraded` flag.
- `toMysqlUtc`/`resolveProject`/`projectClause` live in `discordTimeReport.js` — move
  beside `timeScope.js`.
- `status.test.js` prints "[discord-tasks] bot unreachable" noise.
- `stats.test.js` leaves `DB_TIMEZONE` set on the report module's hooks.

**Site**
- `bucketKeys` builds the key window from the browser's local calendar while server keys
  are DB-local — a viewer behind the DB zone loses the newest day; extend one bucket past
  `until` or clamp to the response's day range.
- TimeTab compares the entries' echoed `project` but not the report's.
- Zero-task projects get no overview card although §4.2 lists them — amend the spec or
  special-case.
- The KPI grid leaves an empty `xl` track when the estimate tile is hidden under self
  scope.
- The range toggle uses `role="tablist"` (should be radiogroup/aria-pressed).
- `StackedBars`' tooltip height is unbounded past ~10 members.
- Per-card `earliestDay` under All time makes overview sparklines span different windows.
- `assigneeOptions` in `tasksLogic.ts` is production-dead.
- `Bars.tsx` exports `Legend` beside `chartChrome.tsx`.
- Component tests for the shell's per-tab control gating, TimeTab's `personId` guard and
  Stats' stale-response gate, if the section ever gains a DOM test environment.

## Time reporting follow-ups — deferred follow-ups
From the 2026-09-22 build (merged and deployed, see `completed.md`). Each was confirmed real by a
reviewer and consciously deferred as Minor.

**Bot**
- **The bot is never granted `SendMessages` on the `#time-reports` channel it creates**
  (`services/dailyTimeReport.js`), though the spec says it should be. It works only because the
  bot is Administrator — an assumption `commands/bug.js` already ships on. If that ever changes,
  the daily report silently stops.
- **`guild.members.fetch({ user: ids })` caps at 100 ids** (Discord's `REQUEST_GUILD_MEMBERS`
  limit). At 15-17 approved members this is fine; past ~100 the request stops resolving and the
  pass blocks for the 120s timeout every tick before falling back to unhydrated names. Chunk the
  ids, or use the plain `guild.members.fetch()` the rest of the repo uses.
- No param-order test for `clockEntrySumByPersonRange` — swapping `since`/`until` would ship
  green, since the service's tests fake the whole method.
- `pad` is duplicated between `utils/timeTracking.js` and `services/dailyTimeReport.js`;
  `TICK_MS` is unexported (so the interval is untestable) while `clockWatch` exports its own;
  `startDailyTimeReport` itself has no test.
- No index matching the new aggregate's `(guildConfigId, clockInAt)` shape.
- No admin command sets `timeReportChannelId` — changing the channel means editing the row by
  hand. Same known gap as `clockReminderHours`/`clockCapHours`.
- The en-GB embed title renders "Time — Tuesday, 22 September 2026"; the spec's example had no
  comma.

**CSAAS**
- **`portalAuthz.js`'s `pickFrom` still reads `req.body`/`req.query`.** The new middleware fix
  sanitizes `decryptedPayload` only, so the invariant now depends on two files agreeing: the
  moment anyone routes `__identityVerified` through `pickFrom`, or reads `req.body.actor_email`
  directly, the forgery returns with no test to catch it. Deleting from `req.body`/`req.query`
  too — or dropping the fallback — would make the sanitization total rather than
  load-bearing-by-coincidence. **Worth doing with whoever owns the framework's auth layer.**
- An orphaned task would yield a non-null `taskId` with a null `taskTitle`, against the spec's
  contract; the site would render a titleless group. No task-delete path exists today.
- No test pins the entries API object's `bindActorToToken: true` / `accessToken: true`, although
  the endpoint's whole model rests on them. Low severity only because both now fail closed.
- **The 7 assert-based scripts in `discord-tasks-test/` sit inside jest's `testMatch`** and none
  defines a `test()`, so `npm test` counts each as a failing suite. Pre-existing pattern, but it
  means "the jest baseline is unchanged" cannot be verified by stashing once a new script is
  committed. Move them out of `testMatch` or wrap them.

**Site**
- `entriesByTask` groups general work under the magic string `'__general__'`; a real task id of
  that literal would merge into it (ids are 24-char hex, so unreachable).
- `Number(e.minutes) || 0` renders `0m` on screen while the CSV writes the raw value, so one bad
  row can read differently in the two places.
- `detail.entries` is dereferenced without an `Array.isArray` guard, unlike `TeamLayout`'s
  treatment of the same transport — a shape surprise white-screens the tab.
- The `truncated` notice says "narrow the range", but the range is fixed at one week and cannot
  be narrowed from that UI. Unreachable in practice (5000 entries in a week).
- `rangeLabel` and `csvFilename` each duplicate the "last day covered" arithmetic.
- The unselected select option reads "Select a person…"; the spec named "Everyone".

## Task time tracking — deferred follow-ups
From the 2026-09-22 build (merged and deployed, see `completed.md`). Each item below was
confirmed real by a reviewer and consciously deferred as Minor — none blocks the feature.

**Bot**
- **Task-picker autocomplete prefilters to the 200 most recently updated tasks guild-wide
  BEFORE applying the caller's access/typed filters**, so an older task a member has access to
  cannot be picked even by exact title. Shared by `/clock-in`, `/log-time` and `/time-report`
  (they all delegate to `clock-in.js`'s `autocomplete`). Hits `/log-time` hardest. Fix: filter
  before slicing, or raise the cap.
- **Two concurrent `/clock-in` calls can both pass `findActive`** and leave two open entries —
  no DB uniqueness guard. The older duplicate leaks and is eventually cap-closed by the watcher.
- **`/my-time` redraws at the default week range after every edit/delete**, so someone browsing
  "all time" is bounced back to this week; a refused leadership action bounces the viewer to
  their own panel.
- **A 0-minute entry cannot be re-saved unchanged** — its `0m` prefill fails `parseDuration`.
  Reachable for a sub-30-second timer. Delete still works.
- **A note-only edit rewrites `clockInAt = clockOutAt − minutes`**, drifting the stored start by
  up to ±30s (totals unaffected). Moving an entry's day without changing its duration writes no
  activity-log row.
- **`/time-report` wording/rounding:** 481-of-480 reads "100% — over" while 479-of-480 reads
  "100%" (percent rounds, flag compares raw — consider `Math.floor`); a task filter matching no
  rows in range reads "task unknown"; filter labels are not independently clipped.
- **`/log-time` refuses a pre-year-1000 date with "too large to store"** — right refusal, wrong
  wording. The overlap warning also ignores the caller's own *running* timer.
- **`clockWatch` swallows a failed guild-config read** (`.catch(() => null)`), which silently
  falls back to the 12h default *and* skips role removal, with no log line. Task-title lookup
  failures are swallowed the same way. Its in-flight guard is single-process only — two bot
  instances on one database would double-DM.
- **Command/service layering is inverted in three places:** `services/timePanel.js` imports from
  `commands/log-time.js`, `services/clockWatch.js` from `commands/clock-in.js`, and
  `commands/time-report.js` from `services/timePanel.js`. No import cycles; `resolveEntryWindow`,
  `entryWindow` and `closeEntry` belong under `utils/`.
- **`clockEntryFindOpen()` ignores its documented `guildConfigId` option** (takes no args at all).
  Harmless today — the watcher groups by guild itself.
- Missing tests: `findMany` clamp/filters, `sumByTask`/`findByMember` SQL, `overlaps()`
  containment, `midnightOf` for a zone that skips local midnight, two guild caps in one watcher
  pass, and spec §12's cross-path `minutes === entryMinutes(...)` invariant as a named test.
- **No command configures `clockReminderHours`/`clockCapHours`** — database-only settings
  (defaults 6 and 12), though the spec called them "configurable per guild".

**CSAAS**
- **`resolveScope` does not require `__identityVerified` before granting `scope: 'all'`.** It
  inherits a **pre-existing** trust gap in `portalAuthz.js` (`actionPerformerURDD` read from
  `dp ?? req.body ?? req.query`, with `bindActorToToken` only closing it when the caller owns an
  active URDD) that is shared by every portal endpoint — not introduced by this feature, but this
  feature newly routes the team's hours through it. One-line hardening available:
  `if (!email) return "self"`. **Worth raising with whoever owns the framework's auth layer.**
- **The `view_discord_time` permission does not actually contain the data it appears to gate** —
  `discordTasks.js` runs with `permission: null` and now ships per-person `timeByPerson` on every
  task, so any signed-in portal user can reconstruct most of the team's hours by summing it.
  Spec §11 explicitly sanctions this, so it is conformant, not a defect — but know it.
- **"This week" disagrees across repos for non-UTC guilds:** the endpoint uses UTC-Monday, while
  the bot's `/time-report` uses each guild's configured timezone. Product decision: give the
  endpoint the guild timezone (needs a `guildconfig` read), or label the tab "week (UTC)".
- **Project names come from the denormalised `task.projectName` snapshot**, so a renamed project
  shows its old name on the Time tab and its current name on the Tasks tab. One more
  `LEFT JOIN granjur.project` fixes it. Deleted-task time buckets as "No project" rather than
  spec §4's "Deleted task".
- Smaller: `since > until` returns empty instead of 400; `loadMemberInfo` reads the whole roster
  even in self scope and degrades all-or-nothing (unlike `discordTasks.js`'s per-column
  fallback); the email lookup omits `TRIM` and is not guild-scoped; the NULL-`discordId` case
  relies on implicit SQL three-valued logic with nothing stating it.

**Site**
- **`TaskDetail`'s Time field is effectively unconditional** now that CSAAS sends `timeLogged: 0`
  on every task, so every task page shows "0m logged" — while the list/board/preview chips
  deliberately hide at zero. Defensible (the page already mixes always-render and hide-when-empty
  fields) but worth a deliberate decision:
  `(task.timeLogged ?? 0) > 0 || (task.estimateMinutes ?? 0) > 0` matches the neighbours.
- **`TaskTime` (`tasksLogic.ts`) and `TimeReportPerson` (`api.ts`) are structurally identical**
  duplicate interfaces feeding the same `<Avatar>`. Two places to change if the shape moves.
- The week picker has no upper bound (you can page into empty future weeks forever) and its range
  label omits the year, so a Dec–Jan week reads "Dec 28 – Jan 3".
- On a fetch error with no cached data, the error banner is followed by two "Nothing here for
  this range" cards (the empty-state branch requires `!error`).

## Per-project sections — follow-ups
From the 2026-09-18 build on branch `feat/project-sections` (built and reviewed,
**not yet merged** — see `session.md`). See `.claude/knowledge/project-sections.md`.

- **`projectMemberFindByProject` has a hard `LIMIT 200`.** A project with more than
  200 members gets a partial pinned members panel (and `/project-setup` already
  guards the revoke pass — see "grantOnly" in the knowledge file — so it cannot
  strip anyone; only the panel display is affected). Raising the DB limit was
  deliberately deferred rather than done under this feature's pressure.
- **`projectFindFirst` is not guild-scoped.** Pre-existing, surfaced again during
  Task 7's review; nothing in this feature relies on it being unscoped, but it is
  a latent cross-guild leak if two guilds ever share a project id space.
- **The meeting pipeline writes a channel's id to the database AFTER the opening
  send** (`meetingPipelineStages.js`). A failed send orphans the channel — it
  exists in Discord but nothing in the database points at it. Pre-existing,
  outside this branch's scope; the branch made it reachable for ordinary project
  meetings too.
- **Dead, unregistered files `bot/src/commands/feature.js` and `bug.js`.** Neither
  is imported anywhere under `bot/src`, and neither is in the registration list in
  `commands/index.js`. Confirmed unreachable during Task 7's review. Delete them.
- **The `@everyone` overwrite in `/meeting-channel`'s global (non-project) voice
  path has no explicit `OverwriteType`.** Kept byte-for-byte from the pre-existing
  code on purpose (discord.js infers the type correctly today); add the explicit
  type opportunistically.
- **Name-fallback adoption may still move an unrelated channel.** The observer's
  by-id guards (`claimedSectionIds`, the `!c.topic` check, the ticket-topic/
  reference-count check for tasks) close every case found during the build, but a
  channel whose topic was hand-wiped AND whose name exactly matches a section or
  ticket channel name could still be misadopted. Only reachable by a deliberate
  hand edit.
- **The created/renamed/moved/granted/opened result buckets don't cross-report.**
  A channel that is both renamed AND moved in the same run only appears in
  `moved` (`applyProjectSection`'s `(entry.action === 'move' ? result.moved :
  result.renamed).push(...)` picks one bucket); a channel that gets the role
  allow as part of a rename/move is counted in `opened`, separately from
  `granted`, which is correct but means the same channel can appear in two of the
  five lists and nothing dedupes them for a human reading the reply.
- **`missingOverwrites` and `mergedOverwrites` guard on different cache methods**
  (`cache?.has` vs `cache?.values`). Both exist on a real discord.js `Collection`
  today, so they agree; a future cache-like object exposing only one of the two
  would make them disagree about whether the cache is "readable." Low risk, easy
  fix if it ever bites: standardize on one guard.
- **`/cleanup`'s `handleConfirm` deletes the ids `execute` stored, with no
  re-check at confirm time.** The window between listing and clicking confirm is
  unchanged from before the final wave's by-id fix — a section built during that
  window would still be offered for deletion. `execute` itself now protects by id
  (final-wave B1); the confirm handler was out of scope for that fix.
- **A task moved between projects keeps its old channel and its old project's
  role allow.** `/update-task` (final-wave B12) now says in its reply that the
  channel did not move with it, but nothing re-parents the channel or strips the
  old project role's overwrite — that only happens the next time `/project-setup`
  runs for either project. Nothing forces anyone to read the reply or re-run it.
- **Archiving a finished project.** Explicitly out of scope for this feature
  (spec §3); no flow exists to retire a project's category/role/channels.
- **The 12 orphan channels in the global `📋 Meetings` category.** Nothing records
  which project (if any) they were originally for, so this feature cannot move
  them; also explicitly out of scope in the spec.
- **Presence-only overwrite repair is deliberate, not a gap** (recorded here so it
  is not "rediscovered" as a bug): the category `@everyone`-deny repair and the
  section/task-channel role-allow repair both check whether an overwrite id is
  *present*, never whether its allow/deny bits still match what the bot would
  send. An admin who hand-edits an overwrite (e.g. removes the `@everyone` deny to
  make a section public on purpose) has that edit respected forever, not fought
  on the next run.
- **A preview can promise role grants while role *creation* keeps failing** —
  cosmetic only; the real run's reply already separately says "Role — not
  created."
- **Test fakes are duplicated across `projectSection.test.js`,
  `project-setup.test.js`, `project-members.test.js`, `meeting-channel.test.js`,
  etc.** rather than shared from one fixture module.
- **`describeRoleCandidate` walks every guild channel per project** (cache reads
  only, no API calls) to find where a same-named role holds an overwrite —
  O(projects × channels), roughly 95 × 9 on the real server today. Fine at this
  volume; would need a rethink at a much larger guild.
- `bot/src/commands/cleanup.js:180-186`: the `userChannel` read still catches to an
  empty set, so a failed read silently shrinks the protected set. Same defect
  shape as the project read that was fixed in the final wave, one table over.
- `/cleanup`'s `handleConfirm` deletes the stored pending ids with no re-check, so
  a channel that became protected between the preview and the confirm is still
  deleted.
- `meetingPipelineStages.js:333` re-reads the meeting that `resolveMeetingChannel`
  already read 43 lines earlier; thread `projectId` out of it instead.
- `create-project-role.js:27`: `loose()` folds case and combining marks but not the
  rest of `utf8mb4_general_ci` (`ß`→`s`, `Æ`→`ae`), so two projects differing only
  that way are still resolved arbitrarily by the `findByName` fallback.
- When `/project-setup` adds the `@everyone` deny to a category the bot ADOPTED
  rather than created, the only operator-facing statement is a planner warning
  inside that project's block, which `capReply` can drop from a large `all:true`
  run. The console mirror still logs it. This is the one place the bot changes
  permissions on something it did not create.

## Team section — follow-ups
From the 2026-09-18 build (built and reviewed on branches, not yet merged/deployed — see
`session.md`). See `.claude/knowledge/project-tasks-site.md` ("Team section and the write
path") for the write-path shape these items sit inside.

- **Loopback bind for the bot's HTTP server.** `bot/src/server.js` binds all interfaces;
  the Azure NSG blocking port 4070 from outside is the only thing keeping it private
  today. A `BOT_HTTP_HOST` env (default `127.0.0.1`) would tighten this properly, but was
  deferred because it would also change reachability for `/verify` and any other on-VM
  caller currently using the public IP — needs a look at who else calls in before
  narrowing the bind.
- **`portalAuthz`'s `pickFrom` falls back to `req.body` for a null
  `actionPerformerURDD`.** Pre-existing in CSAAS, surfaced again during the Task 5
  review of `DiscordTasksStatus_object`; not touched by this build.
- **People page search placeholder wording.** The search box filters People by name but
  the placeholder text wasn't reworded for the new page (carried over from the Tasks
  search copy) — flagged as a possible Task 10 cleanup and left as-is.
- **No keyboard path for moving a board card.** The board's drag-and-drop is native
  HTML5 DnD only; there's no keyboard-accessible way to change a card's column.
- **Dependency graph layout recomputes on every keystroke.** `graphLayout`'s
  `layoutGraph` re-runs on each filter-bar keystroke rather than being debounced or
  memoized — harmless at current data volumes, reviewed and accepted as-is.
- **`storedRoles` in the member name sync duplicates `ensureStringArray` from
  `helpers.js`.** Same normalization logic written twice instead of reused.
- **The `'notified'` default literal is duplicated** between `update-task.js` and
  `taskStatusChange.js` rather than defined once and imported.
- **No body size cap on the bot's HTTP server.** `bot/src/server.js` reads the whole
  request body into memory before handing it to `handleStatusRequest`; the route caps
  `taskId` at 64 characters but only *after* the body has been buffered, so a large POST
  to port 4070 is absorbed in full. Harmless while the NSG keeps the port private (see
  the loopback-bind item above), but the cap belongs on the reader, not the handler.
- **`TeamLayout.refresh` has no request sequencing.** Two refreshes in flight at once
  (a drag that succeeds while a filter change is still loading, or the new refetch the
  Board now fires after a *failed* drop) resolve in whatever order the network gives
  them, so an older response can overwrite a newer one. Needs a request id or an
  AbortController, the same way the Tasks page's other fetches would if they raced.
- **CSAAS `members`/task TEXT payload is uncapped within the endpoint's `LIMIT 2000`
  row cap.** A very large `description`/`scope` field could bloat one response; no
  per-field length cap exists.
- **`task.type` is rendered raw on the Task Detail page.** No label mapping — whatever
  string is stored (`feature`, `bug`, etc.) is shown verbatim.

---

## Project tasks site — follow-ups
From the 2026-09-17 build. See `.claude/knowledge/project-tasks-site.md`.

- **Stray production `guildconfig` row awaiting a decision.** Id
  `b23782a7c09e433bab78d866b`, `guildId = 'guild1'`, inserted 2026-09-17T10:48:49Z by a
  test run that reached the real database (see `.claude/rules/tests-never-touch-production.md`
  for how). Confirmed read-only: no row in any `guildConfigId`-keyed table references
  it, the bot's guild loops use `client.guilds.cache` so it is inert, and the CSAAS
  endpoint reads it and finds nothing to show. Not deleted — needs the owner's
  go-ahead. If approved, the statement is:
  `DELETE FROM guildconfig WHERE id = 'b23782a7c09e433bab78d866b' AND guildId = 'guild1';`
- **The endpoint's `LIMIT 2000` on `task` silently drops older blockers.** A task whose
  blocker falls outside the newest 2000 tasks reads as `isBlocked: false` with no
  indication anything was truncated. Fine at current volume; will misreport quietly as
  the table grows.
- **Project-registry slug mismatch between the site and the bot.** The site's own
  project registry (used by `/tools/projects`) and the bot's `project.docsSlug` agree
  only for `badar-hms`; every other project's deep link from Projects to Tasks lands on
  a "no tasks match" notice rather than a real filtered view. The Tasks page now says so
  instead of showing a silent empty page (UBS-Doc `6529af1`), but the underlying slug
  mismatch is still there and worth reconciling properly.
- **Dashboard has no blocked marker.** `/dashboard` and `/fetch-my` don't show that a
  task is blocked — that only surfaces in `/update-task` replies, the notifier's
  channel posts, and the site. Deliberately left out of the 2026-09-17 build.
- **`/close-feature` and `/resolve-bug` bypass the notifier.** Both change `task.status`
  directly instead of going through `notifyTaskUpdate`, so neither one ever posts a
  blocker warning or an unblock notice — a task closed through either command can
  silently unblock its dependents with nothing posted anywhere.
- **No site link from a task back to its project's documentation.** The Tasks screen
  and the docs browser (`/docs`, `/tools/projects`) are two separate views of the same
  `project` row with no cross-link between a task and the docs for the project it
  belongs to.
- **Deferred minors from the 2026-09-17 build's reviews**, each small enough to pick up
  opportunistically rather than as its own task:
  - `handleAssigneesSelect` (`bot/src/commands/create-task.js` ~645) keeps a dead
    `'none'` filter left over from the string-select era.
  - No test covers the user-select route for `create_task_assignees` in
    `bot/src/handlers/interactions.js`.
  - CSAAS `assembleTasks`: `'No project'` inferred member names are resolved against
    `orphans[0]`'s guild only — wrong in a multi-guild deployment.
  - CSAAS `assembleTasks`: a null `updatedAt` sorts first, and one invalid `Date` value
    throws and 500s the whole response rather than failing just that task.
  - CSAAS `assembleTasks`: two same-named projects from different guilds are
    indistinguishable in the response (no guild field).
  - CSAAS `getDiscordTasks` itself is untested despite having the `__hooks` seam — no
    assertion on username fallback, timestamp formatting, `docsSlug`, `pending`
    members, or array/`Date` shaped inputs.
  - Bot `memberNameSync.js`: `syncGuildMemberNames` has no try/catch of its own; it is
    only safe today because `syncAll` wraps it.
  - `/update-task`: naming an already-assigned member as the only `add_assignee` value
    gets the generic "Provide at least one field" reply instead of a clearer message.
  - Site `Tasks.tsx`: the `?project=` URL param is read only at mount, so browser
    back/forward between two `?project=` entries doesn't resync the filter without a
    full reload.
  - `/project-members list` is not capped at Discord's 2000-character message limit. A
    large project would make `editReply` throw and show a raw Discord error. The final
    review called this the deferred item most likely to bite.
  - `admin-panel.js:216` and `approve.js:32` read `guildMember.findMany` without
    `all: true`, so they stop at 25 rows. The name sync now creates a row for every
    server member, so this old cap is now reachable and those views truncate silently.
  - `/update-task` autocomplete for `unblock` makes five database round trips when the
    task is known; the 200-row `findMany` is fetched and then discarded. Skip it in that
    case.
  - `/update-task` writes the dependency row before `task.update`; if the update throws,
    the row stays and the reply says "Update failed".
  - `projectMemberUpsertSql` uses `VALUES(role)` in `ON DUPLICATE KEY UPDATE`, deprecated
    since MySQL 8.0.20 (warning only).
  - CSAAS `iso()` can return `null` for a timestamp while the site types it as `string`;
    unused on the site today.
  - Site `mwGet` throws the raw response body, so a CSAAS error shows as a JSON blob
    under "Could not load tasks".
  - Site project filter hides projects whose `docsSlug` is null.
  - Spec §7 says the confirm step gains an Assignees row; the code adds it for feature
    tasks only, since bug tasks use tagged members. Worth one clarifying line in the spec.

---

## Command visibility and access — follow-ups
From the 2026-09-16 session, after unhiding ten commands.

- **No member has an email stored.** All 11 `guildmember` rows have `email` empty,
  because the DM verification path (`handleGetCode`) saves `email: ''` and never asks
  for one. Only `handleEmailModal` stores an address and nobody uses it. Anything that
  matches a person by email cannot work: looking someone up for a role grant, the
  meeting roster, and the per-speaker recording filenames all fall back to Discord
  display names. Decide whether the DM path should collect an email, or drop email as
  an identifier.
- **`/scrap`, `/migrate` and `/reconcile` have never been run.** They were hidden by the
  permission bug until now, and they are the destructive ones. `{ ...interaction }` is
  gone from the codebase so they do not share the bug that broke `/invite` and
  `/verify`, but that only rules out one defect class — nothing else about them has
  been exercised. Read them before running on live data.
- **The repo's root `.env` points at the production database.** A test that reaches the
  default `db` export queries the live server; this has now bitten twice (Task 8 of the
  transcription plan, and `verify.test.js`). `handleOtpModal` and `guildIdFor` take a
  `db` seam for this reason. A separate test database would remove the hazard entirely.

---

## Live meeting transcription — follow-ups
Found during the 2026-09-07 build and its reviews. See
`.claude/knowledge/live-meeting-transcription.md`.

- **`/record` should pass `forceNewMeeting: true`.** `ensureMeetingChannel` returns the
  same `meetingId` forever for a persistent voice channel, so re-recording the same room
  reuses it. `clearStaleLiveSession` now wipes the previous session's utterance rows to
  stop them being half-overwritten, which means a previous recording whose pipeline job
  had not run yet loses its live transcript and falls back. The root fix touches
  `/playback` grouping and the recordings directory, so it was left out of scope.
- **`/meeting-retry` cannot re-arm the live path** — it resets status and attempts but
  leaves `dataJson`, so `liveTranscriptFailed` survives forever. A meeting that hit a
  transient Claude outage is stuck on the whole-file fallback permanently.
- **Extract `endMeetingSession` into a module-level factory.** Two tests currently assert
  against the *source text* of `voiceCapture.js` because those closures need a live voice
  socket and the repo has no module mocking. A `createSessionEnder({...})` factory would
  make the re-entrancy guard a two-line behavioural test and let both source-text tests go.
- **Consent notice needs a channel.** If `resolveMeetingChannel` returns null, nothing is
  posted and nothing warns loudly — the remaining hole in the consent surface.
- **`transcriptFeed`'s queue is unbounded** and `degraded` trips on failures, not on
  slowness. A backend answering every call in 29 s grows the queue all meeting, each entry
  holding up to ~240 KB of Opus, and makes teardown take `queueLength/3 x 30 s`.
- **`transcribeAudio.js` builds `new OpenAI()` at module load**, so the CSAAS utterance
  test needs `OPENAI_API_KEY` even under `STT_PROVIDER=soniox`. A CI blocker, not a merge
  blocker.
- **`bot/src/Database/schema.sql` was not updated** with `meetingutterance` or
  `meeting.csaasMeetingId`; migration 016 covers a fresh install but the schema dump is
  now an incomplete picture.
- Smaller: `total_duration_sec` is sent to `analyze-live` and never read; `dataJson.analysis`
  holds a different shape on the live vs fallback path; the empty-channel log says
  "5-minute grace period" while the constant and the new pinned guidelines both say 2.

---

## /explain — follow-ups
- **Drop `MultiEdit` from `EXTRA_ARGS`** — CLI 2.1.186 warns `deny rule "MultiEdit" matches no
  known tool` on every explain run (harmless, noisy). `explainAgent.js`, spec §4, tests.
- **`CLAUDE_CLI_ARGS_JSON` is an escape hatch** — an operator template containing
  `--dangerously-skip-permissions` would re-open the read jail regardless of
  `skipPermissions:false`. Either strip that flag from the template for explain calls or
  document it as forbidden. Final-review out-of-scope note, 2026-09-05.
- **`spawnSync` blocks the CSAAS event loop** for the whole CLI run (30–90 s). The 110 s
  per-call timeout and the one-in-flight guard bound it; the durable fix is an async spawn.
  Pre-existing for meeting analysis too.
- **`/home/azureuser/.claude/.credentials.json` is root-owned** (root's pm2 refreshes the
  token) — azureuser's own `claude` reports "Not logged in". The endpoint is unaffected.
  Fix: run CSAAS as azureuser, or `chown` after each refresh. Observed 2026-09-05.

**Code as a second source** once the fresh Badar HMS clone is on the VM (`--add-dir` 
or a second `cwd` root; renderer needs a `file:line` form).

**Threads / follow-up mode** (CLI `--resume` per Discord thread, idle timeout).

**Multiple `docsPaths` per project** (only the first is used).


---

## Meeting → tasks integration — remaining gaps
Ran end to end and shipped to production (see `completed.md` 2026-09-04). What is
still unexercised or wrong:
- **Assignment has never been exercised live.** The one live run mirrored an
  unassigned task, so the new per-task ticket channel, the assignee DM and the
  `assigneeIds` write have unit tests but no live run behind them. Next recording
  should assign a task in `/meeting-review` before approving.
- **The GitHub `[Agent Call]` push is untested live** — `issue_syncing` has only run
  with zero github-flagged tasks. It also needs a working `GITHUB_TOKEN` (see below).
- **Project linkage is broken.** CSAAS reports the project as `Badar_HMS`; the
  repository row is named `Badar_HMS_Node`, so `mirroredStage`'s exact-name
  `repository.findFirst` misses and every mirrored task lands with `projectId` and
  `repositoryId` null. Needs fuzzier matching (or a stored alias). Until then
  `issue_syncing` cannot resolve a repo slug either.
- **No project-wise task view.** `/dashboard` groups by module. Nothing lists tasks
  per project, which is what a manager asks for after a meeting.
- **Review lands in the voice channel's own chat** for a `/record` meeting, because
  `meetingchannel.textChannelId` is null unless a dedicated meeting channel was set
  up. Consider falling back to the guild's meeting/summary channel.
- **Seven other `LIMIT ?` sites in `bot/src/Database/index.js`** (lines ~490, 493, 964,
  1027, 1030, 1663, 1716) have the same prepared-statement failure that broke the first
  pipeline tick (`Incorrect arguments to mysqld_stmt_execute`). Pre-existing, outside the
  meeting work; any command that reaches them with a bound LIMIT will error.
- **`/meeting-review latest` unsupported** — no `db.meetingPipelineJob.findLatest`;
  the command needs an explicit meetingId.
- **`stopMeetingRecording` in `voiceCapture.js` is dead code (no callers)** — the
  pipeline enqueue actually fires from `endMeetingSession` (empty-channel grace timer
  + max-duration timer, the real meeting-end paths). Delete it or wire it in.
- **Stale-`working` reaper threshold == `MEETING_STAGE_TIMEOUT_MS`** with no margin
  (`bot/src/Database/index.js` `claim`/`claimBatch`). Fine single-process; give it a
  2x multiplier before running multiple worker processes.
- **Migration `015` leaves a redundant plain `idx_task_externalId`** on fresh installs
  (`014` adds the plain key, `015` no-ops because the unique key from `schema.sql` is
  already present). Harmless; tidy `014` to skip when a unique key exists.

## Live Discord acceptance for the project-docs branch
Task 10 of `docs/superpowers/plans/2026-09-03-project-docs-preview.md` — click through
`/docs`, `/projects`, `/edit-docs` and the `#documentation` channel on branch
`feat/project-docs`. Everything else about that branch is verified automatically; this is the
only unverified part. Procedure is in `session.md`.
## `Task` vs `task` — the table-case bug reached beyond the pipeline
`taskCreate`/`taskUpdate` wrote `` `Task` ``, which MySQL on Linux treats as a
different table. Fixed in `099179d`, but it means task writes had **never** worked on
this server — `/create-task`, `/bug` and `/feature` share those functions. Worth a
sweep for other capitalised table identifiers in `bot/src/Database/index.js`.

## Four commands still read a table with zero rows
`/create-task`, `/feature`, `/project-db` and `/create-project-categories` all read
`db.projectSchema`, i.e. the `projectschema` table, which has **0 rows** in production. The
table holding data is `project_schemas`, an unrelated dump-versioning table with a different
shape. Their project pickers are therefore empty. `/edit-docs` and the `#documentation`
channel had the same bug and were repointed at `docpage` on `feat/project-docs`; these four
were out of that plan's scope. See [[project-docs]].

## Replace the dead `GITHUB_TOKEN`
The token in `.env` returns `401 Bad credentials`. The docs sync detects this, warns once and
continues unauthenticated against the public repository, so documentation still works — but
`/bug` issue creation and any other authenticated GitHub call are broken, and the sync runs on
the 60/hr unauthenticated budget instead of 5000/hr.

## Deferred findings from the project-docs final review
None blocks use; the reviewer triaged each as "can wait".

- **`docsPaths` overlap between projects is unchecked**, and ties resolve by SELECT order, so
  with overlapping prefixes a page can flip owners between syncs. Needs a precedence rule
  (longest prefix wins? first created?) — a product decision. Only one project has
  `docsPaths` today.
- **`/scrap` destroys Discord-authored documentation.** It deletes `guildconfig`, which
  cascades `docpage`. `source='local'` pages exist nowhere else, and the confirmation does not
  mention it.
- **A permanently unfetchable file freezes the delete pass.** One file that 404s forever means
  the head SHA is never recorded, so upstream *deletions* stop propagating until it is fixed.
  Fails toward stale content rather than data loss. A retry counter would bound it.
- **`/edit-docs` says "Updated" on a raced no-op** — `affectedRows` is not inspected.
- **`docId` is not unique-keyed**, so a `foo.md`/`foo.mdx` pair could make the read-and-refuse
  guard inspect the wrong row. No clobber results; the message could mis-fire.
- **`projects.js` swallows a re-attribution failure** into "No synced pages match those paths
  yet", so a database error reads as a normal empty result.
- **`/setup`'s Sync button can outlive Discord's interaction token** on a cold sync, leaving
  the user on "Syncing documentation…". Now that the button forces a full pass, a cold sync is
  reachable again.
- **`rootOptions` truncates at 25 with no paging** — past 25 projects plus sections, entries
  become unreachable.
- **`docs_browse:sec:<section>` customId** would exceed Discord's 100-character cap for a
  section name over ~84 characters.
- **`docPageSearch`'s LIKE fallback does not escape `%` or `_`**, so a search containing `%`
  behaves as a wildcard. The term is bound; there is no injection.
- Minor: no index on `docpage.docId`; `DOCS_SYNC_INTERVAL_MS` is unvalidated (a non-numeric
  value yields a 1 ms interval); migration 012 seeds `docsSlug` with a SQL expression that is
  not `slugify()`; `proj:` and `sec:` scopes nest at different depths; two concurrent
  `/projects` link flows share one flow-store key; `projects` has no `dedicatedChannels` entry.

## Phase 2: write documentation back to UBS-Doc
Deliberately out of scope for Phase 1 and shaped to be additive — the `source` column already
distinguishes local pages, so Phase 2 is "commit the `'local'` rows as a PR per doc, flip them
to `'repo'` on merge". Needs a GitHub PAT with Contents: write and Pull requests: write on
`Aashir-Adnan/UBS-Doc`. A page's site link stays dead until the merge triggers a Vercel build.

## `/meetings` — manager filter is name-based
`isManager()` matches role names `CEO` / `Server Manager` (plus owner / ManageGuild).
If those role names ever change, managers silently lose the all-meetings view. Consider
reusing `guildConfig` role-id lists instead.

## Mixed meeting playback track
`/playback` still plays one speaker's file at a time. No step mixes the per-speaker
`.ogg` files into a single meeting track. Would need ffmpeg `amix` / `amerge`.

## `/schedule` — still open
- Per-user timezone override (deliberately skipped — per-guild only for now).
- Voice-channel picker step (currently `voiceChannelId` is always null).

---

## Dead vendored `bot/src/Database/*` files — remove or repair
15 files under `bot/src/Database/` fail to import (missing `../../SysFunctions/*`,
extension-less relative imports, and a duplicate `getColumnNameFromMapper` declaration
in `executeQueryWithPagination.js` that is a hard SyntaxError). Nothing on the live
path imports them — the real DB layer is only `connection.js`, `helpers.js`,
`index.js`. Decide: delete, or fix if the abstraction is wanted.

# Create and edit tasks from the UBS-Doc site — design

**Date:** 2026-09-28
**Repos:** Granjur-Discord-Bot (bot), CSAAS_Backend (CSAAS), UBS-Doc (site)
**Status:** approved in conversation 2026-09-28; this document is the written spec.

## Goal

A signed-in UBS-Doc user can create a task and edit a task from the site. Owner's words:
"we need the user to give option to create-task, update task on the ubs-doc too … on
update anything which can be updated from discord should be editable from there".

## Decisions taken with the owner

| Question | Answer |
|---|---|
| Who may create/edit on the site | Anyone holding `update_discord_tasks` (Dev, Admin, Platform Admin), any task — the rule the board drag already uses. No per-task ownership check. |
| What can be created | Feature and Bug, exactly the two types `/create-task` offers. |
| Where editing lives | An **Edit** button on the task detail page turns it into a form. A **New task** button on the Tasks list (and on each project card) opens a create page. |

## Scope

**Editable from the site** — everything `/update-task` and its task hub can change:

| Field | Values / rule (bot is the authority) |
|---|---|
| `status` | one of `TASK_STATUSES` (`open`, `pending`, `in_progress`, `resolved`, `closed`, `done`); `assertCanFinish` refuses finishing a task with an open subtask |
| `title` | trimmed, 1–200 chars |
| `description` | trimmed, ≤2000 chars; empty → `null` |
| `scope` | one of `SCOPE_VALUES` (`backend`, `frontend`, `qa`, `design`) or `null` |
| `implementationStatus` | `not_started`, `in_progress`, `done` |
| `projectId` | an existing project in the task's guild, or `null` (no project); `projectName` follows. The reply carries `projectMoveNote` as a warning (the channel does not move) |
| holders | the full id list. Written to `assigneeIds` for a feature/task, `taggedMemberIds` for a bug (`holdersOf`). Every id must be a `guildmember` of the task's guild |
| `passedApiTests`, `passedQaTests`, `passedAcceptanceCriteria` | integer 0–127 (`MAX_TEST_COUNT`, signed TINYINT). Cannot be cleared to "not tracked" — Discord cannot either |
| estimate | a duration string parsed by the bot's `parseDuration` (`8h 30m`); empty → `estimateMinutes = null`; must be a safe integer ≤ `MAX_STORABLE_MINUTES` |
| blockers | the full list of blocking task ids; the bot diffs it against `taskdependency` into adds and removes |
| subtasks | add (title, optional assignees) and tick done/open — separate immediate actions, see below |

**Out of scope** (Discord's `/update-task` cannot do these either): priority and due date
(no such columns), repository after creation, re-parenting a task, the closing document
that `/close-feature` / `/resolve-bug` attach, deleting a task.

## Architecture

Every site write goes through the bot, like the board drag, so Discord shows exactly
what it shows for a Discord-made change. CSAAS never writes the bot's tables.

```
site                          CSAAS (accessToken, bindActorToToken,         bot (x-internal-secret)
                              requirePortalPermission update_discord_tasks)
POST /discord/tasks/create  → DiscordTasksCreate_object   → POST /internal/tasks/create  → services/taskCreate.js
POST /discord/tasks/update  → DiscordTasksUpdate_object   → POST /internal/tasks/update  → services/taskEdit.js
POST /discord/tasks/subtask → DiscordTasksSubtask_object  → POST /internal/tasks/subtask → createSubtask
```

### Bot

**Auth and plumbing.** The three new routes share `handleStatusRequest`'s front half:
503 when `BOT_INTERNAL_SECRET` is unset, 401 on a missing/wrong `x-internal-secret`
(`safeEqual`), the body normalised to `{}` before any property read, one try/catch around
the handler body, `TaskRuleError` → 409, anything else → 500 logged with `[internal]`.
The shared part is extracted into one helper in `internalTaskRoute.js`; `/status` keeps
its exact behaviour and tests. `server.js` dispatches the three new paths.

**Actor.** As today: `actor.email` is matched to `guildmember` with
`findByConfigEmail` in the task's guild; the match (a Discord id) is used as
`activityId` (activity log, `taskdependency.createdBy`, the creator) and never as a
mention. The label is `<name-or-email> (via the site)`.

**`POST /internal/tasks/update`** — body `{ taskId, changes, actor }`. `changes` holds only
the fields the user changed, keyed `status`, `title`, `description`, `scope`,
`implementationStatus`, `projectId`, `holderIds`, `passedApiTests`, `passedQaTests`,
`passedAcceptanceCriteria`, `estimate`, `blockerIds`. Unknown keys → 400.

1. Load the task by id (404 if missing). Guild scope is by id alone, as on `/status`
   (single-guild deployment; see the knowledge file's "no guild scope" note).
2. **Validate everything before any write** with a pure rule module (new leaf
   `utils/taskEditRules.js`, reusing `TASK_STATUSES`, `SCOPE_VALUES`, `MAX_TEST_COUNT`,
   `parseDuration`, `MAX_STORABLE_MINUTES`): each field per the table above; the project
   must exist in the task's guild; every holder id must be a `guildmember` of the guild;
   blocker adds must not name the task itself, must exist in the guild, and — checked
   against the dependency graph *with all proposed adds and removes applied* — must not
   form a cycle (`wouldCycle`). Any refusal → 400 with the sentence Discord would show,
   nothing written.
3. Translate to the `updates` object `/update-task` builds (holders to `assigneeIds` or
   `taggedMemberIds`, `projectId` + `projectName`, `estimateMinutes`), dropping values
   equal to the current row. Nothing left and no blocker change → 200 `unchanged: true`,
   no write.
4. Apply through the new interaction-free core **`services/taskEdit.js` `applyEdit({ db,
   client, guild, cfg, task, updates, blockers: { add, remove }, actor })`**, extracted from
   `runUpdate`: `assertCanFinish` → each blocker add/remove via `applyDependencyChange` →
   `applyTaskUpdate`. `runUpdate` becomes a thin wrapper over it, so `/update-task`, the
   hub and the site share one path. One `applyTaskUpdate` call means one activity entry
   and one channel post.
5. 200 `{ ok, task: { id, status }, warning, lines, unchanged }` — `warning` joins the
   blocker warning and `projectMoveNote`.

**`POST /internal/tasks/create`** — body `{ type, title, description, projectId, scope,
modules, holderIds, repositoryIds, tracks: { apiTests, qaTests, acceptanceCriteria },
actor }`.

- `type` is `feature` or `bug`. **`projectId` is required on the site** — it gives the
  guild and puts the task under a project card. Validated like the update fields;
  repositories must belong to the guild; a bug takes at most one repository.
- New **`services/taskCreate.js` `createTask({ db, client, guild, cfg, fields, actor,
  createChannel, createIssue })`**, the body of `/create-task`'s `handleCreate` moved out:
  the row (`feature.create` / `bugTicket.create`, same columns and defaults — feature
  `open` + `not_started`, bug `pending`; a tracked metric starts at 0, untracked `null`),
  `featureRepositories.add`, `ticketDoc.create`, the bug's GitHub issue (best-effort), the
  channel, `discordChannelId` written back. `handleCreate` calls it and keeps only the
  Discord reply, so Discord output is unchanged.
- **Channel placement.** A feature uses `createTaskTicketChannel` as today. A bug with a
  project uses `createTaskTicketChannel` (`type: 'bug'`, project section, as client-raised
  bugs already do); a bug without a project — only `/create-task` makes those — keeps the
  existing global-Bugs channel code exactly.
- **Creator.** The email match becomes `createdBy`; no match → `createdBy = null`. The
  opening embed gets a "Created by" field (`<@id>` when matched, else the site label). The
  site creator is **not** auto-added to the holders (Discord adds the invoker because the
  invoker is in Discord; the site user picks holders explicitly).
- 201-style body `{ ok, task: { id, type, status, projectId }, channelId, fellBack, note }`
  (HTTP 200, `note` = `channelPlacementNote`'s text in plain words).

**`POST /internal/tasks/subtask`** — body `{ parentId, title, holderIds, actor }`. Calls
`createSubtask` (its own refusals — subtask of a subtask, more than 25, empty title — are
`TaskRuleError` → 409). Ticking a subtask is an ordinary `/update` of that subtask's
`status` (`done`/`open`); `syncParent` handles the parent.

### CSAAS

- The loopback call and its error mapping are extracted from `discordTasksStatus.js` into
  one helper (`botLink.js`: env check → 503, fetch with 15 s timeout → 502 unreachable,
  bot 400/404/409 passed with the bot's message, 401/503 → 502 configuration, other → 502,
  unreadable 2xx → 502). `/status` uses it unchanged.
- Three objects, same flags as `DiscordTasksStatus_object` (`accessToken: true`,
  `bindActorToToken: true`, `permission: null`, permission `update_discord_tasks` checked in
  the handler). Each does shape checks only (types, lengths, id formats, array caps: 50
  holders, 50 blockers, 20 repositories, 20 modules), snake_case in → camelCase to the bot,
  actor email only when `__identityVerified`, name via `actorName`. Logs
  `[discord-tasks] <email> created|updated|added subtask …`.
- `GET /api/discord/tasks` gains top-level `repositories: [{ id, name, url }]` from
  `granjur.repository`, `[]` if the query fails (deploy-order safe).

### Site

- `api.ts`: `createTask`, `updateTask`, `addSubtask` on `apiCall` (payload-first errors,
  `ApiError.status`).
- New pure `src/screens/team/taskFormLogic.ts` (vitest): `formFromTask(task)`,
  `diffChanges(task, form)` (only changed fields, lists compared as sets, estimate
  compared as parsed text), `validateForm(form)` (the same limits, for instant feedback;
  the bot still decides), `createPayload(form)`.
- **Task page** (`TaskDetail.tsx`): an Edit button, shown only when
  `useActingPermissions().has('update_discord_tasks')`, swaps the read view for
  `TaskEditForm` — every field in the table, holders as a multi-select from the roster
  (`payload.members`), project select, blockers as a removable list plus a task picker
  (other tasks in the payload), Save / Cancel. Save sends `diffChanges`; nothing changed →
  no request. Success: warning (if any) as a notice, back to read view, `refresh()`.
  Failure: the message inline, the form keeps its values. A subtask checklist and an
  "Add subtask" input sit on the page, save immediately, then `refresh()`.
- **Create page** `/tools/team/tasks/new` (`?project=<docsSlug>` preselects): type toggle,
  title, description, project, scope, holders (label "Assignees" / "Tagged members" by
  type), modules and repositories (feature), one repository (bug), the three "tracks …"
  switches. On success, navigate to `/tools/team/tasks/<newId>` after `refresh()`.
- Without the permission the buttons do not render and the create route shows the
  existing permission notice.

## Error handling

| Case | Result on the site |
|---|---|
| A field the bot refuses (cycle, bad value, unknown member, finishing with open subtasks) | the bot's sentence, inline; nothing written |
| No `update_discord_tasks` | 403 → "You need the update_discord_tasks permission" |
| Bot offline / misconfigured | 502 → "Discord bot is offline, try again" |
| Task deleted meanwhile | 404 → "This task no longer exists" |
| Stale form (someone changed the task meanwhile) | only changed fields are sent, so untouched fields are not overwritten; a field both people changed takes the last save (accepted) |

## Testing

- Bot (`node:test`, `DATABASE_URL=poisoned://no-production-access`, fakes for every
  `db`/`getConfig`): `taskEditRules` pure tests per field; route tests for auth, 400/404/
  409/200 and "validate before write" (a refused blocker leaves no update); `applyEdit`
  with fakes; `/update-task` and hub suites stay green through the `runUpdate` wrapper;
  `taskCreate` tests for both types and both bug channel paths; `/create-task` suite green.
- CSAAS (`node` scripts in `discord-tasks-test/`, `__setTestHooks`): shape checks,
  permission, the shared `botLink` mapping, body sent to the bot, `repositories` fallback.
- Site (vitest): `taskFormLogic` diff/validation/payload.

## Rollout

Bot → CSAAS → site, as before. No new env values: the existing `BOT_INTERNAL_SECRET` /
`DISCORD_BOT_SECRET` pair covers the new routes. First live check: create a feature on
the site and see its channel appear in the project section; edit it and see one
"(via the site) updated this task" post.

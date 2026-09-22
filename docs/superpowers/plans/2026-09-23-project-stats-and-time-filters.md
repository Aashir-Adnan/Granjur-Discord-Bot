# Project Stats Tab and Time Tab Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Team section's Time tab under the shared Project/Assignee filter bar, and add a Stats tab showing each project's members, completion percentage and activity graphs.

**Architecture:** CSAAS gains one shared `timeScope.js` helper (extracted from the two existing time endpoints), an optional `project` parameter on those two endpoints, and one new aggregation endpoint `GET /api/discord/projects/stats` returning sparse per-day series. The site's Team shell renders Project + Assignee on every tab (roster-sourced), the Time tab reads them from context instead of owning a Person select, and a new Stats tab combines snapshot numbers from the already-loaded tasks payload with the series endpoint, drawn by four small hand-rolled SVG chart components whose math lives in a pure, tested `statsLogic.ts`.

**Tech Stack:** CSAAS_Backend — CommonJS, UBS framework `global.<Name>_object` API declarations, mysql2 via `executeQuery`, assert-based test scripts run with `node <file>`. UBS-Doc — React 19, TypeScript strict, react-router 7, Tailwind 4, lucide-react, vitest (node environment).

**Spec:** `docs/superpowers/specs/2026-09-23-project-stats-and-time-filters-design.md` (in the Granjur-Discord-Bot repo)

## Global Constraints

- Three sibling repos: `D:/Work/Granjur Technologies/Granjur-Discord-Bot` (docs only here), `D:/Work/Granjur Technologies/CSAAS_Backend`, `D:/Work/Granjur Technologies/UBS-Doc`. No bot code changes.
- CSAAS: `toMysqlUtc` has exactly one definition, in `discordTimeReport.js`; import it, never copy it. Every date bound to SQL goes through it.
- CSAAS: every self-scope / person / project filter is a SQL `WHERE` clause, never a JS post-filter.
- CSAAS: identity comes only from `decryptedPayload.__identityVerified && decryptedPayload.actor_email`; never from a client-supplied id.
- CSAAS tests: `node Services/SysScripts/TestScripts/discord-tasks-test/<file>.test.js`; they substitute `__setTestHooks` and never open a database connection. The URL `/api/discord/projects/stats` resolves to `global.DiscordProjectsStats_object` (path parts title-cased and joined, see `Services/Middlewares/config.js getApiObject`); files under `Src/Apis` are auto-required at boot.
- Site tests: `npm test` (vitest) and `npx tsc --noEmit` both clean. Pure logic in `*Logic.ts`, no React in it.
- Site line endings: existing files use LF. Commit with the repo's git identity (Nauraiz Haider <bsse23047@itu.edu.pk>) and end commit messages with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Terminal statuses are `closed`, `done`, `resolved` everywhere.
- Stale = no activity for 14 days. Stats series are day-keyed `YYYY-MM-DD` strings, sparse, ascending.

---

## File structure

**CSAAS_Backend**
- Create `Src/Apis/ProjectSpecificApis/DiscordTasks/timeScope.js` — verified email, caller identity, permission→scope, guild id resolution. Takes the caller's hooks so each endpoint's test seam keeps working.
- Modify `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeReport.js` — import from `timeScope.js`; accept `project`.
- Modify `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeEntries.js` — import from `timeScope.js`; accept `project`.
- Create `Src/Apis/ProjectSpecificApis/DiscordTasks/discordProjectStats.js` — the stats endpoint.
- Create `Services/SysScripts/TestScripts/discord-tasks-test/timeScope.test.js`, `stats.test.js`; extend `time.test.js`, `entries.test.js`.

**UBS-Doc**
- Modify `src/components/discordTasks/api.ts` — `project` on two fetches; `fetchProjectStats` + types.
- Modify `src/screens/team/teamNav.ts` (+ test) — `stats` tab.
- Create `src/screens/team/statsLogic.ts` (+ test) — bucketing, rollups, stacking, snapshot math, scales.
- Modify `src/screens/team/TeamLayout.tsx` — per-tab controls, roster-sourced Assignee, `timeSelfScoped` context.
- Modify `src/screens/team/TimeTab.tsx` — read filters from context.
- Create `src/screens/team/charts/Sparkline.tsx`, `Bars.tsx`, `StackedBars.tsx`, `CumulativeLines.tsx`.
- Create `src/screens/team/Stats.tsx`; modify `src/app/routes.tsx`.

**Granjur-Discord-Bot** (docs only)
- Modify `.claude/knowledge/project-tasks-site.md`, `.claude/state/*`.

---

### Task 1: Extract `timeScope.js` (CSAAS)

**Files:**
- Create: `Src/Apis/ProjectSpecificApis/DiscordTasks/timeScope.js`
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeReport.js` (remove `callerIdentity`, `resolveScope`, the email + cfgIds blocks)
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeEntries.js` (remove `callerIdentity`, the email + cfgIds blocks)
- Create: `Services/SysScripts/TestScripts/discord-tasks-test/timeScope.test.js`

**Interfaces:**
- Produces (all in `timeScope.js`, all take `hooks = { requirePortalPermission, executeQuery }`):
  - `verifiedEmail(decryptedPayload) -> string | null`
  - `callerIdentity(email, hooks) -> Promise<{ guildConfigId: string | null, discordId: string | null }>`
  - `resolveScope(req, decryptedPayload, hooks) -> Promise<'all' | 'self'>`
  - `resolveTimeScope({ req, decryptedPayload, hooks }) -> Promise<{ scope, discordId, guildConfigId }>`
  - `resolveCfgIds(identity, hooks) -> Promise<string[]>` (throws the raw error; callers map it to their own 502)

- [ ] **Step 1: Write the failing test**

Create `Services/SysScripts/TestScripts/discord-tasks-test/timeScope.test.js`:

```js
const assert = require("assert");
const { verifiedEmail, callerIdentity, resolveScope, resolveTimeScope, resolveCfgIds } =
  require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/timeScope");

function hooks({ allowed = true, throwOther = null, identity = { guildConfigId: "g1", discordId: "u1" }, guilds = [{ id: "g1" }, { id: "g2" }] } = {}) {
  const calls = [];
  return {
    calls,
    requirePortalPermission: async (_req, _p, permission) => {
      if (throwOther) throw throwOther;
      if (permission === "view_discord_time" && !allowed) throw { statusCode: 403, message: "denied" };
      return { urddId: 7 };
    },
    executeQuery: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM granjur\.guildmember WHERE LOWER\(email\)/.test(sql)) return identity ? [identity] : [];
      if (/FROM granjur\.guildconfig/.test(sql)) return guilds;
      return [];
    },
  };
}

(async () => {
  // Only a token-bound identity yields an email; a forged actor_email without
  // __identityVerified is ignored.
  assert.strictEqual(verifiedEmail({ __identityVerified: true, actor_email: " Ana@X.com " }), "ana@x.com");
  assert.strictEqual(verifiedEmail({ actor_email: "ana@x.com" }), null);
  assert.strictEqual(verifiedEmail({ __identityVerified: true, actor_email: "" }), null);
  assert.strictEqual(verifiedEmail(undefined), null);

  // Identity is best-effort: no row, or a failing lookup, is { null, null }.
  let h = hooks({ identity: null });
  assert.deepStrictEqual(await callerIdentity("ana@x.com", h), { guildConfigId: null, discordId: null });
  assert.deepStrictEqual(await callerIdentity(null, h), { guildConfigId: null, discordId: null });
  assert.strictEqual(h.calls.length, 1, "no email means no query");
  h = hooks(); h.executeQuery = async () => { throw new Error("db down"); };
  assert.deepStrictEqual(await callerIdentity("ana@x.com", h), { guildConfigId: null, discordId: null });
  h = hooks({ identity: { guildConfigId: "g1", discordId: 42 } });
  assert.deepStrictEqual(await callerIdentity("ana@x.com", h), { guildConfigId: "g1", discordId: "42" }, "discordId is stringified");

  // Scope: only a 403 downgrades; anything else is a real failure.
  assert.strictEqual(await resolveScope({}, {}, hooks({ allowed: true })), "all");
  assert.strictEqual(await resolveScope({}, {}, hooks({ allowed: false })), "self");
  let thrown = null;
  try { await resolveScope({}, {}, hooks({ throwOther: new Error("boom") })); } catch (e) { thrown = e; }
  assert.strictEqual(thrown && thrown.message, "boom", "a non-403 error propagates");

  // The composite: scope + identity in one call.
  const out = await resolveTimeScope({ req: {}, decryptedPayload: { __identityVerified: true, actor_email: "ana@x.com" }, hooks: hooks({ allowed: false }) });
  assert.deepStrictEqual(out, { scope: "self", discordId: "u1", guildConfigId: "g1" });

  // Guild ids: the caller's own guild when known, otherwise every guild.
  assert.deepStrictEqual(await resolveCfgIds({ guildConfigId: "g1" }, hooks()), ["g1"]);
  assert.deepStrictEqual(await resolveCfgIds({ guildConfigId: null }, hooks()), ["g1", "g2"]);
  h = hooks(); h.executeQuery = async () => { throw new Error("db down"); };
  thrown = null;
  try { await resolveCfgIds({ guildConfigId: null }, h); } catch (e) { thrown = e; }
  assert.ok(thrown, "a failing guildconfig read throws for the caller to map to its own 502");

  console.log("timeScope.test.js: ok");
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Run (from the CSAAS repo): `node Services/SysScripts/TestScripts/discord-tasks-test/timeScope.test.js`
Expected: FAIL with `Cannot find module '.../timeScope'`

- [ ] **Step 3: Create `timeScope.js`**

```js
// Shared by discordTimeReport.js, discordTimeEntries.js and
// discordProjectStats.js: who is calling (from the token-bound email only),
// whether they hold view_discord_time, and which guild(s) to scope to.
//
// Every function takes the CALLER's hooks object ({ requirePortalPermission,
// executeQuery }) rather than owning one, so each endpoint's existing
// __setTestHooks seam keeps reaching these queries. This file itself opens no
// database connection and imports no framework module.

// Only a token-bound identity may drive any self-scope lookup. actorBinding.js
// sets actor_email (and __identityVerified) solely when the token's user
// resolved an email — trusting an unverified actor_email would let a caller
// read someone else's hours by forging the field.
function verifiedEmail(decryptedPayload) {
  if (!decryptedPayload || !decryptedPayload.__identityVerified) return null;
  const email = String(decryptedPayload.actor_email || "").toLowerCase().trim();
  return email || null;
}

// The caller's own guildConfigId/discordId, resolved from their verified
// email. Best-effort only: no matching guildmember row (or the lookup itself
// failing) must not fail the request — it just means we can't scope to one
// guild and can't identify the caller's own rows.
async function callerIdentity(email, hooks) {
  if (!email) return { guildConfigId: null, discordId: null };
  try {
    const rows = await hooks.executeQuery(
      "SELECT guildConfigId, discordId FROM granjur.guildmember WHERE LOWER(email) = ?",
      [email]
    );
    const row = rows && rows[0];
    return row
      ? { guildConfigId: row.guildConfigId ?? null, discordId: row.discordId != null ? String(row.discordId) : null }
      : { guildConfigId: null, discordId: null };
  } catch (_) {
    return { guildConfigId: null, discordId: null };
  }
}

// 'all' when the caller holds view_discord_time, 'self' on a 403. Anything
// else the permission check throws (a genuine 500, a DB error) is NOT a
// permission refusal — swallowing it into a quiet self-scoped "successful"
// response would hide a broken permission check behind what looks like a
// normal restricted view. Only a 403 downgrades; everything else propagates.
async function resolveScope(req, decryptedPayload, hooks) {
  try {
    await hooks.requirePortalPermission(req, decryptedPayload, "view_discord_time");
    return "all";
  } catch (e) {
    if (e && e.statusCode === 403) return "self";
    throw e;
  }
}

async function resolveTimeScope({ req, decryptedPayload, hooks }) {
  const [scope, identity] = await Promise.all([
    resolveScope(req, decryptedPayload, hooks),
    callerIdentity(verifiedEmail(decryptedPayload), hooks),
  ]);
  return { scope, discordId: identity.discordId, guildConfigId: identity.guildConfigId };
}

// guildConfigId IN (...) is every guild UNLESS one specific guild was resolved
// for the caller, in which case everything is scoped to just that guild
// (correct for the single-guild deployment this codebase is, and simpler).
// Throws on a failed read; each endpoint maps that to its own 502 message.
async function resolveCfgIds(identity, hooks) {
  if (identity && identity.guildConfigId) return [identity.guildConfigId];
  const rows = await hooks.executeQuery("SELECT id FROM granjur.guildconfig", []);
  return (rows || []).map((r) => r.id);
}

module.exports = { verifiedEmail, callerIdentity, resolveScope, resolveTimeScope, resolveCfgIds };
```

- [ ] **Step 4: Run the new test**

Run: `node Services/SysScripts/TestScripts/discord-tasks-test/timeScope.test.js`
Expected: `timeScope.test.js: ok`

- [ ] **Step 5: Point `discordTimeReport.js` at the helper**

Add the import after the existing two `require`s:

```js
const { verifiedEmail, callerIdentity, resolveScope, resolveCfgIds } = require("./timeScope");
```

Delete the local `async function callerIdentity(email) {…}` and `async function resolveScope(req, decryptedPayload) {…}` definitions (and their two comment blocks). In `getTimeReport`, replace everything from `const email = decryptedPayload?.__identityVerified` through the `cfgIds` try/catch with:

```js
  const [scope, identity] = await Promise.all([
    resolveScope(req, decryptedPayload, __hooks),
    callerIdentity(verifiedEmail(decryptedPayload), __hooks),
  ]);

  const { since, until } = resolveRange(req, decryptedPayload);

  let cfgIds;
  try {
    cfgIds = await resolveCfgIds(identity, __hooks);
  } catch (_) {
    throw fail(502, "Could not read time data");
  }
```

- [ ] **Step 6: Point `discordTimeEntries.js` at the helper**

Add after the `toMysqlUtc` import:

```js
const { verifiedEmail, callerIdentity, resolveCfgIds } = require("./timeScope");
```

Delete the local `callerIdentity` function and its comment. In `getTimeEntries`, replace the `const email = …` / `const identity = await callerIdentity(email);` lines with:

```js
  const identity = await callerIdentity(verifiedEmail(decryptedPayload), __hooks);
```

and replace the `cfgIds` try/catch with:

```js
  let cfgIds;
  try {
    cfgIds = await resolveCfgIds(identity, __hooks);
  } catch (_) {
    throw fail(502, "Could not read time entries");
  }
```

- [ ] **Step 7: Run every discord test script**

Run:
```
for f in Services/SysScripts/TestScripts/discord-tasks-test/*.test.js; do node "$f" || exit 1; done
```
Expected: every script exits 0 (`time.test.js` and `entries.test.js` unchanged and passing — the behaviour is identical, only its home moved).

- [ ] **Step 8: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/timeScope.js Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeReport.js Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeEntries.js Services/SysScripts/TestScripts/discord-tasks-test/timeScope.test.js
git commit -m "refactor(discord): extract the time-scope resolution shared by the time endpoints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `project` parameter on the report and entries endpoints (CSAAS)

**Files:**
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeReport.js`
- Modify: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeEntries.js`
- Modify: `Services/SysScripts/TestScripts/discord-tasks-test/time.test.js`, `entries.test.js`

**Interfaces:**
- Consumes: Task 1's helpers.
- Produces: both endpoints accept `?project=<docsSlug>`; both responses carry `project: string | null` (echoed). `resolveProject(req, decryptedPayload) -> string | null` exported from `discordTimeReport.js` and imported by the entries endpoint (and by Task 3).

- [ ] **Step 1: Write the failing tests**

Append to the `timeReport()` function in `time.test.js`, before its closing brace:

```js
  // A project filter is a SQL clause on the joined task's project slug, bound
  // as a parameter, and echoed so the client can match responses to filters.
  calls = reportHooks({ allowed: true, rows: [] });
  out = await getTimeReport({ query: { project: "framework" } }, reportPayload());
  timeCall = calls.find((c) => c.sql.includes("FROM granjur.clockentry"));
  assert.ok(/t\.projectId IN \(SELECT id FROM granjur\.project WHERE docsSlug = \?\)/.test(timeCall.sql), "project filtered in SQL via the slug");
  assert.strictEqual(timeCall.params[timeCall.params.length - 1], "framework", "the slug is the last bound parameter");
  assert.strictEqual(out.project, "framework", "the slug is echoed");

  // No project: no clause, and null echoed.
  calls = reportHooks({ allowed: true, rows: [] });
  out = await getTimeReport({ query: {} }, reportPayload());
  timeCall = calls.find((c) => c.sql.includes("FROM granjur.clockentry"));
  assert.ok(!/granjur\.project/.test(timeCall.sql), "no project clause without a filter");
  assert.strictEqual(out.project, null);
```

Append to `entries.test.js` inside the async IIFE, before `console.log`/end (after the `shaped` assertions):

```js
  // Project filter: same clause as the report, bound after the range, echoed.
  calls = hooks({ allowed: true });
  const filtered = await getTimeEntries({ query: { discordId: "u1", project: "framework" } }, payload());
  q = calls.find((c) => /FROM granjur.clockentry/.test(c.sql));
  assert.ok(/t\.projectId IN \(SELECT id FROM granjur\.project WHERE docsSlug = \?\)/.test(q.sql), "project filtered in SQL via the slug");
  assert.strictEqual(q.params[q.params.length - 1], "framework", "the slug is the last bound parameter");
  assert.strictEqual(filtered.project, "framework");
  calls = hooks({ allowed: true });
  const unfiltered = await getTimeEntries({ query: { discordId: "u1" } }, payload());
  assert.strictEqual(unfiltered.project, null);
```

- [ ] **Step 2: Run both to verify they fail**

Run: `node Services/SysScripts/TestScripts/discord-tasks-test/time.test.js; node Services/SysScripts/TestScripts/discord-tasks-test/entries.test.js`
Expected: both FAIL on the `t.projectId IN` regex assertion.

- [ ] **Step 3: Add `resolveProject` and the clause to the report**

In `discordTimeReport.js`, after `resolveRange`:

```js
// `?project=<docsSlug>` narrows to one project. Read the same way since/until
// are (decryptedPayload first, then req.query). Empty or missing means no
// filter; the slug is never validated here — an unknown slug simply matches
// no project and yields an empty result, which is the honest answer.
function resolveProject(req, decryptedPayload) {
  const raw = decryptedPayload?.project ?? req?.query?.project;
  const slug = typeof raw === "string" ? raw.trim() : "";
  return slug || null;
}

// The one project clause every time endpoint uses. A subquery on the slug
// rather than a JOIN so the callers' existing LEFT JOIN on task stays the
// only join, and so the clause reads the same in all three files.
const PROJECT_CLAUSE = " AND t.projectId IN (SELECT id FROM granjur.project WHERE docsSlug = ?)";
```

In `getTimeReport`, after `const { since, until } = resolveRange(req, decryptedPayload);` add `const project = resolveProject(req, decryptedPayload);`. In the SQL block, after the `if (scope === "self") {…}` block and before `sql += " GROUP BY …"`, add:

```js
      if (project) {
        sql += PROJECT_CLAUSE;
        params.push(project);
      }
```

Change the return to `return { since: since.toISOString(), until: until.toISOString(), project, people, projects, scope };`.

Register the parameter: in `DiscordTimeReport_object`'s `fields`, add `{ name: "project", type: "string", required: false, source: "req.query" }`. Export `resolveProject` and `PROJECT_CLAUSE` from `module.exports`.

- [ ] **Step 4: Add the clause to the entries endpoint**

In `discordTimeEntries.js` change the `toMysqlUtc` import to `const { toMysqlUtc, resolveProject, PROJECT_CLAUSE } = require("./discordTimeReport");`. In `getTimeEntries`, after `resolveRange`, add `const project = resolveProject(req, decryptedPayload);`. Replace the query call so the SQL and params are built then executed:

```js
      const ph = cfgIds.map(() => "?").join(", ");
      let sql =
        `SELECT c.id, c.clockInAt, c.clockOutAt, c.minutes, c.note, c.source,
                c.taskId, t.title AS taskTitle, t.projectId, t.projectName
         FROM granjur.clockentry c
         LEFT JOIN granjur.task t ON t.id = c.taskId
         WHERE c.minutes IS NOT NULL
           AND c.guildConfigId IN (${ph})
           AND c.discordId = ?
           AND c.clockInAt >= ? AND c.clockInAt < ?`;
      const params = [...cfgIds, wanted, toMysqlUtc(since), toMysqlUtc(until)];
      if (project) { sql += PROJECT_CLAUSE; params.push(project); }
      sql += ` ORDER BY c.clockInAt ASC LIMIT ${LIMIT}`;
      rows = await __hooks.executeQuery(sql, params);
```

Add `project,` to the returned object after `until`. Add the `project` field to `DiscordTimeEntries_object`'s `fields`.

- [ ] **Step 5: Run every discord test script**

Run: `for f in Services/SysScripts/TestScripts/discord-tasks-test/*.test.js; do node "$f" || exit 1; done`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/ Services/SysScripts/TestScripts/discord-tasks-test/
git commit -m "feat(discord): optional project filter on the time report and entries endpoints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `GET /api/discord/projects/stats` (CSAAS)

**Files:**
- Create: `Src/Apis/ProjectSpecificApis/DiscordTasks/discordProjectStats.js`
- Create: `Services/SysScripts/TestScripts/discord-tasks-test/stats.test.js`

**Interfaces:**
- Consumes: `toMysqlUtc`, `resolveProject` from `discordTimeReport.js`; `resolveTimeScope`, `resolveCfgIds` from `timeScope.js`.
- Produces: `getProjectStats(req, decryptedPayload)` returning the §4.2 shape. Exported pure helpers used by the tests: `parseChanges(v)`, `completionEvents(rows)`, `reduceStats({ projects, tasks, created, events, statusRows, lastActivity, time, since, until })`.

- [ ] **Step 1: Write the failing test**

Create `stats.test.js`:

```js
const assert = require("assert");
const { getProjectStats, parseChanges, completionEvents, reduceStats, __setTestHooks } =
  require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/discordProjectStats");
const { __setTestHooks: setReportHooks } = require("../../../../Src/Apis/ProjectSpecificApis/DiscordTasks/discordTimeReport");

const D = (s) => new Date(s);

function hooks({ allowed = true, identity = { guildConfigId: "g1", discordId: "u1" }, projects = [{ id: "p1", name: "Framework", docsSlug: "framework" }], tasks = [], created = [], events = [], statusRows = [], lastActivity = [], time = [] } = {}) {
  const calls = [];
  __setTestHooks({
    requirePortalPermission: async (_r, _p, permission) => { if (permission === "view_discord_time" && !allowed) throw { statusCode: 403, message: "no" }; },
    executeQuery: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM granjur\.guildmember WHERE LOWER\(email\)/.test(sql)) return identity ? [identity] : [];
      if (/FROM granjur\.guildconfig/.test(sql)) return [{ id: "g1" }];
      if (/FROM granjur\.project/.test(sql)) return projects;
      if (/JSON_SEARCH/.test(sql)) return statusRows;
      if (/MAX\(a\.createdAt\)/.test(sql)) return lastActivity;
      if (/FROM granjur\.taskactivity/.test(sql)) return events;
      if (/FROM granjur\.clockentry/.test(sql)) return time;
      if (/DATE_FORMAT\(t\.createdAt/.test(sql)) return created;
      if (/FROM granjur\.task /.test(sql)) return tasks;
      return [];
    },
  });
  setReportHooks({ env: () => ({ DB_TIMEZONE: "+05:00" }) });
  return calls;
}
const payload = () => ({ __identityVerified: true, actor_email: "me@x.com" });

(async () => {
  // parseChanges accepts what mysql2 hands back for a JSON column: parsed, or a string.
  assert.deepStrictEqual(parseChanges([{ field: "status" }]), [{ field: "status" }]);
  assert.deepStrictEqual(parseChanges('[{"field":"status","to":"done"}]'), [{ field: "status", to: "done" }]);
  assert.deepStrictEqual(parseChanges("not json"), []);
  assert.deepStrictEqual(parseChanges(null), []);

  // completionEvents: one event per activity row whose status change lands on
  // a terminal status. Reopen + close again counts twice; a move to in_progress
  // does not count.
  const ev = completionEvents([
    { taskId: "A", projectId: "p1", createdAt: D("2026-09-02T10:00:00Z"), changes: [{ field: "status", from: "open", to: "done" }] },
    { taskId: "A", projectId: "p1", createdAt: D("2026-09-03T10:00:00Z"), changes: [{ field: "status", from: "done", to: "open" }] },
    { taskId: "A", projectId: "p1", createdAt: D("2026-09-04T10:00:00Z"), changes: [{ field: "status", from: "open", to: "closed" }] },
    { taskId: "B", projectId: "p1", createdAt: D("2026-09-05T10:00:00Z"), changes: [{ field: "status", from: "open", to: "in_progress" }] },
  ]);
  assert.deepStrictEqual(ev.map((e) => [e.taskId, e.at.toISOString()]), [
    ["A", "2026-09-02T10:00:00.000Z"], ["A", "2026-09-04T10:00:00.000Z"],
  ]);

  // reduceStats: series per project, the updatedAt fallback for a terminal
  // task with no completion event, stale detection, and cycle time.
  const since = D("2026-09-01T00:00:00Z"), until = D("2026-09-30T00:00:00Z");
  const out = reduceStats({
    since, until,
    projects: [{ id: "p1", name: "Framework", docsSlug: "framework" }, { id: "p2", name: "Empty", docsSlug: null }],
    tasks: [
      { id: "A", projectId: "p1", title: "Done with event", status: "done", createdAt: D("2026-09-01T00:00:00Z"), updatedAt: D("2026-09-02T10:00:00Z") },
      { id: "B", projectId: "p1", title: "Done before logging", status: "closed", createdAt: D("2026-09-03T00:00:00Z"), updatedAt: D("2026-09-05T00:00:00Z") },
      { id: "C", projectId: "p1", title: "Stale and open", status: "open", createdAt: D("2026-08-01T00:00:00Z"), updatedAt: D("2026-08-02T00:00:00Z") },
      { id: "E", projectId: "p1", title: "Fresh and open", status: "open", createdAt: D("2026-09-20T00:00:00Z"), updatedAt: D("2026-09-28T00:00:00Z") },
    ],
    created: [{ projectId: "p1", day: "2026-09-01", n: 1 }, { projectId: "p1", day: "2026-09-03", n: 1 }],
    events: [{ projectId: "p1", day: "2026-09-02", n: 3 }],
    statusRows: [
      { taskId: "A", projectId: "p1", createdAt: D("2026-09-02T10:00:00Z"), changes: [{ field: "status", from: "open", to: "done" }] },
    ],
    lastActivity: [{ taskId: "A", lastAt: D("2026-09-02T10:00:00Z") }, { taskId: "E", lastAt: D("2026-09-28T00:00:00Z") }],
    time: [{ projectId: "p1", day: "2026-09-02", discordId: "u1", minutes: "90" }],
  });
  const p1 = out.projects.find((p) => p.id === "p1");
  assert.deepStrictEqual(p1.created, [{ day: "2026-09-01", n: 1 }, { day: "2026-09-03", n: 1 }]);
  assert.deepStrictEqual(p1.events, [{ day: "2026-09-02", n: 3 }]);
  assert.deepStrictEqual(p1.completed, [{ day: "2026-09-02", n: 1 }, { day: "2026-09-05", n: 1 }], "A from its event, B from updatedAt");
  assert.strictEqual(out.approximateCompletion, true, "B's fallback flags the response");
  assert.deepStrictEqual(p1.time, [{ day: "2026-09-02", discordId: "u1", minutes: 90 }], "SUM() strings become numbers");
  assert.deepStrictEqual(p1.stale.map((s) => s.taskId), ["C"], "C has no activity since August; E is fresh; A and B are not open");
  assert.strictEqual(p1.stale[0].lastActivityAt, "2026-08-02T00:00:00.000Z", "falls back to updatedAt when there is no activity row");
  // Cycle: A = 34h (1d 10h) = 2040m, B = 2d = 2880m; mean 2460.
  assert.strictEqual(p1.cycleMinutes, 2460);
  const p2 = out.projects.find((p) => p.id === "p2");
  assert.deepStrictEqual([p2.created, p2.completed, p2.events, p2.time, p2.stale, p2.cycleMinutes], [[], [], [], [], [], null], "an empty project is still listed");

  // The handler: self scope binds the caller's discordId on the clockentry
  // query only; the project slug narrows the project list; since omitted
  // drops the lower bound; the range and scope are echoed.
  let calls = hooks({ allowed: false });
  let res = await getProjectStats({ query: { project: "framework", until: "2026-09-30T00:00:00.000Z" } }, payload());
  assert.strictEqual(res.timeScope, "self");
  assert.strictEqual(res.project, "framework");
  assert.strictEqual(res.since, null);
  assert.strictEqual(res.until, "2026-09-30T00:00:00.000Z");
  const projQ = calls.find((c) => /FROM granjur\.project/.test(c.sql));
  assert.ok(/docsSlug = \?/.test(projQ.sql) && projQ.params.includes("framework"), "project list narrowed by slug in SQL");
  const timeQ = calls.find((c) => /FROM granjur\.clockentry/.test(c.sql));
  assert.ok(/AND c\.discordId = \?/.test(timeQ.sql) && timeQ.params.includes("u1"), "self scope is a SQL clause on the time query");
  assert.ok(!/clockInAt >= \?/.test(timeQ.sql), "no lower bound when since is omitted");
  assert.ok(timeQ.params.includes("2026-09-30 05:00:00"), "until bound through toMysqlUtc");
  const createdQ = calls.find((c) => /DATE_FORMAT\(t\.createdAt/.test(c.sql));
  assert.ok(!/AND c\.discordId/.test(createdQ.sql), "task series are never person-scoped");

  calls = hooks({ allowed: true });
  res = await getProjectStats({ query: { since: "2026-09-01T00:00:00.000Z", until: "2026-09-30T00:00:00.000Z" } }, payload());
  assert.strictEqual(res.timeScope, "all");
  assert.strictEqual(res.project, null);
  const timeQ2 = calls.find((c) => /FROM granjur\.clockentry/.test(c.sql));
  assert.ok(!/c\.discordId = \?/.test(timeQ2.sql), "no person clause with the permission");
  assert.ok(/clockInAt >= \?/.test(timeQ2.sql) && timeQ2.params.includes("2026-09-01 05:00:00"), "since bound through toMysqlUtc");

  // No projects at all: an empty list, no series queries, no error.
  calls = hooks({ projects: [] });
  res = await getProjectStats({ query: {} }, payload());
  assert.deepStrictEqual(res.projects, []);
  assert.ok(!calls.some((c) => /clockentry|taskactivity/.test(c.sql)), "nothing else queried without projects");

  // Older schema: taskactivity / clockentry reads failing degrade to empty series.
  hooks({ tasks: [{ id: "A", projectId: "p1", title: "x", status: "open", createdAt: D("2026-09-01T00:00:00Z"), updatedAt: D("2026-09-01T00:00:00Z") }] });
  __setTestHooks({ executeQuery: async (sql, params) => {
    if (/FROM granjur\.guildmember WHERE LOWER\(email\)/.test(sql)) return [{ guildConfigId: "g1", discordId: "u1" }];
    if (/FROM granjur\.project/.test(sql)) return [{ id: "p1", name: "Framework", docsSlug: "framework" }];
    if (/taskactivity|clockentry/.test(sql)) throw new Error("Table doesn't exist");
    if (/FROM granjur\.task /.test(sql)) return [];
    return [];
  } });
  res = await getProjectStats({ query: {} }, payload());
  assert.deepStrictEqual([res.projects[0].events, res.projects[0].time, res.projects[0].completed], [[], [], []]);

  console.log("stats.test.js: ok");
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node Services/SysScripts/TestScripts/discord-tasks-test/stats.test.js`
Expected: FAIL with `Cannot find module '.../discordProjectStats'`

- [ ] **Step 3: Create `discordProjectStats.js`**

```js
const { requirePortalPermission } = require("../../../HelperFunctions/PreProcessingFunctions/ProjectTenancy/portalAuthz");
const { executeQuery } = require("../../../../Services/Integrations/Database/queryExecution");
const { toMysqlUtc, resolveProject } = require("./discordTimeReport");
const { resolveTimeScope, resolveCfgIds } = require("./timeScope");

// GET /api/discord/projects/stats?since=&until=&project=
//
// Per-project time series for the site's "Team -> Stats" tab: tasks created,
// tasks completed and task events per day, time logged per day per person,
// plus the stale-task list and mean cycle time. The snapshot numbers the tab
// also shows (members, open/done counts, completion %) come from
// /api/discord/tasks, which the site already holds — this endpoint exists
// only for what that payload cannot carry: it caps activity at 15 events per
// task and has no per-day time at all.
//
// Everything here is bucketed by DAY as a 'YYYY-MM-DD' string, sparse (only
// days with data), ascending. Rolling up to weeks is the client's job.
//
// Time scope follows discordTimeReport.js exactly: callers with
// view_discord_time see everyone's minutes, everyone else sees their own —
// and that narrowing is a SQL clause on the clockentry query. Task-derived
// series are never person-scoped (task data is visible to any signed-in
// caller, as /api/discord/tasks already is).

const TERMINAL = new Set(["closed", "done", "resolved"]);
const STALE_DAYS = 14;
const STALE_CAP = 50;

const __hooks = {
  requirePortalPermission: (...a) => requirePortalPermission(...a),
  executeQuery: (...a) => executeQuery(...a),
};
function __setTestHooks(overrides) { Object.assign(__hooks, overrides); }

const fail = (statusCode, message) => ({ statusCode, message });

function parseIsoDate(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// `since` omitted (or unparseable) means all time — unlike the report, whose
// default is the current week, a stats range has no natural "this week".
function resolveRange(req, decryptedPayload) {
  const since = parseIsoDate(decryptedPayload?.since ?? req?.query?.since);
  const until = parseIsoDate(decryptedPayload?.until ?? req?.query?.until) || new Date();
  return { since, until };
}

// A JSON column arrives parsed from mysql2 normally, but as a string from an
// older driver setting; both are accepted, anything else is "no changes".
function parseChanges(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (_) { return []; }
  }
  return [];
}

const toDate = (v) => (v instanceof Date ? v : new Date(v));
const iso = (v) => (v == null ? null : toDate(v).toISOString());
const dayOf = (d) => toDate(d).toISOString().slice(0, 10);

// One completion per activity row whose status change lands on a terminal
// status. A task that is reopened and closed again completes twice, which is
// what a throughput chart wants.
function completionEvents(rows) {
  const out = [];
  for (const r of rows || []) {
    const hit = parseChanges(r.changes).some((c) => c && c.field === "status" && TERMINAL.has(String(c.to)));
    if (hit) out.push({ taskId: String(r.taskId), projectId: r.projectId != null ? String(r.projectId) : null, at: toDate(r.createdAt) });
  }
  return out.sort((a, b) => a.at - b.at);
}

const inRange = (at, since, until) => (!since || at >= since) && at < until;

function bump(map, key, n) { map.set(key, (map.get(key) || 0) + n); }
const sortedSeries = (map) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, n]) => ({ day, n }));

// Pure: turns the raw query rows into the response's `projects` array.
function reduceStats({ projects, tasks, created, events, statusRows, lastActivity, time, since, until }) {
  const byProject = new Map();
  for (const p of projects) {
    byProject.set(String(p.id), {
      id: String(p.id), name: p.name || "Unnamed project", docsSlug: p.docsSlug ?? null,
      created: new Map(), completed: new Map(), events: new Map(), time: [], stale: [], cycle: [],
    });
  }
  const get = (projectId) => byProject.get(projectId != null ? String(projectId) : "");

  for (const r of created || []) { const p = get(r.projectId); if (p) bump(p.created, String(r.day), Number(r.n || 0)); }
  for (const r of events || []) { const p = get(r.projectId); if (p) bump(p.events, String(r.day), Number(r.n || 0)); }

  const completions = completionEvents(statusRows);
  const firstCompletion = new Map(); // taskId -> Date
  const everCompleted = new Set();
  for (const c of completions) {
    everCompleted.add(c.taskId);
    if (!firstCompletion.has(c.taskId)) firstCompletion.set(c.taskId, c.at);
    const p = get(c.projectId);
    if (p && inRange(c.at, since, until)) bump(p.completed, dayOf(c.at), 1);
  }

  // Fallback: a terminal task with no completion event at all finished before
  // activity logging began. It is dated by updatedAt, and the response says
  // so via approximateCompletion.
  let approximateCompletion = false;
  const taskById = new Map();
  for (const t of tasks || []) {
    const id = String(t.id);
    taskById.set(id, t);
    const p = get(t.projectId);
    if (!p) continue;
    if (TERMINAL.has(String(t.status)) && !everCompleted.has(id)) {
      const at = toDate(t.updatedAt);
      if (inRange(at, since, until)) { bump(p.completed, dayOf(at), 1); approximateCompletion = true; }
      if (!firstCompletion.has(id)) firstCompletion.set(id, at);
    }
  }

  // Cycle time: tasks whose FIRST completion is in range, completed − created.
  for (const [taskId, at] of firstCompletion) {
    const t = taskById.get(taskId);
    if (!t || !inRange(at, since, until)) continue;
    const p = get(t.projectId);
    if (p) p.cycle.push((at - toDate(t.createdAt)) / 60000);
  }

  for (const r of time || []) {
    const p = get(r.projectId);
    if (p) p.time.push({ day: String(r.day), discordId: String(r.discordId), minutes: Number(r.minutes || 0) });
  }

  // Stale: open tasks with no activity for STALE_DAYS before `until`.
  const lastAt = new Map();
  for (const r of lastActivity || []) lastAt.set(String(r.taskId), toDate(r.lastAt));
  const cutoff = new Date(until.getTime() - STALE_DAYS * 86400000);
  for (const t of tasks || []) {
    if (TERMINAL.has(String(t.status))) continue;
    const p = get(t.projectId);
    if (!p) continue;
    const last = lastAt.get(String(t.id)) || (t.updatedAt ? toDate(t.updatedAt) : null);
    if (last && last < cutoff) p.stale.push({ taskId: String(t.id), title: t.title || "", lastActivityAt: iso(last) });
  }

  const out = [...byProject.values()].map((p) => ({
    id: p.id, name: p.name, docsSlug: p.docsSlug,
    created: sortedSeries(p.created),
    completed: sortedSeries(p.completed),
    events: sortedSeries(p.events),
    time: p.time.sort((a, b) => a.day.localeCompare(b.day) || a.discordId.localeCompare(b.discordId)),
    stale: p.stale.sort((a, b) => String(a.lastActivityAt).localeCompare(String(b.lastActivityAt))).slice(0, STALE_CAP),
    cycleMinutes: p.cycle.length ? Math.round(p.cycle.reduce((n, m) => n + m, 0) / p.cycle.length) : null,
  }));
  return { projects: out, approximateCompletion };
}

async function getProjectStats(req, decryptedPayload) {
  const { scope, discordId, guildConfigId } = await resolveTimeScope({ req, decryptedPayload, hooks: __hooks });
  const { since, until } = resolveRange(req, decryptedPayload);
  const project = resolveProject(req, decryptedPayload);

  let cfgIds;
  try {
    cfgIds = await resolveCfgIds({ guildConfigId }, __hooks);
  } catch (_) {
    throw fail(502, "Could not read project stats");
  }
  const empty = { since: since ? since.toISOString() : null, until: until.toISOString(), project, timeScope: scope, approximateCompletion: false, projects: [] };
  if (!cfgIds.length) return empty;

  const ph = cfgIds.map(() => "?").join(", ");
  let projects;
  try {
    let sql = `SELECT id, name, docsSlug FROM granjur.project WHERE guildConfigId IN (${ph})`;
    const params = [...cfgIds];
    if (project) { sql += " AND docsSlug = ?"; params.push(project); }
    projects = await __hooks.executeQuery(sql, params);
  } catch (_) {
    throw fail(502, "Could not read project stats");
  }
  if (!projects || !projects.length) return empty;

  const pids = projects.map((p) => p.id);
  const pph = pids.map(() => "?").join(", ");
  // Range clause + params for a given column. `since` null drops the lower bound.
  const range = (col) => {
    const parts = []; const params = [];
    if (since) { parts.push(`AND ${col} >= ?`); params.push(toMysqlUtc(since)); }
    parts.push(`AND ${col} < ?`); params.push(toMysqlUtc(until));
    return { sql: " " + parts.join(" "), params };
  };
  const q = (sql, params) => __hooks.executeQuery(sql, params);
  // taskactivity and clockentry arrive with the bot's migrations 021 and 023;
  // against an older schema those reads fail and degrade to empty series
  // rather than a broken page — the same allowance discordTasks.js makes.
  const soft = (p) => p.catch(() => []);

  // DATE_FORMAT rather than DATE(): mysql2 would turn a bare DATE into a JS
  // Date at midnight in the pool's timezone, and any later local-getter
  // formatting on a differently-zoned host would shift the day. A string
  // cannot drift. The day itself is the day of the STORED digits — the bot
  // writes clockInAt/createdAt in its host's local wall clock (no `timezone`
  // on its pool; see bot/src/Database/connection.js and the incident note at
  // bot/src/Database/index.js ~1908), so this is the guild's local day
  // exactly when the VM's zone matches the guild's, which it does today.
  const rCreated = range("t.createdAt"), rEvents = range("a.createdAt"), rTime = range("c.clockInAt");
  const timeSql =
    `SELECT t.projectId, DATE_FORMAT(c.clockInAt, '%Y-%m-%d') AS day, c.discordId, SUM(c.minutes) AS minutes ` +
    `FROM granjur.clockentry c JOIN granjur.task t ON t.id = c.taskId ` +
    `WHERE c.guildConfigId IN (${ph}) AND t.projectId IN (${pph}) AND c.minutes IS NOT NULL${rTime.sql}` +
    (scope === "self" ? " AND c.discordId = ?" : "") +
    ` GROUP BY t.projectId, day, c.discordId ORDER BY day`;
  const timeParams = [...cfgIds, ...pids, ...rTime.params, ...(scope === "self" ? [discordId] : [])];

  let tasks, created, events, statusRows, lastActivity, time;
  try {
    [tasks, created, events, statusRows, lastActivity, time] = await Promise.all([
      q(`SELECT id, projectId, title, status, createdAt, updatedAt FROM granjur.task WHERE guildConfigId IN (${ph}) AND projectId IN (${pph})`, [...cfgIds, ...pids]),
      q(`SELECT t.projectId, DATE_FORMAT(t.createdAt, '%Y-%m-%d') AS day, COUNT(*) AS n FROM granjur.task t WHERE t.guildConfigId IN (${ph}) AND t.projectId IN (${pph})${rCreated.sql} GROUP BY t.projectId, day ORDER BY day`, [...cfgIds, ...pids, ...rCreated.params]),
      soft(q(`SELECT t.projectId, DATE_FORMAT(a.createdAt, '%Y-%m-%d') AS day, COUNT(*) AS n FROM granjur.taskactivity a JOIN granjur.task t ON t.id = a.taskId WHERE a.guildConfigId IN (${ph}) AND t.projectId IN (${pph})${rEvents.sql} GROUP BY t.projectId, day ORDER BY day`, [...cfgIds, ...pids, ...rEvents.params])),
      // Unbounded on purpose: cycle time needs a task's FIRST completion and
      // the fallback needs to know whether it has ANY, both of which may be
      // outside the range. Only status changes are pulled.
      soft(q(`SELECT a.taskId, t.projectId, a.createdAt, a.changes FROM granjur.taskactivity a JOIN granjur.task t ON t.id = a.taskId WHERE a.guildConfigId IN (${ph}) AND t.projectId IN (${pph}) AND JSON_SEARCH(a.changes, 'one', 'status', NULL, '$[*].field') IS NOT NULL ORDER BY a.createdAt`, [...cfgIds, ...pids])),
      soft(q(`SELECT a.taskId, MAX(a.createdAt) AS lastAt FROM granjur.taskactivity a JOIN granjur.task t ON t.id = a.taskId WHERE a.guildConfigId IN (${ph}) AND t.projectId IN (${pph}) GROUP BY a.taskId`, [...cfgIds, ...pids])),
      soft(q(timeSql, timeParams)),
    ]);
  } catch (_) {
    throw fail(502, "Could not read project stats");
  }

  const reduced = reduceStats({ projects, tasks, created, events, statusRows, lastActivity, time, since, until });
  return { ...empty, approximateCompletion: reduced.approximateCompletion, projects: reduced.projects };
}

global.DiscordProjectsStats_object = {
  versions: {
    versionData: [
      {
        "*": {
          steps: [
            {
              config: {
                features: { multistep: false, parameters: false, pagination: false },
                communication: { encryption: false },
                verification: { otp: false, accessToken: true },
              },
              data: {
                parameters: {
                  fields: [
                    { name: "since", type: "string", required: false, source: "req.query" },
                    { name: "until", type: "string", required: false, source: "req.query" },
                    { name: "project", type: "string", required: false, source: "req.query" },
                  ],
                },
                apiInfo: {
                  preProcessFunctions: [],
                  query: { queryPayload: null, database: () => "main" },
                  postProcessFunction: getProjectStats,
                },
                requestMetaData: { requestMethod: "GET", permission: null, bindActorToToken: true },
              },
              response: {
                successMessage: "Project stats retrieved",
                errorMessage: "Failed to retrieve project stats",
              },
            },
          ],
        },
      },
    ],
  },
};

module.exports = {
  DiscordProjectsStats_object: global.DiscordProjectsStats_object,
  getProjectStats,
  parseChanges,
  completionEvents,
  reduceStats,
  __setTestHooks,
};
```

- [ ] **Step 4: Run the test**

Run: `node Services/SysScripts/TestScripts/discord-tasks-test/stats.test.js`
Expected: `stats.test.js: ok`. If the cycle-time assertion fails, check `dayOf`/`inRange` use `Date` objects (the test passes `Date`s; production rows are `Date`s from mysql2 too).

- [ ] **Step 5: Run every discord test script, then boot-check the module**

Run: `for f in Services/SysScripts/TestScripts/discord-tasks-test/*.test.js; do node "$f" || exit 1; done && node -e "require('./Src/Apis/ProjectSpecificApis/DiscordTasks/discordProjectStats'); console.log(typeof global.DiscordProjectsStats_object)"`
Expected: all pass; prints `object`.

- [ ] **Step 6: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/DiscordTasks/discordProjectStats.js Services/SysScripts/TestScripts/discord-tasks-test/stats.test.js
git commit -m "feat(discord): per-project stats endpoint with per-day series, stale tasks and cycle time

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: API client and Stats tab navigation (site)

**Files:**
- Modify: `src/components/discordTasks/api.ts`
- Modify: `src/screens/team/teamNav.ts`, `src/screens/team/teamNav.test.ts`

**Interfaces:**
- Produces:
  - `fetchTimeReport(since: Date, until: Date, projectSlug?: string | null)`; `TimeReportPayload.project: string | null`
  - `fetchTimeEntries(discordId: string, since: Date, until: Date, projectSlug?: string | null)`; `TimeEntriesPayload.project: string | null`
  - `fetchProjectStats(since: Date | null, until: Date, projectSlug?: string | null): Promise<ProjectStatsPayload>`
  - Types `DayPoint`, `TimePoint`, `StaleTask`, `ProjectStats`, `ProjectStatsPayload`
  - `TeamTabKey` includes `'stats'`; `TEAM_TABS` has a fifth entry `{ key: 'stats', label: 'Stats', path: '/tools/team/stats' }`.

- [ ] **Step 1: Write the failing nav test**

In `teamNav.test.ts`, change the `TEAM_TABS` expectation to include `['stats', '/tools/team/stats']` after the time entry (update the `it` title to "lists People, Tasks, Board, Time and Stats with their paths"), and add:

```ts
describe('the Stats tab', () => {
  it('is a tab and resolves from its path', () => {
    expect(TEAM_TABS.map((t) => t.key)).toContain('stats')
    expect(activeTab('/tools/team/stats')).toBe('stats')
    expect(activeTab('/tools/team/stats/')).toBe('stats')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run (from UBS-Doc): `npx vitest run src/screens/team/teamNav.test.ts`
Expected: FAIL — `TEAM_TABS` has four entries, and `activeTab('/tools/team/stats')` returns `'people'`.

- [ ] **Step 3: Update `teamNav.ts`**

```ts
export type TeamTabKey = 'people' | 'tasks' | 'board' | 'time' | 'stats'
```
Add `{ key: 'stats', label: 'Stats', path: `${TEAM_BASE}/stats` },` after the time entry in `TEAM_TABS`, and in `activeTab` add `if (rest === '/stats' || rest.startsWith('/stats/')) return 'stats'` after the time line.

- [ ] **Step 4: Run the nav test**

Run: `npx vitest run src/screens/team/teamNav.test.ts`
Expected: PASS

- [ ] **Step 5: Extend `api.ts`**

Replace `fetchTimeReport` and its payload type, and `fetchTimeEntries`, with:

```ts
export interface TimeReportPayload {
  since: string
  until: string
  project: string | null
  people: TimeReportPerson[]
  projects: TimeReportProject[]
  scope: 'all' | 'self'
}

// `project` is a docsSlug; omitted means every project. The server echoes it
// back so a response can be matched to the filter that asked for it.
const projectParam = (slug?: string | null) => (slug ? `&project=${encodeURIComponent(slug)}` : '')

export function fetchTimeReport(since: Date, until: Date, projectSlug?: string | null): Promise<TimeReportPayload> {
  const q = `since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}${projectParam(projectSlug)}`
  return mwGet(`/discord/time/report?${q}`) as Promise<TimeReportPayload>
}
```

In `TimeEntriesPayload` add `project: string | null` after `until`. Change the `fetchTimeEntries` signature to `(discordId: string, since: Date, until: Date, projectSlug?: string | null)` and its query line to:

```ts
  const q = `discordId=${encodeURIComponent(discordId)}&since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}${projectParam(projectSlug)}`
```

Append after `fetchTimeEntries`:

```ts
// GET /api/discord/projects/stats?since=&until=&project= — per-project,
// per-day series for the Stats tab. Every series is sparse and ascending;
// `since` null means all time. `timeScope` is 'self' when the caller lacks
// view_discord_time and `time` holds only their own rows.
export interface DayPoint { day: string; n: number }
export interface TimePoint { day: string; discordId: string; minutes: number }
export interface StaleTask { taskId: string; title: string; lastActivityAt: string | null }
export interface ProjectStats {
  id: string
  name: string
  docsSlug: string | null
  created: DayPoint[]
  completed: DayPoint[]
  events: DayPoint[]
  time: TimePoint[]
  stale: StaleTask[]
  cycleMinutes: number | null
}
export interface ProjectStatsPayload {
  since: string | null
  until: string
  project: string | null
  timeScope: 'all' | 'self'
  approximateCompletion: boolean
  projects: ProjectStats[]
}

export async function fetchProjectStats(since: Date | null, until: Date, projectSlug?: string | null): Promise<ProjectStatsPayload> {
  const parts = [`until=${encodeURIComponent(until.toISOString())}`]
  if (since) parts.push(`since=${encodeURIComponent(since.toISOString())}`)
  if (projectSlug) parts.push(`project=${encodeURIComponent(projectSlug)}`)
  const res = await fetch(`${API_BASE_URL}/api/discord/projects/stats?${parts.join('&')}`)
  const text = await res.text()
  let data: Record<string, unknown> = {}
  if (text) {
    try { data = JSON.parse(text) } catch { data = {} }
  }
  if (!res.ok) {
    const specific = typeof data.payload === 'string' && data.payload ? data.payload : ''
    const message = specific || (data.message as string) || (data.error as string) || res.statusText
    throw new ApiError(message, res.status)
  }
  const payload = data.payload as { return?: unknown } | undefined
  return (payload?.return ?? payload ?? data) as ProjectStatsPayload
}
```

- [ ] **Step 6: Type-check and test**

Run: `npx tsc --noEmit && npm test`
Expected: `tsc` clean (the only callers of the two changed fetches pass fewer args than the new optional one, so nothing breaks); all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/discordTasks/api.ts src/screens/team/teamNav.ts src/screens/team/teamNav.test.ts
git commit -m "feat(team): stats tab route and API client for project stats and project-filtered time

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `statsLogic.ts` (site, pure)

**Files:**
- Create: `src/screens/team/statsLogic.ts`, `src/screens/team/statsLogic.test.ts`

**Interfaces:**
- Consumes: `weekRange` from `./timeLogic`; types from `../../components/discordTasks/api` and `../tasksLogic`.
- Produces (all exported):
  - `type RangeKind = '30d' | '90d' | 'all'`; `RANGE_KINDS: { key: RangeKind; label: string }[]`
  - `rangeBounds(kind, now: Date, earliest?: string | null) -> { since: Date | null; until: Date; bucket: 'day' | 'week' }`
  - `dayKey(d: Date) -> string` (local `YYYY-MM-DD`), `parseDayKey(key) -> Date` (local midnight)
  - `weekKeyOf(dayKey) -> string` (its Monday's key)
  - `bucketKeys(since: Date, until: Date, bucket) -> string[]`
  - `rollup(points: DayPoint[], bucket) -> DayPoint[]` (day → week keys, summed; day bucket is identity)
  - `fillSeries(points: DayPoint[], keys: string[]) -> number[]`
  - `cumulative(values: number[]) -> number[]`
  - `stackByMember(points: TimePoint[], keys: string[], bucket, nameOf: (id) => string) -> { members: { discordId; name }[]; rows: number[][] }` (rows[keyIndex][memberIndex] minutes)
  - `MEMBER_COLORS: string[]`, `memberColor(index) -> string`
  - `completionPercent(tasks: TaskRow[]) -> number | null`
  - `memberBreakdown(discordId, tasks) -> { open: number; inProgress: number; done: number }`
  - `estimateSummary(tasks) -> { logged: number; estimate: number } | null`
  - `minutesInRange(points: TimePoint[], discordId?: string | null) -> number`
  - `linePath(values: number[], w: number, h: number, max: number) -> string`
  - `niceMax(n: number) -> number`

- [ ] **Step 1: Write the failing tests**

Create `statsLogic.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  rangeBounds, dayKey, parseDayKey, weekKeyOf, bucketKeys, rollup, fillSeries, cumulative, stackByMember,
  memberColor, MEMBER_COLORS, completionPercent, memberBreakdown, estimateSummary, minutesInRange, linePath, niceMax,
} from './statsLogic'
import type { TaskRow } from '../tasksLogic'

const task = (over: Partial<TaskRow>): TaskRow => ({
  id: 'x', title: 't', type: 'feature', status: 'open', implementationStatus: null, assignees: [], blockedBy: [], blocks: [],
  isBlocked: false, channelUrl: null, createdAt: '', updatedAt: '', description: null, scope: null, modules: [], createdBy: null,
  passedApiTests: null, passedQaTests: null, passedAcceptanceCriteria: null, projectId: 'p1', projectName: 'P', ...over,
})

describe('rangeBounds', () => {
  const now = new Date(2026, 8, 23, 15, 30) // 23 Sep 2026, local
  it('30d is thirty days back at local midnight, day buckets', () => {
    const r = rangeBounds('30d', now)
    expect(r.since).toEqual(new Date(2026, 7, 24, 0, 0, 0, 0))
    expect(r.until).toEqual(now)
    expect(r.bucket).toBe('day')
  })
  it('90d is week buckets', () => {
    const r = rangeBounds('90d', now)
    expect(r.since).toEqual(new Date(2026, 5, 25, 0, 0, 0, 0))
    expect(r.bucket).toBe('week')
  })
  it('all has no lower bound and week buckets', () => {
    expect(rangeBounds('all', now)).toEqual({ since: null, until: now, bucket: 'week' })
  })
})

describe('day and week keys', () => {
  it('round-trips a local day', () => {
    const d = new Date(2026, 0, 5)
    expect(dayKey(d)).toBe('2026-01-05')
    expect(parseDayKey('2026-01-05')).toEqual(d)
  })
  it('weekKeyOf is the Monday of that week', () => {
    expect(weekKeyOf('2026-09-23')).toBe('2026-09-21') // Wednesday -> Monday
    expect(weekKeyOf('2026-09-21')).toBe('2026-09-21')
    expect(weekKeyOf('2026-09-27')).toBe('2026-09-21') // Sunday belongs to the Monday before
  })
  it('bucketKeys lists every day, or every Monday, from since up to until', () => {
    expect(bucketKeys(new Date(2026, 8, 1), new Date(2026, 8, 4), 'day')).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(bucketKeys(new Date(2026, 8, 1), new Date(2026, 8, 4, 12), 'day')).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'])
    expect(bucketKeys(new Date(2026, 8, 2), new Date(2026, 8, 23), 'week')).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'])
  })
})

describe('series', () => {
  it('rollup to weeks sums the days of each Monday-started week; day bucket is unchanged', () => {
    const pts = [{ day: '2026-09-01', n: 2 }, { day: '2026-09-03', n: 3 }, { day: '2026-09-08', n: 1 }]
    expect(rollup(pts, 'week')).toEqual([{ day: '2026-08-31', n: 5 }, { day: '2026-09-07', n: 1 }])
    expect(rollup(pts, 'day')).toEqual(pts)
  })
  it('fillSeries zero-fills the gaps in key order and ignores points outside the keys', () => {
    expect(fillSeries([{ day: 'b', n: 4 }, { day: 'z', n: 9 }], ['a', 'b', 'c'])).toEqual([0, 4, 0])
  })
  it('cumulative runs a total', () => {
    expect(cumulative([1, 0, 2, 3])).toEqual([1, 1, 3, 6])
  })
  it('stackByMember builds a row per key with a column per member, members in first-seen order, named', () => {
    const out = stackByMember(
      [{ day: '2026-09-01', discordId: 'u2', minutes: 30 }, { day: '2026-09-01', discordId: 'u1', minutes: 60 }, { day: '2026-09-02', discordId: 'u1', minutes: 15 }],
      ['2026-09-01', '2026-09-02', '2026-09-03'], 'day', (id) => (id === 'u1' ? 'Ana' : 'Ben'),
    )
    expect(out.members).toEqual([{ discordId: 'u2', name: 'Ben' }, { discordId: 'u1', name: 'Ana' }])
    expect(out.rows).toEqual([[30, 60], [0, 15], [0, 0]])
  })
  it('stackByMember rolls days into weeks when asked', () => {
    const out = stackByMember(
      [{ day: '2026-09-01', discordId: 'u1', minutes: 10 }, { day: '2026-09-03', discordId: 'u1', minutes: 20 }],
      ['2026-08-31', '2026-09-07'], 'week', () => 'Ana',
    )
    expect(out.rows).toEqual([[30], [0]])
  })
  it('memberColor cycles the palette', () => {
    expect(memberColor(0)).toBe(MEMBER_COLORS[0])
    expect(memberColor(MEMBER_COLORS.length)).toBe(MEMBER_COLORS[0])
  })
  it('minutesInRange totals everyone, or one person', () => {
    const pts = [{ day: 'a', discordId: 'u1', minutes: 10 }, { day: 'a', discordId: 'u2', minutes: 5 }]
    expect(minutesInRange(pts)).toBe(15)
    expect(minutesInRange(pts, 'u2')).toBe(5)
  })
})

describe('snapshot math', () => {
  it('completionPercent is done over total, null with no tasks', () => {
    expect(completionPercent([task({ status: 'done' }), task({ status: 'closed' }), task({ status: 'open' }), task({ status: 'in_progress' })])).toBe(50)
    expect(completionPercent([])).toBeNull()
  })
  it('memberBreakdown counts only that person’s tasks', () => {
    const tasks = [
      task({ status: 'open', assignees: [{ discordId: 'u1', name: 'Ana' }] }),
      task({ status: 'in_progress', assignees: [{ discordId: 'u1', name: 'Ana' }, { discordId: 'u2', name: 'Ben' }] }),
      task({ status: 'resolved', assignees: [{ discordId: 'u2', name: 'Ben' }] }),
      task({ status: 'pending', assignees: [{ discordId: 'u1', name: 'Ana' }] }),
    ]
    expect(memberBreakdown('u1', tasks)).toEqual({ open: 2, inProgress: 1, done: 0 }) // pending counts as open
    expect(memberBreakdown('u2', tasks)).toEqual({ open: 0, inProgress: 1, done: 1 })
  })
  it('estimateSummary sums logged and estimate over tasks that have an estimate; null when none do', () => {
    expect(estimateSummary([task({ estimateMinutes: 120, timeLogged: 60 }), task({ estimateMinutes: null, timeLogged: 999 }), task({ estimateMinutes: 30 })]))
      .toEqual({ logged: 60, estimate: 150 })
    expect(estimateSummary([task({ timeLogged: 10 })])).toBeNull()
  })
})

describe('drawing helpers', () => {
  it('niceMax rounds up to a friendly axis maximum, never zero', () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(7)).toBe(8)
    expect(niceMax(23)).toBe(25)
    expect(niceMax(130)).toBe(150)
    expect(niceMax(1000)).toBe(1000)
  })
  it('linePath maps values across the width and inverts y', () => {
    expect(linePath([0, 10], 100, 50, 10)).toBe('M0,50 L100,0')
    expect(linePath([5], 100, 50, 10)).toBe('M0,25 L100,25')
    expect(linePath([], 100, 50, 10)).toBe('')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/screens/team/statsLogic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `statsLogic.ts`**

```ts
// Pure math for the Stats tab: range bounds, day/week bucketing, series
// filling and stacking, snapshot counts from the tasks payload, and the
// scale helpers the SVG charts draw with. No React, no DOM, no fetch.
import type { DayPoint, TimePoint } from '../../components/discordTasks/api'
import { isTerminal, type TaskRow } from '../tasksLogic'
import { weekRange } from './timeLogic'

export type RangeKind = '30d' | '90d' | 'all'
export type Bucket = 'day' | 'week'
export const RANGE_KINDS: { key: RangeKind; label: string }[] = [
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'all', label: 'All time' },
]

const pad = (n: number) => String(n).padStart(2, '0')
export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// 30 days reads day by day; anything longer is bucketed by week so the chart
// stays legible. `since` is local midnight N days back; null means all time.
export function rangeBounds(kind: RangeKind, now: Date): { since: Date | null; until: Date; bucket: Bucket } {
  if (kind === 'all') return { since: null, until: now, bucket: 'week' }
  const days = kind === '30d' ? 30 : 90
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 0, 0, 0, 0)
  return { since, until: now, bucket: kind === '30d' ? 'day' : 'week' }
}

// The Monday that starts the week a day belongs to, as a day key.
export const weekKeyOf = (key: string): string => dayKey(weekRange(parseDayKey(key)).since)

// Every day key from `since` up to (and including) the day containing
// `until`; or every Monday key for the weeks those days fall in.
export function bucketKeys(since: Date, until: Date, bucket: Bucket): string[] {
  const keys: string[] = []
  const last = dayKey(until)
  for (let d = new Date(since.getFullYear(), since.getMonth(), since.getDate()); ; d.setDate(d.getDate() + 1)) {
    const k = dayKey(d)
    if (k > last) break
    keys.push(bucket === 'week' ? weekKeyOf(k) : k)
  }
  return [...new Set(keys)]
}

export function rollup(points: DayPoint[], bucket: Bucket): DayPoint[] {
  if (bucket === 'day') return points
  const acc = new Map<string, number>()
  for (const p of points) {
    const k = weekKeyOf(p.day)
    acc.set(k, (acc.get(k) ?? 0) + p.n)
  }
  return [...acc.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, n]) => ({ day, n }))
}

export function fillSeries(points: DayPoint[], keys: string[]): number[] {
  const byKey = new Map(points.map((p) => [p.day, p.n]))
  return keys.map((k) => byKey.get(k) ?? 0)
}

export function cumulative(values: number[]): number[] {
  let total = 0
  return values.map((v) => (total += v))
}

// rows[keyIndex][memberIndex] = minutes. Members appear in the order they are
// first seen in the points, so the legend and the stack colours agree.
export function stackByMember(
  points: TimePoint[], keys: string[], bucket: Bucket, nameOf: (discordId: string) => string,
): { members: { discordId: string; name: string }[]; rows: number[][] } {
  const members: { discordId: string; name: string }[] = []
  const index = new Map<string, number>()
  const keyIndex = new Map(keys.map((k, i) => [k, i]))
  const rows = keys.map(() => [] as number[])
  for (const p of points) {
    if (!index.has(p.discordId)) { index.set(p.discordId, members.length); members.push({ discordId: p.discordId, name: nameOf(p.discordId) }) }
    const ki = keyIndex.get(bucket === 'week' ? weekKeyOf(p.day) : p.day)
    if (ki === undefined) continue
    const mi = index.get(p.discordId)!
    rows[ki][mi] = (rows[ki][mi] ?? 0) + p.minutes
  }
  for (const row of rows) for (let i = 0; i < members.length; i += 1) row[i] = row[i] ?? 0
  return { members, rows }
}

// Eight distinguishable hues that read on both the dark and light themes.
export const MEMBER_COLORS = ['#6366F1', '#10B981', '#F59E0B', '#0EA5E9', '#F43F5E', '#8B5CF6', '#14B8A6', '#F97316']
export const memberColor = (i: number): string => MEMBER_COLORS[i % MEMBER_COLORS.length]

export function minutesInRange(points: TimePoint[], discordId?: string | null): number {
  return points.reduce((n, p) => (discordId && p.discordId !== discordId ? n : n + p.minutes), 0)
}

export function completionPercent(tasks: TaskRow[]): number | null {
  if (!tasks.length) return null
  const done = tasks.filter((t) => isTerminal(t.status)).length
  return Math.round((done / tasks.length) * 100)
}

// "open" is everything that is neither in progress nor finished — open and
// pending both read as waiting to be picked up.
export function memberBreakdown(discordId: string, tasks: TaskRow[]): { open: number; inProgress: number; done: number } {
  const out = { open: 0, inProgress: 0, done: 0 }
  for (const t of tasks) {
    if (!t.assignees.some((a) => a.discordId === discordId)) continue
    if (isTerminal(t.status)) out.done += 1
    else if (t.status === 'in_progress') out.inProgress += 1
    else out.open += 1
  }
  return out
}

export function estimateSummary(tasks: TaskRow[]): { logged: number; estimate: number } | null {
  const withEstimate = tasks.filter((t) => typeof t.estimateMinutes === 'number' && t.estimateMinutes > 0)
  if (!withEstimate.length) return null
  return {
    logged: withEstimate.reduce((n, t) => n + (t.timeLogged ?? 0), 0),
    estimate: withEstimate.reduce((n, t) => n + (t.estimateMinutes ?? 0), 0),
  }
}

// A friendly axis ceiling: 1-2-2.5-5-10 steps, never 0.
export function niceMax(n: number): number {
  if (n <= 0) return 1
  const exp = Math.floor(Math.log10(n))
  const base = 10 ** exp
  for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= n) return m * base
  return 10 * base
}

// Values spread evenly across `w`, y inverted so `max` is the top. A single
// value draws a flat line across the full width.
export function linePath(values: number[], w: number, h: number, max: number): string {
  if (!values.length) return ''
  const step = values.length > 1 ? w / (values.length - 1) : w
  const pt = (v: number, i: number) => `${values.length > 1 ? Math.round(i * step * 100) / 100 : i * w},${Math.round((h - (v / max) * h) * 100) / 100}`
  if (values.length === 1) return `M0,${pt(values[0], 0).split(',')[1]} L${w},${pt(values[0], 0).split(',')[1]}`
  return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${pt(v, i)}`).join(' ')
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/screens/team/statsLogic.test.ts`
Expected: PASS. If `linePath` formatting differs, keep the assertions and fix the rounding: the expected strings use integers where the values are exact.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/screens/team/statsLogic.ts src/screens/team/statsLogic.test.ts
git commit -m "feat(team): pure stats logic — ranges, bucketing, stacking, snapshot math, scales

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Shared filter bar on every tab, Time tab reads it (site)

**Files:**
- Modify: `src/screens/team/TeamLayout.tsx`
- Modify: `src/screens/team/TimeTab.tsx`

**Interfaces:**
- Consumes: Task 4's fetch signatures and echoed `project` fields.
- Produces: `TeamContext` gains `timeSelfScoped: boolean` and `setTimeSelfScoped: (v: boolean) => void`; `people` now carries the roster (`{ id, name }` from `payload.members`).

- [ ] **Step 1: TeamLayout — context, roster-sourced people, per-tab controls**

In `TeamLayout.tsx`:

1. Replace the `applyFilters, assigneeOptions, DEFAULT_FILTERS` import with `applyFilters, DEFAULT_FILTERS` (drop `assigneeOptions`).
2. In `TeamContext` add:
```ts
  // Set by the Time and Stats tabs from their own response: true when the
  // server narrowed time data to the caller (no view_discord_time). The shell
  // uses it to hide the Assignee select on Time, where every other choice
  // would 403.
  timeSelfScoped: boolean
  setTimeSelfScoped: (v: boolean) => void
```
3. After the `filters` state add `const [timeSelfScoped, setTimeSelfScoped] = useState(false)`.
4. Replace `const people = useMemo(() => assigneeOptions(projects), [projects])` with:
```ts
  // The roster, not `assigneeOptions(projects)`: people log time on general
  // work and on tasks they are not assigned to, so a Time/Stats person filter
  // built from assignees would be missing people who have data. On Tasks, a
  // roster member with nothing assigned simply yields an empty list.
  const people = useMemo(
    () => [...(payload?.members ?? [])].map((m) => ({ id: m.discordId, name: m.name })).sort((a, b) => a.name.localeCompare(b.name)),
    [payload],
  )
```
5. Build the context with the two new fields: `const context: TeamContext = { payload, loading, error, refresh, filters, setFilter, people, timeSelfScoped, setTimeSelfScoped }`.
6. Above the JSX add:
```ts
  // Which of the shared controls apply on this tab. Status is a tasks-list
  // concept; search and Blocked-only act on the tasks payload, which the
  // Time and Stats tabs do not render.
  const taskControls = tab !== 'time' && tab !== 'stats'
  const showAssignee = !(tab === 'time' && timeSelfScoped)
```
7. Change the search box condition from `{tab !== 'time' && (` to `{taskControls && (`.
8. Replace the filter-bar wrapper condition `{tab !== 'time' && (` with an unconditional `<div className="flex flex-wrap items-center gap-3 mb-6">` (remove the outer `{tab !== 'time' && (` … `)}` pair around it) and update its comment to: `{/* Project and Assignee apply everywhere; the rest only where the tasks payload is what is on screen. */}`. Wrap the Assignee `FilterSelect` in `{showAssignee && (…)}` and the Blocked-only `<label>` in `{taskControls && (…)}`.
9. Change the error banner condition from `{tab !== 'time' && error && (` to `{taskControls && error && (`.

- [ ] **Step 2: TimeTab — read filters from context**

In `TimeTab.tsx`:

1. Remove the `FilterSelect` import. Change `const { payload } = useTeam()` to `const { payload, filters, setTimeSelfScoped } = useTeam()`.
2. Delete the `personId` state and the whole `members` memo (and its comment). Replace with:
```ts
  // Spec §5: a caller without view_discord_time only ever receives their own
  // data, so for them the person is always themselves — the shell hides the
  // Assignee select for them (timeSelfScoped) and this ignores the filter.
  // Under self scope with nothing logged, `people` is empty: then there is
  // no person to show, not a fallback to the filter — which would request
  // somebody else's entries and 403.
  const personId = data?.scope === 'self' ? (data.people[0]?.discordId ?? '') : (filters.assigneeId ?? '')
  const projectSlug = filters.projectSlug
```
3. In the report effect, change the call to `fetchTimeReport(range.since, range.until, projectSlug)` and its `.then` to `.then((report) => { if (!cancelled) { setData(report); setTimeSelfScoped(report.scope === 'self') } })`; add `projectSlug` and `setTimeSelfScoped` to the dependency array.
4. In the entries effect, change the call to `fetchTimeEntries(personId, range.since, range.until, projectSlug)` and add `projectSlug` to its dependency array.
5. Extend the `shown` guard with the project match:
```ts
  const shown = detail
    && detail.person.discordId === personId
    && detail.since === range.since.toISOString()
    && (detail.project ?? null) === (projectSlug ?? null)
    ? detail
    : null
```
6. Remove the `<FilterSelect label="Person" …>` element from the header row, leaving the Download CSV button (still guarded by `personId &&`).
7. Update the file's header comment: replace the paragraph starting "A second, independent fetch" through "see the `members` memo below." with:
```
// A second, independent fetch (GET /api/discord/time/entries) backs the
// per-person section: the shared Assignee filter (read from useTeam(), not
// a local select) pulls that person's raw entries for the same range, for
// the per-task breakdown, the entries list and the CSV export. The shared
// Project filter narrows both fetches server-side. When the report is
// self-scoped (the caller lacks view_discord_time) the person is always the
// caller, whatever the filter says, and the shell hides the select.
```

- [ ] **Step 3: Type-check and test**

Run: `npx tsc --noEmit && npm test`
Expected: clean; all pass. Common slip: `data.people[0]` — `people` is always an array on the payload type, so no optional chaining on `people` itself.

- [ ] **Step 4: Manual check**

Run `npm run dev`, open `/tools/team/time`: the Project and Assignee selects are in the shared bar, the search box and Blocked-only are absent on Time, picking a person shows the By task / Entries cards and enables Download CSV, picking a project changes the By person / By project cards, and the Tasks tab still shows all five controls. Note the result in the commit body.

- [ ] **Step 5: Commit**

```bash
git add src/screens/team/TeamLayout.tsx src/screens/team/TimeTab.tsx
git commit -m "feat(team): the Time tab follows the shared Project and Assignee filters

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: SVG chart components (site)

**Files:**
- Create: `src/screens/team/charts/Sparkline.tsx`, `Bars.tsx`, `StackedBars.tsx`, `CumulativeLines.tsx`

**Interfaces:**
- Consumes: `linePath`, `niceMax`, `memberColor` from `../statsLogic`; `Theme` from `../../../types`; `c`, `muted` from `../../../lib`.
- Produces:
  - `Sparkline({ values: number[]; theme; width?: number; height?: number })`
  - `Bars({ labels: string[]; values: number[]; theme; color?: string; format?: (n) => string; horizontal?: boolean; groups?: { name: string; values: number[]; color: string }[] })` — with `groups`, `values` is ignored and one bar per group per label is drawn.
  - `StackedBars({ labels: string[]; rows: number[][]; series: { name: string; color: string }[]; theme; format?: (n) => string })`
  - `CumulativeLines({ labels: string[]; a: { name: string; values: number[]; color: string }; b: { name: string; values: number[]; color: string }; theme })`
  - All render `<p>Nothing in this range</p>` (muted) when every value is 0.

- [ ] **Step 1: Shared bits and Sparkline**

Create `src/screens/team/charts/Sparkline.tsx`:

```tsx
import { linePath } from '../statsLogic'
import type { Theme } from '../../../types'

// A bare trend line for the overview cards: no axes, no labels, no hover.
export default function Sparkline({ values, theme, width = 120, height = 28 }: { values: number[]; theme: Theme; width?: number; height?: number }) {
  const max = Math.max(1, ...values)
  const d = linePath(values, width, height - 2, max)
  const stroke = theme === 'dark' ? '#818CF8' : '#4F46E5'
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="block">
      <g transform="translate(0,1)">
        <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      </g>
    </svg>
  )
}
```

Create `src/screens/team/charts/axes.ts` (tiny shared helpers, no React):

```ts
import type { Theme } from '../../../types'

export const CHART = { w: 560, h: 200, padL: 36, padR: 8, padT: 8, padB: 26 } as const
export const plotW = CHART.w - CHART.padL - CHART.padR
export const plotH = CHART.h - CHART.padT - CHART.padB

export const gridColor = (t: Theme) => (t === 'dark' ? 'rgba(255,255,255,0.08)' : '#E2E8F0')
export const textColor = (t: Theme) => (t === 'dark' ? 'rgba(255,255,255,0.45)' : '#94A3B8')

// Four y gridlines from 0 to max; and which x labels to print so they never
// overlap (at most ~7 across the width).
export const yTicks = (max: number) => [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)
export function xLabelIndexes(count: number, maxLabels = 7): number[] {
  if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i)
  const step = Math.ceil(count / maxLabels)
  return Array.from({ length: count }, (_, i) => i).filter((i) => i % step === 0)
}
// '2026-09-21' -> '21 Sep'
export function shortLabel(key: string): string {
  const [, m, d] = key.split('-').map(Number)
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`
}
```

- [ ] **Step 2: Bars**

Create `src/screens/team/charts/Bars.tsx`:

```tsx
import { useState } from 'react'
import { c, muted } from '../../../lib'
import type { Theme } from '../../../types'
import { niceMax } from '../statsLogic'
import { CHART, plotW, plotH, gridColor, textColor, yTicks, xLabelIndexes, shortLabel } from './axes'

interface Group { name: string; values: number[]; color: string }

// Vertical bars over time (one series, or grouped series side by side), or —
// with `horizontal` — one row per label, used for the per-member breakdown.
export default function Bars({ labels, values = [], theme, color, format = String, horizontal = false, groups, labelFormat = shortLabel }: {
  labels: string[]; values?: number[]; theme: Theme; color?: string; format?: (n: number) => string
  horizontal?: boolean; groups?: Group[]; labelFormat?: (label: string) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const series: Group[] = groups ?? [{ name: '', values, color: color ?? (theme === 'dark' ? '#818CF8' : '#4F46E5') }]
  const all = series.flatMap((s) => s.values)
  if (!all.some((v) => v > 0)) return <p className={c('text-xs font-medium m-0 py-6 text-center', muted(theme))}>Nothing in this range</p>
  const max = niceMax(Math.max(...all))

  if (horizontal) {
    const rowH = 22, gap = 6, barH = (rowH - 2) / series.length
    const h = labels.length * (rowH + gap)
    const labelW = 120
    const w = CHART.w
    const pw = w - labelW - 40
    return (
      <div>
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto block" role="img">
          {labels.map((label, i) => (
            <g key={label} transform={`translate(0,${i * (rowH + gap)})`}>
              <text x={labelW - 8} y={rowH / 2 + 4} textAnchor="end" fontSize={11} fontWeight={600} fill={textColor(theme)}>{label}</text>
              {series.map((s, si) => {
                const v = s.values[i] ?? 0
                const bw = (v / max) * pw
                return (
                  <g key={s.name}>
                    <rect x={labelW} y={1 + si * barH} width={bw} height={barH - 1} rx={2} fill={s.color} />
                    {v > 0 && <text x={labelW + bw + 4} y={1 + si * barH + barH - 2} fontSize={10} fill={textColor(theme)}>{format(v)}</text>}
                  </g>
                )
              })}
            </g>
          ))}
        </svg>
        {groups && <Legend series={series} theme={theme} />}
      </div>
    )
  }

  const n = labels.length
  const slot = plotW / Math.max(1, n)
  const barW = Math.max(2, (slot * 0.7) / series.length)
  const shown = xLabelIndexes(n)
  return (
    <div>
      <svg viewBox={`0 0 ${CHART.w} ${CHART.h}`} className="w-full h-auto block" role="img" onMouseLeave={() => setHover(null)}>
        <g transform={`translate(${CHART.padL},${CHART.padT})`}>
          {yTicks(max).map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW} y1={plotH - (t / max) * plotH} y2={plotH - (t / max) * plotH} stroke={gridColor(theme)} />
              <text x={-6} y={plotH - (t / max) * plotH + 3} textAnchor="end" fontSize={10} fill={textColor(theme)}>{format(t)}</text>
            </g>
          ))}
          {labels.map((label, i) => (
            <g key={label} transform={`translate(${i * slot},0)`} onMouseEnter={() => setHover(i)}>
              <rect x={0} y={0} width={slot} height={plotH} fill="transparent" />
              {series.map((s, si) => {
                const v = s.values[i] ?? 0
                const bh = (v / max) * plotH
                return <rect key={s.name} x={slot * 0.15 + si * barW} y={plotH - bh} width={barW} height={bh} rx={2} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.5} />
              })}
              {shown.includes(i) && <text x={slot / 2} y={plotH + 16} textAnchor="middle" fontSize={10} fill={textColor(theme)}>{labelFormat(label)}</text>}
            </g>
          ))}
          {hover !== null && (
            <g transform={`translate(${Math.min(plotW - 130, hover * slot)},0)`}>
              <rect x={0} y={0} width={130} height={14 + series.length * 14} rx={6} fill={theme === 'dark' ? '#0b1020' : '#fff'} stroke={gridColor(theme)} />
              <text x={8} y={12} fontSize={10} fontWeight={700} fill={textColor(theme)}>{labelFormat(labels[hover])}</text>
              {series.map((s, si) => (
                <text key={s.name} x={8} y={26 + si * 14} fontSize={10} fill={s.color}>{s.name ? `${s.name}: ` : ''}{format(s.values[hover] ?? 0)}</text>
              ))}
            </g>
          )}
        </g>
      </svg>
      {groups && <Legend series={series} theme={theme} />}
    </div>
  )
}

export function Legend({ series, theme }: { series: { name: string; color: string }[]; theme: Theme }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 m-0 p-0 list-none mt-2">
      {series.map((s) => (
        <li key={s.name} className={c('flex items-center gap-1.5 text-[11px] font-semibold', muted(theme))}>
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />{s.name}
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 3: StackedBars**

Create `src/screens/team/charts/StackedBars.tsx`:

```tsx
import { useState } from 'react'
import { c, muted } from '../../../lib'
import type { Theme } from '../../../types'
import { niceMax } from '../statsLogic'
import { CHART, plotW, plotH, gridColor, textColor, yTicks, xLabelIndexes, shortLabel } from './axes'
import { Legend } from './Bars'

// One bar per bucket, segmented by series (time per day, stacked by member).
// rows[bucket][series] = value.
export default function StackedBars({ labels, rows, series, theme, format = String }: {
  labels: string[]; rows: number[][]; series: { name: string; color: string }[]; theme: Theme; format?: (n: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const totals = rows.map((r) => r.reduce((n, v) => n + v, 0))
  if (!totals.some((v) => v > 0)) return <p className={c('text-xs font-medium m-0 py-6 text-center', muted(theme))}>Nothing in this range</p>
  const max = niceMax(Math.max(...totals))
  const n = labels.length
  const slot = plotW / Math.max(1, n)
  const barW = Math.max(2, slot * 0.7)
  const shown = xLabelIndexes(n)
  return (
    <div>
      <svg viewBox={`0 0 ${CHART.w} ${CHART.h}`} className="w-full h-auto block" role="img" onMouseLeave={() => setHover(null)}>
        <g transform={`translate(${CHART.padL},${CHART.padT})`}>
          {yTicks(max).map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW} y1={plotH - (t / max) * plotH} y2={plotH - (t / max) * plotH} stroke={gridColor(theme)} />
              <text x={-6} y={plotH - (t / max) * plotH + 3} textAnchor="end" fontSize={10} fill={textColor(theme)}>{format(t)}</text>
            </g>
          ))}
          {labels.map((label, i) => {
            let y = plotH
            return (
              <g key={label} transform={`translate(${i * slot},0)`} onMouseEnter={() => setHover(i)}>
                <rect x={0} y={0} width={slot} height={plotH} fill="transparent" />
                {series.map((s, si) => {
                  const v = rows[i]?.[si] ?? 0
                  const h = (v / max) * plotH
                  y -= h
                  return <rect key={s.name} x={slot * 0.15} y={y} width={barW} height={h} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.5} />
                })}
                {shown.includes(i) && <text x={slot / 2} y={plotH + 16} textAnchor="middle" fontSize={10} fill={textColor(theme)}>{shortLabel(label)}</text>}
              </g>
            )
          })}
          {hover !== null && (
            <g transform={`translate(${Math.min(plotW - 150, hover * slot)},0)`}>
              <rect x={0} y={0} width={150} height={28 + series.filter((_, si) => (rows[hover]?.[si] ?? 0) > 0).length * 14} rx={6} fill={theme === 'dark' ? '#0b1020' : '#fff'} stroke={gridColor(theme)} />
              <text x={8} y={12} fontSize={10} fontWeight={700} fill={textColor(theme)}>{shortLabel(labels[hover])} · {format(totals[hover])}</text>
              {series.filter((_, si) => (rows[hover]?.[si] ?? 0) > 0).map((s, k) => (
                <text key={s.name} x={8} y={26 + k * 14} fontSize={10} fill={s.color}>{s.name}: {format(rows[hover][series.indexOf(s)])}</text>
              ))}
            </g>
          )}
        </g>
      </svg>
      <Legend series={series} theme={theme} />
    </div>
  )
}
```

- [ ] **Step 4: CumulativeLines**

Create `src/screens/team/charts/CumulativeLines.tsx`:

```tsx
import { useState } from 'react'
import { c, muted } from '../../../lib'
import type { Theme } from '../../../types'
import { linePath, niceMax } from '../statsLogic'
import { CHART, plotW, plotH, gridColor, textColor, yTicks, xLabelIndexes, shortLabel } from './axes'
import { Legend } from './Bars'

interface Line { name: string; values: number[]; color: string }

// Two running totals on one axis (tasks created vs completed). Hover shows
// both values at that bucket.
export default function CumulativeLines({ labels, a, b, theme }: { labels: string[]; a: Line; b: Line; theme: Theme }) {
  const [hover, setHover] = useState<number | null>(null)
  const all = [...a.values, ...b.values]
  if (!all.some((v) => v > 0)) return <p className={c('text-xs font-medium m-0 py-6 text-center', muted(theme))}>Nothing in this range</p>
  const max = niceMax(Math.max(...all))
  const n = labels.length
  const step = n > 1 ? plotW / (n - 1) : plotW
  const shown = xLabelIndexes(n)
  const yOf = (v: number) => plotH - (v / max) * plotH
  return (
    <div>
      <svg viewBox={`0 0 ${CHART.w} ${CHART.h}`} className="w-full h-auto block" role="img" onMouseLeave={() => setHover(null)}>
        <g transform={`translate(${CHART.padL},${CHART.padT})`}>
          {yTicks(max).map((t) => (
            <g key={t}>
              <line x1={0} x2={plotW} y1={yOf(t)} y2={yOf(t)} stroke={gridColor(theme)} />
              <text x={-6} y={yOf(t) + 3} textAnchor="end" fontSize={10} fill={textColor(theme)}>{t}</text>
            </g>
          ))}
          <path d={linePath(a.values, plotW, plotH, max)} fill="none" stroke={a.color} strokeWidth={2} strokeLinejoin="round" />
          <path d={linePath(b.values, plotW, plotH, max)} fill="none" stroke={b.color} strokeWidth={2} strokeLinejoin="round" />
          {labels.map((label, i) => (
            <g key={label} onMouseEnter={() => setHover(i)}>
              <rect x={i * step - step / 2} y={0} width={step} height={plotH} fill="transparent" />
              {shown.includes(i) && <text x={i * step} y={plotH + 16} textAnchor="middle" fontSize={10} fill={textColor(theme)}>{shortLabel(label)}</text>}
            </g>
          ))}
          {hover !== null && (
            <g>
              <line x1={hover * step} x2={hover * step} y1={0} y2={plotH} stroke={gridColor(theme)} strokeDasharray="3 3" />
              <circle cx={hover * step} cy={yOf(a.values[hover] ?? 0)} r={3.5} fill={a.color} />
              <circle cx={hover * step} cy={yOf(b.values[hover] ?? 0)} r={3.5} fill={b.color} />
              <g transform={`translate(${Math.min(plotW - 140, Math.max(0, hover * step - 70))},0)`}>
                <rect x={0} y={0} width={140} height={42} rx={6} fill={theme === 'dark' ? '#0b1020' : '#fff'} stroke={gridColor(theme)} />
                <text x={8} y={12} fontSize={10} fontWeight={700} fill={textColor(theme)}>{shortLabel(labels[hover])}</text>
                <text x={8} y={26} fontSize={10} fill={a.color}>{a.name}: {a.values[hover] ?? 0}</text>
                <text x={8} y={38} fontSize={10} fill={b.color}>{b.name}: {b.values[hover] ?? 0}</text>
              </g>
            </g>
          )}
        </g>
      </svg>
      <Legend series={[a, b]} theme={theme} />
    </div>
  )
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: clean. (No test for the components themselves — the section has no component tests; the math they draw from is covered by Task 5.)

- [ ] **Step 6: Commit**

```bash
git add src/screens/team/charts/
git commit -m "feat(team): SVG chart components for the Stats tab

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The Stats tab (site)

**Files:**
- Create: `src/screens/team/Stats.tsx`
- Modify: `src/app/routes.tsx` (add the route)

**Interfaces:**
- Consumes: everything from Tasks 4–7; `useTeam()` (with `timeSelfScoped`/`setTimeSelfScoped`); `applyFilters`, `DEFAULT_FILTERS`, `allTasks`, `roleLabel`, `isTerminal`, `ProjectGroup`, `ProjectMember` from `../tasksLogic`; `formatDuration` from `./timeLogic`; `Avatar`, `AvatarStack` from `./Avatar`; `card`, `txt`, `muted`, `chipIndigo`, `chipMint`, `chipAmber`, `chipRed`, `chipGray` from `../../lib`.

- [ ] **Step 1: Add the route**

In `src/app/routes.tsx` add `import Stats from '../screens/team/Stats'` after the `TimeTab` import, and `<Route path="stats" element={<Stats />} />` after the `time` route.

- [ ] **Step 2: Create `Stats.tsx`**

```tsx
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { c, card, txt, muted, chipIndigo, chipAmber, chipRed, chipGray } from '../../lib'
import { useTheme } from '../../app/ThemeContext'
import type { Theme } from '../../types'
import { fetchProjectStats, type ProjectStats, type ProjectStatsPayload } from '../../components/discordTasks/api'
import { applyFilters, DEFAULT_FILTERS, isTerminal, roleLabel, type ProjectGroup, type ProjectMember } from '../tasksLogic'
import { formatDuration } from './timeLogic'
import {
  RANGE_KINDS, type RangeKind, rangeBounds, bucketKeys, rollup, fillSeries, cumulative, stackByMember, memberColor,
  completionPercent, memberBreakdown, estimateSummary, minutesInRange, parseDayKey,
} from './statsLogic'
import Avatar, { AvatarStack } from './Avatar'
import Sparkline from './charts/Sparkline'
import Bars from './charts/Bars'
import StackedBars from './charts/StackedBars'
import CumulativeLines from './charts/CumulativeLines'
import { useTeam } from './TeamLayout'

// The Stats tab. Two sources, deliberately:
//  - snapshot numbers (members, open/done counts, completion %, estimate vs
//    logged) come from the tasks payload TeamLayout already holds, scoped by
//    the Project filter exactly as People does, so they agree with the Tasks
//    tab under the same filter;
//  - time series (created / completed / events per bucket, time per bucket
//    per person), stale tasks and cycle time come from
//    GET /api/discord/projects/stats, fetched here with its own range,
//    loading and error state — the tasks payload caps activity at 15 events
//    per task and carries no per-day time at all.
// With no project selected the tab is an overview grid; clicking a card sets
// the Project filter and the same tab becomes that project's detail.

const STATUS = { open: '#F59E0B', inProgress: '#6366F1', done: '#10B981' }

export default function Stats() {
  const { theme } = useTheme()
  const d = theme === 'dark'
  const { payload, loading, filters, setFilter, setTimeSelfScoped } = useTeam()
  const [kind, setKind] = useState<RangeKind>('30d')
  const [series, setSeries] = useState<ProjectStatsPayload | null>(null)
  const [seriesLoading, setSeriesLoading] = useState(true)
  const [seriesError, setSeriesError] = useState<string | null>(null)

  // `now` is pinned per range change so the effect below and the bucket keys
  // agree on the same instant.
  const bounds = useMemo(() => rangeBounds(kind, new Date()), [kind])

  useEffect(() => {
    let cancelled = false
    setSeriesLoading(true)
    setSeriesError(null)
    fetchProjectStats(bounds.since, bounds.until, filters.projectSlug)
      .then((res) => { if (!cancelled) { setSeries(res); setTimeSelfScoped(res.timeScope === 'self') } })
      .catch((e) => { if (!cancelled) setSeriesError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setSeriesLoading(false) })
    return () => { cancelled = true }
  }, [bounds, filters.projectSlug, payload, setTimeSelfScoped])

  const projects = payload?.projects ?? []
  // Project filter only — never assignee/status/blocked — so the counts match
  // the Tasks tab (the same rule People.tsx applies).
  const scoped = useMemo(() => applyFilters(projects, { ...DEFAULT_FILTERS, projectSlug: filters.projectSlug }), [projects, filters.projectSlug])

  // A response is only "current" when it answers the filter on screen.
  const current = series && (series.project ?? null) === (filters.projectSlug ?? null) ? series : null
  const nameOf = useMemo(() => {
    const m = new Map((payload?.members ?? []).map((x) => [x.discordId, x.name]))
    return (id: string) => m.get(id) ?? `Member …${id.slice(-4)}`
  }, [payload])

  if (loading && !payload) {
    return (
      <div className={c(card(theme), 'rounded-2xl px-8 py-14 text-center')}>
        <p className={c('text-sm font-medium m-0', muted(theme))}>Loading…</p>
      </div>
    )
  }
  if (!payload) return null

  const selected = filters.projectSlug ? scoped.find((p) => p.docsSlug === filters.projectSlug) ?? null : null

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <p className={c('text-xs font-semibold m-0', muted(theme))}>
          {selected ? selected.name : `${scoped.length} project${scoped.length === 1 ? '' : 's'}`}
        </p>
        <div className={c('inline-flex rounded-xl p-0.5 border', d ? 'border-white/8 bg-white/4' : 'border-slate-200 bg-slate-50')} role="tablist" aria-label="Range">
          {RANGE_KINDS.map((r) => (
            <button key={r.key} type="button" role="tab" aria-selected={kind === r.key} onClick={() => setKind(r.key)}
              className={c('px-3 py-1.5 text-xs font-semibold rounded-lg tr',
                kind === r.key ? (d ? 'bg-indigo-500/25 text-indigo-200' : 'bg-white text-indigo-600 shadow-sm') : muted(theme))}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {current?.timeScope === 'self' && (
        <p className={c('text-xs font-medium mb-5', muted(theme))}>
          Time figures show your own hours only. Ask an admin for the view_discord_time permission to see the team&rsquo;s.
        </p>
      )}

      {seriesError && (
        <div className={c('rounded-xl px-4 py-3 mb-5 text-sm font-medium border', d ? 'bg-red-500/10 border-red-500/25 text-red-300' : 'bg-red-50 border-red-200 text-red-600')}>
          Could not load activity: {seriesError}
        </div>
      )}

      {filters.projectSlug && !selected ? (
        <div className={c(card(theme), 'rounded-2xl px-8 py-14 text-center')}>
          <p className={c('text-sm font-medium m-0', muted(theme))}>No tasks for this project yet.</p>
        </div>
      ) : selected ? (
        <ProjectDetail
          project={selected} stats={current?.projects.find((p) => p.id === selected.id) ?? null}
          approximate={current?.approximateCompletion ?? false} bounds={bounds} dim={seriesLoading && !!series}
          assigneeId={filters.assigneeId} nameOf={nameOf} theme={theme}
        />
      ) : scoped.length === 0 ? (
        <div className={c(card(theme), 'rounded-2xl px-8 py-14 text-center')}>
          <p className={c('text-sm font-medium m-0', muted(theme))}>No projects yet.</p>
        </div>
      ) : (
        <div className={c('grid gap-5 sm:grid-cols-2 xl:grid-cols-3 tr', seriesLoading && series ? 'opacity-50' : '')}>
          {scoped.map((p) => (
            <ProjectCard key={p.id ?? p.name} project={p} stats={current?.projects.find((s) => s.id === p.id) ?? null}
              bounds={bounds} onOpen={p.docsSlug ? () => setFilter({ projectSlug: p.docsSlug }) : null} theme={theme} />
          ))}
        </div>
      )}
    </>
  )
}

// ---- overview ---------------------------------------------------------------

function ProjectCard({ project, stats, bounds, onOpen, theme }: {
  project: ProjectGroup; stats: ProjectStats | null; bounds: ReturnType<typeof rangeBounds>; onOpen: (() => void) | null; theme: Theme
}) {
  const d = theme === 'dark'
  const pct = completionPercent(project.tasks)
  const lead = project.members.find((m) => m.role === 'lead')
  const keys = bucketKeys(bounds.since ?? earliestDay(stats) ?? bounds.until, bounds.until, bounds.bucket)
  const spark = fillSeries(rollup(stats?.events ?? [], bounds.bucket), keys)
  const minutes = stats ? minutesInRange(stats.time) : 0
  const header = (
    <>
      <div className="min-w-0">
        <h2 className={c('font-extrabold text-base m-0 truncate', txt(theme))}>{project.name}</h2>
        <p className={c('text-xs m-0 truncate', muted(theme))}>{lead ? `Lead: ${lead.name}` : `${project.members.length} member${project.members.length === 1 ? '' : 's'}`}</p>
      </div>
      <Ring pct={pct} theme={theme} />
    </>
  )
  const headerCls = 'text-left bg-transparent border-0 p-0 m-0 w-full flex items-start justify-between gap-3'
  return (
    <section className={c(card(theme), 'rounded-2xl p-5 flex flex-col gap-3 relative')}>
      {/* A project without a docsSlug cannot be selected (the filter is
          slug-keyed, the same limit the Project select has), so its header
          is plain rather than a button that does nothing. */}
      {onOpen
        ? <button type="button" onClick={onOpen} className={c(headerCls, 'cursor-pointer')}>{header}</button>
        : <div className={headerCls}>{header}</div>}
      <div className="flex items-center justify-between gap-3">
        <AvatarStack people={project.members} size={24} max={5} theme={theme} />
        <Sparkline values={spark} theme={theme} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <span className={c('text-[11px] font-semibold px-2.5 py-1 rounded-full', chipAmber(theme))}>{project.counts.open + project.counts.pending} open</span>
        {project.counts.blocked > 0 && <span className={c('text-[11px] font-semibold px-2.5 py-1 rounded-full', chipRed(theme))}>{project.counts.blocked} blocked</span>}
        {minutes > 0 && <span className={c('text-[11px] font-semibold px-2.5 py-1 rounded-full', chipIndigo(theme))}>{formatDuration(minutes)} logged</span>}
      </div>
      {project.docsSlug && (
        <Link to={`/tools/team/tasks?project=${encodeURIComponent(project.docsSlug)}`}
          className={c('text-xs font-semibold inline-flex items-center gap-1 no-underline mt-auto', d ? 'text-indigo-300' : 'text-indigo-600')}>
          View tasks <ArrowUpRight size={12} />
        </Link>
      )}
    </section>
  )
}

// The completion ring: a stroked circle with `pct` of its circumference drawn.
function Ring({ pct, theme, size = 44 }: { pct: number | null; theme: Theme; size?: number }) {
  const r = (size - 6) / 2
  const circ = 2 * Math.PI * r
  const track = theme === 'dark' ? 'rgba(255,255,255,0.1)' : '#E2E8F0'
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} title={pct === null ? 'No tasks' : `${pct}% done`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={4} />
        {pct !== null && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={STATUS.done} strokeWidth={4} strokeLinecap="round"
            strokeDasharray={`${(pct / 100) * circ} ${circ}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        )}
      </svg>
      <span className={c('absolute inset-0 flex items-center justify-center text-[10px] font-bold tabular-nums', pct === null ? muted(theme) : txt(theme))}>
        {pct === null ? '—' : `${pct}%`}
      </span>
    </div>
  )
}

// The first day any series has data — the lower bound for "all time".
function earliestDay(stats: ProjectStats | null): Date | null {
  if (!stats) return null
  const days = [...stats.created, ...stats.completed, ...stats.events].map((p) => p.day).concat(stats.time.map((t) => t.day)).sort()
  return days.length ? parseDayKey(days[0]) : null
}

// ---- detail -----------------------------------------------------------------

function ProjectDetail({ project, stats, approximate, bounds, dim, assigneeId, nameOf, theme }: {
  project: ProjectGroup; stats: ProjectStats | null; approximate: boolean; bounds: ReturnType<typeof rangeBounds>; dim: boolean
  assigneeId: string | null; nameOf: (id: string) => string; theme: Theme
}) {
  const d = theme === 'dark'
  const tasks = project.tasks
  const pct = completionPercent(tasks)
  const est = estimateSummary(tasks)
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length
  const done = tasks.filter((t) => isTerminal(t.status)).length
  const open = tasks.length - inProgress - done
  const blocked = tasks.filter((t) => t.isBlocked && !isTerminal(t.status)).length

  const keys = useMemo(() => bucketKeys(bounds.since ?? earliestDay(stats) ?? bounds.until, bounds.until, bounds.bucket), [bounds, stats])
  const created = cumulative(fillSeries(rollup(stats?.created ?? [], bounds.bucket), keys))
  const completed = cumulative(fillSeries(rollup(stats?.completed ?? [], bounds.bucket), keys))
  const events = fillSeries(rollup(stats?.events ?? [], bounds.bucket), keys)
  const timePoints = (stats?.time ?? []).filter((t) => !assigneeId || t.discordId === assigneeId)
  const stack = stackByMember(timePoints, keys, bounds.bucket, nameOf)

  const members: ProjectMember[] = (assigneeId ? project.members.filter((m) => m.discordId === assigneeId) : project.members)
  const rows = members
    .map((m) => ({ m, b: memberBreakdown(m.discordId, tasks), minutes: stats ? minutesInRange(stats.time, m.discordId) : 0 }))
    .sort((a, b) => b.b.open - a.b.open || a.m.name.localeCompare(b.m.name))

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 xl:grid-cols-7">
        <Kpi label="Completion" value={pct === null ? '—' : `${pct}%`} theme={theme} />
        <Kpi label="Open" value={String(open)} theme={theme} />
        <Kpi label="In progress" value={String(inProgress)} theme={theme} />
        <Kpi label="Blocked" value={String(blocked)} theme={theme} tone={blocked ? 'bad' : undefined} />
        <Kpi label="Done" value={String(done)} theme={theme} />
        <Kpi label="Estimate vs logged" value={est ? `${formatDuration(est.logged)} / ${formatDuration(est.estimate)}` : 'No estimates'} theme={theme}
          tone={est && est.logged > est.estimate ? 'bad' : undefined} />
        <Kpi label="Avg cycle time" value={stats?.cycleMinutes != null ? formatDuration(stats.cycleMinutes) ?? '—' : '—'} theme={theme} />
      </div>

      <Panel title="Members" theme={theme}>
        {rows.length === 0 ? (
          <p className={c('text-xs font-medium m-0 py-3', muted(theme))}>No members on this project.</p>
        ) : (
          <ul className={c('divide-y m-0 p-0 list-none', d ? 'divide-white/6' : 'divide-slate-100')}>
            {rows.map(({ m, b, minutes }) => {
              const total = b.open + b.inProgress + b.done
              return (
                <li key={m.discordId} className="py-3 flex items-center gap-3">
                  <Avatar person={m} size={32} theme={theme} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={c('text-sm font-semibold truncate', txt(theme))}>{m.name}</span>
                      {m.role && <span className={c('text-[10px] font-semibold px-2 py-0.5 rounded-full', chipGray(theme))}>{roleLabel(m.role)}</span>}
                    </div>
                    <div className={c('h-1.5 rounded-full overflow-hidden flex mt-1.5', d ? 'bg-white/8' : 'bg-slate-100')} title={`${b.open} open · ${b.inProgress} in progress · ${b.done} done`}>
                      {total > 0 && (
                        <>
                          <span style={{ width: `${(b.open / total) * 100}%`, background: STATUS.open }} />
                          <span style={{ width: `${(b.inProgress / total) * 100}%`, background: STATUS.inProgress }} />
                          <span style={{ width: `${(b.done / total) * 100}%`, background: STATUS.done }} />
                        </>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={c('text-xs font-bold m-0 tabular-nums', txt(theme))}>{b.open} · {b.inProgress} · {b.done}</p>
                    <p className={c('text-[11px] m-0 tabular-nums', muted(theme))}>{minutes > 0 ? formatDuration(minutes) : '0m'} in range</p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      <div className={c('grid gap-5 lg:grid-cols-2 tr', dim ? 'opacity-50' : '')}>
        <Panel title="Created vs completed" theme={theme}>
          <CumulativeLines labels={keys} theme={theme}
            a={{ name: 'Created', values: created, color: STATUS.inProgress }} b={{ name: 'Completed', values: completed, color: STATUS.done }} />
          {approximate && <p className={c('text-[11px] font-medium m-0 mt-2', muted(theme))}>Some completions predate activity logging and are dated by their last update.</p>}
        </Panel>
        <Panel title="Task activity" theme={theme}>
          <Bars labels={keys} values={events} theme={theme} />
        </Panel>
        <Panel title="Time logged" theme={theme}>
          <StackedBars labels={keys} rows={stack.rows} theme={theme} format={(n) => formatDuration(n) ?? '0m'}
            series={stack.members.map((m, i) => ({ name: m.name, color: memberColor(i) }))} />
        </Panel>
        <Panel title="Load by member" theme={theme}>
          <Bars horizontal theme={theme} labels={rows.map((r) => r.m.name)} labelFormat={(s) => s}
            groups={[
              { name: 'Open', color: STATUS.open, values: rows.map((r) => r.b.open) },
              { name: 'In progress', color: STATUS.inProgress, values: rows.map((r) => r.b.inProgress) },
              { name: 'Done', color: STATUS.done, values: rows.map((r) => r.b.done) },
            ]} />
        </Panel>
      </div>

      <Panel title="Stale tasks" theme={theme} hint="Open, with no activity for 14 days">
        {!stats || stats.stale.length === 0 ? (
          <p className={c('text-xs font-medium m-0 py-3', muted(theme))}>No stale tasks.</p>
        ) : (
          <ul className={c('divide-y m-0 p-0 list-none', d ? 'divide-white/6' : 'divide-slate-100')}>
            {stats.stale.map((s) => (
              <li key={s.taskId} className="py-2.5 flex items-center gap-3">
                <Link to={`/tools/team/tasks/${s.taskId}`} className={c('text-sm font-semibold flex-1 min-w-0 truncate no-underline', txt(theme))}>{s.title || 'Untitled task'}</Link>
                <span className={c('text-xs tabular-nums', muted(theme))}>{s.lastActivityAt ? `last touched ${new Date(s.lastActivityAt).toLocaleDateString()}` : 'never touched'}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

function Kpi({ label, value, theme, tone }: { label: string; value: string; theme: Theme; tone?: 'bad' }) {
  return (
    <div className={c(card(theme), 'rounded-2xl px-4 py-3')}>
      <p className={c('text-[11px] font-semibold m-0 uppercase tracking-wide', muted(theme))}>{label}</p>
      <p className={c('text-lg font-extrabold m-0 mt-0.5 tabular-nums truncate', tone === 'bad' ? (theme === 'dark' ? 'text-red-300' : 'text-red-600') : txt(theme))}>{value}</p>
    </div>
  )
}

function Panel({ title, hint, theme, children }: { title: string; hint?: string; theme: Theme; children: ReactNode }) {
  return (
    <section className={c(card(theme), 'rounded-2xl p-5')}>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h2 className={c('font-extrabold text-sm m-0', txt(theme))}>{title}</h2>
        {hint && <span className={c('text-[11px] font-medium', muted(theme))}>{hint}</span>}
      </div>
      {children}
    </section>
  )
}

```

- [ ] **Step 3: Type-check and test**

Run: `npx tsc --noEmit && npm test`
Expected: clean; all pass. `AvatarStack people={project.members}` type-checks because `ProjectMember` has `name` and `avatarUrl`, which satisfies `Person`.

- [ ] **Step 4: Manual check**

`npm run dev`, open `/tools/team/stats`:
- Overview grid: a card per project, rings show a percentage, sparkline draws, "View tasks" links to `/tools/team/tasks?project=…`, clicking a card sets the Project select and shows the detail.
- Detail: seven KPI tiles, the Members list with three-colour bars, four charts with hover tooltips, the Stale list. The 30 / 90 / All toggle refetches and re-buckets (90 and All show Monday labels). The Assignee select narrows Members, Load by member and Time logged.
- Both themes readable. Both Time and Stats tabs show only Project and Assignee in the bar.
Note the result in the commit body.

- [ ] **Step 5: Commit**

```bash
git add src/screens/team/Stats.tsx src/app/routes.tsx
git commit -m "feat(team): Stats tab — project overview, members, completion and activity graphs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Knowledge and state bookkeeping (bot repo, docs only)

**Files:**
- Modify: `.claude/knowledge/project-tasks-site.md`
- Modify: `.claude/state/backlog.md`, `.claude/state/completed.md`, `.claude/state/session.md`

- [ ] **Step 1: Knowledge**

Append to `.claude/knowledge/project-tasks-site.md`:

```markdown
## Stats tab and project-filtered time (2026-09-23)

- `GET /api/discord/projects/stats?since=&until=&project=` (CSAAS
  `discordProjectStats.js`) returns per-project, per-day sparse series: `created`,
  `completed`, `events`, `time` (per person), plus `stale` (open, 14 days idle, capped
  50) and `cycleMinutes`. Days are `DATE_FORMAT(col,'%Y-%m-%d')` strings of the STORED
  digits — the guild's local day only because the VM's zone matches the guild's.
  `since` omitted = all time. Time rows follow the report's scope rule (`timeScope`).
- `completed` comes from `taskactivity` rows with a `status` change to
  closed/done/resolved (`JSON_SEARCH` on `$[*].field`), reduced in JS. Terminal tasks
  with no such row (pre-migration-021) are dated by `updatedAt`; the response sets
  `approximateCompletion` and the tab prints a note.
- `timeScope.js` is the ONE home for verified-email → identity → scope → guild ids.
  All three time endpoints import it with their own `__hooks`.
- `/api/discord/time/report` and `/time/entries` accept `project=<docsSlug>` (a SQL
  subquery on `granjur.project.docsSlug`) and echo `project`.
- Site: the Team shell's Assignee options are the roster (`payload.members`), not task
  assignees. Time and Stats show only Project + Assignee. `TeamContext.timeSelfScoped`
  hides the Assignee select on Time for callers without `view_discord_time`.
- Charts are hand-rolled SVG in `src/screens/team/charts/`; all math is in
  `statsLogic.ts` (tested). No chart library.
```

- [ ] **Step 2: State**

Add a dated entry at the top of `completed.md` summarising the shipped work, commits and files per repo; remove any backlog item this covers; add to `backlog.md` under a "Stats follow-ups" heading: (a) bucket stats by the guild's timezone from CSAAS if the VM zone ever differs; (b) component tests for the charts if the section ever gains a DOM test environment. Rewrite `session.md` to say the work is complete and list the decisions above.

- [ ] **Step 3: Commit**

```bash
git add .claude/
git commit -m "docs(state): record the Stats tab and time-filter work

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** §3.1 → Task 6 step 1 (per-tab controls, roster Assignee, banner). §3.2 → Task 6 step 2 (self-scope, project on both fetches, `shown` guard). §3.3 → Task 4. §3.4 → Task 2 (clause, echo, empty on unknown slug — the subquery matches nothing, so the row set is empty). §4 → Task 3 (request, response, all six queries, fallback + flag, stale, cycle, `toMysqlUtc`, `soft` degrade). §4.4 → Task 1. §5.1 → Task 4 + Task 8 step 1. §5.2 → Task 8 (`applyFilters` project-only, own fetch keyed on range/project/payload, range toggle). §5.3 → `ProjectCard` (lead, avatar stack, ring, open/blocked, time, sparkline, click, View tasks, null-slug not clickable). §5.4 → `ProjectDetail` (KPI row incl. estimate + cycle, Members, four graphs, stale list). §5.5 → loading card, dim, error banner, per-chart empty text. §6 → Tasks 5 + 7. §7 → `timeScope` note on Stats, `setTimeSelfScoped` from both tabs. §8 → cancelled flags, echoed-project match, `soft`. §9 → tests in Tasks 1–5; `tsc` in 4–8. §10 → CSAAS tasks first. Docs → Task 9.

**Placeholders.** None: every code step carries the code. The one "fix if tsc objects" note in Task 8 names the exact alternative.

**Type consistency.** `fetchProjectStats(since: Date | null, until, projectSlug?)` (Task 4) matches its call in Task 8. `stackByMember(points, keys, bucket, nameOf)` (Task 5) matches Task 8. `Bars` props (`labels, values, groups, horizontal, labelFormat, format`) match Task 8's two uses. `Legend` is exported from `Bars.tsx` and imported by the other two charts. `resolveTimeScope({ req, decryptedPayload, hooks })` and `resolveCfgIds(identity, hooks)` are used identically in Tasks 1–3. `TimeReportPayload.project` / `TimeEntriesPayload.project` are added in Task 4 and read in Task 6.

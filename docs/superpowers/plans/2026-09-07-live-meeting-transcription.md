# Live Meeting Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a meeting is recorded, each person's speech appears as attributed text in that meeting's Discord channel, and that turn-by-turn transcript becomes the transcript CSAAS analyses.

**Architecture:** The bot segments each speaker's Discord voice stream into utterances at capture time (silence-delimited, wall-clock stamped), sends each to a new CSAAS endpoint for speech-to-text, and posts them to the meeting channel in capture order, grouped by speaker. At meeting end the pipeline sends the assembled transcript to the existing CSAAS `analyze-live` endpoint instead of uploading per-speaker whole files, falling back to the old path when the live transcript is too thin.

**Tech Stack:** Node 24 ESM (bot), CommonJS (CSAAS backend), discord.js v14, `@discordjs/voice`, `prism-media`, mysql2, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-07-live-meeting-transcription-design.md`

## Global Constraints

- **Bot source is ESM** (`import`/`export`, `"type": "module"`). **CSAAS backend is CommonJS** (`require`/`module.exports`). Never mix.
- **Tests are `node:test`, colocated as `*.test.js` next to the file under test.** Run with `npm test` from the repo root (bare `node --test`). The directory form `node --test bot/test/` FAILS on Windows — never use it.
- **Never run `prettier` in this repo.** There is no prettier config; it reformats against the established style (single quotes, no semicolons in newer files) and produces enormous spurious diffs. Match the style of the file you are editing.
- **Bot SQL table names are lowercase in queries** (`meeting`, `task`, `ticketdoc`). A mixed-case name in a query has already caused one production bug on a case-sensitive MySQL server. New tables use all-lowercase names.
- **`LIMIT` is never a bound `?` parameter** in bot SQL — MySQL prepared statements reject it. Inline a validated integer.
- **Bot migrations are guarded via `information_schema`** because MySQL lacks `ADD COLUMN IF NOT EXISTS`. Follow `bot/src/Database/migrations/014_task_external_meeting.sql`.
- **Every field a caller passes to an `update`/`create` DB function must appear in that function's SET/INSERT builder.** Silently-ignored fields have caused two production bugs in this repo (`taskUpdate` dropping `projectId`, `ticketDocCreate` writing to a non-existent table).
- **A Discord message body is at most 2000 characters.** Rendered transcript messages cap at 1800 to leave headroom.
- **CSAAS meeting-workflow endpoints are plaintext localhost** (`encryption: false`) and every request carries `actionPerformerURDD`.
- Constants, copied verbatim from the spec: utterance silence window **900 ms**; minimum utterance **500 ms**; utterance force-cut at **30 s**; flush cadence **6 s**; stall timeout **25 s**; speaker-grouping window **60 s**; message cap **1800** characters; live-path threshold **5** utterances with non-empty text; STT concurrency **3**.

---

## File Structure

**CSAAS (`/d/Work/Granjur Technologies/CSAAS_Backend`)**
- Create `data/migrations/20260907_1_meeting_utterances.sql` — the `meeting_utterances` table.
- Modify `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js` — `transcribeUtterance` handler, `global.MeetingWorkflowUtterance_object`, module export.
- Create `Services/SysScripts/TestScripts/meeting-test/utterance.test.js`.

**Bot (`d:\Work\Granjur Technologies\Granjur-Discord-Bot`)**
- Create `bot/src/Database/migrations/016_meeting_utterance.sql` — `meetingutterance` table + `meeting.csaasMeetingId` column.
- Modify `bot/src/Database/index.js` — `meetingUtterance` model, `meetingUpdate` gains `csaasMeetingId`.
- Modify `bot/src/services/csaasClient.js` — `transcribeUtterance`, `analyzeLive`.
- Create `bot/src/services/transcriptFeed.js` — ordering, grouping and rendering (pure) plus the live feed object.
- Create `bot/src/services/liveTranscriptPayload.js` — the `analyze-live` payload builder (pure).
- Modify `bot/src/services/voiceCapture.js` — per-utterance segmentation, CSAAS meeting created at start, feed lifecycle.
- Modify `bot/src/services/meetingPipelineStages.js` — `createdStage` reuse, `transcribingStage` live branch, `analyzingStage` guard.
- Create `bot/src/config/meetingGuidelines.js` — guidelines embed + idempotent pin helper.
- Modify `bot/src/commands/meeting-channel.js`, `bot/src/services/meetingAutoChannel.js`, `bot/src/commands/record.js` — pin the guidelines.

---

### Task 1: CSAAS utterance endpoint

**Files:**
- Create: `data/migrations/20260907_1_meeting_utterances.sql`
- Modify: `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js`
- Test: `Services/SysScripts/TestScripts/meeting-test/utterance.test.js`

All paths in this task are relative to the CSAAS checkout at `/d/Work/Granjur Technologies/CSAAS_Backend`.

**Interfaces:**
- Consumes: existing `transcribeSegment(buffer, originalName)` (`meetingWorkflow.js:7`), `requireMeetingPermission`, `executeQuery`, `step(handler, fields, method)` (`meetingWorkflow.js:65`).
- Produces: `POST /api/meeting/workflow/utterance`, returning `{ text: string, sequence: number }`. Multipart fields: `meeting_id`, `sequence`, `speaker_ref`, `speaker_name`, `started_at` (ISO), `duration_ms`, `actionPerformerURDD`, and the audio file.

- [ ] **Step 1: Write the migration**

Create `data/migrations/20260907_1_meeting_utterances.sql`. The directory's convention is `YYYYMMDD_N_description.sql`; `runMigrationsOnStart.js` applies each file once, tracked in the `schema_migrations` ledger by filename.

```sql
CREATE TABLE IF NOT EXISTS `meeting_utterances` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `meeting_id`   VARCHAR(64) NOT NULL,
  `sequence`     INT NOT NULL,
  `speaker_ref`  VARCHAR(64) DEFAULT NULL,
  `speaker_name` VARCHAR(190) DEFAULT NULL,
  `started_at`   DATETIME NOT NULL,
  `duration_ms`  INT NOT NULL DEFAULT 0,
  `text`         TEXT DEFAULT NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_meeting_utterance_seq` (`meeting_id`, `sequence`),
  KEY `idx_meeting_utterance_meeting` (`meeting_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
```

- [ ] **Step 2: Write the failing test**

Create `Services/SysScripts/TestScripts/meeting-test/utterance.test.js`. It exercises the handler directly with stubbed collaborators, the way `explainAgent.test.js` does.

```js
const assert = require("assert");

// The handler is exported from the module under test.
const { transcribeUtterance, __setTestHooks } = require(
  "../../../../Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow"
);

async function run() {
  const queries = [];
  __setTestHooks({
    executeQuery: async (sql, params) => { queries.push([sql, params]); return []; },
    transcribeSegment: async () => ({ text: "  let's start with booking  ", preview: "" }),
    requireMeetingPermission: async () => true,
  });

  const req = {
    body: {
      meeting_id: "m1", sequence: "7", speaker_ref: "u1",
      speaker_name: "Nauraiz", started_at: "2026-09-07T10:00:00.000Z", duration_ms: "1400",
    },
    files: [{ buffer: Buffer.from("x"), originalname: "u.ogg" }],
  };

  const out = await transcribeUtterance(req, {});
  assert.strictEqual(out.text, "let's start with booking", "text is trimmed");
  assert.strictEqual(out.sequence, 7, "sequence is returned as a number");
  assert.strictEqual(queries.length, 1, "one insert");
  assert.ok(/INSERT INTO meeting_utterances/.test(queries[0][0]));
  assert.ok(/ON DUPLICATE KEY UPDATE/.test(queries[0][0]), "retry-safe insert");
  assert.strictEqual(queries[0][1][0], "m1");
  assert.strictEqual(queries[0][1][1], 7);

  // Inaudible: STT returns nothing. The row is still written so the sequence
  // is accounted for, and empty text is returned.
  queries.length = 0;
  __setTestHooks({ transcribeSegment: async () => ({ text: "   ", preview: "" }) });
  const empty = await transcribeUtterance(req, {});
  assert.strictEqual(empty.text, "");
  assert.strictEqual(queries.length, 1, "inaudible still writes a row");

  // Missing audio is rejected before any STT call.
  await assert.rejects(
    () => transcribeUtterance({ body: { meeting_id: "m1" }, files: [] }, {}),
    /Audio file is required/
  );

  console.log("utterance.test.js OK");
}

run().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `node "Services/SysScripts/TestScripts/meeting-test/utterance.test.js"`
Expected: FAIL — `transcribeUtterance is not a function`.

- [ ] **Step 4: Add the test hook seam**

`meetingWorkflow.js` calls `executeQuery`, `transcribeSegment` and `requireMeetingPermission` as module-level bindings. Add a small indirection near the top of the file, immediately after the `transcribeSegment` definition (~line 12), so the test can substitute them without a DB:

```js
// Test seam: TestScripts substitute these three collaborators. Production code
// must call the hooks, not the imports directly, or the seam does nothing.
const __hooks = {
  executeQuery: (...a) => executeQuery(...a),
  transcribeSegment: (...a) => transcribeSegment(...a),
  requireMeetingPermission: (...a) => requireMeetingPermission(...a),
};
function __setTestHooks(overrides) { Object.assign(__hooks, overrides); }
```

Note `requireMeetingPermission` is defined later in the file; because `__hooks` members are arrow functions evaluated at call time, the late binding is fine.

- [ ] **Step 5: Write the handler**

Add next to `transcribeMeeting` (after it ends, ~line 498):

```js
// ─────────────────────────────────────────────────────────────────────────────
// 4b. TRANSCRIBE ONE UTTERANCE
// POST /api/meeting/workflow/utterance  (FormData: one speaker turn)
// Used by the Discord bot's live transcript feed. Each call is one speaker turn
// segmented at capture time, so the stored rows form a real conversation in
// `sequence` order — unlike /transcribe, which stores whole per-speaker files.
// ─────────────────────────────────────────────────────────────────────────────

async function transcribeUtterance(req, decryptedPayload) {
  const meetingId = req.body?.meeting_id || decryptedPayload?.meeting_id;
  await __hooks.requireMeetingPermission(req, decryptedPayload, "run_meeting_ai", meetingId);
  if (!meetingId) throw new Error("meeting_id is required");

  const audioFile = req.files?.[0] || req.file;
  if (!audioFile) throw new Error("Audio file is required");

  const sequence = parseInt(req.body?.sequence ?? decryptedPayload?.sequence ?? "0", 10);
  const speakerRef = req.body?.speaker_ref || decryptedPayload?.speaker_ref || null;
  const speakerName = req.body?.speaker_name || decryptedPayload?.speaker_name || null;
  const durationMs = parseInt(req.body?.duration_ms ?? decryptedPayload?.duration_ms ?? "0", 10);
  const startedAtRaw = req.body?.started_at || decryptedPayload?.started_at || null;
  const startedAt = startedAtRaw ? new Date(startedAtRaw) : new Date();

  // An STT failure throws: the bot marks that sequence failed and moves on.
  // An empty result is different — the turn was inaudible, so the row is still
  // written and the sequence stays accounted for.
  const result = await __hooks.transcribeSegment(audioFile.buffer, audioFile.originalname);
  const text = String(result?.text || "").trim();

  await __hooks.executeQuery(
    `INSERT INTO meeting_utterances
       (meeting_id, sequence, speaker_ref, speaker_name, started_at, duration_ms, text)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE text = VALUES(text), speaker_name = VALUES(speaker_name)`,
    [meetingId, sequence, speakerRef, speakerName, startedAt, durationMs, text]
  );

  return { text, sequence };
}
```

- [ ] **Step 6: Register the endpoint**

Add after `global.MeetingWorkflowTranscribe_object` (~line 1669). Multipart handlers take an empty `fields` array, exactly as `MeetingWorkflowTranscribe_object` does:

```js
global.MeetingWorkflowUtterance_object = {
  versions: { versionData: [{ "*": { steps: [step(transcribeUtterance, [])] } }] },
};
```

Add the route to the path-map comment block (~line 1618), directly under the `/transcribe` line:

```js
//   /api/meeting/workflow/utterance             → MeetingWorkflowUtterance_object
```

Add to the `module.exports` object (~line 1859), next to `MeetingWorkflowTranscribe_object`:

```js
  MeetingWorkflowUtterance_object,
```

and add `transcribeUtterance` and `__setTestHooks` alongside the existing `transcribeSegment` export (~line 1880).

- [ ] **Step 7: Run the test**

Run: `node "Services/SysScripts/TestScripts/meeting-test/utterance.test.js"`
Expected: PASS, printing `utterance.test.js OK`.

- [ ] **Step 8: Commit**

```bash
git add data/migrations/20260907_1_meeting_utterances.sql Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js Services/SysScripts/TestScripts/meeting-test/utterance.test.js
git commit -m "feat(meeting): per-utterance transcription endpoint"
```

---

### Task 2: Bot migration and utterance data layer

**Files:**
- Create: `bot/src/Database/migrations/016_meeting_utterance.sql`
- Modify: `bot/src/Database/index.js` (`meetingUpdate` ~L1320, model map ~L2033)
- Test: `bot/src/Database/meetingUtterance.test.js`

**Interfaces:**
- Consumes: the module-local `query`, `queryOne` and `id()` helpers already used by `meetingRecordingCreate` (`bot/src/Database/index.js:1400`).
- Produces, on the exported `db` object:
  - `db.meetingUtterance.create({ data: { guildConfigId, meetingId, sequence, speakerRef, speakerName, startedAt, durationMs, text } })` → the inserted row.
  - `db.meetingUtterance.findMany({ where: { meetingId } })` → rows ordered by `sequence` ascending.
  - `db.meetingUtterance.countWithText({ meetingId })` → `number`.
  - `db.meeting.update({ where: { id }, data: { csaasMeetingId } })` now persists `csaasMeetingId`.

- [ ] **Step 1: Write the migration**

Create `bot/src/Database/migrations/016_meeting_utterance.sql`. The table name is all-lowercase deliberately — a mixed-case name in a query has already broken on the case-sensitive production server.

```sql
-- One row per transcribed speaker turn in a meeting, in capture order.
-- Mirrors CSAAS `meeting_utterances`; this copy is what makes the pipeline
-- handoff restart-safe and lets a partial transcript survive a bot restart.

CREATE TABLE IF NOT EXISTS `meetingutterance` (
  `id`            VARCHAR(36) NOT NULL,
  `guildConfigId` VARCHAR(36) NOT NULL,
  `meetingId`     VARCHAR(36) NOT NULL,
  `sequence`      INT NOT NULL,
  `speakerRef`    VARCHAR(64) DEFAULT NULL,
  `speakerName`   VARCHAR(190) DEFAULT NULL,
  `startedAt`     DATETIME NOT NULL,
  `durationMs`    INT NOT NULL DEFAULT 0,
  `text`          TEXT DEFAULT NULL,
  `createdAt`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_meetingutterance_seq` (`meetingId`, `sequence`),
  KEY `idx_meetingutterance_meeting` (`meetingId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The CSAAS meeting is now created when recording starts, not when the pipeline
-- runs, so the live feed has a meeting_id to post utterances against.
SET @col_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meeting' AND COLUMN_NAME = 'csaasMeetingId');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `meeting` ADD COLUMN csaasMeetingId VARCHAR(64) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

- [ ] **Step 2: Write the failing test**

Create `bot/src/Database/meetingUtterance.test.js`. Following `taskExternal.test.js`, this asserts on generated SQL rather than hitting a database — the exported builders are pure enough to check that way. Export the three SQL builders from `index.js` for testability.

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  meetingUtteranceInsertSql,
  meetingUtteranceFindManySql,
  meetingUtteranceCountSql,
  meetingUpdateSql,
} from './index.js'

test('the insert names every column the caller can set', () => {
  const { sql } = meetingUtteranceInsertSql()
  for (const col of ['guildConfigId', 'meetingId', 'sequence', 'speakerRef', 'speakerName', 'startedAt', 'durationMs', 'text']) {
    assert.ok(sql.includes(col), `insert is missing ${col}`)
  }
  assert.ok(sql.includes('`meetingutterance`'), 'lowercase table name')
})

test('findMany orders by sequence so capture order is preserved', () => {
  const { sql, params } = meetingUtteranceFindManySql({ meetingId: 'm1' })
  assert.ok(/ORDER BY\s+`?sequence`?\s+ASC/i.test(sql), sql)
  assert.deepEqual(params, ['m1'])
})

test('countWithText ignores empty and whitespace-only rows', () => {
  const { sql, params } = meetingUtteranceCountSql({ meetingId: 'm1' })
  assert.ok(/COUNT\(\*\)/i.test(sql))
  assert.ok(/TRIM\(/i.test(sql), 'whitespace-only text must not count')
  assert.deepEqual(params, ['m1'])
})

test('meetingUpdate persists csaasMeetingId', () => {
  const { sets, vals } = meetingUpdateSql({ csaasMeetingId: 'csaas-9' })
  assert.deepEqual(sets, ['csaasMeetingId = ?'])
  assert.deepEqual(vals, ['csaas-9'])
})

test('meetingUpdate still persists transcript and notes', () => {
  const { sets } = meetingUpdateSql({ transcript: 't', notes: 'n' })
  assert.deepEqual(sets, ['transcript = ?', 'notes = ?'])
})
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npm test`
Expected: FAIL — the four builders are not exported.

- [ ] **Step 4: Extract `meetingUpdateSql` and add the `csaasMeetingId` branch**

In `bot/src/Database/index.js`, replace the body of `meetingUpdate` (~L1320) so the SET construction lives in an exported pure builder:

```js
export function meetingUpdateSql(data) {
  const sets = [];
  const vals = [];
  if (data.transcript !== undefined) { sets.push("transcript = ?"); vals.push(data.transcript); }
  if (data.notes !== undefined) { sets.push("notes = ?"); vals.push(data.notes); }
  if (data.csaasMeetingId !== undefined) { sets.push("csaasMeetingId = ?"); vals.push(data.csaasMeetingId); }
  return { sets, vals };
}

async function meetingUpdate({ where, data }) {
  const { sets, vals } = meetingUpdateSql(data);
  if (sets.length === 0)
    return queryOne("SELECT * FROM `meeting` WHERE id = ?", [where.id]);
  vals.push(where.id);
  await query(`UPDATE \`meeting\` SET ${sets.join(", ")} WHERE id = ?`, vals);
  return queryOne("SELECT * FROM `meeting` WHERE id = ?", [where.id]);
}
```

- [ ] **Step 5: Add the utterance model**

Add near `meetingRecordingCreate` (~L1400):

```js
export function meetingUtteranceInsertSql() {
  return {
    sql:
      "INSERT INTO `meetingutterance` " +
      "(id, guildConfigId, meetingId, `sequence`, speakerRef, speakerName, startedAt, durationMs, text) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON DUPLICATE KEY UPDATE text = VALUES(text), speakerName = VALUES(speakerName)",
  };
}

export function meetingUtteranceFindManySql({ meetingId }) {
  return {
    sql: "SELECT * FROM `meetingutterance` WHERE meetingId = ? ORDER BY `sequence` ASC",
    params: [meetingId],
  };
}

export function meetingUtteranceCountSql({ meetingId }) {
  return {
    sql: "SELECT COUNT(*) AS n FROM `meetingutterance` WHERE meetingId = ? AND text IS NOT NULL AND TRIM(text) <> ''",
    params: [meetingId],
  };
}

async function meetingUtteranceCreate({ data }) {
  const pk = id();
  const { sql } = meetingUtteranceInsertSql();
  await query(sql, [
    pk,
    data.guildConfigId,
    data.meetingId,
    data.sequence,
    data.speakerRef ?? null,
    data.speakerName ?? null,
    data.startedAt ?? new Date(),
    data.durationMs ?? 0,
    data.text ?? null,
  ]);
  return queryOne("SELECT * FROM `meetingutterance` WHERE id = ?", [pk]);
}

async function meetingUtteranceFindMany({ where }) {
  const { sql, params } = meetingUtteranceFindManySql({ meetingId: where.meetingId });
  return query(sql, params);
}

async function meetingUtteranceCountWithText({ meetingId }) {
  const { sql, params } = meetingUtteranceCountSql({ meetingId });
  const row = await queryOne(sql, params);
  return Number(row?.n || 0);
}
```

Register it on the exported `db` object next to `meetingRecording` (~L2045):

```js
  meetingUtterance: {
    create: meetingUtteranceCreate,
    findMany: meetingUtteranceFindMany,
    countWithText: meetingUtteranceCountWithText,
  },
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS — the five new assertions plus the existing suite.

- [ ] **Step 7: Commit**

```bash
git add bot/src/Database/migrations/016_meeting_utterance.sql bot/src/Database/index.js bot/src/Database/meetingUtterance.test.js
git commit -m "feat(db): meetingutterance table and meeting.csaasMeetingId"
```

---

### Task 3: CSAAS client methods

**Files:**
- Modify: `bot/src/services/csaasClient.js`
- Test: `bot/src/services/csaasClient.test.js`

**Interfaces:**
- Consumes: the endpoint from Task 1; the module-local `BASE()`, `URDD()`, `runFetch`, `parseBody`, `unwrap`, `postJson`, `CsaasError` already in the file.
- Produces:
  - `transcribeUtterance(meetingId, { buffer, filename, speakerRef, speakerName, startedAt, sequence, durationMs })` → `Promise<{ text: string, sequence: number }>`
  - `analyzeLive(meetingId, { meetingNotes, totalDurationSec })` → `Promise<object>` (the analysis blob)
  - `UTTERANCE_TIMEOUT_MS = 30_000`, `ANALYZE_LIVE_TIMEOUT_MS = 180_000`

- [ ] **Step 1: Write the failing test**

Append to `bot/src/services/csaasClient.test.js`:

```js
test('transcribeUtterance posts multipart with every field the endpoint reads', async () => {
  process.env.CSAAS_API_URL = 'http://localhost:9999/api'
  process.env.CSAAS_ACTOR_URDD = 'urdd-1'
  const seen = {}
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.url = String(url)
    seen.form = init.body
    return new Response(JSON.stringify({ status: 200, payload: { return: { text: 'hello', sequence: 4 } } }), { status: 200 })
  }
  try {
    const { transcribeUtterance } = await import('./csaasClient.js')
    const out = await transcribeUtterance('m1', {
      buffer: Buffer.from('abc'), filename: 'u.ogg', speakerRef: 'u1',
      speakerName: 'Nauraiz', startedAt: new Date('2026-09-07T10:00:00Z'),
      sequence: 4, durationMs: 1400,
    })
    assert.equal(out.text, 'hello')
    assert.equal(out.sequence, 4)
    assert.ok(seen.url.endsWith('/meeting/workflow/utterance'), seen.url)
    assert.equal(seen.form.get('meeting_id'), 'm1')
    assert.equal(seen.form.get('sequence'), '4')
    assert.equal(seen.form.get('speaker_ref'), 'u1')
    assert.equal(seen.form.get('speaker_name'), 'Nauraiz')
    assert.equal(seen.form.get('started_at'), '2026-09-07T10:00:00.000Z')
    assert.equal(seen.form.get('duration_ms'), '1400')
    assert.equal(seen.form.get('actionPerformerURDD'), 'urdd-1')
    assert.ok(seen.form.get('file'), 'audio blob is attached')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('analyzeLive sends the snake_case body analyze-live expects', async () => {
  process.env.CSAAS_API_URL = 'http://localhost:9999/api'
  process.env.CSAAS_ACTOR_URDD = 'urdd-1'
  let body = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body)
    return new Response(JSON.stringify({ status: 200, payload: { return: { summary: 'ok' } } }), { status: 200 })
  }
  try {
    const { analyzeLive } = await import('./csaasClient.js')
    const out = await analyzeLive('m1', {
      meetingNotes: { segment_0: { time_range: '00:00-05:00', transcription: 'A: hi' } },
      totalDurationSec: 300,
    })
    assert.equal(out.summary, 'ok')
    assert.equal(body.meeting_id, 'm1')
    assert.equal(body.total_duration_sec, 300)
    assert.equal(body.meeting_notes.segment_0.time_range, '00:00-05:00')
    assert.equal(body.actionPerformerURDD, 'urdd-1')
  } finally {
    globalThis.fetch = realFetch
  }
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test`
Expected: FAIL — `transcribeUtterance is not a function`.

- [ ] **Step 3: Implement both methods**

Append to `bot/src/services/csaasClient.js`, after the existing `transcribeSegment`:

```js
// One speaker turn: a short clip, so a much tighter ceiling than the 5-minute
// default. A turn that has not come back in 30 s is not worth waiting for —
// the feed skips its sequence at 25 s anyway.
export const UTTERANCE_TIMEOUT_MS = 30_000

export async function transcribeUtterance(meetingId, { buffer, filename, speakerRef, speakerName, startedAt, sequence, durationMs }) {
  const form = new FormData()
  form.append('meeting_id', String(meetingId))
  form.append('sequence', String(sequence))
  form.append('speaker_ref', String(speakerRef ?? ''))
  form.append('speaker_name', String(speakerName ?? ''))
  form.append('started_at', new Date(startedAt).toISOString())
  form.append('duration_ms', String(durationMs ?? 0))
  form.append('actionPerformerURDD', URDD())
  form.append('file', new Blob([buffer]), filename || `utterance-${sequence}.ogg`)
  const res = await runFetch(`${BASE()}/meeting/workflow/utterance`, { method: 'POST', body: form }, { timeoutMs: UTTERANCE_TIMEOUT_MS })
  const text = await res.text()
  const json = parseBody(text)
  if (!res.ok) throw new CsaasError(json?.message || text || res.statusText, res.status, json)
  const out = unwrap(json, res.status)
  return { text: String(out?.text ?? ''), sequence: Number(out?.sequence ?? sequence) }
}

// analyze-live stores the assembled transcript AND runs the Claude analysis in
// the same request, so it inherits /analyze's 30-90 s cost.
export const ANALYZE_LIVE_TIMEOUT_MS = 180_000

export const analyzeLive = (meetingId, { meetingNotes, totalDurationSec }) =>
  postJson('/meeting/workflow/analyze-live', {
    meeting_id: meetingId,
    meeting_notes: meetingNotes,
    total_duration_sec: totalDurationSec,
  }, { timeoutMs: ANALYZE_LIVE_TIMEOUT_MS })
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/csaasClient.js bot/src/services/csaasClient.test.js
git commit -m "feat(csaas): transcribeUtterance and analyzeLive client methods"
```

---

### Task 4: Transcript ordering, grouping and rendering (pure)

**Files:**
- Create: `bot/src/services/transcriptFeed.js`
- Test: `bot/src/services/transcriptFeed.test.js`

This task builds only the pure core. Task 5 adds the live object around it.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Constants `FLUSH_INTERVAL_MS = 6000`, `STALL_MS = 25000`, `GROUP_WINDOW_MS = 60000`, `MAX_MESSAGE_CHARS = 1800`, `MAX_CONCURRENT_STT = 3`.
  - `takeReady(pending, nextSeq, now, stallMs)` → `{ ready, next }`. `pending` is a `Map<number, Entry>`; `Entry` is `{ sequence, speakerRef, speakerName, startedAt, durationMs, text, status, enqueuedAt }` with `status` one of `'pending' | 'done' | 'failed'`. `ready` is the renderable entries (status `done` with non-empty text) from the contiguous consumable run; `next` is the new cursor.

**Sequences must be contiguous.** `takeReady` stops at the first missing sequence, so a permanent hole would stall the feed forever. The spec (§4) describes the counter as assigned at `speaking.start`; the counter is instead assigned in `feed.push` (Task 5), *after* the 500 ms minimum-duration gate, so a dropped short utterance never consumes a number. Every sequence that exists is therefore registered with the feed before its speech-to-text call begins. This is a deliberate refinement of the spec, not a deviation from its intent — do not "fix" it back.
  - `groupUtterances(entries, windowMs)` → `[{ speakerName, startedAt, texts: string[] }]`.
  - `renderBlocks(blocks, maxChars)` → `string[]`, each a ready-to-send Discord message body.

- [ ] **Step 1: Write the failing tests**

Create `bot/src/services/transcriptFeed.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  takeReady, groupUtterances, renderBlocks,
  STALL_MS, GROUP_WINDOW_MS, MAX_MESSAGE_CHARS,
} from './transcriptFeed.js'

const T0 = new Date('2026-09-07T10:00:00Z').getTime()
const entry = (sequence, over = {}) => ({
  sequence, speakerRef: 'u1', speakerName: 'Nauraiz',
  startedAt: new Date(T0 + sequence * 1000), durationMs: 900,
  text: `line ${sequence}`, status: 'done', enqueuedAt: T0, ...over,
})
const mapOf = (...es) => new Map(es.map((e) => [e.sequence, e]))

test('only a contiguous run is released, so order is never broken', () => {
  // 1 and 2 are done, 3 has not arrived, 4 is done but must wait behind 3.
  const pending = mapOf(entry(1), entry(2), entry(4))
  const { ready, next } = takeReady(pending, 1, T0 + 1000, STALL_MS)
  assert.deepEqual(ready.map((e) => e.sequence), [1, 2])
  assert.equal(next, 3)
})

test('out-of-order arrival still flushes in capture order', () => {
  const pending = mapOf(entry(2), entry(1))
  const { ready } = takeReady(pending, 1, T0 + 1000, STALL_MS)
  assert.deepEqual(ready.map((e) => e.sequence), [1, 2])
})

test('a stalled sequence is skipped once the timeout passes, not before', () => {
  const pending = mapOf(entry(1, { status: 'pending', text: '' }), entry(2))
  const early = takeReady(pending, 1, T0 + STALL_MS - 1, STALL_MS)
  assert.deepEqual(early.ready, [], 'nothing released while still within the window')
  assert.equal(early.next, 1, 'cursor does not move')

  const late = takeReady(pending, 1, T0 + STALL_MS, STALL_MS)
  assert.deepEqual(late.ready.map((e) => e.sequence), [2], 'the stalled turn is dropped, not rendered')
  assert.equal(late.next, 3)
})

test('failed and inaudible turns are consumed but never rendered', () => {
  const pending = mapOf(entry(1, { status: 'failed', text: '' }), entry(2, { text: '   ' }), entry(3))
  const { ready, next } = takeReady(pending, 1, T0 + 1000, STALL_MS)
  assert.deepEqual(ready.map((e) => e.sequence), [3])
  assert.equal(next, 4)
})

test('consecutive turns by one speaker merge into a single block', () => {
  const blocks = groupUtterances([entry(1), entry(2), entry(3, { speakerName: 'Adnan', speakerRef: 'u2' })], GROUP_WINDOW_MS)
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0].texts, ['line 1', 'line 2'])
  assert.equal(blocks[1].speakerName, 'Adnan')
})

test('a long gap starts a new block even for the same speaker', () => {
  const far = entry(2, { startedAt: new Date(T0 + GROUP_WINDOW_MS + 5000) })
  const blocks = groupUtterances([entry(1), far], GROUP_WINDOW_MS)
  assert.equal(blocks.length, 2, 'the 60s window bounds a block')
})

test('a block renders as a bold name, a viewer-local time and quoted lines', () => {
  const [msg] = renderBlocks(groupUtterances([entry(1)], GROUP_WINDOW_MS), MAX_MESSAGE_CHARS)
  assert.match(msg, /\*\*Nauraiz\*\*/)
  assert.match(msg, /<t:\d+:t>/, 'timestamp renders in each viewer\'s own timezone')
  assert.match(msg, /^> line 1$/m)
})

test('multi-line speech stays inside the quote block', () => {
  const [msg] = renderBlocks(groupUtterances([entry(1, { text: 'first\nsecond' })], GROUP_WINDOW_MS), MAX_MESSAGE_CHARS)
  assert.match(msg, /^> first$/m)
  assert.match(msg, /^> second$/m)
})

test('output is split into messages that always fit Discord', () => {
  const many = Array.from({ length: 40 }, (_, i) => entry(i + 1, { text: 'x'.repeat(200) }))
  const msgs = renderBlocks(groupUtterances(many, GROUP_WINDOW_MS), MAX_MESSAGE_CHARS)
  assert.ok(msgs.length > 1, 'it split')
  for (const m of msgs) assert.ok(m.length <= MAX_MESSAGE_CHARS, `message too long: ${m.length}`)
})

test('a single turn longer than the cap is split with the header repeated', () => {
  const msgs = renderBlocks(groupUtterances([entry(1, { text: 'y'.repeat(5000) })], GROUP_WINDOW_MS), MAX_MESSAGE_CHARS)
  assert.ok(msgs.length > 1)
  for (const m of msgs) {
    assert.ok(m.length <= MAX_MESSAGE_CHARS)
    assert.match(m, /\*\*Nauraiz\*\*/, 'every part says who is speaking')
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './transcriptFeed.js'`.

- [ ] **Step 3: Implement the pure core**

Create `bot/src/services/transcriptFeed.js`:

```js
/**
 * The live meeting transcript feed.
 *
 * Speech-to-text results come back out of order, so nothing is posted until the
 * turns ahead of it have landed: the feed only ever releases a contiguous run
 * starting at its cursor. A turn that never comes back is dropped after
 * STALL_MS so one slow call cannot freeze the feed behind it.
 *
 * This half is pure and fully tested. The live object lives below it.
 */

export const FLUSH_INTERVAL_MS = 6000
export const STALL_MS = 25000
export const GROUP_WINDOW_MS = 60000
export const MAX_MESSAGE_CHARS = 1800
export const MAX_CONCURRENT_STT = 3

const renderable = (e) => e.status === 'done' && String(e.text || '').trim() !== ''

/**
 * Release the longest contiguous run of consumable turns from `nextSeq`.
 * A turn is consumable when it has come back (done or failed) or has been
 * pending longer than `stallMs`. Only `done` turns with text are rendered;
 * the rest are consumed silently so the cursor keeps moving.
 */
export function takeReady(pending, nextSeq, now, stallMs = STALL_MS) {
  const ready = []
  let next = nextSeq
  for (;;) {
    const e = pending.get(next)
    if (!e) break
    const settled = e.status === 'done' || e.status === 'failed'
    const stalled = e.status === 'pending' && now - e.enqueuedAt >= stallMs
    if (!settled && !stalled) break
    if (renderable(e)) ready.push(e)
    next += 1
  }
  return { ready, next }
}

/** Consecutive turns by one speaker, close together in time, become one block. */
export function groupUtterances(entries, windowMs = GROUP_WINDOW_MS) {
  const blocks = []
  for (const e of entries) {
    const last = blocks[blocks.length - 1]
    const gap = last ? new Date(e.startedAt) - new Date(last.lastAt) : Infinity
    if (last && last.speakerRef === e.speakerRef && gap <= windowMs) {
      last.texts.push(String(e.text).trim())
      last.lastAt = e.startedAt
    } else {
      blocks.push({
        speakerRef: e.speakerRef,
        speakerName: e.speakerName || 'Unknown speaker',
        startedAt: e.startedAt,
        lastAt: e.startedAt,
        texts: [String(e.text).trim()],
      })
    }
  }
  return blocks
}

const header = (b) =>
  `**${b.speakerName}** · <t:${Math.floor(new Date(b.startedAt).getTime() / 1000)}:t>`

// Discord renders "> " as a quote; speech containing newlines has to quote each
// line or the block breaks halfway through.
const quote = (text) => text.split('\n').map((l) => `> ${l}`).join('\n')

/**
 * Render blocks into message bodies that each fit within `maxChars`.
 * A block too long on its own is split across messages, its header repeated so
 * every part still says who is speaking.
 */
export function renderBlocks(blocks, maxChars = MAX_MESSAGE_CHARS) {
  const messages = []
  let current = ''

  const push = (chunk) => {
    if (!current) current = chunk
    else if (current.length + 2 + chunk.length <= maxChars) current += `\n\n${chunk}`
    else { messages.push(current); current = chunk }
  }

  for (const b of blocks) {
    const head = header(b)
    const lines = quote(b.texts.join('\n')).split('\n')
    let part = head
    for (const line of lines) {
      // A single line longer than the budget is hard-split so it can never
      // exceed the cap on its own.
      let rest = line
      while (`${part}\n${rest}`.length > maxChars) {
        const room = maxChars - part.length - 1
        if (room <= 2) { push(part); part = head; continue }
        part += `\n${rest.slice(0, room)}`
        push(part)
        part = head
        rest = `> ${rest.slice(room)}`
      }
      part += `\n${rest}`
    }
    push(part)
  }

  if (current) messages.push(current)
  return messages
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS — all ten new tests.

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/transcriptFeed.js bot/src/services/transcriptFeed.test.js
git commit -m "feat(transcript): ordering, grouping and rendering core"
```

---

### Task 5: The live feed object

**Files:**
- Modify: `bot/src/services/transcriptFeed.js`
- Test: `bot/src/services/transcriptFeed.test.js`

**Interfaces:**
- Consumes: `takeReady`, `groupUtterances`, `renderBlocks` and the constants from Task 4; `db.meetingUtterance.create` from Task 2; `csaasClient.transcribeUtterance` from Task 3.
- Produces: `createTranscriptFeed({ db, csaasClient, channel, guildConfigId, meetingId, csaasMeetingId, logger })` → an object with:
  - `push({ speakerRef, speakerName, startedAt, durationMs, buffer })` → `number` (the assigned sequence) or `null` when the feed is degraded or stopped. This is where the sequence counter lives, so every number handed out belongs to an utterance that passed the duration gate and is registered before its speech-to-text call starts.
  - `drain()` → `Promise<void>`, resolving when every queued speech-to-text call has settled. Used by `stop()` and by the tests.
  - `flushOnce(now)` → `Promise<number>` (messages sent). Called by the interval, and directly by tests.
  - `start()` — posts the consent notice and starts the 6 s interval.
  - `stop()` — clears the interval, waits for in-flight speech-to-text, does a final flush.
  - `stats()` → `{ sequence, flushed, degraded, disabled }`.

- [ ] **Step 1: Write the failing tests**

Append to `bot/src/services/transcriptFeed.test.js`:

```js
import { createTranscriptFeed } from './transcriptFeed.js'

const fakeChannel = () => {
  const sent = []
  return { sent, isTextBased: () => true, send: async (m) => { sent.push(typeof m === 'string' ? m : m.content); return {} } }
}
const fakeDb = () => {
  const rows = []
  return { rows, meetingUtterance: { create: async ({ data }) => { rows.push(data); return data } } }
}

test('a transcribed turn reaches the channel and the database', async () => {
  const channel = fakeChannel()
  const db = fakeDb()
  const csaasClient = { transcribeUtterance: async (_m, o) => ({ text: 'hello there', sequence: o.sequence }) }
  const feed = createTranscriptFeed({ db, csaasClient, channel, guildConfigId: 'g', meetingId: 'm', csaasMeetingId: 'c' })

  feed.push({ speakerRef: 'u1', speakerName: 'Nauraiz', startedAt: new Date(T0), durationMs: 900, buffer: Buffer.from('a') })
  await feed.drain()
  const sentCount = await feed.flushOnce(T0 + 1000)

  assert.equal(sentCount, 1)
  assert.match(channel.sent[0], /\*\*Nauraiz\*\*/)
  assert.match(channel.sent[0], /> hello there/)
  assert.equal(db.rows.length, 1, 'the utterance is persisted')
  assert.equal(db.rows[0].meetingId, 'm')
  assert.equal(db.rows[0].sequence, 1)
})

test('sequences are contiguous, so the cursor never stalls on a gap', async () => {
  const feed = createTranscriptFeed({
    db: fakeDb(), channel: fakeChannel(), guildConfigId: 'g', meetingId: 'm', csaasMeetingId: 'c',
    csaasClient: { transcribeUtterance: async (_m, o) => ({ text: 't', sequence: o.sequence }) },
  })
  const a = feed.push({ speakerRef: 'u1', speakerName: 'A', startedAt: new Date(T0), durationMs: 900, buffer: Buffer.from('a') })
  const b = feed.push({ speakerRef: 'u1', speakerName: 'A', startedAt: new Date(T0 + 1000), durationMs: 900, buffer: Buffer.from('b') })
  assert.equal(a, 1)
  assert.equal(b, 2)
  await feed.drain()
})

test('repeated speech-to-text failures degrade the feed once, and recording continues', async () => {
  const channel = fakeChannel()
  const csaasClient = { transcribeUtterance: async () => { throw new Error('stt down') } }
  const feed = createTranscriptFeed({ db: fakeDb(), csaasClient, channel, guildConfigId: 'g', meetingId: 'm', csaasMeetingId: 'c' })

  for (let i = 0; i < 5; i++) {
    feed.push({ speakerRef: 'u1', speakerName: 'A', startedAt: new Date(T0 + i * 1000), durationMs: 900, buffer: Buffer.from('a') })
  }
  await feed.drain()
  await feed.flushOnce(T0 + STALL_MS + 1000)

  const warnings = channel.sent.filter((m) => /transcription/i.test(m) && /unavailable/i.test(m))
  assert.equal(warnings.length, 1, 'warned exactly once, not once per failure')
  assert.equal(feed.stats().degraded, true)
  assert.equal(feed.push({ speakerRef: 'u1', speakerName: 'A', startedAt: new Date(), durationMs: 900, buffer: Buffer.from('a') }), null)
})

test('a deleted channel disables the feed instead of throwing every flush', async () => {
  const channel = { isTextBased: () => true, send: async () => { throw new Error('Unknown Channel') } }
  const feed = createTranscriptFeed({
    db: fakeDb(), channel, guildConfigId: 'g', meetingId: 'm', csaasMeetingId: 'c',
    csaasClient: { transcribeUtterance: async (_m, o) => ({ text: 't', sequence: o.sequence }) },
  })
  feed.push({ speakerRef: 'u1', speakerName: 'A', startedAt: new Date(T0), durationMs: 900, buffer: Buffer.from('a') })
  await feed.drain()
  await feed.flushOnce(T0 + 1000)
  assert.equal(feed.stats().disabled, true)
  await feed.flushOnce(T0 + 2000) // must not throw
})

test('start posts the consent notice before any transcript', async () => {
  const channel = fakeChannel()
  const feed = createTranscriptFeed({
    db: fakeDb(), channel, guildConfigId: 'g', meetingId: 'm', csaasMeetingId: 'c',
    csaasClient: { transcribeUtterance: async (_m, o) => ({ text: 't', sequence: o.sequence }) },
  })
  await feed.start({ interval: false })
  assert.match(channel.sent[0], /transcrib/i)
  assert.match(channel.sent[0], /appear in this channel/i)
  feed.stop()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `createTranscriptFeed is not a function`.

- [ ] **Step 3: Implement the feed**

Append to `bot/src/services/transcriptFeed.js`:

```js
const CONSENT_NOTICE =
  '🎙️ **This meeting is being recorded and transcribed.** ' +
  'Everything said in the voice channel will appear in this channel as text.'

const DEGRADE_AFTER_FAILURES = 3

/**
 * The live feed. One per meeting.
 *
 * `push` is called from the voice capture loop for every accepted utterance and
 * returns immediately — the speech-to-text call runs in the background, at most
 * MAX_CONCURRENT_STT at a time. `flushOnce` posts whatever is releasable.
 */
export function createTranscriptFeed({
  db, csaasClient, channel, guildConfigId, meetingId, csaasMeetingId,
  logger = console,
}) {
  const pending = new Map()
  let sequence = 0
  let next = 1
  let flushed = 0
  let inFlight = 0
  let consecutiveFailures = 0
  let degraded = false
  let disabled = false
  let stopped = false
  let timer = null
  const queue = []
  const waiters = []

  const settle = () => {
    if (inFlight === 0 && queue.length === 0) {
      while (waiters.length) waiters.shift()()
    }
  }

  const pump = () => {
    while (inFlight < MAX_CONCURRENT_STT && queue.length) {
      const entry = queue.shift()
      inFlight += 1
      csaasClient
        .transcribeUtterance(csaasMeetingId, {
          buffer: entry.buffer,
          filename: `utterance-${entry.sequence}.ogg`,
          speakerRef: entry.speakerRef,
          speakerName: entry.speakerName,
          startedAt: entry.startedAt,
          sequence: entry.sequence,
          durationMs: entry.durationMs,
        })
        .then(async ({ text }) => {
          consecutiveFailures = 0
          entry.text = text
          entry.status = 'done'
          entry.buffer = null // release the audio as soon as it is transcribed
          try {
            await db.meetingUtterance.create({
              data: {
                guildConfigId, meetingId,
                sequence: entry.sequence,
                speakerRef: entry.speakerRef,
                speakerName: entry.speakerName,
                startedAt: entry.startedAt,
                durationMs: entry.durationMs,
                text,
              },
            })
          } catch (e) {
            logger.warn?.(`[transcriptFeed] persist failed for seq ${entry.sequence}: ${e?.message || e}`)
          }
        })
        .catch((e) => {
          entry.status = 'failed'
          entry.buffer = null
          consecutiveFailures += 1
          logger.warn?.(`[transcriptFeed] stt failed for seq ${entry.sequence}: ${e?.message || e}`)
          if (consecutiveFailures >= DEGRADE_AFTER_FAILURES) degraded = true
        })
        .finally(() => { inFlight -= 1; settle(); pump() })
    }
    settle()
  }

  const send = async (body) => {
    if (disabled) return false
    try {
      await channel.send({ content: body, allowedMentions: { parse: [] } })
      return true
    } catch (e) {
      // The channel is gone (or the bot lost access). Stop trying every 6 s.
      disabled = true
      logger.warn?.(`[transcriptFeed] channel send failed, disabling feed: ${e?.message || e}`)
      return false
    }
  }

  let warnedDegraded = false

  return {
    push({ speakerRef, speakerName, startedAt, durationMs, buffer }) {
      if (stopped || degraded || disabled) return null
      sequence += 1
      const entry = {
        sequence, speakerRef, speakerName, startedAt, durationMs, buffer,
        text: '', status: 'pending', enqueuedAt: Date.now(),
      }
      pending.set(sequence, entry)
      queue.push(entry)
      pump()
      return sequence
    },

    /** Resolves when every queued speech-to-text call has settled. */
    drain() {
      if (inFlight === 0 && queue.length === 0) return Promise.resolve()
      return new Promise((resolve) => waiters.push(resolve))
    },

    async flushOnce(now = Date.now()) {
      if (disabled) return 0
      if (degraded && !warnedDegraded) {
        warnedDegraded = true
        await send('⚠️ Live transcription is **unavailable** for the rest of this meeting. Recording continues, and the meeting will still be analysed afterwards.')
      }
      const { ready, next: cursor } = takeReady(pending, next, now, STALL_MS)
      for (let s = next; s < cursor; s++) pending.delete(s)
      next = cursor
      if (ready.length === 0) return 0
      const messages = renderBlocks(groupUtterances(ready, GROUP_WINDOW_MS), MAX_MESSAGE_CHARS)
      let sent = 0
      for (const body of messages) {
        if (await send(body)) { sent += 1; flushed += 1 }
      }
      return sent
    },

    async start({ interval = true } = {}) {
      await send(CONSENT_NOTICE)
      if (interval && !timer) {
        timer = setInterval(() => {
          this.flushOnce().catch((e) => logger.warn?.(`[transcriptFeed] flush failed: ${e?.message || e}`))
        }, FLUSH_INTERVAL_MS)
        timer.unref?.()
      }
    },

    async stop() {
      stopped = true
      if (timer) { clearInterval(timer); timer = null }
      await this.drain()
      // Everything settled, so release whatever is left regardless of the stall window.
      await this.flushOnce(Date.now() + STALL_MS + 1)
    },

    stats() { return { sequence, flushed, degraded, disabled } },
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/transcriptFeed.js bot/src/services/transcriptFeed.test.js
git commit -m "feat(transcript): live feed with backpressure and degradation"
```

---

### Task 6: Per-utterance capture in voiceCapture

**Files:**
- Modify: `bot/src/services/voiceCapture.js` (the `receiver.speaking.on("start")` handler ~L527-596; `endMeetingSession` ~L361; the ready-cue block ~L503)

**Interfaces:**
- Consumes: `createTranscriptFeed` (Task 5), `csaasClient.createMeeting` and `transcribeUtterance` (Task 3), `db.meeting.update({ data: { csaasMeetingId } })` (Task 2), `resolveMeetingChannel` (existing, `meetingPipelineStages.js:123`).
- Produces: nothing other modules import. The observable effects are `meeting.csaasMeetingId` being set at recording start and utterances flowing to the feed.

There is no unit test for this task — it is streaming glue over the Discord voice socket. It is verified on the live meeting in Task 10. Keep the diff tight and the existing behaviour byte-identical.

- [ ] **Step 1: Add the imports**

At the top of `bot/src/services/voiceCapture.js`, beside the existing imports:

```js
import * as csaasClient from "./csaasClient.js";
import { createTranscriptFeed } from "./transcriptFeed.js";
import { resolveMeetingChannel } from "./meetingPipelineStages.js";
```

- [ ] **Step 2: Create the CSAAS meeting at recording start**

Immediately after the ready-cue block (after the `[voiceCapture] Played ready-to-record audio cue` section, ~L525) and before `receiver.speaking.on("start"...)`, add:

```js
  // The live transcript needs a CSAAS meeting_id while the meeting is still
  // running. createdStage would only make one after the recording ends, so the
  // meeting is created here and createdStage reuses the id.
  let feed = null;
  if (csaasClient.isConfigured()) {
    try {
      const humans = voiceChannel.members.filter((m) => !m.user.bot).map((m) => m.displayName);
      const title = `${deriveMeetingName(recordingsDir, meetingId)} — ${formatMeetingDate(new Date())}`;
      const { meeting_id } = await csaasClient.createMeeting({ title, participants: humans });
      if (meeting_id) {
        await db.meeting.update({ where: { id: meetingId }, data: { csaasMeetingId: meeting_id } });
        const channel = await resolveMeetingChannel(guild.client, db, {
          meetingId, guildConfigId: cfg.id,
        });
        if (channel) {
          feed = createTranscriptFeed({
            db, csaasClient, channel,
            guildConfigId: cfg.id, meetingId, csaasMeetingId: meeting_id,
          });
          await feed.start();
          console.log(`[voiceCapture] Live transcript feed started for meeting ${meetingId}`);
        }
      }
    } catch (e) {
      // No live feed this meeting; recording and the existing pipeline are unaffected.
      feed = null;
      console.warn(`[voiceCapture] Live transcript unavailable: ${e?.message || e}`);
    }
  }
```

`deriveMeetingName` and `formatMeetingDate` come from `../commands/playback.js` — add that import next to the others.

- [ ] **Step 3: Replace the continuous subscription with per-utterance subscriptions**

Replace the whole `receiver.speaking.on("start", async (userId) => { ... })` handler. The per-speaker file and its `MeetingRecording` row must come out exactly as before, so the long-lived encoder stays; only the subscription changes.

```js
  // One long-lived encoder per speaker (the /playback artifact, unchanged), fed
  // by one short-lived subscription per utterance. Discord ends an AfterSilence
  // stream at the end of a turn and releases the user, so re-subscribing on the
  // next speaking.start is safe and gives us natural turn boundaries.
  const UTTERANCE_SILENCE_MS = 900;
  const MIN_UTTERANCE_MS = 500;
  const MAX_UTTERANCE_MS = 30000;
  const FRAME_MS = 20; // Opus frames from Discord are always 20 ms

  const speakerFor = async (userId) => {
    if (activeUserStreams.has(userId)) return activeUserStreams.get(userId);

    let userLabel = userId;
    try {
      const member = await db.guildMember.findUnique({
        where: { guildId_discordId: { guildId: guild.id, discordId: userId } },
      });
      if (member?.email) {
        userLabel = member.email.split("@")[0].replace(/[^a-z0-9._-]/gi, "_");
      }
    } catch (_) {}

    const fileName = `${userLabel}.ogg`;
    const filePath = path.join(recordingsDir, fileName);
    const oggEncoder = new OggOpusEncoder({ sampleRate: 48000, channels: 2 });
    const writeStream = fs.createWriteStream(filePath);
    const startedAt = new Date();

    oggEncoder.on("error", (err) => {
      console.error(`[voiceCapture] OGG encoder error for user ${userId}:`, err.message);
      writeStream.destroy();
    });
    writeStream.on("error", (err) => {
      console.error(`[voiceCapture] Write stream error for user ${userId}:`, err.message);
    });

    let resolveWrite;
    const writePromise = new Promise((resolve) => { resolveWrite = resolve; });
    pendingWrites.add(writePromise);

    const finalize = () => {
      finishRecording(userId, filePath, startedAt, new Date(), fileName)
        .catch(() => {})
        .finally(() => {
          pendingWrites.delete(writePromise);
          resolveWrite();
          activeUserStreams.delete(userId);
        });
    };
    writeStream.on("finish", finalize);

    oggEncoder.pipe(writeStream);

    let displayName = userId;
    try {
      displayName = (await guild.members.fetch(userId)).displayName;
    } catch (_) {}

    const speaker = { oggEncoder, writeStream, filePath, fileName, startedAt, writePromise, resolveWrite, displayName };
    activeUserStreams.set(userId, speaker);
    console.log(`[voiceCapture] Started recording user: ${userLabel} (${userId}) in meeting: ${meetingId}`);
    return speaker;
  };

  receiver.speaking.on("start", async (userId) => {
    const speaker = await speakerFor(userId);
    if (speaker.utteranceActive) return; // already capturing this turn
    speaker.utteranceActive = true;

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: UTTERANCE_SILENCE_MS },
    });
    speaker.opusStream = opusStream;

    const startedAt = new Date();
    const packets = [];
    let frames = 0;
    let cut = null;

    opusStream.on("error", (err) => {
      console.error(`[voiceCapture] Opus stream error for user ${userId}:`, err.message);
      try { opusStream.destroy(); } catch (_) {}
    });

    opusStream.on("data", (packet) => {
      frames += 1;
      // Keep the meeting file complete regardless of what happens to the feed.
      speaker.oggEncoder.write(packet);
      if (feed) packets.push(packet);
      if (frames * FRAME_MS >= MAX_UTTERANCE_MS && !cut) {
        // A monologue with no pause would otherwise never reach the feed.
        cut = true;
        try { opusStream.destroy(); } catch (_) {}
      }
    });

    const finishUtterance = () => {
      if (!speaker.utteranceActive) return;
      speaker.utteranceActive = false;
      speaker.opusStream = null;
      const durationMs = frames * FRAME_MS;
      if (!feed || packets.length === 0 || durationMs < MIN_UTTERANCE_MS) return;

      // A throwaway encoder turns this turn's packets into a small standalone OGG.
      const chunks = [];
      const enc = new OggOpusEncoder({ sampleRate: 48000, channels: 2 });
      enc.on("data", (c) => chunks.push(c));
      enc.on("end", () => {
        feed.push({
          speakerRef: userId,
          speakerName: speaker.displayName,
          startedAt,
          durationMs,
          buffer: Buffer.concat(chunks),
        });
      });
      enc.on("error", (err) => console.warn(`[voiceCapture] utterance encode failed: ${err.message}`));
      for (const p of packets) enc.write(p);
      enc.end();
    };

    opusStream.on("end", finishUtterance);
    opusStream.on("close", finishUtterance);
  });
```

- [ ] **Step 4: Update `endMeetingSession` for the new stream shape**

In `endMeetingSession` (~L361) the loop currently destroys `stream.opusStream` and ends `stream.oggEncoder`. `opusStream` is now per-utterance and may be absent. Replace that loop with:

```js
      // Stop the live feed before tearing the streams down, so its final flush
      // still has a channel to post to.
      if (feed) {
        try { await feed.stop(); } catch (e) { console.warn(`[voiceCapture] feed stop failed: ${e?.message || e}`); }
      }

      for (const [userId, speaker] of activeUserStreams) {
        console.log(`[voiceCapture] Ending stream for user ${userId}`);
        try { speaker.opusStream?.destroy(); } catch (_) {}
        try { speaker.oggEncoder.end(); } catch (_) {}
      }
```

`feed` is declared with `let` before `endMeetingSession` is defined, so hoisting is not an issue — but confirm the declaration sits above it. If `endMeetingSession` is defined earlier in the function than the feed setup, move the `let feed = null;` declaration up to sit beside `const activeUserStreams = new Map();`.

- [ ] **Step 5: Verify the suite still passes**

Run: `npm test`
Expected: PASS — no test covers this file directly; this confirms nothing else broke.

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/voiceCapture.js
git commit -m "feat(voice): per-utterance capture feeding the live transcript"
```

---

### Task 7: analyze-live payload builder

**Files:**
- Create: `bot/src/services/liveTranscriptPayload.js`
- Test: `bot/src/services/liveTranscriptPayload.test.js`

**Interfaces:**
- Consumes: rows from `db.meetingUtterance.findMany` — `{ sequence, speakerName, startedAt, durationMs, text }`.
- Produces: `buildAnalyzeLivePayload(utterances)` → `{ meetingNotes: Record<string, {time_range: string, transcription: string}>, totalDurationSec: number }`, and `SEGMENT_MS = 300000`.

- [ ] **Step 1: Write the failing test**

Create `bot/src/services/liveTranscriptPayload.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnalyzeLivePayload, SEGMENT_MS } from './liveTranscriptPayload.js'

const T0 = new Date('2026-09-07T10:00:00Z').getTime()
const u = (sequence, offsetMs, speakerName, text) => ({
  sequence, speakerName, text, durationMs: 1000,
  startedAt: new Date(T0 + offsetMs),
})

test('turns become Name: text lines in sequence order within a segment', () => {
  const { meetingNotes } = buildAnalyzeLivePayload([
    u(1, 0, 'Nauraiz', 'start with booking'),
    u(2, 4000, 'Adnan', 'the created date is wrong'),
  ])
  assert.deepEqual(Object.keys(meetingNotes), ['segment_0'])
  assert.equal(meetingNotes.segment_0.transcription, 'Nauraiz: start with booking\nAdnan: the created date is wrong')
  assert.equal(meetingNotes.segment_0.time_range, '00:00-05:00')
})

test('turns are bucketed into five-minute segments by their offset', () => {
  const { meetingNotes } = buildAnalyzeLivePayload([
    u(1, 0, 'A', 'one'),
    u(2, SEGMENT_MS + 1000, 'B', 'two'),
    u(3, 2 * SEGMENT_MS + 1000, 'C', 'three'),
  ])
  assert.deepEqual(Object.keys(meetingNotes), ['segment_0', 'segment_1', 'segment_2'])
  assert.equal(meetingNotes.segment_1.time_range, '05:00-10:00')
  assert.equal(meetingNotes.segment_2.transcription, 'C: three')
})

test('an empty segment in the middle is not emitted', () => {
  const { meetingNotes } = buildAnalyzeLivePayload([
    u(1, 0, 'A', 'one'),
    u(2, 2 * SEGMENT_MS + 1000, 'C', 'three'),
  ])
  assert.deepEqual(Object.keys(meetingNotes), ['segment_0', 'segment_2'])
})

test('empty and whitespace-only turns are dropped', () => {
  const { meetingNotes } = buildAnalyzeLivePayload([
    u(1, 0, 'A', '  '), u(2, 1000, 'B', 'real'), u(3, 2000, 'C', ''),
  ])
  assert.equal(meetingNotes.segment_0.transcription, 'B: real')
})

test('total duration spans first turn to the end of the last', () => {
  const { totalDurationSec } = buildAnalyzeLivePayload([u(1, 0, 'A', 'one'), u(2, 9000, 'B', 'two')])
  assert.equal(totalDurationSec, 10, '9s offset + the last turn\'s 1s')
})

test('no usable turns yields an empty payload rather than throwing', () => {
  const out = buildAnalyzeLivePayload([])
  assert.deepEqual(out.meetingNotes, {})
  assert.equal(out.totalDurationSec, 0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `bot/src/services/liveTranscriptPayload.js`:

```js
/**
 * Turn the bot's stored utterances into the `meeting_notes` structure that
 * CSAAS `analyze-live` consumes (see analyzeLive in meetingWorkflow.js).
 *
 * Segments are five-minute buckets measured from the first turn, which gives
 * the analysis agent the time structure it expects without the bot needing to
 * know when the meeting nominally started.
 */

export const SEGMENT_MS = 5 * 60 * 1000

const mmss = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function buildAnalyzeLivePayload(utterances) {
  const usable = (utterances || [])
    .filter((u) => String(u.text || '').trim() !== '')
    .slice()
    .sort((a, b) => a.sequence - b.sequence)

  if (usable.length === 0) return { meetingNotes: {}, totalDurationSec: 0 }

  const base = new Date(usable[0].startedAt).getTime()
  const buckets = new Map()
  let endMs = 0

  for (const u of usable) {
    const offset = Math.max(0, new Date(u.startedAt).getTime() - base)
    endMs = Math.max(endMs, offset + (Number(u.durationMs) || 0))
    const index = Math.floor(offset / SEGMENT_MS)
    if (!buckets.has(index)) buckets.set(index, [])
    buckets.get(index).push(`${u.speakerName || 'Unknown speaker'}: ${String(u.text).trim()}`)
  }

  const meetingNotes = {}
  for (const index of [...buckets.keys()].sort((a, b) => a - b)) {
    meetingNotes[`segment_${index}`] = {
      time_range: `${mmss(index * SEGMENT_MS)}-${mmss((index + 1) * SEGMENT_MS)}`,
      transcription: buckets.get(index).join('\n'),
    }
  }

  return { meetingNotes, totalDurationSec: Math.round(endMs / 1000) }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/liveTranscriptPayload.js bot/src/services/liveTranscriptPayload.test.js
git commit -m "feat(transcript): analyze-live payload builder"
```

---

### Task 8: Pipeline stages take the live path

**Files:**
- Modify: `bot/src/services/meetingPipelineStages.js` (`createdStage` ~L22, `transcribingStage` ~L58, `analyzingStage` ~L100)
- Test: `bot/src/services/meetingPipelineStages.test.js`

**Interfaces:**
- Consumes: `db.meetingUtterance.countWithText({ meetingId })` and `db.meetingUtterance.findMany({ where: { meetingId } })` (Task 2); `csaasClient.analyzeLive(meetingId, { meetingNotes, totalDurationSec })` (Task 3); `buildAnalyzeLivePayload` (Task 7); `db.meeting.findUnique` (existing).
- Produces: no new exports. Behaviour: `createdStage` reuses `meeting.csaasMeetingId`; `transcribingStage` writes `dataJson.liveTranscript = true` and `dataJson.analysis` when the live path is taken; `analyzingStage` skips when both are present.

- [ ] **Step 1: Write the failing tests**

Append to `bot/src/services/meetingPipelineStages.test.js`:

```js
test('created reuses the CSAAS meeting made when recording started', async () => {
  let created = false
  const db = {
    meeting: { findUnique: async () => ({ id: 'm', csaasMeetingId: 'csaas-existing' }) },
    meetingRecording: { findMany: async () => [{ filePath: '/r/abc-standup/a.ogg', startedAt: new Date('2026-09-07T10:00:00Z') }] },
    guildMember: { findMany: async () => [] },
  }
  const csaasClient = { createMeeting: async () => { created = true; return { meeting_id: 'csaas-new' } } }
  const client = { guilds: { fetch: async () => ({ id: 'g', members: { fetch: async () => ({}) } }) } }
  const out = await stageRunners.created({ job: { meetingId: 'm', guildConfigId: 'g' }, db, client, csaasClient })
  assert.equal(created, false, 'must not create a second CSAAS meeting')
  assert.equal(out.patch.csaasMeetingId, 'csaas-existing')
})

test('transcribing takes the live path when there are enough utterances', async () => {
  let uploaded = 0
  let liveArgs = null
  const db = {
    meetingUtterance: {
      countWithText: async () => 7,
      findMany: async () => ([
        { sequence: 1, speakerName: 'A', text: 'one', durationMs: 1000, startedAt: new Date('2026-09-07T10:00:00Z') },
        { sequence: 2, speakerName: 'B', text: 'two', durationMs: 1000, startedAt: new Date('2026-09-07T10:00:04Z') },
      ]),
    },
    meetingRecording: { findMany: async () => [{ id: 'r1', filePath: '/nope.ogg', fileName: 'a.ogg' }] },
  }
  const csaasClient = {
    transcribeSegment: async () => { uploaded += 1 },
    analyzeLive: async (mid, args) => { liveArgs = [mid, args]; return { summary: 'ok' } },
  }
  const job = { meetingId: 'm', csaasMeetingId: 'c', dataJson: {} }
  const out = await stageRunners.transcribing({ job, db, csaasClient })

  assert.equal(uploaded, 0, 'the whole-file path is skipped')
  assert.equal(liveArgs[0], 'c')
  assert.equal(liveArgs[1].meetingNotes.segment_0.transcription, 'A: one\nB: two')
  assert.equal(out.patch.dataJson.liveTranscript, true)
  assert.equal(out.patch.dataJson.analysis.summary, 'ok')
  assert.notEqual(out.advance, false, 'the stage completes in one tick')
})

test('too few utterances falls back to the whole-file upload', async () => {
  let uploaded = 0
  let liveCalled = false
  const db = {
    meetingUtterance: { countWithText: async () => 4, findMany: async () => [] },
    meetingRecording: { findMany: async () => [{ id: 'r1', filePath: '/nope.ogg', fileName: 'a.ogg' }] },
  }
  const csaasClient = {
    transcribeSegment: async () => { uploaded += 1 },
    analyzeLive: async () => { liveCalled = true; return {} },
  }
  const job = { meetingId: 'm', csaasMeetingId: 'c', dataJson: {} }
  await assert.rejects(
    () => stageRunners.transcribing({ job, db, csaasClient }),
    /all meeting recording files missing on disk/,
    'it really did run the old path (the fake file does not exist)'
  )
  assert.equal(liveCalled, false)
  assert.equal(uploaded, 0)
})

test('an analyze-live failure falls back rather than failing the meeting', async () => {
  const db = {
    meetingUtterance: {
      countWithText: async () => 9,
      findMany: async () => ([{ sequence: 1, speakerName: 'A', text: 'one', durationMs: 1000, startedAt: new Date() }]),
    },
    meetingRecording: { findMany: async () => [] },
  }
  const csaasClient = {
    transcribeSegment: async () => {},
    analyzeLive: async () => { throw new Error('csaas down') },
  }
  const job = { meetingId: 'm', csaasMeetingId: 'c', dataJson: {} }
  await assert.rejects(
    () => stageRunners.transcribing({ job, db, csaasClient }),
    /all meeting recording files missing on disk/,
    'fell through to the whole-file path, which then found no recordings'
  )
})

test('analyzing does not call CSAAS twice when the live path already analysed', async () => {
  let called = false
  const csaasClient = { analyze: async () => { called = true; return { analysis: {} } } }
  const job = { csaasMeetingId: 'c', dataJson: { liveTranscript: true, analysis: { summary: 'ok' } } }
  const out = await stageRunners.analyzing({ job, csaasClient, db: {} })
  assert.equal(called, false)
  assert.equal(out.patch.dataJson.analysis.summary, 'ok')
})

test('analyzing still calls CSAAS on the fallback path', async () => {
  let called = false
  const csaasClient = { analyze: async () => { called = true; return { analysis: { summary: 'from-analyze' } } } }
  const out = await stageRunners.analyzing({ job: { csaasMeetingId: 'c', dataJson: {} }, csaasClient, db: {} })
  assert.equal(called, true)
  assert.equal(out.patch.dataJson.analysis.summary, 'from-analyze')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `created` still calls `createMeeting`, `transcribing` has no live branch.

- [ ] **Step 3: Make `createdStage` reuse the stored id**

In `createdStage`, replace the `const { meeting_id } = await csaasClient.createMeeting({...})` call with:

```js
  // startMeetingRecording creates the CSAAS meeting so the live transcript has
  // somewhere to post. Only create one here when that did not happen.
  let meeting_id = meeting?.csaasMeetingId || null
  if (!meeting_id) {
    ;({ meeting_id } = await csaasClient.createMeeting({
      title,
      participants: roster.map((r) => r.displayName),
    }))
  }
```

- [ ] **Step 4: Add the live branch to `transcribingStage`**

Insert at the very top of `transcribingStage`, before the `meetingRecording.findMany` call:

```js
  // Live path: the bot transcribed each turn as it was spoken, so CSAAS gets a
  // real conversation instead of one whole file per speaker. analyze-live both
  // stores the transcript and runs the analysis, so `analyzing` then no-ops.
  const LIVE_MIN_UTTERANCES = 5
  try {
    const n = (await db.meetingUtterance?.countWithText?.({ meetingId: job.meetingId })) || 0
    if (n >= LIVE_MIN_UTTERANCES) {
      const rows = await db.meetingUtterance.findMany({ where: { meetingId: job.meetingId } })
      const { meetingNotes, totalDurationSec } = buildAnalyzeLivePayload(rows)
      const analysis = await csaasClient.analyzeLive(job.csaasMeetingId, { meetingNotes, totalDurationSec })
      return { patch: { dataJson: { ...(job.dataJson || {}), liveTranscript: true, analysis } } }
    }
  } catch (e) {
    // Anything wrong with the live path drops through to the whole-file upload
    // below — a meeting is never lost because live transcription misbehaved.
    console.warn(`[meetingPipeline] live transcript path failed, falling back: ${e?.message || e}`)
  }
```

Add the import at the top of the file:

```js
import { buildAnalyzeLivePayload } from './liveTranscriptPayload.js'
```

- [ ] **Step 5: Guard `analyzingStage`**

Replace the body of `analyzingStage`:

```js
async function analyzingStage({ job, csaasClient }) {
  const data = job.dataJson || {}
  // The live path already ran the analysis inside analyze-live.
  if (data.liveTranscript && data.analysis) return { patch: { dataJson: data } }
  const { analysis } = await csaasClient.analyze(job.csaasMeetingId)
  return { patch: { dataJson: { ...data, analysis } } }
}
```

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bot/src/services/meetingPipelineStages.js bot/src/services/meetingPipelineStages.test.js
git commit -m "feat(pipeline): analyse the live transcript, fall back to whole files"
```

---

### Task 9: Pinned meeting guidelines

**Files:**
- Create: `bot/src/config/meetingGuidelines.js`
- Test: `bot/src/config/meetingGuidelines.test.js`
- Modify: `bot/src/commands/meeting-channel.js` (after the text channel is created, ~L52), `bot/src/services/meetingAutoChannel.js` (after the text channel is created, ~L198), `bot/src/commands/record.js` (in the `start` branch, ~L45)

**Interfaces:**
- Consumes: `EmbedBuilder` from discord.js; `resolveMeetingChannel` (existing) in `record.js`.
- Produces:
  - `GUIDELINES_MARKER` — the exact footer string used to recognise an existing pin.
  - `buildGuidelinesEmbed()` → `EmbedBuilder`.
  - `findGuidelinesPin(messages, botUserId)` → the matching message or `null`. `messages` is any iterable of `{ author: { id }, embeds: [{ footer: { text } }] }`.
  - `ensureGuidelinesPinned(channel, botUserId)` → `Promise<boolean>` (true when it posted a new pin).

- [ ] **Step 1: Write the failing test**

Create `bot/src/config/meetingGuidelines.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGuidelinesEmbed, findGuidelinesPin, ensureGuidelinesPinned, GUIDELINES_MARKER } from './meetingGuidelines.js'

test('the embed explains transcription, the commands and the flow', () => {
  const json = buildGuidelinesEmbed().toJSON()
  const blob = JSON.stringify(json)
  assert.match(blob, /transcri/i, 'says the meeting is transcribed')
  for (const cmd of ['/record', '/schedule', '/meetings', '/meeting-channel', '/meeting-review', '/meeting-retry', '/playback']) {
    assert.ok(blob.includes(cmd), `missing ${cmd}`)
  }
  assert.equal(json.footer.text, GUIDELINES_MARKER)
})

test('an existing pin is recognised by marker and author', () => {
  const mine = { author: { id: 'bot' }, embeds: [{ footer: { text: GUIDELINES_MARKER } }] }
  const theirs = { author: { id: 'someone' }, embeds: [{ footer: { text: GUIDELINES_MARKER } }] }
  const other = { author: { id: 'bot' }, embeds: [{ footer: { text: 'something else' } }] }
  assert.equal(findGuidelinesPin([other, mine], 'bot'), mine)
  assert.equal(findGuidelinesPin([theirs, other], 'bot'), null)
  assert.equal(findGuidelinesPin([], 'bot'), null)
  assert.equal(findGuidelinesPin([{ author: { id: 'bot' }, embeds: [] }], 'bot'), null)
})

test('pinning is idempotent — a second call posts nothing', async () => {
  const pins = []
  const channel = {
    isTextBased: () => true,
    messages: { fetchPinned: async () => pins },
    send: async (payload) => {
      const msg = { author: { id: 'bot' }, embeds: payload.embeds.map((e) => e.toJSON()), pin: async () => { pins.push(msg) } }
      return msg
    },
  }
  assert.equal(await ensureGuidelinesPinned(channel, 'bot'), true)
  assert.equal(pins.length, 1)
  assert.equal(await ensureGuidelinesPinned(channel, 'bot'), false, 'second call is a no-op')
  assert.equal(pins.length, 1)
})

test('a channel that cannot be read never throws at a call site', async () => {
  const channel = {
    isTextBased: () => true,
    messages: { fetchPinned: async () => { throw new Error('Missing Access') } },
    send: async () => { throw new Error('Missing Permissions') },
  }
  assert.equal(await ensureGuidelinesPinned(channel, 'bot'), false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `bot/src/config/meetingGuidelines.js`:

```js
import { EmbedBuilder } from 'discord.js'

// The footer is how an already-pinned copy is recognised on a later call.
// Changing this string orphans every existing pin — don't.
export const GUIDELINES_MARKER = 'Granjur meeting guidelines'

export function buildGuidelinesEmbed() {
  return new EmbedBuilder()
    .setTitle('📋 How meetings work here')
    .setColor(0x5865f2)
    .setDescription(
      '**This channel receives a live transcript.** While the bot is recording, ' +
      'everything said in the voice channel appears here as text, attributed to ' +
      'whoever said it.',
    )
    .addFields(
      {
        name: 'Commands',
        value: [
          '`/record action:start` — start recording the voice channel you are in',
          '`/record action:stop` — stop recording and start the analysis',
          '`/schedule` — schedule a meeting; the bot creates the channels and joins',
          '`/meetings` — list scheduled meetings',
          '`/meeting-channel` — create a dedicated meeting voice + text channel',
          '`/meeting-review` — reopen the task review for a meeting',
          '`/meeting-retry` — retry a meeting whose processing failed',
          '`/playback` — play back a recorded meeting',
        ].join('\n'),
      },
      {
        name: 'The flow, start to end',
        value: [
          '**1.** The bot joins and plays a short cue — recording has started.',
          '**2.** The transcript appears here as people speak.',
          '**3.** Recording ends when the last person leaves (after a 2-minute grace period) or someone runs `/record action:stop`.',
          '**4.** The transcript is analysed and turned into proposed tasks.',
          '**5.** A review message posts here: check each task, set its assignee, approve or reject.',
          '**6.** On approval the tasks are created, each gets a private ticket channel, and assignees are notified.',
        ].join('\n'),
      },
    )
    .setFooter({ text: GUIDELINES_MARKER })
}

export function findGuidelinesPin(messages, botUserId) {
  for (const m of messages || []) {
    if (m?.author?.id !== botUserId) continue
    const hit = (m.embeds || []).some((e) => e?.footer?.text === GUIDELINES_MARKER)
    if (hit) return m
  }
  return null
}

/**
 * Post and pin the guidelines unless they are already pinned here.
 * Never throws: a missing permission must not take down channel creation or
 * `/record`, which is what actually matters at these call sites.
 */
export async function ensureGuidelinesPinned(channel, botUserId) {
  if (!channel?.isTextBased?.()) return false
  try {
    const pinned = await channel.messages.fetchPinned()
    if (findGuidelinesPin(pinned.values ? [...pinned.values()] : pinned, botUserId)) return false
    const msg = await channel.send({ embeds: [buildGuidelinesEmbed()] })
    await msg.pin()
    return true
  } catch (e) {
    console.warn(`[meetingGuidelines] could not pin guidelines: ${e?.message || e}`)
    return false
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Wire the three call sites**

`bot/src/commands/meeting-channel.js` — after `const textChannel = await guild.channels.create({...})` (~L52-58), add:

```js
  await ensureGuidelinesPinned(textChannel, guild.client.user.id)
```

with `import { ensureGuidelinesPinned } from '../config/meetingGuidelines.js'` at the top.

`bot/src/services/meetingAutoChannel.js` — after the `textChannel = await guild.channels.create({...})` assignment (~L198-205), add the same line, importing from `../config/meetingGuidelines.js`.

`bot/src/commands/record.js` — in the `start` branch, after `await startMeetingRecording(...)` (~L45), add:

```js
    // The channel the transcript and the review will land in gets the guidelines.
    const target = await resolveMeetingChannel(interaction.client, db, {
      meetingId: meetingChannel.meetingId,
      guildConfigId: meetingChannel.guildConfigId,
    })
    if (target) await ensureGuidelinesPinned(target, guild.client.user.id)
```

with imports for `ensureGuidelinesPinned`, `resolveMeetingChannel` (`../services/meetingPipelineStages.js`) and the default `db` export (`../db/index.js`).

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bot/src/config/meetingGuidelines.js bot/src/config/meetingGuidelines.test.js bot/src/commands/meeting-channel.js bot/src/services/meetingAutoChannel.js bot/src/commands/record.js
git commit -m "feat(meetings): pinned meeting guidelines in every meeting channel"
```

---

### Task 10: Deploy and verify on the live VM

**Files:** none — this task deploys and verifies what the previous nine built.

**Interfaces:**
- Consumes: everything above.
- Produces: a verified live meeting, and knowledge/state files updated per `CLAUDE.md`.

- [ ] **Step 1: Confirm the whole suite is green**

Run: `npm test`
Expected: PASS, with a count at or above the pre-existing 190 plus the new tests.

- [ ] **Step 2: Deploy CSAAS**

The VM runs `git reset --hard origin/main` on every push to `main` via `Deploy to Azure.yml`, and `runMigrationsOnStart.js` applies the new migration at boot. Push the CSAAS branch to `main`, then confirm on the VM:

```bash
pm2 logs csaas --lines 40 | grep -i "meeting_utterances"
```

Expected: the migration is reported applied (or already in the `schema_migrations` ledger).

- [ ] **Step 3: Deploy the bot**

On the VM:

```bash
cd /var/www/granjur-bot && git pull && npm run deploy:commands && pm2 restart granjur-bot
```

Expected: commands registered, bot online.

- [ ] **Step 4: Verify the pinned guidelines**

Run `/meeting-channel name:transcription-test` in Discord.
Expected: the new text channel opens with the guidelines embed pinned. Run it a second time in the same channel via `/record action:start` — expected: still exactly one pin, not two.

- [ ] **Step 5: Verify the live transcript**

Join the voice channel and run `/record action:start`. Two people speak, alternating, for about two minutes.

Expected, in order:
1. The consent notice posts before any transcript.
2. Within roughly 10 s of the first sentence, a message appears with the speaker's display name in bold, a timestamp, and the quoted text.
3. Speakers alternate correctly — no turn attributed to the wrong person.
4. Consecutive sentences by one speaker appear merged in a single block.

If turns are fragmented into many one-word messages, raise `UTTERANCE_SILENCE_MS` in `voiceCapture.js` from 900 to 1200 and restart; this is the tuning knob the spec flags in §12.

- [ ] **Step 6: Verify the pipeline took the live path**

Run `/record action:stop`, then on the VM:

```bash
pm2 logs granjur-bot --lines 80 | grep -iE "live transcript|meetingPipeline"
```

Expected: no `live transcript path failed` warning. Then check the job:

```sql
SELECT stage, JSON_EXTRACT(dataJson, '$.liveTranscript') AS live FROM meetingpipelinejob ORDER BY createdAt DESC LIMIT 1;
```

Expected: `live` is `true`, and the meeting reaches `awaiting_review` with a review message in the meeting channel.

- [ ] **Step 7: Confirm the transcript CSAAS stored is a conversation**

```sql
SELECT LEFT(transcript, 600) FROM meetings ORDER BY created_at DESC LIMIT 1;
```

Expected: alternating `Name: text` lines under `[00:00-05:00]` — not one `[Segment N]` block per speaker. This is the whole point of the feature; if it looks like the old shape, the fallback path ran.

- [ ] **Step 8: Update the memory system**

Per `CLAUDE.md`:
- Write `.claude/knowledge/live-meeting-transcription.md` covering the capture segmentation, the utterance endpoint, the feed's ordering rules, the live-vs-fallback pipeline branch, the tuning knobs, and the debug commands used in Steps 6-7. Add it to `.claude/knowledge/README.md`.
- Update `.claude/knowledge/meeting-audio-recording.md`: the per-speaker stream is now per-utterance, and the stored `.ogg` is still one file per speaker.
- Move the finished item into `.claude/state/completed.md` dated `2026-09-07`, with the commits.
- Add any tuning follow-ups found in Step 5 to `.claude/state/backlog.md`.

- [ ] **Step 9: Commit**

```bash
git add .claude/
git commit -m "docs: live meeting transcription knowledge and state"
```

# `/explain` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/explain` slash command where a verified member picks a project (or "no project") and asks a question; Claude answers from that project's documentation, on the VM, and every cited page links to the live docs site.

**Architecture:** Two repositories. CSAAS (`/var/www/CSAAS/CSAAS_Backend` on the VM, CommonJS, Jest) gains one endpoint that runs the Claude CLI inside the `UBS-Doc` clone with the working directory set to the project's docs folder and the writing/executing tools removed. The bot (this repo, ESM, `node:test`) gains a command, an autocomplete, a CSAAS client call, and a pure renderer. Scoping is the working directory, not the prompt.

**Tech Stack:** Node 24 ESM + discord.js v14 (bot); Node CommonJS + Express-style UBS framework + Jest 30 (CSAAS); Claude CLI via the existing `claudeClient`.

**Spec:** `docs/superpowers/specs/2026-09-04-explain-command-design.md`

## Global Constraints

- **Documentation only.** v1 reads `Repos/UBS-Doc/docs/…` and nothing else. No code repositories.
- **One-shot.** No session, no thread, no follow-up state anywhere.
- **Scoping is `cwd`.** Badar HMS → `Repos/UBS-Doc/docs/hms-documentation`; no project or no `docsPaths` → `Repos/UBS-Doc/docs`. Never a prompt instruction to ignore folders.
- **Tools removed, not merely disallowed by prompt:** `--disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch,Task`. `claudeClient` passes `--dangerously-skip-permissions` on every call, so an `--allowedTools` allowlist restricts nothing.
- **Do not add `--output-format json`.** `claudeClient` already passes `--output-format text`; the model's text is expected to be the JSON object itself.
- **Reference `path` in the response is relative to the docs root** (`Repos/UBS-Doc/docs`), never to the `cwd` Claude ran in.
- **References capped at 8** server-side, and again at render.
- **Non-JSON from the model is not an error:** retry once with a JSON-only nudge, then return the raw text as `answer` with empty references.
- **Public reply.** The answer is posted so the channel can see it, not ephemeral.
- **Discord limits:** embed title 256, embed description 4096 (we cap at 4000), field value 1024, autocomplete choice name 100, 25 choices, string option max length 500 enforced by Discord.
- **Bot tests:** `node:test`, colocated `*.test.js`, run with `npm test` (bare `node --test`; the directory form fails on Windows). Suite is at 159 passing before this plan.
- **CSAAS tests:** Jest, under `Services/SysScripts/TestScripts/`. Live-model tests are gated with `const maybe = process.env.CLAUDE_BACKEND ? test : test.skip`.
- **CSAAS deploy:** commits to CSAAS `main` are deployed by `Deploy to Azure.yml` doing `git reset --hard origin/main` on the VM. Never leave source changes as VM-local commits. Work in a clone, push to `main`.
- **CSAAS repo hygiene:** never commit `schema.sql` or anything under `data/migrations_completed/` — the running server rewrites those.
- **Bot deploy:** `git pull` on the VM at `~/Granjur-Discord-Bot`, `npm run deploy:commands` when a command's options change, `pm2 restart granjur-bot --update-env`.

---

## File map

**CSAAS** (`/var/www/CSAAS/CSAAS_Backend`)

| File | Responsibility |
|---|---|
| `Services/SysScripts/AgentScripts/claudeClient.js` | *modify* — `options.extraArgs` appended to CLI argv |
| `Services/SysScripts/AIScripts/explainAgent.js` | *new* — `resolveScope`, `EXPLAIN_SYSTEM_PROMPT`, `parseExplainResult`, `rebasePaths`, `refreshDocsClone`, `runExplain` |
| `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js` | *modify* — `explainDocs` handler + `MeetingWorkflowExplain_object` |
| `Services/SysScripts/TestScripts/meeting-test/claudeClientExtraArgs.test.js` | *new* |
| `Services/SysScripts/TestScripts/meeting-test/explainAgent.test.js` | *new* |

**Bot** (this repo)

| File | Responsibility |
|---|---|
| `bot/src/services/csaasClient.js` | *modify* — `postJson(path, body, { timeoutMs })`, `explain()` |
| `bot/src/services/csaasClient.test.js` | *modify* — `explain()` test |
| `bot/src/services/explainRender.js` | *new* — pure `buildExplainEmbed` |
| `bot/src/services/explainRender.test.js` | *new* |
| `bot/src/commands/explain.js` | *new* — command, `projectChoices` (pure), `autocomplete`, `execute` |
| `bot/src/commands/explain.test.js` | *new* — `projectChoices` |
| `bot/src/commands/index.js` | *modify* — register; `isPublicReplyCommand` |
| `bot/src/index.js` | *modify* — public defer for public-reply commands |
| `bot/src/config/command-config.json` | *modify* — roles, dedicated channel, description |
| `.claude/knowledge/explain.md` | *new* — how it scopes, where it runs, how to debug |

---

## CSAAS side

### Task 1: `extraArgs` passthrough in `claudeClient`

**Files:**
- Modify: `Services/SysScripts/AgentScripts/claudeClient.js` (the `args` assembly inside `chatViaLocalCli`, and the `chat` doc comment)
- Test: `Services/SysScripts/TestScripts/meeting-test/claudeClientExtraArgs.test.js`

**Interfaces:**
- Produces: `chat(messages, { system, max_tokens, cwd, model, extraArgs })` — `extraArgs: string[]` appended to the CLI argv **after** the output flags, only when provided.

Context: `chatViaLocalCli` builds `args` in two branches (`useStdin` true/false) and both end with `...outputFlags`. Today the only way to add CLI flags is the global `CLAUDE_CLI_ARGS_JSON` env var, which would apply to meeting analysis too.

- [ ] **Step 1: Write the failing test**

The test stubs `child_process.spawnSync` to capture argv. `claudeClient` calls `spawnSync(cli, runArgs, …)` inside `runOnce`; the stub returns a successful result so `chatViaLocalCli` returns normally.

```js
// Services/SysScripts/TestScripts/meeting-test/claudeClientExtraArgs.test.js
const path = require('path')

const CLIENT = path.resolve(__dirname, '../../AgentScripts/claudeClient.js')

function loadWithSpawnStub(captured) {
  jest.resetModules()
  jest.doMock('child_process', () => ({
    spawnSync: (cmd, args, opts) => {
      captured.push({ cmd, args, opts })
      return { status: 0, stdout: '{"ok":true}', stderr: '', error: null }
    },
  }))
  return require(CLIENT)
}

describe('claudeClient extraArgs', () => {
  const env = { ...process.env }
  beforeEach(() => {
    process.env.CLAUDE_BACKEND = 'cli'
    process.env.CLAUDE_CLI_USE_STDIN = 'true'
    delete process.env.CLAUDE_CLI_ARGS_JSON
  })
  afterEach(() => { process.env = { ...env } })

  test('extraArgs are appended after the output flags', async () => {
    const captured = []
    const { chat } = loadWithSpawnStub(captured)
    await chat([{ role: 'user', content: 'q' }], {
      system: 's',
      extraArgs: ['--disallowedTools', 'Write,Edit'],
    })
    const args = captured[0].args
    const i = args.indexOf('--disallowedTools')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('Write,Edit')
    // after the output flags, which come after "-p"
    expect(i).toBeGreaterThan(args.indexOf('--output-format'))
  })

  test('a call without extraArgs gets none', async () => {
    const captured = []
    const { chat } = loadWithSpawnStub(captured)
    await chat([{ role: 'user', content: 'q' }], { system: 's' })
    expect(captured[0].args).not.toContain('--disallowedTools')
  })

  test('cwd is passed to spawnSync', async () => {
    const captured = []
    const { chat } = loadWithSpawnStub(captured)
    await chat([{ role: 'user', content: 'q' }], { system: 's', cwd: '/tmp/somewhere' })
    expect(captured[0].opts.cwd).toBe('/tmp/somewhere')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run (in the CSAAS clone): `npx jest Services/SysScripts/TestScripts/meeting-test/claudeClientExtraArgs.test.js`
Expected: FAIL — `extraArgs are appended after the output flags` fails because `--disallowedTools` is not in argv (`i` is `-1`).

- [ ] **Step 3: Implement**

In `chatViaLocalCli`, immediately after `const outputFlags = getCliOutputFlags();` and the optional `--model` push, add:

```js
  // Per-call CLI flags. The global CLAUDE_CLI_ARGS_JSON template applies to every
  // caller; extraArgs lets one endpoint (e.g. /explain) restrict its own tools
  // without touching meeting analysis.
  const extraArgs = Array.isArray(options.extraArgs)
    ? options.extraArgs.filter((a) => typeof a === "string" && a.length > 0)
    : [];
```

Then change both argv assemblies:

```js
    args = [...baseArgs, ...outputFlags, ...extraArgs];
```
and
```js
      args = [...template.map((x) =>
        x === "__PROMPT__" || x === "__FILE__" ? promptArg : x
      ), ...outputFlags, ...extraArgs];
    } else {
      args = ["-p", promptArg, ...outputFlags, ...extraArgs];
    }
```

Update the `chat` JSDoc (above `async function chat`) to list `extraArgs`:

```js
/**
 * options: { system, max_tokens, cwd, model, extraArgs }
 *  - cwd:       working directory for the CLI (the model can read/search it)
 *  - extraArgs: string[] appended to the CLI argv after the output flags
 */
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest Services/SysScripts/TestScripts/meeting-test/claudeClientExtraArgs.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add Services/SysScripts/AgentScripts/claudeClient.js Services/SysScripts/TestScripts/meeting-test/claudeClientExtraArgs.test.js
git commit -m "feat(claudeClient): per-call extraArgs for the CLI backend"
```

---

### Task 2: `explainAgent.js` — scope, prompt, parse

**Files:**
- Create: `Services/SysScripts/AIScripts/explainAgent.js`
- Test: `Services/SysScripts/TestScripts/meeting-test/explainAgent.test.js`

**Interfaces:**
- Consumes: `chat(messages, options)` from `../AgentScripts/claudeClient` (Task 1 shape).
- Produces:
  - `DOCS_ROOT` — `path.resolve(process.cwd(), "Repos", "UBS-Doc", "docs")`
  - `resolveScope(project, { exists }) → { cwd, label, prefix }` — pure given an injected `exists(dir) → boolean`
  - `EXPLAIN_SYSTEM_PROMPT` — string, verbatim from spec §5
  - `parseExplainResult(text) → { answer, references } | null` — pure
  - `rebasePaths(references, prefix) → references` — pure
  - `refreshDocsClone({ now, minIntervalMs, run }) → boolean` — pulls at most every 15 min
  - `runExplain({ question, project }, deps?) → { answer, references, scope, model, durationMs }`

- [ ] **Step 1: Write the failing tests**

```js
// Services/SysScripts/TestScripts/meeting-test/explainAgent.test.js
const path = require('path')
const {
  DOCS_ROOT,
  resolveScope,
  parseExplainResult,
  rebasePaths,
  refreshDocsClone,
  runExplain,
  EXPLAIN_SYSTEM_PROMPT,
} = require('../../AIScripts/explainAgent')

describe('resolveScope', () => {
  const exists = (dir) => dir === path.join(DOCS_ROOT, 'hms-documentation')

  test('a project with docsPaths scopes to its first path', () => {
    const s = resolveScope({ name: 'Badar HMS', docsPaths: ['hms-documentation'] }, { exists })
    expect(s.cwd).toBe(path.join(DOCS_ROOT, 'hms-documentation'))
    expect(s.label).toBe('Badar HMS')
    expect(s.prefix).toBe('hms-documentation')
  })

  test('no project scopes to the docs root', () => {
    const s = resolveScope(null, { exists })
    expect(s.cwd).toBe(DOCS_ROOT)
    expect(s.label).toBe('All documentation')
    expect(s.prefix).toBe('')
  })

  test('a project without docsPaths scopes to the root and says so', () => {
    const s = resolveScope({ name: 'Framework', docsPaths: null }, { exists })
    expect(s.cwd).toBe(DOCS_ROOT)
    expect(s.label).toBe('All documentation')
  })

  test('a docsPath that does not exist on disk falls back to the root', () => {
    const s = resolveScope({ name: 'Ghost', docsPaths: ['nope'] }, { exists })
    expect(s.cwd).toBe(DOCS_ROOT)
    expect(s.label).toBe('All documentation')
    expect(s.prefix).toBe('')
  })

  test('a docsPath cannot escape the docs root', () => {
    const s = resolveScope({ name: 'Evil', docsPaths: ['../../etc'] }, { exists: () => true })
    expect(s.cwd).toBe(DOCS_ROOT)
  })
})

describe('parseExplainResult', () => {
  test('parses a bare JSON object', () => {
    const r = parseExplainResult('{"answer":"A","references":[{"path":"a.md","heading":"H","quote":"Q"}]}')
    expect(r.answer).toBe('A')
    expect(r.references).toEqual([{ path: 'a.md', heading: 'H', quote: 'Q' }])
  })

  test('parses JSON inside a code fence with prose around it', () => {
    const r = parseExplainResult('Sure.\n```json\n{"answer":"A","references":[]}\n```\nDone.')
    expect(r.answer).toBe('A')
  })

  test('drops references without a path and defaults the other fields', () => {
    const r = parseExplainResult('{"answer":"A","references":[{"heading":"x"},{"path":"b.md"}]}')
    expect(r.references).toEqual([{ path: 'b.md', heading: '', quote: '' }])
  })

  test('caps references at 8', () => {
    const refs = Array.from({ length: 12 }, (_, i) => ({ path: `p${i}.md` }))
    const r = parseExplainResult(JSON.stringify({ answer: 'A', references: refs }))
    expect(r.references).toHaveLength(8)
  })

  test('returns null for text that is not JSON', () => {
    expect(parseExplainResult('The docs say the window is 24 hours.')).toBeNull()
  })

  test('returns null for JSON without an answer', () => {
    expect(parseExplainResult('{"references":[]}')).toBeNull()
  })
})

describe('rebasePaths', () => {
  test('prefixes the docsPath and normalises leading ./', () => {
    expect(rebasePaths([{ path: './a/b.md', heading: '', quote: '' }], 'hms-documentation'))
      .toEqual([{ path: 'hms-documentation/a/b.md', heading: '', quote: '' }])
  })
  test('an empty prefix leaves paths alone', () => {
    expect(rebasePaths([{ path: 'init.md', heading: '', quote: '' }], ''))
      .toEqual([{ path: 'init.md', heading: '', quote: '' }])
  })
  test('a path that already carries the prefix is not doubled', () => {
    expect(rebasePaths([{ path: 'hms-documentation/x.md', heading: '', quote: '' }], 'hms-documentation'))
      .toEqual([{ path: 'hms-documentation/x.md', heading: '', quote: '' }])
  })
})

describe('refreshDocsClone', () => {
  test('pulls when never pulled, then not again within the interval', () => {
    const calls = []
    const run = () => calls.push('pull')
    const state = { lastPullAt: 0 }
    expect(refreshDocsClone({ now: 1_000_000, minIntervalMs: 900_000, run, state })).toBe(true)
    expect(refreshDocsClone({ now: 1_000_000 + 60_000, minIntervalMs: 900_000, run, state })).toBe(false)
    expect(refreshDocsClone({ now: 1_000_000 + 901_000, minIntervalMs: 900_000, run, state })).toBe(true)
    expect(calls).toHaveLength(2)
  })
  test('a failing pull is swallowed and the timestamp still advances', () => {
    const state = { lastPullAt: 0 }
    const run = () => { throw new Error('no network') }
    expect(refreshDocsClone({ now: 5, minIntervalMs: 1, run, state })).toBe(false)
    expect(state.lastPullAt).toBe(5)
  })
})

describe('runExplain', () => {
  const okDeps = (text) => ({
    chat: jest.fn(async () => ({ text, model: 'm', usage: null })),
    exists: () => true,
    refresh: () => true,
  })

  test('happy path returns the parsed answer with rebased paths and the scope', async () => {
    const deps = okDeps('{"answer":"A","references":[{"path":"a.md","heading":"H","quote":"Q"}]}')
    const out = await runExplain(
      { question: 'q?', project: { name: 'Badar HMS', docsPaths: ['hms-documentation'] } },
      deps,
    )
    expect(out.answer).toBe('A')
    expect(out.references[0].path).toBe('hms-documentation/a.md')
    expect(out.scope).toBe('Badar HMS')
    expect(typeof out.durationMs).toBe('number')
    const [, options] = deps.chat.mock.calls[0]
    expect(options.cwd).toBe(path.join(DOCS_ROOT, 'hms-documentation'))
    expect(options.system).toBe(EXPLAIN_SYSTEM_PROMPT)
    expect(options.extraArgs).toEqual([
      '--disallowedTools', 'Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch,Task',
    ])
  })

  test('non-JSON is retried once with a JSON-only nudge', async () => {
    const chat = jest.fn()
      .mockResolvedValueOnce({ text: 'prose', model: 'm' })
      .mockResolvedValueOnce({ text: '{"answer":"A","references":[]}', model: 'm' })
    const out = await runExplain({ question: 'q?', project: null }, { chat, exists: () => true, refresh: () => true })
    expect(out.answer).toBe('A')
    expect(chat).toHaveBeenCalledTimes(2)
    const secondUser = chat.mock.calls[1][0][0].content
    expect(secondUser).toMatch(/Respond with the JSON object only/)
  })

  test('non-JSON twice returns the raw text as the answer', async () => {
    const chat = jest.fn(async () => ({ text: 'Just prose.', model: 'm' }))
    const out = await runExplain({ question: 'q?', project: null }, { chat, exists: () => true, refresh: () => true })
    expect(out.answer).toBe('Just prose.')
    expect(out.references).toEqual([])
    expect(chat).toHaveBeenCalledTimes(2)
  })

  test('rejects an empty or over-long question', async () => {
    await expect(runExplain({ question: '', project: null }, okDeps('{}'))).rejects.toThrow(/question/)
    await expect(runExplain({ question: 'x'.repeat(501), project: null }, okDeps('{}'))).rejects.toThrow(/500/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest Services/SysScripts/TestScripts/meeting-test/explainAgent.test.js`
Expected: FAIL — `Cannot find module '../../AIScripts/explainAgent'`

- [ ] **Step 3: Implement `explainAgent.js`**

```js
// Services/SysScripts/AIScripts/explainAgent.js
//
// /explain: answer a question from a project's documentation, on this machine.
//
// Scoping is the WORKING DIRECTORY, not the prompt. The Claude CLI is started in
// the project's docs folder and can only read what is under it, so a project-
// scoped answer cannot cite another project's pages. The prompt never has to
// say "ignore other folders" — there are none to ignore.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { chat: defaultChat } = require("../AgentScripts/claudeClient");

const DOCS_REPO = path.resolve(process.cwd(), "Repos", "UBS-Doc");
const DOCS_ROOT = path.join(DOCS_REPO, "docs");
const ALL_DOCS_LABEL = "All documentation";
const MAX_REFERENCES = 8;
const MAX_QUESTION = 500;
const PULL_MIN_INTERVAL_MS = 15 * 60 * 1000; // matches the bot's docs sync cadence

// Tools the explainer must not have. claudeClient passes
// --dangerously-skip-permissions on every call, under which an --allowedTools
// allowlist restricts nothing; --disallowedTools removes these outright.
const DISALLOWED_TOOLS = "Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch,Task";
const EXTRA_ARGS = ["--disallowedTools", DISALLOWED_TOOLS];

const EXPLAIN_SYSTEM_PROMPT = `You are answering a question about a software project using only the documentation in the current directory. Search it with the tools you have; read the pages that are relevant; then answer.

Rules:
- Answer only from what these documents say. If they do not cover the question, say so plainly and do not guess. Do not use knowledge from outside these files.
- Keep the answer under 1500 characters. Prefer a direct answer followed by the essential detail. Use Markdown that Discord renders: bold, inline code, bullet lists. No headings, no tables.
- Cite every page you relied on. A reference is the file's path relative to the current directory, plus the nearest heading if there is one, plus a short verbatim quote (under 200 characters) that supports the answer.
- Respond with a single JSON object and nothing else:
  {"answer": "...", "references": [{"path": "...", "heading": "...", "quote": "..."}]}
  heading and quote may be empty strings. references may be empty.`;

const JSON_ONLY_NUDGE = "\n\nRespond with the JSON object only — no prose, no code fence.";

/**
 * Where Claude runs for this request.
 * @param {{name:string, docsPaths?:string[]|null}|null} project
 * @param {{exists:(dir:string)=>boolean}} deps
 * @returns {{cwd:string, label:string, prefix:string}}
 */
function resolveScope(project, { exists } = { exists: (d) => fs.existsSync(d) }) {
  const root = { cwd: DOCS_ROOT, label: ALL_DOCS_LABEL, prefix: "" };
  if (!project) return root;
  const first = Array.isArray(project.docsPaths) ? project.docsPaths.find((p) => typeof p === "string" && p.trim()) : null;
  if (!first) return root;

  // Normalise and refuse anything that would leave the docs root.
  const prefix = first.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const cwd = path.resolve(DOCS_ROOT, prefix);
  const inside = cwd === DOCS_ROOT || cwd.startsWith(DOCS_ROOT + path.sep);
  if (!inside || cwd === DOCS_ROOT) return root;
  if (!exists(cwd)) {
    console.warn(`[explainAgent] docsPath "${prefix}" for ${project.name} not found under ${DOCS_ROOT}; using root`);
    return root;
  }
  return { cwd, label: String(project.name || ALL_DOCS_LABEL), prefix };
}

/** Find the first balanced {...} block in text. Returns the substring or null. */
function firstJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * The model's text -> { answer, references } or null when it is not the JSON we asked for.
 * Pure.
 */
function parseExplainResult(text) {
  const candidates = [String(text || "").trim(), firstJsonObject(text)].filter(Boolean);
  for (const c of candidates) {
    let obj;
    try { obj = JSON.parse(c); } catch (_) { continue; }
    if (!obj || typeof obj !== "object" || typeof obj.answer !== "string") continue;
    const references = (Array.isArray(obj.references) ? obj.references : [])
      .filter((r) => r && typeof r.path === "string" && r.path.trim())
      .slice(0, MAX_REFERENCES)
      .map((r) => ({
        path: r.path.trim(),
        heading: typeof r.heading === "string" ? r.heading.trim().slice(0, 200) : "",
        quote: typeof r.quote === "string" ? r.quote.trim().slice(0, 300) : "",
      }));
    return { answer: obj.answer.trim(), references };
  }
  return null;
}

/** Make reference paths relative to the docs root, whatever cwd Claude ran in. Pure. */
function rebasePaths(references, prefix) {
  return references.map((r) => {
    let p = String(r.path).replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
    if (prefix && !p.startsWith(prefix + "/") && p !== prefix) p = `${prefix}/${p}`;
    return { ...r, path: p };
  });
}

const pullState = { lastPullAt: 0 };

/**
 * `git pull --ff-only` the docs clone at most once per interval. Returns whether
 * a pull was attempted. A failed pull is logged and swallowed: stale docs beat
 * no answer.
 */
function refreshDocsClone({
  now = Date.now(),
  minIntervalMs = PULL_MIN_INTERVAL_MS,
  state = pullState,
  run = () => {
    const r = spawnSync("git", ["-C", DOCS_REPO, "pull", "--ff-only", "--quiet"], { encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `git exited ${r.status}`).trim());
  },
} = {}) {
  if (now - state.lastPullAt < minIntervalMs) return false;
  state.lastPullAt = now;
  try {
    run();
    return true;
  } catch (e) {
    console.warn("[explainAgent] docs pull failed, continuing on the current clone:", e?.message || e);
    return false;
  }
}

/**
 * Answer one question. deps are injectable for tests.
 * @returns {Promise<{answer:string, references:object[], scope:string, model:string|null, durationMs:number}>}
 */
async function runExplain({ question, project }, deps = {}) {
  const chat = deps.chat || defaultChat;
  const exists = deps.exists || ((d) => fs.existsSync(d));
  const refresh = deps.refresh || refreshDocsClone;

  const q = String(question || "").trim();
  if (!q) throw new Error("question is required");
  if (q.length > MAX_QUESTION) throw new Error(`question must be ${MAX_QUESTION} characters or fewer`);

  const scope = resolveScope(project, { exists });
  refresh();

  const t0 = Date.now();
  const options = {
    system: EXPLAIN_SYSTEM_PROMPT,
    cwd: scope.cwd,
    extraArgs: EXTRA_ARGS,
    max_tokens: 2000,
  };
  if (process.env.EXPLAIN_MODEL) options.model = process.env.EXPLAIN_MODEL;

  let res = await chat([{ role: "user", content: q }], options);
  let parsed = parseExplainResult(res.text);
  if (!parsed) {
    res = await chat([{ role: "user", content: q + JSON_ONLY_NUDGE }], options);
    parsed = parseExplainResult(res.text);
  }
  if (!parsed) {
    // A readable answer beats an error.
    parsed = { answer: String(res.text || "").trim(), references: [] };
  }

  return {
    answer: parsed.answer,
    references: rebasePaths(parsed.references, scope.prefix),
    scope: scope.label,
    model: res.model || process.env.EXPLAIN_MODEL || null,
    durationMs: Date.now() - t0,
  };
}

module.exports = {
  DOCS_ROOT,
  EXPLAIN_SYSTEM_PROMPT,
  resolveScope,
  parseExplainResult,
  rebasePaths,
  refreshDocsClone,
  runExplain,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest Services/SysScripts/TestScripts/meeting-test/explainAgent.test.js`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add Services/SysScripts/AIScripts/explainAgent.js Services/SysScripts/TestScripts/meeting-test/explainAgent.test.js
git commit -m "feat(explain): explainAgent — scope by cwd, prompt, parse with fallback"
```

---

### Task 3: the `/explain` endpoint

**Files:**
- Modify: `Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js` — add the handler after `assignTasks` (~line 767) and the object after `MeetingWorkflowAssign_object` (~line 1795); add the route to the comment block listing routes (~line 1690)
- Test: live `curl` (no unit test — the handler is three lines around `runExplain`, which Task 2 tests)

**Interfaces:**
- Consumes: `runExplain` from `../../../../Services/SysScripts/AIScripts/explainAgent`; `requireMeetingPermission(req, dp, "view_meetings", null)` from `./meetingAuthz` (already imported).
- Produces: `POST /api/meeting/workflow/explain` with body `{ question, project: {name, docsPaths}|null, actionPerformerURDD }` → `{ answer, references, scope, model, durationMs }` inside the standard `{ status, message, payload: { return } }` envelope.

- [ ] **Step 1: Add the import**

At the top of `meetingWorkflow.js`, after the `meetingAgents` require (line ~24):

```js
const { runExplain } = require("../../../../Services/SysScripts/AIScripts/explainAgent");
```

- [ ] **Step 2: Add the handler**

After `assignTasks` (before `// Combined handler for both GET and POST on /tasks`):

```js
// ─────────────────────────────────────────────────────────────────────────────
// 6c. EXPLAIN — answer a question from a project's documentation
// POST /api/meeting/workflow/explain
// body { question, project: { name, docsPaths } | null, actionPerformerURDD }
// Read-only; needs view_meetings. No meeting is involved, so no narrowing.
// ─────────────────────────────────────────────────────────────────────────────

async function explainDocs(req, decryptedPayload) {
  const { question, project } = decryptedPayload;
  await requireMeetingPermission(req, decryptedPayload, "view_meetings", null);
  const proj = project && typeof project === "object"
    ? { name: String(project.name || ""), docsPaths: Array.isArray(project.docsPaths) ? project.docsPaths : null }
    : null;
  const out = await runExplain({ question, project: proj });
  logMessage([`[explain] scope=${out.scope} refs=${out.references.length} ${out.durationMs}ms`], 0, "cyan");
  return out;
}
```

- [ ] **Step 3: Add the object**

After `global.MeetingWorkflowAssign_object = { … };`:

```js
// /explain uses step() like /assign — proven live: step() endpoints answer POST
// correctly. (The requestMethod-must-be-an-array fix of 2026-09-04 applied to the
// hand-written objects such as Tasks, not to step()-generated ones.)
global.MeetingWorkflowExplain_object = {
  versions: { versionData: [{ "*": { steps: [step(explainDocs, ["question", "project"])] } }] },
};
```

And in the route comment block near line 1690 add:

```js
//   /api/meeting/workflow/explain               → MeetingWorkflowExplain_object (POST)
```

- [ ] **Step 4: Run the whole CSAAS test suite**

Run: `npx jest Services/SysScripts/TestScripts/meeting-test`
Expected: PASS for the two new files; the pre-existing live-model tests skip without `CLAUDE_BACKEND` in the test env.

- [ ] **Step 5: Commit**

```bash
git add Src/Apis/ProjectSpecificApis/MeetingWorkflow/meetingWorkflow.js
git commit -m "feat(explain): POST /meeting/workflow/explain — Claude answers from a project's docs"
```

- [ ] **Step 6: Push to CSAAS `main` and verify the deploy**

Push from the clone you worked in (never leave this as a VM-local commit):

```bash
git push origin HEAD:main
```

Then on the VM, wait for the deploy (`Deploy to Azure.yml` runs `git reset --hard origin/main` and nodemon restarts):

```bash
ssh azureuser@20.120.228.55 'cd /var/www/CSAAS/CSAAS_Backend && sudo git log --oneline -1 && sudo git rev-list --count origin/main..HEAD'
```
Expected: your commit hash, `0`.

- [ ] **Step 7: Live smoke test through the endpoint**

```bash
ssh azureuser@20.120.228.55 'curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"question\":\"What is the booking cancellation window?\",\"project\":{\"name\":\"Badar HMS\",\"docsPaths\":[\"hms-documentation\"]},\"actionPerformerURDD\":6}" \
  http://127.0.0.1:3000/api/meeting/workflow/explain | head -c 1500'
```
Expected: HTTP 200 envelope, `payload.return.answer` non-empty, `payload.return.scope` = `Badar HMS`, every `references[].path` starts with `hms-documentation/`. Allow 30–90 s.

Then the negative permission check:

```bash
ssh azureuser@20.120.228.55 'curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
  -d "{\"question\":\"x\",\"project\":null}" http://127.0.0.1:3000/api/meeting/workflow/explain'
```
Expected: `403` (no `actionPerformerURDD`).

---

## Bot side

### Task 4: `csaasClient.explain()` with a per-call timeout

**Files:**
- Modify: `bot/src/services/csaasClient.js` — `timeoutSignal`, `runFetch`, `postJson` gain an optional timeout; add `explain`
- Test: `bot/src/services/csaasClient.test.js` (append)

**Interfaces:**
- Produces: `explain({ question, project }) → Promise<{ answer, references, scope, model, durationMs }>`; `postJson(pathname, body, { timeoutMs } = {})`.

- [ ] **Step 1: Write the failing test**

Append to `bot/src/services/csaasClient.test.js` (it already stubs `globalThis.fetch` in a `beforeEach`; follow the existing tests' shape):

```js
test('explain posts question + project and unwraps the answer', async () => {
  let captured
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts }
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        status: 200,
        payload: { return: { answer: 'A', references: [{ path: 'init.md', heading: '', quote: '' }], scope: 'All documentation', model: 'm', durationMs: 12 } },
      }),
    }
  }
  const out = await explain({ question: 'q?', project: null })
  assert.equal(out.answer, 'A')
  assert.equal(out.scope, 'All documentation')
  assert.match(captured.url, /\/meeting\/workflow\/explain$/)
  const body = JSON.parse(captured.opts.body)
  assert.equal(body.question, 'q?')
  assert.equal(body.project, null)
  assert.equal(String(body.actionPerformerURDD), process.env.CSAAS_ACTOR_URDD)
  // a per-call timeout is passed as the abort signal
  assert.ok(captured.opts.signal instanceof AbortSignal)
})

test('explain normalises a missing references array', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ status: 200, payload: { return: { answer: 'A', scope: 'x' } } }),
  })
  const out = await explain({ question: 'q?', project: null })
  assert.deepEqual(out.references, [])
})
```

Add `explain` to the import at the top of the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test bot/src/services/csaasClient.test.js`
Expected: FAIL — `explain` is not exported.

- [ ] **Step 3: Implement**

In `bot/src/services/csaasClient.js`:

```js
function timeoutSignal(ms = requestTimeoutMs()) {
  return AbortSignal.timeout(ms)
}
```

```js
async function runFetch(url, init, { timeoutMs } = {}) {
  const ms = timeoutMs || requestTimeoutMs()
  try {
    return await fetch(url, { ...init, signal: timeoutSignal(ms) })
  } catch (err) {
    if (isAbort(err)) {
      throw new CsaasError(`CSAAS request timed out after ${ms}ms: ${url}`, 0, null)
    }
    throw err
  }
}
```

```js
async function postJson(pathname, body, { timeoutMs } = {}) {
  const res = await runFetch(`${BASE()}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, actionPerformerURDD: URDD() }),
  }, { timeoutMs })
  const text = await res.text()
  const json = parseBody(text)
  if (!res.ok) throw new CsaasError(json?.message || text || res.statusText, res.status, json)
  return unwrap(json, res.status)
}
```

And after `issueSync`:

```js
// /explain runs the Claude CLI in the docs clone: 30–90 s is normal. The
// interaction token lasts 15 minutes, so a 2-minute ceiling is comfortable.
export const EXPLAIN_TIMEOUT_MS = 120_000

export const explain = async ({ question, project }) => {
  const out = await postJson('/meeting/workflow/explain', { question, project: project ?? null }, { timeoutMs: EXPLAIN_TIMEOUT_MS })
  return {
    answer: String(out?.answer ?? ''),
    references: Array.isArray(out?.references) ? out.references : [],
    scope: String(out?.scope ?? 'All documentation'),
    model: out?.model ?? null,
    durationMs: Number(out?.durationMs) || 0,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test bot/src/services/csaasClient.test.js`
Expected: PASS (all, including the pre-existing ones — the timeout refactor must not change their behaviour).

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/csaasClient.js bot/src/services/csaasClient.test.js
git commit -m "feat(csaas): explain() with a 2-minute per-call timeout"
```

---

### Task 5: `explainRender.js` — the embed, pure

**Files:**
- Create: `bot/src/services/explainRender.js`
- Test: `bot/src/services/explainRender.test.js`

**Interfaces:**
- Consumes: `docUrl(siteUrl, docId)` from `../utils/docRender.js`.
- Produces: `buildExplainEmbed({ question, answer, references, scope, durationMs, siteUrl }, lookupTitle) → EmbedBuilder`; `trimAnswer(text, max) → string`; `referenceLine(ref, siteUrl, lookupTitle) → string`; `MAX_RENDERED_REFERENCES = 8`.
- `lookupTitle(docId) → string | null` is injected so the renderer has no database dependency.

- [ ] **Step 1: Write the failing tests**

```js
// bot/src/services/explainRender.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildExplainEmbed, trimAnswer, referenceLine, MAX_RENDERED_REFERENCES } from './explainRender.js'

const SITE = 'https://ubs-doc.vercel.app'
const titles = { 'hms-documentation/major-implementations/booking-rules/booking-rules-requirements': 'Booking Rules Requirements' }
const lookupTitle = (docId) => titles[docId] ?? null

test('referenceLine links the page title and appends the heading', () => {
  const line = referenceLine(
    { path: 'hms-documentation/major-implementations/booking-rules/booking-rules-requirements.md', heading: 'Cancellation window', quote: 'x' },
    SITE, lookupTitle,
  )
  assert.equal(
    line,
    '📄 [Booking Rules Requirements](https://ubs-doc.vercel.app/docs/hms-documentation/major-implementations/booking-rules/booking-rules-requirements) › Cancellation window',
  )
})

test('referenceLine falls back to the filename when the page is not mirrored', () => {
  const line = referenceLine({ path: 'init.md', heading: '', quote: '' }, SITE, lookupTitle)
  assert.equal(line, '📄 [init](https://ubs-doc.vercel.app/docs/init)')
})

test('referenceLine strips .mdx too and never renders the quote', () => {
  const line = referenceLine({ path: 'intro/start.mdx', heading: '', quote: 'secret' }, SITE, lookupTitle)
  assert.equal(line, '📄 [start](https://ubs-doc.vercel.app/docs/intro/start)')
  assert.ok(!line.includes('secret'))
})

test('trimAnswer leaves short text alone and cuts long text at a paragraph', () => {
  assert.equal(trimAnswer('short', 4000), 'short')
  const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${'x'.repeat(90)}`).join('\n\n')
  const out = trimAnswer(long, 4000)
  assert.ok(out.length <= 4000, `length ${out.length}`)
  assert.ok(out.endsWith('\n\n_…answer trimmed_'), out.slice(-40))
  // cut at a paragraph boundary: the text before the marker ends a paragraph
  const body = out.slice(0, -'\n\n_…answer trimmed_'.length)
  assert.ok(/x{90}$/.test(body), 'cut mid-paragraph')
})

test('trimAnswer hard-cuts when there is no paragraph boundary to use', () => {
  const out = trimAnswer('y'.repeat(5000), 4000)
  assert.ok(out.length <= 4000)
  assert.ok(out.endsWith('_…answer trimmed_'))
})

test('buildExplainEmbed assembles title, description, references and footer', () => {
  const embed = buildExplainEmbed({
    question: 'How does cancellation work?',
    answer: 'Like **this**.',
    references: [{ path: 'init.md', heading: '', quote: '' }],
    scope: 'Badar HMS',
    durationMs: 41250,
    siteUrl: SITE,
  }, lookupTitle).toJSON()
  assert.equal(embed.title, 'How does cancellation work?')
  assert.equal(embed.description, 'Like **this**.')
  assert.equal(embed.fields[0].name, 'References')
  assert.match(embed.fields[0].value, /\[init\]\(https:\/\/ubs-doc\.vercel\.app\/docs\/init\)/)
  assert.equal(embed.footer.text, 'Badar HMS · 41s')
  assert.equal(embed.color, 0x5865f2)
})

test('buildExplainEmbed says so when nothing was cited', () => {
  const embed = buildExplainEmbed({ question: 'q', answer: 'a', references: [], scope: 'All documentation', durationMs: 900, siteUrl: SITE }, lookupTitle).toJSON()
  assert.equal(embed.fields[0].value, '_No specific pages cited._')
  assert.equal(embed.footer.text, 'All documentation · 1s')
})

test('buildExplainEmbed caps references and the title', () => {
  const refs = Array.from({ length: 12 }, (_, i) => ({ path: `p${i}.md`, heading: '', quote: '' }))
  const embed = buildExplainEmbed({ question: 'q'.repeat(300), answer: 'a', references: refs, scope: 's', durationMs: 0, siteUrl: SITE }, lookupTitle).toJSON()
  assert.equal(embed.title.length, 256)
  assert.equal(embed.fields[0].value.split('\n').length, MAX_RENDERED_REFERENCES)
})

test('buildExplainEmbed keeps the references field under the 1024 field cap', () => {
  const refs = Array.from({ length: 8 }, (_, i) => ({
    path: `a-very-long-directory-name-number-${i}/and-another-long-segment/and-a-really-long-file-name-${i}.md`,
    heading: 'A heading that is also fairly long to push the line length up',
    quote: '',
  }))
  const embed = buildExplainEmbed({ question: 'q', answer: 'a', references: refs, scope: 's', durationMs: 0, siteUrl: SITE }, lookupTitle).toJSON()
  assert.ok(embed.fields[0].value.length <= 1024, `field length ${embed.fields[0].value.length}`)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test bot/src/services/explainRender.test.js`
Expected: FAIL — cannot find module `./explainRender.js`

- [ ] **Step 3: Implement**

```js
// bot/src/services/explainRender.js
// Pure builders for the /explain reply. No Discord calls, no database — the
// page-title lookup is injected so this file is testable on its own.
import { EmbedBuilder } from 'discord.js'
import { docUrl } from '../utils/docRender.js'

export const MAX_RENDERED_REFERENCES = 8
const TITLE_MAX = 256
const DESCRIPTION_MAX = 4000
const FIELD_MAX = 1024
const TRIM_MARK = '\n\n_…answer trimmed_'

/** A reference path -> the docId /docs uses (no extension, no leading ./). */
export function refDocId(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\.mdx?$/i, '')
}

/** One line: 📄 [Title](url) › heading. The quote is deliberately not rendered. */
export function referenceLine(ref, siteUrl, lookupTitle) {
  const docId = refDocId(ref.path)
  const title = lookupTitle(docId) || docId.split('/').pop() || docId
  const heading = String(ref.heading || '').trim()
  return `📄 [${title}](${docUrl(siteUrl, docId)})${heading ? ` › ${heading}` : ''}`
}

/**
 * Cap the answer at `max`, cutting at the last paragraph break before the
 * limit so a sentence is not sliced in half. Falls back to a hard cut when the
 * text has no paragraph break early enough.
 */
export function trimAnswer(text, max = DESCRIPTION_MAX) {
  const s = String(text || '')
  if (s.length <= max) return s
  const room = max - TRIM_MARK.length
  const cut = s.lastIndexOf('\n\n', room)
  const body = cut > room / 2 ? s.slice(0, cut) : s.slice(0, room)
  return body + TRIM_MARK
}

function referencesField(references, siteUrl, lookupTitle) {
  const refs = (Array.isArray(references) ? references : []).slice(0, MAX_RENDERED_REFERENCES)
  if (refs.length === 0) return '_No specific pages cited._'
  const lines = []
  let used = 0
  for (const r of refs) {
    const line = referenceLine(r, siteUrl, lookupTitle)
    // A single over-long line is dropped rather than truncated: a truncated
    // markdown link is a broken link.
    if (used + line.length + 1 > FIELD_MAX) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n') || '_No specific pages cited._'
}

/**
 * @param {{question:string, answer:string, references:object[], scope:string, durationMs:number, siteUrl:string}} r
 * @param {(docId:string)=>string|null} lookupTitle
 */
export function buildExplainEmbed(r, lookupTitle) {
  const seconds = Math.round((Number(r.durationMs) || 0) / 1000)
  return new EmbedBuilder()
    .setTitle(String(r.question || 'Question').slice(0, TITLE_MAX))
    .setDescription(trimAnswer(r.answer, DESCRIPTION_MAX) || '_No answer._')
    .addFields({ name: 'References', value: referencesField(r.references, r.siteUrl, lookupTitle), inline: false })
    .setFooter({ text: `${r.scope || 'All documentation'} · ${seconds}s` })
    .setColor(0x5865f2)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test bot/src/services/explainRender.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add bot/src/services/explainRender.js bot/src/services/explainRender.test.js
git commit -m "feat(explain): pure embed renderer with doc links"
```

---

### Task 6: the `/explain` command, autocomplete, registration, config

**Files:**
- Create: `bot/src/commands/explain.js`
- Test: `bot/src/commands/explain.test.js`
- Modify: `bot/src/commands/index.js` (import + `commandModules` entry + `PUBLIC_REPLY_COMMANDS`)
- Modify: `bot/src/index.js:71-76` (defer flags)
- Modify: `bot/src/config/command-config.json` (three sections)

**Interfaces:**
- Consumes: `explain` from `../services/csaasClient.js` (Task 4); `buildExplainEmbed` from `../services/explainRender.js` (Task 5); `db.project.findMany({ where: { guildConfigId } })`, `db.project.findFirst({ where: { id } })`, `db.docPage.findByDocId({ guildConfigId, docId })`, `db.docSource.get({ guildConfigId })`, `getOrCreateGuildConfig(guildId)` from `../db/index.js`; `DEFAULT_SOURCE` from `../services/docsSync.js`; `CsaasError` from `../services/csaasClient.js`.
- Produces: `projectChoices(projects, term) → {name, value}[]` (pure, exported); `isPublicReplyCommand(name)` from `commands/index.js`.

- [ ] **Step 1: Write the failing test for the pure choice list**

```js
// bot/src/commands/explain.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectChoices, NO_PROJECT } from './explain.js'

const projects = [
  { id: 'p1', name: 'Framework' },
  { id: 'p2', name: 'Badar HMS' },
  { id: 'p3', name: 'CSAAS' },
]

test('"No project" is always first and carries the sentinel value', () => {
  const out = projectChoices(projects, '')
  assert.equal(out[0].value, NO_PROJECT)
  assert.match(out[0].name, /^No project/)
  assert.deepEqual(out.slice(1).map((c) => c.value), ['p1', 'p2', 'p3'])
})

test('typing filters projects by name, case-insensitively, and keeps "No project"', () => {
  const out = projectChoices(projects, 'hms')
  assert.deepEqual(out.map((c) => c.value), [NO_PROJECT, 'p2'])
})

test('never more than 25 choices and names never over 100 characters', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `id${i}`, name: `Project ${'n'.repeat(120)} ${i}` }))
  const out = projectChoices(many, '')
  assert.ok(out.length <= 25)
  for (const c of out) assert.ok(c.name.length <= 100)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test bot/src/commands/explain.test.js`
Expected: FAIL — cannot find module `./explain.js`

- [ ] **Step 3: Implement the command**

```js
// bot/src/commands/explain.js
import { SlashCommandBuilder } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { explain, CsaasError, isConfigured } from '../services/csaasClient.js'
import { buildExplainEmbed } from '../services/explainRender.js'
import { DEFAULT_SOURCE } from '../services/docsSync.js'

export const NO_PROJECT = 'none'
const NO_PROJECT_LABEL = 'No project — all documentation'
const QUESTION_MAX = 500

export const data = new SlashCommandBuilder()
  .setName('explain')
  .setDescription('Ask a question about a project — answered from its documentation, with references')
  .addStringOption((o) =>
    o
      .setName('project')
      .setDescription('Which project to answer from (or "No project" for everything)')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption((o) =>
    o
      .setName('question')
      .setDescription('What do you want explained?')
      .setRequired(true)
      .setMaxLength(QUESTION_MAX)
  )

/** Autocomplete choices: "No project" first, then projects matching the typed text. Pure. */
export function projectChoices(projects, term) {
  const t = String(term || '').trim().toLowerCase()
  const head = { name: NO_PROJECT_LABEL, value: NO_PROJECT }
  const rest = (projects || [])
    .filter((p) => !t || String(p.name || '').toLowerCase().includes(t))
    .map((p) => ({ name: String(p.name || p.id).slice(0, 100), value: String(p.id) }))
  return [head, ...rest].slice(0, 25)
}

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'project') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getOrCreateGuildConfig(interaction.guild.id)
    const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
    return interaction.respond(projectChoices(projects, focused.value)).catch(() => {})
  } catch (e) {
    console.error('[explain] autocomplete:', e?.message ?? e)
    return interaction.respond([]).catch(() => {})
  }
}

export async function execute(interaction) {
  if (!interaction.guild) return interaction.editReply({ content: 'Use this in a server.' }).catch(() => {})
  if (!isConfigured()) {
    return interaction.editReply({ content: 'The explainer is not configured on this bot (CSAAS_API_URL / CSAAS_ACTOR_URDD).' }).catch(() => {})
  }

  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  const projectValue = interaction.options.getString('project')
  const question = String(interaction.options.getString('question') || '').trim()
  if (!question) return interaction.editReply({ content: 'Ask a question.' }).catch(() => {})

  // The picker's value is a project id; free text typed past the suggestions
  // arrives as-is and matches nothing, which is treated as "no project".
  let project = null
  if (projectValue && projectValue !== NO_PROJECT) {
    const row = await db.project.findFirst({ where: { id: projectValue } }).catch(() => null)
    if (row && row.guildConfigId === cfg.id) {
      project = { name: row.name, docsPaths: Array.isArray(row.docsPaths) ? row.docsPaths : null }
    }
  }

  await interaction.editReply({ content: `Reading the ${project ? `**${project.name}**` : ''} documentation… this takes a minute.` }).catch(() => {})

  let result
  try {
    result = await explain({ question, project })
  } catch (e) {
    const status = e instanceof CsaasError ? e.status : null
    console.error(`[explain] CSAAS failed (status ${status}):`, e?.message ?? e)
    return interaction.editReply({ content: "Couldn't reach the explainer — try again in a minute." }).catch(() => {})
  }

  const source = (await db.docSource.get({ guildConfigId: cfg.id }).catch(() => null)) || DEFAULT_SOURCE
  // Titles come from the mirrored pages when present; the renderer falls back
  // to the filename for anything not mirrored.
  const titles = new Map()
  for (const ref of result.references) {
    const docId = String(ref.path || '').replace(/^(\.\/)+/, '').replace(/\.mdx?$/i, '')
    if (titles.has(docId)) continue
    const row = await db.docPage.findByDocId({ guildConfigId: cfg.id, docId }).catch(() => null)
    titles.set(docId, row?.title || null)
  }
  const lookupTitle = (docId) => titles.get(docId) ?? null

  const embed = buildExplainEmbed({ ...result, question, siteUrl: source.siteUrl }, lookupTitle)
  return interaction.editReply({ content: null, embeds: [embed] }).catch(() => {})
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test bot/src/commands/explain.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the command and make its reply public**

In `bot/src/commands/index.js`:

- Add `import * as explainCmd from './explain.js'` after the `recordCmd` import.
- Add `explainCmd,` to the `commandModules` array (after `docsCmd,` so it sits with the documentation commands).
- Next to `MODAL_FIRST_COMMANDS`, add:

```js
// Commands whose reply should be visible to the channel, not only to the
// invoker. Every other slash command is deferred ephemerally in index.js.
const PUBLIC_REPLY_COMMANDS = new Set(['explain'])

export function isPublicReplyCommand(name) {
  return PUBLIC_REPLY_COMMANDS.has(name)
}
```

In `bot/src/index.js`, import `isPublicReplyCommand` alongside `isModalFirstCommand` (same module), and change the defer:

```js
      await interaction.deferReply(
        isPublicReplyCommand(interaction.commandName) ? {} : { flags: EPHEMERAL },
      );
```

- [ ] **Step 6: Configure the command**

In `bot/src/config/command-config.json`:

- `commandRoles`: add `"explain": ["Verified"],` after the `"docs"` line.
- `dedicatedChannels`: add `"explain": true,` after the `"docs"` line.
- `commandDescriptions`: add after the `docs` entry:

```json
    "explain": {
      "summary": "Ask a question about a project; answered from its documentation with references.",
      "syntax": "`/explain project:<pick one> question:<your question>`",
      "detail": "Pick a project (or **No project** for all documentation) and ask in plain words. Claude reads that project's documentation on the server and answers with links to the pages it used. One question, one answer — ask again to follow up. Takes 30–90 seconds."
    },
```

Validate: `node -e "JSON.parse(require('fs').readFileSync('bot/src/config/command-config.json','utf8'));console.log('json ok')"`

- [ ] **Step 7: Run the full bot suite**

Run: `npm test`
Expected: PASS, 159 + 2 (Task 4) + 9 (Task 5) + 3 (Task 6) = **173** tests.

- [ ] **Step 8: Commit**

```bash
git add bot/src/commands/explain.js bot/src/commands/explain.test.js bot/src/commands/index.js bot/src/index.js bot/src/config/command-config.json
git commit -m "feat: /explain — ask a project's documentation, answered by Claude on the VM"
```

---

### Task 7: deploy, live acceptance, knowledge page

**Files:**
- Create: `.claude/knowledge/explain.md`
- Modify: `.claude/knowledge/README.md` (index line), `.claude/state/backlog.md`, `.claude/state/completed.md`

**Interfaces:** none new.

- [ ] **Step 1: Deploy the bot**

```bash
git push origin main
ssh -i ~/frame-work_key.pem azureuser@20.120.228.55 'cd ~/Granjur-Discord-Bot && git checkout -- package-lock.json; git pull --ff-only origin main && npm run deploy:commands && pm2 restart granjur-bot --update-env && sleep 5 && pm2 logs granjur-bot --lines 8 --nostream | grep -E "Registered|Logged in"'
```
Expected: `Registered 41 commands for guild …`, `Logged in as Granjur-Helper#8388`.

- [ ] **Step 2: Live acceptance — three questions**

Ask in Discord and check each against spec §11:

1. `/explain project: Badar HMS question: What is the booking cancellation window?` — an answer, references under `hms-documentation/`, each link opens a real page on `ubs-doc.vercel.app`, footer `Badar HMS · Ns`.
2. `/explain project: No project question: What does init.md tell a new developer to do first?` — a reference outside `hms-documentation` (proves root scope), footer `All documentation · Ns`.
3. `/explain project: Badar HMS question: What is the capital of France?` — the answer says the documentation does not cover it, `_No specific pages cited._`, no error.

Also confirm the reply is **visible to another member** in the channel (public defer worked).

If (1) cites paths that do not resolve, check `pm2 logs csaas` for `[explain] scope=` lines and the CLI duration; a `scope=All documentation` on a Badar HMS question means `resolveScope` fell back — verify `Repos/UBS-Doc/docs/hms-documentation` exists on the VM.

- [ ] **Step 3: Knowledge page**

```markdown
<!-- .claude/knowledge/explain.md -->
# /explain — how it works and how to debug it

**What:** `/explain project:<picker> question:<text>` answers from a project's documentation.
One-shot; no session. Documentation only (no code) as of 2026-09-04.

**Where Claude runs:** on the VM, inside `/var/www/CSAAS/CSAAS_Backend/Repos/UBS-Doc/docs`,
via CSAAS `POST /api/meeting/workflow/explain` → `Services/SysScripts/AIScripts/explainAgent.js`
→ `claudeClient.chat` (Claude CLI as `azureuser`). The bot never talks to Claude directly.

**Scoping is the working directory.** A project with `project.docsPaths` runs in
`docs/<first docsPath>`; no project or no `docsPaths` runs in `docs/`. The footer says
`All documentation` whenever scoping did not happen — that is the first thing to check
when a project answer looks too broad.

**Tools:** `--disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch,Task`
via `claudeClient`'s `extraArgs` option. `--allowedTools` would not restrict anything because
`claudeClient` always passes `--dangerously-skip-permissions`.

**Docs freshness:** `git pull --ff-only` on the clone at most every 15 minutes, before a run.

**Debugging:**
- `pm2 logs csaas | grep '\[explain\]'` — one line per question: scope, reference count, ms.
- `pm2 logs csaas | grep claudeClient` — prompt length and CLI duration.
- Bot side: `[explain] CSAAS failed (status N)` in `pm2 logs granjur-bot`.
- Non-JSON from the model is retried once, then returned as plain text with no references.
  Not an error; if it happens often, the prompt in `explainAgent.js` needs tightening.

**Limits:** question ≤ 500 chars; references ≤ 8; answer trimmed at 4000; 120 s bot-side timeout.

**Tests:** `bot/src/services/explainRender.test.js`, `bot/src/commands/explain.test.js`,
`bot/src/services/csaasClient.test.js`; CSAAS `Services/SysScripts/TestScripts/meeting-test/explainAgent.test.js`.
```

Add to `.claude/knowledge/README.md`: `- [explain.md](explain.md) — /explain: Claude answers from a project's docs on the VM; scoping by cwd; debugging`.

- [ ] **Step 4: State files**

Append to `.claude/state/completed.md` (newest first) a dated entry naming the commits on both repos, and remove any `/explain` item from `backlog.md`. Add to `backlog.md`: "**/explain: code as a second source** once the fresh Badar HMS clone is on the VM (`--add-dir` or a second `cwd` root; renderer needs a `file:line` form)."

- [ ] **Step 5: Commit**

```bash
git add .claude/knowledge/explain.md .claude/knowledge/README.md .claude/state/completed.md .claude/state/backlog.md
git commit -m "docs: /explain knowledge page and state"
git push origin main
```

---

## Self-review

**Spec coverage.** §1 one-shot → Task 6 (no components, no state). §2 VM → Tasks 2–3. §3 cwd scoping table → `resolveScope` in Task 2 with all four rows tested. §4 endpoint: body shape, `view_meetings`, pull-if-stale, `extraArgs`, no `--output-format json`, `EXPLAIN_MODEL`, path rebasing → Tasks 2–3. §5 prompt verbatim → Task 2 constant. §6 parse + retry + raw fallback + cap 8 + drop no-path → Task 2. §7 command, autocomplete, roles, dedicated channel, public defer, 120 s timeout → Tasks 4 and 6. §8 rendering → Task 5. §9 failure table → Tasks 2 (pull, cwd fallback, non-JSON), 6 (CSAAS errors). §10 config → nothing new, noted. §11 tests → Tasks 1, 2, 4, 5, 6, and live in Task 7. §12 file map → matches the file map above. §13 out of scope → backlog note in Task 7.

One deliberate deviation from spec §4: the object uses `step()` (string `"POST"`) rather than an explicit `requestMethod` array, because `/assign` uses `step()` and answers POST correctly live; the array fix applied only to the hand-written objects. Recorded in the Task 3 code comment.

**Placeholders.** None: every step has its code or its exact command and expected output.

**Type consistency.** `runExplain` returns `{ answer, references, scope, model, durationMs }` (Task 2) = what `explainDocs` returns (Task 3) = what `csaasClient.explain` normalises (Task 4) = what `buildExplainEmbed` consumes with `question` and `siteUrl` added (Tasks 5–6). `references[]` is `{ path, heading, quote }` throughout. `projectChoices`/`NO_PROJECT` are exported from `explain.js` and imported by its test. `isPublicReplyCommand` is exported from `commands/index.js` and imported in `bot/src/index.js`.

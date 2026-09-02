# Project Docs Sync + Preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every markdown document in the `UBS-Doc` repository readable from Discord, organised by project, with a deep link to the published site for anything an embed cannot hold.

**Architecture:** A 15-minute background service pulls the UBS-Doc git tree from GitHub and mirrors changed files into two new MySQL tables (`docpage`, `docsource`). Every Discord surface reads only from MySQL, never from GitHub, so browsing stays fast and survives a GitHub outage. Pure functions (path parsing, markdown rendering, tree building) live in `bot/src/utils/` and carry the test suite; commands stay thin.

**Tech Stack:** Node 24 ESM, discord.js v14, mysql2, `node:test` (new to this repo), `node-fetch` (already a dependency).

**Spec:** `docs/superpowers/specs/2026-09-03-project-docs-preview-design.md`

## Global Constraints

- ESM only — `import`/`export`, `"type": "module"`. No `require`.
- Two-space indent, single quotes, no semicolon-terminated style in `bot/src/commands/` and `bot/src/utils/` (match the surrounding file you edit; `bot/src/Database/index.js` and `bot/src/index.js` use semicolons and double quotes — match those when editing them).
- All DB access goes through `bot/src/Database/index.js` and is re-exported by `bot/src/db/index.js`. Commands import `db from '../db/index.js'`.
- Ids come from `helpers.id()` — `VARCHAR(36)`. Never auto-increment.
- Migrations are `.sql` files in `bot/src/Database/migrations/`, named `NNN_snake_case.sql`, run in filename order, and MUST be re-runnable — guard every DDL with an `information_schema` check exactly as `010_guild_timezone.sql` and `011_scheduled_meeting_cancelled.sql` do.
- Interaction replies always end in `.catch(() => {})`. Every slash command is already deferred by `bot/src/index.js` before `execute` runs, so handlers use `interaction.editReply`, never `interaction.reply`.
- Repo constants: `EPHEMERAL` from `bot/src/constants.js`. Embed colours in use: `0x5865f2` (info), `0x57f287` (success).
- Source repository: owner `Aashir-Adnan`, repo `UBS-Doc`, branch `main`, site `https://ubs-doc.vercel.app`.
- Doc id rule, copied from the site's `src/docs/docsIndex.ts`: include `docs/**/*.md` and `docs/**/*.mdx`, exclude `docs/superpowers/**`; the id is the path with the `docs/` prefix and the extension removed.
- Discord hard limits used throughout: 25 options per select menu, 4096 characters per embed description, 100 characters per option label, 4000 characters per modal text input.
- **Do not push to `main`.** `.github/workflows/deploy.yml` deploys every push to `main` onto the production VM. All work happens on the `feat/project-docs` branch.

---

### Task 0: Branch and test harness

**Files:**
- Modify: `package.json`
- Create: `bot/test/.gitkeep`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` runs `node --test bot/test/`, so every later task has somewhere to put tests.

- [ ] **Step 1: Create the working branch**

```bash
git checkout -b feat/project-docs
```

- [ ] **Step 2: Add the test script**

In `package.json`, inside `"scripts"`, add this line after `"dev"`:

```json
    "test": "node --test bot/test/",
```

- [ ] **Step 3: Create the test directory**

```bash
mkdir -p bot/test && touch bot/test/.gitkeep
```

- [ ] **Step 4: Verify the runner works with no tests**

Run: `npm test`
Expected: exits 0 with `# pass 0` / `# fail 0`. If it errors with "Could not find" the directory is missing — re-run step 3.

- [ ] **Step 5: Commit**

```bash
git add package.json bot/test/.gitkeep
git commit -m "test: add node:test runner and bot/test directory

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: Doc path utilities

Pure functions that turn a repository path into everything the rest of the system needs. No I/O, no DB, no Discord.

**Files:**
- Create: `bot/src/utils/docPath.js`
- Test: `bot/test/docPath.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `isDocFile(path: string): boolean`
  - `toDocId(path: string): string`
  - `sectionOf(path: string): string`
  - `slugify(name: string): string`
  - `extractTitle(content: string, path: string): string`
  - `attributeProject(path: string, projects: Array<{id, docsSlug, docsPaths}>): string | null`

- [ ] **Step 1: Write the failing test**

Create `bot/test/docPath.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isDocFile,
  toDocId,
  sectionOf,
  slugify,
  extractTitle,
  attributeProject,
} from '../src/utils/docPath.js'

test('isDocFile accepts md and mdx under docs/', () => {
  assert.equal(isDocFile('docs/api/overview.md'), true)
  assert.equal(isDocFile('docs/intro/Node-Advantages.mdx'), true)
})

test('isDocFile rejects non-docs, non-markdown, and superpowers', () => {
  assert.equal(isDocFile('src/docs/sidebar.ts'), false)
  assert.equal(isDocFile('docs/api/_category_.json'), false)
  assert.equal(isDocFile('docs/intro/Node-Advantages.pdf'), false)
  assert.equal(isDocFile('docs/superpowers/brainstorming/SKILL.md'), false)
  assert.equal(isDocFile('README.md'), false)
})

test('toDocId strips the docs prefix and the extension', () => {
  assert.equal(toDocId('docs/api/overview.md'), 'api/overview')
  assert.equal(
    toDocId('docs/hms-documentation/major-implementations/booking-rules/booking-rules-requirements.md'),
    'hms-documentation/major-implementations/booking-rules/booking-rules-requirements'
  )
  assert.equal(toDocId('docs/init.mdx'), 'init')
})

test('sectionOf returns the first segment under docs/', () => {
  assert.equal(sectionOf('docs/api/overview.md'), 'api')
  assert.equal(sectionOf('docs/init.md'), 'init.md')
})

test('slugify lowercases and hyphenates', () => {
  assert.equal(slugify('Badar HMS'), 'badar-hms')
  assert.equal(slugify('ScholarSpace'), 'scholarspace')
  assert.equal(slugify('  Fit Tour  '), 'fit-tour')
  assert.equal(slugify('C/SAAS'), 'c-saas')
})

test('extractTitle prefers frontmatter title', () => {
  const md = '---\ntitle: Booking Rules\nsidebar_position: 2\n---\n\n# Something else\n'
  assert.equal(extractTitle(md, 'docs/a/b.md'), 'Booking Rules')
})

test('extractTitle falls back to the first heading', () => {
  const md = '---\nsidebar_position: 0\n---\n\n# Standard Issue Resolution Workflow\n\ntext\n'
  assert.equal(extractTitle(md, 'docs/a/b.md'), 'Standard Issue Resolution Workflow')
})

test('extractTitle falls back to a humanized filename', () => {
  assert.equal(extractTitle('no heading here\n', 'docs/a/tenant-seed-data.md'), 'Tenant Seed Data')
  assert.equal(extractTitle('', 'docs/a/OPERA_PMS_Integration.md'), 'OPERA PMS Integration')
})

test('attributeProject matches docs/projects/<docsSlug>/', () => {
  const projects = [{ id: 'p1', docsSlug: 'badar-hms', docsPaths: [] }]
  assert.equal(attributeProject('docs/projects/badar-hms/Opera_Config.md', projects), 'p1')
  assert.equal(attributeProject('docs/projects/other/x.md', projects), null)
})

test('attributeProject matches an extra docsPaths prefix', () => {
  const projects = [{ id: 'p1', docsSlug: 'badar-hms', docsPaths: ['hms-documentation'] }]
  assert.equal(attributeProject('docs/hms-documentation/admin-apis/x.md', projects), 'p1')
  assert.equal(attributeProject('docs/api/overview.md', projects), null)
})

test('attributeProject does not match a partial directory name', () => {
  const projects = [{ id: 'p1', docsSlug: 'hms', docsPaths: [] }]
  assert.equal(attributeProject('docs/projects/hms-other/x.md', projects), null)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/utils/docPath.js'`

- [ ] **Step 3: Write the implementation**

Create `bot/src/utils/docPath.js`:

```js
/**
 * Pure helpers that map a UBS-Doc repository path onto the values the bot stores.
 * The include/exclude rule and the id derivation mirror the site's
 * src/docs/docsIndex.ts exactly, so a docId here is a working site route.
 */

const DOCS_PREFIX = 'docs/'
const EXCLUDED_PREFIX = 'docs/superpowers/'

/** True if this repository path is a doc the site would route. */
export function isDocFile(path) {
  if (typeof path !== 'string') return false
  if (!path.startsWith(DOCS_PREFIX)) return false
  if (path.startsWith(EXCLUDED_PREFIX)) return false
  return /\.mdx?$/i.test(path)
}

/** 'docs/api/overview.md' -> 'api/overview' (the site's route id). */
export function toDocId(path) {
  return path.slice(DOCS_PREFIX.length).replace(/\.mdx?$/i, '')
}

/** First path segment under docs/. Loose root files return their filename. */
export function sectionOf(path) {
  return path.slice(DOCS_PREFIX.length).split('/')[0]
}

/** 'Badar HMS' -> 'badar-hms'. Used to derive a project's default docsSlug. */
export function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function humanizeFilename(path) {
  const base = path.split('/').pop().replace(/\.mdx?$/i, '')
  return base.replace(/[-_]+/g, ' ').trim()
}

/** Frontmatter title, else the first '# ' heading, else a humanized filename. */
export function extractTitle(content, path) {
  const text = String(content || '')
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const t = fm[1].match(/^title:\s*(.+)$/m)
    if (t) return t[1].trim().replace(/^['"]|['"]$/g, '')
  }
  const body = fm ? text.slice(fm[0].length) : text
  const heading = body.match(/^#\s+(.+)$/m)
  if (heading) return heading[1].trim()
  return humanizeFilename(path)
}

/**
 * Return the id of the project that owns this path, or null.
 * A project owns `docs/projects/<docsSlug>/**` plus each prefix in docsPaths
 * (relative to docs/). Matching is on whole directory segments, so a project
 * slugged 'hms' never captures 'hms-other'.
 */
export function attributeProject(path, projects) {
  const rel = path.slice(DOCS_PREFIX.length)
  for (const p of projects || []) {
    const prefixes = []
    if (p.docsSlug) prefixes.push(`projects/${p.docsSlug}/`)
    for (const extra of p.docsPaths || []) {
      const clean = String(extra).replace(/^\/+|\/+$/g, '')
      if (clean) prefixes.push(`${clean}/`)
    }
    if (prefixes.some((pre) => rel.startsWith(pre))) return p.id
  }
  return null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add bot/src/utils/docPath.js bot/test/docPath.test.js
git commit -m "feat: add doc path utilities mirroring the UBS-Doc route rules

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Markdown rendering and pagination

Turns MDX-flavoured markdown into something Discord renders sensibly, then splits it into embed-sized pages without cutting a code fence in half.

**Files:**
- Create: `bot/src/utils/docRender.js`
- Test: `bot/test/docRender.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `renderForDiscord(markdown: string, opts: { siteUrl: string }): string`
  - `paginate(text: string, max?: number): string[]` — default max 3800
  - `docUrl(siteUrl: string, docId: string): string`

- [ ] **Step 1: Write the failing test**

Create `bot/test/docRender.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderForDiscord, paginate, docUrl } from '../src/utils/docRender.js'

const SITE = 'https://ubs-doc.vercel.app'

test('docUrl builds a site route from a docId', () => {
  assert.equal(docUrl(SITE, 'api/overview'), 'https://ubs-doc.vercel.app/docs/api/overview')
  assert.equal(docUrl(SITE + '/', 'api/overview'), 'https://ubs-doc.vercel.app/docs/api/overview')
})

test('renderForDiscord strips frontmatter', () => {
  const out = renderForDiscord('---\ntitle: X\n---\n\nBody text\n', { siteUrl: SITE })
  assert.equal(out, 'Body text')
})

test('renderForDiscord converts admonitions to bold + blockquote', () => {
  const md = ':::warning[Heads up]\nDo not do this.\n:::\n'
  const out = renderForDiscord(md, { siteUrl: SITE })
  assert.match(out, /\*\*Heads up\*\*/)
  assert.match(out, /^> Do not do this\./m)
})

test('renderForDiscord labels an untitled admonition with its type', () => {
  const out = renderForDiscord(':::note\nRemember.\n:::\n', { siteUrl: SITE })
  assert.match(out, /\*\*Note\*\*/)
  assert.match(out, /^> Remember\./m)
})

test('renderForDiscord drops MDX imports and bare JSX', () => {
  const md = "import Foo from './Foo'\n\n<Foo bar />\n\nReal text\n"
  const out = renderForDiscord(md, { siteUrl: SITE })
  assert.equal(out.includes('import Foo'), false)
  assert.equal(out.includes('<Foo'), false)
  assert.match(out, /Real text/)
})

test('renderForDiscord rewrites relative doc links to site urls', () => {
  const md = 'See [the other](./other.md) and [up](../api/overview.md).'
  const out = renderForDiscord(md, { siteUrl: SITE, docId: 'backend/tenancy' })
  assert.match(out, /\(https:\/\/ubs-doc\.vercel\.app\/docs\/backend\/other\)/)
  assert.match(out, /\(https:\/\/ubs-doc\.vercel\.app\/docs\/api\/overview\)/)
})

test('renderForDiscord leaves code fences untouched', () => {
  const md = '```js\nconst x = 1 // <Foo />\n```\n'
  const out = renderForDiscord(md, { siteUrl: SITE })
  assert.match(out, /const x = 1 \/\/ <Foo \/>/)
})

test('paginate returns one page when the text fits', () => {
  assert.deepEqual(paginate('short', 100), ['short'])
})

test('paginate splits on paragraph boundaries', () => {
  const text = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].join('\n\n')
  const pages = paginate(text, 90)
  assert.equal(pages.length, 2)
  assert.equal(pages[0].includes('c'.repeat(40)), false)
  assert.ok(pages.every((p) => p.length <= 90))
})

test('paginate never splits inside a code fence', () => {
  const fence = '```js\n' + 'x\n'.repeat(30) + '```'
  const text = 'intro paragraph\n\n' + fence + '\n\ntail paragraph'
  const pages = paginate(text, 60)
  for (const p of pages) {
    const fences = (p.match(/```/g) || []).length
    assert.equal(fences % 2, 0, `unbalanced fence in page: ${JSON.stringify(p)}`)
  }
})

test('paginate hard-splits a single oversized paragraph', () => {
  const pages = paginate('z'.repeat(250), 100)
  assert.equal(pages.length, 3)
  assert.ok(pages.every((p) => p.length <= 100))
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/utils/docRender.js'`

- [ ] **Step 3: Write the implementation**

Create `bot/src/utils/docRender.js`:

```js
/**
 * Markdown -> Discord-embed text, plus paging.
 *
 * The transformations mirror what the UBS-Doc site does at build time
 * (remarkAdmonitions.ts, remarkDocLinks.ts) so a doc reads the same in
 * both places. Tables and images are left as raw markdown on purpose:
 * Discord will not render them, which is what the "Read full page"
 * button on the embed is for.
 */

const ADMONITION_TYPES = ['note', 'tip', 'info', 'warning', 'caution', 'danger']

/** Build the published URL for a doc id. */
export function docUrl(siteUrl, docId) {
  return `${String(siteUrl || '').replace(/\/+$/, '')}/docs/${docId}`
}

function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? text.slice(m[0].length) : text
}

/** Split into alternating prose / fenced-code segments so we never edit code. */
function splitFences(text) {
  const parts = []
  const re = /```[\s\S]*?(?:```|$)/g
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ code: false, text: text.slice(last, m.index) })
    parts.push({ code: true, text: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) })
  return parts
}

function convertAdmonitions(text) {
  const open = new RegExp(`^:::(${ADMONITION_TYPES.join('|')})(?:\\[(.*?)\\])?\\s*$`, 'i')
  const lines = text.split('\n')
  const out = []
  let inside = false
  for (const line of lines) {
    const m = line.match(open)
    if (m && !inside) {
      inside = true
      const type = m[1].toLowerCase()
      const label = m[2] || type.charAt(0).toUpperCase() + type.slice(1)
      out.push(`**${label}**`)
      continue
    }
    if (inside && /^:::\s*$/.test(line)) {
      inside = false
      continue
    }
    out.push(inside ? `> ${line}` : line)
  }
  return out.join('\n')
}

function stripMdx(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*(import|export)\s+/.test(l))
    .join('\n')
    .replace(/<\/?[A-Z][A-Za-z0-9]*(?:\s[^>]*)?\/?>/g, '')
}

function rewriteLinks(text, siteUrl, docId) {
  const baseDir = docId && docId.includes('/') ? docId.slice(0, docId.lastIndexOf('/')) : ''
  return text.replace(/\]\((\.\.?\/[^)\s]+?)\.mdx?\)/g, (_full, rel) => {
    const segments = `${baseDir}/${rel}`.split('/')
    const stack = []
    for (const s of segments) {
      if (s === '' || s === '.') continue
      if (s === '..') stack.pop()
      else stack.push(s)
    }
    return `](${docUrl(siteUrl, stack.join('/'))})`
  })
}

/** Full markdown -> Discord text pipeline. */
export function renderForDiscord(markdown, { siteUrl = '', docId = '' } = {}) {
  const body = stripFrontmatter(String(markdown || ''))
  const rendered = splitFences(body)
    .map((part) => {
      if (part.code) return part.text
      let t = convertAdmonitions(part.text)
      t = stripMdx(t)
      t = rewriteLinks(t, siteUrl, docId)
      return t
    })
    .join('')
  return rendered.replace(/\n{3,}/g, '\n\n').trim()
}

function hardSplit(chunk, max) {
  const out = []
  let rest = chunk
  while (rest.length > max) {
    out.push(rest.slice(0, max))
    rest = rest.slice(max)
  }
  if (rest.length) out.push(rest)
  return out
}

/**
 * Split an oversized code block into several complete, individually fenced
 * blocks, so no page ever carries an unbalanced ``` marker.
 */
function splitCodeBlock(block, max) {
  const lines = block.split('\n')
  const opener = lines[0].startsWith('```') ? lines[0] : '```'
  const closed = lines[lines.length - 1].trim() === '```'
  const inner = lines.slice(1, closed ? -1 : undefined)
  const wrap = (arr) => [opener, ...arr, '```'].join('\n')

  const pieces = []
  let buf = []
  for (const line of inner) {
    if (buf.length && wrap([...buf, line]).length > max) {
      pieces.push(wrap(buf))
      buf = [line]
    } else {
      buf.push(line)
    }
  }
  if (buf.length) pieces.push(wrap(buf))
  // A single line longer than max still has to be cut somewhere.
  return pieces.flatMap((p) => (p.length <= max ? [p] : hardSplit(p, max)))
}

/**
 * Split rendered text into pages of at most `max` characters, breaking on
 * paragraph boundaries. A fenced code block stays whole unless it alone
 * exceeds `max`, in which case it is split into several complete fenced
 * blocks rather than being cut mid-fence.
 */
export function paginate(text, max = 3800) {
  const blocks = []
  for (const part of splitFences(String(text || ''))) {
    if (part.code) blocks.push({ text: part.text, code: true })
    else for (const p of part.text.split(/\n{2,}/)) if (p.trim()) blocks.push({ text: p.trim(), code: false })
  }

  const pages = []
  let current = ''
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block.text}` : block.text
    if (candidate.length <= max) {
      current = candidate
      continue
    }
    if (current) {
      pages.push(current)
      current = ''
    }
    if (block.text.length <= max) {
      current = block.text
      continue
    }
    const pieces = block.code ? splitCodeBlock(block.text, max) : hardSplit(block.text, max)
    pages.push(...pieces.slice(0, -1))
    current = pieces[pieces.length - 1]
  }
  if (current) pages.push(current)
  return pages.length ? pages : ['']
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 22 tests total across both files.

- [ ] **Step 5: Commit**

```bash
git add bot/src/utils/docRender.js bot/test/docRender.test.js
git commit -m "feat: add markdown to Discord renderer and fence-safe pager

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Migration 012 and the database surface

**Files:**
- Create: `bot/src/Database/migrations/012_doc_pages.sql`
- Modify: `bot/src/Database/schema.sql` (append the two tables so a fresh `db:init` matches)
- Modify: `bot/src/Database/index.js` (add `docPage` and `docSource` to the exported `db`)

**Interfaces:**
- Consumes: `helpers.id()`, `query`, `queryOne` from `./connection.js`
- Produces, on `db`:
  - `docPage.listIndex({ guildConfigId }): Promise<Row[]>` — every row **without** `content`: `{ id, path, docId, section, projectId, title, source }`
  - `docPage.findByDocId({ guildConfigId, docId }): Promise<Row|null>` — full row including `content`
  - `docPage.search({ guildConfigId, q, limit }): Promise<Row[]>` — no `content`
  - `docPage.upsert({ data }): Promise<void>` — `data` is `{ guildConfigId, path, docId, section, projectId, title, content, source, blobSha, size }`
  - `docPage.deleteRepoPathsNotIn({ guildConfigId, paths }): Promise<number>`
  - `docPage.countsByProject({ guildConfigId }): Promise<Array<{projectId, n}>>`
  - `docSource.get({ guildConfigId })`, `docSource.upsert({ guildConfigId, data })`, `docSource.recordSync({ guildConfigId, commitSha })`, `docSource.recordError({ guildConfigId, message })`

- [ ] **Step 1: Write the migration**

Create `bot/src/Database/migrations/012_doc_pages.sql`:

```sql
-- Docs mirrored from the UBS-Doc repository, plus per-guild sync state.
-- Re-runnable: every statement is guarded on information_schema.

CREATE TABLE IF NOT EXISTS docpage (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  path VARCHAR(512) NOT NULL,
  docId VARCHAR(512) NOT NULL,
  section VARCHAR(128) NOT NULL,
  projectId VARCHAR(36) NULL,
  title VARCHAR(512) NOT NULL,
  content MEDIUMTEXT,
  source VARCHAR(16) NOT NULL DEFAULT 'repo',
  blobSha VARCHAR(64) NULL,
  size INT NOT NULL DEFAULT 0,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_docpage_path (guildConfigId, path),
  KEY idx_docpage_project (guildConfigId, projectId),
  KEY idx_docpage_section (guildConfigId, section),
  FULLTEXT KEY ft_docpage (title, content),
  FOREIGN KEY (guildConfigId) REFERENCES guildconfig(id) ON DELETE CASCADE,
  FOREIGN KEY (projectId) REFERENCES project(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS docsource (
  id VARCHAR(36) PRIMARY KEY,
  guildConfigId VARCHAR(36) NOT NULL,
  owner VARCHAR(255) NOT NULL,
  repo VARCHAR(255) NOT NULL,
  branch VARCHAR(255) NOT NULL DEFAULT 'main',
  siteUrl VARCHAR(512) NOT NULL,
  lastCommitSha VARCHAR(64) NULL,
  lastSyncedAt DATETIME(3) NULL,
  lastError TEXT NULL,
  createdAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_docsource_guild (guildConfigId),
  FOREIGN KEY (guildConfigId) REFERENCES guildconfig(id) ON DELETE CASCADE
);

SET @c1 = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project' AND COLUMN_NAME = 'docsSlug');
SET @s1 = IF(@c1 = 0, 'ALTER TABLE project ADD COLUMN docsSlug VARCHAR(128) NULL', 'SELECT 1');
PREPARE st1 FROM @s1;
EXECUTE st1;
DEALLOCATE PREPARE st1;

SET @c2 = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project' AND COLUMN_NAME = 'docsPaths');
SET @s2 = IF(@c2 = 0, 'ALTER TABLE project ADD COLUMN docsPaths JSON NULL', 'SELECT 1');
PREPARE st2 FROM @s2;
EXECUTE st2;
DEALLOCATE PREPARE st2;

-- Default every project's docsSlug from its name, then attach the HMS
-- engineering tree to Badar HMS. Both are no-ops if the rows are absent.
UPDATE project
SET docsSlug = LOWER(REPLACE(TRIM(name), ' ', '-'))
WHERE docsSlug IS NULL;

UPDATE project
SET docsPaths = JSON_ARRAY('hms-documentation')
WHERE name = 'Badar HMS' AND (docsPaths IS NULL OR JSON_LENGTH(docsPaths) = 0);
```

- [ ] **Step 2: Append the same tables to `schema.sql`**

Add both `CREATE TABLE IF NOT EXISTS` blocks (verbatim from step 1, without the `ALTER`/`UPDATE` statements) to the end of `bot/src/Database/schema.sql`, and add `docsSlug VARCHAR(128) NULL,` and `docsPaths JSON NULL,` to the existing `project` table definition in that file, so a fresh `npm run db:init` produces the same shape.

- [ ] **Step 3: Run the migration**

Run: `npm run db:migrate`
Expected: `Applied: 012_doc_pages.sql` then `Migrations complete. Applied 1 migration(s).`

Note: this runs against the shared production database at `20.120.228.55`. It is additive only — two new tables and two nullable columns — and re-runnable.

- [ ] **Step 4: Verify the schema landed**

Run:

```bash
node -e "
import('dotenv/config').then(async () => {
  const mysql=(await import('mysql2/promise')).default
  const u=new URL(process.env.DATABASE_URL)
  const c=await mysql.createConnection({host:u.hostname,port:u.port||3306,user:u.username,password:u.password,database:u.pathname.slice(1)})
  const [t]=await c.query(\"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('docpage','docsource')\")
  console.log('tables:', t.map(r=>r.TABLE_NAME))
  const [p]=await c.query('SELECT name, docsSlug, docsPaths FROM project ORDER BY name')
  p.forEach(r=>console.log(r.name,'|',r.docsSlug,'|',JSON.stringify(r.docsPaths)))
  await c.end()
})
"
```

Expected: both tables listed; every project has a `docsSlug`; `Badar HMS` shows `["hms-documentation"]`.

- [ ] **Step 5: Add the DB surface**

In `bot/src/Database/index.js`, add these functions near the other `ticketDoc*` functions (this file uses double quotes and semicolons — match that):

```js
async function docPageListIndex({ guildConfigId }) {
  return query(
    "SELECT id, path, docId, section, projectId, title, source FROM `docpage` WHERE guildConfigId = ? ORDER BY path",
    [guildConfigId],
  );
}

async function docPageFindByDocId({ guildConfigId, docId }) {
  return queryOne("SELECT * FROM `docpage` WHERE guildConfigId = ? AND docId = ?", [
    guildConfigId,
    docId,
  ]);
}

async function docPageSearch({ guildConfigId, q, limit = 25 }) {
  const term = String(q || "").trim();
  // mysql2 `execute` uses prepared statements, where a bound LIMIT parameter is
  // sent as a string and MySQL rejects it. Inline a sanitised integer instead.
  const cap = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 25);
  if (!term) {
    return query(
      `SELECT id, path, docId, section, projectId, title, source FROM \`docpage\` WHERE guildConfigId = ? ORDER BY title LIMIT ${cap}`,
      [guildConfigId],
    );
  }
  // FULLTEXT ignores tokens shorter than innodb_ft_min_token_size (3 by default),
  // so short queries fall back to a title LIKE.
  if (term.length < 3) {
    return query(
      `SELECT id, path, docId, section, projectId, title, source FROM \`docpage\` WHERE guildConfigId = ? AND title LIKE ? ORDER BY title LIMIT ${cap}`,
      [guildConfigId, `%${term}%`],
    );
  }
  const boolean = term.replace(/[+\-><()~*"@]/g, " ").trim().split(/\s+/).filter(Boolean).map((w) => `${w}*`).join(" ");
  const rows = boolean
    ? await query(
        `SELECT id, path, docId, section, projectId, title, source, MATCH(title, content) AGAINST (? IN BOOLEAN MODE) AS score FROM \`docpage\` WHERE guildConfigId = ? AND MATCH(title, content) AGAINST (? IN BOOLEAN MODE) ORDER BY score DESC LIMIT ${cap}`,
        [boolean, guildConfigId, boolean],
      )
    : [];
  if (rows.length) return rows;
  return query(
    `SELECT id, path, docId, section, projectId, title, source FROM \`docpage\` WHERE guildConfigId = ? AND title LIKE ? ORDER BY title LIMIT ${cap}`,
    [guildConfigId, `%${term}%`],
  );
}

async function docPageUpsert({ data }) {
  await query(
    "INSERT INTO `docpage` (id, guildConfigId, path, docId, section, projectId, title, content, source, blobSha, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE docId = VALUES(docId), section = VALUES(section), projectId = VALUES(projectId), title = VALUES(title), content = VALUES(content), source = VALUES(source), blobSha = VALUES(blobSha), size = VALUES(size)",
    [
      id(),
      data.guildConfigId,
      data.path,
      data.docId,
      data.section,
      data.projectId ?? null,
      data.title,
      data.content ?? null,
      data.source ?? "repo",
      data.blobSha ?? null,
      data.size ?? 0,
    ],
  );
}

async function docPageDeleteRepoPathsNotIn({ guildConfigId, paths }) {
  if (!paths || paths.length === 0) {
    const res = await query(
      "DELETE FROM `docpage` WHERE guildConfigId = ? AND source = 'repo'",
      [guildConfigId],
    );
    return res.affectedRows ?? 0;
  }
  const placeholders = paths.map(() => "?").join(", ");
  const res = await query(
    `DELETE FROM \`docpage\` WHERE guildConfigId = ? AND source = 'repo' AND path NOT IN (${placeholders})`,
    [guildConfigId, ...paths],
  );
  return res.affectedRows ?? 0;
}

async function docPageCountsByProject({ guildConfigId }) {
  return query(
    "SELECT projectId, COUNT(*) AS n FROM `docpage` WHERE guildConfigId = ? GROUP BY projectId",
    [guildConfigId],
  );
}

async function docSourceGet({ guildConfigId }) {
  return queryOne("SELECT * FROM `docsource` WHERE guildConfigId = ?", [guildConfigId]);
}

async function docSourceUpsert({ guildConfigId, data }) {
  await query(
    "INSERT INTO `docsource` (id, guildConfigId, owner, repo, branch, siteUrl) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE owner = VALUES(owner), repo = VALUES(repo), branch = VALUES(branch), siteUrl = VALUES(siteUrl)",
    [id(), guildConfigId, data.owner, data.repo, data.branch, data.siteUrl],
  );
  return docSourceGet({ guildConfigId });
}

async function docSourceRecordSync({ guildConfigId, commitSha }) {
  await query(
    "UPDATE `docsource` SET lastCommitSha = ?, lastSyncedAt = CURRENT_TIMESTAMP(3), lastError = NULL WHERE guildConfigId = ?",
    [commitSha, guildConfigId],
  );
}

async function docSourceRecordError({ guildConfigId, message }) {
  await query("UPDATE `docsource` SET lastError = ? WHERE guildConfigId = ?", [
    String(message || "").slice(0, 2000),
    guildConfigId,
  ]);
}
```

Then register them on the exported `db` object, immediately after the `ticketDoc: { ... }` block:

```js
  docPage: {
    listIndex: docPageListIndex,
    findByDocId: docPageFindByDocId,
    search: docPageSearch,
    upsert: docPageUpsert,
    deleteRepoPathsNotIn: docPageDeleteRepoPathsNotIn,
    countsByProject: docPageCountsByProject,
  },
  docSource: {
    get: docSourceGet,
    upsert: docSourceUpsert,
    recordSync: docSourceRecordSync,
    recordError: docSourceRecordError,
  },
```

- [ ] **Step 6: Verify the module still loads and the surface exists**

Run:

```bash
node -e "import('./bot/src/db/index.js').then(m => { const db = m.default; console.log('docPage:', Object.keys(db.docPage)); console.log('docSource:', Object.keys(db.docSource)) })"
```

Expected: both key lists printed, matching the Interfaces block above.

- [ ] **Step 7: Commit**

```bash
git add bot/src/Database/migrations/012_doc_pages.sql bot/src/Database/schema.sql bot/src/Database/index.js
git commit -m "feat: add docpage and docsource tables with db surface

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The sync service

Pure sync logic with injected I/O, so it is fully testable offline.

**Files:**
- Create: `bot/src/services/docsSync.js`
- Test: `bot/test/docsSync.test.js`

**Interfaces:**
- Consumes: `isDocFile`, `toDocId`, `sectionOf`, `extractTitle`, `attributeProject` from `../utils/docPath.js`; `db.docPage`, `db.docSource`, `db.project` from `../db/index.js`
- Produces:
  - `syncOnce({ guildConfigId, source, projects, deps }): Promise<{ skipped: boolean, upserted: number, deleted: number, commitSha: string }>` where `deps = { fetchHeadSha, fetchTree, fetchRaw, db }`
  - `startDocsSync(client): void`
  - also adds `db.docPage.listIndexFull({ guildConfigId })` (index rows plus `blobSha`), which the sync needs and `listIndex` deliberately omits
  - `syncGuildNow(guildId): Promise<object>` — used by the `/setup` button

- [ ] **Step 1: Write the failing test**

Create `bot/test/docsSync.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { syncOnce } from '../src/services/docsSync.js'

function makeDb(existing = []) {
  const calls = { upserts: [], deletedNotIn: null, sync: null, error: null }
  return {
    calls,
    docPage: {
      listIndexFull: async () => existing,
      upsert: async ({ data }) => calls.upserts.push(data),
      deleteRepoPathsNotIn: async ({ paths }) => {
        calls.deletedNotIn = paths
        return existing.filter((r) => r.source === 'repo' && !paths.includes(r.path)).length
      },
    },
    docSource: {
      recordSync: async (a) => (calls.sync = a),
      recordError: async (a) => (calls.error = a),
    },
  }
}

const SOURCE = {
  owner: 'Aashir-Adnan',
  repo: 'UBS-Doc',
  branch: 'main',
  siteUrl: 'https://ubs-doc.vercel.app',
  lastCommitSha: 'old-sha',
}

const TREE = [
  { path: 'docs/api/overview.md', type: 'blob', sha: 'sha-a', size: 10 },
  { path: 'docs/projects/badar-hms/Opera_Config.md', type: 'blob', sha: 'sha-b', size: 20 },
  { path: 'docs/superpowers/x/SKILL.md', type: 'blob', sha: 'sha-c', size: 5 },
  { path: 'docs/api/_category_.json', type: 'blob', sha: 'sha-d', size: 5 },
  { path: 'src/docs/sidebar.ts', type: 'blob', sha: 'sha-e', size: 5 },
]

const PROJECTS = [{ id: 'p1', docsSlug: 'badar-hms', docsPaths: ['hms-documentation'] }]

test('unchanged head sha short-circuits without fetching the tree', async () => {
  const db = makeDb()
  let treeFetched = false
  const res = await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'old-sha',
      fetchTree: async () => {
        treeFetched = true
        return TREE
      },
      fetchRaw: async () => '',
    },
  })
  assert.equal(res.skipped, true)
  assert.equal(treeFetched, false)
  assert.equal(db.calls.upserts.length, 0)
})

test('a fresh sync upserts only routable docs', async () => {
  const db = makeDb()
  const res = await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'new-sha',
      fetchTree: async () => TREE,
      fetchRaw: async (path) => `# Title for ${path}\n\nbody\n`,
    },
  })
  assert.equal(res.skipped, false)
  assert.equal(db.calls.upserts.length, 2)
  const paths = db.calls.upserts.map((u) => u.path).sort()
  assert.deepEqual(paths, ['docs/api/overview.md', 'docs/projects/badar-hms/Opera_Config.md'])
  const opera = db.calls.upserts.find((u) => u.path.includes('Opera_Config'))
  assert.equal(opera.projectId, 'p1')
  assert.equal(opera.docId, 'projects/badar-hms/Opera_Config')
  assert.equal(opera.source, 'repo')
  assert.equal(opera.blobSha, 'sha-b')
  const overview = db.calls.upserts.find((u) => u.path === 'docs/api/overview.md')
  assert.equal(overview.projectId, null)
  assert.equal(overview.section, 'api')
})

test('an unchanged blob sha is not re-fetched', async () => {
  const db = makeDb([
    { path: 'docs/api/overview.md', blobSha: 'sha-a', source: 'repo' },
    { path: 'docs/projects/badar-hms/Opera_Config.md', blobSha: 'stale', source: 'repo' },
  ])
  const fetched = []
  await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'new-sha',
      fetchTree: async () => TREE,
      fetchRaw: async (path) => {
        fetched.push(path)
        return '# T\n'
      },
    },
  })
  assert.deepEqual(fetched, ['docs/projects/badar-hms/Opera_Config.md'])
  assert.equal(db.calls.upserts.length, 1)
})

test('deletion is scoped to repo paths still present in the tree', async () => {
  const db = makeDb([{ path: 'docs/api/gone.md', blobSha: 'x', source: 'repo' }])
  await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'new-sha',
      fetchTree: async () => TREE,
      fetchRaw: async () => '# T\n',
    },
  })
  assert.deepEqual(db.calls.deletedNotIn.sort(), [
    'docs/api/overview.md',
    'docs/projects/badar-hms/Opera_Config.md',
  ])
})

test('the head sha is recorded after a successful sync', async () => {
  const db = makeDb()
  await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => 'new-sha',
      fetchTree: async () => TREE,
      fetchRaw: async () => '# T\n',
    },
  })
  assert.deepEqual(db.calls.sync, { guildConfigId: 'g1', commitSha: 'new-sha' })
  assert.equal(db.calls.error, null)
})

test('a fetch failure records the error and does not throw', async () => {
  const db = makeDb()
  const res = await syncOnce({
    guildConfigId: 'g1',
    source: SOURCE,
    projects: PROJECTS,
    deps: {
      db,
      fetchHeadSha: async () => {
        throw new Error('403 rate limited')
      },
      fetchTree: async () => TREE,
      fetchRaw: async () => '',
    },
  })
  assert.equal(res.failed, true)
  assert.match(db.calls.error.message, /rate limited/)
  assert.equal(db.calls.sync, null)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/services/docsSync.js'`

- [ ] **Step 3: Write the implementation**

Create `bot/src/services/docsSync.js`:

```js
import fetch from 'node-fetch'
import db from '../db/index.js'
import { getOrCreateGuildConfig } from '../db/index.js'
import { isDocFile, toDocId, sectionOf, extractTitle, attributeProject, slugify } from '../utils/docPath.js'

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
const INTERVAL_MS = Number(process.env.DOCS_SYNC_INTERVAL_MS || 15 * 60 * 1000)

export const DEFAULT_SOURCE = {
  owner: process.env.DOCS_REPO_OWNER || 'Aashir-Adnan',
  repo: process.env.DOCS_REPO_NAME || 'UBS-Doc',
  branch: process.env.DOCS_REPO_BRANCH || 'main',
  siteUrl: process.env.DOCS_SITE_URL || 'https://ubs-doc.vercel.app',
}

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN || ''
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'granjur-bot' }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/** Head commit sha of the branch. One API call. */
export async function fetchHeadSha({ owner, repo, branch }) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/commits/${branch}`, { headers: ghHeaders() })
  if (!res.ok) throw new Error(`GitHub commits ${res.status}: ${await res.text()}`)
  const json = await res.json()
  return json.sha
}

/** Every blob in the branch, recursively. One API call. */
export async function fetchTree({ owner, repo, branch }) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { headers: ghHeaders() })
  if (!res.ok) throw new Error(`GitHub tree ${res.status}: ${await res.text()}`)
  const json = await res.json()
  if (json.truncated) console.warn('[docsSync] tree response was truncated')
  return json.tree || []
}

/** File content from raw.githubusercontent — not subject to the API rate limit. */
export async function fetchRaw(path, { owner, repo, branch }) {
  const res = await fetch(`${RAW}/${owner}/${repo}/${branch}/${path}`)
  if (!res.ok) throw new Error(`raw ${res.status} for ${path}`)
  return res.text()
}

/**
 * One sync pass for one guild. All I/O is injected so this is testable offline.
 * Never throws: a failure is recorded on docsource and reported in the result.
 */
export async function syncOnce({ guildConfigId, source, projects, deps }) {
  const { fetchHeadSha: head, fetchTree: tree, fetchRaw: raw, db: database } = deps
  try {
    const commitSha = await head(source)
    if (commitSha && commitSha === source.lastCommitSha) {
      return { skipped: true, failed: false, upserted: 0, deleted: 0, commitSha }
    }

    const entries = await tree(source)
    const docs = entries.filter((e) => e.type === 'blob' && isDocFile(e.path))

    const existing = await database.docPage.listIndexFull({ guildConfigId })
    const shaByPath = new Map(existing.filter((r) => r.source === 'repo').map((r) => [r.path, r.blobSha]))

    let upserted = 0
    for (const entry of docs) {
      if (shaByPath.get(entry.path) === entry.sha) continue
      const content = await raw(entry.path, source)
      await database.docPage.upsert({
        data: {
          guildConfigId,
          path: entry.path,
          docId: toDocId(entry.path),
          section: sectionOf(entry.path),
          projectId: attributeProject(entry.path, projects),
          title: extractTitle(content, entry.path),
          content,
          source: 'repo',
          blobSha: entry.sha,
          size: entry.size || content.length,
        },
      })
      upserted++
    }

    const deleted = await database.docPage.deleteRepoPathsNotIn({
      guildConfigId,
      paths: docs.map((d) => d.path),
    })

    await database.docSource.recordSync({ guildConfigId, commitSha })
    return { skipped: false, failed: false, upserted, deleted, commitSha }
  } catch (err) {
    await database.docSource.recordError({ guildConfigId, message: err.message }).catch(() => {})
    return { skipped: false, failed: true, upserted: 0, deleted: 0, error: err.message }
  }
}

/** Resolve (and lazily create) the docsource row for a guild. */
async function ensureSource(guildConfigId) {
  const existing = await db.docSource.get({ guildConfigId })
  if (existing) return existing
  return db.docSource.upsert({ guildConfigId, data: DEFAULT_SOURCE })
}

async function projectsFor(guildConfigId) {
  const rows = await db.project.findMany({ where: { guildConfigId } })
  return rows.map((p) => ({
    id: p.id,
    docsSlug: p.docsSlug || slugify(p.name),
    docsPaths: Array.isArray(p.docsPaths) ? p.docsPaths : JSON.parse(p.docsPaths || '[]'),
  }))
}

/** Sync one guild now. Used by the /setup button and by the interval loop. */
export async function syncGuildNow(guildId) {
  const cfg = await getOrCreateGuildConfig(guildId)
  if (!cfg) return { failed: true, error: 'guild not initialized' }
  const source = await ensureSource(cfg.id)
  const projects = await projectsFor(cfg.id)
  return syncOnce({
    guildConfigId: cfg.id,
    source,
    projects,
    deps: { db, fetchHeadSha, fetchTree, fetchRaw },
  })
}

/** Start the background sync loop. Runs once on start, then every INTERVAL_MS. */
export function startDocsSync(client) {
  if (!client?.guilds) return
  const runAll = async () => {
    for (const [guildId] of client.guilds.cache) {
      try {
        const res = await syncGuildNow(guildId)
        if (res.failed) console.error('[docsSync]', guildId, res.error)
        else if (!res.skipped) console.log(`[docsSync] ${guildId}: +${res.upserted} -${res.deleted}`)
      } catch (err) {
        console.error('[docsSync] loop error:', err)
      }
    }
  }
  runAll()
  setInterval(runAll, INTERVAL_MS)
}
```

- [ ] **Step 4: Add the missing `listIndexFull` DB function**

The sync needs `blobSha` per path, which `listIndex` deliberately omits. In `bot/src/Database/index.js`, next to the other `docPage*` functions:

```js
async function docPageListIndexFull({ guildConfigId }) {
  return query(
    "SELECT id, path, docId, section, projectId, title, source, blobSha FROM `docpage` WHERE guildConfigId = ?",
    [guildConfigId],
  );
}
```

and add `listIndexFull: docPageListIndexFull,` to the `docPage` block on `db`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 28 tests total.

- [ ] **Step 6: Commit**

```bash
git add bot/src/services/docsSync.js bot/test/docsSync.test.js bot/src/Database/index.js
git commit -m "feat: add UBS-Doc sync service with injectable I/O

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Start the sync loop and add the manual trigger

**Files:**
- Modify: `bot/src/index.js` (import + start, next to the other services)
- Modify: `bot/src/commands/setup.js` (a "Sync docs now" button on the settings embed, and doc status fields)
- Modify: `bot/src/handlers/interactions.js` (route the new button)

**Interfaces:**
- Consumes: `startDocsSync`, `syncGuildNow` from `../services/docsSync.js`; `db.docSource.get`
- Produces: `setupCmd.handleDocsSync(interaction)` — routed on customId `setup_docs_sync`

- [ ] **Step 1: Start the service**

In `bot/src/index.js`, add the import next to the other service imports (around line 18):

```js
import { startDocsSync } from "./services/docsSync.js";
```

and start it inside `Events.ClientReady`, after `startTicketReminder(client);`:

```js
  startDocsSync(client);
```

- [ ] **Step 2: Add doc status and the sync button to `/setup`**

In `bot/src/commands/setup.js`, extend the imports:

```js
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import db, { getOrCreateGuildConfig, updateGuildConfig } from "../db/index.js";
import { syncGuildNow } from "../services/docsSync.js";
```

In `execute`, in the "No options -> show current settings" branch, after the existing `Timezone` field, add a documentation field and a button row. Replace the final `return interaction.editReply({ embeds: [embed] }).catch(() => {});` with:

```js
  const src = await db.docSource.get({ guildConfigId: cfg.id }).catch(() => null);
  const counts = await db.docPage.countsByProject({ guildConfigId: cfg.id }).catch(() => []);
  const total = counts.reduce((n, r) => n + Number(r.n || 0), 0);
  embed.addFields({
    name: "Documentation",
    value: src
      ? `${total} page(s) from \`${src.owner}/${src.repo}\`\nLast synced: ${src.lastSyncedAt ? `<t:${Math.floor(new Date(src.lastSyncedAt).getTime() / 1000)}:R>` : "_never_"}${src.lastError ? `\nLast error: \`${String(src.lastError).slice(0, 200)}\`` : ""}`
      : "_not configured — press Sync to set it up_",
    inline: false,
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("setup_docs_sync")
      .setLabel("Sync docs now")
      .setStyle(ButtonStyle.Primary),
  );

  return interaction.editReply({ embeds: [embed], components: [row] }).catch(() => {});
```

Then add the handler at the end of the file:

```js
export async function handleDocsSync(interaction) {
  const guild = interaction.guild;
  if (!guild) return;
  await interaction
    .editReply({ content: "Syncing documentation…", embeds: [], components: [] })
    .catch(() => {});
  const res = await syncGuildNow(guild.id);
  const text = res.failed
    ? `Sync failed: \`${res.error}\``
    : res.skipped
      ? "Already up to date — no changes since the last sync."
      : `Synced. ${res.upserted} page(s) added or updated, ${res.deleted} removed.`;
  return interaction.editReply({ content: text }).catch(() => {});
}
```

- [ ] **Step 3: Route the button**

In `bot/src/handlers/interactions.js`, in the button section next to the other `setup`-adjacent routes (near the `doc_traversal_refresh` route around line 203), add:

```js
    if (customId === "setup_docs_sync")
      return (await import("../commands/setup.js")).handleDocsSync(interaction);
```

- [ ] **Step 4: Verify everything still loads and the commands still build**

Run:

```bash
node --check bot/src/index.js && node --check bot/src/commands/setup.js && node --check bot/src/handlers/interactions.js && node -e "import('./bot/src/commands/index.js').then(m => console.log('commands:', m.getCommands().map(c => c.toJSON()).length))"
```

Expected: no syntax errors, `commands: 36`.

- [ ] **Step 5: Run a real sync against the live repository**

Run:

```bash
node -e "
import('dotenv/config').then(async () => {
  const { syncOnce, fetchHeadSha, fetchTree, fetchRaw, DEFAULT_SOURCE } = await import('./bot/src/services/docsSync.js')
  const db = (await import('./bot/src/db/index.js')).default
  const { getOrCreateGuildConfig } = await import('./bot/src/db/index.js')
  const cfg = await getOrCreateGuildConfig(process.env.DISCORD_GUILD_ID)
  const source = (await db.docSource.get({ guildConfigId: cfg.id })) || (await db.docSource.upsert({ guildConfigId: cfg.id, data: DEFAULT_SOURCE }))
  const rows = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  const projects = rows.map(p => ({ id: p.id, docsSlug: p.docsSlug, docsPaths: Array.isArray(p.docsPaths) ? p.docsPaths : JSON.parse(p.docsPaths || '[]') }))
  console.log(await syncOnce({ guildConfigId: cfg.id, source, projects, deps: { db, fetchHeadSha, fetchTree, fetchRaw } }))
  const idx = await db.docPage.listIndex({ guildConfigId: cfg.id })
  console.log('rows:', idx.length, '| attributed to a project:', idx.filter(r => r.projectId).length)
  process.exit(0)
})
"
```

Expected: `upserted: 173`, then `rows: 173 | attributed to a project: 138` (132 under `hms-documentation` plus 6 under `projects/badar-hms`). If `attributed` is 0, migration 012's `UPDATE` did not run — re-check Task 3 step 4.

- [ ] **Step 6: Commit**

```bash
git add bot/src/index.js bot/src/commands/setup.js bot/src/handlers/interactions.js
git commit -m "feat: start docs sync loop and add manual sync to /setup

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Doc tree builder

The pure logic behind the browse menus, split out of the command so it can be tested.

**Files:**
- Create: `bot/src/utils/docTree.js`
- Test: `bot/test/docTree.test.js`

**Interfaces:**
- Consumes: nothing (operates on the plain index rows from `db.docPage.listIndex`)
- Produces:
  - `rootOptions(index, projects): Array<{label, value, description}>` — values are `proj:<projectId>` and `sec:<section>`
  - `childOptions(index, { scope, prefix, page }): { options, hasMore, total }` — values are `dir:<prefix>`, `doc:<docId>`, `back:<prefix>`, `more:<prefix>:<page>`

- [ ] **Step 1: Write the failing test**

Create `bot/test/docTree.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { rootOptions, childOptions } from '../src/utils/docTree.js'

const INDEX = [
  { path: 'docs/api/overview.md', docId: 'api/overview', section: 'api', projectId: null, title: 'Overview', source: 'repo' },
  { path: 'docs/api/permissions.md', docId: 'api/permissions', section: 'api', projectId: null, title: 'Permissions', source: 'repo' },
  { path: 'docs/hms-documentation/admin-apis/rooms.md', docId: 'hms-documentation/admin-apis/rooms', section: 'hms-documentation', projectId: 'p1', title: 'Rooms', source: 'repo' },
  { path: 'docs/projects/badar-hms/Opera_Config.md', docId: 'projects/badar-hms/Opera_Config', section: 'projects', projectId: 'p1', title: 'Opera Config', source: 'repo' },
  { path: 'docs/projects/badar-hms/notes.md', docId: 'projects/badar-hms/notes', section: 'projects', projectId: 'p1', title: 'Notes', source: 'local' },
]

const PROJECTS = [{ id: 'p1', name: 'Badar HMS' }, { id: 'p2', name: 'CSAAS' }]

test('rootOptions lists projects that have docs, then sections', () => {
  const opts = rootOptions(INDEX, PROJECTS)
  const values = opts.map((o) => o.value)
  assert.ok(values.includes('proj:p1'))
  assert.equal(values.includes('proj:p2'), false, 'a project with no docs is not offered')
  assert.ok(values.includes('sec:api'))
  assert.equal(values.indexOf('proj:p1') < values.indexOf('sec:api'), true, 'projects come first')
})

test('rootOptions shows the doc count in the description', () => {
  const opts = rootOptions(INDEX, PROJECTS)
  const p1 = opts.find((o) => o.value === 'proj:p1')
  assert.match(p1.description, /3 page/)
})

test('childOptions on a project lists its immediate directories and files', () => {
  const { options } = childOptions(INDEX, { scope: 'proj:p1', prefix: '' })
  const values = options.map((o) => o.value)
  assert.ok(values.includes('dir:hms-documentation'))
  assert.ok(values.includes('dir:projects'))
  assert.equal(values.some((v) => v.startsWith('doc:')), false, 'no files at this level')
})

test('childOptions descends into a directory and lists files', () => {
  const { options } = childOptions(INDEX, { scope: 'proj:p1', prefix: 'projects/badar-hms' })
  const values = options.map((o) => o.value)
  assert.ok(values.includes('doc:projects/badar-hms/Opera_Config'))
  assert.ok(values.includes('doc:projects/badar-hms/notes'))
  assert.equal(values[0].startsWith('back:'), true, 'first option goes back')
})

test('childOptions marks local docs', () => {
  const { options } = childOptions(INDEX, { scope: 'proj:p1', prefix: 'projects/badar-hms' })
  const notes = options.find((o) => o.value === 'doc:projects/badar-hms/notes')
  assert.match(notes.label, /📝/)
})

test('childOptions on a section scopes to that section only', () => {
  const { options } = childOptions(INDEX, { scope: 'sec:api', prefix: '' })
  const values = options.map((o) => o.value)
  assert.deepEqual(values.sort(), ['doc:api/overview', 'doc:api/permissions'])
})

test('childOptions pages when there are more than 25 entries', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    path: `docs/api/f${i}.md`,
    docId: `api/f${i}`,
    section: 'api',
    projectId: null,
    title: `File ${i}`,
    source: 'repo',
  }))
  const first = childOptions(many, { scope: 'sec:api', prefix: '', page: 0 })
  assert.equal(first.options.length, 25)
  assert.equal(first.hasMore, true)
  assert.equal(first.options[24].value, 'more:api:1')
  const second = childOptions(many, { scope: 'sec:api', prefix: '', page: 1 })
  assert.equal(second.options[0].value.startsWith('doc:'), true)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/utils/docTree.js'`

- [ ] **Step 3: Write the implementation**

Create `bot/src/utils/docTree.js`:

```js
/**
 * Pure select-menu construction for the /docs browser.
 * Operates on the lightweight index rows from db.docPage.listIndex
 * ({ path, docId, section, projectId, title, source }).
 */

const MAX_OPTIONS = 25
const LABEL_MAX = 100

function relOf(row) {
  return row.docId
}

function scopeRows(index, scope) {
  if (scope.startsWith('proj:')) {
    const projectId = scope.slice(5)
    return index.filter((r) => r.projectId === projectId)
  }
  if (scope.startsWith('sec:')) {
    const section = scope.slice(4)
    return index.filter((r) => !r.projectId && r.section === section)
  }
  return index
}

/** Root menu: projects that own docs, then unattributed sections. */
export function rootOptions(index, projects) {
  const options = []

  const byProject = new Map()
  for (const r of index) if (r.projectId) byProject.set(r.projectId, (byProject.get(r.projectId) || 0) + 1)
  for (const p of projects || []) {
    const n = byProject.get(p.id)
    if (!n) continue
    options.push({
      label: `📁 ${p.name}`.slice(0, LABEL_MAX),
      value: `proj:${p.id}`,
      description: `${n} page${n === 1 ? '' : 's'}`,
    })
  }

  const bySection = new Map()
  for (const r of index) if (!r.projectId) bySection.set(r.section, (bySection.get(r.section) || 0) + 1)
  for (const [section, n] of [...bySection.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    options.push({
      label: `📚 ${section}`.slice(0, LABEL_MAX),
      value: `sec:${section}`,
      description: `${n} page${n === 1 ? '' : 's'}`,
    })
  }

  return options.slice(0, MAX_OPTIONS)
}

/**
 * One level of the tree inside a scope.
 * `prefix` is a docId prefix (no trailing slash); '' is the scope root.
 */
export function childOptions(index, { scope, prefix = '', page = 0 }) {
  const rows = scopeRows(index, scope)
  const base = prefix ? `${prefix}/` : ''

  const dirs = new Set()
  const files = []
  for (const r of rows) {
    const rel = relOf(r)
    if (base && !rel.startsWith(base)) continue
    const rest = rel.slice(base.length)
    if (!rest) continue
    const slash = rest.indexOf('/')
    if (slash === -1) files.push(r)
    else dirs.add(rest.slice(0, slash))
  }

  const entries = []
  for (const d of [...dirs].sort((a, b) => a.localeCompare(b))) {
    entries.push({
      label: `📁 ${d}`.slice(0, LABEL_MAX),
      value: `dir:${base}${d}`,
      description: 'Open folder',
    })
  }
  for (const f of files.sort((a, b) => a.title.localeCompare(b.title))) {
    const mark = f.source === 'local' ? '📝' : '📄'
    entries.push({
      label: `${mark} ${f.title}`.slice(0, LABEL_MAX),
      value: `doc:${f.docId}`,
      description: f.docId.slice(0, 100),
    })
  }

  const options = []
  if (prefix) {
    const parent = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : ''
    options.push({
      label: '← Back',
      value: `back:${parent}`,
      description: parent || 'Back to the top',
    })
  }

  const room = MAX_OPTIONS - options.length
  const start = page * (room - 1)
  const slice = entries.slice(start, start + room)
  const hasMore = entries.length > start + slice.length

  if (hasMore) {
    options.push(...slice.slice(0, room - 1))
    options.push({
      label: `→ Next ${Math.min(room - 1, entries.length - start - (room - 1))} of ${entries.length}`.slice(0, LABEL_MAX),
      value: `more:${prefix}:${page + 1}`,
      description: 'Show more entries',
    })
  } else {
    options.push(...slice)
  }

  return { options, hasMore, total: entries.length }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 35 tests total.

- [ ] **Step 5: Commit**

```bash
git add bot/src/utils/docTree.js bot/test/docTree.test.js
git commit -m "feat: add pure doc tree builder for the /docs browser

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Rebuild `/docs`

**Files:**
- Modify (rewrite): `bot/src/commands/docs.js`
- Modify: `bot/src/handlers/interactions.js` (add the paging buttons; `docs_browse` is already routed at line 289)

**Interfaces:**
- Consumes: `db.docPage.listIndex / findByDocId / search`, `db.docSource.get`, `db.project.findMany`, `rootOptions`/`childOptions`, `renderForDiscord`/`paginate`/`docUrl`
- Produces:
  - `data` — `/docs` with one optional autocompleted string option `query`
  - `autocomplete(interaction)`
  - `execute(interaction)`
  - `handleDocsBrowse(interaction)` — select `docs_browse`
  - `handleDocsPage(interaction)` — buttons `docs_page_prev:<docId>:<n>` and `docs_page_next:<docId>:<n>`

- [ ] **Step 1: Rewrite the command**

Replace the entire contents of `bot/src/commands/docs.js`:

```js
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { rootOptions, childOptions } from '../utils/docTree.js'
import { renderForDiscord, paginate, docUrl } from '../utils/docRender.js'
import { DEFAULT_SOURCE } from '../services/docsSync.js'

const SELECT_ID = 'docs_browse'
const PAGE_CHARS = 3800

export const data = new SlashCommandBuilder()
  .setName('docs')
  .setDescription('Browse project and framework documentation')
  .addStringOption((o) =>
    o
      .setName('query')
      .setDescription('Search documentation by title or content')
      .setRequired(false)
      .setAutocomplete(true)
  )

async function context(interaction) {
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  const source = (await db.docSource.get({ guildConfigId: cfg.id })) || DEFAULT_SOURCE
  return { cfg, source }
}

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true)
  if (focused.name !== 'query') return interaction.respond([]).catch(() => {})
  try {
    const cfg = await getOrCreateGuildConfig(interaction.guild.id)
    const rows = await db.docPage.search({ guildConfigId: cfg.id, q: focused.value, limit: 25 })
    return interaction
      .respond(rows.map((r) => ({ name: r.title.slice(0, 100), value: r.docId.slice(0, 100) })))
      .catch(() => {})
  } catch {
    return interaction.respond([]).catch(() => {})
  }
}

/** Build the embed + components for one page of one doc. */
function docPayload(row, source, page) {
  const rendered = renderForDiscord(row.content, { siteUrl: source.siteUrl, docId: row.docId })
  const pages = paginate(rendered, PAGE_CHARS)
  const n = Math.min(Math.max(page, 0), pages.length - 1)

  const embed = new EmbedBuilder()
    .setTitle(row.title.slice(0, 256))
    .setDescription(pages[n] || '_empty_')
    .setColor(0x5865f2)
    .setFooter({ text: `${row.docId} — page ${n + 1}/${pages.length}` })

  const buttons = []
  if (pages.length > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`docs_page_prev:${row.docId}:${n}`)
        .setLabel('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(n === 0),
      new ButtonBuilder()
        .setCustomId(`docs_page_next:${row.docId}:${n}`)
        .setLabel('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(n >= pages.length - 1)
    )
  }
  if (row.source !== 'local') {
    buttons.push(
      new ButtonBuilder()
        .setLabel('Read full page ↗')
        .setStyle(ButtonStyle.Link)
        .setURL(docUrl(source.siteUrl, row.docId))
    )
  }

  const components = buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : []
  return { embeds: [embed], components, content: null }
}

async function browsePayload(cfg, scope, prefix, page) {
  const index = await db.docPage.listIndex({ guildConfigId: cfg.id })
  if (index.length === 0) {
    return {
      content: 'No documentation synced yet. A manager can run **/setup** and press **Sync docs now**.',
      embeds: [],
      components: [],
    }
  }

  let options
  let heading
  if (!scope) {
    const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
    options = rootOptions(index, projects)
    heading = 'Select a project or a documentation section.'
  } else {
    const res = childOptions(index, { scope, prefix, page })
    options = res.options
    heading = prefix ? `**${prefix}**` : 'Select a folder or a page.'
  }

  if (options.length === 0) {
    return { content: 'Nothing here.', embeds: [], components: [] }
  }

  const embed = new EmbedBuilder()
    .setTitle('📚 Documentation')
    .setDescription(heading)
    .setColor(0x5865f2)

  const select = new StringSelectMenuBuilder()
    .setCustomId(scope ? `${SELECT_ID}:${scope}` : SELECT_ID)
    .setPlaceholder('Choose…')
    .addOptions(options.slice(0, 25))

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], content: null }
}

export async function execute(interaction) {
  if (!interaction.guild) return interaction.editReply({ content: 'Use this in a server.' })
  const { cfg, source } = await context(interaction)

  const q = interaction.options.getString('query')
  if (q) {
    let row = await db.docPage.findByDocId({ guildConfigId: cfg.id, docId: q })
    if (!row) {
      const hits = await db.docPage.search({ guildConfigId: cfg.id, q, limit: 1 })
      if (hits.length) row = await db.docPage.findByDocId({ guildConfigId: cfg.id, docId: hits[0].docId })
    }
    if (!row) {
      return interaction.editReply({ content: `No documentation found for **${q}**.` }).catch(() => {})
    }
    return interaction.editReply(docPayload(row, source, 0)).catch(() => {})
  }

  return interaction.editReply(await browsePayload(cfg, null, '', 0)).catch(() => {})
}

export async function handleDocsBrowse(interaction) {
  if (!interaction.guild) return
  const { cfg, source } = await context(interaction)
  const value = interaction.values?.[0]
  if (!value) return

  const scopeFromId = interaction.customId.startsWith(`${SELECT_ID}:`)
    ? interaction.customId.slice(SELECT_ID.length + 1)
    : null

  if (value.startsWith('proj:') || value.startsWith('sec:')) {
    return interaction.editReply(await browsePayload(cfg, value, '', 0)).catch(() => {})
  }
  if (value.startsWith('dir:')) {
    return interaction.editReply(await browsePayload(cfg, scopeFromId, value.slice(4), 0)).catch(() => {})
  }
  if (value.startsWith('back:')) {
    const parent = value.slice(5)
    if (!parent) return interaction.editReply(await browsePayload(cfg, null, '', 0)).catch(() => {})
    return interaction.editReply(await browsePayload(cfg, scopeFromId, parent, 0)).catch(() => {})
  }
  if (value.startsWith('more:')) {
    const rest = value.slice(5)
    const lastColon = rest.lastIndexOf(':')
    const prefix = rest.slice(0, lastColon)
    const page = Number(rest.slice(lastColon + 1)) || 0
    return interaction.editReply(await browsePayload(cfg, scopeFromId, prefix, page)).catch(() => {})
  }
  if (value.startsWith('doc:')) {
    const docId = value.slice(4)
    const row = await db.docPage.findByDocId({ guildConfigId: cfg.id, docId })
    if (!row) {
      const src = await db.docSource.get({ guildConfigId: cfg.id })
      const when = src?.lastSyncedAt ? ` (last synced <t:${Math.floor(new Date(src.lastSyncedAt).getTime() / 1000)}:R>)` : ''
      return interaction
        .editReply({ content: `That page is not available — docs may be out of date${when}.`, embeds: [], components: [] })
        .catch(() => {})
    }
    return interaction.editReply(docPayload(row, source, 0)).catch(() => {})
  }

  return interaction.editReply({ content: 'Unknown selection.', components: [] }).catch(() => {})
}

export async function handleDocsPage(interaction) {
  if (!interaction.guild) return
  const { cfg, source } = await context(interaction)
  const [action, ...rest] = interaction.customId.split(':')
  const page = Number(rest.pop())
  const docId = rest.join(':')
  const row = await db.docPage.findByDocId({ guildConfigId: cfg.id, docId })
  if (!row) return interaction.editReply({ content: 'That page is no longer available.' }).catch(() => {})
  const next = action === 'docs_page_next' ? page + 1 : page - 1
  return interaction.editReply(docPayload(row, source, next)).catch(() => {})
}
```

- [ ] **Step 2: Route the paging buttons**

In `bot/src/handlers/interactions.js`, in the button section, add next to the existing `docs`-related routes:

```js
    if (customId.startsWith("docs_page_prev:") || customId.startsWith("docs_page_next:"))
      return (await import("../commands/docs.js")).handleDocsPage(interaction);
```

Also change the existing `docs_browse` select route (line 289) to match the scoped custom id:

```js
    if (customId === "docs_browse" || customId.startsWith("docs_browse:"))
```

- [ ] **Step 3: Verify the command builds and the autocomplete is registered**

Run:

```bash
node --check bot/src/commands/docs.js && node -e "
import('./bot/src/commands/index.js').then(m => {
  const docs = m.getCommands().map(c => c.toJSON()).find(c => c.name === 'docs')
  console.log(JSON.stringify(docs, null, 2))
})
"
```

Expected: one option named `query`, `autocomplete: true`, `required: false`.

- [ ] **Step 4: Verify a real doc renders end to end**

Run:

```bash
node -e "
import('dotenv/config').then(async () => {
  const db = (await import('./bot/src/db/index.js')).default
  const { getOrCreateGuildConfig } = await import('./bot/src/db/index.js')
  const { renderForDiscord, paginate, docUrl } = await import('./bot/src/utils/docRender.js')
  const cfg = await getOrCreateGuildConfig(process.env.DISCORD_GUILD_ID)
  const src = await db.docSource.get({ guildConfigId: cfg.id })
  const row = await db.docPage.findByDocId({ guildConfigId: cfg.id, docId: 'hms-documentation/tenant-creation-flow/04-services' })
  const pages = paginate(renderForDiscord(row.content, { siteUrl: src.siteUrl, docId: row.docId }), 3800)
  console.log('title:', row.title)
  console.log('pages:', pages.length, '| max page length:', Math.max(...pages.map(p => p.length)))
  console.log('url:', docUrl(src.siteUrl, row.docId))
  console.log('--- first 300 chars ---'); console.log(pages[0].slice(0, 300))
  process.exit(0)
})
"
```

Expected: a title, several dozen pages, **max page length at or below 3800**, and a URL that opens in a browser. If any page exceeds 3800 the embed will be rejected by Discord — fix `paginate` before continuing.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — 35 tests.

- [ ] **Step 6: Commit**

```bash
git add bot/src/commands/docs.js bot/src/handlers/interactions.js
git commit -m "feat: rebuild /docs on the synced corpus with search and paging

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `/projects` and the `/repos` project link

**Files:**
- Create: `bot/src/commands/projects.js`
- Modify: `bot/src/commands/index.js` (import + register)
- Modify: `bot/src/handlers/interactions.js` (route the new components)
- Modify: `bot/src/commands/repos.js:160` (write the project and the join row)
- Modify: `bot/src/Database/index.js` (extend `projectCreate`, add `projectFindByName`, `projectRepos.add`)
- Modify: `bot/src/config/command-config.json` (restrict `/projects` to CEO / Server Manager)

**Interfaces:**
- Consumes: `db.project.findMany / create`, `db.docPage.countsByProject`, `db.repository.findMany`
- Produces:
  - `db.project.findByName({ guildConfigId, name })`
  - `db.project.create({ data })` extended with `docsSlug` and `docsPaths`
  - `db.projectRepos.add({ projectId, repositoryId })`
  - `projectsCmd.execute`, `projectsCmd.handleAddButton`, `projectsCmd.handleAddModal`, `projectsCmd.handleLinkRepo`, `projectsCmd.handleLinkProject`

- [ ] **Step 1: Extend the database surface**

In `bot/src/Database/index.js`, replace `projectCreate` with:

```js
async function projectCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `project` (id, guildConfigId, name, readme, owner_emails, docsSlug, docsPaths) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      pk,
      data.guildConfigId,
      data.name,
      data.readme ?? null,
      data.owner_emails ?? null,
      data.docsSlug ?? null,
      JSON.stringify(data.docsPaths ?? []),
    ],
  );
  return queryOne("SELECT * FROM `project` WHERE id = ?", [pk]);
}

async function projectFindByName({ guildConfigId, name }) {
  return queryOne("SELECT * FROM `project` WHERE guildConfigId = ? AND name = ?", [
    guildConfigId,
    name,
  ]);
}

async function projectReposAdd({ projectId, repositoryId }) {
  await query(
    "INSERT IGNORE INTO `project_repos` (project_id, repository_id) VALUES (?, ?)",
    [projectId, repositoryId],
  );
}
```

Add `findByName: projectFindByName,` to the `project` block on `db`, and add `add: projectReposAdd,` to the existing `projectRepos` block.

- [ ] **Step 2: Create the command**

Create `bot/src/commands/projects.js`:

```js
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import * as flowStore from '../flows/store.js'
import { slugify } from '../utils/docPath.js'

export const data = new SlashCommandBuilder()
  .setName('projects')
  .setDescription('(CEO/Server Manager) List projects, add a project, link a repo')

async function listPayload(cfg) {
  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  const counts = await db.docPage.countsByProject({ guildConfigId: cfg.id })
  const byId = new Map(counts.map((c) => [c.projectId, Number(c.n)]))

  const embed = new EmbedBuilder()
    .setTitle('Projects')
    .setColor(0x5865f2)
    .setDescription(
      projects.length
        ? projects
            .map((p) => `**${p.name}** — \`${p.docsSlug || slugify(p.name)}\` — ${byId.get(p.id) || 0} doc page(s)`)
            .join('\n')
        : '_No projects yet._'
    )

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('projects_add').setLabel('Add project').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('projects_link_repo').setLabel('Link repo').setStyle(ButtonStyle.Secondary)
  )

  return { embeds: [embed], components: [row], content: null }
}

export async function execute(interaction) {
  if (!interaction.guild) return interaction.editReply({ content: 'Use this in a server.' })
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  return interaction.editReply(await listPayload(cfg)).catch(() => {})
}

export async function handleAddButton(interaction) {
  const modal = new ModalBuilder().setCustomId('projects_add_modal').setTitle('Add project')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('name')
        .setLabel('Project name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('slug')
        .setLabel('Docs folder under docs/projects/ (optional)')
        .setPlaceholder('leave blank to derive from the name')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('paths')
        .setLabel('Extra doc paths, comma separated (optional)')
        .setPlaceholder('hms-documentation')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
    )
  )
  return interaction.showModal(modal).catch(() => {})
}

export async function handleAddModal(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const cfg = await getOrCreateGuildConfig(guild.id)
  const name = interaction.fields.getTextInputValue('name').trim()
  const slug = (interaction.fields.getTextInputValue('slug') || '').trim() || slugify(name)
  const paths = (interaction.fields.getTextInputValue('paths') || '')
    .split(',')
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)

  const existing = await db.project.findByName({ guildConfigId: cfg.id, name })
  if (existing) {
    return interaction.editReply({ content: `**${name}** already exists.` }).catch(() => {})
  }

  await db.project.create({
    data: { guildConfigId: cfg.id, name, docsSlug: slug, docsPaths: paths },
  })

  return interaction
    .editReply({
      content: `Added **${name}** (docs folder \`docs/projects/${slug}/\`${paths.length ? `, plus ${paths.map((p) => `\`${p}\``).join(', ')}` : ''}). Run **/setup** → **Sync docs now** to attribute its pages.`,
    })
    .catch(() => {})
}

export async function handleLinkRepo(interaction) {
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  const repos = await db.repository.findMany({ where: { guildConfigId: cfg.id } })
  if (repos.length === 0) {
    return interaction.editReply({ content: 'No repositories yet — add one with **/repos**.', components: [] }).catch(() => {})
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId('projects_link_repo_select')
    .setPlaceholder('Choose a repository…')
    .addOptions(
      repos.slice(0, 25).map((r) => ({
        label: (r.name || '').slice(0, 100),
        value: r.id,
        description: (r.url || '').slice(0, 100),
      }))
    )
  return interaction
    .editReply({ content: 'Which repository?', embeds: [], components: [new ActionRowBuilder().addComponents(select)] })
    .catch(() => {})
}

export async function handleLinkRepoSelect(interaction) {
  const cfg = await getOrCreateGuildConfig(interaction.guild.id)
  flowStore.set(interaction.user.id, interaction.guild.id, 'projects_link', { repositoryId: interaction.values[0] })
  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  if (projects.length === 0) {
    return interaction.editReply({ content: 'No projects yet — add one first.', components: [] }).catch(() => {})
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId('projects_link_project_select')
    .setPlaceholder('Choose a project…')
    .addOptions(projects.slice(0, 25).map((p) => ({ label: p.name.slice(0, 100), value: p.id })))
  return interaction
    .editReply({ content: 'Link it to which project?', components: [new ActionRowBuilder().addComponents(select)] })
    .catch(() => {})
}

export async function handleLinkProjectSelect(interaction) {
  const state = flowStore.get(interaction.user.id, interaction.guild.id, 'projects_link')
  if (!state?.repositoryId) {
    return interaction.editReply({ content: 'That selection expired — start again with /projects.', components: [] }).catch(() => {})
  }
  await db.projectRepos.add({ projectId: interaction.values[0], repositoryId: state.repositoryId })
  flowStore.clear(interaction.user.id, interaction.guild.id, 'projects_link')
  return interaction.editReply({ content: 'Linked.', components: [] }).catch(() => {})
}
```

- [ ] **Step 3: Register the command**

In `bot/src/commands/index.js`, add the import next to the others:

```js
import * as projectsCmd from './projects.js'
```

and add `projectsCmd,` to the `commandModules` array (after `meetingsCmd,`).

- [ ] **Step 4: Route the components**

In `bot/src/handlers/interactions.js`:

Buttons:

```js
    if (customId === "projects_add")
      return (await import("../commands/projects.js")).handleAddButton(interaction);
    if (customId === "projects_link_repo")
      return (await import("../commands/projects.js")).handleLinkRepo(interaction);
```

Selects:

```js
    if (customId === "projects_link_repo_select")
      return (await import("../commands/projects.js")).handleLinkRepoSelect(interaction);
    if (customId === "projects_link_project_select")
      return (await import("../commands/projects.js")).handleLinkProjectSelect(interaction);
```

Modals:

```js
    if (customId === "projects_add_modal")
      return (await import("../commands/projects.js")).handleAddModal(interaction);
```

`projects_add` shows a modal, so it must NOT be deferred. In `bot/src/index.js`, add `"projects_add"` to the `noDeferComponentIds` array.

- [ ] **Step 5: Restrict the command**

In `bot/src/config/command-config.json`, under `commandRoles`, add:

```json
    "projects": ["CEO", "Server Manager"],
```

Add a `commandDescriptions` entry too, matching the shape of the neighbouring entries:

```json
    "projects": { "summary": "List projects, add a project, link a repository", "syntax": "/projects", "detail": "CEO/Server Manager only. A project's docs folder determines which UBS-Doc pages are attributed to it." },
```

- [ ] **Step 6: Fix `/repos` so the project name is not discarded**

In `bot/src/commands/repos.js`, in the confirm handler, replace the `db.repository.create({ data: { ... } })` call and the lines around it with:

```js
    const repo = await db.repository.create({
      data: {
        guildConfigId: cfg.id,
        name: state.name,
        url: state.url,
      },
    })

    if (state.project) {
      const name = String(state.project).trim()
      let project = await db.project.findByName({ guildConfigId: cfg.id, name })
      if (!project) {
        const { slugify } = await import('../utils/docPath.js')
        project = await db.project.create({
          data: { guildConfigId: cfg.id, name, docsSlug: slugify(name), docsPaths: [] },
        })
      }
      if (project?.id && repo?.id) {
        await db.projectRepos.add({ projectId: project.id, repositoryId: repo.id })
      }
    }
```

- [ ] **Step 7: Verify the command registry**

Run:

```bash
node --check bot/src/commands/projects.js && node -e "
import('./bot/src/commands/index.js').then(m => {
  const names = m.getCommands().map(c => c.toJSON().name)
  console.log('count:', names.length, '| projects present:', names.includes('projects'))
})
"
```

Expected: `count: 37 | projects present: true`

- [ ] **Step 8: Run the tests**

Run: `npm test`
Expected: PASS — 35 tests.

- [ ] **Step 9: Commit**

```bash
git add bot/src/commands/projects.js bot/src/commands/index.js bot/src/commands/repos.js bot/src/handlers/interactions.js bot/src/index.js bot/src/Database/index.js bot/src/config/command-config.json
git commit -m "feat: add /projects and stop /repos discarding the project name

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Repoint `/edit-docs` and the `#documentation` channel

**Files:**
- Modify (rewrite): `bot/src/commands/edit-docs.js`
- Modify: `bot/src/services/docTraversal.js`
- Modify: `bot/src/handlers/interactions.js` (route the new attachment path if the custom ids change)

**Interfaces:**
- Consumes: `db.docPage.upsert / listIndex`, `db.project.findMany`, `slugify`
- Produces: `/edit-docs` writes `docpage` rows with `source: 'local'`; `buildDocTraversalPayload(guildId)` returns project options built from `docpage`

- [ ] **Step 1: Rewrite `/edit-docs` onto docpage**

Replace `bot/src/commands/edit-docs.js`. Keep the existing `edit_docs_select` and `edit_docs_modal` custom ids so the routing in `interactions.js` (lines 94 and 307) keeps working:

```js
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import * as flowStore from '../flows/store.js'
import { slugify, toDocId, sectionOf } from '../utils/docPath.js'

export const data = new SlashCommandBuilder()
  .setName('edit-docs')
  .setDescription('Write a documentation page for a project (stored in the bot database)')

export async function execute(interaction) {
  const guild = interaction.guild
  if (!guild) return interaction.editReply({ content: 'Use this in a server.' })

  const cfg = await getOrCreateGuildConfig(guild.id)
  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  if (projects.length === 0) {
    return interaction
      .editReply({ content: 'No projects yet. A manager can add one with **/projects**.' })
      .catch(() => {})
  }

  const embed = new EmbedBuilder()
    .setTitle('Write documentation')
    .setDescription(
      'Choose the project this page belongs to. The page is stored in the bot database and appears in **/docs** under that project.'
    )
    .setColor(0x5865f2)

  const select = new StringSelectMenuBuilder()
    .setCustomId('edit_docs_select')
    .setPlaceholder('Select a project…')
    .addOptions(projects.slice(0, 25).map((p) => ({ label: p.name.slice(0, 100), value: p.id })))

  return interaction
    .editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] })
    .catch(() => {})
}

export async function handleEditDocsSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  flowStore.set(interaction.user.id, guild.id, 'edit_docs', { projectId: interaction.values[0] })

  const modal = new ModalBuilder().setCustomId('edit_docs_modal').setTitle('New documentation page')
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Page title')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('body')
        .setLabel('Markdown content')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
    )
  )
  return interaction.showModal(modal).catch(() => {})
}

export async function handleEditDocsModal(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const cfg = await getOrCreateGuildConfig(guild.id)
  const state = flowStore.get(interaction.user.id, guild.id, 'edit_docs')
  if (!state?.projectId) {
    return interaction.editReply({ content: 'That flow expired — run /edit-docs again.' }).catch(() => {})
  }

  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  const project = projects.find((p) => p.id === state.projectId)
  if (!project) {
    return interaction.editReply({ content: 'That project no longer exists.' }).catch(() => {})
  }

  const title = interaction.fields.getTextInputValue('title').trim()
  const body = interaction.fields.getTextInputValue('body')
  const projectSlug = project.docsSlug || slugify(project.name)
  const path = `docs/projects/${projectSlug}/${slugify(title)}.md`

  await db.docPage.upsert({
    data: {
      guildConfigId: cfg.id,
      path,
      docId: toDocId(path),
      section: sectionOf(path),
      projectId: project.id,
      title,
      content: body,
      source: 'local',
      blobSha: null,
      size: body.length,
    },
  })

  flowStore.clear(interaction.user.id, guild.id, 'edit_docs')
  return interaction
    .editReply({
      content: `Saved **${title}** under **${project.name}**. Find it in **/docs**. It is stored in the bot only — it is not published to the docs site yet.`,
    })
    .catch(() => {})
}
```

- [ ] **Step 2: Repoint the `#documentation` channel traversal**

In `bot/src/services/docTraversal.js`, replace the two lookups at the top of `buildDocTraversalPayload` (the `db.repository.findMany` / `db.projectSchema.findMany` pair and the option construction that follows) with project options built from the synced corpus:

```js
  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  const counts = await db.docPage.countsByProject({ guildConfigId: cfg.id })
  const byId = new Map(counts.map((c) => [c.projectId, Number(c.n)]))

  const options = []
  for (const p of projects) {
    const n = byId.get(p.id) || 0
    if (!n) continue
    options.push({
      label: `${p.name}`.slice(0, 100),
      value: `proj:${p.id}`,
      description: `${n} documentation page(s)`,
    })
  }
  if (options.length === 0) {
    options.push({
      label: 'No documentation synced yet',
      value: '__none__',
      description: 'A manager can run /setup → Sync docs now',
    })
  }
```

- [ ] **Step 2b: Rewrite the traversal select handler**

In `bot/src/commands/doc-channel.js`, replace the whole of `handleDocTraversalSelect` (the `schema:` and `repo:` branches go away) with:

```js
export async function handleDocTraversalSelect(interaction) {
  const guild = interaction.guild
  if (!guild) return
  const value = interaction.values?.[0]
  if (!value) return

  const cfg = await getOrCreateGuildConfig(guild.id)

  if (value === '__none__') {
    return interaction
      .editReply({
        content: 'No documentation synced yet. A manager can run **/setup** and press **Sync docs now**.',
        components: [],
        embeds: [],
      })
      .catch(() => {})
  }

  const projectId = value.startsWith('proj:') ? value.slice('proj:'.length) : value
  const projects = await db.project.findMany({ where: { guildConfigId: cfg.id } })
  const project = projects.find((p) => p.id === projectId)
  if (!project) {
    return interaction
      .editReply({ content: 'That project no longer exists.', components: [], embeds: [] })
      .catch(() => {})
  }

  const index = await db.docPage.listIndex({ guildConfigId: cfg.id })
  const pages = index.filter((r) => r.projectId === projectId)
  const source = await db.docSource.get({ guildConfigId: cfg.id })
  const siteUrl = source?.siteUrl || ''

  const lines = pages.slice(0, 25).map((r) =>
    r.source === 'local' || !siteUrl
      ? `📝 ${r.title}`
      : `📄 [${r.title}](${docUrl(siteUrl, r.docId)})`
  )
  const more = pages.length > 25 ? `\n\n…and ${pages.length - 25} more — use **/docs** to browse them all.` : ''

  const embed = new EmbedBuilder()
    .setTitle(`📚 ${project.name}`)
    .setDescription(
      lines.length
        ? `${lines.join('\n')}${more}`
        : 'No documentation pages for this project yet.'
    )
    .setColor(0x5865f2)
    .setFooter({ text: `${pages.length} page(s) · read them in Discord with /docs` })

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BACK_CUSTOM_ID).setLabel('Back to list').setStyle(ButtonStyle.Secondary)
  )

  return interaction.editReply({ embeds: [embed], components: [row], content: null }).catch(() => {})
}
```

Update that file's imports to match — `getRepoFileContent` and the `truncate` helper are no longer used, and `docUrl` is now needed:

```js
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js'
import db, { getOrCreateGuildConfig } from '../db/index.js'
import { buildDocTraversalPayload, getDocTraversalCustomIds } from '../services/docTraversal.js'
import { docUrl } from '../utils/docRender.js'
```

- [ ] **Step 3: Verify every module still imports**

Run:

```bash
node -e "
import('dotenv/config').then(async () => {
  const { readdirSync, statSync } = await import('fs')
  const files = []
  ;(function walk(d){for(const f of readdirSync(d)){const p=d+'/'+f; if(statSync(p).isDirectory())walk(p); else if(f.endsWith('.js'))files.push(p)}})('bot/src')
  let fail = 0
  for (const f of files) {
    if (f.endsWith('bot/src/index.js')) continue
    if (f.includes('bot/src/Database/') && !/(index|connection|helpers)\.js$/.test(f)) continue
    try { await import('./' + f) } catch (e) { fail++; console.log('FAIL', f, e.message.split('\n')[0]) }
  }
  console.log(fail === 0 ? 'all modules import cleanly' : fail + ' failures')
  process.exit(0)
})
"
```

Expected: `all modules import cleanly`. (The filter skips the 15 known-dead vendored `Database/*` files that already fail on `main`.)

- [ ] **Step 4: Run the tests and build the command list**

Run: `npm test && node -e "import('./bot/src/commands/index.js').then(m => console.log('commands:', m.getCommands().map(c => c.toJSON()).length))"`
Expected: PASS, `commands: 37`.

- [ ] **Step 5: Commit**

```bash
git add bot/src/commands/edit-docs.js bot/src/commands/doc-channel.js bot/src/services/docTraversal.js
git commit -m "feat: repoint /edit-docs and the documentation channel at docpage

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Live verification in Discord

No code. This is the acceptance pass, and it needs the production bot stopped first because it shares this token and database.

- [ ] **Step 1: Ask the user to stop the deployed bot**

The VM instance must be stopped or two bots answer every interaction:

```bash
ssh -i "C:/Users/Dell/Downloads/frame-work_key.pem" azureuser@20.120.228.55 "pm2 stop granjur-bot"
```

- [ ] **Step 2: Start the bot locally**

Run: `npm start`
Expected: `Registered 37 slash commands for guild …` (the count changed, so registration will fire), then `Logged in as …`, then a `[docsSync]` line within a few seconds.

- [ ] **Step 3: Walk the acceptance checks in Discord**

- [ ] `/setup` shows a **Documentation** field with a page count and a relative last-synced time, and a **Sync docs now** button that reports "Already up to date".
- [ ] `/docs` with no query lists **Badar HMS** first, then the framework sections.
- [ ] Selecting **Badar HMS** offers `hms-documentation` and `projects` folders.
- [ ] Walking down to a page renders it, `← Back` climbs one level, and a folder with more than 25 entries offers **Next**.
- [ ] A long page shows `page 1/N` with working ◀ ▶ buttons and a **Read full page ↗** button that opens the correct `ubs-doc.vercel.app` URL.
- [ ] `/docs query:` typing `tenan` offers matching titles; picking one opens that page directly.
- [ ] `/projects` lists projects with doc counts; **Add project** creates one; **Link repo** writes the join.
- [ ] `/edit-docs` saves a page that then appears in `/docs` under its project, tagged 📝 and with no link button.
- [ ] The `#documentation` channel browser lists projects rather than the old empty schema list.

- [ ] **Step 4: Stop the local bot and restart the VM**

```bash
ssh -i "C:/Users/Dell/Downloads/frame-work_key.pem" azureuser@20.120.228.55 "pm2 start granjur-bot"
```

Note: the VM is still running `main`, which does not have these commands. Merging the branch redeploys it.

- [ ] **Step 5: Update the project state files**

Per `CLAUDE.md`: move the finished work into `.claude/state/completed.md` dated `2026-09-03`, add any follow-ups to `.claude/state/backlog.md`, clear `.claude/state/session.md`, and write `.claude/knowledge/project-docs.md` covering the sync model, the `docpage`/`docsource` tables, the path-prefix attribution rule, and the local-versus-repo distinction. Add it to `.claude/knowledge/README.md`.

- [ ] **Step 6: Commit the state and knowledge updates**

```bash
git add .claude/
git commit -m "docs: record project docs work in state and knowledge

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Known follow-ups (not in this plan)

- Phase 2: commit `source='local'` pages back to UBS-Doc as a PR per doc. Needs a GitHub PAT with Contents: write and Pull requests: write.
- `GITHUB_TOKEN` in `.env` is invalid (`401`). Phase 1 works without it; a valid token only raises the metadata rate limit.
- The 15 dead vendored files under `bot/src/Database/` still fail to import and still contain a hard SyntaxError.
- `/edit-docs` currently caps content at Discord's 4000-character modal limit. The `.md` attachment path described in the spec is deferred until someone hits that ceiling.

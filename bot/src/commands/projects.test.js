// Every test here passes fakes for every seam `handleAddModal` takes — db,
// getConfig, reattribute, and (where the real routine is not the subject) setup.
// The root `.env` points at production; see .claude/rules/tests-never-touch-production.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import {
  handleAddModal,
  listPayload,
  handleDeleteButton,
  handleDeleteSelect,
  handleDeleteModal,
  handleReactivateButton,
  handleReactivateSelect,
  handleReactivateConfirm,
} from './projects.js'

// --- fakes ------------------------------------------------------------------

function fakeChannel(id, name, { type = ChannelType.GuildText, parentId = null } = {}) {
  const channel = {
    id,
    name,
    type,
    parentId,
    edits: [],
    sent: [],
    permissionOverwrites: { cache: new Map() },
    messages: { fetchPinned: async () => [] },
    async send(payload) {
      channel.sent.push(payload)
      return { pin: async () => {} }
    },
    async edit(opts) {
      channel.edits.push(opts)
      return channel
    },
  }
  return channel
}

function fakeGuild() {
  const guild = {
    id: 'G1',
    fetchedAll: 0,
    roles: {
      cache: new Map(),
      everyone: { id: 'G1', name: '@everyone', permissions: 0n },
      calls: [],
      async create(opts) {
        guild.roles.calls.push(opts)
        const role = { id: `role-${guild.roles.calls.length}`, name: opts.name, members: new Map() }
        guild.roles.cache.set(role.id, role)
        return role
      },
    },
    channels: {
      cache: new Map(),
      calls: [],
      async create(opts) {
        guild.channels.calls.push(opts)
        const made = fakeChannel(`new-${guild.channels.calls.length}`, opts.name, {
          type: opts.type,
          parentId: opts.parent ?? null,
        })
        guild.channels.cache.set(made.id, made)
        return made
      },
    },
    members: {
      cache: new Map(),
      async fetch(id) {
        if (id === undefined) {
          guild.fetchedAll += 1
          return guild.members.cache
        }
        throw new Error('Unknown Member')
      },
    },
  }
  return guild
}

const CFG = { id: 'g1' }

function fakeDb({ projects = [], log = [] } = {}) {
  const calls = []
  const rows = [...projects]
  return {
    calls,
    rows,
    project: {
      findByName: async ({ guildConfigId, name }) =>
        rows.find((p) => p.guildConfigId === guildConfigId && p.name === name) ?? null,
      findMany: async () => rows,
      create: async ({ data }) => {
        log.push('project.create')
        calls.push(['project.create', data])
        const row = { id: `p${rows.length + 1}`, ...data }
        rows.push(row)
        return row
      },
      update: async (args) => {
        calls.push(['project.update', args])
        return { id: args?.where?.id }
      },
      delete: async (args) => {
        calls.push(['project.delete', args])
      },
    },
    task: { findMany: async () => [] },
    projectMember: {
      findByProject: async ({ where }) => {
        calls.push(['projectMember.findByProject', where])
        return []
      },
    },
  }
}

function fakeInteraction({ guild, name = 'Framework', slug = '', paths = '', deferred = true, log = [] } = {}) {
  const replies = []
  const values = { name, slug, paths }
  return {
    replies,
    guild,
    deferred,
    replied: false,
    client: { user: { id: 'bot1' } },
    fields: { getTextInputValue: (id) => values[id] ?? '' },
    async deferReply() {
      log.push('deferReply')
      this.deferred = true
    },
    async editReply(payload) {
      log.push('editReply')
      replies.push(payload)
      return payload
    },
  }
}

const getConfig = async () => CFG
const reattribute = async () => 0

async function quiet(fn) {
  const warn = console.warn
  const error = console.error
  console.warn = () => {}
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.warn = warn
    console.error = error
  }
}

// --- the add flow -----------------------------------------------------------

test('Add project writes the row and runs the one-project routine once with the created project', async () => {
  const db = fakeDb()
  const guild = fakeGuild()
  const it = fakeInteraction({ guild })
  const seen = []
  const setup = async (g, project, deps) => {
    seen.push({ g, project, deps })
    return { block: '**Framework** — 11 created.', result: { category: { name: '📂 FRAMEWORK' } } }
  }

  await handleAddModal(it, { db, getConfig, reattribute, setup })

  const created = db.calls.filter((c) => c[0] === 'project.create')
  assert.equal(created.length, 1)
  assert.equal(seen.length, 1, 'the routine ran exactly once')
  assert.equal(seen[0].g, guild)
  assert.equal(seen[0].project, db.rows[0], 'it was handed the row the create returned')
  assert.equal(seen[0].deps.db, db, 'the routine reads and writes through the same db seam')
  assert.equal(seen[0].deps.cfg, CFG)
  assert.equal(seen[0].deps.botUserId, 'bot1')
  const content = it.replies.at(-1).content
  assert.match(content, /Added \*\*Framework\*\*/)
  assert.match(content, /ready in \*\*📂 FRAMEWORK\*\*/, 'the reply names the category')
})

test('the interaction is acknowledged before the build starts', async () => {
  const log = []
  const db = fakeDb({ log })
  const it = fakeInteraction({ guild: fakeGuild(), deferred: false, log })
  const setup = async () => {
    log.push('setup')
    return { block: 'ok', result: { category: { name: '📂 FRAMEWORK' } } }
  }

  await handleAddModal(it, { db, getConfig, reattribute, setup })

  assert.equal(log[0], 'deferReply', 'an undeferred modal is deferred first')
  assert.ok(log.indexOf('setup') > log.indexOf('deferReply'))
  // The operator is told the project exists before the slow part begins.
  assert.ok(log.indexOf('editReply') < log.indexOf('setup'), 'a reply went out before the build')
  assert.match(it.replies[0].content, /Building its private section/)
})

test('an already-deferred modal is not deferred twice', async () => {
  const log = []
  const it = fakeInteraction({ guild: fakeGuild(), deferred: true, log })
  const setup = async () => ({ block: 'ok', result: { category: { name: '📂 FRAMEWORK' } } })
  await handleAddModal(it, { db: fakeDb(), getConfig, reattribute, setup })
  assert.ok(!log.includes('deferReply'))
})

test('a routine that throws keeps the project row and points at /project-setup', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ guild: fakeGuild() })
  const setup = async () => {
    throw new Error('Missing Permissions')
  }

  await quiet(() => handleAddModal(it, { db, getConfig, reattribute, setup }))

  assert.equal(db.rows.length, 1, 'the row stays')
  assert.deepEqual(db.calls.filter((c) => c[0] === 'project.delete'), [], 'nothing was rolled back')
  const content = it.replies.at(-1).content
  assert.match(content, /Added \*\*Framework\*\*/, 'the reply still reports the project created')
  assert.match(content, /Missing Permissions/)
  assert.match(content, /\/project-setup/)
})

test('a section whose category could not be made says so and points at /project-setup', async () => {
  const db = fakeDb()
  const it = fakeInteraction({ guild: fakeGuild() })
  const setup = async () => ({
    block: '**Framework** — nothing to change.\n⚠ category "📂 FRAMEWORK": Missing Permissions',
    result: { category: null },
  })

  await handleAddModal(it, { db, getConfig, reattribute, setup })

  const content = it.replies.at(-1).content
  assert.match(content, /could not be built/)
  assert.match(content, /\/project-setup/)
  assert.match(content, /Missing Permissions/)
  assert.doesNotMatch(content, /ready in/)
})

test('a name that already exists creates nothing and builds nothing', async () => {
  const db = fakeDb({ projects: [{ id: 'p1', name: 'Framework', guildConfigId: 'g1' }] })
  const it = fakeInteraction({ guild: fakeGuild() })
  let ran = 0
  await handleAddModal(it, { db, getConfig, reattribute, setup: async () => ran++ })
  assert.equal(ran, 0)
  assert.deepEqual(db.calls.filter((c) => c[0] === 'project.create'), [])
  assert.match(it.replies.at(-1).content, /already exists/)
})

test('through the real routine, a new project gets its role, category, channels and a members panel', async () => {
  const db = fakeDb()
  const guild = fakeGuild()
  const it = fakeInteraction({ guild })

  await quiet(() => handleAddModal(it, { db, getConfig, reattribute }))

  assert.equal(guild.roles.calls.length, 1, 'the project role was created')
  assert.equal(guild.channels.calls.length, 15, 'a category, its thirteen channels and the archive divider')
  assert.equal(guild.fetchedAll, 1, 'the member list was fetched before the role sync')
  assert.ok(
    db.calls.some((c) => c[0] === 'projectMember.findByProject'),
    'the real roster was read, not left undefined'
  )
  const members = [...guild.channels.cache.values()].find((c) => c.name === 'framework-members')
  assert.equal(members.sent.length, 1, 'the panel was posted')
  assert.match(members.sent[0].embeds[0].data.description, /No members yet/)
  assert.match(it.replies.at(-1).content, /ready in \*\*📂 FRAMEWORK\*\*/)
})

test('a slug that collides with a legacy project’s EFFECTIVE slug is refused', async () => {
  // `UBS Doc` predates the docsSlug column, so its slug is NULL and its
  // effective slug is `slugify(name)` — the same `ubs-doc` the new project
  // wants, and the same ten section channel names. Comparing the columns
  // alone let both in, and then each /project-setup run dragged those ten
  // channels into whichever project ran last.
  const db = fakeDb({ projects: [{ id: 'p1', name: 'UBS Doc', docsSlug: null, guildConfigId: 'g1' }] })
  const guild = fakeGuild()
  const it = fakeInteraction({ guild, name: 'UBS-Doc' })
  let ran = 0

  await handleAddModal(it, { db, getConfig, reattribute, setup: async () => ran++ })

  assert.equal(ran, 0)
  assert.deepEqual(db.calls.filter((c) => c[0] === 'project.create'), [])
  assert.match(it.replies.at(-1).content, /`ubs-doc` is already used by \*\*UBS Doc\*\*/)
})

test('Add project never adopts a role somebody already holds', async () => {
  // Since Task 10 every add builds the section, so the add flow is the one
  // that must never be able to revoke a role or show a new section to the
  // holders of an unrelated role that happens to share its name. It passes no
  // adopt_role, and there is no option on it to pass.
  const holder = { id: 'u1', displayName: 'Aashir', roles: { cache: new Set(['r9']), add: async () => {}, remove: async () => { throw new Error('should never be called') } } }
  const db = fakeDb()
  const guild = fakeGuild()
  guild.roles.cache.set('r9', {
    id: 'r9',
    name: 'Framework',
    permissions: 0n,
    managed: false,
    members: new Map([['u1', holder]]),
  })
  guild.members.cache.set('u1', holder)
  const it = fakeInteraction({ guild })

  await quiet(() => handleAddModal(it, { db, getConfig, reattribute }))

  assert.equal(guild.roles.calls.length, 0, 'and no second role of the same name was made either')
  assert.ok(holder.roles.cache.has('r9'), 'the holder kept the role')
  const category = guild.channels.calls[0]
  assert.deepEqual(
    category.permissionOverwrites,
    [{ id: 'G1', type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] }],
    'the section is built shut, not gated on a role two strangers hold'
  )
  assert.match(it.replies.at(-1).content, /held by 1 member\(s\)/)
})

// ---------------------------------------------------------------------------
// D4: the slug typed into the modal is normalised before anything sees it
// ---------------------------------------------------------------------------

test('a slug typed with a space is slugified before it is stored or compared', async () => {
  // Stored raw, `UBS Doc` slips past the effective-slug check here AND
  // /project-setup's duplicate-slug refusal, and `channelNameFor` then builds
  // `UBS Doc-members` — a name Discord normalises server-side, so the name
  // fallback never matches it again and ten fresh channels appear every run.
  const db = fakeDb({ projects: [] })
  const it = fakeInteraction({ guild: fakeGuild(), name: 'UBS Doc', slug: 'UBS Doc' })

  await quiet(() => handleAddModal(it, { db, getConfig, reattribute, setup: async () => ({ block: 'ok', result: {} }) }))

  const create = db.calls.find((c) => c[0] === 'project.create')
  assert.equal(create[1].docsSlug, 'ubs-doc')
})

test('a typed slug that slugifies to nothing falls back to the project name', async () => {
  const db = fakeDb({ projects: [] })
  const it = fakeInteraction({ guild: fakeGuild(), name: 'Framework', slug: '!!!' })
  await quiet(() => handleAddModal(it, { db, getConfig, reattribute, setup: async () => ({ block: 'ok', result: {} }) }))
  const create = db.calls.find((c) => c[0] === 'project.create')
  assert.equal(create[1].docsSlug, 'framework')
})

test('a normalised slug is caught by the effective-slug conflict check', async () => {
  const db = fakeDb({ projects: [{ id: 'p1', name: 'UBS Doc', docsSlug: null, guildConfigId: 'g1' }] })
  const it = fakeInteraction({ guild: fakeGuild(), name: 'Other', slug: 'UBS Doc' })
  let ran = 0
  await quiet(() => handleAddModal(it, { db, getConfig, reattribute, setup: async () => ran++ }))
  assert.equal(ran, 0)
  assert.deepEqual(db.calls.filter((c) => c[0] === 'project.create'), [])
  assert.match(it.replies.at(-1).content, /`ubs-doc` is already used by \*\*UBS Doc\*\*/)
})

// ---------------------------------------------------------------------------
// A soft-deleted project keeps its name and its slug reserved
// ---------------------------------------------------------------------------

const DELETED_AT = new Date('2026-10-01T09:00:00Z')

/** fakeDb whose project list hides a deleted project unless the read opts in, as the real one does. */
function hidingDb(projects) {
  const db = fakeDb({ projects })
  db.reads = []
  db.project.findMany = async ({ where }) => {
    db.reads.push(where)
    return db.rows.filter((p) => where.includeDeleted === true || !p.deletedAt)
  }
  return db
}

test('Add refuses a name a deleted project holds, and creates and builds nothing', async () => {
  const db = hidingDb([{ id: 'p1', name: 'Apollo', docsSlug: 'apollo', guildConfigId: 'g1', deletedAt: DELETED_AT }])
  const it = fakeInteraction({ guild: fakeGuild(), name: 'Apollo' })
  let ran = 0
  await handleAddModal(it, { db, getConfig, reattribute, setup: async () => ran++ })
  assert.equal(ran, 0)
  assert.deepEqual(db.calls.filter((c) => c[0] === 'project.create'), [])
  assert.equal(it.replies.at(-1).content, 'A deleted project has that name — reactivate it or pick another name.')
})

test('Add refuses a slug a deleted project holds, and creates and builds nothing', async () => {
  const db = hidingDb([{ id: 'p1', name: 'Apollo Old', docsSlug: 'apollo', guildConfigId: 'g1', deletedAt: DELETED_AT }])
  const it = fakeInteraction({ guild: fakeGuild(), name: 'Apollo' })
  let ran = 0
  await handleAddModal(it, { db, getConfig, reattribute, setup: async () => ran++ })
  assert.equal(ran, 0)
  assert.deepEqual(db.calls.filter((c) => c[0] === 'project.create'), [])
  assert.equal(it.replies.at(-1).content, 'A deleted project uses that slug — reactivate it or pick another slug.')
})

test('Add refuses a deleted project’s EFFECTIVE slug too (a NULL docsSlug still holds slugify(name))', async () => {
  const db = hidingDb([{ id: 'p1', name: 'UBS Doc', docsSlug: null, guildConfigId: 'g1', deletedAt: DELETED_AT }])
  const it = fakeInteraction({ guild: fakeGuild(), name: 'UBS-Doc' })
  await quiet(() => handleAddModal(it, { db, getConfig, reattribute, setup: async () => { throw new Error('must not run') } }))
  assert.deepEqual(db.calls.filter((c) => c[0] === 'project.create'), [])
  assert.equal(it.replies.at(-1).content, 'A deleted project uses that slug — reactivate it or pick another slug.')
})

test('the /projects list reads deleted projects too, and lists the live ones', async () => {
  const db = hidingDb([
    { id: 'p1', name: 'Framework', docsSlug: 'framework', guildConfigId: 'g1', deletedAt: null },
    { id: 'p2', name: 'Apollo', docsSlug: 'apollo', guildConfigId: 'g1', deletedAt: DELETED_AT },
  ])
  db.docPage = { countsByProject: async () => [{ projectId: 'p1', n: 3 }] }
  const payload = await listPayload(CFG, { db })
  assert.deepEqual(db.reads, [{ guildConfigId: 'g1', includeDeleted: true }])
  assert.match(payload.embeds[0].data.description, /\*\*Framework\*\* — `framework` — 3 doc page\(s\)/)
})

// ---------------------------------------------------------------------------
// Delete and Reactivate
// ---------------------------------------------------------------------------

function lifecycleDb() {
  const db = hidingDb([
    { id: 'p1', name: 'Framework', docsSlug: 'framework', guildConfigId: 'g1', deletedAt: null },
    { id: 'p2', name: 'Apollo', docsSlug: 'apollo', guildConfigId: 'g1', deletedAt: DELETED_AT },
  ])
  db.project.findFirst = async ({ where }) => db.rows.find((p) => p.id === where.id) ?? null
  db.docPage = { countsByProject: async () => [] }
  return db
}

function componentInteraction({ guild = fakeGuild(), values = [], customId = '', typed = '', deferred = true } = {}) {
  const log = []
  return {
    log,
    guild,
    customId,
    values,
    deferred,
    replied: false,
    user: { id: 'u-ceo' },
    client: { user: { id: 'bot1' } },
    fields: { getTextInputValue: (id) => (id === 'name' ? typed : '') },
    replies: [],
    modals: [],
    async deferUpdate() {
      log.push('deferUpdate')
      this.deferred = true
    },
    async deferReply() {
      log.push('deferReply')
      this.deferred = true
    },
    async editReply(payload) {
      log.push('editReply')
      this.replies.push(payload)
      return payload
    },
    async showModal(modal) {
      log.push('showModal')
      this.modals.push(modal)
    },
  }
}

const buttonIds = (payload) => payload.components.flatMap((row) => row.components.map((c) => c.data.custom_id))

test('the /projects list shows deleted projects in their own section, and Reactivate only when there are any', async () => {
  const db = lifecycleDb()
  const payload = await listPayload(CFG, { db })
  const embed = payload.embeds[0].data
  assert.match(embed.description, /\*\*Framework\*\*/)
  assert.doesNotMatch(embed.description, /Apollo/, 'a deleted project is not among the live ones')
  const deleted = embed.fields.find((f) => f.name === 'Deleted')
  assert.ok(deleted, 'a Deleted section')
  assert.match(deleted.value, /\*\*Apollo\*\*/)
  assert.doesNotMatch(deleted.value, /Framework/)
  assert.deepEqual(buttonIds(payload), [
    'projects_add',
    'projects_link_repo',
    'projects_unlink_repo',
    'projects_delete',
    'projects_reactivate',
  ])

  db.rows.splice(1, 1)
  const none = await listPayload(CFG, { db })
  assert.equal((none.embeds[0].data.fields ?? []).length, 0, 'no Deleted section with nothing deleted')
  assert.ok(!buttonIds(none).includes('projects_reactivate'))
  assert.ok(buttonIds(none).includes('projects_delete'))
})

test('Delete project offers the live projects only', async () => {
  const db = lifecycleDb()
  const it = componentInteraction({ customId: 'projects_delete' })
  await handleDeleteButton(it, { db, getConfig })
  const select = it.replies.at(-1).components[0].components[0].toJSON()
  assert.equal(select.custom_id, 'projects_delete_select')
  assert.deepEqual(select.options.map((o) => o.value), ['p1'])
})

test('picking a project to delete opens the confirm-name modal carrying its id', async () => {
  const db = lifecycleDb()
  const it = componentInteraction({ customId: 'projects_delete_select', values: ['p1'], deferred: false })
  await handleDeleteSelect(it, { db, getConfig })
  assert.deepEqual(it.log, ['showModal'], 'the modal is the reply; nothing deferred first')
  const modal = it.modals[0].toJSON()
  assert.equal(modal.custom_id, 'projects_delete_modal:p1')
  const input = modal.components[0].components[0]
  assert.equal(input.label, 'Type the project name to confirm')
  assert.equal(input.custom_id, 'name')
})

test('a confirm name that does not match refuses with the sentence and deletes nothing', async () => {
  const db = lifecycleDb()
  let ran = 0
  const it = componentInteraction({ customId: 'projects_delete_modal:p1', typed: 'Framewrk' })
  await handleDeleteModal(it, { db, getConfig, remove: async () => ran++ })
  assert.equal(ran, 0)
  assert.deepEqual(db.calls.filter((c) => c[0] === 'project.update'), [])
  assert.equal(it.replies.at(-1).content, 'The name does not match — nothing was deleted.')
})

test('a matching name (any case, spaces trimmed) deletes and replies with the result', async () => {
  const db = lifecycleDb()
  const guild = fakeGuild()
  const seen = []
  const remove = async (args) => {
    seen.push(args)
    return { archived: 2, removed: 5, stoppedClocks: 1, failures: ['Could not delete #framework-general: Missing Permissions'] }
  }
  const it = componentInteraction({ guild, customId: 'projects_delete_modal:p1', typed: '  framework ', deferred: false })
  await handleDeleteModal(it, { db, getConfig, remove })
  assert.equal(it.log[0], 'deferReply', 'deferred before the slow part')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].db, db)
  assert.equal(seen[0].guild, guild)
  assert.equal(seen[0].cfg, CFG)
  assert.equal(seen[0].project.id, 'p1')
  assert.equal(seen[0].actorId, 'u-ceo')
  assert.ok(seen[0].now instanceof Date)
  assert.deepEqual(it.log.filter((l) => l === 'editReply'), ['editReply'], 'the reply is edited once, at the end')
  assert.equal(
    it.replies.at(-1).content,
    'Deleted **Framework**. Archived 2 task channels; removed its section and role. Stopped 1 running clocks.\nCould not delete #framework-general: Missing Permissions'
  )
})

test('deleting a project that is already deleted is refused', async () => {
  const db = lifecycleDb()
  let ran = 0
  const it = componentInteraction({ customId: 'projects_delete_modal:p2', typed: 'Apollo' })
  await handleDeleteModal(it, { db, getConfig, remove: async () => ran++ })
  assert.equal(ran, 0)
  assert.equal(it.replies.at(-1).content, 'This project is deleted.')
})

test('Reactivate project offers the deleted projects only, then a confirm button', async () => {
  const db = lifecycleDb()
  const it = componentInteraction({ customId: 'projects_reactivate' })
  await handleReactivateButton(it, { db, getConfig })
  const select = it.replies.at(-1).components[0].components[0].toJSON()
  assert.equal(select.custom_id, 'projects_reactivate_select')
  assert.deepEqual(select.options.map((o) => o.value), ['p2'])

  const picked = componentInteraction({ customId: 'projects_reactivate_select', values: ['p2'] })
  await handleReactivateSelect(picked, { db, getConfig })
  const reply = picked.replies.at(-1)
  assert.match(reply.content, /\*\*Apollo\*\*/)
  assert.deepEqual(buttonIds(reply), ['projects_reactivate_confirm:p2'])
})

test('confirming a reactivation runs it and replies with the result', async () => {
  const db = lifecycleDb()
  const guild = fakeGuild()
  const seen = []
  const reactivate = async (args) => {
    seen.push(args)
    return { restored: 3, failures: ['Section rebuild failed — run /project-setup for it.'] }
  }
  const it = componentInteraction({ guild, customId: 'projects_reactivate_confirm:p2', deferred: false })
  await handleReactivateConfirm(it, { db, getConfig, reactivate })
  assert.equal(it.log[0], 'deferUpdate')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].db, db)
  assert.equal(seen[0].guild, guild)
  assert.equal(seen[0].cfg, CFG)
  assert.equal(seen[0].project.id, 'p2')
  assert.equal(seen[0].botUserId, 'bot1')
  assert.deepEqual(it.log.filter((l) => l === 'editReply'), ['editReply'])
  assert.deepEqual(it.replies.at(-1), {
    content: 'Reactivated **Apollo**. Rebuilt its section; restored 3 task channels.\nSection rebuild failed — run /project-setup for it.',
    components: [],
    embeds: [],
  })
})

test('confirming a reactivation of a live project changes nothing', async () => {
  const db = lifecycleDb()
  let ran = 0
  const it = componentInteraction({ customId: 'projects_reactivate_confirm:p1' })
  await handleReactivateConfirm(it, { db, getConfig, reactivate: async () => ran++ })
  assert.equal(ran, 0)
  assert.equal(it.replies.at(-1).content, '**Framework** is not deleted.')
})

test('a delete or reactivate that throws still answers the operator', async () => {
  const db = lifecycleDb()
  const it = componentInteraction({ customId: 'projects_delete_modal:p1', typed: 'Framework' })
  await quiet(() =>
    handleDeleteModal(it, { db, getConfig, remove: async () => { throw new Error('db down') } })
  )
  assert.match(it.replies.at(-1).content, /Could not delete \*\*Framework\*\*: db down/)

  const again = componentInteraction({ customId: 'projects_reactivate_confirm:p2' })
  await quiet(() =>
    handleReactivateConfirm(again, { db, getConfig, reactivate: async () => { throw new Error('db down') } })
  )
  assert.match(again.replies.at(-1).content, /Could not reactivate \*\*Apollo\*\*: db down/)
})

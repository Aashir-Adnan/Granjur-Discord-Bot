import { query, queryOne } from "./connection.js";
import { id, ensureStringArray, toJson } from "./helpers.js";
import { buildTaskInsertValues } from "./taskInsert.helpers.js";

export { ensureStringArray } from "./helpers.js";

// ---------- GuildConfig ----------
export async function getGuildConfig(guildId) {
  return queryOne("SELECT * FROM `guildconfig` WHERE guildId = ?", [guildId]);
}

export async function getGuildConfigById(id) {
  return queryOne("SELECT * FROM `guildconfig` WHERE id = ?", [id]);
}

export async function getOrCreateGuildConfig(guildId, data = {}) {
  let g = await getGuildConfig(guildId);
  if (!g) {
    const pk = id();
    const allowedDomains = data.allowedDomains
      ? Array.isArray(data.allowedDomains)
        ? JSON.stringify(data.allowedDomains)
        : data.allowedDomains
      : '["granjur.com"]';
    await query(
      "INSERT INTO `guildconfig` (id, guildId, onboardingChannelId, holdingRoleId, verifiedRoleId, adminChannelId, allowedDomains, dashboardRoleIds, seniorRoleIds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        pk,
        guildId,
        data.onboardingChannelId ?? null,
        data.holdingRoleId ?? null,
        data.verifiedRoleId ?? null,
        data.adminChannelId ?? null,
        allowedDomains,
        data.dashboardRoleIds ? toJson(data.dashboardRoleIds) : "[]",
        data.seniorRoleIds ? toJson(data.seniorRoleIds) : "[]",
      ],
    );
    g = await getGuildConfig(guildId);
  }
  return g;
}

export async function updateGuildConfig(guildId, data) {
  const sets = [];
  const vals = [];
  if (data.onboardingChannelId !== undefined) {
    sets.push("onboardingChannelId = ?");
    vals.push(data.onboardingChannelId);
  }
  if (data.holdingRoleId !== undefined) {
    sets.push("holdingRoleId = ?");
    vals.push(data.holdingRoleId);
  }
  if (data.verifiedRoleId !== undefined) {
    sets.push("verifiedRoleId = ?");
    vals.push(data.verifiedRoleId);
  }
  if (data.adminChannelId !== undefined) {
    sets.push("adminChannelId = ?");
    vals.push(data.adminChannelId);
  }
  if (data.allowedDomains !== undefined) {
    sets.push("allowedDomains = ?");
    vals.push(
      Array.isArray(data.allowedDomains)
        ? toJson(data.allowedDomains)
        : data.allowedDomains,
    );
  }
  if (data.dashboardRoleIds !== undefined) {
    sets.push("dashboardRoleIds = ?");
    vals.push(toJson(data.dashboardRoleIds));
  }
  if (data.seniorRoleIds !== undefined) {
    sets.push("seniorRoleIds = ?");
    vals.push(toJson(data.seniorRoleIds));
  }
  if (data.clockedInRoleId !== undefined) {
    sets.push("clockedInRoleId = ?");
    vals.push(data.clockedInRoleId);
  }
  if (data.timezone !== undefined) {
    sets.push("timezone = ?");
    vals.push(data.timezone);
  }
  if (sets.length === 0) return getGuildConfig(guildId);
  vals.push(guildId);
  await query(
    `UPDATE \`guildconfig\` SET ${sets.join(", ")} WHERE guildId = ?`,
    vals,
  );
  return getGuildConfig(guildId);
}

async function deleteGuildConfig(guildId) {
  await query("DELETE FROM `guildconfig` WHERE guildId = ?", [guildId]);
}

// ---------- GuildMember ----------
async function guildMemberFindMany({ where }) {
  let sql = "SELECT * FROM `guildmember` WHERE 1=1";
  const params = [];
  if (where?.guildConfigId) {
    sql += " AND guildConfigId = ?";
    params.push(where.guildConfigId);
  }
  if (where?.status) {
    sql += " AND status = ?";
    params.push(where.status);
  }
  if (where?.verifiedAt && typeof where.verifiedAt === "object" && "not" in where.verifiedAt && where.verifiedAt.not === null) {
    sql += " AND verifiedAt IS NOT NULL";
  }
  sql += " ORDER BY createdAt ASC";
  if (!where?.all) sql += " LIMIT 25";
  return query(sql, params);
}

async function guildMemberFindUnique({ where }) {
  if (where?.guildId_discordId) {
    const cfg = await getGuildConfig(where.guildId_discordId.guildId);
    if (!cfg) return null;
    return queryOne(
      "SELECT * FROM `guildmember` WHERE guildConfigId = ? AND discordId = ?",
      [cfg.id, where.guildId_discordId.discordId],
    );
  }
  if (where?.id)
    return queryOne("SELECT * FROM `guildmember` WHERE id = ?", [where.id]);
  return null;
}

async function guildMemberUpsert({ where, create, update }) {
  const existing = await guildMemberFindUnique({ where });
  if (existing) {
    await query(
      "UPDATE `guildmember` SET email = ?, verifiedAt = ?, status = ?, updatedAt = CURRENT_TIMESTAMP(3) WHERE id = ?",
      [
        update.email ?? existing.email,
        update.verifiedAt ?? existing.verifiedAt,
        update.status ?? existing.status,
        existing.id,
      ],
    );
    return guildMemberFindUnique({ where });
  }
  const pk = id();
  const cfg = await getOrCreateGuildConfig(create.guildId);
  await query(
    `INSERT INTO \`guildmember\` (id, guildConfigId, discordId, email, verifiedAt, status, roleIds)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      pk,
      cfg.id,
      create.discordId,
      create.email ?? null,
      create.verifiedAt ?? null,
      create.status ?? "pending",
      toJson(create.roleIds || []),
    ],
  );
  return guildMemberFindUnique({
    where: {
      guildId_discordId: {
        guildId: create.guildId,
        discordId: create.discordId,
      },
    },
  });
}

async function guildMemberUpdate({ where, data }) {
  const idVal = where.id;
  const sets = [];
  const vals = [];
  if (data.status !== undefined) {
    sets.push("status = ?");
    vals.push(data.status);
  }
  if (data.roleIds !== undefined) {
    sets.push("roleIds = ?");
    vals.push(toJson(data.roleIds));
  }
  if (data.email !== undefined) {
    sets.push("email = ?");
    vals.push(data.email);
  }
  if (sets.length === 0) return guildMemberFindUnique({ where: { id: idVal } });
  vals.push(idVal);
  await query(
    `UPDATE \`guildmember\` SET ${sets.join(", ")} WHERE id = ?`,
    vals,
  );
  return guildMemberFindUnique({ where: { id: idVal } });
}

// ---------- Repository ----------
async function repositoryFindMany({ where }) {
  return query("SELECT * FROM `repository` WHERE guildConfigId = ?", [
    where.guildConfigId,
  ]);
}

async function repositoryFindFirst({ where }) {
  if (where?.id && where?.guildConfigId) {
    return queryOne(
      "SELECT * FROM `repository` WHERE id = ? AND guildConfigId = ?",
      [where.id, where.guildConfigId],
    );
  }
  if (where?.guildConfigId && where?.name) {
    return queryOne(
      "SELECT * FROM `repository` WHERE guildConfigId = ? AND LOWER(name) = LOWER(?)",
      [where.guildConfigId, where.name],
    );
  }
  return null;
}

async function repositoryCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `repository` (id, guildConfigId, name, url) VALUES (?, ?, ?, ?)",
    [pk, data.guildConfigId, data.name, data.url],
  );
  return queryOne("SELECT * FROM `repository` WHERE id = ?", [pk]);
}

// ---------- Task (unified bugs and features: is_bug / is_feature) ----------
async function taskFindMany({ where, orderBy, take }) {
  if (!where || !where.guildConfigId) return [];
  let sql = "SELECT * FROM `task` WHERE guildConfigId = ?";
  const params = [where.guildConfigId];
  if (where?.type) {
    sql += " AND type = ?";
    params.push(where.type);
  }
  if (where?.is_bug !== undefined) {
    sql += " AND is_bug = ?";
    params.push(where.is_bug ? 1 : 0);
  }
  if (where?.is_feature !== undefined) {
    sql += " AND is_feature = ?";
    params.push(where.is_feature ? 1 : 0);
  }
  if (where?.status) {
    sql += " AND status = ?";
    params.push(where.status);
  }
  if (where?.createdBy) {
    sql += " AND createdBy = ?";
    params.push(where.createdBy);
  }
  if (where?.createdAtSince) {
    sql += " AND createdAt >= ?";
    params.push(where.createdAtSince);
  }
  const orderByField = orderBy ? Object.keys(orderBy)[0] : 'createdAt';
  const orderByDir = orderBy && orderBy[orderByField] ? orderBy[orderByField].toUpperCase() : 'DESC';
  sql += ` ORDER BY \`${orderByField}\` ${orderByDir}`;
  const limit = Number.isFinite(Number(take)) ? Number(take) : 500;
  sql += ` LIMIT ${limit}`;
  return query(sql, params);
}

async function taskFindFirst({ where }) {
  if (where?.id && where?.guildConfigId)
    return queryOne("SELECT * FROM `task` WHERE id = ? AND guildConfigId = ?", [
      where.id,
      where.guildConfigId,
    ]);
  if (where?.id)
    return queryOne("SELECT * FROM `task` WHERE id = ?", [where.id]);
  if (where?.discordChannelId)
    return queryOne("SELECT * FROM `task` WHERE discordChannelId = ?", [
      where.discordChannelId,
    ]);
  if (where?.externalId)
    return queryOne("SELECT * FROM `task` WHERE externalId = ?", [
      where.externalId,
    ]);
  return null;
}

async function taskCreate({ data }) {
  const pk = id();
  const taskExternalValues = buildTaskInsertValues(data);
  await query(
    `INSERT INTO \`Task\` (id, guildConfigId, type, is_bug, is_feature, title, description, status, createdBy, assigneeIds, taggedMemberIds,
     repositoryId, projectId, projectName, discordChannelId, discordThreadId, externalIssueUrl, externalIssueNumber,
     modules, handlerId, scope, implementationStatus, passedApiTests, passedQaTests, passedAcceptanceCriteria,
     externalId, meetingId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      pk,
      data.guildConfigId,
      data.type ?? (data.is_bug ? "bug" : "feature"),
      data.is_bug ? 1 : 0,
      data.is_feature ? 1 : 0,
      data.title ?? null,
      data.description ?? null,
      data.status ?? (data.is_bug ? "pending" : "open"),
      data.createdBy ?? null,
      toJson(data.assigneeIds || []),
      toJson(data.taggedMemberIds || []),
      data.repositoryId ?? null,
      data.projectId ?? null,
      data.projectName ?? null,
      data.discordChannelId ?? null,
      data.discordThreadId ?? null,
      data.externalIssueUrl ?? null,
      data.externalIssueNumber ?? null,
      toJson(data.modules || []),
      data.handlerId ?? null,
      data.scope ?? null,
      data.implementationStatus ?? null,
      data.passedApiTests ?? null,
      data.passedQaTests ?? null,
      data.passedAcceptanceCriteria ?? null,
      taskExternalValues.externalId,
      taskExternalValues.meetingId,
    ],
  );
  return queryOne("SELECT * FROM `task` WHERE id = ?", [pk]);
}

async function taskUpdate({ where, data }) {
  let id = where?.id;
  if (id == null && where?.externalId != null) {
    const existing = await taskFindFirst({ where: { externalId: where.externalId } });
    id = existing?.id ?? null;
  }
  if (id == null) return null;
  const sets = [];
  const vals = [];
  if (data.modules !== undefined) {
    sets.push("modules = ?");
    vals.push(toJson(data.modules));
  }
  if (data.handlerId !== undefined) {
    sets.push("handlerId = ?");
    vals.push(data.handlerId);
  }
  if (data.scope !== undefined) {
    sets.push("scope = ?");
    vals.push(data.scope);
  }
  if (data.implementationStatus !== undefined) {
    sets.push("implementationStatus = ?");
    vals.push(data.implementationStatus);
  }
  if (data.passedApiTests !== undefined) {
    sets.push("passedApiTests = ?");
    vals.push(data.passedApiTests);
  }
  if (data.passedQaTests !== undefined) {
    sets.push("passedQaTests = ?");
    vals.push(data.passedQaTests);
  }
  if (data.passedAcceptanceCriteria !== undefined) {
    sets.push("passedAcceptanceCriteria = ?");
    vals.push(data.passedAcceptanceCriteria);
  }
  if (data.status !== undefined) {
    sets.push("status = ?");
    vals.push(data.status);
  }
  if (data.discordChannelId !== undefined) {
    sets.push("discordChannelId = ?");
    vals.push(data.discordChannelId);
  }
  if (data.externalIssueUrl !== undefined) {
    sets.push("externalIssueUrl = ?");
    vals.push(data.externalIssueUrl);
  }
  if (data.externalIssueNumber !== undefined) {
    sets.push("externalIssueNumber = ?");
    vals.push(data.externalIssueNumber);
  }
  if (data.assigneeIds !== undefined) {
    sets.push("assigneeIds = ?");
    vals.push(toJson(data.assigneeIds));
  }
  if (data.title !== undefined) {
    sets.push("title = ?");
    vals.push(data.title);
  }
  if (data.description !== undefined) {
    sets.push("description = ?");
    vals.push(data.description);
  }
  if (sets.length === 0) return taskFindFirst({ where: { id } });
  vals.push(id);
  await query(`UPDATE \`Task\` SET ${sets.join(", ")} WHERE id = ?`, vals);
  return taskFindFirst({ where: { id } });
}

async function taskCount({ where }) {
  let sql = "SELECT COUNT(*) AS c FROM `task` WHERE guildConfigId = ?";
  const params = [where.guildConfigId];
  if (where?.type) {
    sql += " AND type = ?";
    params.push(where.type);
  }
  if (where?.is_bug !== undefined) {
    sql += " AND is_bug = ?";
    params.push(where.is_bug ? 1 : 0);
  }
  if (where?.is_feature !== undefined) {
    sql += " AND is_feature = ?";
    params.push(where.is_feature ? 1 : 0);
  }
  if (where?.status) {
    sql += " AND status = ?";
    params.push(where.status);
  }
  if (where?.createdAtSince) {
    sql += " AND createdAt >= ?";
    params.push(where.createdAtSince);
  }
  const row = await queryOne(sql, params);
  return row?.c ?? 0;
}

// Aliases: bugTicket and feature use Task with is_bug / is_feature
async function bugTicketFindMany(opts) {
  return taskFindMany({ ...opts, where: { ...opts.where, is_bug: 1 } });
}
async function bugTicketFindFirst(opts) {
  return taskFindFirst(opts);
}
async function bugTicketCreate({ data }) {
  return taskCreate({
    data: { ...data, type: "bug", is_bug: 1, is_feature: 0 },
  });
}
async function bugTicketUpdate(opts) {
  return taskUpdate(opts);
}
async function bugTicketCount(opts) {
  return taskCount({ ...opts, where: { ...opts.where, is_bug: 1 } });
}

async function featureFindMany(opts) {
  return taskFindMany({ ...opts, where: { ...opts.where, is_feature: 1 } });
}
async function featureFindFirst(opts) {
  return taskFindFirst(opts);
}
async function featureCreate({ data }) {
  return taskCreate({
    data: { ...data, type: "feature", is_feature: 1, is_bug: 0 },
  });
}
async function featureUpdate(opts) {
  return taskUpdate(opts);
}
async function featureCount(opts) {
  return taskCount({ ...opts, where: { ...opts.where, is_feature: 1 } });
}

// ---------- TicketDoc ----------
async function ticketDocFindFirst({ where }) {
  if (where?.id)
    return queryOne("SELECT * FROM `ticketdoc` WHERE id = ?", [where.id]);
  if (where?.taskId)
    return queryOne("SELECT * FROM `ticketdoc` WHERE taskId = ?", [
      where.taskId,
    ]);
  return null;
}

async function ticketDocFindMany({ where, take, orderBy }) {
  if (!where || !where.guildConfigId) return [];
  let sql = "SELECT * FROM `ticketdoc` WHERE guildConfigId = ?";
  const params = [where.guildConfigId];
  if (where?.ticketType) {
    sql += " AND ticketType = ?";
    params.push(where.ticketType);
  }
  if (where?.taskId) {
    sql += " AND taskId = ?";
    params.push(where.taskId);
  }
  const orderByField = orderBy ? Object.keys(orderBy)[0] : 'createdAt';
  const orderByDir = orderBy && orderBy[orderByField] ? orderBy[orderByField].toUpperCase() : 'DESC';
  sql += ` ORDER BY \`${orderByField}\` ${orderByDir}`;
  if (take) {
    sql += " LIMIT ?";
    params.push(take);
  } else {
    sql += " LIMIT ?";
    params.push(100);
  }
  return query(sql, params);
}

async function ticketDocCreate({ data }) {
  const pk = id();
  await query(
    `INSERT INTO \`TicketDoc\` (id, guildConfigId, ticketType, taskId, title, content)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      pk,
      data.guildConfigId,
      data.ticketType,
      data.taskId ?? null,
      data.title,
      data.content ?? null,
    ],
  );
  return queryOne("SELECT * FROM `ticketdoc` WHERE id = ?", [pk]);
}

async function ticketDocUpdate({ where, data }) {
  const sets = [];
  const vals = [];
  if (data.content !== undefined) {
    sets.push("content = ?");
    vals.push(data.content);
  }
  if (data.title !== undefined) {
    sets.push("title = ?");
    vals.push(data.title);
  }
  if (sets.length === 0) return ticketDocFindFirst({ where: { id: where.id } });
  vals.push(where.id);
  await query(`UPDATE \`TicketDoc\` SET ${sets.join(", ")} WHERE id = ?`, vals);
  return ticketDocFindFirst({ where: { id: where.id } });
}

// ---------- DocPage / DocSource ----------
async function docPageListIndex({ guildConfigId }) {
  return query(
    "SELECT id, path, docId, section, projectId, title, source FROM `docpage` WHERE guildConfigId = ? ORDER BY path",
    [guildConfigId],
  );
}

async function docPageListIndexFull({ guildConfigId }) {
  return query(
    "SELECT id, path, docId, section, projectId, title, source, blobSha FROM `docpage` WHERE guildConfigId = ?",
    [guildConfigId],
  );
}

async function docPageFindByDocId({ guildConfigId, docId }) {
  return queryOne("SELECT * FROM `docpage` WHERE guildConfigId = ? AND docId = ?", [
    guildConfigId,
    docId,
  ]);
}

// Discord component values and custom_ids cap at 100 characters and the longest
// docId in the corpus is 103, so components address a page by primary key.
async function docPageFindById({ guildConfigId, id: rowId }) {
  return queryOne("SELECT * FROM `docpage` WHERE guildConfigId = ? AND id = ?", [
    guildConfigId,
    rowId,
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

// A Discord-authored page. The ON DUPLICATE KEY UPDATE clause assigns every
// column conditionally so an existing `source='repo'` row keeps its own values
// and this write becomes a no-op: the read-then-write guard in /edit-docs
// cannot see a sync that lands between its read and its write, but this can.
// `source` is assigned last on purpose — MySQL evaluates the assignments left
// to right and later expressions see the already-updated columns, so every
// IF() above must still read the row's original source.
async function docPageUpsertLocal({ data }) {
  await query(
    "INSERT INTO `docpage` (id, guildConfigId, path, docId, section, projectId, title, content, source, blobSha, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?) ON DUPLICATE KEY UPDATE docId = IF(source = 'repo', docId, VALUES(docId)), section = IF(source = 'repo', section, VALUES(section)), projectId = IF(source = 'repo', projectId, VALUES(projectId)), title = IF(source = 'repo', title, VALUES(title)), content = IF(source = 'repo', content, VALUES(content)), blobSha = IF(source = 'repo', blobSha, VALUES(blobSha)), size = IF(source = 'repo', size, VALUES(size)), source = IF(source = 'repo', source, VALUES(source))",
    [
      id(),
      data.guildConfigId,
      data.path,
      data.docId,
      data.section,
      data.projectId ?? null,
      data.title,
      data.content ?? null,
      data.blobSha ?? null,
      data.size ?? 0,
    ],
  );
}

async function docPageSetProjectId({ guildConfigId, id: rowId, projectId }) {
  await query(
    "UPDATE `docpage` SET projectId = ? WHERE guildConfigId = ? AND id = ?",
    [projectId ?? null, guildConfigId, rowId],
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

// ---------- ScheduledMeeting ----------
async function scheduledMeetingFindMany({ where, orderBy, take }) {
  let sql = "SELECT * FROM `scheduledmeeting` WHERE guildConfigId = ?";
  const params = [where.guildConfigId];
  if (where?.createdBy) {
    sql += " AND createdBy = ?";
    params.push(where.createdBy);
  }
  if (!where?.includeCancelled) {
    sql += " AND cancelled = FALSE";
  }
  // Handle orderBy parameter (e.g., { scheduledAt: 'asc' } or { createdAt: 'desc' })
  const orderByField = orderBy ? Object.keys(orderBy)[0] : 'scheduledAt';
  const orderByDir = orderBy && orderBy[orderByField] ? orderBy[orderByField].toUpperCase() : 'ASC';
  sql += ` ORDER BY \`${orderByField}\` ${orderByDir}`;
  if (take) {
    const limit = Number.isFinite(Number(take)) ? Number(take) : 500;
    sql += ` LIMIT ${limit}`;
  }
  return query(sql, params);
}

async function scheduledMeetingCreate({ data }) {
  const pk = id();
  await query(
    `INSERT INTO \`scheduledmeeting\` (id, guildConfigId, topic, scheduledAt, memberIds, createdBy, voiceChannelId, recordingEnabled, autoChannelId, channelCreatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      pk,
      data.guildConfigId,
      data.topic,
      data.scheduledAt,
      toJson(data.memberIds || []),
      data.createdBy,
      data.voiceChannelId ?? null,
      data.recordingEnabled ?? false,
      null,
      null,
    ],
  );
  return queryOne("SELECT * FROM `scheduledmeeting` WHERE id = ?", [pk]);
}

async function scheduledMeetingCount({ where }) {
  const row = await queryOne(
    "SELECT COUNT(*) AS c FROM `scheduledmeeting` WHERE guildConfigId = ? AND cancelled = FALSE",
    [where.guildConfigId],
  );
  return row?.c ?? 0;
}

async function scheduledMeetingUpdate(id, data) {
  const sets = [];
  const vals = [];
  if (data.reminderSentAt !== undefined) {
    sets.push("reminderSentAt = ?");
    vals.push(data.reminderSentAt);
  }
  if (data.scheduledAt !== undefined) {
    sets.push("scheduledAt = ?");
    vals.push(data.scheduledAt);
  }
  if (data.topic !== undefined) {
    sets.push("topic = ?");
    vals.push(data.topic);
  }
  if (data.memberIds !== undefined) {
    sets.push("memberIds = ?");
    vals.push(toJson(data.memberIds));
  }
  if (data.cancelled !== undefined) {
    sets.push("cancelled = ?");
    vals.push(data.cancelled ? 1 : 0);
  }
  if (sets.length === 0)
    return queryOne("SELECT * FROM `scheduledmeeting` WHERE id = ?", [id]);
  vals.push(id);
  await query(
    `UPDATE \`scheduledmeeting\` SET ${sets.join(", ")} WHERE id = ?`,
    vals,
  );
  return queryOne("SELECT * FROM `scheduledmeeting` WHERE id = ?", [id]);
}

async function scheduledMeetingFindById(id) {
  return queryOne("SELECT * FROM `scheduledmeeting` WHERE id = ?", [id]);
}

/** Upcoming, non-cancelled meetings for a guild (optionally filtered to one creator). */
async function scheduledMeetingFindUpcoming({ guildConfigId, createdBy } = {}) {
  let sql =
    "SELECT * FROM `scheduledmeeting` WHERE guildConfigId = ? AND cancelled = FALSE AND scheduledAt >= ?";
  const params = [guildConfigId, new Date()];
  if (createdBy) {
    sql += " AND createdBy = ?";
    params.push(createdBy);
  }
  sql += " ORDER BY scheduledAt ASC LIMIT 25";
  return query(sql, params);
}

async function scheduledMeetingFindDueForReminder(
  guildId,
  now,
  windowMs = 10 * 60 * 1000,
) {
  const cfg = await getGuildConfig(guildId);
  if (!cfg) return [];
  const end = new Date(now.getTime() + windowMs);
  return query(
    "SELECT * FROM `scheduledmeeting` WHERE guildConfigId = ? AND scheduledAt >= ? AND scheduledAt <= ? AND reminderSentAt IS NULL AND cancelled = FALSE ORDER BY scheduledAt ASC",
    [cfg.id, now, end],
  );
}

// Meetings whose start time has arrived. Bounded below by MISSED_GRACE_MS so a
// long bot downtime doesn't spawn a channel for every meeting missed while offline.
const MISSED_GRACE_MS = 30 * 60 * 1000;

async function scheduledMeetingFindDueToStart(guildId, now) {
  const cfg = await getGuildConfig(guildId);
  if (!cfg) return [];
  const floor = new Date(now.getTime() - MISSED_GRACE_MS);
  return query(
    "SELECT * FROM `scheduledmeeting` WHERE guildConfigId = ? AND scheduledAt <= ? AND scheduledAt >= ? AND autoChannelId IS NULL AND cancelled = FALSE ORDER BY scheduledAt ASC",
    [cfg.id, now, floor],
  );
}

async function scheduledMeetingSetChannel(id, channelId) {
  await query(
    "UPDATE `scheduledmeeting` SET autoChannelId = ?, channelCreatedAt = ? WHERE id = ?",
    [channelId, new Date(), id],
  );
  return queryOne("SELECT * FROM `scheduledmeeting` WHERE id = ?", [id]);
}
// ---------- ProjectSchema ----------
async function projectSchemaFindMany({ where }) {
  return query("SELECT * FROM `projectschema` WHERE guildConfigId = ?", [
    where.guildConfigId,
  ]);
}

async function projectSchemaFindFirst({ where }) {
  if (where?.guildConfigId && where?.projectId) {
    return queryOne(
      "SELECT * FROM `projectschema` WHERE guildConfigId = ? AND projectId = ?",
      [where.guildConfigId, where.projectId],
    );
  }
  if (where?.guildConfigId && where?.id) {
    return queryOne(
      "SELECT * FROM `projectschema` WHERE guildConfigId = ? AND id = ?",
      [where.guildConfigId, where.id],
    );
  }
  return null;
}

async function projectSchemaUpsert({ where, create, update }) {
  const existing = await projectSchemaFindFirst({
    where: {
      guildConfigId: where.guildConfigId_projectId.guildConfigId,
      projectId: where.guildConfigId_projectId.projectId,
    },
  });
  if (existing) {
    await query(
      "UPDATE `projectschema` SET schemaContent = ?, projectName = ?, readme = ? WHERE id = ?",
      [
        update.schemaContent ?? existing.schemaContent,
        update.projectName ?? existing.projectName,
        update.readme !== undefined ? update.readme : existing.readme,
        existing.id,
      ],
    );
    return projectSchemaFindFirst({
      where: {
        guildConfigId: where.guildConfigId_projectId.guildConfigId,
        projectId: where.guildConfigId_projectId.projectId,
      },
    });
  }
  const pk = id();
  await query(
    "INSERT INTO `projectschema` (id, guildConfigId, projectId, projectName, schemaContent, readme) VALUES (?, ?, ?, ?, ?, ?)",
    [
      pk,
      create.guildConfigId,
      create.projectId,
      create.projectName ?? create.projectId,
      create.schemaContent,
      create.readme ?? null,
    ],
  );
  return queryOne("SELECT * FROM `projectschema` WHERE id = ?", [pk]);
}

// ---------- Project (new: name, readme, owner_emails) ----------
async function projectFindMany({ where }) {
  return query("SELECT * FROM `project` WHERE guildConfigId = ?", [
    where.guildConfigId,
  ]);
}
async function projectFindFirst({ where }) {
  if (where?.id)
    return queryOne("SELECT * FROM `project` WHERE id = ?", [where.id]);
  if (where?.guildConfigId && where?.name)
    return queryOne(
      "SELECT * FROM `project` WHERE guildConfigId = ? AND name = ?",
      [where.guildConfigId, where.name],
    );
  return null;
}
async function projectCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `project` (id, guildConfigId, name, readme, owner_emails, docsSlug, docsPaths) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      pk,
      data.guildConfigId,
      data.name,
      data.readme ?? null,
      data.owner_emails
        ? Array.isArray(data.owner_emails)
          ? JSON.stringify(data.owner_emails)
          : data.owner_emails
        : "[]",
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

// ---------- project_schemas (FK project, name, latest_dump_id) ----------
async function projectSchemasFindMany({ where }) {
  if (where?.project_id)
    return query("SELECT * FROM `project_schemas` WHERE project_id = ?", [
      where.project_id,
    ]);
  return query("SELECT * FROM `project_schemas` WHERE 1=1 LIMIT 100");
}
async function projectSchemaRecordFindFirst({ where }) {
  if (where?.id)
    return queryOne("SELECT * FROM `project_schemas` WHERE id = ?", [where.id]);
  if (where?.project_id && where?.name)
    return queryOne(
      "SELECT * FROM `project_schemas` WHERE project_id = ? AND name = ?",
      [where.project_id, where.name],
    );
  return null;
}

// ---------- dump_versions ----------
async function dumpVersionFindMany({ where, take }) {
  let sql =
    "SELECT * FROM `dump_versions` WHERE project_schema_id = ? ORDER BY created_at DESC";
  const params = [where.project_schema_id];
  if (take) {
    sql += " LIMIT ?";
    params.push(take);
  }
  return query(sql, params);
}
async function dumpVersionCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `dump_versions` (id, project_schema_id, content, created_by) VALUES (?, ?, ?, ?)",
    [pk, data.project_schema_id, data.content, data.created_by ?? null],
  );
  return queryOne("SELECT * FROM `dump_versions` WHERE id = ?", [pk]);
}

// ---------- project_repos (bridge) ----------
async function projectReposFindMany({ where }) {
  if (where?.project_id)
    return query("SELECT * FROM `project_repos` WHERE project_id = ?", [
      where.project_id,
    ]);
  if (where?.repository_id)
    return query("SELECT * FROM `project_repos` WHERE repository_id = ?", [
      where.repository_id,
    ]);
  return query("SELECT * FROM `project_repos` LIMIT 200");
}
async function projectReposAdd({ data }) {
  await query(
    "INSERT IGNORE INTO `project_repos` (project_id, repository_id) VALUES (?, ?)",
    [data.project_id, data.repository_id],
  );
}

// ---------- Faq ----------
async function faqFindMany({ where, take, orderBy, include }) {
  if (!where || !where.guildConfigId) return [];
  const baseFrom = " FROM `faq` f";
  const join = include?.repository
    ? " LEFT JOIN `repository` r ON f.repositoryId = r.id"
    : "";
  const select = include?.repository
    ? "SELECT f.*, r.id AS repo_id, r.name AS repo_name, r.url AS repo_url"
    : "SELECT f.*";
  let sql = select + baseFrom + join + " WHERE f.guildConfigId = ?";
  const params = [where.guildConfigId];
  if (where?.status) {
    sql += " AND f.status = ?";
    params.push(where.status);
  }
  if (where?.repositoryId) {
    sql += " AND f.repositoryId = ?";
    params.push(where.repositoryId);
  }
  if (where?.OR && Array.isArray(where.OR) && where.OR.length > 0) {
    const q =
      where.OR[0]?.question?.contains || where.OR[0]?.answer?.contains || "";
    sql += " AND (f.question LIKE ? OR f.answer LIKE ?)";
    params.push("%" + q + "%", "%" + q + "%");
  }
  const orderByField = orderBy ? Object.keys(orderBy)[0] : 'f.createdAt';
  const orderByDir = orderBy && orderBy[orderByField] ? orderBy[orderByField].toUpperCase() : 'DESC';
  sql += ` ORDER BY ${orderByField} ${orderByDir}`;
  if (take) {
    sql += " LIMIT ?";
    params.push(take);
  } else {
    sql += " LIMIT ?";
    params.push(10);
  }
  const rows = await query(sql, params);
  if (!include?.repository) return rows;
  return rows.map((r) => ({
    id: r.id,
    guildConfigId: r.guildConfigId,
    repositoryId: r.repositoryId,
    question: r.question,
    answer: r.answer,
    askedBy: r.askedBy,
    answeredBy: r.answeredBy,
    answeredAt: r.answeredAt,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    repository: r.repo_id
      ? { id: r.repo_id, name: r.repo_name, url: r.repo_url }
      : null,
  }));
}

async function faqFindFirst({ where }) {
  let sql = "SELECT * FROM `faq` WHERE guildConfigId = ?";
  const params = [where.guildConfigId];
  if (where?.id) {
    sql += " AND id = ?";
    params.push(where.id);
  }
  if (where?.repositoryId) {
    sql += " AND repositoryId = ?";
    params.push(where.repositoryId);
  }
  if (where?.name) {
    const repo = await queryOne(
      "SELECT id FROM `repository` WHERE guildConfigId = ? AND name = ?",
      [where.guildConfigId, where.name],
    );
    if (repo) {
      sql += " AND repositoryId = ?";
      params.push(repo.id);
    }
  }
  return queryOne(sql, params);
}

async function faqCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `faq` (id, guildConfigId, repositoryId, question, askedBy, status) VALUES (?, ?, ?, ?, ?, ?)",
    [
      pk,
      data.guildConfigId,
      data.repositoryId ?? null,
      data.question,
      data.askedBy,
      data.status ?? "open",
    ],
  );
  return queryOne("SELECT * FROM `faq` WHERE id = ?", [pk]);
}

async function faqUpdate({ where, data }) {
  const sets = [];
  const vals = [];
  if (data.answer !== undefined) {
    sets.push("answer = ?");
    vals.push(data.answer);
  }
  if (data.answeredBy !== undefined) {
    sets.push("answeredBy = ?");
    vals.push(data.answeredBy);
  }
  if (data.answeredAt !== undefined) {
    sets.push("answeredAt = ?");
    vals.push(data.answeredAt);
  }
  if (data.status !== undefined) {
    sets.push("status = ?");
    vals.push(data.status);
  }
  if (sets.length === 0)
    return queryOne("SELECT * FROM `faq` WHERE id = ?", [where.id]);
  vals.push(where.id);
  await query(`UPDATE \`Faq\` SET ${sets.join(", ")} WHERE id = ?`, vals);
  return queryOne("SELECT * FROM `faq` WHERE id = ?", [where.id]);
}

async function faqCount({ where }) {
  let sql = "SELECT COUNT(*) AS c FROM `faq` WHERE guildConfigId = ?";
  const params = [where.guildConfigId];
  if (where?.status) {
    sql += " AND status = ?";
    params.push(where.status);
  }
  const row = await queryOne(sql, params);
  return row?.c ?? 0;
}

// ---------- VerificationToken ----------
async function verificationTokenCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `verificationtoken` (id, token, guildConfigId, discordId, email, expiresAt) VALUES (?, ?, ?, ?, ?, ?)",
    [
      pk,
      data.token,
      data.guildConfigId,
      data.discordId,
      data.email,
      data.expiresAt,
    ],
  );
  return queryOne("SELECT * FROM `verificationtoken` WHERE id = ?", [pk]);
}

async function verificationTokenFindUnique({ where }) {
  return queryOne("SELECT * FROM `verificationtoken` WHERE token = ?", [
    where.token,
  ]);
}

async function verificationTokenDelete({ where }) {
  await query("DELETE FROM `verificationtoken` WHERE token = ?", [where.token]);
}

// ---------- VerificationOtp (in-Discord OTP verification) ----------
async function verificationOtpCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `verificationotp` (id, guildConfigId, discordId, email, code, expiresAt) VALUES (?, ?, ?, ?, ?, ?)",
    [
      pk,
      data.guildConfigId,
      data.discordId,
      data.email,
      data.code,
      data.expiresAt,
    ],
  );
  return queryOne("SELECT * FROM `verificationotp` WHERE id = ?", [pk]);
}

async function verificationOtpFindValid(guildId, discordId, email, code) {
  const cfg = await getGuildConfig(guildId);
  if (!cfg) return null;
  return queryOne(
    "SELECT * FROM `verificationotp` WHERE guildConfigId = ? AND discordId = ? AND email = ? AND code = ? AND expiresAt > NOW()",
    [cfg.id, discordId, email, code],
  );
}

/** Find valid OTP by code only (used when email comes from stored member record). */
async function verificationOtpFindValidByCode(guildId, discordId, code) {
  const cfg = await getGuildConfig(guildId);
  if (!cfg) return null;
  return queryOne(
    "SELECT * FROM `verificationotp` WHERE guildConfigId = ? AND discordId = ? AND code = ? AND expiresAt > NOW()",
    [cfg.id, discordId, code],
  );
}

async function verificationOtpDelete({ where }) {
  if (where?.guildId_discordId) {
    const cfg = await getGuildConfig(where.guildId_discordId.guildId);
    if (!cfg) return;
    await query(
      "DELETE FROM `verificationotp` WHERE guildConfigId = ? AND discordId = ?",
      [cfg.id, where.guildId_discordId.discordId],
    );
    return;
  }
  if (where?.id) {
    await query("DELETE FROM `verificationotp` WHERE id = ?", [where.id]);
  }
}

// ---------- email_log ----------
async function emailLogCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `email_log` (id, guildConfigId, recipient_email, subject, content) VALUES (?, ?, ?, ?, ?)",
    [
      pk,
      data.guildConfigId ?? null,
      data.recipient_email,
      data.subject ?? null,
      data.content ?? null,
    ],
  );
  return pk;
}

// ---------- PendingInvite (invite code + email when sending /invite; used on member join) ----------
async function pendingInviteCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `pendinginvite` (id, guildConfigId, inviteCode, email) VALUES (?, ?, ?, ?)",
    [pk, data.guildConfigId, data.inviteCode, data.email],
  );
  return queryOne("SELECT * FROM `pendinginvite` WHERE id = ?", [pk]);
}

async function pendingInviteFindByGuild(guildConfigId) {
  return query("SELECT * FROM `pendinginvite` WHERE guildConfigId = ?", [
    guildConfigId,
  ]);
}

async function pendingInviteDeleteByCode(guildConfigId, inviteCode) {
  await query(
    "DELETE FROM `pendinginvite` WHERE guildConfigId = ? AND inviteCode = ?",
    [guildConfigId, inviteCode],
  );
}

// ---------- GuildMember by email (for invite DM) ----------
async function guildMemberFindByEmail(guildId, email) {
  const cfg = await getGuildConfig(guildId);
  if (!cfg) return null;
  return queryOne(
    "SELECT * FROM `guildmember` WHERE guildConfigId = ? AND LOWER(email) = LOWER(?)",
    [cfg.id, email],
  );
}

// ---------- Meeting & MeetingChannel (for meetingListener) ----------
async function meetingCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `meeting` (id, guildConfigId, channelId, externalId, transcript, notes, projectId, repositoryUrl) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      pk,
      data.guildConfigId,
      data.channelId,
      data.externalId ?? null,
      data.transcript ?? null,
      data.notes ?? null,
      data.projectId ?? null,
      data.repositoryUrl ?? null,
    ],
  );
  return queryOne("SELECT * FROM `meeting` WHERE id = ?", [pk]);
}

async function meetingFindUnique({ where }) {
  if (where?.id)
    return queryOne("SELECT * FROM `meeting` WHERE id = ?", [where.id]);
  return null;
}

async function meetingUpdate({ where, data }) {
  const sets = [];
  const vals = [];
  if (data.transcript !== undefined) {
    sets.push("transcript = ?");
    vals.push(data.transcript);
  }
  if (data.notes !== undefined) {
    sets.push("notes = ?");
    vals.push(data.notes);
  }
  if (sets.length === 0)
    return queryOne("SELECT * FROM `meeting` WHERE id = ?", [where.id]);
  vals.push(where.id);
  await query(`UPDATE \`meeting\` SET ${sets.join(", ")} WHERE id = ?`, vals);
  return queryOne("SELECT * FROM `meeting` WHERE id = ?", [where.id]);
}

async function meetingChannelFindFirst({ where }) {
  if (where?.textChannelId) {
    return queryOne(
      "SELECT * FROM `meetingchannel` WHERE guildConfigId = ? AND textChannelId = ?",
      [where.guildConfigId, where.textChannelId],
    );
  }
  if (where?.voiceChannelId) {
    return queryOne(
      "SELECT * FROM `meetingchannel` WHERE guildConfigId = ? AND voiceChannelId = ?",
      [where.guildConfigId, where.voiceChannelId],
    );
  }
  return null;
}

async function meetingChannelFindUnique({ where }) {
  if (where?.meetingId)
    return queryOne("SELECT * FROM `meetingchannel` WHERE meetingId = ?", [
      where.meetingId,
    ]);
  if (where?.id)
    return queryOne("SELECT * FROM `meetingchannel` WHERE id = ?", [where.id]);
  return null;
}

async function meetingChannelCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `meetingchannel` (id, guildConfigId, voiceChannelId, textChannelId, meetingId) VALUES (?, ?, ?, ?, ?)",
    [
      pk,
      data.guildConfigId,
      data.voiceChannelId,
      data.textChannelId ?? null,
      data.meetingId ?? null,
    ],
  );
  return queryOne("SELECT * FROM `meetingchannel` WHERE id = ?", [pk]);
}

async function meetingChannelUpdate({ where, data }) {
  const sets = [];
  const vals = [];
  if (data.textChannelId !== undefined) {
    sets.push("textChannelId = ?");
    vals.push(data.textChannelId);
  }
  if (data.meetingId !== undefined) {
    sets.push("meetingId = ?");
    vals.push(data.meetingId);
  }
  if (sets.length === 0) return meetingChannelFindUnique({ where });
  vals.push(where.id);
  await query(
    `UPDATE \`meetingchannel\` SET ${sets.join(", ")} WHERE id = ?`,
    vals,
  );
  return meetingChannelFindUnique({ where: { id: where.id } });
}

// ---------- MeetingRecording (for individual user audio recordings) ----------
async function meetingRecordingCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `MeetingRecording` (id, guildConfigId, meetingId, memberId, filePath, fileName, audioFormat, startedAt, endedAt, durationSeconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      pk,
      data.guildConfigId,
      data.meetingId,
      data.memberId,
      data.filePath ?? null,
      data.fileName ?? null,
      data.audioFormat ?? "ogg",
      data.startedAt ?? null,
      data.endedAt ?? null,
      data.durationSeconds ?? 0,
    ],
  );
  return queryOne("SELECT * FROM `MeetingRecording` WHERE id = ?", [pk]);
}

async function meetingRecordingFindMany({ where }) {
  let sql = "SELECT * FROM `MeetingRecording` WHERE 1=1";
  const params = [];
  if (where?.meetingId) {
    sql += " AND meetingId = ?";
    params.push(where.meetingId);
  }
  if (where?.guildConfigId) {
    sql += " AND guildConfigId = ?";
    params.push(where.guildConfigId);
  }
  if (where?.memberId) {
    sql += " AND memberId = ?";
    params.push(where.memberId);
  }
  sql += " ORDER BY startedAt DESC";
  return query(sql, params);
}

// ---------- Meeting Delete ----------
async function meetingDelete({ where }) {
  if (where?.id) {
    await query("DELETE FROM `meeting` WHERE id = ?", [where.id]);
    return { success: true };
  }
  return { success: false };
}

// ---------- MeetingRecordingStatus (for tracking recording session status) ----------
async function meetingRecordingStatusCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `MeetingRecordingStatus` (id, guildConfigId, meetingId, status, voiceChannelId, startedAt, endedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      pk,
      data.guildConfigId,
      data.meetingId,
      data.status ?? "idle",
      data.voiceChannelId ?? null,
      data.startedAt ?? null,
      data.endedAt ?? null,
    ],
  );
  return queryOne("SELECT * FROM `MeetingRecordingStatus` WHERE id = ?", [pk]);
}

async function meetingRecordingStatusFindUnique({ where }) {
  if (where?.meetingId) {
    return queryOne("SELECT * FROM `MeetingRecordingStatus` WHERE meetingId = ?", [where.meetingId]);
  }
  if (where?.id) {
    return queryOne("SELECT * FROM `MeetingRecordingStatus` WHERE id = ?", [where.id]);
  }
  return null;
}

async function meetingRecordingStatusUpsert({ where, create, update }) {
  const existing = await meetingRecordingStatusFindUnique({ where });
  if (existing) {
    const sets = [];
    const vals = [];
    if (update.status !== undefined) {
      sets.push("status = ?");
      vals.push(update.status);
    }
    if (update.voiceChannelId !== undefined) {
      sets.push("voiceChannelId = ?");
      vals.push(update.voiceChannelId);
    }
    if (update.startedAt !== undefined) {
      sets.push("startedAt = ?");
      vals.push(update.startedAt);
    }
    if (update.endedAt !== undefined) {
      sets.push("endedAt = ?");
      vals.push(update.endedAt);
    }
    if (sets.length === 0) return existing;
    vals.push(existing.id);
    await query(
      `UPDATE \`MeetingRecordingStatus\` SET ${sets.join(", ")} WHERE id = ?`,
      vals,
    );
    return meetingRecordingStatusFindUnique({ where: { id: existing.id } });
  }
  return meetingRecordingStatusCreate({ data: create });
}

async function meetingRecordingStatusUpdate({ where, data }) {
  const sets = [];
  const vals = [];
  if (data.status !== undefined) {
    sets.push("status = ?");
    vals.push(data.status);
  }
  if (data.voiceChannelId !== undefined) {
    sets.push("voiceChannelId = ?");
    vals.push(data.voiceChannelId);
  }
  if (data.startedAt !== undefined) {
    sets.push("startedAt = ?");
    vals.push(data.startedAt);
  }
  if (data.endedAt !== undefined) {
    sets.push("endedAt = ?");
    vals.push(data.endedAt);
  }
  if (sets.length === 0) return meetingRecordingStatusFindUnique({ where });
  vals.push(where.meetingId);
  await query(
    `UPDATE \`MeetingRecordingStatus\` SET ${sets.join(", ")} WHERE meetingId = ?`,
    vals,
  );
  return meetingRecordingStatusFindUnique({ where: { meetingId: where.meetingId } });
}

// ---------- meeting_pipeline_job ----------
function _mpjRow(row) {
  if (!row) return null;
  let dataJson = null;
  try {
    dataJson = row.dataJson ? (typeof row.dataJson === "string" ? JSON.parse(row.dataJson) : row.dataJson) : null;
  } catch {
    dataJson = null;
  }
  return { ...row, dataJson };
}

async function meetingPipelineJobCreate({ data }) {
  const existing = await queryOne("SELECT * FROM `meeting_pipeline_job` WHERE meetingId = ?", [data.meetingId]);
  if (existing) return _mpjRow(existing);
  const pk = id();
  await query(
    "INSERT INTO `meeting_pipeline_job` (id, guildConfigId, meetingId) VALUES (?, ?, ?)",
    [pk, data.guildConfigId, data.meetingId],
  );
  return _mpjRow(await queryOne("SELECT * FROM `meeting_pipeline_job` WHERE id = ?", [pk]));
}

async function meetingPipelineJobFindByMeeting(meetingId) {
  return _mpjRow(await queryOne("SELECT * FROM `meeting_pipeline_job` WHERE meetingId = ?", [meetingId]));
}

async function meetingPipelineJobFindById(jobId) {
  return _mpjRow(await queryOne("SELECT * FROM `meeting_pipeline_job` WHERE id = ?", [jobId]));
}

function _mpjStaleSeconds() {
  return Math.max(1, Math.round((Number(process.env.MEETING_STAGE_TIMEOUT_MS) || 360000) / 1000));
}

async function meetingPipelineJobClaimBatch(limit = 3) {
  // Pick up pending jobs, plus jobs stuck in 'working' past the stage timeout
  // (crashed/killed process left them mid-transition — the claim will re-take them).
  //
  // query() runs prepared statements (pool.execute). mysql2 binds a JS number as a
  // DOUBLE, which MySQL rejects inside LIMIT and INTERVAL ... SECOND with
  // "Incorrect arguments to mysqld_stmt_execute" — the first live tick failed on
  // exactly this. Both values are clamped integers we control, so inline them.
  const cap = Math.min(Math.max(parseInt(limit, 10) || 3, 1), 50);
  const stale = _mpjStaleSeconds();
  const rows = await query(
    `SELECT * FROM \`meeting_pipeline_job\`
     WHERE (
       (status = 'pending' AND (nextAttemptAt IS NULL OR nextAttemptAt <= NOW(3)))
       OR (status = 'working' AND updatedAt < NOW(3) - INTERVAL ${stale} SECOND)
     )
     ORDER BY updatedAt ASC LIMIT ${cap}`,
  );
  return rows.map(_mpjRow);
}

// Conditional claim: flip pending -> working (or re-take a stale 'working') for
// exactly one worker. Returns true only when this call won the row.
async function meetingPipelineJobClaim(jobId) {
  // Same prepared-statement constraint as claimBatch: INTERVAL takes an inlined
  // integer, never a bound parameter.
  const stale = _mpjStaleSeconds();
  const result = await query(
    `UPDATE \`meeting_pipeline_job\` SET status = 'working', updatedAt = NOW(3)
     WHERE id = ? AND (
       status = 'pending'
       OR (status = 'working' AND updatedAt < NOW(3) - INTERVAL ${stale} SECOND)
     )`,
    [jobId],
  );
  return result?.affectedRows === 1;
}

async function meetingPipelineJobUpdate(jobId, patch) {
  const cols = ["stage", "status", "csaasMeetingId", "attempts", "nextAttemptAt", "lastError", "reviewMessageId", "dataJson"];
  const sets = [];
  const vals = [];
  for (const c of cols) {
    if (patch[c] === undefined) continue;
    sets.push(`\`${c}\` = ?`);
    vals.push(c === "dataJson" && patch[c] !== null && typeof patch[c] === "object" ? JSON.stringify(patch[c]) : patch[c]);
  }
  if (!sets.length) return meetingPipelineJobFindById(jobId);
  vals.push(jobId);
  await query(`UPDATE \`meeting_pipeline_job\` SET ${sets.join(", ")} WHERE id = ?`, vals);
  return meetingPipelineJobFindById(jobId);
}

// Guarded update: apply `patch` only when the row still matches `cond` (column
// equality). Returns true iff exactly one row was updated. Used to make the
// review approve/reject buttons safe against double-clicks and races.
async function meetingPipelineJobUpdateIf(jobId, patch, cond = {}) {
  const cols = ["stage", "status", "csaasMeetingId", "attempts", "nextAttemptAt", "lastError", "reviewMessageId", "dataJson"];
  const sets = [];
  const vals = [];
  for (const c of cols) {
    if (patch[c] === undefined) continue;
    sets.push(`\`${c}\` = ?`);
    vals.push(c === "dataJson" && patch[c] !== null && typeof patch[c] === "object" ? JSON.stringify(patch[c]) : patch[c]);
  }
  if (!sets.length) return false;
  const whereParts = ["id = ?"];
  const whereVals = [jobId];
  for (const [k, v] of Object.entries(cond)) {
    whereParts.push(`\`${k}\` = ?`);
    whereVals.push(v);
  }
  const result = await query(
    `UPDATE \`meeting_pipeline_job\` SET ${sets.join(", ")} WHERE ${whereParts.join(" AND ")}`,
    [...vals, ...whereVals],
  );
  return result?.affectedRows === 1;
}

// ---------- UserChannel (for /create-channel, protected from /cleanup) ----------
async function userChannelCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `userchannel` (id, guildConfigId, voiceChannelId, textChannelId, name, createdBy, memberIds) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      pk,
      data.guildConfigId,
      data.voiceChannelId ?? null,
      data.textChannelId ?? null,
      data.name,
      data.createdBy,
      JSON.stringify(data.memberIds ?? []),
    ],
  );
  return queryOne("SELECT * FROM `userchannel` WHERE id = ?", [pk]);
}

async function userChannelFindMany({ where }) {
  let sql = "SELECT * FROM `userchannel` WHERE 1=1";
  const params = [];
  if (where?.guildConfigId) {
    sql += " AND guildConfigId = ?";
    params.push(where.guildConfigId);
  }
  if (where?.createdBy) {
    sql += " AND createdBy = ?";
    params.push(where.createdBy);
  }
  sql += " ORDER BY createdAt DESC";
  return query(sql, params);
}

async function userChannelDelete({ where }) {
  if (where?.id) {
    await query("DELETE FROM `userchannel` WHERE id = ?", [where.id]);
  }
  if (where?.voiceChannelId) {
    await query("DELETE FROM `userchannel` WHERE voiceChannelId = ?", [where.voiceChannelId]);
  }
  if (where?.textChannelId) {
    await query("DELETE FROM `userchannel` WHERE textChannelId = ?", [where.textChannelId]);
  }
}

// ---------- Faq findMany with search (faq.js search) ----------
async function faqSearch(guildId, queryStr, repoName, limit = 10) {
  const cfg = await getGuildConfig(guildId);
  if (!cfg) return [];
  let sql =
    "SELECT f.*, r.name AS repo_name FROM `faq` f LEFT JOIN `repository` r ON f.repositoryId = r.id WHERE f.guildConfigId = ?";
  const params = [cfg.id];
  if (queryStr) {
    sql += " AND (f.question LIKE ? OR f.answer LIKE ?)";
    params.push("%" + queryStr + "%", "%" + queryStr + "%");
  }
  if (repoName) {
    sql += " AND r.name = ?";
    params.push(repoName);
  }
  sql += " ORDER BY f.createdAt DESC LIMIT ?";
  params.push(limit);
  return query(sql, params);
}

// ---------- ClockEntry ----------
async function clockEntryCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO `clockentry` (id, guildConfigId, discordId, clockInAt, clockOutAt) VALUES (?, ?, ?, ?, ?)",
    [
      pk,
      data.guildConfigId,
      data.discordId,
      data.clockInAt,
      data.clockOutAt ?? null,
    ],
  );
  return queryOne("SELECT * FROM `clockentry` WHERE id = ?", [pk]);
}
async function clockEntryFindActive(guildId, discordId) {
  const cfg = await getGuildConfig(guildId);
  if (!cfg) return null;
  return queryOne(
    "SELECT * FROM `clockentry` WHERE guildConfigId = ? AND discordId = ? AND clockOutAt IS NULL ORDER BY clockInAt DESC LIMIT 1",
    [cfg.id, discordId],
  );
}
async function clockEntryUpdate(id, data) {
  const sets = [];
  const vals = [];
  if (data.clockOutAt !== undefined) {
    sets.push("clockOutAt = ?");
    vals.push(data.clockOutAt);
  }
  if (sets.length === 0)
    return queryOne("SELECT * FROM `clockentry` WHERE id = ?", [id]);
  vals.push(id);
  await query(
    `UPDATE \`ClockEntry\` SET ${sets.join(", ")} WHERE id = ?`,
    vals,
  );
  return queryOne("SELECT * FROM `clockentry` WHERE id = ?", [id]);
}
async function clockEntryFindMany({ where, orderBy, take }) {
  let sql = "SELECT * FROM `clockentry` WHERE guildConfigId = ?";
  const params = [where.guildConfigId];
  if (where.discordId) {
    sql += " AND discordId = ?";
    params.push(where.discordId);
  }
  sql += " ORDER BY clockInAt DESC";
  if (take) {
    sql += " LIMIT ?";
    params.push(take);
  }
  return query(sql, params);
}

// ---------- feature_repositories (many-to-many: task_id for feature tasks) ----------
async function featureRepositoriesAdd(taskId, repositoryIds) {
  if (!repositoryIds?.length) return;
  for (const rid of repositoryIds) {
    await query(
      "INSERT IGNORE INTO feature_repositories (task_id, repository_id) VALUES (?, ?)",
      [taskId, rid],
    );
  }
}

// ---------- feature_project_schemas (many-to-many: task_id for feature tasks) ----------
async function featureProjectSchemasAdd(taskId, projectSchemaIds) {
  if (!projectSchemaIds?.length) return;
  for (const sid of projectSchemaIds) {
    await query(
      "INSERT IGNORE INTO feature_project_schemas (task_id, project_schema_id) VALUES (?, ?)",
      [taskId, sid],
    );
  }
}

// ---------- guild_scopes ----------
async function guildScopeFindMany({ where }) {
  return query(
    "SELECT * FROM guild_scopes WHERE guildConfigId = ? ORDER BY name ASC",
    [where.guildConfigId],
  );
}
async function guildScopeCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO guild_scopes (id, guildConfigId, name) VALUES (?, ?, ?)",
    [pk, data.guildConfigId, data.name],
  );
  return queryOne("SELECT * FROM guild_scopes WHERE id = ?", [pk]);
}
async function guildScopeFindFirst({ where }) {
  if (where?.guildConfigId && where?.name) {
    return queryOne(
      "SELECT * FROM guild_scopes WHERE guildConfigId = ? AND name = ?",
      [where.guildConfigId, where.name],
    );
  }
  return null;
}

// ---------- guild_modules ----------
async function guildModuleFindMany({ where }) {
  return query(
    "SELECT * FROM guild_modules WHERE guildConfigId = ? ORDER BY name ASC",
    [where.guildConfigId],
  );
}
async function guildModuleCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO guild_modules (id, guildConfigId, name) VALUES (?, ?, ?)",
    [pk, data.guildConfigId, data.name],
  );
  return queryOne("SELECT * FROM guild_modules WHERE id = ?", [pk]);
}
async function guildModuleFindFirst({ where }) {
  if (where?.guildConfigId && where?.name) {
    return queryOne(
      "SELECT * FROM guild_modules WHERE guildConfigId = ? AND name = ?",
      [where.guildConfigId, where.name],
    );
  }
  return null;
}

// ---------- guild_assignable_roles (backlog role multiselect) ----------
async function guildAssignableRoleFindMany({ where }) {
  return query(
    "SELECT * FROM guild_assignable_roles WHERE guildConfigId = ? ORDER BY name ASC",
    [where.guildConfigId],
  );
}
async function guildAssignableRoleCreate({ data }) {
  const pk = id();
  await query(
    "INSERT INTO guild_assignable_roles (id, guildConfigId, name) VALUES (?, ?, ?)",
    [pk, data.guildConfigId, data.name],
  );
  return queryOne("SELECT * FROM guild_assignable_roles WHERE id = ?", [pk]);
}
async function guildAssignableRoleFindFirst({ where }) {
  if (where?.guildConfigId && where?.name) {
    return queryOne(
      "SELECT * FROM guild_assignable_roles WHERE guildConfigId = ? AND name = ?",
      [where.guildConfigId, where.name],
    );
  }
  return null;
}

// ---------- db facade (default export) ----------
const db = {
  guildConfig: {
    findUnique: ({ where }) =>
      where?.guildId ? getGuildConfig(where.guildId) : null,
    create: () => {
      throw new Error("Use getOrCreateGuildConfig");
    },
    update: ({ where, data }) => updateGuildConfig(where.guildId, data),
    delete: ({ where }) => deleteGuildConfig(where.guildId),
  },
  guildMember: {
    findMany: guildMemberFindMany,
    findUnique: guildMemberFindUnique,
    upsert: guildMemberUpsert,
    update: guildMemberUpdate,
  },
  repository: {
    findMany: repositoryFindMany,
    findFirst: repositoryFindFirst,
    create: repositoryCreate,
  },
  bugTicket: {
    findMany: bugTicketFindMany,
    findFirst: bugTicketFindFirst,
    create: bugTicketCreate,
    update: bugTicketUpdate,
    count: bugTicketCount,
  },
  feature: {
    findMany: featureFindMany,
    findFirst: featureFindFirst,
    create: featureCreate,
    update: featureUpdate,
    count: featureCount,
  },
  featureRepositories: { add: featureRepositoriesAdd },
  featureProjectSchemas: { add: featureProjectSchemasAdd },
  guildScope: {
    findMany: guildScopeFindMany,
    findFirst: guildScopeFindFirst,
    create: guildScopeCreate,
  },
  guildModule: {
    findMany: guildModuleFindMany,
    findFirst: guildModuleFindFirst,
    create: guildModuleCreate,
  },
  guildAssignableRole: {
    findMany: guildAssignableRoleFindMany,
    findFirst: guildAssignableRoleFindFirst,
    create: guildAssignableRoleCreate,
  },
  task: {
    findMany: taskFindMany,
    findFirst: taskFindFirst,
    create: taskCreate,
    update: taskUpdate,
    count: taskCount,
  },
  ticketDoc: {
    findMany: ticketDocFindMany,
    findFirst: ticketDocFindFirst,
    create: ticketDocCreate,
    update: ticketDocUpdate,
  },
  docPage: {
    listIndex: docPageListIndex,
    listIndexFull: docPageListIndexFull,
    findByDocId: docPageFindByDocId,
    findById: docPageFindById,
    search: docPageSearch,
    upsert: docPageUpsert,
    upsertLocal: docPageUpsertLocal,
    setProjectId: docPageSetProjectId,
    deleteRepoPathsNotIn: docPageDeleteRepoPathsNotIn,
    countsByProject: docPageCountsByProject,
  },
  docSource: {
    get: docSourceGet,
    upsert: docSourceUpsert,
    recordSync: docSourceRecordSync,
    recordError: docSourceRecordError,
  },
  scheduledMeeting: {
    findMany: scheduledMeetingFindMany,
    findById: scheduledMeetingFindById,
    findUpcoming: scheduledMeetingFindUpcoming,
    create: scheduledMeetingCreate,
    count: scheduledMeetingCount,
    update: scheduledMeetingUpdate,
    findDueForReminder: scheduledMeetingFindDueForReminder,
    findDueToStart: scheduledMeetingFindDueToStart,
    setChannel: scheduledMeetingSetChannel,
  },
  projectSchema: {
    findMany: projectSchemaFindMany,
    findFirst: projectSchemaFindFirst,
    upsert: projectSchemaUpsert,
  },
  project: {
    findMany: projectFindMany,
    findFirst: projectFindFirst,
    create: projectCreate,
    findByName: projectFindByName,
  },
  projectSchemas: {
    findMany: projectSchemasFindMany,
    findFirst: projectSchemaRecordFindFirst,
  },
  dumpVersions: {
    findMany: dumpVersionFindMany,
    create: dumpVersionCreate,
  },
  projectRepos: {
    findMany: projectReposFindMany,
    add: projectReposAdd,
  },
  faq: {
    findMany: faqFindMany,
    findFirst: faqFindFirst,
    create: faqCreate,
    update: faqUpdate,
    count: faqCount,
  },
  verificationToken: {
    create: verificationTokenCreate,
    findUnique: verificationTokenFindUnique,
    delete: verificationTokenDelete,
  },
  verificationOtp: {
    create: verificationOtpCreate,
    findValid: verificationOtpFindValid,
    findValidByCode: verificationOtpFindValidByCode,
    delete: verificationOtpDelete,
  },
  pendingInvite: {
    create: pendingInviteCreate,
    findByGuild: pendingInviteFindByGuild,
    deleteByCode: pendingInviteDeleteByCode,
  },
  emailLog: {
    create: emailLogCreate,
  },
  meeting: {
    findUnique: meetingFindUnique,
    create: meetingCreate,
    update: meetingUpdate,
    delete: meetingDelete,
  },
  meetingChannel: {
    findFirst: meetingChannelFindFirst,
    findUnique: meetingChannelFindUnique,
    create: meetingChannelCreate,
    update: meetingChannelUpdate,
  },
  meetingRecording: {
    create: meetingRecordingCreate,
    findMany: meetingRecordingFindMany,
  },
  meetingRecordingStatus: {
    findUnique: meetingRecordingStatusFindUnique,
    create: meetingRecordingStatusCreate,
    upsert: meetingRecordingStatusUpsert,
    update: meetingRecordingStatusUpdate,
  },
  meetingPipelineJob: {
    create: meetingPipelineJobCreate,
    findByMeeting: meetingPipelineJobFindByMeeting,
    findById: meetingPipelineJobFindById,
    claimBatch: meetingPipelineJobClaimBatch,
    claim: meetingPipelineJobClaim,
    update: meetingPipelineJobUpdate,
    updateIf: meetingPipelineJobUpdateIf,
  },
  clockEntry: {
    create: clockEntryCreate,
    findActive: clockEntryFindActive,
    update: clockEntryUpdate,
    findMany: clockEntryFindMany,
  },
  userChannel: {
    create: userChannelCreate,
    findMany: userChannelFindMany,
    delete: userChannelDelete,
  },
};

export { db, faqSearch, guildMemberFindByEmail };

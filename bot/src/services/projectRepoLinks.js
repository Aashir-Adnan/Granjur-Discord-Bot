// Linking a repository to a project under a scope (roadmap sub-project 4,
// 2026-09-30). A project has at most one repository per scope — enforced in
// the DB by a unique key on (project_id, scope), NULL scope unrestricted
// (`.claude/knowledge` / repositories-per-scope plan). This module is the one
// place that reads-then-writes that invariant, so /projects (link/unlink) and
// /repos add both go through it instead of calling `db.projectRepos` directly.
import { scopeLabel } from '../utils/taskScope.js'

const DUP_KEY_ERRNO = 1062

function isDupKeyError(e) {
  return e?.errno === DUP_KEY_ERRNO || e?.code === 'ER_DUP_ENTRY'
}

function holderFor(links, scope, repositoryId) {
  return links.find((l) => l.scope === scope && String(l.repository_id) !== String(repositoryId))
}

/**
 * Link `repositoryId` to `projectId` under `scope` (falsy/`null` = no scope).
 * Refuses when another repository in the project already holds that scope —
 * nothing is written in that case. A race that slips past the pre-check (two
 * requests setting the same scope at once) surfaces as a duplicate-key error
 * from `setScope`; that is treated the same as a refusal, re-reading first so
 * the reported holder reflects what actually won.
 *
 * @param {{db: object, projectId: string, repositoryId: string, scope?: string|null}} args
 * @returns {Promise<{ok: true, updated: boolean} | {ok: false, holderRepositoryId: string|null}>}
 */
export async function linkRepo({ db, projectId, repositoryId, scope }) {
  const wantScope = scope || null
  const links = (await db.projectRepos.findMany({ where: { project_id: projectId } })) ?? []

  if (wantScope) {
    const holder = holderFor(links, wantScope, repositoryId)
    if (holder) return { ok: false, holderRepositoryId: holder.repository_id }
  }

  const existing = links.find((l) => String(l.repository_id) === String(repositoryId))
  let inserted = false
  try {
    if (!existing) {
      await db.projectRepos.add({ data: { project_id: projectId, repository_id: repositoryId } })
      inserted = true
    }
    await db.projectRepos.setScope({ project_id: projectId, repository_id: repositoryId, scope: wantScope })
    return { ok: true, updated: !!existing }
  } catch (e) {
    if (!isDupKeyError(e)) throw e
    // The row this call just added is untagged; a refusal must not leave it
    // behind as a stray link the user never asked for.
    if (inserted) {
      try {
        await db.projectRepos.remove({ project_id: projectId, repository_id: repositoryId })
      } catch (removeErr) {
        console.warn('[projectRepoLinks] stray link cleanup failed:', removeErr?.message ?? removeErr)
      }
    }
    const fresh = (await db.projectRepos.findMany({ where: { project_id: projectId } })) ?? []
    const holder = holderFor(fresh, wantScope, repositoryId)
    return { ok: false, holderRepositoryId: holder?.repository_id ?? null }
  }
}

/** Remove one project/repository pair. Leaves every other link untouched. */
export async function unlinkRepo({ db, projectId, repositoryId }) {
  await db.projectRepos.remove({ project_id: projectId, repository_id: repositoryId })
}

/** Verbatim refusal text for a scope already held by another repository. */
export function linkRefusalText(projectName, repoName, scope) {
  return `${projectName} already has ${repoName} as its ${scopeLabel(scope)} repository — unlink it or pick another scope.`
}

/** /projects → Link repo, when the repository was already linked and only its scope changed. */
export function linkUpdatedText(repoName, projectName, scope) {
  return `Updated **${repoName}** in **${projectName}** to ${scope ? scopeLabel(scope) : 'no scope'}.`
}

/** /repos add with a `scope` but no `project`: the scope has nothing to attach to. */
export const SCOPE_IGNORED_TEXT = 'Scope ignored — give a project to link with a scope.'

/**
 * One line describing whether a token can reach a repository, from
 * `checkRepoAccess`'s result. `result.url` is an optional extra the callers
 * in this feature attach (the checked URL) so the bad-url case has something
 * to show in place of `<owner>/<repo>` — `checkRepoAccess` itself never
 * learns the owner/repo for a URL it could not parse.
 * @param {{ok: true} | {ok: false, code: 'no-access'|'bad-url'|'error', message: string, issuesDisabled?: boolean, url?: string}} result
 */
export function accessLine(result) {
  if (!result) return `GitHub access couldn't be checked right now.`
  if (result.ok) return '✅ GitHub access OK'
  if (result.code === 'no-access' && result.issuesDisabled) {
    return `⚠️ ${result.message} — issues won't open until they are turned on in the repository's settings`
  }
  if (result.code === 'no-access') {
    return `⚠️ ${result.message} — issues won't open until a token can reach it`
  }
  if (result.code === 'bad-url') {
    return `⚠️ No GitHub access to ${result.url ?? result.message} — issues won't open until a token can reach it`
  }
  return `GitHub access couldn't be checked right now.`
}

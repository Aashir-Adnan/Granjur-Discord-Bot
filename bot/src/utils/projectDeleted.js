// A soft-deleted project (`project.deletedAt` set; migration 031). The DB layer
// hides it and its tasks from every list by default (`includeDeleted: true`
// opts back in); `findFirst` and `findByName` still return it, so a caller
// acting on an id or a name sees it and refuses with the sentences below.

/** The refusal for any write that names a deleted project, or a task in one. */
export const PROJECT_DELETED = 'This project is deleted.'

/** `/projects` → Add: the name is still held by a deleted project. */
export const DELETED_NAME_HELD = 'A deleted project has that name — reactivate it or pick another name.'

/** `/projects` → Add: the docs slug is still held by a deleted project. */
export const DELETED_SLUG_HELD = 'A deleted project uses that slug — reactivate it or pick another slug.'

/**
 * Where a deleted project's task channels are kept (Task 3 creates it;
 * `🗄 ARCHIVED PROJECTS 2` and on once one is full). `/cleanup` protects every
 * category whose name starts with this.
 */
export const ARCHIVE_CATEGORY_BASE = '🗄 ARCHIVED PROJECTS'

/** True for a project row that is soft-deleted. Pure. */
export function isDeletedProject(project) {
  return Boolean(project?.deletedAt)
}

/**
 * Whether `projectId` names a soft-deleted project, read by id. False for no id
 * and for an id that matches nothing. A failed read throws.
 */
export async function projectIdIsDeleted(dbArg, projectId) {
  if (!projectId) return false
  return isDeletedProject(await dbArg.project.findFirst({ where: { id: String(projectId) } }))
}

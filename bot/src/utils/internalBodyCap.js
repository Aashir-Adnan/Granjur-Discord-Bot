// How many bytes an internal route may read from a request body.
export const INTERNAL_MAX_BODY = 64 * 1024
/** A whole file of up to 50 tasks and their subtasks is checked in one request (the site caps the file at 256 KB). */
export const IMPORT_CHECK_MAX_BODY = 512 * 1024

export function maxBodyFor(url) {
  return url === '/internal/tasks/import-check' ? IMPORT_CHECK_MAX_BODY : INTERNAL_MAX_BODY
}

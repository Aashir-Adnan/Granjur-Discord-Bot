/**
 * The roles this bot assigns, and the arithmetic for changing someone's set.
 *
 * Shared by /approve, /backlog and /set-roles so the three cannot drift apart —
 * a role assignable at onboarding but absent here would be impossible to remove
 * afterwards.
 */

export const MANAGED_ROLES = [
  'Intern', 'Temp', 'Junior Dev', 'Senior Dev', 'Associate Engineer',
  'Quality Assurance', 'Project Manager', 'Server Manager', 'CEO',
  'Frontend', 'UI/UX', 'Designer', 'Server', 'Full-Stack', 'Database',
]

const fold = (s) => String(s ?? '').trim().toLowerCase()
const MANAGED_FOLDED = new Set(MANAGED_ROLES.map(fold))

/**
 * Work out which roles to add and which to remove.
 *
 * Only roles in MANAGED_ROLES are ever removed. Everything else a member holds —
 * Verified, Holding, Clocked In, or anything created by hand — is left alone.
 * Without that guard, saving a change would strip Verified and take away the
 * member's access to every channel in the server.
 *
 * @param {string[]} currentNames role names the member holds now
 * @param {string[]} selectedNames managed role names that were ticked
 * @returns {{add: string[], remove: string[]}} names, in MANAGED_ROLES order
 */
export function roleDiff(currentNames = [], selectedNames = []) {
  const current = new Set((currentNames || []).map(fold))
  const selected = new Set((selectedNames || []).map(fold).filter((n) => MANAGED_FOLDED.has(n)))

  const add = MANAGED_ROLES.filter((r) => selected.has(fold(r)) && !current.has(fold(r)))
  const remove = MANAGED_ROLES.filter((r) => current.has(fold(r)) && !selected.has(fold(r)))
  return { add, remove }
}

/** Options for the role picker, with the member's current managed roles ticked. */
export function roleSelectOptions(currentNames = []) {
  const current = new Set((currentNames || []).map(fold))
  return MANAGED_ROLES.map((name) => ({
    label: name,
    value: name,
    default: current.has(fold(name)),
  }))
}

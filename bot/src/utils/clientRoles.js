// The project-member roles that are CLIENTS. A leaf on purpose: project-setup,
// project-members, the request service and the tracking commands all read it.
//
// Both roles are outsiders: neither may ever hold the project role (that opens
// every team channel), and both get the client channels — the support pair and
// the casual chat — by a member overwrite. A client MANAGER additionally reads
// every REQUEST channel on the project: the channel of any task with
// `requestedBy` set, and never a task the team created for itself.

export const CLIENT_PROJECT_ROLES = ['client', 'client_manager']

export const isClientRole = (role) => CLIENT_PROJECT_ROLES.includes(String(role ?? ''))

/** The client managers on a roster, minus `exceptId` (the person already in the room). */
export const managerIdsOf = (rows, exceptId = null) =>
  (rows ?? [])
    .filter((m) => m?.role === 'client_manager' && String(m.discordId) !== String(exceptId ?? ''))
    .map((m) => String(m.discordId))

/** The projects a member's rows say they manage. */
export const managedProjectIds = (rows) =>
  (rows ?? []).filter((m) => m?.role === 'client_manager').map((m) => String(m.projectId))

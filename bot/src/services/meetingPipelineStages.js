// Stage runners are filled in Tasks 9-16. Each: async ({ job, db, client, csaasClient })
//   -> { patch?, advance?: boolean (default true), block?: boolean }
// - patch:   shallow-merged into the job row on success
// - advance: when false, the job stays on the same stage (e.g. polling)
// - block:   when true, status becomes 'blocked' instead of 'pending'/'done'
export const stageRunners = {}

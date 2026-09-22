// Which tasks a person may clock into: the ones they hold, plus any task in a
// project they are a member of — so a reviewer or QA can log against the task
// they are testing, which "only your own tasks" would forbid. Leadership: any.
// Pure.
import { holdersOf } from './taskLabel.js'

export function clockableTasks(tasks, { memberProjectIds = [], isLeadership = false, callerId }) {
  const mine = new Set(memberProjectIds.map(String))
  return (tasks || []).filter((t) => {
    if (isLeadership) return true
    if (holdersOf(t).includes(String(callerId))) return true
    return Boolean(t.projectId) && mine.has(String(t.projectId))
  })
}

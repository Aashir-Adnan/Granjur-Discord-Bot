// A task's discipline, fixed to four values. Replaces the old free-text
// `scope` column (which held things like "GitSync" or "Task Hierarchy" —
// a short label, not a classification) with a closed set that both
// /create-task and /update-task offer as a picker, never typed text.

export const SCOPE_CHOICES = [
  { name: 'Backend', value: 'backend' },
  { name: 'Frontend', value: 'frontend' },
  { name: 'QA', value: 'qa' },
  { name: 'Design', value: 'design' },
]

export const SCOPE_VALUES = SCOPE_CHOICES.map((c) => c.value)

export function isValidScope(value) {
  return SCOPE_VALUES.includes(value)
}

/** The label shown to a person for a stored value: 'backend' -> 'Backend'.
 *  A value predating this change (free text, or null) is returned as-is,
 *  so an old task's stored label keeps displaying rather than disappearing. */
export function scopeLabel(value) {
  return SCOPE_CHOICES.find((c) => c.value === value)?.name ?? value ?? null
}

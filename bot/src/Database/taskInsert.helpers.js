export function buildTaskInsertValues(data) {
  return {
    externalId: data.externalId ?? null,
    meetingId: data.meetingId ?? null,
  }
}

export interface CreateEmailReminderDTO {
  userUuid: string
  // Epoch milliseconds, or an ISO 8601 string the client supplies for the reminder
  // due time. Validated/normalised in the use case.
  dueAt: number | string
  message: string
}

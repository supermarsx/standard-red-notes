export interface CreateEmailReminderResult {
  uuid: string
  dueAt: number
  message: string
  sent: boolean
  createdAt: number
}

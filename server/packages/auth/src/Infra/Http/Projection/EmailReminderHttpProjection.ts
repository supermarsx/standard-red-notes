export interface EmailReminderHttpProjection {
  uuid: string
  dueAt: number
  message: string
  sent: boolean
  createdAt: number
}

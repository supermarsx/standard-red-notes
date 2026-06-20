export interface DeadManSwitchHttpProjection {
  uuid: string
  recipientEmail: string
  message: string | null
  intervalDays: number
  deadline: number
  triggered: boolean
  lastCheckInAt: number | null
  createdAt: number
  sendAttempts: number
  nextAttemptAt: number | null
  lastAttemptAt: number | null
}

export interface CreateDeadManSwitchResult {
  uuid: string
  recipientEmail: string
  message: string | null
  intervalDays: number
  deadline: number
  triggered: boolean
  lastCheckInAt: number | null
  createdAt: number
}

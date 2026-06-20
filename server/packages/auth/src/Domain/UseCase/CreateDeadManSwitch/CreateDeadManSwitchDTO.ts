export interface CreateDeadManSwitchDTO {
  userUuid: string
  recipientEmail: string
  shareUrl: string
  message?: string | null
  intervalDays: number
}

export interface NextcloudBackupCompletedEventPayload {
  userUuid: string
  requestUuid: string
  outcome: 'succeeded' | 'failed'
  completedAt: number
}

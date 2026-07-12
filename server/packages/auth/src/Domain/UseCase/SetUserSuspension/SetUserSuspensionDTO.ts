export interface SetUserSuspensionDTO {
  userUuid: string
  suspended: boolean
  suspendedReason?: string | null
}

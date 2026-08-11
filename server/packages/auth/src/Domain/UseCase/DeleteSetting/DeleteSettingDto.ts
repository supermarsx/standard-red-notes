export type DeleteSettingDto = {
  userUuid: string
  settingName: string
  uuid?: string
  timestamp?: number
  softDelete?: boolean
  serverPassword?: string
  authTokenVersion?: number
  shouldVerifyUserServerPassword?: boolean
  /** Trusted server/admin callers may explicitly bypass client mutability. */
  allowClientImmutable?: boolean
}

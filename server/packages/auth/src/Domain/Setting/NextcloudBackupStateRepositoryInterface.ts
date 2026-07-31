export interface PersistedNextcloudBackupSettingValue {
  exists: boolean
  value: string | null
}

export interface PersistedNextcloudBackupState {
  deliveryState: PersistedNextcloudBackupSettingValue
  lastSuccessAt: PersistedNextcloudBackupSettingValue
}

export interface PersistedNextcloudBackupStateMutation<T> {
  result: T
  deliveryStateValue?: string
  lastSuccessAtValue?: string
}

export type NextcloudBackupStateRepositoryResult<T> = { status: 'available'; value: T } | { status: 'user-not-found' }

/**
 * Owns the database transaction used for a single user's backup lifecycle.
 * Implementations must acquire their cross-process lock before reading either
 * setting and must perform every requested write with the transaction-bound
 * connection before returning.
 */
export interface NextcloudBackupStateRepositoryInterface {
  runExclusive<T>(
    userUuid: string,
    transition: (state: PersistedNextcloudBackupState) => PersistedNextcloudBackupStateMutation<T>,
  ): Promise<NextcloudBackupStateRepositoryResult<T>>
}

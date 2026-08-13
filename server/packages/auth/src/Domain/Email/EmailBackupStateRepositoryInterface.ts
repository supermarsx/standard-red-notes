import { EmailBackupDeliveryState } from './EmailBackupDeliveryState'

export interface EmailBackupStateMutation<T> {
  result: T
  deliveryState?: EmailBackupDeliveryState
  lastSentAt?: number
}

export type EmailBackupStateRepositoryResult<T> = { status: 'available'; value: T } | { status: 'user-not-found' }

/**
 * Serializes email-backup lifecycle transitions for one user across processes.
 * Reads and requested writes must share the same database transaction and lock.
 */
export interface EmailBackupStateRepositoryInterface {
  runExclusive<T>(
    userUuid: string,
    transition: (state: EmailBackupDeliveryState) => EmailBackupStateMutation<T> | Promise<EmailBackupStateMutation<T>>,
  ): Promise<EmailBackupStateRepositoryResult<T>>
}

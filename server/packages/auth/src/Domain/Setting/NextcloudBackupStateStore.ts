import { Logger } from 'winston'
import { TimerInterface } from '@standardnotes/time'

import {
  NextcloudBackupStateRepositoryInterface,
  PersistedNextcloudBackupState,
} from './NextcloudBackupStateRepositoryInterface'
import {
  NextcloudBackupDeliveryState,
  emptyNextcloudBackupDeliveryState,
  isValidNextcloudBackupTimestamp,
  NEXTCLOUD_BACKUP_MAX_RETRY_DELAY_MS,
  parseNextcloudBackupDeliveryState,
} from './NextcloudBackupDeliveryState'

export type NextcloudBackupStateRead<T> =
  { status: 'available'; value: T } | { status: 'user-not-found' } | { status: 'unavailable' }

export interface NextcloudBackupLifecycleState {
  deliveryState: NextcloudBackupDeliveryState
  lastSuccessAt: number | null
}

export interface NextcloudBackupLifecycleMutation<T> {
  result: T
  deliveryState?: NextcloudBackupDeliveryState
  lastSuccessAt?: number
}

class InvalidNextcloudBackupStateError extends Error {}

export class NextcloudBackupStateStore {
  private static readonly MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000

  constructor(
    private repository: NextcloudBackupStateRepositoryInterface,
    private timer: TimerInterface,
    private logger: Logger,
  ) {}

  /**
   * Runs a complete per-user lifecycle transition behind the repository's
   * cross-process transaction. The callback is synchronous by design: callers
   * may calculate state only, never publish an event or perform network I/O
   * while holding the database lock.
   */
  async runExclusive<T>(
    userUuid: string,
    transition: (state: NextcloudBackupLifecycleState) => NextcloudBackupLifecycleMutation<T>,
  ): Promise<NextcloudBackupStateRead<T>> {
    try {
      const repositoryResult = await this.repository.runExclusive(userUuid, (persistedState) => {
        const state = this.decodeState(persistedState)
        const mutation = transition(state)

        let deliveryStateValue: string | undefined
        if (mutation.deliveryState !== undefined) {
          deliveryStateValue = JSON.stringify(mutation.deliveryState)
          if (parseNextcloudBackupDeliveryState(deliveryStateValue) === null) {
            throw new InvalidNextcloudBackupStateError('Invalid delivery-state mutation')
          }
        }

        let lastSuccessAtValue: string | undefined
        if (mutation.lastSuccessAt !== undefined) {
          if (!isValidNextcloudBackupTimestamp(mutation.lastSuccessAt)) {
            throw new InvalidNextcloudBackupStateError('Invalid last-success mutation')
          }
          lastSuccessAtValue = String(mutation.lastSuccessAt)
        }

        return {
          result: mutation.result,
          deliveryStateValue,
          lastSuccessAtValue,
        }
      })

      if (repositoryResult.status === 'user-not-found') {
        return { status: 'user-not-found' }
      }

      return { status: 'available', value: repositoryResult.value }
    } catch {
      this.logger.error('Nextcloud backup lifecycle transaction failed; dispatch is paused.', {
        codeTag: 'NextcloudBackupStateStore',
        userId: userUuid,
      })

      return { status: 'unavailable' }
    }
  }

  async readDeliveryState(userUuid: string): Promise<NextcloudBackupStateRead<NextcloudBackupDeliveryState>> {
    return this.runExclusive(userUuid, ({ deliveryState }) => ({ result: deliveryState }))
  }

  async writeDeliveryState(userUuid: string, state: NextcloudBackupDeliveryState): Promise<boolean> {
    const result = await this.runExclusive(userUuid, () => ({ result: true, deliveryState: state }))

    return result.status === 'available'
  }

  async readLastSuccessAt(userUuid: string): Promise<NextcloudBackupStateRead<number | null>> {
    return this.runExclusive(userUuid, ({ lastSuccessAt }) => ({ result: lastSuccessAt }))
  }

  async writeLastSuccessAt(userUuid: string, timestamp: number): Promise<boolean> {
    if (!isValidNextcloudBackupTimestamp(timestamp)) {
      this.logger.error('Nextcloud backup completion carried an invalid timestamp.', {
        codeTag: 'NextcloudBackupStateStore',
        userId: userUuid,
      })

      return false
    }

    const result = await this.runExclusive(userUuid, () => ({ result: true, lastSuccessAt: timestamp }))

    return result.status === 'available'
  }

  private decodeState(persistedState: PersistedNextcloudBackupState): NextcloudBackupLifecycleState {
    let deliveryState: NextcloudBackupDeliveryState
    if (!persistedState.deliveryState.exists) {
      deliveryState = emptyNextcloudBackupDeliveryState()
    } else if (typeof persistedState.deliveryState.value === 'string') {
      const parsed = parseNextcloudBackupDeliveryState(persistedState.deliveryState.value)
      if (parsed === null) {
        throw new InvalidNextcloudBackupStateError('Malformed delivery state')
      }
      deliveryState = parsed
    } else {
      throw new InvalidNextcloudBackupStateError('Missing delivery state value')
    }

    let lastSuccessAt: number | null = null
    if (persistedState.lastSuccessAt.exists) {
      const value = persistedState.lastSuccessAt.value
      if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw new InvalidNextcloudBackupStateError('Malformed last-success value')
      }
      const parsed = Number(value)
      if (!isValidNextcloudBackupTimestamp(parsed)) {
        throw new InvalidNextcloudBackupStateError('Out-of-range last-success value')
      }
      lastSuccessAt = parsed
    }

    const nowMs = this.nowMs()
    if (
      (deliveryState.activeRequest &&
        deliveryState.activeRequest.requestedAt > nowMs + NextcloudBackupStateStore.MAX_CLOCK_SKEW_MS) ||
      (deliveryState.retryNotBefore !== null &&
        deliveryState.retryNotBefore >
          nowMs + NEXTCLOUD_BACKUP_MAX_RETRY_DELAY_MS + NextcloudBackupStateStore.MAX_CLOCK_SKEW_MS) ||
      deliveryState.completed.some(
        (completion) => completion.completedAt > nowMs + NextcloudBackupStateStore.MAX_CLOCK_SKEW_MS,
      ) ||
      (lastSuccessAt !== null && lastSuccessAt > nowMs + NextcloudBackupStateStore.MAX_CLOCK_SKEW_MS)
    ) {
      throw new InvalidNextcloudBackupStateError('Implausible lifecycle timestamp')
    }

    return { deliveryState, lastSuccessAt }
  }

  private nowMs(): number {
    return this.timer.convertMicrosecondsToMilliseconds(this.timer.getTimestampInMicroseconds())
  }
}

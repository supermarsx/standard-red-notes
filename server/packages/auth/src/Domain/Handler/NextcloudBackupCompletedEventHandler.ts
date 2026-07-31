import {
  DomainEventHandlerInterface,
  DomainEventService,
  NextcloudBackupCompletedEvent,
} from '@standardnotes/domain-events'
import { Uuid } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'
import { Logger } from 'winston'

import {
  appendNextcloudBackupCompletion,
  isValidNextcloudBackupTimestamp,
  nextFailureCount,
  nextNextcloudBackupRetryDelayMs,
} from '../Setting/NextcloudBackupDeliveryState'
import { NextcloudBackupStateStore } from '../Setting/NextcloudBackupStateStore'

const MAX_COMPLETION_CLOCK_SKEW_MS = 5 * 60 * 1_000

export class NextcloudBackupCompletedEventHandler implements DomainEventHandlerInterface {
  constructor(
    private stateStore: NextcloudBackupStateStore,
    private timer: TimerInterface,
    private logger: Logger,
  ) {}

  async handle(event: NextcloudBackupCompletedEvent): Promise<void> {
    const nowMs = this.timer.convertMicrosecondsToMilliseconds(this.timer.getTimestampInMicroseconds())
    if (!this.isValidEvent(event, nowMs)) {
      this.logger.warn('Rejected an invalid Nextcloud backup completion.', {
        codeTag: 'NextcloudBackupCompletedEventHandler',
      })

      return
    }

    const { userUuid, requestUuid, outcome } = event.payload
    const [stateRead, lastSuccessRead] = await Promise.all([
      this.stateStore.readDeliveryState(userUuid),
      this.stateStore.readLastSuccessAt(userUuid),
    ])
    if (stateRead.status === 'unavailable' || lastSuccessRead.status === 'unavailable') {
      throw new Error('Nextcloud backup completion state is unavailable')
    }
    const state = stateRead.value

    if (
      state.activeRequest?.requestUuid === requestUuid &&
      event.payload.completedAt < state.activeRequest.requestedAt
    ) {
      this.logger.warn('Rejected a Nextcloud backup completion older than its request.', {
        codeTag: 'NextcloudBackupCompletedEventHandler',
        userId: userUuid,
        requestId: requestUuid,
      })

      return
    }

    if (state.completed.some((entry) => entry.requestUuid === requestUuid)) {
      this.logger.debug('Ignored a duplicate Nextcloud backup completion.', {
        codeTag: 'NextcloudBackupCompletedEventHandler',
        userId: userUuid,
        requestId: requestUuid,
      })

      return
    }

    const activeRequestMatches = state.activeRequest?.requestUuid === requestUuid
    let nextState = {
      ...state,
      completed: appendNextcloudBackupCompletion(state, {
        requestUuid,
        outcome,
        completedAt: event.payload.completedAt,
      }),
    }

    if (outcome === 'succeeded') {
      // The syncing completion clock describes when the upload actually finished;
      // auth validates it and updates monotonically so late/out-of-order delivery
      // can neither make an old upload look fresh nor move the cadence backward.
      const lastSuccessAt = Math.max(lastSuccessRead.value ?? 0, event.payload.completedAt)
      if (!(await this.stateStore.writeLastSuccessAt(userUuid, lastSuccessAt))) {
        throw new Error('Nextcloud backup success could not be recorded')
      }
      nextState = {
        ...nextState,
        activeRequest: activeRequestMatches ? null : nextState.activeRequest,
        consecutiveFailures: 0,
        retryNotBefore: null,
      }
    } else if (activeRequestMatches) {
      const consecutiveFailures = nextFailureCount(state.consecutiveFailures)
      nextState = {
        ...nextState,
        activeRequest: null,
        consecutiveFailures,
        retryNotBefore: nowMs + nextNextcloudBackupRetryDelayMs(consecutiveFailures),
      }
    }

    if (!(await this.stateStore.writeDeliveryState(userUuid, nextState))) {
      throw new Error('Nextcloud backup completion could not be recorded')
    }

    this.logger.info(`Nextcloud backup ${outcome}.`, {
      codeTag: 'NextcloudBackupCompletedEventHandler',
      userId: userUuid,
      requestId: requestUuid,
    })
  }

  private isValidEvent(event: NextcloudBackupCompletedEvent, nowMs: number): boolean {
    const payload = event?.payload
    if (!payload) {
      return false
    }

    return (
      event.type === 'NEXTCLOUD_BACKUP_COMPLETED' &&
      event.meta?.origin === DomainEventService.SyncingServer &&
      event.meta?.target === DomainEventService.Auth &&
      event.meta?.correlation?.userIdentifierType === 'uuid' &&
      event.meta.correlation.userIdentifier === payload.userUuid &&
      !Uuid.create(payload.userUuid).isFailed() &&
      !Uuid.create(payload.requestUuid).isFailed() &&
      (payload.outcome === 'succeeded' || payload.outcome === 'failed') &&
      isValidNextcloudBackupTimestamp(payload.completedAt) &&
      payload.completedAt <= nowMs + MAX_COMPLETION_CLOCK_SKEW_MS
    )
  }
}

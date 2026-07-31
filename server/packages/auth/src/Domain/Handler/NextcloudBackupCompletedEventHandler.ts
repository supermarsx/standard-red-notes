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

type CompletionDecision = 'recorded' | 'duplicate' | 'older-than-request'

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

    const { userUuid, requestUuid, outcome, completedAt } = event.payload
    const transition = await this.stateStore.runExclusive<CompletionDecision>(
      userUuid,
      ({ deliveryState: state, lastSuccessAt }) => {
        if (state.activeRequest?.requestUuid === requestUuid && completedAt < state.activeRequest.requestedAt) {
          return { result: 'older-than-request' }
        }

        const existingCompletion = state.completed.find((entry) => entry.requestUuid === requestUuid)
        // Completion truth is monotonic: success is terminal, while a failed
        // observation may be upgraded when an overlapping/redelivered worker
        // later confirms that the same request actually uploaded successfully.
        if (existingCompletion?.outcome === 'succeeded' || (existingCompletion && outcome === 'failed')) {
          return { result: 'duplicate' }
        }

        const activeRequestMatches = state.activeRequest?.requestUuid === requestUuid
        let nextState = {
          ...state,
          completed: appendNextcloudBackupCompletion(state, {
            requestUuid,
            outcome,
            completedAt,
          }),
        }

        if (outcome === 'succeeded') {
          nextState = {
            ...nextState,
            activeRequest: activeRequestMatches ? null : nextState.activeRequest,
            consecutiveFailures: 0,
            retryNotBefore: null,
          }

          return {
            result: 'recorded',
            deliveryState: nextState,
            // Monotonic inside the same transaction as the completion receipt.
            lastSuccessAt: Math.max(lastSuccessAt ?? 0, completedAt),
          }
        }

        if (activeRequestMatches) {
          const consecutiveFailures = nextFailureCount(state.consecutiveFailures)
          nextState = {
            ...nextState,
            activeRequest: null,
            consecutiveFailures,
            retryNotBefore: nowMs + nextNextcloudBackupRetryDelayMs(consecutiveFailures),
          }
        }

        return { result: 'recorded', deliveryState: nextState }
      },
    )

    if (transition.status === 'unavailable') {
      throw new Error('Nextcloud backup completion state is unavailable')
    }
    if (transition.status === 'user-not-found') {
      this.logger.info('Dropped a Nextcloud backup completion for a deleted user.', {
        codeTag: 'NextcloudBackupCompletedEventHandler',
        userId: userUuid,
        requestId: requestUuid,
      })

      return
    }
    if (transition.value === 'older-than-request') {
      this.logger.warn('Rejected a Nextcloud backup completion older than its request.', {
        codeTag: 'NextcloudBackupCompletedEventHandler',
        userId: userUuid,
        requestId: requestUuid,
      })

      return
    }
    if (transition.value === 'duplicate') {
      this.logger.debug('Ignored a duplicate Nextcloud backup completion.', {
        codeTag: 'NextcloudBackupCompletedEventHandler',
        userId: userUuid,
        requestId: requestUuid,
      })

      return
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

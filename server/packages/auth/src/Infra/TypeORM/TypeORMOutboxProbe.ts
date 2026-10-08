import { Repository } from 'typeorm'

import { OutboxProbe } from '../../Domain/Diagnostics/AuthRuntimeDiagnostics'
import { InviteEventOutboxRepositoryInterface } from '../../Domain/Invite/InviteEventOutboxRepositoryInterface'
import { TypeORMInviteEventOutbox, type InviteEventOutboxStatus } from './TypeORMInviteEventOutbox'

/**
 * Standard Red Notes: the TypeORM half of the dead-outbox census the admin
 * Diagnostics pane reads.
 *
 * SEPARATE FROM THE REPORT, exactly as `TypeORMDatastoreProbe` is.
 * `AuthRuntimeDiagnostics` holds the SHAPE of the answer and must stay free of
 * anything that can reach a table or a connection option; this file is the only
 * place that touches the entity, and it hands the report one number, one boolean
 * and a rejection.
 *
 * WHAT A TERMINAL ROW IS. `'failed'` is the state the dispatcher moves a record
 * to when its attempt limit is reached. The claim predicate matches only
 * `'pending'` and stale `'dispatching'` rows, so a `'failed'` row is never
 * claimed again: the realtime invalidation it carries is not retried by
 * anything, and it sits there until retention cleanup deletes it. That is the
 * one row this count exists to make visible.
 *
 * WHY A COUNT AND NOT A LIST. The rows themselves name affected users and carry
 * an error code written by whatever threw; the count is the whole of what can
 * leave this process. `COUNT(*)` with a single equality predicate on an indexed
 * column also costs nothing worth caching away from.
 */
const TERMINAL_STATUS: InviteEventOutboxStatus = 'failed'

export function createTypeORMOutboxProbe(
  ormRepository: Repository<TypeORMInviteEventOutbox>,
  outboxRepository: Pick<InviteEventOutboxRepositoryInterface, 'requeueFailed'> | undefined,
  dispatcher: { isDrainArmed(): boolean } | undefined,
): OutboxProbe {
  return {
    deadRows: (): Promise<number> => ormRepository.countBy({ status: TERMINAL_STATUS }),
    // Read off the repository rather than assumed, so a deployment bound to a
    // store with no way back reports the rows as what they are: lost, with the
    // remedy being to re-trigger whatever produced the event.
    requeueTransitionAvailable: typeof outboxRepository?.requeueFailed === 'function',
    // Absent dispatcher is NOT armed. A requeue into a queue nothing polls looks
    // like a fix and is not one.
    drainArmed: (): boolean => dispatcher?.isDrainArmed() === true,
  }
}

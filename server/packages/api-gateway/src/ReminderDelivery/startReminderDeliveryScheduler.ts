import { Container } from 'inversify'

import { TYPES } from '../Bootstrap/Types'
import { ReminderDeliveryScheduler } from '../Service/ReminderDelivery/ReminderDeliveryScheduler'

/**
 * Standard Red Notes: start the in-process reminder-delivery scheduler.
 *
 * Called from both the standalone api-gateway bootstrap (bin/server.ts) and the
 * self-hosted HomeServer (after the HTTP server is built), mirroring how
 * registerCaldavRoutes is wired. The scheduler resolves its own gating internally
 * (`start()` no-ops when REMINDER_DELIVERY_ENABLED is off), so calling this is
 * always safe.
 *
 * Returns true when the interval was actually started (feature on), so callers
 * can log it.
 */
export function startReminderDeliveryScheduler(container: Container): boolean {
  const scheduler = container.get<ReminderDeliveryScheduler>(TYPES.ApiGateway_ReminderDeliveryScheduler)
  return scheduler.start()
}

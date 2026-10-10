import { createAdminEmailDeliveryRouter } from '@standardnotes/api-gateway'

/** The concrete service `createAdminEmailDeliveryRouter` accepts, named off it. */
export type BundledAdminEmailDeliveryService = NonNullable<Parameters<typeof createAdminEmailDeliveryRouter>[0]>

/** The one thing this needs from the container, so a test does not build one. */
export interface AdminEmailDeliveryBindingSource {
  isBound(serviceIdentifier: symbol): boolean
  get<T>(serviceIdentifier: symbol): T
}

/**
 * Standard Red Notes: picks the advanced e-mail-delivery service the bundled
 * server actually built, or nothing.
 *
 * It exists because the mount used to pass a hardcoded `undefined`, which turned
 * the boundary's `501 "Advanced email delivery is not available in this
 * topology"` into a claim about the TOPOLOGY when the only thing it can honestly
 * be is a claim about the BINDING.
 *
 * The two differ on a real bundle. `ApiGateway_AdminEmailDeliveryService` is
 * bound whenever a non-cluster Redis is bound, and `MODE=home-server` permits
 * that: `buildHomeServerEnvironmentOverrides` spreads the configured environment
 * AFTER its own `CACHE_TYPE: 'memory'` default, so a bundle configured with
 * `CACHE_TYPE=redis` runs the real queue, the real worker and this service.
 * Measured on exactly that bundle before this change: the worker armed, the
 * admin test route answered from the advanced service with `outcome: "sent"`,
 * and `/relays`, `/queue` and `/logs` all answered 501 — so the queue's rows,
 * its dead letters and the requeue action existed and were unreachable.
 *
 * A missing binding still yields `undefined`, because on `CACHE_TYPE=memory`
 * there genuinely is no queue and 501 is then the true answer.
 */
export function resolveBundledAdminEmailDeliveryService(
  container: AdminEmailDeliveryBindingSource,
  serviceIdentifier: symbol,
): BundledAdminEmailDeliveryService | undefined {
  if (!container.isBound(serviceIdentifier)) {
    return undefined
  }

  return container.get<BundledAdminEmailDeliveryService>(serviceIdentifier)
}

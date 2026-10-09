import { DomainEventInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events'

/**
 * Standard Red Notes: raised when the process doing the publishing has no way
 * to hand a domain event to anything that would act on it.
 *
 * This is a statement about the DEPLOYMENT, not a failure: a bundled
 * (single-container / LXC) install delivers domain events by DIRECT CALL inside
 * the one server process, and `srn-admin` is a second, short-lived process. It
 * holds no socket registry and shares no event bus with the server, and the
 * deployment runs no broker it could hand the event to instead. Nothing the
 * operator can configure makes this publish arrive.
 *
 * It is a distinct type so a caller can decide per event, which is the only
 * safe way to treat it: an event that merely NOTIFIES may be dropped with a
 * warning, while an event that CARRIES THE WORK must fail the command. A single
 * blanket policy would get one of those two wrong, and the dangerous direction
 * is the silent one — `fix-quota` reporting success over a recalculation that
 * never ran reads as a measurement (see `FixStorageQuotaForUser`).
 */
export class DomainEventTransportUnavailableError extends Error {
  constructor(readonly eventType: string) {
    super(
      `Cannot publish ${eventType}: this deployment delivers domain events in-process and the srn-admin CLI runs ` +
        'as a separate process, so there is no transport to deliver it. Nothing was queued.',
    )
    this.name = 'DomainEventTransportUnavailableError'
  }
}

/**
 * The publisher bound for `srn-admin` on a deployment with NO event broker.
 *
 * The alternative that used to be bound there was a lazily-built SNS publisher
 * (see `LazyDomainEventPublisher`), which on such a deployment has no topic ARN,
 * no region and no credentials: it threw `Region is missing` from deep inside
 * the AWS SDK on the first publish, which told the operator to go and configure
 * AWS for a deployment that deliberately has none. This refuses in the
 * deployment's own terms instead.
 *
 * It is NOT a silent no-op, and it must not become one.
 */
export class UndeliverableDomainEventPublisher implements DomainEventPublisherInterface {
  async publish(event: DomainEventInterface): Promise<void> {
    throw new DomainEventTransportUnavailableError(event.type)
  }
}

/**
 * Does this deployment run an event broker the CLI could publish to?
 *
 * The SNS topic ARN is the publisher's own precondition rather than a proxy for
 * one: `SNSDomainEventPublisher` names it on every call, so without it there is
 * nothing to publish TO. Keying off this rather than off `MODE` is deliberate.
 * `MODE` describes the PROCESS — `HomeServer` sets it on itself, in memory —
 * while this describes the DEPLOYMENT, which is what an exec'd CLI needs to
 * know and the only one of the two it can observe. It also covers the LXC
 * install, which runs the same bundled server with no `MODE` anywhere.
 */
export function eventBrokerIsConfigured(snsTopicArn: string | undefined): boolean {
  return (snsTopicArn ?? '').trim() !== ''
}

/**
 * The whole publisher decision for `ContainerConfigLoader`'s 'cli' mode, in one
 * testable place.
 *
 * `buildBrokerPublisher` is a thunk so the broker arm is only taken when there
 * is a broker: it is what constructs (lazily) the SNS client, and on a bundled
 * deployment there is no region or credential for it to find.
 */
export function selectCliDomainEventPublisher(
  snsTopicArn: string | undefined,
  buildBrokerPublisher: () => DomainEventPublisherInterface,
): DomainEventPublisherInterface {
  if (eventBrokerIsConfigured(snsTopicArn)) {
    return buildBrokerPublisher()
  }

  return new UndeliverableDomainEventPublisher()
}

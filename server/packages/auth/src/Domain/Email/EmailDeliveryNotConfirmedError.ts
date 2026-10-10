/**
 * Standard Red Notes: raised when a requested user-facing notification was not
 * accepted by the active delivery pipeline.
 *
 * It exists because the alternative — a bare `new Error('Email delivery was not
 * confirmed')` — reached the operator stripped of everything that identified it.
 * Every `EMAIL_REQUESTED` publisher wraps its publish in a try/catch and logs
 * through `safeErrorLogMetadata`, which keeps only `errorType`. On the bundled
 * single-container deployment, where the publisher IS the handler (direct call),
 * the entire operator-visible trace of an undelivered sign-in notice was
 * `error "Could not publish the sign-in event." { errorType: "Error" }`: no
 * message identifier, and no hint that the cause was an unconfigured relay
 * rather than a broken transport.
 *
 * `name` and `messageIdentifier` are therefore the point of the type. `name`
 * survives the redaction, and the identifier says WHICH notification was lost.
 * `deliveryConfigured` separates the two causes an operator fixes differently:
 * `false` means nothing is configured to send mail at all (set up a relay), and
 * `true` means a configured relay refused or failed (look at the relay).
 *
 * It is thrown, not swallowed, on purpose: on a broker-backed deployment the
 * throw is what makes the queue redeliver the event, and a notification queued
 * while no relay was configured is then delivered once one is — which is
 * measurably what happens on the multi-container topology.
 */
export class EmailDeliveryNotConfirmedError extends Error {
  constructor(
    readonly messageIdentifier: string,
    readonly deliveryConfigured: boolean,
  ) {
    super(
      `Email delivery was not confirmed for ${messageIdentifier}: ` +
        (deliveryConfigured
          ? 'the configured delivery pipeline did not accept the message.'
          : 'no email relay is configured, so there was nothing to deliver it with.'),
    )
    this.name = 'EmailDeliveryNotConfirmedError'
  }
}

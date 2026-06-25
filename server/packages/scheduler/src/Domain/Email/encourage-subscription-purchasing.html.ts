import { safeHtml } from '@standardnotes/common'

// Paid-tier / subscription upsell emails are no longer a thing in this self-hosted fork
// (there is no paid tier). This template is intentionally inert: the original Standard Notes
// plan-pricing marketing copy and standardnotes.com/plans + /features links have been removed.
// The scheduling of this email is also disabled at the source (see UserRegisteredEventHandler),
// so this body should never be sent. The function signature is kept for backwards compatibility
// with EncourageSubscriptionPurchasing.ts and the JobDoneInterpreter import.
//
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const html = (_registrationDate: string, _annualPlusPrice: number, _annualProPrice: number) => safeHtml`<div>
  <p>Hi there,</p>
  <p>We hope you've been finding great use out of Standard Red Notes.</p>
</div>
`

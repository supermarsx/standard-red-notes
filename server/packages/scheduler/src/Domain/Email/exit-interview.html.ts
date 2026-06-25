import { safeHtml } from '@standardnotes/common'

// The exit-interview email is part of the paid-tier subscription-cancellation flow, which does
// not exist in this self-hosted fork (no paid tier). It is only scheduled from
// SubscriptionCancelledEventHandler, which never fires here. The original copy referenced
// subscription pricing and discounts; that paid-tier marketing has been removed and branding
// updated. Kept exported (inert) so existing imports continue to resolve.
export const html = safeHtml`<div>
  <p>
    We're truly sad to see you leave. Our mission is simple: build the best, most private, and most secure
    note-taking app available.
  </p>
  <p>
    If you canceled for another reason, such as a missing feature, or a feature that wasn't behaving or working as
    you expected, please let us know! We build Standard Red Notes for you, and your feedback is most crucial for us
    as we continue to evolve and iterate.
  </p>
  <p>
    If you have any other thoughts or questions, please feel free to reply directly to this email.
  </p>
</div>
`

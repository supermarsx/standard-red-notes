import { safeHtml } from '@standardnotes/common'

import { emailConfig } from './emailConfig'

// Only render the "learn more" link when the operator has configured a help URL.
// safeHtml escapes interpolated substitutions, so we build the anchor separately and
// concatenate it as raw markup (the URL is operator-controlled via HELP_URL).
const helpLink = emailConfig.helpUrl
  ? `<a href="${encodeURI(emailConfig.helpUrl)}">
    Learn more about daily email backups →
  </a>`
  : ''

export const html =
  safeHtml`<div>
  <p>
    Did you know you can enable daily email backups for your account? This <strong>free</strong> feature sends an
    email to your inbox with an encrypted backup file including all your notes and tags.
  </p>
  <p>
    Email backups are an important feature that help protect you against worst-case scenarios. Your backups can be
    used to restore your account to a previous state, or to import old versions of notes into your present
    account.
  </p>
  <p>
    To enable free email backups, use the Standard Red Notes web or desktop app, and open Preferences > Backups > Email Backups.
  </p>

  ` +
  helpLink +
  safeHtml`
</div>`

export interface EmailReminderProps {
  userUuid: string
  // Epoch milliseconds. When `Date.now()` passes this value the reminder is due
  // and (if the user has opted in) the account email is sent.
  dueAt: number
  // The user-provided reminder text. This left end-to-end encryption deliberately:
  // the client registers it in PLAINTEXT only when the user opts THIS reminder into
  // emailing, so the server can include it in the email body. Never note content
  // beyond what the user typed as the reminder message.
  message: string
  // Whether the reminder email has already been sent. In "no records" mode the row
  // is deleted on send instead of being flipped to true, so this stays false there.
  sent: boolean
  createdAt: number
}

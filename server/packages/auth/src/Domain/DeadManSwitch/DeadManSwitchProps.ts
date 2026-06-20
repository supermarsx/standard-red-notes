export interface DeadManSwitchProps {
  userUuid: string
  recipientEmail: string
  // The full Standard Red Notes share link including the decryption key in the
  // URL fragment. Deliberately stored server-side: this is inherent to a dead
  // man's switch, which must deliver the link to the recipient without the user.
  shareUrl: string
  message: string | null
  intervalDays: number
  // Epoch milliseconds. When `Date.now()` passes this value without a check-in,
  // the switch becomes due and the recipient is emailed.
  deadline: number
  triggered: boolean
  lastCheckInAt: number | null
  createdAt: number
  // Number of FAILED send attempts so far. Drives the escalating retry backoff.
  sendAttempts: number
  // Epoch milliseconds. Earliest time the next send may be attempted after a
  // failure. Null means "as soon as the switch is due".
  nextAttemptAt: number | null
  // Epoch milliseconds of the most recent send attempt (success or failure).
  lastAttemptAt: number | null
  // Last send error message (truncated). Never exposed over HTTP.
  lastError: string | null
}

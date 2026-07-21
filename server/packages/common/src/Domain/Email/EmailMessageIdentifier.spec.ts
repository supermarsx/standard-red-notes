import { EmailMessageIdentifier } from './EmailMessageIdentifier'

describe('EmailMessageIdentifier', () => {
  it('should name every persisted identifier identically to its wire value', () => {
    for (const [name, value] of Object.entries(EmailMessageIdentifier)) {
      expect(value).toEqual(name)
    }
  })

  it('should keep the wire values of the identifiers other services publish', () => {
    expect(EmailMessageIdentifier.WELCOME_EMAIL).toEqual('WELCOME_EMAIL')
    expect(EmailMessageIdentifier.SIGN_IN).toEqual('SIGN_IN')
    expect(EmailMessageIdentifier.PAYMENT_FAILED).toEqual('PAYMENT_FAILED')
    expect(EmailMessageIdentifier.SUBSCRIPTION_CANCELLED).toEqual('SUBSCRIPTION_CANCELLED')
  })

  it('should expose exactly the identifiers the email senders may use', () => {
    expect(Object.values(EmailMessageIdentifier).sort()).toEqual([
      'ACCOUNT_CLAIM',
      'ACCOUNT_RESET',
      'ACTIVATION_CODE',
      'DATA_BACKUP',
      'DISCOUNT_NOTICE',
      'ENCOURAGE_EMAIL_BACKUPS',
      'ENCOURAGE_SUBSCRIPTION_PURCHASING',
      'EXIT_DISCOUNT',
      'EXIT_INTERVIEW',
      'FAILED_BACKUP_ATTACHMENT_TOO_BIG',
      'FAILED_DROPBOX_BACKUP',
      'FAILED_GOOGLE_DRIVE_BACKUP',
      'FAILED_ONE_DRIVE_BACKUP',
      'MARKETING_BLACK_FRIDAY_2022',
      'MARKETING_BLACK_FRIDAY_2022_REMINDER',
      'MARKETING_CAMPAIGN_FILES',
      'OFFLINE_SUBSCRIPTION_ACCESS',
      'PAYMENT_FAILED',
      'RATE_ADJUSTMENT_NOTICE',
      'REFUND_NOTICE',
      'REFUND_REQUESTED',
      'SEND_INVOICE',
      'SHARED_SUBSCRIPTION_INVITATION',
      'SIGN_IN',
      'STUDENT_DISCOUNT_APPROVED',
      'STUDENT_DISCOUNT_REQUESTED',
      'SUBSCRIPTION_CANCELLED',
      'VERSION_ADOPTION_REPORT',
      'WELCOME_EMAIL',
    ])
  })
})

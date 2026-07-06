import { EmailConfirmationToken } from './EmailConfirmationToken'

export interface EmailConfirmationTokenRepositoryInterface {
  save(token: EmailConfirmationToken): Promise<void>
  /** Constant lookup by the SHA-256 hash of the presented raw token. */
  findByHashedToken(hashedToken: string): Promise<EmailConfirmationToken | null>
}

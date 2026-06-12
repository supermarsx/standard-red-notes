export interface MagicLinkTokenProps {
  userIdentifier: string
  code: string
  expiresAt: Date
  consumed: boolean
  createdAt: Date
}

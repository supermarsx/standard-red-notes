export interface CreateAppPasswordResult {
  uuid: string
  label: string
  /**
   * The plaintext app password. This is returned exactly ONCE at creation time
   * and never persisted in plaintext. Only its bcrypt hash is stored. It carries
   * the recognizable, non-secret `srn_ap_` prefix.
   */
  password: string
  createdAt: Date
  expiresAt: Date | null
}

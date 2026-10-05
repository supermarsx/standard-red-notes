export type SettingData = {
  uuid: string
  name: string
  value: string
  sensitive?: boolean
  /**
   * Standard Red Notes: WHERE the value came from, for the settings whose server
   * answer can be an EFFECTIVE value rather than a stored row.
   *
   * Absent on every ordinary setting, and absent from every server that does not
   * send it, so a client must never read absence as "stored". Today only auth's
   * self-scoped subscription-setting endpoint sets it, and only for
   * `FILE_UPLOAD_BYTES_LIMIT`:
   *
   *   - `account-setting`        a stored per-account row.
   *   - `plan-default`           the subscription plan's default allowance — what
   *                              `CreateValetToken` applies when no per-account
   *                              limit row exists.
   *   - `no-active-subscription` no live subscription, so the upload token is
   *                              minted unlimited (-1) unless an explicit limit
   *                              row says otherwise.
   *
   * Typed as a wide `string` on purpose: it is a SERVER enum, and a client that
   * declared it as a union would have to either trust an unknown value or crash on
   * one. Callers admit it against their own closed list.
   */
  origin?: string
}

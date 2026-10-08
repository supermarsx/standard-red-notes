export interface TokenEncoderInterface<T> {
  encodeToken(data: T): string
  encodeExpirableToken(data: T, expiresIn: number): string
  /**
   * Same token, plus a per-mint `jti` nonce so two mints of IDENTICAL claims in
   * the same second are never the same string. Required for any single-use
   * credential; see `TokenEncoder.encodeUniqueExpirableToken`.
   */
  encodeUniqueExpirableToken(data: T, expiresIn: number): string
}

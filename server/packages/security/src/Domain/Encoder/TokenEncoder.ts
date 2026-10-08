import { randomUUID } from 'node:crypto'
import { sign, SignOptions } from 'jsonwebtoken'

import { TokenEncoderInterface } from './TokenEncoderInterface'

export class TokenEncoder<T> implements TokenEncoderInterface<T> {
  constructor(private jwtSecret: string) {}

  encodeExpirableToken(data: T, expiresIn: string | number | undefined): string {
    return sign(data as Record<string, unknown>, this.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: expiresIn as SignOptions['expiresIn'],
    })
  }

  /**
   * Standard Red Notes: an expirable token that is UNIQUE per mint.
   *
   * `encodeExpirableToken` above is a pure function of its payload plus `iat`,
   * and `iat` is SECONDS -- the JWT spec's resolution, not a choice this class
   * can make. So two mints of the same claims inside one second are the same
   * string, byte for byte. Measured here: four mints of one valet payload in
   * 5 ms produced ONE distinct token.
   *
   * That is fatal for a credential whose whole contract is single use. A valet
   * token is presented to the files service exactly once
   * (`ValetTokenAuthMiddleware` refuses a token its repository has already
   * seen) and the multi-container adapter enforces the same rule before the
   * storage boundary. An upload mints for the open and again for the first
   * chunk, with IDENTICAL claims, inside the same second -- so the second mint
   * handed back a token that had already been spent, and every socket upload
   * failed FILE_ACCESS_DENIED on chunk 0.
   *
   * The fix is a `jti` nonce rather than a finer `iat`. Millisecond issuance
   * would only narrow the window: this process mints several tokens per
   * millisecond, so same-millisecond collisions are reachable, and `iat` would
   * then no longer be the seconds value every verifier and the JWT spec expect.
   * A 122-bit random `jti` makes the signature differ unconditionally, at any
   * clock resolution and under any load.
   *
   * BACKWARD COMPATIBLE in both directions. `jti` is a registered JWT claim and
   * every verifier of these tokens reads named claims only -- `TokenDecoder`
   * verifies the signature and casts, and the api-gateway and home-server
   * authorizers use structural type guards -- so a new token with `jti` is
   * accepted by an old verifier, and a token already in flight WITHOUT `jti`
   * stays valid until it expires. Nothing keys on the claim set being exact.
   */
  encodeUniqueExpirableToken(data: T, expiresIn: string | number | undefined): string {
    return sign(data as Record<string, unknown>, this.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: expiresIn as SignOptions['expiresIn'],
      jwtid: randomUUID(),
    })
  }

  encodeToken(data: T): string {
    return sign(data as Record<string, unknown>, this.jwtSecret, { algorithm: 'HS256' })
  }
}

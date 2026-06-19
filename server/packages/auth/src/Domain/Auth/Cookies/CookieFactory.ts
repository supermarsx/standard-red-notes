import { CookieFactoryInterface } from './CookieFactoryInterface'

export class CookieFactory implements CookieFactoryInterface {
  constructor(
    private sameSite: 'None' | 'Lax' | 'Strict',
    private domain: string,
    private secure: boolean,
    private partitioned: boolean,
  ) {}

  createCookieHeaderValue(dto: {
    sessionUuid: string
    accessToken: string
    refreshToken: string
    refreshTokenExpiration: Date
  }): string[] {
    // Omit the Domain attribute entirely when no domain is configured so the
    // cookie becomes host-only. Required for self-hosting on localhost / a bare
    // host or IP: a Domain that doesn't domain-match the request host (such as
    // the old 'standardnotes.com' default) is rejected by the browser, the auth
    // cookie is silently dropped, and every authenticated request 401s.
    const domainAttr = this.domain ? ` Domain=${this.domain};` : ''
    return [
      `access_token_${dto.sessionUuid}=${dto.accessToken}; HttpOnly;${this.secure ? 'Secure; ' : ' '}Path=/;${
        this.partitioned ? 'Partitioned; ' : ' '
      }SameSite=${this.sameSite};${domainAttr} Expires=${dto.refreshTokenExpiration.toUTCString()};`,
      `refresh_token_${dto.sessionUuid}=${dto.refreshToken}; HttpOnly;${
        this.secure ? 'Secure; ' : ' '
      }Path=/v1/sessions/refresh;${
        this.partitioned ? 'Partitioned; ' : ' '
      }SameSite=${this.sameSite};${domainAttr} Expires=${dto.refreshTokenExpiration.toUTCString()};`,
    ]
  }
}

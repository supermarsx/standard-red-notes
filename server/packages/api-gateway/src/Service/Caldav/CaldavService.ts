import { CaldavTokenStore, CaldavTokenMetadata, CreatedCaldavToken } from './CaldavTokenStore'
import { PublishedCalendarStore } from './PublishedCalendarStore'
import { PublishedTodo, serializeCalendar } from './ICalendarSerializer'

/**
 * Standard Red Notes: facade tying together the CalDAV token store and the
 * published-calendar store, plus iCalendar serialization helpers. Holds the env
 * master switch so callers (controller + DAV router) ask ONE place "is this
 * feature on?".
 *
 * Gating model (off by default, two independent gates):
 *   1. env master switch CALDAV_ENABLED (this.enabled) — operator opt-in.
 *   2. per-user opt-in — enforced where a session/settings context exists (the
 *      authenticated CaldavTokensController checks the CALDAV_ENABLED setting
 *      before issuing a token). Possession of a valid, unrevoked, scoped token
 *      then proves the user opted in; revoking it revokes feed access.
 */
export class CaldavService {
  constructor(
    private readonly enabled: boolean,
    private readonly tokenStore: CaldavTokenStore,
    private readonly publishedStore: PublishedCalendarStore,
  ) {}

  isEnabled(): boolean {
    return this.enabled
  }

  async createToken(userUuid: string, label: string): Promise<CreatedCaldavToken> {
    return this.tokenStore.create(userUuid, label)
  }

  async listTokens(userUuid: string): Promise<CaldavTokenMetadata[]> {
    return this.tokenStore.listForUser(userUuid)
  }

  async revokeToken(userUuid: string, tokenUuid: string): Promise<boolean> {
    return this.tokenStore.revoke(userUuid, tokenUuid)
  }

  /** Verify a Basic-auth password (the plaintext CalDAV token). */
  async verifyToken(plaintext: string): Promise<CaldavTokenMetadata | null> {
    return this.tokenStore.verify(plaintext)
  }

  async listTodos(userUuid: string): Promise<PublishedTodo[]> {
    return this.publishedStore.listForUser(userUuid)
  }

  async getTodo(userUuid: string, uid: string): Promise<PublishedTodo | null> {
    return this.publishedStore.getForUser(userUuid, uid)
  }

  serializeCalendar(todos: PublishedTodo[]): string {
    return serializeCalendar(todos)
  }
}

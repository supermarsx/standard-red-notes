import { CaldavTokenStore, CaldavTokenMetadata, CreatedCaldavToken } from './CaldavTokenStore'
import { CalendarProjectionSettings, ProjectedEvent, projectTodosToEvents } from './CalendarProjection'
import { CalendarProjectionStore } from './CalendarProjectionStore'
import { PublishedCalendarStore } from './PublishedCalendarStore'
import { PublishedTodo, serializeCalendar, serializeEventCalendar } from './ICalendarSerializer'

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
    private readonly projectionStore: CalendarProjectionStore,
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

  async revokeAllTokens(userUuid: string): Promise<number> {
    return this.tokenStore.revokeAllForUser(userUuid)
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

  async publishTodo(userUuid: string, todo: PublishedTodo): Promise<PublishedTodo> {
    return this.publishedStore.publish(userUuid, todo)
  }

  async unpublishTodo(userUuid: string, uid: string): Promise<boolean> {
    return this.publishedStore.unpublish(userUuid, uid)
  }

  serializeCalendar(todos: PublishedTodo[]): string {
    return serializeCalendar(todos)
  }

  /**
   * The user's due-date-to-event projection settings. Always a complete set,
   * defaulting to OFF, so the DAV router can ask on every request without a
   * guard and an unreadable store means "no events".
   */
  async getProjection(userUuid: string): Promise<CalendarProjectionSettings> {
    return this.projectionStore.getForUser(userUuid)
  }

  /** Store projection settings and return the EFFECTIVE (normalized) set. */
  async setProjection(userUuid: string, settings: unknown): Promise<CalendarProjectionSettings> {
    return this.projectionStore.setForUser(userUuid, settings)
  }

  async resetProjection(userUuid: string): Promise<boolean> {
    return this.projectionStore.resetForUser(userUuid)
  }

  /** The user's published tasks projected onto events under their settings. */
  async listEvents(userUuid: string): Promise<ProjectedEvent[]> {
    const settings = await this.projectionStore.getForUser(userUuid)
    if (!settings.enabled) {
      return []
    }
    return projectTodosToEvents(await this.publishedStore.listForUser(userUuid), settings)
  }

  serializeEvents(events: ProjectedEvent[]): string {
    return serializeEventCalendar(events)
  }
}

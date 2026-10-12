/**
 * How long after a peer's last applied edit that peer is still reported as typing. Long enough to
 * span the pause between two words, short enough that "typing" stops being true soon after it does.
 */
export const PEER_TYPING_LINGER_MS = 3_000

export type PeerActivity = {
  /** A document edit by this peer was applied here within PEER_TYPING_LINGER_MS. */
  typing: boolean
  /**
   * When this client last saw the peer do anything — an edit applied, or the caret or selection
   * move — on THIS client's clock, so two machines whose clocks disagree cannot make a peer look
   * idle or busy. Absent until the peer has done something since it was first seen.
   */
  lastActiveAt?: number
}

type Clock = {
  now(): number
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(handle: unknown): void
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * What each remote peer in one room is doing, derived entirely from what arrives here: the edits
 * the provider applies (`EncryptedYjsProvider.onPeerEdit`) and the caret positions in awareness.
 * A peer sends nothing extra for this, so it is as true of an older client as of a current one.
 *
 * `onChange` fires when an answer changes with no new input — a peer stops typing because the
 * linger ran out — so a view never has to poll to take the indication down.
 */
export class PeerActivityTracker {
  private readonly typingUntil = new Map<number, number>()
  private readonly lastActiveAt = new Map<number, number>()
  private readonly caret = new Map<number, string>()
  private expiry: unknown

  constructor(
    private readonly onChange: () => void,
    private readonly clock: Clock = systemClock,
    private readonly lingerMilliseconds = PEER_TYPING_LINGER_MS,
  ) {}

  /** A document edit authored by `clientId` was just applied. */
  noteEdit(clientId: number): void {
    const now = this.clock.now()
    const wasTyping = this.isTyping(clientId, now)
    this.lastActiveAt.set(clientId, now)
    this.typingUntil.set(clientId, now + this.lingerMilliseconds)
    this.scheduleExpiry()
    if (!wasTyping) {
      this.onChange()
    }
  }

  /**
   * The caret/selection a peer's awareness currently carries. Activity is a CHANGE of it: the
   * first position seen says nothing about when it was reached, and the 15 s awareness renewal
   * repeats the same one.
   */
  observeCaret(clientId: number, anchorPos: unknown, focusPos: unknown): void {
    let key: string
    try {
      key = JSON.stringify([anchorPos ?? null, focusPos ?? null])
    } catch {
      return
    }
    const previous = this.caret.get(clientId)
    this.caret.set(clientId, key)
    if (previous !== undefined && previous !== key) {
      this.lastActiveAt.set(clientId, this.clock.now())
    }
  }

  describe(clientId: number): PeerActivity {
    const lastActiveAt = this.lastActiveAt.get(clientId)
    return {
      typing: this.isTyping(clientId, this.clock.now()),
      ...(lastActiveAt === undefined ? {} : { lastActiveAt }),
    }
  }

  /** Drop everything known about peers that are no longer in the room. */
  retain(present: ReadonlySet<number>): void {
    for (const map of [this.typingUntil, this.lastActiveAt, this.caret]) {
      for (const clientId of [...map.keys()]) {
        if (!present.has(clientId)) {
          map.delete(clientId)
        }
      }
    }
    this.scheduleExpiry()
  }

  dispose(): void {
    if (this.expiry !== undefined) {
      this.clock.clearTimeout(this.expiry)
      this.expiry = undefined
    }
    this.typingUntil.clear()
    this.lastActiveAt.clear()
    this.caret.clear()
  }

  private isTyping(clientId: number, now: number): boolean {
    const until = this.typingUntil.get(clientId)
    return until !== undefined && until > now
  }

  private scheduleExpiry(): void {
    if (this.expiry !== undefined) {
      this.clock.clearTimeout(this.expiry)
      this.expiry = undefined
    }
    let earliest = Number.POSITIVE_INFINITY
    for (const until of this.typingUntil.values()) {
      earliest = Math.min(earliest, until)
    }
    if (!Number.isFinite(earliest)) {
      return
    }
    this.expiry = this.clock.setTimeout(
      () => {
        this.expiry = undefined
        const now = this.clock.now()
        let stopped = false
        for (const [clientId, until] of [...this.typingUntil.entries()]) {
          if (until <= now) {
            this.typingUntil.delete(clientId)
            stopped = true
          }
        }
        this.scheduleExpiry()
        if (stopped) {
          this.onChange()
        }
      },
      Math.max(0, earliest - this.clock.now()),
    )
  }
}

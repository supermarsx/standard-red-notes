/**
 * Which other tabs of this app are open in this browser, and which of them holds the socket.
 *
 * *** WHY A TAB CANNOT WORK THIS OUT ALONE. *** One tab per account holds the
 * realtime socket; the others stand down and sync over HTTP, by design. A tab
 * that is standing down knows only that SOME tab holds the lease — not whether
 * that tab is still open, and not how many siblings there are. So "this tab is
 * on HTTP" had two readings that looked identical: the ordinary second tab, and
 * a tab waiting on an owner that is gone or is running a build too old to say
 * so. The only way to tell them apart is to ask the other tabs.
 *
 * *** HOW IT ASKS. *** Over a `BroadcastChannel`, which reaches every tab and
 * window of this origin in this browser profile — the same scope the socket
 * lease itself has. Every tab answers a census with two closed facts about
 * itself. A tab on a build older than this module does not answer at all, which
 * the reading cannot distinguish from a tab that is not there; the caller says
 * so rather than claiming a count is exact.
 *
 * *** WHAT CROSSES THE CHANNEL. *** A per-page-load random tab id, used only to
 * de-duplicate answers and to drop this tab's own; a carrier from a closed set;
 * and one boolean. No account, no session, no address. A message that is not
 * exactly that shape is ignored, in both directions — another script on the
 * origin can post to the channel, and nothing it posts is believed.
 */

export const TAB_CENSUS_CHANNEL = 'srn-tab-census-v1'

export const TAB_CARRIERS = ['socket', 'http', 'dialling'] as const

export type TabCarrier = (typeof TAB_CARRIERS)[number]

/** What one tab says about itself. */
export type TabStanding = {
  readonly carrier: TabCarrier
  /** On HTTP because another tab holds the socket, as opposed to for any other reason. */
  readonly standingBy: boolean
}

export type TabCensusReading = {
  /** Other tabs that answered. A FLOOR: a tab on an older build does not answer. */
  readonly otherTabs: number
  readonly othersOnSocket: number
  readonly othersStandingBy: number
}

type CensusChannel = {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  close(): void
}

type ChannelFactory = (name: string) => CensusChannel | undefined

const defaultChannelFactory: ChannelFactory = (name) => {
  if (typeof BroadcastChannel === 'undefined') {
    return undefined
  }
  try {
    return new BroadcastChannel(name) as unknown as CensusChannel
  } catch {
    return undefined
  }
}

const randomToken = (): string => {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** This page load's id. Never persisted, never shown; it exists to tell answers apart. */
const THIS_TAB = (() => {
  try {
    return randomToken()
  } catch {
    return `tab-${Math.random().toString(36).slice(2)}`
  }
})()

const TOKEN = /^[0-9a-z-]{8,40}$/

type Question = { type: 'who-is-here'; nonce: string; from: string }
type Answer = { type: 'here'; nonce: string; from: string; carrier: TabCarrier; standingBy: boolean }

const isQuestion = (data: unknown): data is Question => {
  const candidate = data as Partial<Question> | null
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    candidate.type === 'who-is-here' &&
    typeof candidate.nonce === 'string' &&
    TOKEN.test(candidate.nonce) &&
    typeof candidate.from === 'string' &&
    TOKEN.test(candidate.from)
  )
}

const isAnswer = (data: unknown): data is Answer => {
  const candidate = data as Partial<Answer> | null
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    candidate.type === 'here' &&
    typeof candidate.nonce === 'string' &&
    TOKEN.test(candidate.nonce) &&
    typeof candidate.from === 'string' &&
    TOKEN.test(candidate.from) &&
    (TAB_CARRIERS as readonly unknown[]).includes(candidate.carrier) &&
    typeof candidate.standingBy === 'boolean'
  )
}

/**
 * Answer every census taken by another tab, for as long as this tab lives.
 *
 * `describe` is read at the moment of each question, so the answer is where this
 * tab is NOW. Returns a disposer; a browser with no `BroadcastChannel` gets a
 * disposer that does nothing, and simply never answers.
 */
export function installTabCensusResponder(
  describe: () => TabStanding | undefined,
  options: { channelFactory?: ChannelFactory; tabId?: string } = {},
): () => void {
  const channel = (options.channelFactory ?? defaultChannelFactory)(TAB_CENSUS_CHANNEL)
  if (channel === undefined) {
    return () => undefined
  }
  const self = options.tabId ?? THIS_TAB

  channel.addEventListener('message', (event) => {
    // A question from THIS tab is answered like any other. The census drops its
    // own tab's answers, and that is the one place the rule lives: a second
    // guard here made each of the two untestable, because either hid a fault in
    // the other.
    if (!isQuestion(event.data)) {
      return
    }
    let standing: TabStanding | undefined
    try {
      standing = describe()
    } catch {
      standing = undefined
    }
    if (standing === undefined) {
      return
    }
    const answer: Answer = {
      type: 'here',
      nonce: event.data.nonce,
      from: self,
      carrier: standing.carrier,
      standingBy: standing.standingBy,
    }
    try {
      channel.postMessage(answer)
    } catch {
      // A channel closing under us is this tab going away. Nothing to report.
    }
  })

  return () => {
    try {
      channel.close()
    } catch {
      // Already closed.
    }
  }
}

/** Long enough for a background tab's throttled task queue, short enough to wait for on a button. */
export const TAB_CENSUS_WAIT_MS = 400

/**
 * Ask every other tab where it stands, wait briefly, and count the answers.
 *
 * `undefined` when this browser cannot ask at all, which is a different fact
 * from "nobody answered" and is reported as one.
 */
export async function takeTabCensus(
  options: {
    channelFactory?: ChannelFactory
    waitMs?: number
    tabId?: string
    wait?: (ms: number) => Promise<void>
  } = {},
): Promise<TabCensusReading | undefined> {
  const channel = (options.channelFactory ?? defaultChannelFactory)(TAB_CENSUS_CHANNEL)
  if (channel === undefined) {
    return undefined
  }
  const self = options.tabId ?? THIS_TAB
  const nonce = randomToken()
  // One entry per tab, however many times it answers: a page hosting several
  // signed-in accounts answers once for each, and is still one tab.
  const tabs = new Map<string, TabStanding>()

  channel.addEventListener('message', (event) => {
    const data = event.data
    if (!isAnswer(data) || data.nonce !== nonce || data.from === self) {
      return
    }
    const previous = tabs.get(data.from)
    // A tab holds the socket if any of its answers says so.
    if (previous === undefined || (previous.carrier !== 'socket' && data.carrier === 'socket')) {
      tabs.set(data.from, { carrier: data.carrier, standingBy: data.standingBy })
    }
  })

  try {
    const question: Question = { type: 'who-is-here', nonce, from: self }
    channel.postMessage(question)
    await (options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
      options.waitMs ?? TAB_CENSUS_WAIT_MS,
    )
  } finally {
    try {
      channel.close()
    } catch {
      // Already closed.
    }
  }

  const standings = [...tabs.values()]

  return {
    otherTabs: standings.length,
    othersOnSocket: standings.filter((standing) => standing.carrier === 'socket').length,
    othersStandingBy: standings.filter((standing) => standing.standingBy).length,
  }
}

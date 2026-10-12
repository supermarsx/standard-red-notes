import { installTabCensusResponder, takeTabCensus, TAB_CENSUS_CHANNEL, type TabStanding } from './TabCensus'

/**
 * A `BroadcastChannel` for one origin, as the platform defines it: a message
 * posted on one channel object reaches every OTHER channel object of the same
 * name — including others in the same tab — and never the one that posted it.
 */
const origin = () => {
  type Listener = (event: { data: unknown }) => void
  const channels: { name: string; listeners: Listener[]; closed: boolean }[] = []
  const posted: unknown[] = []

  const factory = (name: string) => {
    const self = { name, listeners: [] as Listener[], closed: false }
    channels.push(self)

    return {
      postMessage(message: unknown) {
        if (self.closed) {
          throw new Error('channel is closed')
        }
        posted.push(message)
        for (const other of channels) {
          if (other !== self && !other.closed && other.name === name) {
            for (const listener of other.listeners) {
              listener({ data: JSON.parse(JSON.stringify(message)) })
            }
          }
        }
      },
      addEventListener(_type: 'message', listener: Listener) {
        self.listeners.push(listener)
      },
      close() {
        self.closed = true
      },
    }
  }

  return { factory, posted, open: () => channels.filter((channel) => !channel.closed).length }
}

const noWait = async () => undefined

const tab = (id: string, standing: TabStanding | undefined, channelFactory: ReturnType<typeof origin>['factory']) =>
  installTabCensusResponder(() => standing, { channelFactory, tabId: id })

describe('the tab census', () => {
  it('counts the other tabs that answer, and which of them holds the socket', async () => {
    const browser = origin()
    tab('tab-owner-1', { carrier: 'socket', standingBy: false }, browser.factory)
    tab('tab-other-2', { carrier: 'http', standingBy: true }, browser.factory)
    tab('tab-other-3', { carrier: 'http', standingBy: true }, browser.factory)

    const reading = await takeTabCensus({ channelFactory: browser.factory, tabId: 'tab-asking-9', wait: noWait })

    expect(reading).toEqual({ otherTabs: 3, othersOnSocket: 1, othersStandingBy: 2 })
  })

  it('finds no other tab when this is the only one, and does not count itself', async () => {
    const browser = origin()
    // This tab's own responder is a second channel object in the same tab, so it
    // DOES receive the question. It must not be counted as a sibling.
    tab('tab-asking-9', { carrier: 'socket', standingBy: false }, browser.factory)

    const reading = await takeTabCensus({ channelFactory: browser.factory, tabId: 'tab-asking-9', wait: noWait })

    expect(reading).toEqual({ otherTabs: 0, othersOnSocket: 0, othersStandingBy: 0 })
  })

  it('counts a tab once however many times it answers, and as on the socket if any answer says so', async () => {
    const browser = origin()
    // One page hosting two signed-in accounts answers once for each.
    tab('tab-two-accounts', { carrier: 'http', standingBy: true }, browser.factory)
    tab('tab-two-accounts', { carrier: 'socket', standingBy: false }, browser.factory)

    const reading = await takeTabCensus({ channelFactory: browser.factory, tabId: 'tab-asking-9', wait: noWait })

    expect(reading?.otherTabs).toBe(1)
    expect(reading?.othersOnSocket).toBe(1)
  })

  it('says it could not ask, rather than that nobody answered, where there is no BroadcastChannel', async () => {
    const reading = await takeTabCensus({ channelFactory: () => undefined, wait: noWait })

    expect(reading).toBeUndefined()
    // And a responder on such a browser installs nothing and throws nothing.
    expect(() => installTabCensusResponder(() => undefined, { channelFactory: () => undefined })()).not.toThrow()
  })

  it('answers with where the tab stands at the moment it is asked', async () => {
    const browser = origin()
    let standing: TabStanding = { carrier: 'dialling', standingBy: false }
    installTabCensusResponder(() => standing, { channelFactory: browser.factory, tabId: 'tab-moving-1' })

    const first = await takeTabCensus({ channelFactory: browser.factory, tabId: 'tab-asking-9', wait: noWait })
    standing = { carrier: 'socket', standingBy: false }
    const second = await takeTabCensus({ channelFactory: browser.factory, tabId: 'tab-asking-9', wait: noWait })

    expect(first?.othersOnSocket).toBe(0)
    expect(second?.othersOnSocket).toBe(1)
  })

  it('does not answer for a tab that cannot say where it stands, and survives one that throws', async () => {
    const browser = origin()
    tab('tab-silent-1', undefined, browser.factory)
    installTabCensusResponder(
      () => {
        throw new Error('no transport')
      },
      { channelFactory: browser.factory, tabId: 'tab-broken-2' },
    )

    const reading = await takeTabCensus({ channelFactory: browser.factory, tabId: 'tab-asking-9', wait: noWait })

    expect(reading?.otherTabs).toBe(0)
  })

  /**
   * *** ANYTHING ON THE ORIGIN CAN POST TO THE CHANNEL. *** Nothing it posts is
   * believed unless it is exactly an answer to THIS question, and nothing posted
   * here carries more than a random id, a closed carrier and a boolean.
   */
  it('ignores every message that is not exactly an answer to its own question', async () => {
    const browser = origin()
    const forger = browser.factory(TAB_CENSUS_CHANNEL)
    const census = takeTabCensus({
      channelFactory: browser.factory,
      tabId: 'tab-asking-9',
      wait: async () => {
        const question = browser.posted.find((message) => (message as { type?: string }).type === 'who-is-here') as {
          nonce: string
        }
        const honest = {
          type: 'here',
          nonce: question.nonce,
          from: 'tab-forged-1',
          carrier: 'socket',
          standingBy: false,
        }

        forger.postMessage({ ...honest, nonce: 'a-different-question' })
        forger.postMessage({ ...honest, carrier: 'https://evil.internal.example/' })
        forger.postMessage({ ...honest, standingBy: 'yes' })
        forger.postMessage({ ...honest, from: 'NOT A TOKEN / hunter2' })
        forger.postMessage({ ...honest, from: 'tab-asking-9' })
        forger.postMessage('here')
        forger.postMessage(null)
        forger.postMessage({ type: 'here' })
      },
    })

    expect(await census).toEqual({ otherTabs: 0, othersOnSocket: 0, othersStandingBy: 0 })
  })

  it('puts nothing on the channel but a random id, a closed carrier and a boolean', async () => {
    const browser = origin()
    tab('tab-owner-1', { carrier: 'socket', standingBy: false }, browser.factory)

    await takeTabCensus({ channelFactory: browser.factory, tabId: 'tab-asking-9', wait: noWait })

    for (const message of browser.posted) {
      const keys = Object.keys(message as object).sort()
      expect([
        ['from', 'nonce', 'type'],
        ['carrier', 'from', 'nonce', 'standingBy', 'type'],
      ]).toContainEqual(keys)
    }
  })

  it('closes the channel it asked on, and a disposed responder stops answering', async () => {
    const browser = origin()
    const dispose = tab('tab-owner-1', { carrier: 'socket', standingBy: false }, browser.factory)
    expect(browser.open()).toBe(1)

    await takeTabCensus({ channelFactory: browser.factory, tabId: 'tab-asking-9', wait: noWait })
    expect(browser.open()).toBe(1)

    dispose()
    const after = await takeTabCensus({ channelFactory: browser.factory, tabId: 'tab-asking-9', wait: noWait })

    expect(after?.otherTabs).toBe(0)
    expect(browser.open()).toBe(0)
  })
})

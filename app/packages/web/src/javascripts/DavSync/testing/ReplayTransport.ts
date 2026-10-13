import { DavTransport, RelayRequest, RelayResult } from '../transport/DavTransport'

/** One request the sync code sent and what came back, as recorded against a real server. */
export type RecordedExchange = { request: RelayRequest; result: RelayResult }

/** What a test did to the server directly, the way another calendar app would, and what it answered. */
export type RecordedObservation = { status: number; etag?: string; body: string }

export type Recording = {
  /** Which server answered, with its version. */
  server: string
  exchanges: RecordedExchange[]
  observations: RecordedObservation[]
}

const requestKey = (request: RelayRequest): string => {
  const headers = request.headers ?? {}
  return JSON.stringify([
    request.method,
    request.path,
    Object.keys(headers)
      .sort()
      .map((name) => [name, headers[name as keyof typeof headers]]),
    request.body ?? '',
  ])
}

/**
 * Answers requests from a recording, and only from it.
 *
 * A request is answered by the first unused recorded exchange whose request is
 * exactly the same: method, path, headers and body. A request that was never
 * recorded throws, so sync code that starts sending something different fails
 * its tests instead of being handed an answer to a question it did not ask.
 */
export class ReplayTransport implements DavTransport {
  readonly sent: RelayRequest[] = []
  private readonly used: boolean[]

  constructor(private readonly recording: Recording) {
    this.used = recording.exchanges.map(() => false)
  }

  async request(request: RelayRequest): Promise<RelayResult> {
    this.sent.push(request)
    const key = requestKey(request)
    const index = this.recording.exchanges.findIndex(
      (exchange, at) => !this.used[at] && requestKey(exchange.request) === key,
    )
    if (index < 0) {
      throw new Error(
        `No recorded answer left for ${request.method} ${request.path} ` +
          `(headers ${JSON.stringify(request.headers ?? {})}, body ${JSON.stringify(request.body ?? '')}). ` +
          `Recorded against ${this.recording.server}.`,
      )
    }
    this.used[index] = true
    // A copy, so that code under test cannot alter the recording for the next test.
    return JSON.parse(JSON.stringify(this.recording.exchanges[index].result)) as RelayResult
  }

  /** Recorded exchanges that were never asked for. */
  unused(): RecordedExchange[] {
    return this.recording.exchanges.filter((_exchange, at) => !this.used[at])
  }
}

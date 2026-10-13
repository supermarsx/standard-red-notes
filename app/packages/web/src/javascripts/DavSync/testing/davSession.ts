import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DavTransport, RelayRequest, RelayResult } from '../transport/DavTransport'
import { LiveAccount, LiveTransport, rawRequest } from './LiveTransport'
import { RecordedExchange, RecordedObservation, Recording, ReplayTransport } from './ReplayTransport'

/**
 * Standard Red Notes: one test body, two ways to run it.
 *
 * Normally a session REPLAYS a recording: every request the sync code sends is
 * answered by what a real server answered when the same test ran against it.
 * With `DAV_RECORD_ORIGIN` set, the same test body runs against that server
 * for real and the recording is written again. The recordings are therefore
 * never written by hand and never drift from the code: they are what this exact
 * test provoked from that exact server.
 *
 * To record (a throwaway server only, never anyone's real account):
 *
 *   DAV_RECORD_ORIGIN=http://127.0.0.1:5632 DAV_RECORD_USER=alice DAV_RECORD_PASSWORD=… \
 *   DAV_RECORD_SERVER="Radicale 3.5.4" DAV_RECORD_PREFIX=radicale \
 *     yarn jest --config jest.config.js -i src/javascripts/DavSync
 *
 * Then format the written files with prettier.
 */

/** Acts on the server directly, the way another calendar app would. */
export type SessionObserver = {
  request(method: string, path: string, headers?: Record<string, string>, body?: string): Promise<RecordedObservation>
}

export type DavSessionContext = {
  transport: DavTransport
  observer: SessionObserver
  /** Every request the sync code sent in this session, in order. */
  sent: RelayRequest[]
  /** The server the session runs against, or ran against when it was recorded. */
  server: string
  /** True when the session is talking to a real server right now. */
  live: boolean
}

const RECORDINGS = path.join(__dirname, '..', '__fixtures__', 'recordings')

/** The recording a session of this name uses: `<prefix>-<name>.json`. */
export const recordingFile = (prefix: string, name: string): string => path.join(RECORDINGS, `${prefix}-${name}.json`)

const liveAccount = (): (LiveAccount & { server: string; prefix: string }) | null => {
  const origin = process.env.DAV_RECORD_ORIGIN
  if (!origin) {
    return null
  }
  return {
    origin,
    username: process.env.DAV_RECORD_USER ?? '',
    password: process.env.DAV_RECORD_PASSWORD ?? '',
    server: process.env.DAV_RECORD_SERVER ?? 'unnamed server',
    prefix: process.env.DAV_RECORD_PREFIX ?? '',
  }
}

/**
 * Run `body` as a session called `name` against the server `prefix` names.
 * When recording, only sessions whose prefix is the one being recorded talk to
 * the server; the others replay as usual.
 */
export async function davSession(
  prefix: string,
  name: string,
  body: (context: DavSessionContext) => Promise<void>,
): Promise<void> {
  const account = liveAccount()
  const file = recordingFile(prefix, name)

  if (account && account.prefix === prefix) {
    const live = new LiveTransport(account)
    const exchanges: RecordedExchange[] = []
    const observations: RecordedObservation[] = []
    const sent: RelayRequest[] = []
    const transport: DavTransport = {
      async request(request: RelayRequest): Promise<RelayResult> {
        sent.push(request)
        const result = await live.request(request)
        exchanges.push({ request, result })
        return result
      },
    }
    const observer: SessionObserver = {
      async request(method, requestPath, headers, requestBody) {
        const answer = await rawRequest(account, method, requestPath, headers, requestBody)
        const observation: RecordedObservation = { status: answer.status, body: answer.body }
        if (typeof answer.headers.etag === 'string') {
          observation.etag = answer.headers.etag
        }
        observations.push(observation)
        return observation
      },
    }
    await body({ transport, observer, sent, server: account.server, live: true })
    const recording: Recording = { server: account.server, exchanges, observations }
    mkdirSync(RECORDINGS, { recursive: true })
    writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`)
    return
  }

  const recording = JSON.parse(readFileSync(file, 'utf8')) as Recording
  const replay = new ReplayTransport(recording)
  let observed = 0
  const observer: SessionObserver = {
    async request() {
      const observation = recording.observations[observed]
      if (!observation) {
        throw new Error(
          `The recording ${path.basename(file)} holds no further observation (asked for #${observed + 1}).`,
        )
      }
      observed += 1
      return observation
    },
  }
  await body({ transport: replay, observer, sent: replay.sent, server: recording.server, live: false })

  const unused = replay.unused()
  if (unused.length > 0 || observed !== recording.observations.length) {
    throw new Error(
      `The recording ${path.basename(file)} was not used up: ${unused.length} exchange(s) never asked for ` +
        `(first: ${unused[0]?.request.method ?? '-'} ${unused[0]?.request.path ?? '-'}), ` +
        `${recording.observations.length - observed} observation(s) never made. Record it again.`,
    )
  }
}

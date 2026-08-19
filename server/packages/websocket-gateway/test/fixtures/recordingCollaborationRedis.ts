/**
 * A deliberately minimal fake Redis for CollaborationRedisBridge that RECORDS
 * every Lua script invocation by name.
 *
 * Negative security tests need to assert that the grant backend was never
 * reached — not merely that the client saw an error. The deepest such boundary
 * on the gateway side is the `SRN_RESERVE_LEASE_V3` EVAL: once that runs, a
 * lease key exists in shared Redis and the room has been mutated. Asserting on
 * `reserveEvalCalls === 0` (and on the empty `leases`/`sets`/`roomStates` maps)
 * therefore proves failure-closed at the real backend, not at a stub of it.
 *
 * The implementations below mirror the production scripts only as far as a
 * single happy-path reserve -> activate -> release flow requires, so that the
 * positive control test in the same file genuinely exercises the recorder.
 */
export type CollaborationScriptName =
  'SRN_RESERVE_LEASE_V3' | 'SRN_REFRESH_OWNED_LEASE_V3' | 'SRN_RELEASE_LEASE_V3' | 'SRN_CLAIM_YJS_RESPONSE_V1'

type MessageHandler = (channel: string, message: string) => void
type SubscriptionCallback = (error: Error | null | undefined, count?: unknown) => void

const SCRIPT_NAMES: CollaborationScriptName[] = [
  'SRN_RESERVE_LEASE_V3',
  'SRN_REFRESH_OWNED_LEASE_V3',
  'SRN_RELEASE_LEASE_V3',
  'SRN_CLAIM_YJS_RESPONSE_V1',
]

function scriptNameOf(script: string): CollaborationScriptName {
  const matched = SCRIPT_NAMES.find((name) => script.includes(name))
  if (!matched) {
    throw new Error('Unknown fake Redis collaboration script')
  }
  return matched
}

export class RecordingCollaborationRedis {
  /** Every EVAL this fake has seen, oldest first. */
  readonly scriptCalls: CollaborationScriptName[] = []
  readonly sets = new Map<string, Set<string>>()
  readonly leases = new Map<string, number>()
  readonly leaseValues = new Map<string, string>()
  readonly roomStates = new Map<string, string>()
  readonly published: Array<{ channel: string; message: string }> = []
  private readonly subscribers = new Set<MessageHandler>()
  private nextClientRole: 'command' | 'subscriber' = 'command'

  get reserveEvalCalls(): number {
    return this.scriptCalls.filter((name) => name === 'SRN_RESERVE_LEASE_V3').length
  }

  get refreshEvalCalls(): number {
    return this.scriptCalls.filter((name) => name === 'SRN_REFRESH_OWNED_LEASE_V3').length
  }

  /** True when nothing durable about any room has been created or mutated. */
  get isPristine(): boolean {
    return this.leases.size === 0 && this.sets.size === 0 && this.roomStates.size === 0
  }

  client() {
    const role = this.nextClientRole
    this.nextClientRole = role === 'command' ? 'subscriber' : 'command'
    let messageHandler: MessageHandler | undefined
    return {
      status: 'ready',
      on: (event: string, handler: (...args: never[]) => void) => {
        if (event === 'message') {
          messageHandler = handler as MessageHandler
          this.subscribers.add(messageHandler)
        }
        return this
      },
      subscribe: (_channel: string, callback: SubscriptionCallback) => {
        callback(null, 1)
      },
      eval: async (script: string, _keyCount: number, ...args: Array<string | number>) => {
        const name = scriptNameOf(script)
        this.scriptCalls.push(name)
        if (name === 'SRN_CLAIM_YJS_RESPONSE_V1') {
          return 1
        }
        const roomSetKey = String(args[0])
        const leaseKey = String(args[1])
        const roomStateKey = String(args[2])
        const members = this.sets.get(roomSetKey) ?? new Set<string>()

        if (name === 'SRN_RESERVE_LEASE_V3') {
          const ttl = Number(args[3])
          const redisValue = String(args[5])
          const roomEpoch = String(args[7])
          const securityEpoch = String(args[8])
          const authorizationIssuedAt = Number(args[11])
          const requestedState = `${roomEpoch}:${securityEpoch}:${authorizationIssuedAt}`
          const currentState = this.roomStates.get(roomStateKey)
          if (currentState === undefined) {
            this.roomStates.set(roomStateKey, requestedState)
          } else if (currentState !== requestedState) {
            const separator = currentState.indexOf(':')
            return `epoch:${separator >= 0 ? currentState.slice(0, separator) : ''}`
          }
          const active = members.size
          this.leases.set(leaseKey, ttl)
          this.leaseValues.set(leaseKey, redisValue)
          members.add(leaseKey)
          this.sets.set(roomSetKey, members)
          return active === 0 ? 1 : 0
        }

        if (name === 'SRN_REFRESH_OWNED_LEASE_V3') {
          const ttl = Number(args[3])
          const marker = String(args[5])
          const roomStatePrefix = String(args[7])
          if (this.leaseValues.get(leaseKey) !== marker || !this.leases.has(leaseKey) || !members.has(leaseKey)) {
            return -3
          }
          if (!this.roomStates.get(roomStateKey)?.startsWith(`${roomStatePrefix}:`)) {
            return -3
          }
          this.leases.set(leaseKey, ttl)
          return 1
        }

        this.leases.delete(leaseKey)
        this.leaseValues.delete(leaseKey)
        members.delete(leaseKey)
        if (members.size === 0) {
          this.sets.delete(roomSetKey)
          if (this.roomStates.get(roomStateKey)?.startsWith(`${String(args[4])}:`)) {
            this.roomStates.set(roomStateKey, String(args[3]))
          }
        }
        return 1
      },
      pexpire: async (key: string, milliseconds: number) => {
        if (!this.leases.has(key)) {
          return 0
        }
        this.leases.set(key, milliseconds)
        return 1
      },
      publish: async (channel: string, message: string) => {
        this.published.push({ channel, message })
        for (const subscriber of this.subscribers) {
          subscriber(channel, message)
        }
        return this.subscribers.size
      },
      quit: async () => undefined,
      disconnect: () => {
        if (messageHandler) {
          this.subscribers.delete(messageHandler)
        }
      },
    }
  }
}

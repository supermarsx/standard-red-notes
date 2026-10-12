import { lookup } from 'dns/promises'
import { isIP } from 'net'
import { networkInterfaces } from 'os'

import {
  PinnedHttpTransport,
  PinnedRequestFactory,
  ResolveHost,
  resolveHttpUrlForOutboundConnection,
  SsrfValidationError,
} from '@standardnotes/domain-core'

import { DavBridgeRefusal, davRefusal } from './DavBridgeRefusal'

/**
 * Standard Red Notes: where the DAV relay may connect.
 *
 * The relay makes the SERVER open a connection to an address a USER typed, and
 * sends a stored password along. Without rules that is a way to reach things
 * inside the operator's network; with rules that are too strict it cannot reach
 * a Nextcloud on the operator's own LAN, which is where most self-hosters keep
 * one. The rules:
 *
 *   target                                   default    if its exact origin is on
 *                                                       the operator's list
 *   ---------------------------------------  ---------  -------------------------
 *   public address, https, port 443          allowed    allowed
 *   public address, https, another port      refused    allowed
 *   public address, http                     refused    allowed (operator's choice;
 *                                                       the password travels in clear)
 *   RFC 1918, CGNAT, unique-local            refused    ALLOWED, http included
 *   localhost, *.local, *.internal names     refused    allowed, subject to the two
 *                                                       rows below
 *   loopback, link-local (169.254.169.254),  refused    STILL REFUSED
 *     unspecified, multicast, every other
 *     special range, IPv4-mapped IPv6
 *   this deployment's own services, by       refused    STILL REFUSED
 *     name and by address
 *
 * The last two rows are code, not settings: no entry on any list reaches them.
 *
 * Address checks are not done here. They are done by the pinned transport this
 * class builds, at the moment it resolves the name, on the answer it then
 * connects to (`allowedPrivateOriginScope: 'private-ranges'` in domain-core).
 * A check made here on one DNS answer followed by a connection made on another
 * would be the rebinding hole this exists to close.
 */

/**
 * Service names of this stack's own containers (docker-compose.yml). On the
 * stack's network these resolve to the database, the cache, the queue emulator,
 * the Docker socket proxy and the server itself. A fixed list, so that
 * `http://db:3306` cannot be put on the operator's list by mistake.
 */
export const DAV_OWN_SERVICE_NAMES: readonly string[] = [
  'server',
  'db',
  'cache',
  'floci',
  'app',
  'mcp',
  'n8n',
  'docker-socket-proxy',
]

/**
 * Ports this deployment's own processes listen on (docker-entrypoint.sh,
 * HomeServer.ts). Refused on any address that belongs to this machine.
 */
export const DAV_OWN_SERVICE_PORTS: readonly number[] = [3000, 3101, 3103, 3104, 3105, 50051, 50052]

const OWN_ADDRESS_CACHE_MS = 60_000
const OWN_NAME_LOOKUP_TIMEOUT_MS = 1_000

export type DavPolicyLogTag =
  'scheme' | 'own-service-name' | 'port-not-listed' | 'http-not-listed' | 'blocked-address' | 'unresolvable'

export interface DavNetworkPolicyOptions {
  /** DNS for user-typed hosts. Injectable for tests; defaults to the system resolver. */
  resolveHost?: ResolveHost
  /** The socket factory. Injectable so tests can COUNT connection attempts. */
  requestFactory?: PinnedRequestFactory
  /** DNS for the stack's own service names. Defaults to the system resolver. */
  resolveOwnServiceName?: (name: string) => Promise<string[]>
  /** This machine's own interface addresses. Defaults to `os.networkInterfaces()`. */
  ownInterfaceAddresses?: () => string[]
  /** The port this process listens on, added to the fixed list. */
  listeningPort?: number
  now?: () => number
}

export interface DavTargetDecision {
  /** Whether the target's exact origin is on the operator's list. */
  listed: boolean
}

const defaultResolveOwnServiceName = async (name: string): Promise<string[]> =>
  (await lookup(name, { all: true })).map((record) => record.address)

const defaultOwnInterfaceAddresses = (): string[] => {
  const addresses: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      addresses.push(entry.address)
    }
  }
  return addresses
}

/** One spelling per address, so that a set lookup cannot be dodged by another spelling. */
export function canonicalAddress(address: string): string {
  const family = isIP(address)
  if (family === 6) {
    try {
      return new URL(`http://[${address}]/`).hostname.slice(1, -1)
    } catch {
      return address.toLowerCase()
    }
  }
  return address
}

function effectivePort(url: URL): number {
  if (url.port !== '') {
    return Number(url.port)
  }
  return url.protocol === 'https:' ? 443 : 80
}

function bareHostname(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
}

export class DavNetworkPolicy {
  private readonly resolveHost?: ResolveHost
  private readonly requestFactory?: PinnedRequestFactory
  private readonly resolveOwnServiceName: (name: string) => Promise<string[]>
  private readonly ownInterfaceAddresses: () => string[]
  private readonly ownPorts: ReadonlySet<number>
  private readonly now: () => number
  private ownServiceAddresses: { addresses: ReadonlySet<string>; expiresAt: number } | undefined
  private ownServiceRefresh: Promise<ReadonlySet<string>> | undefined

  constructor(options: DavNetworkPolicyOptions = {}) {
    this.resolveHost = options.resolveHost
    this.requestFactory = options.requestFactory
    this.resolveOwnServiceName = options.resolveOwnServiceName ?? defaultResolveOwnServiceName
    this.ownInterfaceAddresses = options.ownInterfaceAddresses ?? defaultOwnInterfaceAddresses
    this.ownPorts = new Set([
      ...DAV_OWN_SERVICE_PORTS,
      ...(options.listeningPort !== undefined && Number.isInteger(options.listeningPort)
        ? [options.listeningPort]
        : []),
    ])
    this.now = options.now ?? ((): number => Date.now())
  }

  /**
   * The rules that need no DNS answer, or that need one only to choose the
   * right sentence. Throws the refusal the caller should send. `whileSaving`
   * only selects the HTTP status of "host not found".
   */
  async assertTargetAcceptable(
    target: URL,
    allowedPrivateOrigins: ReadonlySet<string>,
    whileSaving: boolean,
  ): Promise<DavTargetDecision> {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw davRefusal.addressNotAllowed(target.origin, 'scheme' satisfies DavPolicyLogTag)
    }

    // By name first: these never reach DNS and no list can admit them.
    if (DAV_OWN_SERVICE_NAMES.includes(bareHostname(target))) {
      throw davRefusal.addressNotAllowed(target.origin, 'own-service-name' satisfies DavPolicyLogTag)
    }

    const listed = allowedPrivateOrigins.has(target.origin)
    if (listed) {
      return { listed }
    }

    // Not listed: only public, https, port 443. Decide which sentence helps.
    // "Use https" is the wrong advice for an address that would be refused over
    // https as well, so look at where the name points before giving it.
    if (target.protocol !== 'https:' || effectivePort(target) !== 443) {
      await this.assertResolvesPublicly(target, whileSaving)
      if (target.protocol !== 'https:') {
        throw davRefusal.httpsRequired(target.origin)
      }
      throw davRefusal.addressNotAllowed(target.origin, 'port-not-listed' satisfies DavPolicyLogTag)
    }

    return { listed }
  }

  /**
   * The check made when an account is saved, so that the user gets an answer
   * they can act on at once. It resolves the name and applies the same address
   * rules the transport applies when it connects. It opens no connection.
   */
  async assertSavable(target: URL, allowedPrivateOrigins: ReadonlySet<string>): Promise<DavTargetDecision> {
    const decision = await this.assertTargetAcceptable(target, allowedPrivateOrigins, true)
    const isAddressDenied = await this.addressDenialFor(target, decision.listed)
    try {
      await resolveHttpUrlForOutboundConnection(target.origin, this.resolveHost, {
        allowedPrivateOrigins: decision.listed ? new Set([target.origin]) : new Set<string>(),
        allowedPrivateOriginScope: 'private-ranges',
        isAddressDenied,
      })
    } catch (error) {
      throw this.refusalFor(error, target, true)
    }
    return decision
  }

  /**
   * A transport for ONE request to `target`. It resolves, checks and connects
   * to the same address. Private reach is granted to this target's origin only,
   * and only when the operator listed it; redirects are left to the caller
   * (`redirect: 'manual'`), which puts every hop through this policy again.
   */
  async transportFor(target: URL, decision: DavTargetDecision): Promise<PinnedHttpTransport> {
    return new PinnedHttpTransport(this.resolveHost, this.requestFactory, {
      allowedPrivateOrigins: decision.listed ? [target.origin] : [],
      allowedPrivateOriginScope: 'private-ranges',
      isAddressDenied: await this.addressDenialFor(target, decision.listed),
    })
  }

  /** Maps a transport or resolver failure onto the refusal the caller should send. */
  refusalFor(error: unknown, target: URL, whileSaving: boolean): DavBridgeRefusal | unknown {
    if (error instanceof DavBridgeRefusal) {
      return error
    }
    if (error instanceof SsrfValidationError) {
      if (error.tag === 'unresolvable-host') {
        return davRefusal.hostNotFound(bareHostname(target), whileSaving)
      }
      return davRefusal.addressNotAllowed(
        target.origin,
        (error.tag === 'blocked-host' ? 'blocked-address' : 'scheme') satisfies DavPolicyLogTag,
      )
    }
    return error
  }

  private async assertResolvesPublicly(target: URL, whileSaving: boolean): Promise<void> {
    try {
      await resolveHttpUrlForOutboundConnection(target.origin, this.resolveHost)
    } catch (error) {
      throw this.refusalFor(error, target, whileSaving)
    }
  }

  /**
   * Addresses refused for this target whatever its origin is listed as. Only a
   * listed origin can reach private space at all, so only then is it worth
   * finding out where the stack's own services live.
   */
  private async addressDenialFor(target: URL, listed: boolean): Promise<(address: string) => boolean> {
    if (!listed) {
      return () => false
    }
    const ownServices = await this.currentOwnServiceAddresses()
    const ownInterfaces = new Set(this.ownInterfaceAddresses().map(canonicalAddress))
    const targetsOwnPort = this.ownPorts.has(effectivePort(target))

    return (address: string): boolean => {
      const canonical = canonicalAddress(address)
      return ownServices.has(canonical) || (targetsOwnPort && ownInterfaces.has(canonical))
    }
  }

  /**
   * Where the stack's own service names point right now. A name that does not
   * resolve (every topology but compose) contributes nothing. Cached briefly:
   * container addresses change on restart, and a lookup per request for names
   * that do not exist would be a self-inflicted delay.
   */
  private async currentOwnServiceAddresses(): Promise<ReadonlySet<string>> {
    const cached = this.ownServiceAddresses
    if (cached && cached.expiresAt > this.now()) {
      return cached.addresses
    }
    if (!this.ownServiceRefresh) {
      this.ownServiceRefresh = this.resolveOwnServiceAddresses().finally(() => {
        this.ownServiceRefresh = undefined
      })
    }
    return this.ownServiceRefresh
  }

  private async resolveOwnServiceAddresses(): Promise<ReadonlySet<string>> {
    const found = new Set<string>()
    await Promise.all(
      DAV_OWN_SERVICE_NAMES.map(async (name) => {
        let timer: NodeJS.Timeout | undefined
        try {
          const addresses = await Promise.race([
            this.resolveOwnServiceName(name),
            new Promise<string[]>((resolve) => {
              timer = setTimeout(() => resolve([]), OWN_NAME_LOOKUP_TIMEOUT_MS)
            }),
          ])
          for (const address of addresses) {
            found.add(canonicalAddress(address))
          }
        } catch {
          // Not resolvable here: this is not the compose topology, or the
          // service is not running. Nothing to refuse by address.
        } finally {
          if (timer) {
            clearTimeout(timer)
          }
        }
      }),
    )
    this.ownServiceAddresses = { addresses: found, expiresAt: this.now() + OWN_ADDRESS_CACHE_MS }
    return found
  }
}

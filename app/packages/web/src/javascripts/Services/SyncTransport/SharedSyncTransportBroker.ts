import type { MainToSyncWorkerMessage, SyncWorkerToMainMessage } from './syncTransportProtocol'

export type BrokerInbound =
  | { type: 'BROKER_ATTACH'; sessionScope: string; revision: string }
  | { type: 'BROKER_DETACH' }
  | { type: 'BROKER_HEARTBEAT' }
  | MainToSyncWorkerMessage

export interface BrokerPort {
  postMessage(message: SyncWorkerToMainMessage): void
}

export interface BrokerRuntime {
  handle(message: MainToSyncWorkerMessage): Promise<void>
  isBrokerPrimaryIdle(): boolean
  detachBrokerClient(requestIds: ReadonlySet<string>, clientId?: string): Promise<void>
  registerBrokerRpcOwner?(requestId: string, clientId: string): void
}

type Client = {
  port: BrokerPort
  requests: Map<string, string>
  savers: Map<string, boolean>
  readiness?: string
  invite?: Extract<MainToSyncWorkerMessage, { type: 'SUBSCRIBE_INVITE_EVENTS' }>
  lastSeen: number
}

const PRIMARY = new Set(['EXECUTE', 'RECOVER', 'AUTHORIZE_COLLABORATION'])
const BROADCAST = new Set([
  'STATE',
  'NEGOTIATED',
  'SAVE_LANE',
  'DIAL_HOLD_ARMED',
  'DIAL_HOLD_ENDED',
  'SESSION_NOT_AUTHORIZED',
])

/** One authenticated session, one runtime, one durable journal/socket owner. */
export class SharedSyncTransportBroker {
  private readonly clients = new Map<string, Client>()
  private readonly owners = new Map<string, { clientId: string; externalId: string }>()
  private readonly queue: Array<{ clientId: string; message: MainToSyncWorkerMessage }> = []
  private readonly health = new Map<string, SyncWorkerToMainMessage>()
  private sessionScope?: string
  private stopped = false
  private pumping = false
  private readinessActive = false
  private inviteActive = false
  private inviteReady?: Extract<SyncWorkerToMainMessage, { type: 'INVITE_READY' }>
  private inviteBatch?: Extract<SyncWorkerToMainMessage, { type: 'INVITE_BATCH' }>
  private readonly inviteAcks = new Set<string>()
  private readonly refreshOwners = new Map<string, string>()
  private readonly ticketOwners = new Map<string, { clientId: string; externalId: string }>()
  private readonly commandOwners = new Map<string, string>()
  private readonly readyId = 'shared-broker:readiness'
  private readonly inviteId = 'shared-broker:invites'
  private revocation?: Promise<void>
  private revocationSucceeded = false

  constructor(
    private readonly runtime: BrokerRuntime,
    private readonly revision: string,
    private readonly now: () => number = Date.now,
  ) {}

  async receive(clientId: string, port: BrokerPort, input: BrokerInbound): Promise<void> {
    if (input.type === 'BROKER_ATTACH') {
      if (
        this.stopped ||
        typeof input.sessionScope !== 'string' ||
        !input.sessionScope ||
        input.sessionScope.length > 1024 ||
        input.revision !== this.revision ||
        (this.sessionScope && this.sessionScope !== input.sessionScope)
      ) {
        port.postMessage({ type: 'SESSION_NOT_AUTHORIZED', sessionScope: input.sessionScope })
        return
      }
      this.sessionScope = input.sessionScope
      if (!this.clients.has(clientId)) {
        this.clients.set(clientId, { port, requests: new Map(), savers: new Map(), lastSeen: this.now() })
      }
      port.postMessage({ type: 'WORKER_BUILD', revision: this.revision })
      for (const message of this.health.values()) {
        port.postMessage(message)
      }
      return
    }
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }
    client.lastSeen = this.now()
    if (input.type === 'BROKER_HEARTBEAT') {
      return
    }
    if (input.type === 'BROKER_DETACH' || input.type === 'SHUTDOWN') {
      await this.detach(clientId)
      port.postMessage({ type: 'SHUTDOWN_COMPLETE' })
      return
    }
    if ('sessionScope' in input && input.sessionScope !== this.sessionScope) {
      return
    }
    if (input.type === 'SESSION_REVOKED') {
      if (!this.revocation) {
        this.stopped = true
        this.queue.length = 0
        const requestId = `${clientId}:${input.requestId}`
        this.owners.set(requestId, { clientId, externalId: input.requestId })
        this.revocation = this.runtime.handle({ ...input, requestId })
        await this.revocation
        for (const [id, other] of this.clients) {
          if (id !== clientId) {
            other.port.postMessage({ type: 'SESSION_NOT_AUTHORIZED', sessionScope: input.sessionScope })
          }
        }
      } else {
        await this.revocation
        port.postMessage({
          type: this.revocationSucceeded ? 'SESSION_REVOKED_ACK' : 'SESSION_REVOKED_FAILED',
          requestId: input.requestId,
          sessionScope: input.sessionScope,
        })
      }
      return
    }
    if (this.stopped) {
      return
    }
    // One departing page cannot surrender its siblings' socket.
    if (input.type === 'RELEASE_OWNER') {
      return
    }
    if (input.type === 'SET_COLLABORATION_SAVER') {
      client.savers.set(input.room, input.canSave)
      await this.publishSaver(input.room)
      return
    }
    if (input.type === 'KEEP_SOCKET_READY') {
      client.readiness = input.clientRequestId
      await this.updateReadiness()
      return
    }
    if (input.type === 'RELEASE_SOCKET_READY') {
      if (client.readiness === input.clientRequestId) {
        client.readiness = undefined
      }
      await this.updateReadiness()
      return
    }
    if (input.type === 'SUBSCRIBE_INVITE_EVENTS') {
      client.invite = input
      if (!this.inviteActive) {
        this.inviteActive = true
        await this.runtime.handle({ ...input, clientRequestId: this.inviteId })
      } else {
        if (this.inviteReady) {
          port.postMessage({ ...this.inviteReady, clientRequestId: input.clientRequestId })
        }
        if (this.inviteBatch) {
          this.inviteAcks.add(clientId)
          port.postMessage({ ...this.inviteBatch, clientRequestId: input.clientRequestId })
        } else if (this.inviteReady && input.cursor !== this.inviteReady.cursor) {
          port.postMessage({
            type: 'INVITE_RECONCILE',
            clientRequestId: input.clientRequestId,
            reason: 'BOOTSTRAP_REQUIRED',
            cursor: this.inviteReady.cursor,
          })
        }
      }
      return
    }
    if (input.type === 'UNSUBSCRIBE_INVITE_EVENTS') {
      if (client.invite?.clientRequestId === input.clientRequestId) {
        client.invite = undefined
      }
      this.inviteAcks.delete(clientId)
      await this.finishInviteBatch()
      await this.updateInvites()
      return
    }
    if (input.type === 'ACK_INVITE_EVENTS') {
      if (
        client.invite?.clientRequestId === input.clientRequestId &&
        input.cursor === this.inviteBatch?.batch.nextCursor
      ) {
        this.inviteAcks.delete(clientId)
        await this.finishInviteBatch()
      }
      return
    }
    if (input.type === 'SESSION_REFRESH_TICKET' || input.type === 'SESSION_REFRESH_UNAVAILABLE') {
      if (this.refreshOwners.get(input.refreshId) !== clientId) {
        return
      }
      this.refreshOwners.delete(input.refreshId)
      await this.runtime.handle(input)
      return
    }
    let message: MainToSyncWorkerMessage = input
    if ('clientRequestId' in input) {
      const ticketKey = `${clientId}:${input.clientRequestId}`
      const ticket = this.ticketOwners.get(ticketKey)
      if ((input.type === 'CONNECT' || input.type === 'TICKET_UNAVAILABLE') && ticket?.clientId === clientId) {
        message = { ...input, clientRequestId: ticket.externalId }
        this.ticketOwners.delete(ticketKey)
      } else {
        const existing = client.requests.get(input.clientRequestId)
        if (
          !existing &&
          ![
            'EXECUTE',
            'RECOVER',
            'AUTHORIZE_COLLABORATION',
            'OPEN_RPC',
            'OPEN_FILE_DOWNLOAD',
            'OPEN_FILE_UPLOAD',
          ].includes(input.type)
        ) {
          return
        }
        const internal = existing ?? `${clientId}:${input.clientRequestId}`
        client.requests.set(input.clientRequestId, internal)
        this.owners.set(internal, { clientId, externalId: input.clientRequestId })
        message = { ...input, clientRequestId: internal }
      }
    } else if ('requestId' in input) {
      const internal = `${clientId}:${input.requestId}`
      this.owners.set(internal, { clientId, externalId: input.requestId })
      message = { ...input, requestId: internal }
    }
    if (PRIMARY.has(message.type)) {
      if (
        message.type === 'EXECUTE' &&
        message.body.items.some(
          (item) =>
            typeof item === 'object' && item !== null && client.savers.get((item as { uuid: string }).uuid) === false,
        )
      ) {
        port.postMessage({
          type: 'RECOVERY_REQUIRED',
          clientRequestId: this.owners.get(message.clientRequestId)!.externalId,
        })
        this.forget(message.clientRequestId)
        return
      }
      this.queue.push({ clientId, message })
      await this.pump()
    } else {
      if (message.type === 'OPEN_RPC') {
        this.runtime.registerBrokerRpcOwner?.(message.clientRequestId, clientId)
      }
      await this.runtime.handle(message)
    }
  }

  /** Called after outputs and on a bounded worker timer; FIFO avoids hot-tab starvation. */
  async pump(): Promise<void> {
    if (this.pumping || this.stopped || !this.runtime.isBrokerPrimaryIdle()) {
      return
    }
    this.pumping = true
    try {
      const next = this.queue.shift()
      if (next && this.clients.has(next.clientId)) {
        await this.runtime.handle(next.message)
      }
    } finally {
      this.pumping = false
    }
  }

  publish(message: SyncWorkerToMainMessage): void {
    if (message.type === 'SESSION_REVOKED_ACK') {
      this.revocationSucceeded = true
    }
    if (BROADCAST.has(message.type)) {
      if (message.type === 'STATE' || message.type === 'NEGOTIATED' || message.type === 'SAVE_LANE') {
        this.health.set(message.type, message)
      }
      if (message.type === 'SESSION_NOT_AUTHORIZED') {
        this.stopped = true
      }
      for (const client of this.clients.values()) {
        client.port.postMessage(message)
      }
      return
    }
    if (message.type === 'NEED_SESSION_REFRESH') {
      const first = this.clients.entries().next().value as [string, Client] | undefined
      if (first) {
        this.refreshOwners.set(message.refreshId, first[0])
        first[1].port.postMessage(message)
      }
      return
    }
    if (
      message.type === 'NEED_TICKET' &&
      (message.clientRequestId === this.readyId || message.clientRequestId === this.inviteId)
    ) {
      const target = [...this.clients.entries()].find(([, client]) => {
        return message.clientRequestId === this.readyId ? client.readiness : client.invite
      })
      if (target) {
        const externalId =
          message.clientRequestId === this.readyId ? target[1].readiness! : target[1].invite!.clientRequestId
        this.ticketOwners.set(`${target[0]}:${externalId}`, {
          clientId: target[0],
          externalId: message.clientRequestId,
        })
        target[1].port.postMessage({ ...message, clientRequestId: externalId })
      }
      return
    }
    if ('clientRequestId' in message && message.clientRequestId === this.inviteId) {
      if (message.type === 'INVITE_RECONCILE' || message.type === 'INVITE_ERROR') {
        // The existing runtime waits for a fresh subscribe after reconciliation;
        // the first page to finish resumes it, while every page still processes
        // subsequent batches behind its own reconciliation promise.
        this.inviteActive = false
        this.inviteReady = undefined
        this.inviteBatch = undefined
        this.inviteAcks.clear()
      }
      if (message.type === 'INVITE_READY') {
        this.inviteReady = message
      }
      if (message.type === 'INVITE_BATCH') {
        this.inviteBatch = message
        this.inviteAcks.clear()
        for (const [id, client] of this.clients) {
          if (client.invite) {
            this.inviteAcks.add(id)
          }
        }
      }
      for (const client of this.clients.values()) {
        if (client.invite) {
          client.port.postMessage({ ...message, clientRequestId: client.invite.clientRequestId })
        }
      }
      return
    }
    const id =
      'clientRequestId' in message ? message.clientRequestId : 'requestId' in message ? message.requestId : undefined
    const owner = id === undefined ? undefined : this.owners.get(id)
    if (!owner) {
      return
    }
    const client = this.clients.get(owner.clientId)
    if (!client) {
      return
    }
    if ('clientRequestId' in message) {
      client.port.postMessage({ ...message, clientRequestId: owner.externalId })
    } else if ('requestId' in message) {
      client.port.postMessage({ ...message, requestId: owner.externalId })
    }
    if (message.type === 'RESULT') {
      this.commandOwners.set(message.commandId, id!)
    }
    if (message.type === 'CHECKPOINT_CLEARED' || message.type === 'CHECKPOINT_FAILED') {
      const request = this.commandOwners.get(message.commandId)
      if (request && message.type === 'CHECKPOINT_CLEARED') {
        this.forget(request)
        this.commandOwners.delete(message.commandId)
      }
    }
    if (
      [
        'RECOVERY_EMPTY',
        'RECOVERY_REQUIRED',
        'RECOVERY_DEFERRED',
        'COLLABORATION_RESULT',
        'COLLABORATION_DENIED',
        'COLLABORATION_FALLBACK',
        'RPC_END',
        'RPC_ERROR',
        'FILE_DOWNLOAD_COMPLETE',
        'FILE_DOWNLOAD_ERROR',
        'FILE_UPLOAD_COMPLETE',
        'FILE_UPLOAD_ERROR',
        'CHECKPOINT_CLEARED',
        'CHECKPOINT_FAILED',
        'SESSION_REVOKED_ACK',
        'SESSION_REVOKED_FAILED',
      ].includes(message.type) ||
      message.type === 'HTTP_FALLBACK'
    ) {
      this.forget(id!)
    }
  }

  private forget(id: string): void {
    const owner = this.owners.get(id)
    if (owner) {
      this.clients.get(owner.clientId)?.requests.delete(owner.externalId)
    }
    this.owners.delete(id)
  }

  private async publishSaver(room: string): Promise<void> {
    await this.runtime.handle({
      type: 'SET_COLLABORATION_SAVER',
      room,
      canSave: [...this.clients.values()].some((client) => client.savers.get(room) === true),
    })
  }

  private async updateReadiness(): Promise<void> {
    const needed = [...this.clients.values()].some((client) => client.readiness)
    if (needed === this.readinessActive) {
      return
    }
    this.readinessActive = needed
    await this.runtime.handle(
      needed
        ? { type: 'KEEP_SOCKET_READY', clientRequestId: this.readyId, sessionScope: this.sessionScope! }
        : { type: 'RELEASE_SOCKET_READY', clientRequestId: this.readyId },
    )
  }

  private async finishInviteBatch(): Promise<void> {
    if (!this.inviteBatch || this.inviteAcks.size) {
      return
    }
    const cursor = this.inviteBatch.batch.nextCursor
    this.inviteBatch = undefined
    if (this.inviteReady) {
      this.inviteReady = { ...this.inviteReady, cursor }
    }
    await this.runtime.handle({ type: 'ACK_INVITE_EVENTS', clientRequestId: this.inviteId, cursor })
  }

  private async updateInvites(): Promise<void> {
    if (this.inviteActive && ![...this.clients.values()].some((client) => client.invite)) {
      this.inviteActive = false
      this.inviteReady = undefined
      await this.runtime.handle({ type: 'UNSUBSCRIBE_INVITE_EVENTS', clientRequestId: this.inviteId })
    }
  }

  async detach(clientId: string): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }
    this.clients.delete(clientId)
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].clientId === clientId) {
        this.queue.splice(i, 1)
      }
    }
    this.inviteAcks.delete(clientId)
    await this.runtime.detachBrokerClient(new Set(client.requests.values()), clientId)
    for (const room of client.savers.keys()) {
      await this.publishSaver(room)
    }
    await this.updateReadiness()
    await this.finishInviteBatch()
    await this.updateInvites()
    for (const [id, owner] of this.owners) {
      if (owner.clientId === clientId) {
        this.owners.delete(id)
      }
    }
    for (const [id, owner] of this.ticketOwners) {
      if (owner.clientId === clientId) {
        this.ticketOwners.delete(id)
        if (owner.externalId === this.readyId || owner.externalId === this.inviteId) {
          this.publish({ type: 'NEED_TICKET', clientRequestId: owner.externalId, reconnect: true })
        }
      }
    }
    for (const [id, owner] of this.refreshOwners) {
      if (owner === clientId) {
        this.refreshOwners.delete(id)
        this.publish({ type: 'NEED_SESSION_REFRESH', refreshId: id, sessionScope: this.sessionScope! })
      }
    }
    for (const [id, owner] of this.commandOwners) {
      if (!this.owners.has(owner)) {
        this.commandOwners.delete(id)
      }
    }
  }

  async shutdownIfUnused(): Promise<boolean> {
    if (this.clients.size) {
      return false
    }
    this.stopped = true
    await this.runtime.handle({ type: 'SHUTDOWN' })
    return true
  }

  async expireInactivePorts(): Promise<void> {
    for (const [id, client] of this.clients) {
      if (this.now() - client.lastSeen > 120_000) {
        client.port.postMessage({ type: 'SHUTDOWN_COMPLETE' })
        await this.detach(id)
      }
    }
    await this.pump()
  }

  get hasClients(): boolean {
    return this.clients.size > 0
  }
}

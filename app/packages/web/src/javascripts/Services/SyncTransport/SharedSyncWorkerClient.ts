import type { MainToSyncWorkerMessage, SyncWorkerToMainMessage } from './syncTransportProtocol'
import type { BrokerInbound } from './SharedSyncTransportBroker'

/** Worker-compatible MessagePort adapter. Termination withdraws only this page. */
export class SharedSyncWorkerClient {
  readonly shared = true
  onmessage: ((event: MessageEvent<SyncWorkerToMainMessage>) => void) | null = null
  onerror: (() => void) | null = null
  onexpired: (() => void) | null = null
  private readonly port: MessagePort
  private readonly heartbeat: ReturnType<typeof setInterval>
  private readonly onPageHide: (event: PageTransitionEvent) => void
  private closed = false
  private shutdownRequested = false

  constructor(worker: SharedWorker, sessionScope: string, revision: string) {
    this.port = worker.port
    this.port.onmessage = (event) => {
      if (event.data.type === 'SHUTDOWN_COMPLETE' && !this.shutdownRequested) {
        if (this.onexpired) {
          this.onexpired()
        } else {
          this.onerror?.()
        }
      } else {
        this.onmessage?.(event)
      }
    }
    worker.onerror = () => this.onerror?.()
    this.port.onmessageerror = () => this.onerror?.()
    this.port.start()
    this.send({ type: 'BROKER_ATTACH', sessionScope, revision })
    this.heartbeat = setInterval(() => this.send({ type: 'BROKER_HEARTBEAT' }), 10_000)
    this.onPageHide = (event) => {
      // A cached page still owns its in-flight durability callback. Its port
      // remains attached until explicit teardown or the broker's inactivity bound.
      if (!event.persisted) {
        this.terminate()
      }
    }
    globalThis.addEventListener('pagehide', this.onPageHide)
  }

  private send(message: BrokerInbound): void {
    if (!this.closed) {
      this.port.postMessage(message)
    }
  }

  postMessage(message: MainToSyncWorkerMessage): void {
    if (message.type === 'SHUTDOWN') {
      this.shutdownRequested = true
    }
    this.send(message)
  }

  terminate(): void {
    if (this.closed) {
      return
    }
    this.send({ type: 'BROKER_DETACH' })
    this.closed = true
    clearInterval(this.heartbeat)
    globalThis.removeEventListener('pagehide', this.onPageHide)
    this.port.close()
  }
}

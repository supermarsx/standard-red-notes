import { WebBuildRevision } from '../../Constants/BuildRevision'
import { SharedSyncTransportBroker, type BrokerInbound } from './SharedSyncTransportBroker'
import { SyncTransportWorkerRuntime } from './SyncTransportWorkerRuntime'

// webpack's dedicated emission rule exports this bundle's stable URL to the page.
export default ''

if (typeof document === 'undefined') {
  const scope = self as unknown as SharedWorkerGlobalScope
  const runtime = new SyncTransportWorkerRuntime({ postMessage: (message) => broker.publish(message) })
  const broker = new SharedSyncTransportBroker(runtime, WebBuildRevision)
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const considerClose = () => {
    if (broker.hasClients || closeTimer !== undefined) {
      return
    }
    closeTimer = setTimeout(() => {
      closeTimer = undefined
      void broker.shutdownIfUnused().then((closed) => {
        if (closed) {
          scope.close()
        }
      })
    }, 1_000)
  }
  scope.onconnect = (event) => {
    if (closeTimer !== undefined) {
      clearTimeout(closeTimer)
    }
    closeTimer = undefined
    const port = event.ports[0]
    const clientId = crypto.randomUUID()
    port.onmessage = (message: MessageEvent<BrokerInbound>) => {
      void broker.receive(clientId, port, message.data).finally(considerClose)
    }
    port.start()
  }
  setInterval(() => {
    void broker.expireInactivePorts().finally(considerClose)
  }, 50)
}

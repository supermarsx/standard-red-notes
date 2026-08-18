import { MainToSyncWorkerMessage } from './syncTransportProtocol'
import { SyncTransportWorkerRuntime } from './SyncTransportWorkerRuntime'

const workerScope = self as unknown as DedicatedWorkerGlobalScope
const runtime = new SyncTransportWorkerRuntime({
  postMessage: (message) => workerScope.postMessage(message),
})

workerScope.onmessage = (event: MessageEvent<MainToSyncWorkerMessage>) => {
  void runtime.handle(event.data)
}

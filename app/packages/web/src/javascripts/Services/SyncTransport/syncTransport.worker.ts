import { WebBuildRevision } from '../../Constants/BuildRevision'
import { MainToSyncWorkerMessage, SyncWorkerToMainMessage } from './syncTransportProtocol'
import { SyncTransportWorkerRuntime } from './SyncTransportWorkerRuntime'

const workerScope = self as unknown as DedicatedWorkerGlobalScope

/**
 * *** THE WORKER SAYS WHICH BUILD IT IS. *** This file is the entry of a bundle
 * of its own, and the revision is compiled into it the same way it is compiled
 * into the page's — so the two can be compared, and a worker file left over from
 * another build cannot pass for this one. See `WORKER_BUILD` in the protocol.
 *
 * Said before anything else and without being asked: a worker built before this
 * existed says nothing, and the page reads that silence as "not this build".
 *
 * Only inside a worker. Outside the bundler this module is imported for its
 * constructor by the transport's unit tests, where `self` is a window.
 */
if (typeof document === 'undefined') {
  const announcement: SyncWorkerToMainMessage = { type: 'WORKER_BUILD', revision: WebBuildRevision }
  workerScope.postMessage(announcement)
}
const runtime = new SyncTransportWorkerRuntime({
  postMessage: (message) => workerScope.postMessage(message),
})

workerScope.onmessage = (event: MessageEvent<MainToSyncWorkerMessage>) => {
  void runtime.handle(event.data)
}

import { prepareTextPreview } from './textPreviewContent'
import type { TextPreviewWorkerRequest, TextPreviewWorkerResponse } from './textPreviewWorkerProtocol'

const context = self as unknown as DedicatedWorkerGlobalScope

context.onmessage = (event: MessageEvent<TextPreviewWorkerRequest>): void => {
  const request = event.data
  try {
    if (request.type !== 'prepare') {
      return
    }

    const response: TextPreviewWorkerResponse = {
      type: 'prepared',
      requestId: request.requestId,
      result: prepareTextPreview(request.bytes, request.language),
    }
    context.postMessage(response)
  } catch (error) {
    const response: TextPreviewWorkerResponse = {
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    }
    context.postMessage(response)
  }
}

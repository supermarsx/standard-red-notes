import type { TextPreviewLanguage } from './isFilePreviewable'
import type { PreparedTextPreview } from './textPreviewContent'

export type TextPreviewWorkerRequest = {
  type: 'prepare'
  requestId: number
  bytes: Uint8Array
  language: TextPreviewLanguage
}

export type TextPreviewWorkerResponse =
  | { type: 'prepared'; requestId: number; result: PreparedTextPreview }
  | { type: 'error'; requestId: number; message: string }

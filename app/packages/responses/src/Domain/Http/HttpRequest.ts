import { HttpRequestParams } from './HttpRequestParams'
import { HttpVerb } from './HttpVerb'

export type HttpRequest = {
  url: string
  params?: HttpRequestParams
  rawBytes?: Uint8Array
  verb: HttpVerb
  authentication?: string
  customHeaders?: Record<string, string>[]
  responseType?: XMLHttpRequestResponseType
  external?: boolean
  /** Cancels the underlying fetch, including an in-progress response body. */
  abortSignal?: AbortSignal
  /**
   * Optional wall-clock deadline for a request. Ordinary API calls use the
   * transport default; bounded long-running transfers can opt into a larger
   * deadline without weakening the hung-socket protection globally.
   */
  timeoutMs?: number
}

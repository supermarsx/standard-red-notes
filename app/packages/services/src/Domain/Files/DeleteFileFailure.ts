import { HttpErrorResponse, getErrorMessageFromErrorResponseBody } from '@standardnotes/responses'
import { spaceSeparatedStrings } from '@standardnotes/utils'

/**
 * Why a server-side file delete failed, and — the part that matters — whether
 * the failure is evidence that the stored file is gone.
 *
 * This exists because the client used to collapse every failure into a single
 * prompt that blamed the user ("a file item that was imported from another
 * account") and offered to drop the item locally. That prompt fired on an
 * expired credential, on a refused request, and on a dropped connection alike,
 * inviting the user to orphan a file that was still sitting on the server —
 * with an explanation that, in every one of those cases, was simply untrue.
 *
 * The escape hatch is now offered only when the response actually supports it:
 * the server answered, and its answer was a refusal of THIS delete rather than
 * a transport failure or an authentication problem that a retry would clear.
 */
export type DeleteFileFailureKind = 'network' | 'unauthorized' | 'forbidden' | 'not-found' | 'server-error' | 'refused'

export type DeleteFileFailure = {
  kind: DeleteFileFailureKind
  /** Verbatim from the server when it said anything; a transport description otherwise. */
  serverMessage: string
  /** What the user is told. Never speculates about a cause the response does not support. */
  text: string
  title: string
  /**
   * Whether to offer removing the file item from the account regardless. Only
   * true where the response is evidence that retrying will not help AND that
   * the user is not being asked to abandon a file the server still holds
   * without saying so.
   */
  offerLocalRemoval: boolean
}

const NETWORK_FAILURE_TITLE = 'Could Not Reach Server'
const UNABLE_TO_DELETE_TITLE = 'Unable to Delete'

/**
 * `FetchRequestHandler` reports an offline/timed-out request as a synthesized
 * 500 carrying `networkFailure`, precisely so it can be told apart from a real
 * server-side 500. Read that flag rather than the status.
 */
function isNetworkFailure(response: HttpErrorResponse): boolean {
  return (response.data as { networkFailure?: unknown } | undefined)?.networkFailure === true
}

export function diagnoseDeleteFileFailure(response: HttpErrorResponse): DeleteFileFailure {
  const serverMessage = getErrorMessageFromErrorResponseBody(response.data, 'no reason given')
  // Widened deliberately: `HttpStatusCode` does not enumerate every status a
  // files server can return (404 among them), and narrowing to the enum would
  // make those comparisons a type error rather than a working branch.
  const status: number = response.status

  if (isNetworkFailure(response)) {
    return {
      kind: 'network',
      serverMessage,
      title: NETWORK_FAILURE_TITLE,
      text: spaceSeparatedStrings(
        'This file could not be deleted because the server could not be reached.',
        'The file has not been deleted and is still in your account.',
        'Check your connection and try again.',
      ),
      offerLocalRemoval: false,
    }
  }

  if (status === 401) {
    return {
      kind: 'unauthorized',
      serverMessage,
      title: UNABLE_TO_DELETE_TITLE,
      text: spaceSeparatedStrings(
        'The server rejected the credential used to delete this file, which usually means it expired',
        'before the request completed. The file has not been deleted.',
        `Please try again. (Server said: "${serverMessage}")`,
      ),
      offerLocalRemoval: false,
    }
  }

  if (status === 403) {
    return {
      kind: 'forbidden',
      serverMessage,
      title: UNABLE_TO_DELETE_TITLE,
      text: spaceSeparatedStrings(
        'The server refused to delete this file. The file has not been deleted.',
        `Server said: "${serverMessage}"`,
      ),
      offerLocalRemoval: false,
    }
  }

  if (status === 404) {
    return {
      kind: 'not-found',
      serverMessage,
      title: UNABLE_TO_DELETE_TITLE,
      text: spaceSeparatedStrings(
        'The server has no stored copy of this file, so there is nothing there to delete.',
        'Remove this file item from your account?',
      ),
      offerLocalRemoval: true,
    }
  }

  if (status >= 500) {
    return {
      kind: 'server-error',
      serverMessage,
      title: UNABLE_TO_DELETE_TITLE,
      text: spaceSeparatedStrings(
        'The server ran into an error deleting this file, so it may still be stored there.',
        'The file has not been deleted from your account.',
        `Please try again. (Server said: "${serverMessage}")`,
      ),
      offerLocalRemoval: false,
    }
  }

  return {
    kind: 'refused',
    serverMessage,
    title: UNABLE_TO_DELETE_TITLE,
    text: spaceSeparatedStrings(
      `This file could not be deleted from the server. Server said: "${serverMessage}"`,
      'You can remove the file item from your account anyway, but if the file is still stored on the',
      'server this will leave it there with no way to reach it. If you are not sure, try again first.',
    ),
    offerLocalRemoval: true,
  }
}

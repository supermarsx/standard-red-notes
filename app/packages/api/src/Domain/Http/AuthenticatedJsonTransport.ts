import { HttpRequest } from '@standardnotes/responses'

/** Undefined is permitted only before dispatch, when HTTP can safely carry the request. */
export type AuthenticatedJsonTransport = (
  request: Readonly<HttpRequest>,
  context: { host: string; authentication?: string; applicationVersion: string; snjsVersion: string },
) => Promise<Response | undefined>

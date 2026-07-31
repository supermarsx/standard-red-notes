import { PinnedHttpError, PinnedHttpTransport } from '@standardnotes/domain-core'

import { WebDAVClientInterface, WebDAVUploadDestination } from './WebDAVClientInterface'

/**
 * Standard Red Notes: dependency-light WebDAV client built on Node's built-in
 * https/http modules (raw MKCOL + PUT with Basic auth). See WebDAVClientInterface for
 * the rationale on not pulling in the pure-ESM `webdav` npm package.
 *
 * Uploads to the Nextcloud WebDAV files endpoint:
 *   <url>/remote.php/dav/files/<user>/<folder>/<fileName>
 *
 * The encrypted artifact is the same ciphertext the server already stores; Nextcloud
 * never receives plaintext.
 */
export class HttpsWebDAVClient implements WebDAVClientInterface {
  private readonly REQUEST_TIMEOUT_MS = 15_000

  constructor(private readonly httpTransport: PinnedHttpTransport = new PinnedHttpTransport()) {}

  async putFile(destination: WebDAVUploadDestination, contents: string): Promise<void> {
    // The destination is user-supplied and every request bears Basic auth. The
    // shared transport resolves, validates, and pins each MKCOL/PUT socket while
    // preserving the original Host and HTTPS certificate identity.
    const base = this.buildFilesBaseUrl(destination)

    // Ensure each nested folder segment exists (MKCOL is idempotent enough: an
    // existing collection returns 405, which we treat as success).
    const folderSegments = this.splitPath(destination.folder)
    let currentPath = base
    for (const segment of folderSegments) {
      currentPath = `${currentPath}/${this.encodeSegment(segment)}`
      await this.request('MKCOL', currentPath, destination, undefined, [201, 405, 301, 302])
    }

    const fileUrl = `${currentPath}/${this.encodeSegment(destination.fileName)}`
    await this.request('PUT', fileUrl, destination, contents, [200, 201, 204])
  }

  private buildFilesBaseUrl(destination: WebDAVUploadDestination): string {
    const trimmedUrl = destination.url.replace(/\/+$/, '')

    return `${trimmedUrl}/remote.php/dav/files/${this.encodeSegment(destination.username)}`
  }

  private splitPath(folder: string): string[] {
    return folder
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
  }

  private encodeSegment(segment: string): string {
    return encodeURIComponent(segment)
  }

  private async request(
    method: string,
    targetUrl: string,
    destination: WebDAVUploadDestination,
    body: string | undefined,
    acceptedStatusCodes: number[],
  ): Promise<void> {
    const auth = Buffer.from(`${destination.username}:${destination.appPassword}`).toString('base64')
    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(body))
    }

    const response = await this.httpTransport.request({
      url: targetUrl,
      method,
      headers,
      body,
      timeoutMs: this.REQUEST_TIMEOUT_MS,
      redirect: 'manual',
      maxRedirects: 0,
    })
    await response.discard()
    if (!acceptedStatusCodes.includes(response.status)) {
      throw new PinnedHttpError(`WebDAV ${method} request failed with status ${response.status}.`, 'upstream-status')
    }
  }
}

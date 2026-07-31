import { PinnedHttpError, PinnedHttpTransport } from '@standardnotes/domain-core'

import { WebDAVClientInterface, WebDAVUploadDestination } from './WebDAVClientInterface'

const DEFAULT_UPLOAD_DEADLINE_MS = 60_000

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
  constructor(
    private readonly httpTransport: PinnedHttpTransport = new PinnedHttpTransport(),
    private readonly uploadDeadlineMs: number = DEFAULT_UPLOAD_DEADLINE_MS,
  ) {}

  async putFile(destination: WebDAVUploadDestination, contents: string): Promise<void> {
    const validated = this.validateDestination(destination)
    const lifecycle = this.createUploadLifecycle()

    try {
      // Ensure each nested folder segment exists. 201 means it was created and
      // 405 means it already exists; no redirect is accepted as success.
      let currentPath = validated.filesBaseUrl
      for (const segment of validated.folderSegments) {
        currentPath = this.appendSegment(currentPath, segment)
        await this.request('MKCOL', currentPath, validated, undefined, [201, 405], lifecycle.signal)
      }

      const fileUrl = this.appendSegment(currentPath, validated.fileName)
      await this.request('PUT', fileUrl, validated, contents, [200, 201, 204], lifecycle.signal)
    } catch (error) {
      const safeError = this.safeError(error, lifecycle.signal)
      if (!lifecycle.signal.aborted) {
        lifecycle.controller.abort(safeError)
      }
      throw safeError
    } finally {
      lifecycle.cleanup()
    }
  }

  private validateDestination(destination: WebDAVUploadDestination): ValidatedWebDAVUploadDestination {
    const rawBaseUrl = destination.url.trim()
    let baseUrl: URL
    try {
      baseUrl = new URL(rawBaseUrl)
    } catch {
      throw new WebDAVClientError('Enter a valid Nextcloud base URL.', 'webdav-invalid-url')
    }
    if (baseUrl.protocol !== 'https:') {
      throw new WebDAVClientError('Nextcloud backups require an HTTPS base URL.', 'webdav-https-required')
    }
    if (baseUrl.username !== '' || baseUrl.password !== '') {
      throw new WebDAVClientError('Remove credentials from the Nextcloud base URL.', 'webdav-url-credentials')
    }
    if (baseUrl.search !== '' || baseUrl.hash !== '' || /[?#]/.test(rawBaseUrl)) {
      throw new WebDAVClientError('Remove the query and fragment from the Nextcloud base URL.', 'webdav-url-components')
    }
    if (destination.appPassword.trim() === '') {
      throw new WebDAVClientError('Enter a dedicated Nextcloud app password.', 'webdav-app-password-required')
    }

    const username = this.validateSegment(destination.username, 'username', false)
    if (username.includes(':')) {
      throw new WebDAVClientError('The Nextcloud username cannot contain a colon.', 'webdav-invalid-username')
    }
    const folder = destination.folder.trim()
    const folderSegments =
      folder === '' ? [] : folder.split('/').map((segment) => this.validateSegment(segment, 'folder', true))
    const fileName = this.validateSegment(destination.fileName, 'file name', false)

    // Canonicalize once. Every later URL is derived from this immutable URL,
    // preventing URL-parser reinterpretation between authenticated requests.
    baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '') || '/'
    const filesBaseUrl = ['remote.php', 'dav', 'files', username].reduce(
      (url, segment) => this.appendSegment(url, segment),
      baseUrl,
    )

    return {
      filesBaseUrl,
      username,
      appPassword: destination.appPassword,
      folderSegments,
      fileName,
    }
  }

  private validateSegment(value: string, field: 'username' | 'folder' | 'file name', allowSpaces: boolean): string {
    const normalized = value.trim()
    if (
      normalized === '' ||
      normalized === '.' ||
      normalized === '..' ||
      normalized.includes('/') ||
      normalized.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(normalized) ||
      (!allowSpaces && /\s/.test(normalized))
    ) {
      throw new WebDAVClientError(`Enter a safe Nextcloud ${field}.`, `webdav-invalid-${field.replace(' ', '-')}`)
    }
    return normalized
  }

  private appendSegment(baseUrl: URL, segment: string): URL {
    const url = new URL(baseUrl.toString())
    const prefix = url.pathname.replace(/\/+$/, '')
    url.pathname = `${prefix}/${encodeURIComponent(segment)}`
    return url
  }

  private async request(
    method: string,
    targetUrl: URL,
    destination: Pick<ValidatedWebDAVUploadDestination, 'username' | 'appPassword'>,
    body: string | undefined,
    acceptedStatusCodes: number[],
    signal: AbortSignal,
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
      url: targetUrl.toString(),
      method,
      headers,
      body,
      signal,
      redirect: 'error',
      maxRedirects: 0,
    })
    await response.discard()
    if (!acceptedStatusCodes.includes(response.status)) {
      throw new WebDAVClientError(
        `Nextcloud rejected the WebDAV ${method} request (HTTP ${response.status}).`,
        'webdav-upstream-status',
      )
    }
  }

  private createUploadLifecycle(): {
    controller: AbortController
    signal: AbortSignal
    cleanup: () => void
  } {
    const controller = new AbortController()
    const timeoutMs =
      Number.isFinite(this.uploadDeadlineMs) && this.uploadDeadlineMs > 0
        ? this.uploadDeadlineMs
        : DEFAULT_UPLOAD_DEADLINE_MS
    const timer = setTimeout(() => {
      controller.abort(new WebDAVClientError('The WebDAV upload exceeded its total deadline.', 'webdav-timeout'))
    }, timeoutMs)

    return {
      controller,
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    }
  }

  private safeError(error: unknown, signal: AbortSignal): WebDAVClientError {
    if (signal.aborted && signal.reason instanceof WebDAVClientError) {
      return signal.reason
    }
    if (error instanceof WebDAVClientError) {
      return error
    }
    if (error instanceof PinnedHttpError && error.tag === 'redirect-not-allowed') {
      return new WebDAVClientError(
        'Nextcloud redirected the WebDAV request. Configure the final HTTPS base URL.',
        'webdav-redirect-rejected',
      )
    }
    if (error instanceof PinnedHttpError && error.tag === 'request-timeout') {
      return new WebDAVClientError('The WebDAV upload exceeded its total deadline.', 'webdav-timeout')
    }

    return new WebDAVClientError(
      'The WebDAV upload could not reach the approved Nextcloud destination.',
      'webdav-transport-failure',
    )
  }
}

interface ValidatedWebDAVUploadDestination {
  filesBaseUrl: URL
  username: string
  appPassword: string
  folderSegments: string[]
  fileName: string
}

export class WebDAVClientError extends Error {
  constructor(
    message: string,
    readonly tag: string,
  ) {
    super(message)
    this.name = 'WebDAVClientError'
  }
}

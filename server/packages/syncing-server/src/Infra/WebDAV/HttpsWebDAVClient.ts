import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'

import { assertPublicHttpUrl } from '@standardnotes/domain-core'

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
  async putFile(destination: WebDAVUploadDestination, contents: string): Promise<void> {
    // SSRF guard: the destination URL is user-supplied (NEXTCLOUD_BACKUP_URL) and
    // we send it a Basic-auth-bearing request, so reject any host that resolves
    // to a private / loopback / link-local / cloud-metadata address BEFORE any
    // MKCOL/PUT. Throwing here is caught + logged by WebDAVItemBackupService.
    await assertPublicHttpUrl(destination.url)

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

  private request(
    method: string,
    targetUrl: string,
    destination: WebDAVUploadDestination,
    body: string | undefined,
    acceptedStatusCodes: number[],
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let parsed: URL
      try {
        parsed = new URL(targetUrl)
      } catch (error) {
        reject(new Error(`Invalid Nextcloud WebDAV URL: ${(error as Error).message}`))

        return
      }

      const transport = parsed.protocol === 'http:' ? http : https
      const auth = Buffer.from(`${destination.username}:${destination.appPassword}`).toString('base64')

      const headers: Record<string, string> = {
        Authorization: `Basic ${auth}`,
      }
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = String(Buffer.byteLength(body))
      }

      const req = transport.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: `${parsed.pathname}${parsed.search}`,
          method,
          headers,
        },
        (res) => {
          // Drain the response so the socket can be reused/closed.
          res.on('data', () => undefined)
          res.on('end', () => {
            const statusCode = res.statusCode ?? 0
            if (acceptedStatusCodes.includes(statusCode)) {
              resolve()
            } else {
              reject(new Error(`WebDAV ${method} ${targetUrl} failed with status ${statusCode}`))
            }
          })
        },
      )

      req.on('error', (error) => {
        reject(error)
      })

      if (body !== undefined) {
        req.write(body)
      }

      req.end()
    })
  }
}

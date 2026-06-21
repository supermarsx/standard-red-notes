/**
 * Standard Red Notes: minimal WebDAV surface needed to upload an encrypted backup
 * artifact to a Nextcloud instance. Kept tiny and injectable so the uploader can be
 * unit-tested with a mock (asserting path/filename and error-swallowing) without any
 * network access.
 *
 * NOTE ON LIBRARY CHOICE: the `webdav` npm package (v5) is published as a pure-ESM
 * module ("type": "module") with ~14 transitive deps. This server is compiled to
 * CommonJS and tested with ts-jest/babel-jest under CommonJS, where a pure-ESM
 * dependency cannot be require()'d (it would force dynamic import() and breaks the
 * CJS jest transform), and adding it would bloat the strict Yarn PnP install. Per the
 * task's allowance to "fall back to raw HTTPS PUT + Basic auth", the default
 * implementation (HttpsWebDAVClient) uses Node's built-in `https` module: a Nextcloud
 * WebDAV upload is simply MKCOL (ensure folder) + PUT (write file) with Basic auth.
 * This abstraction would equally allow swapping in the `webdav` package later.
 */
export interface WebDAVUploadDestination {
  // Base URL of the Nextcloud instance, e.g. https://cloud.example.com
  url: string
  // Nextcloud username (taken from the user's key-params identifier / email).
  username: string
  // App password (NOT the main login password) used for Basic auth.
  appPassword: string
  // Folder under the user's WebDAV files root, e.g. "Backups/StandardNotes".
  folder: string
  // File name to write, e.g. "SN-Data-2026-06-21.json".
  fileName: string
}

export interface WebDAVClientInterface {
  /**
   * Ensure the destination folder exists then PUT the file contents.
   * Implementations MUST throw on failure; callers are responsible for swallowing
   * and logging so a single user's failed upload never crashes the batch job.
   */
  putFile(destination: WebDAVUploadDestination, contents: string): Promise<void>
}

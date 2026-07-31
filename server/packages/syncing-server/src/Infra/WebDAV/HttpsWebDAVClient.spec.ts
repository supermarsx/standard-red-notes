import { PinnedHttpError, PinnedHttpResponse, PinnedHttpTransport } from '@standardnotes/domain-core'

import { HttpsWebDAVClient } from './HttpsWebDAVClient'
import { WebDAVUploadDestination } from './WebDAVClientInterface'

const responseOf = (status: number, discard: () => Promise<void> = async () => undefined): PinnedHttpResponse =>
  ({
    status,
    ok: status >= 200 && status < 300,
    discard: jest.fn(discard),
  }) as unknown as PinnedHttpResponse

describe('HttpsWebDAVClient', () => {
  let transport: jest.Mocked<PinnedHttpTransport>
  const destination: WebDAVUploadDestination = {
    url: 'https://cloud.example/base/',
    username: 'user@example.com',
    appPassword: 'app-password',
    folder: 'Backups/Standard Notes',
    fileName: 'SN-Data.json',
  }

  beforeEach(() => {
    transport = { request: jest.fn() } as unknown as jest.Mocked<PinnedHttpTransport>
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('pins every request under one lifecycle while preserving exact WebDAV success semantics', async () => {
    transport.request
      .mockResolvedValueOnce(responseOf(201))
      .mockResolvedValueOnce(responseOf(405))
      .mockResolvedValueOnce(responseOf(204))

    await new HttpsWebDAVClient(transport).putFile(destination, '{"encrypted":true}')

    expect(transport.request).toHaveBeenCalledTimes(3)
    expect(transport.request.mock.calls.map(([request]) => [request.method, request.url])).toEqual([
      ['MKCOL', 'https://cloud.example/base/remote.php/dav/files/user%40example.com/Backups'],
      ['MKCOL', 'https://cloud.example/base/remote.php/dav/files/user%40example.com/Backups/Standard%20Notes'],
      [
        'PUT',
        'https://cloud.example/base/remote.php/dav/files/user%40example.com/Backups/Standard%20Notes/SN-Data.json',
      ],
    ])
    const requests = transport.request.mock.calls.map(([request]) => request)
    expect(new Set(requests.map((request) => request.signal)).size).toBe(1)
    for (const request of requests) {
      expect(request).toMatchObject({ redirect: 'error', maxRedirects: 0 })
      expect(request.timeoutMs).toBeUndefined()
    }
    const put = requests[2]
    expect(put.body).toBe('{"encrypted":true}')
    expect(put.headers?.Authorization).toBe(`Basic ${Buffer.from('user@example.com:app-password').toString('base64')}`)
    expect(put.headers?.['Content-Length']).toBe(String(Buffer.byteLength('{"encrypted":true}')))
  })

  it.each([200, 201, 204])('accepts PUT status %i', async (status) => {
    transport.request.mockResolvedValueOnce(responseOf(405)).mockResolvedValueOnce(responseOf(status))

    await expect(
      new HttpsWebDAVClient(transport).putFile({ ...destination, folder: 'Backups' }, 'ciphertext'),
    ).resolves.toBeUndefined()
  })

  it.each([201, 405])('accepts MKCOL status %i', async (status) => {
    transport.request.mockResolvedValueOnce(responseOf(status)).mockResolvedValueOnce(responseOf(201))

    await expect(
      new HttpsWebDAVClient(transport).putFile({ ...destination, folder: 'Backups' }, 'ciphertext'),
    ).resolves.toBeUndefined()
  })

  it('rejects redirect responses and never sends credentials to a second request', async () => {
    transport.request.mockResolvedValueOnce(responseOf(301))

    await expect(
      new HttpsWebDAVClient(transport).putFile({ ...destination, folder: 'Backups' }, 'ciphertext'),
    ).rejects.toMatchObject({ tag: 'webdav-upstream-status' })

    expect(transport.request).toHaveBeenCalledTimes(1)
    expect(transport.request.mock.calls[0][0]).toMatchObject({ redirect: 'error', maxRedirects: 0 })
  })

  it('maps a transport-detected redirect to an actionable, secret-free error', async () => {
    transport.request.mockRejectedValueOnce(
      new PinnedHttpError('redirect to https://attacker.example/?secret=app-password', 'redirect-not-allowed'),
    )

    const upload = new HttpsWebDAVClient(transport).putFile(destination, 'ciphertext')

    await expect(upload).rejects.toMatchObject({
      message: 'Nextcloud redirected the WebDAV request. Configure the final HTTPS base URL.',
      tag: 'webdav-redirect-rejected',
    })
    await expect(upload).rejects.not.toThrow(/attacker|app-password/)
    expect(transport.request).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ url: 'http://cloud.example' }, 'webdav-https-required'],
    [{ url: 'https://user:password@cloud.example' }, 'webdav-url-credentials'],
    [{ url: 'https://cloud.example?tenant=one' }, 'webdav-url-components'],
    [{ url: 'https://cloud.example?' }, 'webdav-url-components'],
    [{ url: 'https://cloud.example#fragment' }, 'webdav-url-components'],
    [{ username: '' }, 'webdav-invalid-username'],
    [{ username: '..' }, 'webdav-invalid-username'],
    [{ username: 'nested/user' }, 'webdav-invalid-username'],
    [{ username: 'user:name' }, 'webdav-invalid-username'],
    [{ folder: '/Backups' }, 'webdav-invalid-folder'],
    [{ folder: 'Backups/' }, 'webdav-invalid-folder'],
    [{ folder: 'Backups//Notes' }, 'webdav-invalid-folder'],
    [{ folder: 'Backups/../Notes' }, 'webdav-invalid-folder'],
    [{ fileName: '.' }, 'webdav-invalid-file-name'],
    [{ fileName: 'nested/file.json' }, 'webdav-invalid-file-name'],
    [{ appPassword: '   ' }, 'webdav-app-password-required'],
  ] as Array<[Partial<WebDAVUploadDestination>, string]>)(
    'rejects unsafe destination %# before networking',
    async (input, tag) => {
      await expect(
        new HttpsWebDAVClient(transport).putFile({ ...destination, ...input }, 'ciphertext'),
      ).rejects.toMatchObject({
        tag,
      })
      expect(transport.request).not.toHaveBeenCalled()
    },
  )

  it('preserves an empty folder as the established WebDAV account-root destination', async () => {
    transport.request.mockResolvedValueOnce(responseOf(201))

    await new HttpsWebDAVClient(transport).putFile({ ...destination, folder: '' }, 'ciphertext')

    expect(transport.request).toHaveBeenCalledTimes(1)
    expect(transport.request.mock.calls[0][0]).toMatchObject({
      method: 'PUT',
      url: 'https://cloud.example/base/remote.php/dav/files/user%40example.com/SN-Data.json',
    })
  })

  it('uses one absolute deadline across earlier requests and the final response drain', async () => {
    jest.useFakeTimers()
    let responseSignal: AbortSignal | undefined
    transport.request
      .mockImplementationOnce(async () => {
        jest.advanceTimersByTime(40_000)
        return responseOf(201)
      })
      .mockImplementationOnce(async (request) => {
        responseSignal = request.signal
        return responseOf(
          201,
          () =>
            new Promise<void>((_resolve, reject) => {
              if (request.signal?.aborted) {
                reject(request.signal.reason)
                return
              }
              request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true })
            }),
        )
      })

    const upload = new HttpsWebDAVClient(transport).putFile({ ...destination, folder: 'Backups' }, 'ciphertext')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(transport.request).toHaveBeenCalledTimes(2)
    expect(responseSignal?.aborted).toBe(false)
    jest.advanceTimersByTime(19_999)
    expect(responseSignal?.aborted).toBe(false)
    jest.advanceTimersByTime(1)

    await expect(upload).rejects.toMatchObject({ tag: 'webdav-timeout' })
    expect(responseSignal?.aborted).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('clears the absolute-deadline timer after a successful upload', async () => {
    jest.useFakeTimers()
    transport.request.mockResolvedValueOnce(responseOf(201)).mockResolvedValueOnce(responseOf(204))

    await new HttpsWebDAVClient(transport).putFile({ ...destination, folder: 'Backups' }, 'ciphertext')

    expect(jest.getTimerCount()).toBe(0)
  })

  it('does not retry an ambiguous failed request and sanitizes the transport error', async () => {
    transport.request.mockRejectedValueOnce(
      new Error('request to https://cloud.example failed with password app-password'),
    )

    const upload = new HttpsWebDAVClient(transport).putFile(destination, 'ciphertext')

    await expect(upload).rejects.toMatchObject({
      message: 'The WebDAV upload could not reach the approved Nextcloud destination.',
      tag: 'webdav-transport-failure',
    })
    await expect(upload).rejects.not.toThrow(/cloud\.example|app-password/)
    expect(transport.request).toHaveBeenCalledTimes(1)
  })
})

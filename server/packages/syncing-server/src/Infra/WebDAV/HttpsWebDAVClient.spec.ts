import { PinnedHttpResponse, PinnedHttpTransport } from '@standardnotes/domain-core'

import { HttpsWebDAVClient } from './HttpsWebDAVClient'
import { WebDAVUploadDestination } from './WebDAVClientInterface'

const responseOf = (status: number): PinnedHttpResponse =>
  ({
    status,
    ok: status >= 200 && status < 300,
    discard: jest.fn().mockResolvedValue(undefined),
  }) as unknown as PinnedHttpResponse

describe('HttpsWebDAVClient', () => {
  let transport: jest.Mocked<PinnedHttpTransport>
  const destination: WebDAVUploadDestination = {
    url: 'https://cloud.example/base',
    username: 'user@example.com',
    appPassword: 'app-password',
    folder: 'Backups/Standard Notes',
    fileName: 'SN-Data.json',
  }

  beforeEach(() => {
    transport = { request: jest.fn() } as unknown as jest.Mocked<PinnedHttpTransport>
  })

  it('pins every MKCOL and PUT through the shared transport without changing WebDAV semantics', async () => {
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
    const put = transport.request.mock.calls[2][0]
    expect(put).toMatchObject({
      body: '{"encrypted":true}',
      timeoutMs: 15_000,
      redirect: 'manual',
      maxRedirects: 0,
    })
    expect(put.headers?.Authorization).toBe(`Basic ${Buffer.from('user@example.com:app-password').toString('base64')}`)
    expect(put.headers?.['Content-Length']).toBe(String(Buffer.byteLength('{"encrypted":true}')))
  })

  it('keeps the existing accepted redirect status for idempotent MKCOL without following it', async () => {
    transport.request.mockResolvedValueOnce(responseOf(301)).mockResolvedValueOnce(responseOf(201))

    await expect(
      new HttpsWebDAVClient(transport).putFile({ ...destination, folder: 'Backups' }, 'ciphertext'),
    ).resolves.toBeUndefined()

    expect(transport.request.mock.calls[0][0]).toMatchObject({ redirect: 'manual', maxRedirects: 0 })
  })

  it('throws a stable transport error when WebDAV returns an unaccepted status', async () => {
    transport.request.mockResolvedValue(responseOf(403))

    await expect(
      new HttpsWebDAVClient(transport).putFile({ ...destination, folder: '' }, 'ciphertext'),
    ).rejects.toMatchObject({ tag: 'upstream-status' })
  })

  it('does not make later requests after the shared transport rejects a pinned destination', async () => {
    transport.request.mockRejectedValueOnce(new Error('blocked destination'))

    await expect(new HttpsWebDAVClient(transport).putFile(destination, 'ciphertext')).rejects.toThrow(
      'blocked destination',
    )
    expect(transport.request).toHaveBeenCalledTimes(1)
  })
})

import { WebService, WebFetchLike } from './WebService'

describe('bounded public PDF download', () => {
  function setup(bytes: Uint8Array, maxFetchBytes = 100) {
    const cancel = jest.fn()
    let sent = false
    const fetch = jest.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => 'application/pdf' },
      text: async () => '',
      body: {
        getReader: () => ({
          read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
          cancel,
        }),
      },
    }))
    return {
      fetch,
      cancel,
      service: new WebService(fetch as WebFetchLike, { maxFetchBytes }, async () => ['93.184.216.34']),
    }
  }
  it('preserves non-UTF8 binary bytes', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 255, 128, 0])
    const { service } = setup(bytes)
    expect((await service.fetchBytes('https://example.test/paper.pdf')).bytes).toEqual(Buffer.from(bytes))
  })
  it('rejects private destinations before downloading', async () => {
    const { service, fetch } = setup(new Uint8Array())
    await expect(service.fetchBytes('http://127.0.0.1/paper.pdf')).rejects.toMatchObject({ tag: 'blocked-host' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('cancels an oversized stream', async () => {
    const { service, cancel } = setup(new Uint8Array(101))
    await expect(service.fetchBytes('https://example.test/paper.pdf')).rejects.toMatchObject({
      tag: 'response-too-large',
    })
    expect(cancel).toHaveBeenCalled()
  })
})

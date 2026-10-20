import 'reflect-metadata'
import { Request } from 'express'
import { storageUsageSignature } from '@standardnotes/domain-core'
import { AnnotatedStorageUsageController } from './AnnotatedStorageUsageController'
import { FileStorageUsage } from '../../Domain/Services/FileStorageUsage'

describe('internal File storage usage authorization', () => {
  const secret = 'test-authority-secret'
  const scope = {
    userUuid: '00000000-0000-4000-8000-000000000001',
    vaultUuids: ['00000000-0000-4000-8000-000000000002'],
  }
  const now = 1_800_000_000_000
  const request = (body = scope, timestamp = String(now), signature = storageUsageSignature(secret, timestamp, body)) =>
    ({ body, headers: { 'x-storage-timestamp': timestamp, 'x-storage-signature': signature } }) as unknown as Request
  let measure: jest.Mock
  let controller: AnnotatedStorageUsageController

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now)
    measure = jest.fn().mockResolvedValue({ bytes: 36, count: 3, complete: true })
    controller = new AnnotatedStorageUsageController({ secret, measure } as unknown as FileStorageUsage)
  })
  afterEach(() => jest.restoreAllMocks())

  it('returns measured bytes for the exact scope authenticated by the authority signature', async () => {
    const result = await controller.measure(request())
    expect((await result.executeAsync()).statusCode).toBe(200)
    expect(result.json).toEqual({ bytes: 36, count: 3, complete: true })
    expect(measure).toHaveBeenCalledWith(scope)
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it.each(['missing', 'tampered-scope', 'wrong-signature', 'expired', 'future', 'invalid-scope'])(
    'rejects %s authentication before reading storage',
    async (reason) => {
      let candidate = request()
      if (reason === 'missing') {
        candidate = { body: scope, headers: {} } as Request
      }
      if (reason === 'tampered-scope') {
        candidate.body = { ...scope, vaultUuids: [] }
      }
      if (reason === 'wrong-signature') {
        candidate.headers['x-storage-signature'] = '0'.repeat(64)
      }
      if (reason === 'expired') {
        candidate = request(scope, String(now - 30_001))
      }
      if (reason === 'future') {
        candidate = request(scope, String(now + 30_001))
      }
      if (reason === 'invalid-scope') {
        candidate = request({ ...scope, userUuid: 'invalid' })
      }
      const result = await controller.measure(candidate)
      expect((await result.executeAsync()).statusCode).toBe(403)
      expect(result.json).toEqual({ error: 'Not authorized' })
      expect(measure).not.toHaveBeenCalled()
    },
  )

  it('fails closed without a configured authority secret', async () => {
    const unavailable = new AnnotatedStorageUsageController({ secret: '', measure } as unknown as FileStorageUsage)
    const result = await unavailable.measure(request())
    expect((await result.executeAsync()).statusCode).toBe(403)
    expect(measure).not.toHaveBeenCalled()
  })

  it('reports authority failure without leaking its detail or inventing a complete total', async () => {
    measure.mockRejectedValue(new Error('private storage details'))
    const result = await controller.measure(request())
    expect((await result.executeAsync()).statusCode).toBe(503)
    expect(result.json).toEqual({ error: 'File usage unavailable' })
  })
})

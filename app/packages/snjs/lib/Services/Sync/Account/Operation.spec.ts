import { RawSyncResponse } from '@standardnotes/responses'
import { AccountSyncOperation, AccountSyncPaginationGuardError, AccountSyncPaginationMetric } from './Operation'
import { SyncSignal } from '../Signals'

/**
 * Standard Red Notes RELIABILITY regression: AccountSyncOperation must NOT swallow
 * a receiver (response-handling) error and keep paginating.
 *
 * Background: each page's receiver persists that page's retrieved payloads AND, on
 * success, advances the PERSISTED sync token (SyncService.handleSuccessServerResponse).
 * Only the persisted token gates what a future sync re-pulls. The old code caught a
 * receiver throw, logged it, and CONTINUED to the next page. A later page's success
 * could then advance the persisted token PAST the items the failed page never
 * persisted — a silent drop with no way to re-pull.
 *
 * Fix: the operation propagates the receiver error and stops paginating. The caller
 * (SyncService.performSync) treats it as a failed sync and lets the failure-backoff
 * retry re-pull from the un-advanced persisted token.
 */

const rawResponse = (paginationToken?: string): { status: number; data: RawSyncResponse } => ({
  status: 200,
  data: {
    retrieved_items: [],
    saved_items: [],
    conflicts: [],
    sync_token: 'tok',
    cursor_token: paginationToken,
  } as unknown as RawSyncResponse,
})

describe('AccountSyncOperation receiver-error handling', () => {
  it('propagates a receiver error instead of swallowing it', async () => {
    const apiService = {
      sync: jest.fn().mockResolvedValue(rawResponse(undefined)),
    }

    const boom = new Error('persist failed')
    const receiver = jest.fn(async (type: SyncSignal) => {
      if (type === SyncSignal.Response) {
        throw boom
      }
    })

    const operation = new AccountSyncOperation([], receiver as never, apiService as never, {})

    await expect(operation.run()).rejects.toBe(boom)
  })

  it('does NOT request the next page after a receiver error (no token-advancing drop)', async () => {
    // Server indicates MORE pages via a cursor token; if the operation kept
    // paginating after the first page's receiver threw, sync() would be called twice.
    const apiService = {
      sync: jest.fn().mockResolvedValue(rawResponse('more-pages-cursor')),
    }

    const receiver = jest.fn(async (type: SyncSignal) => {
      if (type === SyncSignal.Response) {
        throw new Error('persist failed on page 1')
      }
    })

    const operation = new AccountSyncOperation([], receiver as never, apiService as never, {})

    await expect(operation.run()).rejects.toThrow('persist failed on page 1')
    // Exactly ONE network call: pagination must stop at the failed page.
    expect(apiService.sync).toHaveBeenCalledTimes(1)
  })

  it('still paginates normally when the receiver succeeds', async () => {
    let call = 0
    const apiService = {
      // First page returns a cursor (more pages), second page returns none (done).
      sync: jest.fn(async () => {
        call += 1
        return rawResponse(call === 1 ? 'cursor' : undefined)
      }),
    }
    const receiver = jest.fn(async () => undefined)

    const operation = new AccountSyncOperation([], receiver as never, apiService as never, {})

    await expect(operation.run()).resolves.toBeUndefined()
    expect(apiService.sync).toHaveBeenCalledTimes(2)
  })
})

describe('AccountSyncOperation transport durability seam', () => {
  it('applies recovered A and its checkpoint before constructing fresh B with the post-A token', async () => {
    const ordering: string[] = []
    let persistedToken = 'before-a'
    const requestA = {
      api: '20240226',
      items: [{ uuid: 'a' }],
      sync_token: 'before-a',
      limit: 150,
    }
    const transport = {
      recoverPending: jest
        .fn()
        .mockResolvedValueOnce({
          request: requestA,
          response: rawResponse(),
          markCheckpointDurable: async () => {
            ordering.push('checkpoint-a')
          },
        })
        .mockResolvedValueOnce(undefined),
      execute: jest.fn(async () => {
        ordering.push('execute-b')
        return { response: rawResponse() }
      }),
    }
    let recoveryOperation: AccountSyncOperation
    recoveryOperation = new AccountSyncOperation(
      [],
      (async (type: SyncSignal, response) => {
        if (type === SyncSignal.Response && response) {
          ordering.push('apply-a')
          persistedToken = response.lastSyncToken as string
          expect(recoveryOperation.payloads).toEqual(requestA.items)
          expect(recoveryOperation.payloadsSavedOrSaving).toEqual(requestA.items)
        }
      }) as never,
      { apiVersion: '20240226' } as never,
      { transport },
    )

    await expect(recoveryOperation.recoverPending()).resolves.toEqual({ recoveredCount: 1, hasError: false })

    const operationB = new AccountSyncOperation(
      [{ uuid: 'b' }] as never,
      jest.fn(async () => undefined) as never,
      { apiVersion: '20240226' } as never,
      { transport, syncToken: persistedToken },
    )
    await operationB.run()

    expect(ordering).toEqual(['apply-a', 'checkpoint-a', 'execute-b'])
    expect(transport.execute).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ uuid: 'b' }], sync_token: 'tok' }),
      expect.any(Function),
    )
  })

  it('uses the optional transport and clears its outbox only after the local response checkpoint', async () => {
    let locallyDurable = false
    const markCheckpointDurable = jest.fn(async () => {
      expect(locallyDurable).toBe(true)
    })
    const transport = {
      execute: jest.fn(async () => ({ response: rawResponse(), markCheckpointDurable })),
    }
    const apiService = { apiVersion: '20240226', sync: jest.fn() }
    const receiver = jest.fn(async (type: SyncSignal) => {
      if (type === SyncSignal.Response) {
        locallyDurable = true
      }
    })
    const operation = new AccountSyncOperation([], receiver as never, apiService as never, { transport })

    await operation.run()

    expect(transport.execute).toHaveBeenCalledWith({ api: '20240226', items: [], limit: 150 }, expect.any(Function))
    expect(markCheckpointDurable).toHaveBeenCalledTimes(1)
    expect(apiService.sync).not.toHaveBeenCalled()
  })

  it('retains the transport outbox when local response persistence fails', async () => {
    const markCheckpointDurable = jest.fn()
    const transport = {
      execute: jest.fn(async () => ({ response: rawResponse(), markCheckpointDurable })),
    }
    const persistenceError = new Error('local checkpoint failed')
    const receiver = jest.fn(async (type: SyncSignal) => {
      if (type === SyncSignal.Response) {
        throw persistenceError
      }
    })
    const operation = new AccountSyncOperation([], receiver as never, { apiVersion: '20240226' } as never, {
      transport,
    })

    await expect(operation.run()).rejects.toBe(persistenceError)
    expect(markCheckpointDurable).not.toHaveBeenCalled()
  })
})

describe('AccountSyncOperation pagination circuit breakers', () => {
  it('stops on a repeated cursor without exposing the cursor through metrics or the error', async () => {
    const metrics: AccountSyncPaginationMetric[] = []
    const apiService = {
      sync: jest.fn().mockResolvedValue(rawResponse('sensitive-cursor')),
    }
    const receiver = jest.fn(async () => undefined)
    const operation = new AccountSyncOperation([], receiver as never, apiService as never, {
      onPaginationMetric: (metric) => metrics.push(metric),
    })

    await expect(operation.run()).rejects.toMatchObject<AccountSyncPaginationGuardError>({
      reason: 'repeated-cursor',
      controlledSyncFailure: true,
    })
    expect(apiService.sync).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(metrics)).not.toContain('sensitive-cursor')
    expect(metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'page', page: 2, guardReason: 'repeated-cursor' })]),
    )
  })

  it('allows a normal changing-cursor backlog to finish', async () => {
    const cursors = ['cursor-a', 'cursor-b', 'cursor-c', undefined]
    const apiService = {
      sync: jest.fn(async () => rawResponse(cursors.shift())),
    }
    const operation = new AccountSyncOperation([], jest.fn(async () => undefined) as never, apiService as never, {})

    await expect(operation.run()).resolves.toBeUndefined()
    expect(apiService.sync).toHaveBeenCalledTimes(4)
  })

  it('stops before requesting beyond a configured maximum page count', async () => {
    let page = 0
    const apiService = {
      sync: jest.fn(async () => rawResponse(`cursor-${++page}`)),
    }
    const operation = new AccountSyncOperation([], jest.fn(async () => undefined) as never, apiService as never, {
      paginationGuard: { maxPages: 2 },
    })

    await expect(operation.run()).rejects.toMatchObject({ reason: 'maximum-pages', pages: 2 })
    expect(apiService.sync).toHaveBeenCalledTimes(2)
  })

  it('stops after safely applying a page that crosses the configured response-byte budget', async () => {
    const apiService = {
      sync: jest.fn().mockResolvedValue(rawResponse('next-page')),
    }
    const receiver = jest.fn(async () => undefined)
    const operation = new AccountSyncOperation([], receiver as never, apiService as never, {
      paginationGuard: { maxResponseBytes: 1 },
    })

    await expect(operation.run()).rejects.toMatchObject({ reason: 'maximum-response-bytes', pages: 1 })
    expect(apiService.sync).toHaveBeenCalledTimes(1)
    expect(receiver).toHaveBeenCalledWith(SyncSignal.Response, expect.anything())
  })

  it('stops when a continuing operation crosses its configured elapsed-time budget', async () => {
    let clock = 0
    const apiService = {
      sync: jest.fn().mockResolvedValue(rawResponse('next-page')),
    }
    const receiver = jest.fn(async (type: SyncSignal) => {
      if (type === SyncSignal.Response) {
        clock = 200
      }
    })
    const operation = new AccountSyncOperation([], receiver as never, apiService as never, {
      paginationGuard: { maxElapsedMs: 100, now: () => clock },
    })

    await expect(operation.run()).rejects.toMatchObject({ reason: 'maximum-elapsed-time', pages: 1 })
    expect(apiService.sync).toHaveBeenCalledTimes(1)
  })
})

/**
 * DATA-LOSS regression: a paginated UPLOAD that fails on batch 1 must NOT proceed
 * to batch 2. popPayloads() removes each batch before its request; on a RETURNED
 * error response the failed batch's items stay pending (dirty preserved). The
 * upload must stop on the first failed batch so those items re-upload cleanly next
 * sync, instead of advancing to a later batch against a now-stale syncToken (which
 * can let a later batch commit while the earlier one is clobbered on re-pull).
 */
describe('AccountSyncOperation paginated-upload error handling', () => {
  const errorResponse = (): { status: number; data: unknown } => ({
    // status >= 400 => isErrorResponse => ServerSyncResponse.hasError === true
    status: 500,
    data: { error: { message: 'server unavailable' } },
  })

  const makeUploadPayloads = (count: number) => Array.from({ length: count }, (_, i) => ({ uuid: `u${i}` })) as never[]

  it('does NOT proceed to batch 2 after batch 1 returns an error response, and preserves dirty items', async () => {
    // 200 dirty items => two upload batches (150 + 50).
    const payloads = makeUploadPayloads(200)

    const apiService = {
      sync: jest.fn().mockResolvedValue(errorResponse()),
    }
    const receiver = jest.fn(async () => undefined)

    const operation = new AccountSyncOperation(payloads, receiver as never, apiService as never, {})

    await expect(operation.run()).resolves.toBeUndefined()

    // Exactly ONE network call: pagination stops at the failed batch.
    expect(apiService.sync).toHaveBeenCalledTimes(1)

    // The not-yet-uploaded batch (the 50 remaining) plus the failed batch's items
    // were never marked saved: payloadsSavedOrSaving excludes the still-pending
    // remainder, proving the second batch was never sent.
    expect(operation.payloadsSavedOrSaving.length).toBe(150)
  })

  it('still completes a multi-batch upload when every batch succeeds', async () => {
    const payloads = makeUploadPayloads(200)

    let call = 0
    const apiService = {
      sync: jest.fn(async () => {
        call += 1
        // success on every batch; no pagination token => done once pending empties
        return { status: 200, data: { saved_items: [], retrieved_items: [], conflicts: [] } }
      }),
    }
    const receiver = jest.fn(async () => undefined)

    const operation = new AccountSyncOperation(payloads, receiver as never, apiService as never, {})

    await expect(operation.run()).resolves.toBeUndefined()

    // 150 + 50 => two upload batches, both sent because none errored.
    expect(apiService.sync).toHaveBeenCalledTimes(2)
    expect(call).toBe(2)
  })
})

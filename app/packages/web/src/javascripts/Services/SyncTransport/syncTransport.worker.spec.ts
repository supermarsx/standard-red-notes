/** @jest-environment node */
import type { MainToSyncWorkerMessage, SyncWorkerToMainMessage } from './syncTransportProtocol'

const mockHandle = jest.fn()
let mockPostToMain: ((message: SyncWorkerToMainMessage) => void) | undefined
jest.mock('./SyncTransportWorkerRuntime', () => ({
  SyncTransportWorkerRuntime: jest.fn().mockImplementation((options: { postMessage: typeof mockPostToMain }) => {
    mockPostToMain = options.postMessage
    return { handle: mockHandle }
  }),
}))

describe('sync worker entry point', () => {
  it('announces its build before work, routes requests to the runtime and returns runtime messages', async () => {
    const postMessage = jest.fn()
    const scope = {
      postMessage,
      onmessage: undefined as ((event: MessageEvent<MainToSyncWorkerMessage>) => void) | undefined,
    }
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'self')
    Object.defineProperty(globalThis, 'self', { configurable: true, value: scope })
    try {
      mockHandle.mockResolvedValue(undefined)
      // The constructor's mock is created after Jest resets mocks for this test.
      jest.isolateModules(() => {
        require('./syncTransport.worker')
      })
      expect(postMessage).toHaveBeenCalledTimes(1)
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'WORKER_BUILD', revision: expect.any(String) }),
      )
      expect(scope.onmessage).toEqual(expect.any(Function))
      const request: MainToSyncWorkerMessage = { type: 'SET_COLLABORATION_SAVER', room: 'room', canSave: false }
      scope.onmessage?.({ data: request } as MessageEvent<MainToSyncWorkerMessage>)
      expect(mockHandle).toHaveBeenCalledWith(request)
      const response: SyncWorkerToMainMessage = {
        type: 'SAVE_LANE',
        held: true,
        code: 'NOT_AUTHORIZED',
        holdForMilliseconds: 30_000,
      }
      mockPostToMain?.(response)
      expect(postMessage).toHaveBeenLastCalledWith(response)
      await Promise.resolve()
    } finally {
      if (previous) {
        Object.defineProperty(globalThis, 'self', previous)
      } else {
        Reflect.deleteProperty(globalThis, 'self')
      }
    }
  })
})

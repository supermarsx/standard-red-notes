/// <reference types="jest" />

import AsyncStorage from '@react-native-async-storage/async-storage'
import { TransferPayload } from '@standardnotes/snjs'
import { createMMKV } from 'react-native-mmkv'
import { Database } from './Database'

const mockAsyncStorageValues = new Map<string, string>()
const mockFlashStorageValues = new Map<string, Map<string, string>>()
const mockFlashClearAll = new Map<string, jest.Mock>()
const mockEraseEvents: string[] = []

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getAllKeys: jest.fn(),
    getItem: jest.fn(),
    getMany: jest.fn(),
    removeMany: jest.fn(),
    setItem: jest.fn(),
  },
}))

jest.mock('@standardnotes/snjs', () => ({
  GetSortedPayloadsByPriority: jest.fn(),
  isNotUndefined: (value: unknown) => value !== undefined,
}))

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}))

jest.mock('react-native-mmkv', () => ({
  createMMKV: jest.fn(),
}))

const payload = (uuid: string): TransferPayload =>
  ({
    uuid,
    content_type: 'Note',
    content: { title: uuid },
    created_at: new Date(0),
    updated_at: new Date(0),
  }) as unknown as TransferPayload

describe('mobile database data erasure', () => {
  beforeEach(() => {
    mockAsyncStorageValues.clear()
    mockFlashStorageValues.clear()
    mockFlashClearAll.clear()
    mockEraseEvents.length = 0

    jest.mocked(AsyncStorage.getAllKeys).mockImplementation(async () => Array.from(mockAsyncStorageValues.keys()))
    jest.mocked(AsyncStorage.getItem).mockImplementation(async (key) => mockAsyncStorageValues.get(key) ?? null)
    jest.mocked(AsyncStorage.getMany).mockImplementation(async (keys) => {
      return Object.fromEntries(keys.map((key) => [key, mockAsyncStorageValues.get(key) ?? null]))
    })
    jest.mocked(AsyncStorage.removeMany).mockImplementation(async (keys) => {
      mockEraseEvents.push('payloads')
      for (const key of keys) {
        mockAsyncStorageValues.delete(key)
      }
    })
    jest.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
      mockAsyncStorageValues.set(key, value)
    })

    jest.mocked(createMMKV).mockImplementation((configuration) => {
      const id = configuration?.id ?? 'default'
      const values = new Map<string, string>()
      const clearAll = jest.fn(() => {
        mockEraseEvents.push(`metadata:${id}`)
        values.clear()
      })
      mockFlashStorageValues.set(id, values)
      mockFlashClearAll.set(id, clearAll)

      return {
        clearAll,
        getAllKeys: () => Array.from(values.keys()),
        getString: (key: string) => values.get(key),
        remove: (key: string) => values.delete(key),
        set: (key: string, value: string) => values.set(key, value),
      } as unknown as ReturnType<typeof createMMKV>
    })
  })

  it.each(['workspace-a', 'standardnotes'])('erases AsyncStorage payloads and MMKV metadata for %s', async (id) => {
    const database = new Database(id)
    const otherDatabase = new Database('workspace-other')
    await database.setItems([payload('target-note')])
    await otherDatabase.setItems([payload('other-note')])

    await database.deleteAll()

    const targetPrefix = id === 'standardnotes' ? 'Item-' : `${id}-Item-`
    expect(Array.from(mockAsyncStorageValues.keys())).not.toContain(`${targetPrefix}target-note`)
    expect(mockFlashStorageValues.get(id)?.size).toBe(0)
    expect(mockAsyncStorageValues.has('workspace-other-Item-other-note')).toBe(true)
    expect(mockFlashStorageValues.get('workspace-other')?.size).toBe(1)
  })

  it('waits for payload deletion before clearing metadata', async () => {
    mockAsyncStorageValues.set('workspace-a-Item-note', JSON.stringify(payload('note')))
    let finishPayloadDeletion: (() => void) | undefined
    jest.mocked(AsyncStorage.removeMany).mockImplementationOnce(
      (keys) =>
        new Promise<void>((resolve) => {
          mockEraseEvents.push('payloads-started')
          finishPayloadDeletion = () => {
            for (const key of keys) {
              mockAsyncStorageValues.delete(key)
            }
            mockEraseEvents.push('payloads-finished')
            resolve()
          }
        }),
    )
    const database = new Database('workspace-a')

    const deletion = database.deleteAll()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(AsyncStorage.removeMany).toHaveBeenCalledWith(['workspace-a-Item-note'])
    expect(mockFlashClearAll.get('workspace-a')).not.toHaveBeenCalled()

    finishPayloadDeletion?.()
    await deletion

    expect(mockEraseEvents).toEqual(['payloads-started', 'payloads-finished', 'metadata:workspace-a'])
  })

  it('does not clear metadata or claim success when payload deletion fails', async () => {
    mockAsyncStorageValues.set('workspace-a-Item-note', JSON.stringify(payload('note')))
    jest.mocked(AsyncStorage.removeMany).mockRejectedValueOnce(new Error('payload erase failed'))
    const database = new Database('workspace-a')

    await expect(database.deleteAll()).rejects.toThrow('payload erase failed')

    expect(mockFlashClearAll.get('workspace-a')).not.toHaveBeenCalled()
    expect(mockAsyncStorageValues.has('workspace-a-Item-note')).toBe(true)
  })
})

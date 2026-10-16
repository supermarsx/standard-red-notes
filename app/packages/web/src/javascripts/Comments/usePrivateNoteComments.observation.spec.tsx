/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ApplicationEvent, ContentType } from '@standardnotes/snjs'
import { usePrivateNoteComments } from './usePrivateNoteComments'

const mockRead = jest.fn(() => [])
const mockUser = { uuid: 'user' }
type ItemChanges = {
  changed: { uuid: string; content_type: string }[]
  inserted: { uuid: string; content_type: string }[]
  removed: { uuid: string; content_type: string }[]
  unerrored: { uuid: string; content_type: string }[]
}
let mockItemsChanged: (changes: ItemChanges) => void
let mockPreferencesChanged: () => void
const mockStopItems = jest.fn()
const mockStopPreferences = jest.fn()
const mockApplication = {
  sessions: { getUser: () => mockUser },
  items: {
    addObserver: jest.fn((_types, callback) => {
      mockItemsChanged = callback
      return mockStopItems
    }),
  },
  addEventObserver: jest.fn((callback) => {
    mockPreferencesChanged = callback
    return mockStopPreferences
  }),
}
jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: () => mockApplication }))
jest.mock('./PrivateNoteComments', () => ({
  readPrivateNoteComments: (...args: unknown[]) => mockRead(...(args as [])),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('does not reread the private store for unrelated note traffic and handles every relevant change kind', async () => {
  mockRead.mockReturnValue([])
  mockApplication.items.addObserver.mockImplementation((_types, callback) => {
    mockItemsChanged = callback
    return mockStopItems
  })
  mockApplication.addEventObserver.mockImplementation((callback) => {
    mockPreferencesChanged = callback
    return mockStopPreferences
  })
  const element = document.createElement('div')
  const root = createRoot(element)
  const Probe = () => {
    usePrivateNoteComments({ uuid: 'current' } as never)
    return null
  }
  const emit = (field: keyof ItemChanges, uuid: string, content_type: string) =>
    mockItemsChanged({ changed: [], inserted: [], removed: [], unerrored: [], [field]: [{ uuid, content_type }] })
  try {
    await act(async () => root.render(<Probe />))
    expect(mockRead).toHaveBeenCalledTimes(1)
    mockRead.mockClear()
    await act(async () => {
      for (let index = 0; index < 100; index++) {
        emit('changed', `other-${index}`, ContentType.TYPES.Note)
      }
    })
    expect(mockRead).not.toHaveBeenCalled()
    for (const kind of ['changed', 'inserted', 'removed', 'unerrored'] as const) {
      await act(async () => emit(kind, 'current', ContentType.TYPES.Note))
    }
    expect(mockRead).toHaveBeenCalledTimes(4)
    for (const kind of ['changed', 'inserted', 'removed', 'unerrored'] as const) {
      await act(async () => emit(kind, 'prefs', ContentType.TYPES.UserPrefs))
    }
    expect(mockRead).toHaveBeenCalledTimes(8)
    await act(async () => mockPreferencesChanged())
    expect(mockRead).toHaveBeenCalledTimes(9)
    expect(mockApplication.addEventObserver).toHaveBeenCalledWith(
      expect.any(Function),
      ApplicationEvent.PreferencesChanged,
    )
  } finally {
    await act(async () => root.unmount())
  }
  expect(mockStopItems).toHaveBeenCalledTimes(1)
  expect(mockStopPreferences).toHaveBeenCalledTimes(1)
})

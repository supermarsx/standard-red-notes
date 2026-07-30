/**
 * @jest-environment jsdom
 */
import { act, createElement, FunctionComponent, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'

import {
  CUSTOM_EDITOR_PERSIST_DEBOUNCE_MS,
  EditorPersistenceFlushController,
  useEditorPersistenceDebounce,
} from './useEditorPersistenceDebounce'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type HarnessProps = {
  controller: EditorPersistenceFlushController
  noteUuid: string
  persist: (value: string) => void
  exposeSchedule: (schedule: (value: string) => void) => void
}

const Harness: FunctionComponent<HarnessProps> = ({ controller, noteUuid, persist, exposeSchedule }) => {
  const schedule = useEditorPersistenceDebounce({
    controller,
    noteUuid,
    persist,
  })

  useEffect(() => {
    exposeSchedule(schedule)
  }, [exposeSchedule, schedule])

  return null
}

type RegisteredControl = {
  flush?: () => void
  hasPending?: () => boolean
}

const createController = (control: RegisteredControl): EditorPersistenceFlushController => ({
  registerEditorFlush: (flush, hasPending) => {
    control.flush = flush
    control.hasPending = hasPending
    return () => {
      if (control.flush === flush) {
        control.flush = undefined
        control.hasPending = undefined
      }
    }
  },
})

let container: HTMLElement
let root: Root
let mounted: boolean
let schedule: (value: string) => void

const exposeSchedule = (nextSchedule: (value: string) => void) => {
  schedule = nextSchedule
}

const renderHarness = async (
  controller: EditorPersistenceFlushController,
  noteUuid: string,
  persist: (value: string) => void,
) => {
  await act(async () => {
    root.render(createElement(Harness, { controller, noteUuid, persist, exposeSchedule }))
  })
}

const unmount = () => {
  if (!mounted) {
    return
  }
  act(() => {
    root.unmount()
  })
  mounted = false
}

beforeEach(() => {
  jest.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = true
})

afterEach(() => {
  unmount()
  container.remove()
  jest.useRealTimers()
})

describe('useEditorPersistenceDebounce', () => {
  it('keeps normal trailing debounce behavior and persists only the latest value once', async () => {
    const control: RegisteredControl = {}
    const persist = jest.fn()
    await renderHarness(createController(control), 'note-a', persist)

    act(() => {
      schedule('first')
      schedule('latest')
      jest.advanceTimersByTime(CUSTOM_EDITOR_PERSIST_DEBOUNCE_MS - 1)
    })
    expect(persist).not.toHaveBeenCalled()
    expect(control.hasPending?.()).toBe(true)

    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith('latest')
    expect(control.hasPending?.()).toBe(false)

    unmount()
    act(() => {
      jest.runOnlyPendingTimers()
    })
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('flushes synchronously on unmount and cancels the trailing timer', async () => {
    const persist = jest.fn()
    await renderHarness(createController({}), 'note-a', persist)

    act(() => {
      schedule('pending edit')
    })
    unmount()

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith('pending edit')

    act(() => {
      jest.runOnlyPendingTimers()
    })
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('flushes a pending value to its original note before a note identity change', async () => {
    const controller = createController({})
    const persistA = jest.fn()
    const persistB = jest.fn()
    await renderHarness(controller, 'note-a', persistA)

    act(() => {
      schedule('note-a edit')
    })
    await renderHarness(controller, 'note-b', persistB)

    expect(persistA).toHaveBeenCalledTimes(1)
    expect(persistA).toHaveBeenCalledWith('note-a edit')
    expect(persistB).not.toHaveBeenCalled()

    act(() => {
      schedule('note-b edit')
      jest.advanceTimersByTime(CUSTOM_EDITOR_PERSIST_DEBOUNCE_MS)
    })
    expect(persistB).toHaveBeenCalledTimes(1)
    expect(persistB).toHaveBeenCalledWith('note-b edit')
  })

  it('registers with the controller flush path without duplicating the later unmount flush', async () => {
    const control: RegisteredControl = {}
    const persist = jest.fn()
    await renderHarness(createController(control), 'note-a', persist)

    act(() => {
      schedule('controller flush')
      control.flush?.()
    })

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith('controller flush')
    expect(control.hasPending?.()).toBe(false)

    unmount()
    expect(persist).toHaveBeenCalledTimes(1)
  })
})

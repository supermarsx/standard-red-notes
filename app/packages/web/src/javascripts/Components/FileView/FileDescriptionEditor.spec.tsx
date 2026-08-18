/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { FileItem, MAX_FILE_DESCRIPTION_LENGTH } from '@standardnotes/models'
import FileDescriptionEditor, { FileDescriptionSaveDebounceMs } from './FileDescriptionEditor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number; max?: number }) => {
      return key === 'fileDescriptionCharacterCount' ? `${values?.count} / ${values?.max}` : key
    },
  }),
}))

const setFileDescription = jest.fn<Promise<FileItem>, [FileItem, string | undefined]>()
const sync = jest.fn<Promise<void>, [{ onPresyncSave: () => void }?]>()

const application = {
  mutator: { setFileDescription },
  sync: { sync },
} as never

const createFile = (description?: string, uuid = 'file-1') =>
  ({
    uuid,
    name: 'document.txt',
    description,
  }) as FileItem

let container: HTMLElement
let root: Root
let rootIsMounted: boolean

beforeEach(() => {
  jest.useFakeTimers()
  setFileDescription.mockImplementation(async (file, description) => ({ ...file, description }) as FileItem)
  sync.mockImplementation(async (options) => {
    options?.onPresyncSave()
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  rootIsMounted = true
})

afterEach(() => {
  if (rootIsMounted) {
    act(() => root.unmount())
  }
  container.remove()
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

const render = (file = createFile(), readonly = false) => {
  act(() => root.render(createElement(FileDescriptionEditor, { application, file, readonly })))
  return container.querySelector('textarea') as HTMLTextAreaElement
}

const rerender = (file: FileItem, readonly = false) => {
  act(() => root.render(createElement(FileDescriptionEditor, { application, file, readonly })))
  return container.querySelector('textarea') as HTMLTextAreaElement
}

const changeValue = (textarea: HTMLTextAreaElement, value: string) => {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    valueSetter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const advanceTimers = async (milliseconds: number) => {
  await act(async () => {
    jest.advanceTimersByTime(milliseconds)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const blur = async (textarea: HTMLTextAreaElement) => {
  await act(async () => {
    textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const pressSaveShortcut = async (textarea: HTMLTextAreaElement, modifier: 'ctrl' | 'meta') => {
  await act(async () => {
    textarea.focus()
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: modifier === 'ctrl',
        metaKey: modifier === 'meta',
        bubbles: true,
        cancelable: true,
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('FileDescriptionEditor', () => {
  it('debounces keystrokes into one normalized, durably acknowledged save', async () => {
    const file = createFile()
    const textarea = render(file)

    changeValue(textarea, 'Draft')
    changeValue(textarea, '  Summary\r\nwith\u0000 details  ')
    await advanceTimers(FileDescriptionSaveDebounceMs - 1)

    expect(setFileDescription).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()

    await advanceTimers(1)

    expect(setFileDescription).toHaveBeenCalledTimes(1)
    expect(setFileDescription).toHaveBeenCalledWith(file, 'Summary\nwith details')
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledWith({ onPresyncSave: expect.any(Function) })
    expect(textarea.value).toBe('Summary\nwith details')
    expect(container.textContent).toContain('fileDescriptionSaved')
  })

  it('flushes immediately on blur and cancels the pending debounce', async () => {
    const textarea = render()

    changeValue(textarea, 'Save on blur')
    await blur(textarea)
    await advanceTimers(FileDescriptionSaveDebounceMs)

    expect(setFileDescription).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it.each(['ctrl', 'meta'] as const)(
    'flushes immediately on %s+Enter without duplicating the blur save',
    async (modifier) => {
      const textarea = render()

      changeValue(textarea, `Save with ${modifier}`)
      await pressSaveShortcut(textarea, modifier)
      await advanceTimers(FileDescriptionSaveDebounceMs)

      expect(setFileDescription).toHaveBeenCalledTimes(1)
      expect(sync).toHaveBeenCalledTimes(1)
    },
  )

  it('does not create a mutation when an unchanged description loses focus', async () => {
    const textarea = render(createFile('Already saved'))

    await blur(textarea)

    expect(setFileDescription).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  it('flushes the previous file before navigation without overwriting the next file draft', async () => {
    const firstFile = createFile()
    const textarea = render(firstFile)
    changeValue(textarea, 'First file description')

    const secondFile = createFile('Second file description', 'file-2')
    const secondTextarea = rerender(secondFile)
    await flushMicrotasks()

    expect(setFileDescription).toHaveBeenCalledWith(firstFile, 'First file description')
    expect(sync).toHaveBeenCalledTimes(1)
    expect(secondTextarea.value).toBe('Second file description')
    expect(container.textContent).not.toContain('fileDescriptionSaved')
  })

  it('best-effort flushes an unsaved draft when unmounted', async () => {
    const file = createFile()
    const textarea = render(file)
    changeValue(textarea, 'Save before leaving')

    await act(async () => {
      root.unmount()
      rootIsMounted = false
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(setFileDescription).toHaveBeenCalledWith(file, 'Save before leaving')
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('keeps a sync persistence failure dirty and retryable after an in-memory prop echo', async () => {
    const file = createFile()
    sync.mockRejectedValueOnce(new Error('persistence failed')).mockImplementationOnce(async (options) => {
      options?.onPresyncSave()
    })
    let textarea = render(file)

    changeValue(textarea, 'Still needs persistence')
    await blur(textarea)

    expect(setFileDescription).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('fileDescriptionSaveFailed')

    textarea = rerender({ ...file, description: 'Still needs persistence' } as FileItem)
    expect(textarea.value).toBe('Still needs persistence')
    expect(container.textContent).toContain('fileDescriptionSaveFailed')

    await blur(textarea)

    expect(setFileDescription).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenLastCalledWith({ onPresyncSave: expect.any(Function) })
    expect(container.textContent).toContain('fileDescriptionSaved')
  })

  it('serializes an active save and coalesces queued edits to the latest description', async () => {
    const file = createFile()
    let resolveFirstSave: ((file: FileItem) => void) | undefined
    setFileDescription
      .mockImplementationOnce(
        () =>
          new Promise<FileItem>((resolve) => {
            resolveFirstSave = resolve
          }),
      )
      .mockImplementation(async (targetFile, description) => ({ ...targetFile, description }) as FileItem)

    const textarea = render(file)
    changeValue(textarea, 'First')
    act(() => textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    changeValue(textarea, 'Intermediate')
    act(() => textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    changeValue(textarea, 'Latest')
    act(() => textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))

    expect(setFileDescription).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstSave?.({ ...file, description: 'First' } as FileItem)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(setFileDescription).toHaveBeenCalledTimes(2)
    expect(setFileDescription.mock.calls.map((call) => call[1])).toEqual(['First', 'Latest'])
    expect(sync).toHaveBeenCalledTimes(2)
    expect(textarea.value).toBe('Latest')
    expect(container.textContent).toContain('fileDescriptionSaved')
  })

  it('drops a queued debounce immediately when write permission is revoked', async () => {
    const file = createFile()
    let textarea = render(file)
    changeValue(textarea, 'Must not save')

    textarea = rerender(file, true)
    await advanceTimers(FileDescriptionSaveDebounceMs)

    expect(textarea.disabled).toBe(true)
    expect(setFileDescription).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })

  it('enforces the shared metadata limit and disables editing for readonly vaults', () => {
    const textarea = render(createFile('Visible description'), true)

    expect(textarea.value).toBe('Visible description')
    expect(textarea.maxLength).toBe(MAX_FILE_DESCRIPTION_LENGTH)
    expect(textarea.disabled).toBe(true)
  })

  it('keeps a failed mutation visible and does not report success', async () => {
    setFileDescription.mockRejectedValue(new Error('offline'))
    const textarea = render()

    changeValue(textarea, 'Unsynced description')
    await blur(textarea)

    expect(sync).not.toHaveBeenCalled()
    expect(container.textContent).toContain('fileDescriptionSaveFailed')
  })

  it('does not let a stale completion update the status after navigating to another file', async () => {
    let resolveSave: ((file: FileItem) => void) | undefined
    setFileDescription.mockReturnValue(
      new Promise<FileItem>((resolve) => {
        resolveSave = resolve
      }),
    )
    const firstFile = createFile()
    const textarea = render(firstFile)
    changeValue(textarea, 'First file description')

    act(() => {
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })

    const secondFile = createFile('Second file description', 'file-2')
    rerender(secondFile)

    await act(async () => {
      resolveSave?.({ ...firstFile, description: 'First file description' } as FileItem)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Second file description')
    expect(container.textContent).not.toContain('fileDescriptionSaved')
  })
})

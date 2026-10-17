/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AssistantSharedChatBinding, SyncedChat } from '@/Assistant/assistantSyncedChats'
import type { AssistantChatComposerState } from '@/Assistant/assistantChatComposerState'
import { useAssistantComposerSync } from './useAssistantComposerSync'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Assistant composer sync', () => {
  let root: Root
  let container: HTMLDivElement
  let api: ReturnType<typeof useAssistantComposerSync>
  let binding: AssistantSharedChatBinding
  let identity: string
  const receive = jest.fn()
  const checkpoint = jest.fn()
  const history = (composer: AssistantChatComposerState) => ({ composer }) as SyncedChat
  function Harness() {
    api = useAssistantComposerSync({ identity, binding, onRemote: receive })
    return null
  }
  const render = async () => {
    await act(async () => root.render(<Harness />))
  }
  beforeEach(() => {
    jest.useFakeTimers()
    checkpoint.mockResolvedValue(undefined)
    identity = 'account-a/chat-a'
    binding = { ready: true, refresh: jest.fn(), checkpoint: jest.fn(), checkpointComposer: checkpoint }
    container = document.createElement('div')
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    jest.useRealTimers()
  })
  it('hydrates without writing and coalesces edits with a bounded wait', async () => {
    binding.history = history({ draft: { value: { text: 'Remote' }, updatedAt: 1 } })
    await render()
    expect(receive).toHaveBeenCalledWith({ draft: { text: 'Remote' } })
    expect(checkpoint).not.toHaveBeenCalled()
    for (let n = 0; n < 7; n++) {
      await act(async () => {
        api.update({ draft: { text: `${n}` } })
        await jest.advanceTimersByTimeAsync(300)
      })
    }
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledWith({ draft: { text: '6' } })
  })
  it('serializes in-flight changes and protects a dirty field while accepting other incoming fields', async () => {
    let resolve!: (chat: SyncedChat) => void
    checkpoint.mockImplementationOnce(
      () =>
        new Promise<SyncedChat>((done) => {
          resolve = done
        }),
    )
    await render()
    await act(async () => {
      api.update({ draft: { text: 'Local' } })
      void api.flush()
    })
    binding = {
      ...binding,
      history: history({
        draft: { value: { text: 'Other' }, updatedAt: 2 },
        context: { value: { scope: 'all-notes' }, updatedAt: 2 },
      }),
    }
    await render()
    expect(receive).toHaveBeenCalledWith({ context: { scope: 'all-notes' } })
    expect(receive).not.toHaveBeenCalledWith(expect.objectContaining({ draft: expect.anything() }))
    await act(async () => {
      api.update({ draft: { text: 'Later local' } })
      resolve(history({ draft: { value: { text: 'Local' }, updatedAt: 3 } }))
    })
    expect(checkpoint).toHaveBeenCalledTimes(2)
    expect(checkpoint).toHaveBeenLastCalledWith({ draft: { text: 'Later local' } })
  })
  it('retains failed writes for explicit retry and exposes the failure', async () => {
    checkpoint.mockRejectedValueOnce(new Error('Unavailable'))
    await render()
    await act(async () => {
      api.update({ draft: { text: 'Keep me' } })
      expect(await api.flush()).toBe(false)
    })
    expect(api.error).toBeInstanceOf(Error)
    await act(async () => {
      expect(await api.flush()).toBe(true)
    })
    expect(checkpoint).toHaveBeenNthCalledWith(2, { draft: { text: 'Keep me' } })
    expect(api.error).toBeUndefined()
  })
  it('applies a newer remote field only after the local write is acknowledged', async () => {
    let resolve!: (chat: SyncedChat) => void
    checkpoint.mockImplementationOnce(
      () =>
        new Promise<SyncedChat>((done) => {
          resolve = done
        }),
    )
    await render()
    await act(async () => {
      api.update({ draft: { text: 'Local' } })
      void api.flush()
    })
    binding = { ...binding, history: history({ draft: { value: { text: 'Newer remote' }, updatedAt: 10 } }) }
    await render()
    expect(receive).not.toHaveBeenCalled()
    await act(async () => {
      resolve(history({ draft: { value: { text: 'Local' }, updatedAt: 9 } }))
    })
    expect(receive).toHaveBeenCalledWith({ draft: { text: 'Newer remote' } })
  })
  it('retries pending edits when storage becomes ready', async () => {
    binding.ready = false
    await render()
    await act(async () => {
      api.update({ draft: { text: 'Waiting' } })
      expect(await api.flush()).toBe(false)
    })
    binding = { ...binding, ready: true }
    await render()
    expect(checkpoint).toHaveBeenCalledWith({ draft: { text: 'Waiting' } })
  })
  it.each(['online', 'focus', 'visibilitychange'])(
    'retries pending failures on %s and removes listeners on unmount',
    async (event) => {
      const target = event === 'visibilitychange' ? document : window
      const removed = jest.spyOn(target, 'removeEventListener')
      checkpoint.mockRejectedValueOnce(new Error('Offline'))
      await render()
      await act(async () => {
        api.update({ draft: { text: 'Retained' } })
        expect(await api.flush()).toBe(false)
      })
      await act(async () => {
        target.dispatchEvent(new Event(event))
      })
      expect(checkpoint).toHaveBeenCalledTimes(2)
      expect(checkpoint).toHaveBeenLastCalledWith({ draft: { text: 'Retained' } })
      expect(api.error).toBeUndefined()
      await act(async () => {
        root.unmount()
        target.dispatchEvent(new Event(event))
      })
      expect(checkpoint).toHaveBeenCalledTimes(2)
      expect(removed).toHaveBeenCalledWith(event, expect.any(Function))
      removed.mockRestore()
    },
  )
  it('accepts a canonical equal-clock winner without echoing it', async () => {
    binding.history = history({ draft: { value: { text: 'First' }, updatedAt: 5 } })
    await render()
    binding = { ...binding, history: history({ draft: { value: { text: 'Canonical winner' }, updatedAt: 5 } }) }
    await render()
    expect(receive).toHaveBeenLastCalledWith({ draft: { text: 'Canonical winner' } })
    expect(checkpoint).not.toHaveBeenCalled()
  })
  it('reconciles a different canonical acknowledged value', async () => {
    checkpoint.mockResolvedValueOnce(history({ draft: { value: { text: 'Canonical' }, updatedAt: 10 } }))
    await render()
    await act(async () => {
      api.update({ draft: { text: 'Local' } })
      expect(await api.flush()).toBe(true)
    })
    expect(receive).toHaveBeenLastCalledWith({ draft: { text: 'Canonical' } })
    expect(checkpoint).toHaveBeenCalledTimes(1)
  })
  it('keeps legacy bindings without composer support nonblocking', async () => {
    delete binding.checkpointComposer
    await render()
    await act(async () => {
      api.update({ draft: { text: 'Local only' } })
      expect(await api.flush()).toBe(true)
    })
    expect(api.error).toBeUndefined()
    expect(checkpoint).not.toHaveBeenCalled()
  })
  it('does not send queued old-account edits or apply old replies across identities', async () => {
    let resolve!: (chat: SyncedChat) => void
    checkpoint.mockImplementationOnce(
      () =>
        new Promise<SyncedChat>((done) => {
          resolve = done
        }),
    )
    await render()
    await act(async () => {
      api.update({ draft: { text: 'Old' } })
      void api.flush()
    })
    await act(async () => {
      api.update({ draft: { text: 'Old unsent' } })
    })
    identity = 'account-b/chat-b'
    binding = { ...binding, history: history({ draft: { value: { text: 'New' }, updatedAt: 1 } }) }
    await render()
    await act(async () => {
      resolve(history({ draft: { value: { text: 'Old' }, updatedAt: 99 } }))
      await jest.advanceTimersByTimeAsync(2500)
    })
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(receive).toHaveBeenLastCalledWith({ draft: { text: 'New' } })
  })
  it('flushes on pagehide and on unmount', async () => {
    await render()
    await act(async () => {
      api.update({ draft: { text: 'Leaving' } })
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(checkpoint).toHaveBeenCalledWith({ draft: { text: 'Leaving' } })
    await act(async () => {
      api.update({ draft: null })
      root.unmount()
    })
    expect(checkpoint).toHaveBeenLastCalledWith({ draft: null })
  })
})

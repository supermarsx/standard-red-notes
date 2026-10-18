/**
 * @jest-environment jsdom
 */
import { ApplicationEvent } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { getAssistantUsageService } from '@/Assistant/AssistantUsageService'
import { act, createElement, useLayoutEffect } from 'react'
import { Root, createRoot } from 'react-dom/client'
import { AssistantUsageState, useAssistantUsage } from './useAssistantUsage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness({
  application,
  onResult,
}: {
  application: WebApplication
  onResult: (result: AssistantUsageState) => void
}) {
  const result = useAssistantUsage(application)
  useLayoutEffect(() => {
    onResult(result)
  }, [onResult, result])
  return null
}

describe('useAssistantUsage bounded server refresh', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('does not treat STREAM_ASSISTANT capability as a usage-event feed', async () => {
    const assistantConfigRequest = jest
      .fn()
      .mockResolvedValueOnce({ used: 2, limit: 10 })
      .mockResolvedValueOnce({ used: 3, limit: 10 })
    const application = {
      getPreference: jest.fn().mockReturnValue('proxy'),
      sessions: { isSignedIn: jest.fn().mockReturnValue(true), getUser: () => ({ uuid: 'account' }) },
      addEventObserver: () => () => undefined,
      assistantConfigRequest,
      // Deliberately expose a READY transport with assistant streaming. This
      // capability alone must not suppress GET refreshes because it does not
      // negotiate a usage-event feed.
      _webSocketSyncTransport: {
        transportStatus: { state: 'READY', operations: ['API_RPC', 'STREAM_ASSISTANT'] },
      },
    } as unknown as WebApplication
    let latest: AssistantUsageState | undefined

    await act(async () => {
      root.render(createElement(Harness, { application, onResult: (result) => (latest = result) }))
    })

    expect(assistantConfigRequest).toHaveBeenCalledTimes(1)
    expect(assistantConfigRequest).toHaveBeenLastCalledWith('/v1/assistant/usage')
    expect(latest?.cap).toEqual({ used: 2, limit: 10 })
    await act(async () => {
      getAssistantUsageService(application).record({ totalTokens: 1 })
    })

    expect(assistantConfigRequest).toHaveBeenCalledTimes(2)
    expect(latest?.cap).toEqual({ used: 3, limit: 10 })
  })
  it('clears old caps at auth/key boundaries and rejects delayed prior-principal responses', async () => {
    let account: string | undefined = 'first'
    let notify!: (event: ApplicationEvent) => void
    const pending: Array<(value: { used: number; limit: number }) => void> = []
    const assistantConfigRequest = jest.fn(() => new Promise((resolve) => pending.push(resolve)))
    const application = {
      getPreference: () => 'proxy',
      sessions: { isSignedIn: () => !!account, getUser: () => (account ? { uuid: account } : undefined) },
      addEventObserver: (callback: typeof notify) => {
        notify = callback
        return () => undefined
      },
      assistantConfigRequest,
    } as unknown as WebApplication
    const firstAccountUsage = getAssistantUsageService(application)
    firstAccountUsage.record({ totalTokens: 15 })
    let latest: AssistantUsageState | undefined
    await act(async () => {
      root.render(createElement(Harness, { application, onResult: (result) => (latest = result) }))
    })
    await act(async () => {
      account = 'second'
      notify(ApplicationEvent.SignedIn)
      pending[1]({ used: 2, limit: 20 })
    })
    expect(latest?.cap).toEqual({ used: 2, limit: 20 })
    await act(async () => {
      pending[0]({ used: 99, limit: 100 })
      firstAccountUsage.record({ totalTokens: 12 })
    })
    expect(latest?.cap).toEqual({ used: 2, limit: 20 })
    expect(latest?.session.totalTokens).toBe(0)
    expect(firstAccountUsage.get().totalTokens).toBe(27)
    act(() => {
      notify(ApplicationEvent.KeyStatusChanged)
    })
    expect(latest?.cap).toBeNull()
    await act(async () => {
      account = undefined
      notify(ApplicationEvent.SignedOut)
      pending[2]({ used: 7, limit: 20 })
    })
    expect(latest?.cap).toBeNull()
    expect(assistantConfigRequest).toHaveBeenCalledTimes(3)
  })

  it('coalesces usage bursts and ignores unrelated preference events without missing the trailing refresh', async () => {
    let notify!: (event: ApplicationEvent) => void
    const pending: Array<(value: { used: number; limit: number }) => void> = []
    const assistantConfigRequest = jest.fn(() => new Promise((resolve) => pending.push(resolve)))
    const application = {
      getPreference: () => 'proxy',
      sessions: { isSignedIn: () => true, getUser: () => ({ uuid: 'account' }) },
      addEventObserver: (callback: typeof notify) => {
        notify = callback
        return () => undefined
      },
      assistantConfigRequest,
    } as unknown as WebApplication
    let latest: AssistantUsageState | undefined
    await act(async () => {
      root.render(createElement(Harness, { application, onResult: (result) => (latest = result) }))
      getAssistantUsageService(application).record({ totalTokens: 1 })
      getAssistantUsageService(application).record({ totalTokens: 1 })
    })
    await act(async () => {
      getAssistantUsageService(application).record({ totalTokens: 1 })
      getAssistantUsageService(application).record({ totalTokens: 1 })
      notify(ApplicationEvent.PreferencesChanged)
    })
    expect(assistantConfigRequest).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending[0]({ used: 1, limit: 10 })
    })
    expect(assistantConfigRequest).toHaveBeenCalledTimes(2)
    await act(async () => {
      pending[1]({ used: 5, limit: 10 })
    })
    expect(latest?.cap).toEqual({ used: 5, limit: 10 })
    expect(assistantConfigRequest).toHaveBeenCalledTimes(2)
  })
})

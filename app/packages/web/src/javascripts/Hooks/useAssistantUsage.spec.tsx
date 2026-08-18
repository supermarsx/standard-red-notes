/**
 * @jest-environment jsdom
 */
import { WebApplication } from '@/Application/WebApplication'
import { assistantUsageService } from '@/Assistant/AssistantUsageService'
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
    assistantUsageService.reset()
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
      sessions: { isSignedIn: jest.fn().mockReturnValue(true) },
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
      assistantUsageService.record({ totalTokens: 1 })
    })

    expect(assistantConfigRequest).toHaveBeenCalledTimes(2)
    expect(latest?.cap).toEqual({ used: 3, limit: 10 })
  })
})

/** @jest-environment jsdom */
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { useAssistantAutoScroll } from './useAssistantAutoScroll'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('does no layout reads for hidden chats, preserves reading position and resumes at the bottom', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const scroll = jest.fn()
  const height = jest.fn(() => 1000)
  let revision = 0
  const frames = new Map<number, FrameRequestCallback>()
  const previousRequest = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame
  let frameId = 0
  globalThis.requestAnimationFrame = jest.fn((callback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  globalThis.cancelAnimationFrame = jest.fn((id) => {
    frames.delete(id)
  })
  function Harness({ active }: { active: boolean }) {
    const ref = useRef<HTMLDivElement>(null)
    const onScroll = useAssistantAutoScroll(ref, active, revision, null)
    return <div ref={ref} onScroll={onScroll} />
  }
  const render = (active: boolean) => act(() => root.render(<Harness active={active} />))
  const flush = () =>
    act(() => {
      const work = [...frames.values()]
      frames.clear()
      work.forEach((callback) => callback(0))
    })
  try {
    render(false)
    const element = container.firstElementChild as HTMLDivElement
    element.scrollTo = scroll
    Object.defineProperty(element, 'scrollHeight', { get: height })
    Object.defineProperty(element, 'clientHeight', { value: 200 })
    for (let i = 0; i < 30; i++) {
      revision++
      render(false)
    }
    expect(height).not.toHaveBeenCalled()
    expect(scroll).not.toHaveBeenCalled()
    render(true)
    revision++
    render(true)
    expect(frames.size).toBe(1)
    flush()
    expect(scroll).toHaveBeenCalledTimes(1)
    element.scrollTop = 100
    act(() => element.dispatchEvent(new Event('scroll')))
    height.mockClear()
    revision++
    render(true)
    flush()
    expect(height).not.toHaveBeenCalled()
    expect(scroll).toHaveBeenCalledTimes(1)
    element.scrollTop = 800
    act(() => element.dispatchEvent(new Event('scroll')))
    revision++
    render(true)
    flush()
    expect(scroll).toHaveBeenCalledTimes(2)
    revision++
    render(true)
    render(false)
    flush()
    expect(scroll).toHaveBeenCalledTimes(2)
  } finally {
    act(() => root.unmount())
    globalThis.requestAnimationFrame = previousRequest
    globalThis.cancelAnimationFrame = previousCancel
  }
})

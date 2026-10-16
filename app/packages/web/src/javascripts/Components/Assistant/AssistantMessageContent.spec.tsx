/** @jest-environment jsdom */
import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import AssistantMessageContent, { assistantMarkdownHtml } from './AssistantMessageContent'
import { assistantMessageTextForCopy } from './AssistantMessageActions'
import * as markdown from '@/Utils/markdownToHtml'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('renders the note-preview markdown pipeline without active HTML or automatic image requests', () => {
  const output = document.createElement('div')
  output.innerHTML = assistantMarkdownHtml(
    '# Heading\n\n**Bold** and *italic*\n- Item\n```js\n<script>code</script>\n```\n<script>alert(1)</script>\n![Tracking](https://example.test/pixel)\n[Unsafe](javascript:alert) [File](file:///secret) [Data](data:text/html,evil) [Safe](https://example.test) [Anchor](#heading)',
  )
  expect(output.querySelector('h1')?.textContent).toBe('Heading')
  expect(output.querySelector('strong')?.textContent).toBe('Bold')
  expect(output.querySelector('li')?.textContent).toBe('Item')
  expect(output.querySelector('pre code')?.textContent).toBe('<script>code</script>')
  expect(output.querySelectorAll('script,img,iframe,object,embed')).toHaveLength(0)
  const styledLink = document.createElement('div')
  styledLink.innerHTML = assistantMarkdownHtml('[Styled](https://example.test/"style="background:red)')
  expect(styledLink.querySelector('[style]')).toBeNull()
  expect(output.textContent).toContain('[Image: Tracking]')
  const links = Array.from(output.querySelectorAll('a'))
  expect(links.map((link) => link.getAttribute('href')).filter(Boolean)).toEqual(['https://example.test', '#heading'])
  expect(links.find((link) => link.textContent === 'Safe')?.rel).toBe('noopener noreferrer')
})

it('defaults to Markdown, supports exact plain text, and retains the choice during streaming updates', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const messageTextRef = createRef<HTMLDivElement>()
  const raw = '**Answer**\n\n```ts\nconst value = 1\n'
  const render = (text: string, streaming: boolean) =>
    root.render(createElement(AssistantMessageContent, { text, streaming, messageTextRef }))
  try {
    act(() => render(raw, true))
    expect(messageTextRef.current?.querySelector('strong')?.textContent).toBe('Answer')
    expect(container.querySelector('[aria-label="Generating response"]')).not.toBeNull()
    const plain = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Plain text',
    )!
    act(() => plain.click())
    expect(messageTextRef.current?.textContent).toBe(`${raw}▍`)
    const finished = raw + 'finished\n```'
    act(() => render(finished, false))
    expect(plain.getAttribute('aria-pressed')).toBe('true')
    expect(messageTextRef.current?.textContent).toBe(finished)
    expect(assistantMessageTextForCopy({ id: 'response', kind: 'assistant', text: raw })).toBe(raw)
    expect(messageTextRef.current?.querySelector('button')).toBeNull()
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Markdown')!
        .click(),
    )
    expect(messageTextRef.current?.querySelector('pre code')?.textContent).toContain('finished')
  } finally {
    act(() => root.unmount())
  }
})

it('bounds Markdown work during streaming while showing every pending character and rendering the exact final response', () => {
  jest.useFakeTimers()
  const parse = jest.spyOn(markdown, 'markdownToHtml')
  const container = document.createElement('div')
  const root = createRoot(container)
  const ref = createRef<HTMLDivElement>()
  const render = (text: string, streaming = true) =>
    root.render(createElement(AssistantMessageContent, { text, streaming, messageTextRef: ref }))
  try {
    act(() => render('**Start**'))
    const initialCalls = parse.mock.calls.length
    let text = '**Start**'
    for (let index = 0; index < 4; index++) {
      text += ` delta${index}`
      act(() => {
        jest.advanceTimersByTime(40)
        render(text)
      })
    }
    expect(parse).toHaveBeenCalledTimes(initialCalls)
    expect(ref.current?.textContent).toBe('Start delta0 delta1 delta2 delta3▍')
    expect(assistantMessageTextForCopy({ id: 'm', kind: 'assistant', text })).toBe(text)
    act(() => jest.advanceTimersByTime(200))
    expect(parse).toHaveBeenCalledTimes(initialCalls + 1)
    const finalText = text + ' **finished**'
    act(() => render(finalText, false))
    expect(Array.from(ref.current!.querySelectorAll('strong')).map((node) => node.textContent)).toEqual([
      'Start',
      'finished',
    ])
    expect(ref.current?.textContent).toBe('Start delta0 delta1 delta2 delta3 finished')
  } finally {
    act(() => root.unmount())
    parse.mockRestore()
    jest.useRealTimers()
  }
})
it('hides a replaced message snapshot immediately and cancels pending formatting on unmount', () => {
  jest.useFakeTimers()
  const container = document.createElement('div')
  const root = createRoot(container)
  const ref = createRef<HTMLDivElement>()
  try {
    act(() =>
      root.render(
        createElement(AssistantMessageContent, {
          text: '**old account secret**',
          streaming: true,
          messageTextRef: ref,
        }),
      ),
    )
    act(() =>
      root.render(
        createElement(AssistantMessageContent, { text: 'new account response', streaming: true, messageTextRef: ref }),
      ),
    )
    expect(ref.current?.textContent).toBe('new account response▍')
    expect(container.textContent).not.toContain('old account secret')
    expect(ref.current?.querySelector('strong')).toBeNull()
    act(() => root.unmount())
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    jest.useRealTimers()
  }
})

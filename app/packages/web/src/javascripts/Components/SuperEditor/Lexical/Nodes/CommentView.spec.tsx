/**
 * @jest-environment jsdom
 *
 * Render contract / vanish-guard for the Comment block's presentational view.
 * Per this repo's repeat "serializes green but never renders" failure, a node
 * that round-trips is NOT done until its UI is proven to reach the DOM. Because
 * `CommentView` is pure/provider-free (no LexicalComposer harness needed), we
 * render it directly with sample props and assert its container, the comment
 * text, the author field, and the formatted timestamp all appear.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { CommentView, formatCommentTimestamp } from './CommentNode'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const CREATED_AT = 1_700_000_000_000

const render = (props?: Partial<Parameters<typeof CommentView>[0]>) => {
  act(() => {
    root.render(
      createElement(CommentView, {
        text: 'Please double-check this figure.',
        author: 'Alex',
        createdAt: CREATED_AT,
        onChangeText: () => undefined,
        onChangeAuthor: () => undefined,
        ...props,
      }),
    )
  })
}

describe('CommentView', () => {
  it('renders the comment container', () => {
    render()
    expect(container.querySelector('[data-comment-block="true"]')).not.toBeNull()
  })

  it('renders the comment text', () => {
    render()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()
    expect(textarea.value).toBe('Please double-check this figure.')
  })

  it('renders the author input with its current value', () => {
    render()
    const authorInput = container.querySelector('input[aria-label="Comment author"]') as HTMLInputElement
    expect(authorInput).not.toBeNull()
    expect(authorInput.value).toBe('Alex')
  })

  it('renders the formatted createdAt timestamp', () => {
    render()
    const stamp = container.querySelector('[data-comment-timestamp="true"]') as HTMLElement
    expect(stamp).not.toBeNull()
    expect(stamp.textContent).toBe(formatCommentTimestamp(CREATED_AT))
    expect(stamp.textContent?.length).toBeGreaterThan(0)
  })

  it('invokes onChange callbacks on blur', () => {
    const onChangeText = jest.fn()
    const onChangeAuthor = jest.fn()
    render({ onChangeText, onChangeAuthor })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'edited'
    act(() => {
      textarea.dispatchEvent(new Event('focusout', { bubbles: true }))
    })
    expect(onChangeText).toHaveBeenCalledWith('edited')

    const authorInput = container.querySelector('input[aria-label="Comment author"]') as HTMLInputElement
    authorInput.value = 'Sam'
    act(() => {
      authorInput.dispatchEvent(new Event('focusout', { bubbles: true }))
    })
    expect(onChangeAuthor).toHaveBeenCalledWith('Sam')
  })
})

/**
 * @jest-environment jsdom
 *
 * Coverage for FIX 1b: getFirstTextNodes must collect the first N text nodes in
 * document order WITHOUT walking the entire node tree. Previously the preview
 * code did `$getRoot().getAllTextNodes().slice(0, 2)`, which materializes every
 * text node (O(node-count)) on every editor change. getFirstTextNodes does an
 * early-exit DFS that stops as soon as it has N nodes.
 */
import { createHeadlessEditor } from '@lexical/headless'
import { $createParagraphNode, $createTextNode, $getRoot, ElementNode, LexicalEditor } from 'lexical'

import { createFlushableDebounce, getFirstTextNodes } from './Utils'

const makeEditor = (): LexicalEditor =>
  createHeadlessEditor({
    namespace: 'GetFirstTextNodesTest',
    nodes: [],
    onError: (error) => {
      throw error
    },
  })

describe('getFirstTextNodes (FIX 1b early-exit)', () => {
  it('returns the first 2 text nodes in document order', () => {
    const editor = makeEditor()
    editor.update(
      () => {
        const root = $getRoot()
        for (const text of ['alpha', 'beta', 'gamma', 'delta']) {
          const paragraph = $createParagraphNode()
          paragraph.append($createTextNode(text))
          root.append(paragraph)
        }
      },
      { discrete: true },
    )

    editor.getEditorState().read(() => {
      const nodes = getFirstTextNodes($getRoot(), 2)
      expect(nodes).toHaveLength(2)
      expect(nodes.map((node) => node.getTextContent())).toEqual(['alpha', 'beta'])
    })
  })

  it('does NOT walk past the first 2 text nodes (early exit)', () => {
    const editor = makeEditor()
    editor.update(
      () => {
        const root = $getRoot()
        for (const text of ['one', 'two', 'three', 'four', 'five']) {
          const paragraph = $createParagraphNode()
          paragraph.append($createTextNode(text))
          root.append(paragraph)
        }
      },
      { discrete: true },
    )

    editor.getEditorState().read(() => {
      // Spy on getChildren of the root so we can assert the traversal stops early.
      // With early exit, after visiting the first paragraph (alpha) and second
      // (beta) text nodes, no further sibling element children are expanded.
      const root = $getRoot()
      const realGetChildren = root.getChildren.bind(root)
      const visitedElements: string[] = []
      const children = realGetChildren()
      children.forEach((child) => {
        const original = (child as ElementNode).getChildren?.bind(child as ElementNode)
        if (original) {
          ;(child as ElementNode).getChildren = function spy() {
            const result = original()
            const first = result[0]
            visitedElements.push(first ? first.getTextContent() : '')
            return result
          } as ElementNode['getChildren']
        }
      })

      const nodes = getFirstTextNodes(root, 2)
      expect(nodes.map((node) => node.getTextContent())).toEqual(['one', 'two'])
      // Only the first two paragraphs should have had their children expanded.
      expect(visitedElements).toEqual(['one', 'two'])
    })
  })

  it('returns all text nodes when fewer than the limit exist', () => {
    const editor = makeEditor()
    editor.update(
      () => {
        const root = $getRoot()
        const paragraph = $createParagraphNode()
        paragraph.append($createTextNode('solo'))
        root.append(paragraph)
      },
      { discrete: true },
    )

    editor.getEditorState().read(() => {
      const nodes = getFirstTextNodes($getRoot(), 2)
      expect(nodes.map((node) => node.getTextContent())).toEqual(['solo'])
    })
  })

  it('returns an empty array for a non-positive limit', () => {
    const editor = makeEditor()
    editor.update(
      () => {
        const root = $getRoot()
        const paragraph = $createParagraphNode()
        paragraph.append($createTextNode('text'))
        root.append(paragraph)
      },
      { discrete: true },
    )

    editor.getEditorState().read(() => {
      expect(getFirstTextNodes($getRoot(), 0)).toEqual([])
    })
  })

  it('descends into nested element nodes in document order', () => {
    const editor = makeEditor()
    editor.update(
      () => {
        const root = $getRoot()
        // Two distinct text nodes (different formats so Lexical does not merge them)
        // inside the FIRST paragraph, then a second paragraph that must NOT be reached.
        const first = $createParagraphNode()
        first.append($createTextNode('first-a'))
        const boldSecond = $createTextNode('first-b')
        boldSecond.toggleFormat('bold')
        first.append(boldSecond)
        root.append(first)
        const second = $createParagraphNode()
        second.append($createTextNode('second'))
        root.append(second)
      },
      { discrete: true },
    )

    editor.getEditorState().read(() => {
      const nodes = getFirstTextNodes($getRoot(), 2)
      expect(nodes.map((node) => node.getTextContent())).toEqual(['first-a', 'first-b'])
    })
  })
})

describe('createFlushableDebounce (FIX 1 — flush on blur/unmount)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it('debounces rapid calls into a single trailing invocation with the latest args', () => {
    const spy = jest.fn<void, [string]>()
    const debounced = createFlushableDebounce(spy, 350)

    debounced('a')
    debounced('b')
    debounced('c')
    expect(spy).not.toHaveBeenCalled()

    jest.advanceTimersByTime(350)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('c')
  })

  it('flush() runs the pending call immediately with the latest args (no edit lost on blur)', () => {
    const spy = jest.fn<void, [string]>()
    const debounced = createFlushableDebounce(spy, 350)

    debounced('typed-but-not-yet-serialized')
    expect(spy).not.toHaveBeenCalled()

    // Simulates blur/unmount: flush captures the latest content before save.
    debounced.flush()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('typed-but-not-yet-serialized')

    // The trailing timer was cancelled by flush, so it does not fire again.
    jest.advanceTimersByTime(1000)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('flush() is a no-op when nothing is pending', () => {
    const spy = jest.fn()
    const debounced = createFlushableDebounce(spy, 350)

    debounced.flush()
    expect(spy).not.toHaveBeenCalled()

    // And a flush after an already-fired call does not re-fire.
    debounced('x')
    jest.advanceTimersByTime(350)
    expect(spy).toHaveBeenCalledTimes(1)
    debounced.flush()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('cancel() drops the pending call without running it and clears the timer', () => {
    const spy = jest.fn()
    const debounced = createFlushableDebounce(spy, 350)

    debounced('dropped')
    debounced.cancel()
    jest.advanceTimersByTime(1000)
    expect(spy).not.toHaveBeenCalled()
  })

  /**
   * Standard Red Notes (last-edit-loss fix): hasPending reports whether an edit lives
   * only in the debounce timer (not yet dirty). The beforeunload warning and
   * note-switch flush rely on this to avoid silently dropping a mid-debounce edit.
   */
  it('hasPending() reflects whether a trailing call is scheduled but not yet run', () => {
    const spy = jest.fn()
    const debounced = createFlushableDebounce(spy, 350)

    expect(debounced.hasPending()).toBe(false)

    debounced('mid-debounce')
    expect(debounced.hasPending()).toBe(true)

    // Firing the trailing timer clears pending.
    jest.advanceTimersByTime(350)
    expect(debounced.hasPending()).toBe(false)

    // Flush also clears pending.
    debounced('again')
    expect(debounced.hasPending()).toBe(true)
    debounced.flush()
    expect(debounced.hasPending()).toBe(false)

    // Cancel clears pending without running.
    debounced('dropme')
    expect(debounced.hasPending()).toBe(true)
    debounced.cancel()
    expect(debounced.hasPending()).toBe(false)
  })
})

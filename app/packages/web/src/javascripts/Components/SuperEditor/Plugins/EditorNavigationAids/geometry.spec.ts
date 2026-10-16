/** @jest-environment jsdom */
import { collectVisualLines, mergeVisualLines, minimapScrollTarget, visibleLineStart } from './geometry'

it('numbers wrapped visual lines while coalescing mixed formatting spans on a baseline', () => {
  const lines = mergeVisualLines([
    { top: 12, height: 20, left: 35, right: 70 },
    { top: 10, height: 24, left: 5, right: 35 },
    { top: 40, height: 24, left: 5, right: 80 },
    { top: 65, height: 0, left: 5, right: 80 },
  ])
  expect(lines).toEqual([
    { top: 10, height: 24, left: 5, right: 70 },
    { top: 40, height: 24, left: 5, right: 80 },
  ])
  expect(visibleLineStart(lines, 35)).toBe(1)
  expect(visibleLineStart(lines, 15)).toBe(0)
})

it('measures text-node ranges once, excludes hidden/decorator text, and leaves native selection alone', () => {
  const root = document.createElement('div')
  root.contentEditable = 'false'
  root.innerHTML = '<p>wrapped <em>words</em></p><p hidden>folded</p><div contenteditable="false">widget</div>'
  document.body.append(root)
  const selection = window.getSelection()!
  const selectionRange = document.createRange()
  selectionRange.selectNodeContents(root.firstChild!)
  selection.addRange(selectionRange)
  const selected = selection.toString()
  const rect = (top: number, left: number, right: number) =>
    ({ top, left, right, height: 20, width: right - left }) as DOMRect
  const calls: string[] = []
  const original = document.createRange.bind(document)
  jest.spyOn(document, 'createRange').mockImplementation(() => {
    const range = original()
    Object.defineProperty(range, 'getClientRects', {
      value: () => {
        calls.push(range.toString())
        return range.toString() === 'wrapped ' ? [rect(10, 0, 80), rect(35, 0, 30)] : [rect(35, 30, 80)]
      },
    })
    return range
  })
  expect(collectVisualLines(root)).toHaveLength(2)
  expect(calls).toEqual(['wrapped ', 'words'])
  expect(selection.toString()).toBe(selected)
  jest.restoreAllMocks()
  root.remove()
  selection.removeAllRanges()
})

it('centres click navigation on the selected document region and clamps its edges', () => {
  expect(minimapScrollTarget(0.5, 2000, 400)).toBe(800)
  expect(minimapScrollTarget(-1, 2000, 400)).toBe(0)
  expect(minimapScrollTarget(2, 2000, 400)).toBe(1600)
  expect(minimapScrollTarget(0.5, 200, 400)).toBe(0)
})

/** @jest-environment jsdom */
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CustomPageSizeFields, PageLayoutFields } from './PageLayoutFields'
import { DEFAULT_NOTE_LAYOUT, normalizeNoteLayout, NoteLayout } from './layoutSettings'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('edits custom dimensions on commit and refuses invalid dimensions without changing saved layout', async () => {
  let saved = normalizeNoteLayout({ ...DEFAULT_NOTE_LAYOUT, pageSizeId: 'custom' })
  function Harness() {
    const [layout, setLayout] = useState(saved)
    return (
      <CustomPageSizeFields
        layout={layout}
        onChange={(patch) => {
          saved = normalizeNoteLayout({ ...layout, ...patch })
          setLayout(saved)
        }}
      />
    )
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Harness />))
    const width = container.querySelector<HTMLInputElement>('input')!
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      width.focus()
      set.call(width, '145.5')
      width.dispatchEvent(new Event('input', { bubbles: true }))
      width.blur()
    })
    expect(saved.customPageWidthMm).toBe(145.5)
    await act(async () => {
      width.focus()
      set.call(width, '99999')
      width.dispatchEvent(new Event('input', { bubbles: true }))
      width.blur()
    })
    expect(saved.customPageWidthMm).toBe(145.5)
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it('exposes every layout family including complete header/footer styles', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<PageLayoutFields layout={DEFAULT_NOTE_LAYOUT} onChange={(_patch: Partial<NoteLayout>) => {}} />),
    )
    for (const label of [
      'Page size',
      'Orientation',
      'Margins',
      'Text columns',
      'Number format',
      'Number location',
      'Number alignment',
      'Start at page',
      'Header font',
      'Footer font',
      'Header bold',
      'Footer underline',
      'Show document outline',
      'Show bookmarks in outline',
    ]) {
      expect(container.textContent).toContain(label)
    }
  } finally {
    await act(async () => root.unmount())
  }
})

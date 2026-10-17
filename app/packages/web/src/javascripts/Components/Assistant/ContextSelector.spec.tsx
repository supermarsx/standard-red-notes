/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ContextSelector from './ContextSelector'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('keeps context configuration collapsed behind its abbreviated scope', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onChange = jest.fn()
  const application = { items: { getItems: () => [], getTagLongTitle: () => '' } }
  try {
    await act(async () =>
      root.render(
        <ContextSelector
          application={application as never}
          selection={{ scope: 'topic', topicQuery: 'work' }}
          onChange={onChange}
        />,
      ),
    )
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Assistant context"]')!
    expect(button.textContent).toBe('Topic')
    expect(button.title).toContain('Topic / search')
    expect(document.querySelector('[aria-label="Topic search query"]')).toBeNull()
    await act(async () => button.click())
    const query = document.querySelector<HTMLInputElement>('[aria-label="Topic search query"]')!
    expect(query.value).toBe('work')
    expect(document.querySelector('[aria-label="Choose assistant context"]')).not.toBeNull()
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

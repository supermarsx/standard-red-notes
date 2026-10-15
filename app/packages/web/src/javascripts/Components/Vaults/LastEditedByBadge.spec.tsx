/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { TrustedContactInterface } from '@standardnotes/models'
import LastEditedByBadge from './LastEditedByBadge'

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
jest.mock('../Icon/Icon', () => ({ __esModule: true, default: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('retains the attribution slot when empty and exposes full names despite visual truncation', () => {
  const container = document.createElement('div'),
    root = createRoot(container)
  const contact = { name: 'A very long collaborator name', uuid: 'alice' } as TrustedContactInterface
  try {
    act(() => root.render(createElement(LastEditedByBadge, { contact })))
    const badge = container.querySelector('[data-last-edited-badge]')!
    expect(badge.getAttribute('title')).toBe('lastEditedBy: A very long collaborator name')
    expect(badge.textContent).toBe(contact.name)
    act(() => root.render(createElement(LastEditedByBadge)))
    expect(container.querySelector('[data-last-edited-badge]')).toBe(badge)
    expect(badge.getAttribute('aria-hidden')).toBe('true')
    expect(badge.textContent).toBe('')
    expect(badge.getAttribute('title')).toBeNull()
  } finally {
    act(() => root.unmount())
  }
})

/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { sanitizePrintBody } from '@/Components/NoteView/Print/PrintNote'
import { ShipmentTrackingView } from './ShipmentTrackingNode'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root
let fetchSpy: jest.Mock
let originalFetch: typeof globalThis.fetch

const data = {
  version: 1,
  label: 'Replacement keyboard',
  trackingNumber: 'RR123456789CN',
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  originalFetch = globalThis.fetch
  fetchSpy = jest.fn()
  globalThis.fetch = fetchSpy as typeof globalThis.fetch
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.fetch = originalFetch
})

const render = () => {
  act(() => {
    root.render(createElement(ShipmentTrackingView, { data, onChange: jest.fn() }))
  })
}

describe('ShipmentTrackingView', () => {
  it('renders a compact shipment summary and exact hardened global link', () => {
    render()

    expect(container.querySelector('[data-shipment-tracking-block="true"]')).not.toBeNull()
    expect(container.querySelector('[data-shipment-tracking-label="true"]')?.textContent).toBe('Replacement keyboard')
    expect(container.querySelector('code')?.textContent).toBe('RR123456789CN')

    const section = container.querySelector('section')!
    const sectionLabelId = section.getAttribute('aria-labelledby')
    expect(sectionLabelId).not.toBeNull()
    expect(document.getElementById(sectionLabelId!)?.textContent).toContain('Shipment tracking')

    const link = container.querySelector('[data-shipment-track-action="global"]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://t.17track.net/en#nums=RR123456789CN')
    expect(link.target).toBe('_blank')
    expect(new Set(link.rel.split(/\s+/u))).toEqual(new Set(['noopener', 'noreferrer']))
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(link.getAttribute('aria-label')).toBe('Track Replacement keyboard globally')
    expect(container.querySelector('button[aria-label="Copy tracking number for Replacement keyboard"]')).not.toBeNull()
    expect(
      container.querySelector('button[aria-label="Edit shipment tracking for Replacement keyboard"]'),
    ).not.toBeNull()
  })

  it('performs no network request and injects no third-party active content on render', () => {
    render()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(container.querySelector('script, iframe, img, object, embed')).toBeNull()
    expect(container.innerHTML).not.toContain('externalcall.js')
  })

  it('uses unique description ids when multiple empty blocks are edited', () => {
    const emptyData = { version: 1, label: '', trackingNumber: '' }
    act(() => {
      root.render(
        createElement(
          'div',
          null,
          createElement(ShipmentTrackingView, { data: emptyData, onChange: jest.fn() }),
          createElement(ShipmentTrackingView, { data: emptyData, onChange: jest.fn() }),
        ),
      )
    })

    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[aria-describedby]'))
    const descriptionIds = inputs.map((input) => input.getAttribute('aria-describedby'))
    expect(inputs).toHaveLength(2)
    expect(new Set(descriptionIds).size).toBe(2)
    for (const descriptionId of descriptionIds) {
      expect(descriptionId).not.toBeNull()
      expect(document.getElementById(descriptionId!)).not.toBeNull()
    }

    const sections = Array.from(container.querySelectorAll('section[aria-labelledby]'))
    const sectionLabelIds = sections.map((section) => section.getAttribute('aria-labelledby'))
    expect(sections).toHaveLength(2)
    expect(new Set(sectionLabelIds).size).toBe(2)
    for (const sectionLabelId of sectionLabelIds) {
      expect(sectionLabelId).not.toBeNull()
      expect(document.getElementById(sectionLabelId!)).not.toBeNull()
    }
  })

  it('moves focus into the form after Edit', () => {
    render()
    const edit = container.querySelector(
      'button[aria-label="Edit shipment tracking for Replacement keyboard"]',
    ) as HTMLButtonElement

    act(() => edit.click())

    expect(document.activeElement).toBe(container.querySelector('input[aria-label="Shipment tracking number"]'))
  })

  it('reopens the editor when synced data becomes invalid', () => {
    render()
    expect(container.querySelector('input[aria-label="Shipment tracking number"]')).toBeNull()

    act(() => {
      root.render(
        createElement(ShipmentTrackingView, {
          data: { version: 1, label: '', trackingNumber: '' },
          onChange: jest.fn(),
        }),
      )
    })

    expect(container.querySelector('input[aria-label="Shipment tracking number"]')).not.toBeNull()
  })

  it('keeps label and number in print while removing every lookup/edit control and vendor URL', () => {
    render()

    const printBody = container.cloneNode(true) as HTMLElement
    sanitizePrintBody(printBody, container)

    expect(printBody.textContent).toContain('Replacement keyboard')
    expect(printBody.textContent).toContain('RR123456789CN')
    expect(printBody.textContent).not.toContain('Track globally')
    expect(printBody.textContent).not.toContain('Ready to check')
    expect(printBody.innerHTML.toLowerCase()).not.toContain('17track')
    expect(printBody.querySelector('button, a, input, form, [data-srn-print-exclude]')).toBeNull()
  })
})

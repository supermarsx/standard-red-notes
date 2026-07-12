/**
 * @jest-environment jsdom
 *
 * UI-render guard for the ImportModal InitialPage import-source additions (t46):
 * the new "Word (.docx)" and "OpenDocument (.odt)" buttons must actually render.
 * This repo has twice shipped menu/toolbar entries that were silently filtered
 * out of the DOM (MEMORY: "verify UI render paths"), so we render the real
 * component and assert both buttons are present.
 */
import { createElement, act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { FeatureStatus } from '@standardnotes/snjs'
import ApplicationProvider from '@/Components/ApplicationProvider'
import InitialPage from './InitialPage'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const makeFakeApp = () =>
  ({
    features: {
      getFeatureStatus: () => FeatureStatus.Entitled,
    },
    showPremiumModal: () => undefined,
    addEventObserver: () => () => undefined,
  }) as never

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

const render = () => {
  act(() => {
    root.render(
      createElement(ApplicationProvider, {
        application: makeFakeApp(),
        children: createElement(InitialPage, {
          setFiles: () => undefined,
          selectFiles: () => Promise.resolve(),
        }),
      }),
    )
  })
}

describe('ImportModal InitialPage docx/odt sources', () => {
  it('renders the Word (.docx) import button', () => {
    render()
    expect(container.textContent).toContain('Word (.docx)')
  })

  it('renders the OpenDocument (.odt) import button', () => {
    render()
    expect(container.textContent).toContain('OpenDocument (.odt)')
  })

  it('still renders the existing Super (JSON) and HTML sources (no regression)', () => {
    render()
    expect(container.textContent).toContain('Super (JSON)')
    expect(container.textContent).toContain('HTML')
  })
})

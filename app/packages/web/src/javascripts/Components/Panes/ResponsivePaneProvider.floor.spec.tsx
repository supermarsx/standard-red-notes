/** @jest-environment jsdom */

/**
 * The launch restore's floor is WIRED, not merely implemented.
 *
 * `PaneController.initializePanesIfEmpty` is guarded and unit-tested in
 * `PaneCollapsePersistence.spec.ts`, but a guard nothing calls is a guard that
 * does nothing: the pane stack stays empty, no columns render, and no error is
 * raised anywhere — the exact failure the floor exists to catch. This repo has
 * shipped three times over control logic that typechecked, passed its unit tests
 * and was never reached, so the call site gets a render proof of its own: the
 * real provider, mounted, with the controller's method observed.
 */

import { act, createElement, StrictMode, useEffect, useState } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { AppPaneId } from './AppPaneMetadata'
import type { PaneController } from '@/Controllers/PaneController/PaneController'

jest.mock('@/NativeMobileWeb/useAndroidBackHandler', () => ({
  __esModule: true,
  useAndroidBackHandler: () => () => () => {},
}))

import ResponsivePaneProvider, { useResponsiveAppPane } from './ResponsivePaneProvider'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noop = () => {}

const makePaneController = (panes: AppPaneId[]) => {
  const initializePanesIfEmpty = jest.fn()

  const controller = {
    panes,
    currentPane: panes[panes.length - 1],
    initializePanesIfEmpty,
    isListPaneCollapsed: !panes.includes(AppPaneId.Items),
    isNavigationPaneCollapsed: !panes.includes(AppPaneId.Navigation),
    focusModeEnabled: false,
    toggleListPane: noop,
    toggleNavigationPane: noop,
    presentPane: noop,
    popToPane: noop,
    dismissLastPane: noop,
    replacePanes: noop,
    removePane: noop,
    insertPaneAtIndex: noop,
    setPaneLayout: noop,
  } as unknown as PaneController

  return { controller, initializePanesIfEmpty }
}

describe('ResponsivePaneProvider asks the controller for panes when it mounts', () => {
  let container: HTMLDivElement
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

  const PaneReadout = () => {
    const { panes } = useResponsiveAppPane()
    return createElement('div', { 'data-testid': 'panes' }, panes.join(','))
  }

  it('calls initializePanesIfEmpty exactly once, with the pane context still working', () => {
    const { controller, initializePanesIfEmpty } = makePaneController([AppPaneId.Navigation, AppPaneId.Editor])

    act(() => {
      root.render(
        createElement(ResponsivePaneProvider, { paneController: controller, children: createElement(PaneReadout) }),
      )
    })

    expect(initializePanesIfEmpty).toHaveBeenCalledTimes(1)
    expect(initializePanesIfEmpty).toHaveBeenCalledWith()
    expect(container.querySelector('[data-testid="panes"]')?.textContent).toBe('NavigationColumn,EditorColumn')
  })

  it('does not re-ask on every re-render: the controller decides, once', () => {
    const { controller, initializePanesIfEmpty } = makePaneController([AppPaneId.Editor])

    const Rerenderer = () => {
      const [count, setCount] = useState(0)
      useEffect(() => {
        if (count < 3) {
          setCount(count + 1)
        }
      }, [count])
      return createElement(ResponsivePaneProvider, { paneController: controller, children: createElement(PaneReadout) })
    }

    act(() => {
      root.render(createElement(Rerenderer))
    })

    expect(initializePanesIfEmpty).toHaveBeenCalledTimes(1)
  })

  it('is idempotent under StrictMode double-invocation, because the controller guards it', () => {
    // StrictMode mounts effects twice in development. The call is therefore
    // allowed to happen twice; what must not happen is a second RESTORE, which is
    // why the guard lives in the controller and not at this call site.
    const { controller, initializePanesIfEmpty } = makePaneController([AppPaneId.Editor])

    act(() => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(ResponsivePaneProvider, { paneController: controller, children: createElement(PaneReadout) }),
        ),
      )
    })

    expect(initializePanesIfEmpty.mock.calls.length).toBeGreaterThanOrEqual(1)
  })
})

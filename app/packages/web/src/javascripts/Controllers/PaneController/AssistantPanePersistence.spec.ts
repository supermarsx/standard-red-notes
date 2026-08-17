/**
 * @jest-environment jsdom
 */
import { LocalPrefDefaults, LocalPrefKey, PreferenceServiceInterface } from '@standardnotes/services'
import { ApplicationEvent, InternalEventBusInterface } from '@standardnotes/snjs'
import { KeyboardService } from '@standardnotes/ui-services'
import { PanesForLayout } from '../../Application/UseCase/PanesForLayout'
import { IsTabletOrMobileScreen } from '../../Application/UseCase/IsTabletOrMobileScreen'
import { AppPaneId } from '../../Components/Panes/AppPaneMetadata'
import { CommandService } from '../../Components/CommandPalette/CommandService'
import { PaneController } from './PaneController'

type Harness = {
  controller: PaneController
  localValues: Map<LocalPrefKey, unknown>
  setLocalValue: jest.Mock
}

const localPreferencesChanged = { type: ApplicationEvent.LocalPreferencesChanged } as never

function installMatchMedia(isMobile: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: jest.fn((query: string) => ({
      matches: query.includes('max-width: 767px') ? isMobile : !isMobile,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  })
}

function makeHarness(options: { isMobile?: boolean; assistantPreference?: unknown } = {}): Harness {
  const isMobile = options.isMobile ?? false
  installMatchMedia(isMobile)

  const localValues = new Map<LocalPrefKey, unknown>()
  if ('assistantPreference' in options) {
    localValues.set(LocalPrefKey.AssistantPaneOpen, options.assistantPreference)
  }

  const setLocalValue = jest.fn((key: LocalPrefKey, value: unknown) => {
    localValues.set(key, value)
  })
  const preferences = {
    getValue: jest.fn((_key: unknown, defaultValue: unknown) => defaultValue),
    getLocalValue: jest.fn((key: LocalPrefKey, defaultValue: unknown) =>
      localValues.has(key) ? localValues.get(key) : defaultValue,
    ),
    setLocalValue,
  } as unknown as PreferenceServiceInterface

  const eventBus = {
    addEventHandler: jest.fn(),
    publish: jest.fn(),
    publishSync: jest.fn(),
    deinit: jest.fn(),
  } as unknown as InternalEventBusInterface
  const keyboardService = {} as KeyboardService
  const commands = {
    addWithShortcut: jest.fn(() => jest.fn()),
  } as unknown as CommandService
  const screen = {
    execute: jest.fn(() => ({
      getValue: () => ({
        isTabletOrMobile: isMobile,
        isTablet: false,
        isMobile,
      }),
    })),
  } as unknown as IsTabletOrMobileScreen
  const panesForLayout = {
    execute: jest.fn(() => ({ getValue: () => [AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor] })),
  } as unknown as PanesForLayout

  return {
    controller: new PaneController(preferences, keyboardService, commands, screen, panesForLayout, eventBus),
    localValues,
    setLocalValue,
  }
}

describe('PaneController assistant visibility persistence', () => {
  it('defaults closed and restores only the literal boolean true at the desktop right edge', async () => {
    expect(LocalPrefDefaults[LocalPrefKey.AssistantPaneOpen]).toBe(false)

    const closed = makeHarness()
    await closed.controller.handleEvent(localPreferencesChanged)
    expect(closed.controller.panes).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])

    const malformed = makeHarness({ assistantPreference: 'true' })
    await malformed.controller.handleEvent(localPreferencesChanged)
    expect(malformed.controller.panes).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])

    const open = makeHarness({ assistantPreference: true })
    await open.controller.handleEvent(localPreferencesChanged)
    expect(open.controller.panes).toEqual([
      AppPaneId.Navigation,
      AppPaneId.Items,
      AppPaneId.Editor,
      AppPaneId.Assistant,
    ])
  })

  it('restores an open assistant as the current pane on mobile', async () => {
    const { controller } = makeHarness({ isMobile: true, assistantPreference: true })

    await controller.handleEvent(localPreferencesChanged)

    expect(controller.panes).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Assistant])
    expect(controller.currentPane).toBe(AppPaneId.Assistant)
  })

  it('persists an explicit open and restores it in a new controller', async () => {
    const first = makeHarness()
    await first.controller.handleEvent(localPreferencesChanged)

    first.controller.presentPane(AppPaneId.Assistant)

    expect(first.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.AssistantPaneOpen, true)
    const reloaded = makeHarness({ assistantPreference: first.localValues.get(LocalPrefKey.AssistantPaneOpen) })
    await reloaded.controller.handleEvent(localPreferencesChanged)
    expect(reloaded.controller.panes.at(-1)).toBe(AppPaneId.Assistant)
  })

  it.each([
    ['dismissLastPane', (controller: PaneController) => controller.dismissLastPane()],
    ['removePane', (controller: PaneController) => controller.removePane(AppPaneId.Assistant)],
  ])('persists an explicit close through %s', async (_name, close) => {
    const harness = makeHarness({ assistantPreference: true })
    await harness.controller.handleEvent(localPreferencesChanged)
    harness.setLocalValue.mockClear()

    close(harness.controller)

    expect(harness.setLocalValue).toHaveBeenCalledWith(LocalPrefKey.AssistantPaneOpen, false)
    expect(harness.controller.panes).not.toContain(AppPaneId.Assistant)
  })

  it('keeps a docked assistant through layout replacement without rewriting its saved state', async () => {
    const harness = makeHarness({ assistantPreference: true })
    await harness.controller.handleEvent(localPreferencesChanged)
    harness.setLocalValue.mockClear()

    harness.controller.replacePanes([AppPaneId.Editor])

    expect(harness.controller.panes).toEqual([AppPaneId.Editor, AppPaneId.Assistant])
    expect(harness.setLocalValue).not.toHaveBeenCalled()
    expect(harness.localValues.get(LocalPrefKey.AssistantPaneOpen)).toBe(true)
  })
})

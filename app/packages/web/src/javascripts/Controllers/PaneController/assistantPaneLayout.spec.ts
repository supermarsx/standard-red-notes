import { AppPaneId } from '../../Components/Panes/AppPaneMetadata'
import {
  ASSISTANT_PANEL_MIN_WIDTH,
  clampAssistantPanelWidth,
  dockAssistantPaneToRight,
  insertPaneBeforeDockedAssistant,
  maximumAssistantPanelWidth,
  presentPaneBeforeDockedAssistant,
} from './assistantPaneLayout'

describe('desktop assistant pane layout', () => {
  it('keeps an open assistant through a normal layout replacement and docks it at the right edge', () => {
    expect(dockAssistantPaneToRight([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor], true)).toEqual([
      AppPaneId.Navigation,
      AppPaneId.Items,
      AppPaneId.Editor,
      AppPaneId.Assistant,
    ])
  })

  it('normalizes a malformed duplicate assistant layout to one rightmost pane', () => {
    expect(
      dockAssistantPaneToRight(
        [AppPaneId.Navigation, AppPaneId.Assistant, AppPaneId.Editor, AppPaneId.Assistant],
        true,
      ),
    ).toEqual([AppPaneId.Navigation, AppPaneId.Editor, AppPaneId.Assistant])
  })

  it.each([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor])(
    'does not append %s to the right of an open assistant',
    (pane) => {
      expect(
        presentPaneBeforeDockedAssistant(
          [AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor, AppPaneId.Assistant],
          pane,
        ),
      ).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor, AppPaneId.Assistant])
    },
  )

  it('inserts a newly shown navigation pane before the assistant without duplication', () => {
    expect(
      insertPaneBeforeDockedAssistant(
        [AppPaneId.Items, AppPaneId.Editor, AppPaneId.Assistant],
        AppPaneId.Navigation,
        0,
      ),
    ).toEqual([AppPaneId.Navigation, AppPaneId.Items, AppPaneId.Editor, AppPaneId.Assistant])
  })
})

describe('assistant pane width bounds', () => {
  it('keeps enough room for the main pane on a normal desktop viewport', () => {
    expect(maximumAssistantPanelWidth(1440)).toBe(900)
    expect(clampAssistantPanelWidth(1200, 1440)).toBe(900)
    expect(clampAssistantPanelWidth(100, 1440)).toBe(ASSISTANT_PANEL_MIN_WIDTH)
  })

  it('reserves visible navigation and item-list widths before sizing the assistant', () => {
    expect(maximumAssistantPanelWidth(1440, 620)).toBe(420)
    expect(clampAssistantPanelWidth(900, 1440, 620)).toBe(420)
  })

  it('never returns a width smaller than the accessible minimum on a narrow viewport', () => {
    expect(maximumAssistantPanelWidth(500)).toBe(ASSISTANT_PANEL_MIN_WIDTH)
    expect(clampAssistantPanelWidth(600, 500)).toBe(ASSISTANT_PANEL_MIN_WIDTH)
  })
})

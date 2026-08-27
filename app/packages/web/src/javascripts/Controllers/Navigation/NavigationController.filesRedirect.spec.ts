import { SystemViewId } from '@standardnotes/snjs'
import { NavigationController } from './NavigationController'
import { AppPaneId } from '@/Components/Panes/AppPaneMetadata'

/**
 * The Files system view is no longer reachable from the sidebar or the command
 * palette, but saved state can still name it: a quick action or Home card
 * configured before the merge stores its uuid and resolves through
 * setSelectedTag. These cases pin the redirect that sends those to the Files tab
 * instead of a files list with no folder chips, upload or bulk bar.
 *
 * Built on the prototype rather than the real constructor so the guard can be
 * exercised without standing up the controller's full dependency graph.
 */
const buildController = () => {
  const openPaneTab = jest.fn()
  const setPaneLayout = jest.fn()
  const publishSync = jest.fn(async () => undefined)
  const controller = Object.create(NavigationController.prototype) as NavigationController & {
    selected_: unknown
    selectedLocation: unknown
  }

  Object.assign(controller, {
    paneController: { openPaneTab, setPaneLayout },
    items: { isTemplateItem: () => false },
    recents: { add: jest.fn() },
    eventBus: { publishSync },
    _changeAndSaveItem: { execute: jest.fn(async () => undefined) },
    selected_: undefined,
    selectedUuid: undefined,
    selectedLocation: undefined,
    previouslySelected_: undefined,
    tagToScrollIntoView: undefined,
  })

  jest.spyOn(controller, 'tagUsesTableView').mockReturnValue(false)

  return { controller, openPaneTab, setPaneLayout, publishSync }
}

const filesView = { uuid: SystemViewId.Files, title: 'Files' } as never
const regularTag = { uuid: 'tag-1', title: 'Work' } as never

describe('setSelectedTag and the retired Files view', () => {
  it('opens the Files tab instead of selecting the view', async () => {
    const { controller, openPaneTab } = buildController()

    await controller.setSelectedTag(filesView, 'views', { userTriggered: true })

    expect(openPaneTab).toHaveBeenCalledWith(AppPaneId.Files)
  })

  it('leaves the navigation selection untouched when it redirects', async () => {
    const { controller, publishSync } = buildController()

    await controller.setSelectedTag(filesView, 'views', { userTriggered: true })

    // No selection change and no TagChanged event: the sidebar keeps whatever was
    // selected, because opening a tab is not a navigation change.
    expect(controller.selected_).toBeUndefined()
    expect(controller.selectedLocation).toBeUndefined()
    expect(publishSync).not.toHaveBeenCalled()
  })

  it('still selects an ordinary tag normally', async () => {
    const { controller, openPaneTab, publishSync } = buildController()

    await controller.setSelectedTag(regularTag, 'all', { userTriggered: true })

    expect(openPaneTab).not.toHaveBeenCalled()
    expect(controller.selectedLocation).toBe('all')
    expect(publishSync).toHaveBeenCalled()
  })
})

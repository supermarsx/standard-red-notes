import { ContentType, SNFolder, SNTag } from '@standardnotes/snjs'
import { NavigationController } from './NavigationController'

/**
 * Standard Red Notes: hidden folders & tags.
 *
 * The rules these cases pin, in the order the feature was decided:
 *
 *  1. A hidden folder/tag keeps its ROW out of every sidebar list. Nothing is done to its
 *     notes, and `tags`/`folders` stay complete so the organize surface can still list it.
 *  2. The subtree goes with it: a child of a hidden parent is kept out too, even though the
 *     child carries no flag of its own.
 *  3. Revealing is always available. `showHiddenNavigationItems` puts every hidden row back,
 *     and a hidden tag is not silently restored as the startup selection.
 *
 * Built on the prototype rather than the real constructor, as
 * `NavigationController.filesRedirect.spec.ts` does, so the sidebar getters can be exercised
 * without standing up the controller's whole dependency graph.
 */

type FakeTag = {
  uuid: string
  title: string
  content_type: string
  starred?: boolean
  hidden?: boolean
  content?: { hidden?: boolean }
}

type FakeFolder = {
  uuid: string
  title: string
  parentId?: string
  hidden?: boolean
}

const tag = (uuid: string, overrides: Partial<FakeTag> = {}): FakeTag => ({
  uuid,
  title: uuid,
  content_type: ContentType.TYPES.Tag,
  ...overrides,
})

const folder = (uuid: string, overrides: Partial<FakeFolder> = {}): FakeFolder => ({
  uuid,
  title: uuid,
  ...overrides,
})

/** Shown root, hidden root, and one child under each. */
const SHOWN_FOLDER = folder('f-shown')
const HIDDEN_FOLDER = folder('f-hidden', { hidden: true })
const CHILD_OF_SHOWN = folder('f-child-shown', { parentId: 'f-shown' })
const CHILD_OF_HIDDEN = folder('f-child-hidden', { parentId: 'f-hidden' })
const GRANDCHILD_OF_HIDDEN = folder('f-grandchild-hidden', { parentId: 'f-child-hidden' })

const SHOWN_TAG = tag('t-shown')
const HIDDEN_TAG = tag('t-hidden', { hidden: true })
const CHILD_OF_HIDDEN_TAG = tag('t-child-hidden')
/** A tag whose flag only exists in raw content, as a pre-rebuild snjs bundle leaves it. */
const HIDDEN_VIA_CONTENT_TAG = tag('t-hidden-content', { content: { hidden: true } })
const STARRED_SHOWN_TAG = tag('t-starred-shown', { starred: true })
const STARRED_HIDDEN_TAG = tag('t-starred-hidden', { starred: true, hidden: true })

const TAG_PARENTS: Record<string, string | undefined> = {
  't-child-hidden': 't-hidden',
}

const ALL_TAGS = [
  SHOWN_TAG,
  HIDDEN_TAG,
  CHILD_OF_HIDDEN_TAG,
  HIDDEN_VIA_CONTENT_TAG,
  STARRED_SHOWN_TAG,
  STARRED_HIDDEN_TAG,
]

const ALL_FOLDERS = [SHOWN_FOLDER, HIDDEN_FOLDER, CHILD_OF_SHOWN, CHILD_OF_HIDDEN, GRANDCHILD_OF_HIDDEN]

const buildController = () => {
  const controller = Object.create(NavigationController.prototype) as NavigationController
  const execute = jest.fn(async (_item: unknown, mutate: (mutator: unknown) => void) => {
    const mutator = { mutableContent: {} as { hidden?: boolean } }
    mutate(mutator)
    return mutator
  })

  const tagsByUuid = new Map(ALL_TAGS.map((candidate) => [candidate.uuid, candidate]))

  Object.assign(controller, {
    tags: ALL_TAGS as unknown as SNTag[],
    folders: ALL_FOLDERS as unknown as SNFolder[],
    starredTags: [STARRED_SHOWN_TAG, STARRED_HIDDEN_TAG] as unknown as SNTag[],
    smartViews: [{ uuid: 'view-all-notes', title: 'All notes' }],
    showHiddenNavigationItems: false,
    searchQuery: '',
    customTagsOrder_: [],
    customFoldersOrder_: [],
    editing_: undefined,
    editingFolder_: undefined,
    _changeAndSaveItem: { execute },
    mutator: { changeItem: jest.fn(async () => undefined) },
    sync: { sync: jest.fn(async () => undefined) },
    items: {
      isTemplateItem: () => false,
      getDisplayableTagParent: (candidate: { uuid: string }) => {
        const parentUuid = TAG_PARENTS[candidate.uuid]
        return parentUuid ? tagsByUuid.get(parentUuid) : undefined
      },
      getTagChildren: (parent: { uuid: string }) =>
        ALL_TAGS.filter((candidate) => TAG_PARENTS[candidate.uuid] === parent.uuid),
    },
  })

  return { controller, execute }
}

const uuidsOf = (items: { uuid: string }[]) => items.map((item) => item.uuid)

describe('hidden folders in the sidebar tree', () => {
  it('leaves a hidden root folder out of the root list', () => {
    const { controller } = buildController()

    expect(uuidsOf(controller.allLocalRootFolders)).toEqual(['f-shown'])
  })

  it('takes the whole subtree with it, even though the children carry no flag', () => {
    const { controller } = buildController()

    expect(uuidsOf(controller.getFolderChildren(HIDDEN_FOLDER as unknown as SNFolder))).toEqual([])
    expect(uuidsOf(controller.getFolderChildren(CHILD_OF_HIDDEN as unknown as SNFolder))).toEqual([])
    expect(controller.isFolderInHiddenSubtree(GRANDCHILD_OF_HIDDEN as unknown as SNFolder)).toBe(true)
  })

  it('still shows the children of a folder that is not hidden', () => {
    const { controller } = buildController()

    expect(uuidsOf(controller.getFolderChildren(SHOWN_FOLDER as unknown as SNFolder))).toEqual(['f-child-shown'])
  })

  it('distinguishes a folder the user hid from one that is only under a hidden parent', () => {
    const { controller } = buildController()

    expect(controller.isFolderHidden(HIDDEN_FOLDER as unknown as SNFolder)).toBe(true)
    expect(controller.isFolderHidden(CHILD_OF_HIDDEN as unknown as SNFolder)).toBe(false)
    expect(controller.isFolderInHiddenSubtree(CHILD_OF_HIDDEN as unknown as SNFolder)).toBe(true)
  })

  it('does not trim the complete folder set the organize surface lists', () => {
    const { controller } = buildController()

    expect(uuidsOf(controller.folders)).toHaveLength(ALL_FOLDERS.length)
  })
})

describe('hidden tags in the sidebar tree', () => {
  it('leaves hidden root tags out of the root list', () => {
    const { controller } = buildController()

    expect(uuidsOf(controller.allLocalRootTags)).toEqual(['t-shown', 't-starred-shown'])
  })

  it('leaves hidden tags and their subtree out of the flat list', () => {
    const { controller } = buildController()

    expect(uuidsOf(controller.allLocalFlatTags)).toEqual(['t-shown', 't-starred-shown'])
  })

  it('leaves the children of a hidden tag out of its child list', () => {
    const { controller } = buildController()

    expect(uuidsOf(controller.getChildren(HIDDEN_TAG as unknown as SNTag))).toEqual([])
  })

  it('leaves a favorited tag out of the flat favorites list when it is hidden', () => {
    const { controller } = buildController()

    expect(uuidsOf(controller.visibleStarredTags)).toEqual(['t-starred-shown'])
  })

  it('honours a flag that only exists in raw content, as a pre-rebuild snjs bundle leaves it', () => {
    const { controller } = buildController()

    expect(controller.isTagHidden(HIDDEN_VIA_CONTENT_TAG as unknown as SNTag)).toBe(true)
    expect(uuidsOf(controller.allLocalRootTags)).not.toContain('t-hidden-content')
  })

  it('counts what is hidden so the reveal control can say how much there is', () => {
    const { controller } = buildController()

    expect(controller.hiddenTagsCount).toBe(3)
    expect(controller.hiddenFoldersCount).toBe(1)
  })
})

describe('revealing hidden folders and tags', () => {
  it('puts the hidden rows back in both halves of the tree', () => {
    const { controller } = buildController()

    controller.setShowHiddenNavigationItems(true)

    expect(uuidsOf(controller.allLocalRootFolders)).toEqual(['f-shown', 'f-hidden'])
    expect(uuidsOf(controller.allLocalRootTags)).toContain('t-hidden')
    expect(uuidsOf(controller.allLocalRootTags)).toContain('t-hidden-content')
  })

  it('puts a revealed subtree back as well', () => {
    const { controller } = buildController()

    controller.setShowHiddenNavigationItems(true)

    expect(uuidsOf(controller.getFolderChildren(HIDDEN_FOLDER as unknown as SNFolder))).toEqual(['f-child-hidden'])
    expect(uuidsOf(controller.getChildren(HIDDEN_TAG as unknown as SNTag))).toEqual(['t-child-hidden'])
  })

  it('puts a hidden favorite back in the favorites list', () => {
    const { controller } = buildController()

    controller.setShowHiddenNavigationItems(true)

    expect(uuidsOf(controller.visibleStarredTags)).toEqual(['t-starred-shown', 't-starred-hidden'])
  })

  it('goes back to the tidy tree when the reveal is switched off again', () => {
    const { controller } = buildController()

    controller.setShowHiddenNavigationItems(true)
    controller.setShowHiddenNavigationItems(false)

    expect(uuidsOf(controller.allLocalRootFolders)).toEqual(['f-shown'])
  })
})

describe('marking a folder or tag hidden', () => {
  it('writes the flag into the content that gets saved', async () => {
    const { controller, execute } = buildController()

    await controller.setTagHidden(SHOWN_TAG as unknown as SNTag, true)

    expect(execute).toHaveBeenCalledTimes(1)
    const mutator = await execute.mock.results[0].value
    expect(mutator.mutableContent).toEqual({ hidden: true })
  })

  it('removes the flag rather than writing false when showing again', async () => {
    const { controller, execute } = buildController()

    await controller.setFolderHidden(HIDDEN_FOLDER as unknown as SNFolder, false)

    const mutator = await execute.mock.results[0].value
    expect('hidden' in mutator.mutableContent).toBe(false)
  })
})

describe('restoring a selection on startup', () => {
  const restore = (controller: NavigationController, uuid: string) => {
    ;(controller as unknown as { findAndSetTag: (uuid: string) => void }).findAndSetTag(uuid)
  }

  it('does not restore a hidden tag, because it would have no row to look selected', () => {
    const { controller } = buildController()
    const setSelectedTag = jest.spyOn(controller, 'setSelectedTag').mockResolvedValue(undefined)
    const selectHome = jest.spyOn(controller, 'selectHomeNavigationView').mockResolvedValue(undefined)

    restore(controller, 't-hidden')

    expect(selectHome).toHaveBeenCalledTimes(1)
    expect(setSelectedTag).not.toHaveBeenCalled()
  })

  it('does not restore a tag that is only hidden through its parent either', () => {
    const { controller } = buildController()
    const setSelectedTag = jest.spyOn(controller, 'setSelectedTag').mockResolvedValue(undefined)
    const selectHome = jest.spyOn(controller, 'selectHomeNavigationView').mockResolvedValue(undefined)

    restore(controller, 't-child-hidden')

    expect(selectHome).toHaveBeenCalledTimes(1)
    expect(setSelectedTag).not.toHaveBeenCalled()
  })

  it('restores an ordinary tag as before', () => {
    const { controller } = buildController()
    const setSelectedTag = jest.spyOn(controller, 'setSelectedTag').mockResolvedValue(undefined)
    const selectHome = jest.spyOn(controller, 'selectHomeNavigationView').mockResolvedValue(undefined)

    restore(controller, 't-shown')

    expect(setSelectedTag).toHaveBeenCalledTimes(1)
    expect(selectHome).not.toHaveBeenCalled()
  })

  it('restores a hidden tag while the reveal is on', () => {
    const { controller } = buildController()
    const setSelectedTag = jest.spyOn(controller, 'setSelectedTag').mockResolvedValue(undefined)
    controller.setShowHiddenNavigationItems(true)

    restore(controller, 't-hidden')

    expect(setSelectedTag).toHaveBeenCalledTimes(1)
  })
})

import Icon from '@/Components/Icon/Icon'
import { FOCUSABLE_BUT_NOT_TABBABLE, TAG_FOLDERS_FEATURE_NAME } from '@/Constants/Constants'
import { KeyboardKey } from '@standardnotes/ui-services'
import { FeaturesController } from '@/Controllers/FeaturesController'
import { NavigationController } from '@/Controllers/Navigation/NavigationController'
import { IconType, SNFolder, SNNote, DefaultFolderIconName } from '@standardnotes/snjs'
import { computed } from 'mobx'
import { observer } from 'mobx-react-lite'
import {
  DragEventHandler,
  FormEventHandler,
  FunctionComponent,
  KeyboardEventHandler,
  MouseEvent,
  MouseEventHandler,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { classNames } from '@standardnotes/utils'
import { LinkingController } from '@/Controllers/LinkingController'
import { TagListSectionType } from './TagListSection'
import { log, LoggingDomain } from '@/Logging'
import { NoteDragDataFormat, TagDragDataFormat } from './DragNDrop'
import { usePremiumModal } from '@/Hooks/usePremiumModal'
import { useApplication } from '../ApplicationProvider'

type Props = {
  folder: SNFolder
  navigationController: NavigationController
  features: FeaturesController
  linkingController: LinkingController
  level: number
  onContextMenu: (folder: SNFolder, posX: number, posY: number) => void
}

const PADDING_BASE_PX = 14
const PADDING_PER_LEVEL_PX = 21
const TYPE: TagListSectionType = 'folders'

export const FoldersListItem: FunctionComponent<Props> = observer(
  ({ folder, features, navigationController, level, onContextMenu, linkingController }) => {
    const application = useApplication()

    const [title, setTitle] = useState(folder.title || '')
    const [subfolderTitle, setSubfolderTitle] = useState('')

    const folderRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const subfolderInputRef = useRef<HTMLInputElement>(null)
    const menuButtonRef = useRef<HTMLAnchorElement>(null)

    const isContextMenuOpenForFolder =
      navigationController.contextMenuFolder === folder &&
      navigationController.contextMenuOpen &&
      navigationController.contextMenuTagSection === TYPE
    const isSelected =
      navigationController.selectedFolder === folder && navigationController.selectedLocation === TYPE
    const isEditing = navigationController.editingFolder === folder
    const isAddingSubfolder = navigationController.addingSubfolderTo === folder
    const noteCounts = computed(() => folder.noteCount)

    const childrenFolders = computed(() => navigationController.getFolderChildren(folder)).get()
    const hasChildren = childrenFolders.length > 0

    const displayIconType = (folder.iconString || DefaultFolderIconName) as IconType

    const hasFolders = features.hasFolders

    const premiumModal = usePremiumModal()

    const [showChildren, setShowChildren] = useState(folder.expanded)
    const [hadChildren, setHadChildren] = useState(hasChildren)

    const [isBeingDraggedOver, setIsBeingDraggedOver] = useState(false)

    const isTemplate = application.items.isTemplateItem(folder)

    useEffect(() => {
      if (!hadChildren && hasChildren) {
        setShowChildren(true)
      }
      setHadChildren(hasChildren)
    }, [hadChildren, hasChildren])

    useEffect(() => {
      setTitle(folder.title || '')
    }, [setTitle, folder])

    const setFolderExpanded = useCallback(
      (expanded: boolean) => {
        if (!hasChildren) {
          return
        }
        setShowChildren(expanded)
        navigationController.setFolderExpanded(folder, expanded)
      },
      [hasChildren, navigationController, folder],
    )

    const toggleChildren = useCallback(
      (e?: MouseEvent) => {
        e?.stopPropagation()
        setFolderExpanded(!showChildren)
      },
      [showChildren, setFolderExpanded],
    )

    useEffect(() => {
      setShowChildren(folder.expanded)
    }, [folder])

    const selectCurrentFolder = useCallback(async () => {
      if (isTemplate) {
        return
      }
      await navigationController.setSelectedFolder(folder, {
        userTriggered: true,
        scrollIntoView: false,
      })
    }, [navigationController, folder, isTemplate])

    const onBlur = useCallback(() => {
      if (isTemplate) {
        navigationController.createFolder(title).catch(console.error)
      } else {
        navigationController.renameFolder(folder, title).catch(console.error)
        setTitle(folder.title)
      }
    }, [navigationController, folder, title, isTemplate])

    const onInput: FormEventHandler = useCallback((e) => {
      setTitle((e.target as HTMLInputElement).value)
    }, [])

    const onKeyDown: KeyboardEventHandler = useCallback((e) => {
      if (e.key === KeyboardKey.Enter) {
        inputRef.current?.blur()
        e.preventDefault()
      }
    }, [])

    useEffect(() => {
      if (isEditing) {
        inputRef.current?.focus()
      }
    }, [isEditing])

    const onSubfolderInput: FormEventHandler<HTMLInputElement> = useCallback((e) => {
      setSubfolderTitle((e.target as HTMLInputElement).value)
    }, [])

    const onSubfolderInputBlur = useCallback(() => {
      navigationController.createFolder(subfolderTitle, folder).catch(console.error)
      setSubfolderTitle('')
    }, [subfolderTitle, folder, navigationController])

    const onSubfolderKeyDown: KeyboardEventHandler = useCallback((e) => {
      if (e.key === KeyboardKey.Enter) {
        e.preventDefault()
        subfolderInputRef.current?.blur()
      }
    }, [])

    useEffect(() => {
      if (isAddingSubfolder) {
        subfolderInputRef.current?.focus()
      }
    }, [isAddingSubfolder])

    const toggleContextMenu: MouseEventHandler<HTMLAnchorElement> = useCallback(
      (event) => {
        event.preventDefault()
        event.stopPropagation()

        if (!menuButtonRef.current) {
          return
        }

        const contextMenuOpen = navigationController.contextMenuOpen
        const menuButtonRect = menuButtonRef.current?.getBoundingClientRect()

        if (contextMenuOpen) {
          navigationController.setContextMenuOpen(false)
        } else {
          onContextMenu(folder, menuButtonRect.right, menuButtonRect.top)
        }
      },
      [navigationController, onContextMenu, folder],
    )

    log(LoggingDomain.NavigationList, 'Rendering FoldersListItem')

    const onDragStart: DragEventHandler<HTMLDivElement> = useCallback(
      (event) => {
        if (isTemplate) {
          return
        }
        event.dataTransfer.setData(TagDragDataFormat, folder.uuid)
      },
      [folder.uuid, isTemplate],
    )

    const onDragEnter: DragEventHandler<HTMLDivElement> = useCallback((event): void => {
      const isFolderDrag = event.dataTransfer.types.includes(TagDragDataFormat)
      const isNoteDrag = event.dataTransfer.types.includes(NoteDragDataFormat)
      if (isFolderDrag || isNoteDrag) {
        event.preventDefault()
        setIsBeingDraggedOver(true)
      }
    }, [])

    const removeDragIndicator = useCallback(() => {
      setIsBeingDraggedOver(false)
    }, [])

    const onDragOver: DragEventHandler<HTMLDivElement> = useCallback((event): void => {
      const isFolderDrag = event.dataTransfer.types.includes(TagDragDataFormat)
      const isNoteDrag = event.dataTransfer.types.includes(NoteDragDataFormat)
      if (isFolderDrag || isNoteDrag) {
        event.preventDefault()
      }
    }, [])

    const onDrop: DragEventHandler<HTMLDivElement> = useCallback(
      async (event) => {
        setIsBeingDraggedOver(false)
        const draggedFolderUuid = event.dataTransfer.getData(TagDragDataFormat)
        const draggedNoteUuid = event.dataTransfer.getData(NoteDragDataFormat)
        if (draggedFolderUuid) {
          if (draggedFolderUuid === folder.uuid) {
            return
          }
          if (!hasFolders) {
            premiumModal.activate(TAG_FOLDERS_FEATURE_NAME)
            return
          }
          // Dropping a folder onto a folder re-parents it.
          void navigationController.assignFolderParent(draggedFolderUuid, folder.uuid)
          return
        } else if (draggedNoteUuid) {
          const note = application.items.findSureItem<SNNote>(draggedNoteUuid)
          // Dropping a note on a folder MOVES it there — a note lives in one folder.
          await navigationController.moveNoteToFolder(note, folder)
          return
        }
      },
      [application.items, hasFolders, navigationController, premiumModal, folder],
    )

    return (
      <>
        <div
          role="button"
          tabIndex={FOCUSABLE_BUT_NOT_TABBABLE}
          className={classNames(
            'tag group relative px-3.5 py-0.5 focus-visible:!shadow-inner md:py-0',
            (isSelected || isContextMenuOpenForFolder) && 'selected',
            isBeingDraggedOver && 'is-drag-over',
          )}
          onClick={selectCurrentFolder}
          onKeyDown={(event) => {
            if (event.key === KeyboardKey.Enter || event.key === KeyboardKey.Space) {
              selectCurrentFolder().catch(console.error)
            } else if (event.key === KeyboardKey.Left) {
              setFolderExpanded(false)
            } else if (event.key === KeyboardKey.Right) {
              setFolderExpanded(true)
            }
          }}
          ref={folderRef}
          style={{
            paddingLeft: `${level * PADDING_PER_LEVEL_PX + PADDING_BASE_PX}px`,
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            onContextMenu(folder, e.clientX, e.clientY)
          }}
          draggable={!isTemplate}
          onDragStart={onDragStart}
          onDragEnter={onDragEnter}
          onDragExit={removeDragIndicator}
          onDragOver={onDragOver}
          onDragLeave={removeDragIndicator}
          onDrop={onDrop}
        >
          {folder.color && (
            <div
              className="absolute bottom-0 left-0 top-0 w-1 rounded-r"
              style={{ backgroundColor: folder.color }}
              aria-hidden="true"
            />
          )}
          <div className="tag-info" title={title}>
            <div
              onClick={selectCurrentFolder}
              className={'tag-icon draggable mr-2'}
              style={folder.color ? { color: folder.color } : undefined}
            >
              <Icon
                type={displayIconType}
                className={classNames(
                  'cursor-pointer',
                  folder.color ? 'fill-current' : isSelected ? 'text-info' : 'text-neutral group-hover:text-text',
                )}
              />
            </div>

            {isEditing && (
              <input
                className="title editing min-w-0 overflow-hidden text-mobile-navigation-list-item focus:shadow-none focus:outline-none lg:text-navigation-list-item"
                id={`react-folder-${folder.uuid}`}
                onBlur={onBlur}
                onInput={onInput}
                value={title}
                onKeyDown={onKeyDown}
                spellCheck={false}
                ref={inputRef}
              />
            )}

            {!isEditing && (
              <div
                className="title overflow-hidden text-left text-mobile-navigation-list-item focus:shadow-none focus:outline-none lg:text-navigation-list-item"
                id={`react-folder-${folder.uuid}`}
              >
                {title}
              </div>
            )}

            <div className="flex items-center">
              {isSelected && (
                <a
                  role="button"
                  className={'mr-2 cursor-pointer border-0 bg-transparent hover:bg-contrast focus:shadow-inner'}
                  onClick={toggleContextMenu}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                  }}
                  ref={menuButtonRef}
                >
                  <Icon type="more" className="text-neutral" />
                </a>
              )}

              {hasChildren && (
                <a
                  role="button"
                  className={`focus:shadow-inner ${showChildren ? 'cursor-n-resize' : 'cursor-s-resize'} ${
                    showChildren ? 'opened' : 'closed'
                  } `}
                  onClick={toggleChildren}
                >
                  <Icon
                    className={'text-neutral'}
                    size="large"
                    type={showChildren ? 'menu-arrow-down-alt' : 'menu-arrow-right'}
                  />
                </a>
              )}
              <div
                onClick={hasChildren ? toggleChildren : undefined}
                className={`count text-base lg:text-sm ${
                  hasChildren ? (showChildren ? 'cursor-n-resize' : 'cursor-s-resize') : ''
                }`}
              >
                {noteCounts.get()}
              </div>
            </div>
          </div>
        </div>
        {isAddingSubfolder && (
          <div
            className="tag overflow-hidden"
            style={{
              paddingLeft: `${(level + 1) * PADDING_PER_LEVEL_PX + PADDING_BASE_PX}px`,
            }}
          >
            <div className="tag-info">
              <div className="flex h-full min-w-[22px] items-center border-0 bg-transparent p-0" />
              <div className="tag-icon mr-1">
                <Icon type="folder" className="mr-1 text-neutral" />
              </div>
              <input
                className="title w-full text-mobile-navigation-list-item focus:shadow-none focus:outline-none lg:text-navigation-list-item"
                type="text"
                ref={subfolderInputRef}
                onBlur={onSubfolderInputBlur}
                onKeyDown={onSubfolderKeyDown}
                value={subfolderTitle}
                onInput={onSubfolderInput}
              />
            </div>
          </div>
        )}
        {showChildren && (
          <>
            {childrenFolders.map((child) => {
              return (
                <FoldersListItem
                  level={level + 1}
                  key={child.uuid}
                  folder={child}
                  navigationController={navigationController}
                  features={features}
                  linkingController={linkingController}
                  onContextMenu={onContextMenu}
                />
              )
            })}
          </>
        )}
      </>
    )
  },
)

FoldersListItem.displayName = 'FoldersListItem'

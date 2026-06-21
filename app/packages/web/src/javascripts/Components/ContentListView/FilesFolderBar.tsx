import { observer } from 'mobx-react-lite'
import { FunctionComponent, useCallback, useMemo, useRef, useState } from 'react'
import { classNames, FileItem, SNFolder } from '@standardnotes/snjs'
import { KeyboardKey } from '@standardnotes/ui-services'
import Icon from '../Icon/Icon'
import { NavigationController } from '@/Controllers/Navigation/NavigationController'

export const FilesFolderFilterAll = 'all'
export const FilesFolderFilterNone = 'none'

/**
 * The active Files-section folder filter:
 *  - 'all'  → every file
 *  - 'none' → virtual "No folder" entry: files not referenced by any folder
 *  - a folder uuid → files referenced by that folder
 */
export type FilesFolderFilter = typeof FilesFolderFilterAll | typeof FilesFolderFilterNone | string

type FolderListEntry = {
  folder: SNFolder
  depth: number
}

type Props = {
  navigationController: NavigationController
  activeFilter: FilesFolderFilter
  onChange: (filter: FilesFolderFilter) => void
}

const FilesFolderBar: FunctionComponent<Props> = ({ navigationController, activeFilter, onChange }) => {
  const [isCreating, setIsCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const folderEntries = useMemo<FolderListEntry[]>(() => {
    const entries: FolderListEntry[] = []
    const visit = (folder: SNFolder, depth: number) => {
      entries.push({ folder, depth })
      for (const child of navigationController.getFolderChildren(folder)) {
        visit(child, depth + 1)
      }
    }
    for (const root of navigationController.allLocalRootFolders) {
      visit(root, 0)
    }
    return entries
  }, [navigationController, navigationController.folders, navigationController.allLocalRootFolders])

  const submitCreate = useCallback(
    async (title: string) => {
      const trimmed = title.trim()
      setIsCreating(false)
      if (trimmed.length === 0) {
        return
      }
      await navigationController.createFolder(trimmed)
    },
    [navigationController],
  )

  const chipClass = (active: boolean) =>
    classNames(
      // Comfortable tap target on touch screens (min-h ~40px); compact on desktop.
      'flex min-h-[2.25rem] flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-sm pointer-coarse:min-h-[2.5rem]',
      active ? 'border-info bg-info text-info-contrast' : 'border-border bg-default text-text hover:bg-contrast',
    )

  return (
    <div className="flex items-center gap-2 overflow-x-auto overscroll-x-contain border-b border-border px-3 py-2">
      <button className={chipClass(activeFilter === FilesFolderFilterAll)} onClick={() => onChange(FilesFolderFilterAll)}>
        <Icon type="files" className="h-4 w-4" />
        All Files
      </button>
      <button
        className={chipClass(activeFilter === FilesFolderFilterNone)}
        onClick={() => onChange(FilesFolderFilterNone)}
      >
        <Icon type="close" className="h-4 w-4" />
        No folder
      </button>
      {folderEntries.map(({ folder, depth }) => (
        <button
          key={folder.uuid}
          className={chipClass(activeFilter === folder.uuid)}
          onClick={() => onChange(folder.uuid)}
          title={folder.title}
        >
          <span style={{ width: `${depth * 0.5}rem` }} className="flex-shrink-0" aria-hidden />
          <Icon type="folder" className="h-4 w-4" />
          <span className="max-w-[10rem] overflow-hidden overflow-ellipsis whitespace-nowrap">{folder.title}</span>
        </button>
      ))}
      {isCreating ? (
        <input
          ref={inputRef}
          className="min-h-[2.25rem] flex-shrink-0 rounded-full border border-info bg-default px-3 py-1 text-sm pointer-coarse:min-h-[2.5rem]"
          placeholder="Folder name"
          autoFocus
          onKeyDown={(event) => {
            if (event.key === KeyboardKey.Enter) {
              event.preventDefault()
              void submitCreate(event.currentTarget.value)
            } else if (event.key === KeyboardKey.Escape) {
              setIsCreating(false)
            }
          }}
          onBlur={(event) => {
            void submitCreate(event.currentTarget.value)
          }}
        />
      ) : (
        <button
          className="flex min-h-[2.25rem] flex-shrink-0 items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1 text-sm text-neutral hover:bg-contrast pointer-coarse:min-h-[2.5rem]"
          onClick={() => setIsCreating(true)}
          title="Create a new folder"
        >
          <Icon type="add" className="h-4 w-4" />
          New folder
        </button>
      )}
    </div>
  )
}

/** Filter a list of items by the active Files-section folder filter (client-side, "No folder" is virtual). */
export const filterItemsByFolder = (
  items: { uuid: string }[],
  filter: FilesFolderFilter,
  navigationController: NavigationController,
): { uuid: string }[] => {
  if (filter === FilesFolderFilterAll) {
    return items
  }

  if (filter === FilesFolderFilterNone) {
    return items.filter((item) => {
      // A file is "unfiled" if no folder references it. Non-file items (notes use noteReferences) are left as-is.
      if (!(item instanceof FileItem)) {
        return true
      }
      return !navigationController.folders.some((folder) => folder.isReferencingItem(item))
    })
  }

  const folder = navigationController.folders.find((candidate) => candidate.uuid === filter)
  if (!folder) {
    return items
  }
  return items.filter((item) => folder.isReferencingItem(item))
}

export default observer(FilesFolderBar)

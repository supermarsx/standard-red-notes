import { observer } from 'mobx-react-lite'
import { useCallback, useMemo, useState } from 'react'
import { confirmDialog } from '@standardnotes/ui-services'
import Modal, { ModalAction } from '@/Components/Modal/Modal'
import ModalOverlay from '@/Components/Modal/ModalOverlay'
import Icon from '@/Components/Icon/Icon'
import { useApplication } from '../ApplicationProvider'

type Tab = 'folders' | 'tags'

type Props = {
  isOpen: boolean
  close: () => void
}

const BulkOrganizeModal = ({ isOpen, close }: Props) => {
  const application = useApplication()
  const navigationController = application.navigationController

  const [tab, setTab] = useState<Tab>('folders')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editingUuid, setEditingUuid] = useState<string | undefined>(undefined)
  const [editingValue, setEditingValue] = useState('')

  const switchTab = useCallback((nextTab: Tab) => {
    setTab(nextTab)
    setSelected(new Set())
    setFilter('')
    setEditingUuid(undefined)
  }, [])

  const folders = navigationController.folders
  const tags = navigationController.tags

  const folderTitleByUuid = useMemo(() => {
    const map = new Map<string, string>()
    folders.forEach((folder) => map.set(folder.uuid, folder.title))
    return map
  }, [folders])

  type Row = {
    uuid: string
    title: string
    parentUuid: string | undefined
    parentTitle: string
    noteCount: number
  }

  const rows: Row[] = useMemo(() => {
    if (tab === 'folders') {
      return folders.map((folder) => ({
        uuid: folder.uuid,
        title: folder.title,
        parentUuid: folder.parentId,
        parentTitle: folder.parentId ? folderTitleByUuid.get(folder.parentId) ?? '' : '',
        noteCount: folder.noteReferences.length,
      }))
    }
    return tags.map((tag) => {
      const parent = navigationController.getTagParentForDisplay(tag)
      return {
        uuid: tag.uuid,
        title: tag.title,
        parentUuid: parent?.uuid,
        parentTitle: parent?.title ?? '',
        noteCount: navigationController.getNotesCount(tag),
      }
    })
  }, [tab, folders, tags, folderTitleByUuid, navigationController])

  const visibleRows = useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (query.length === 0) {
      return rows
    }
    return rows.filter((row) => row.title.toLowerCase().includes(query))
  }, [rows, filter])

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((row) => selected.has(row.uuid))

  const toggleRow = useCallback((uuid: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(uuid)) {
        next.delete(uuid)
      } else {
        next.add(uuid)
      }
      return next
    })
  }, [])

  const toggleSelectAllVisible = useCallback(() => {
    setSelected((previous) => {
      const next = new Set(previous)
      const everySelected = visibleRows.length > 0 && visibleRows.every((row) => next.has(row.uuid))
      if (everySelected) {
        visibleRows.forEach((row) => next.delete(row.uuid))
      } else {
        visibleRows.forEach((row) => next.add(row.uuid))
      }
      return next
    })
  }, [visibleRows])

  const selectDuplicates = useCallback(() => {
    const seen = new Set<string>()
    const duplicates = new Set<string>()
    rows.forEach((row) => {
      const key = `${(row.parentUuid ?? '').toLowerCase()}::${row.title.trim().toLowerCase()}`
      if (seen.has(key)) {
        duplicates.add(row.uuid)
      } else {
        seen.add(key)
      }
    })
    setSelected(duplicates)
  }, [rows])

  const beginEdit = useCallback((row: Row) => {
    setEditingUuid(row.uuid)
    setEditingValue(row.title)
  }, [])

  const commitEdit = useCallback(
    async (uuid: string) => {
      const newTitle = editingValue
      setEditingUuid(undefined)
      if (tab === 'folders') {
        const folder = folders.find((candidate) => candidate.uuid === uuid)
        if (folder) {
          await navigationController.renameFolder(folder, newTitle)
        }
      } else {
        const tag = tags.find((candidate) => candidate.uuid === uuid)
        if (tag) {
          await navigationController.save(tag, newTitle.trim())
        }
      }
    },
    [editingValue, tab, folders, tags, navigationController],
  )

  const deleteSingle = useCallback(
    async (uuid: string) => {
      const confirmed = await confirmDialog({
        title: 'Delete item',
        text: 'Are you sure you want to delete this item? This action cannot be undone.',
        confirmButtonStyle: 'danger',
      })
      if (!confirmed) {
        return
      }
      if (tab === 'folders') {
        const folder = folders.find((candidate) => candidate.uuid === uuid)
        if (folder) {
          await navigationController.bulkDeleteFolders([folder])
        }
      } else {
        const tag = tags.find((candidate) => candidate.uuid === uuid)
        if (tag) {
          await navigationController.bulkDeleteTags([tag])
        }
      }
      setSelected((previous) => {
        const next = new Set(previous)
        next.delete(uuid)
        return next
      })
    },
    [tab, folders, tags, navigationController],
  )

  const deleteSelected = useCallback(async () => {
    const uuids = Array.from(selected)
    if (uuids.length === 0) {
      return
    }
    const confirmed = await confirmDialog({
      title: 'Delete selected',
      text: `Are you sure you want to delete ${uuids.length} item(s)? This action cannot be undone.`,
      confirmButtonStyle: 'danger',
    })
    if (!confirmed) {
      return
    }
    if (tab === 'folders') {
      const targets = folders.filter((folder) => selected.has(folder.uuid))
      await navigationController.bulkDeleteFolders(targets)
    } else {
      const targets = tags.filter((tag) => selected.has(tag.uuid))
      await navigationController.bulkDeleteTags(targets)
    }
    setSelected(new Set())
  }, [selected, tab, folders, tags, navigationController])

  const moveSelected = useCallback(
    async (parentUuid: string | undefined) => {
      const uuids = selected
      if (uuids.size === 0) {
        return
      }
      if (tab === 'folders') {
        const targets = folders.filter((folder) => uuids.has(folder.uuid))
        await navigationController.bulkMoveFolders(targets, parentUuid)
      } else {
        const targets = tags.filter((tag) => uuids.has(tag.uuid))
        await navigationController.bulkMoveTags(targets, parentUuid)
      }
      setSelected(new Set())
    },
    [selected, tab, folders, tags, navigationController],
  )

  const moveOptions = useMemo(() => {
    const source: { uuid: string; title: string }[] =
      tab === 'folders'
        ? folders.map((folder) => ({ uuid: folder.uuid, title: folder.title }))
        : tags.map((tag) => ({ uuid: tag.uuid, title: tag.title }))
    return source.filter((option) => !selected.has(option.uuid))
  }, [tab, folders, tags, selected])

  const actions: ModalAction[] = useMemo(
    () => [
      {
        label: 'Done',
        type: 'cancel',
        onClick: close,
        mobileSlot: 'left',
      },
    ],
    [close],
  )

  const selectedCount = selected.size

  return (
    <ModalOverlay isOpen={isOpen} close={close}>
      <Modal title="Organize folders & tags" close={close} actions={actions} className="flex flex-col">
        <div className="flex flex-col px-4 py-3">
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              className={`rounded px-3 py-1.5 text-sm font-semibold ${
                tab === 'folders' ? 'bg-info text-info-contrast' : 'bg-default text-text'
              }`}
              onClick={() => switchTab('folders')}
            >
              Folders
            </button>
            <button
              type="button"
              className={`rounded px-3 py-1.5 text-sm font-semibold ${
                tab === 'tags' ? 'bg-info text-info-contrast' : 'bg-default text-text'
              }`}
              onClick={() => switchTab('tags')}
            >
              Tags
            </button>
          </div>

          <div className="mb-3 flex items-center gap-2">
            <input
              className="flex-grow rounded border border-border bg-default px-3 py-1.5 text-sm text-text"
              placeholder="Filter by title…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button
              type="button"
              className="whitespace-nowrap rounded border border-border bg-default px-3 py-1.5 text-sm text-text hover:bg-contrast"
              onClick={selectDuplicates}
            >
              Select duplicates
            </button>
          </div>

          {selectedCount > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded bg-contrast px-3 py-2">
              <span className="text-sm font-semibold">{selectedCount} selected</span>
              <label className="flex items-center gap-1 text-sm">
                Move to
                <select
                  className="rounded border border-border bg-default px-2 py-1 text-sm text-text"
                  value=""
                  onChange={(event) => {
                    const value = event.target.value
                    void moveSelected(value === '' ? undefined : value)
                    event.target.value = ''
                  }}
                >
                  <option value="__placeholder__" disabled>
                    Move to…
                  </option>
                  <option value="">Root (no parent)</option>
                  {moveOptions.map((option) => (
                    <option key={option.uuid} value={option.uuid}>
                      {option.title}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="rounded bg-danger px-3 py-1 text-sm font-semibold text-danger-contrast"
                onClick={() => void deleteSelected()}
              >
                Delete selected
              </button>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-grow overflow-y-auto px-4 pb-4">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-passive-0">
                <th className="w-8 py-2">
                  <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAllVisible} />
                </th>
                <th className="py-2">Title</th>
                <th className="py-2">Parent</th>
                <th className="w-16 py-2 text-right">Notes</th>
                <th className="w-10 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.uuid} className="border-b border-border">
                  <td className="py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(row.uuid)}
                      onChange={() => toggleRow(row.uuid)}
                    />
                  </td>
                  <td className="py-2">
                    {editingUuid === row.uuid ? (
                      <input
                        autoFocus
                        className="w-full rounded border border-border bg-default px-2 py-1 text-sm text-text"
                        value={editingValue}
                        onChange={(event) => setEditingValue(event.target.value)}
                        onBlur={() => void commitEdit(row.uuid)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            void commitEdit(row.uuid)
                          } else if (event.key === 'Escape') {
                            setEditingUuid(undefined)
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="cursor-text text-left text-text hover:underline"
                        onClick={() => beginEdit(row)}
                      >
                        {row.title || '(untitled)'}
                      </button>
                    )}
                  </td>
                  <td className="py-2 text-passive-0">{row.parentTitle || '—'}</td>
                  <td className="py-2 text-right text-passive-0">{row.noteCount}</td>
                  <td className="py-2">
                    <button
                      type="button"
                      title="Delete"
                      className="flex items-center text-danger"
                      onClick={() => void deleteSingle(row.uuid)}
                    >
                      <Icon type="trash-filled" />
                    </button>
                  </td>
                </tr>
              ))}
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-passive-0">
                    No {tab} to show.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Modal>
    </ModalOverlay>
  )
}

export default observer(BulkOrganizeModal)

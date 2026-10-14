import type { WebApplication } from '@/Application/WebApplication'
import { isNote } from '@standardnotes/snjs'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import Button from '../Button/Button'

const TrashActionsBar = ({ application }: { application: WebApplication }) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const notes = application.itemListController.items.filter((item) => isNote(item) && item.trashed)
  const selected = application.notesController.selectedNotes.filter((note) => note.trashed)
  const allTrash = application.items.trashedItems
  const unavailable = (note: (typeof allTrash)[number]) => {
    const vault = application.vaults.getItemVault(note)
    return (
      note.locked ||
      !application.isAuthorizedToRenderItem(note) ||
      (vault?.isSharedVaultListing() && application.vaultUsers.isCurrentUserReadonlyVaultMember(vault))
    )
  }
  const perform = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch {
      setError('The Trash action could not finish. Your remaining notes are still in Trash.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div aria-label="Trash actions" className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <span className="text-passive-1 text-xs">{selected.length} selected</span>
      <Button
        small
        label="Select all"
        disabled={busy || !notes.length}
        onClick={() => {
          void application.itemListController.selectUuids(
            notes.filter((note) => !note.protected).map((note) => note.uuid),
            true,
          )
        }}
      />
      <Button
        small
        label="Restore selected"
        disabled={busy || !selected.length || selected.some(unavailable)}
        onClick={() => void perform(() => application.notesController.setTrashSelectedNotes(false))}
      />
      <Button
        small
        label="Delete selected permanently"
        disabled={busy || !selected.length || selected.some(unavailable)}
        onClick={() => void perform(() => application.notesController.deleteNotesPermanently())}
      />
      <Button
        small
        label="Empty trash"
        disabled={busy || !allTrash.length || allTrash.some(unavailable)}
        onClick={() => void perform(() => application.notesController.emptyTrash())}
      />
      {error && (
        <p role="alert" className="text-danger text-xs">
          {error}
        </p>
      )}
    </div>
  )
}

export default observer(TrashActionsBar)

import { SNNote } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'
import { useCallback } from 'react'
import Icon from '../Icon/Icon'
import MenuItem from '../Menu/MenuItem'
import MenuSection from '../Menu/MenuSection'
import { iconClass } from './ClassNames'

type Props = {
  note: SNNote
  closeMenu: () => void
}

/**
 * Export actions for the Spreadsheet (`NoteType.Spreadsheet`) note type. The
 * spreadsheet editor itself is an iframe component, so these live in the note
 * options menu. The `xlsx` / `docx` libraries are lazy-loaded inside the
 * helpers so they are code-split out of the main bundle.
 */
const SpreadsheetNoteOptions = ({ note, closeMenu }: Props) => {
  const exportToExcel = useCallback(() => {
    import('@/Utils/Spreadsheet/exportSpreadsheet')
      .then(({ exportSpreadsheetNoteToXLSX }) => exportSpreadsheetNoteToXLSX(note.text, note.title))
      .catch((error) => {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to export spreadsheet to Excel.' })
      })
    closeMenu()
  }, [note.text, note.title, closeMenu])

  const exportToWord = useCallback(() => {
    import('@/Utils/Spreadsheet/exportSpreadsheet')
      .then(({ exportSpreadsheetNoteToDOCX }) => exportSpreadsheetNoteToDOCX(note.text, note.title))
      .catch((error) => {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to export spreadsheet to Word.' })
      })
    closeMenu()
  }, [note.text, note.title, closeMenu])

  return (
    <MenuSection>
      <MenuItem onClick={exportToExcel}>
        <Icon type="download" className={iconClass} />
        Export to Excel (.xlsx)
      </MenuItem>
      <MenuItem onClick={exportToWord}>
        <Icon type="download" className={iconClass} />
        Export to Word (.docx)
      </MenuItem>
    </MenuSection>
  )
}

export default SpreadsheetNoteOptions

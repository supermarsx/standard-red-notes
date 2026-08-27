import Icon from '@/Components/Icon/Icon'
import { classNames } from '@standardnotes/snjs'
import { useRef } from 'react'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'

type Props = {
  isDailyEntry: boolean
  addButtonLabel: string
  addNewItem: () => void
}

/**
 * The notes list's add button. It used to grow a menu (folder upload, camera
 * capture) when the Files smart view was selected; that view is gone and those
 * actions live in the Files tab's Upload menu, so this is only ever the plain
 * primary add action now.
 */
const AddItemMenuButton = ({ isDailyEntry, addButtonLabel, addNewItem }: Props) => {
  const addItemButtonRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <StyledTooltip label={addButtonLabel}>
        <button
          className={classNames(
            'z-editor-title-bar hidden h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-solid border-transparent hover:brightness-125 md:flex',
            isDailyEntry ? 'bg-danger text-danger-contrast' : 'bg-info text-info-contrast',
          )}
          aria-label={addButtonLabel}
          onClick={addNewItem}
          ref={addItemButtonRef}
        >
          <Icon type="add" size="custom" className="h-5 w-5" />
        </button>
      </StyledTooltip>
    </>
  )
}

export default AddItemMenuButton

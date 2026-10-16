import { useRef, useState } from 'react'
import type { LexicalEditor } from 'lexical'
import Icon from '@/Components/Icon/Icon'
import Menu from '@/Components/Menu/Menu'
import MenuItem from '@/Components/Menu/MenuItem'
import Popover from '@/Components/Popover/Popover'
import { UPLOAD_AND_INSERT_FILE_COMMAND } from '../Commands'
import { pasteAsImage } from './clipboardActions'
import ToolbarButton from './ToolbarButton'

/** One large ribbon control, with the same labelled menu rows as other insert actions. */
export default function InsertImagesButton({ editor, fromUrl }: { editor: LexicalEditor; fromUrl: () => void }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const close = () => setOpen(false)
  const perform = (action: () => void) => {
    close()
    if (editor.isEditable()) {
      action()
    }
  }
  return (
    <>
      <ToolbarButton
        ref={anchor}
        name="Insert image"
        aria-label="Insert image"
        aria-haspopup="menu"
        aria-expanded={open}
        active={open}
        onSelect={() => setOpen(!open)}
        className="h-20 min-w-20 md:h-[7.375rem] [&>div]:h-full"
      >
        <span className="flex h-full flex-col items-center justify-center gap-1.5 px-1">
          <Icon type="image" size="custom" className="h-8 w-8" />
          <span className="text-xs">Image</span>
          <Icon type="chevron-down" size="small" />
        </span>
      </ToolbarButton>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        aria-label="Image file"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file?.type.startsWith('image/') && editor.isEditable()) {
            editor.dispatchCommand(UPLOAD_AND_INSERT_FILE_COMMAND, file)
          }
          event.target.value = ''
        }}
      />
      <Popover
        title="Insert image"
        anchorElement={anchor}
        open={open}
        togglePopover={() => setOpen(!open)}
        side="bottom"
        align="start"
        portal
        disableMobileFullscreenTakeover
        containerClassName="md:!min-w-48 md:!w-auto"
      >
        <Menu
          a11yLabel="Image insertion options"
          closeMenu={() => {
            close()
            anchor.current?.focus()
          }}
          className="py-1"
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <MenuItem onClick={() => perform(fromUrl)}>
            <Icon type="link" size="medium" className="mr-2" />
            From URL
          </MenuItem>
          <MenuItem onClick={() => perform(() => fileInput.current?.click())}>
            <Icon type="file" size="medium" className="mr-2" />
            From file
          </MenuItem>
          <MenuItem onClick={() => perform(() => void pasteAsImage(editor))}>
            <Icon type="clipboard" size="medium" className="mr-2" />
            From clipboard
          </MenuItem>
        </Menu>
      </Popover>
    </>
  )
}

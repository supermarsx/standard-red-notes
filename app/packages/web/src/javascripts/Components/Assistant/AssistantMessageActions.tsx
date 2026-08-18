import { ReactNode, RefObject, useCallback, useRef, useState } from 'react'
import { classNames } from '@standardnotes/utils'

import Icon from '@/Components/Icon/Icon'
import Menu from '@/Components/Menu/Menu'
import MenuItem from '@/Components/Menu/MenuItem'
import Popover from '@/Components/Popover/Popover'
import { useContextMenuEvent } from '@/Hooks/useContextMenuEvent'
import { copyTextToClipboard } from '@/Utils/copyTextToClipboard'
import { parseAssistantDirectivePrompt } from '@/Assistant/assistantDirectives'

export type AssistantMessageActionTarget = {
  id: string
  kind: 'user' | 'assistant' | 'error'
  text: string
  streaming?: boolean
}

type MenuAnchor = { kind: 'element' } | { kind: 'point'; x: number; y: number }

type Props = {
  message: AssistantMessageActionTarget
  children: (messageTextRef: RefObject<HTMLDivElement | null>) => ReactNode
  onRemoveMessage: (messageId: string) => void | Promise<void>
}

export function assistantMessageTextForCopy(message: AssistantMessageActionTarget): string {
  if (message.kind !== 'user') {
    return message.text
  }

  const directive = parseAssistantDirectivePrompt(message.text)
  if (!directive) {
    return message.text
  }

  return [
    directive.instruction,
    directive.selectedText,
    ...(directive.selectionTruncated ? ['Selection truncated.'] : []),
  ].join('\n\n')
}

export default function AssistantMessageActions({ message, children, onRemoveMessage }: Props) {
  const messageRef = useRef<HTMLDivElement>(null)
  const messageTextRef = useRef<HTMLDivElement>(null)
  const optionsButtonRef = useRef<HTMLButtonElement>(null)
  const invokerRef = useRef<HTMLElement | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor>()

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenuAnchor(undefined)
    if (restoreFocus) {
      invokerRef.current?.focus({ preventScroll: true })
    }
  }, [])

  const openAtPoint = useCallback((x: number, y: number) => {
    const invoker = messageRef.current
    if (!invoker) {
      return
    }
    invokerRef.current = invoker
    invoker.focus({ preventScroll: true })
    setMenuAnchor({ kind: 'point', x, y })
  }, [])

  useContextMenuEvent(messageRef, openAtPoint)

  const openFromKeyboard = useCallback(() => {
    const invoker = messageRef.current
    if (!invoker) {
      return
    }
    const rect = invoker.getBoundingClientRect()
    invokerRef.current = invoker
    setMenuAnchor({ kind: 'point', x: rect.left + Math.min(rect.width, 24), y: rect.top + Math.min(rect.height, 24) })
  }, [])

  const toggleOptionsMenu = useCallback(() => {
    if (menuAnchor) {
      closeMenu(false)
      return
    }
    invokerRef.current = optionsButtonRef.current
    setMenuAnchor({ kind: 'element' })
  }, [closeMenu, menuAnchor])

  const selectMessageText = useCallback(() => {
    const textElement = messageTextRef.current
    const selection = window.getSelection()
    if (!textElement || !selection) {
      closeMenu(true)
      return
    }

    closeMenu(true)
    const range = document.createRange()
    range.selectNodeContents(textElement)
    selection.removeAllRanges()
    selection.addRange(range)
  }, [closeMenu])

  const copyText = assistantMessageTextForCopy(message)
  const canRemove = !(message.kind === 'assistant' && message.streaming)
  const menu = (
    <Menu role="menu" a11yLabel="Message context menu" closeMenu={() => closeMenu(true)}>
      <MenuItem
        icon="copy"
        disabled={copyText.length === 0}
        onClick={() => {
          copyTextToClipboard(copyText, 'Message copied')
          closeMenu(true)
        }}
      >
        Copy message
      </MenuItem>
      <MenuItem icon="editor" disabled={copyText.length === 0} onClick={selectMessageText}>
        Select all
      </MenuItem>
      <MenuItem
        icon="trash"
        className="text-danger"
        disabled={!canRemove}
        title={canRemove ? undefined : 'The active streaming message cannot be removed'}
        onClick={() => {
          closeMenu(true)
          void onRemoveMessage(message.id)
        }}
      >
        Remove message
      </MenuItem>
    </Menu>
  )

  return (
    <div
      ref={messageRef}
      role="group"
      tabIndex={0}
      aria-label={`${message.kind === 'user' ? 'Your' : message.kind === 'assistant' ? 'Assistant' : 'Error'} message`}
      className={classNames(
        'focus-visible:ring-info flex max-w-[85%] items-start gap-1 rounded outline-none focus-visible:ring-2',
        message.kind === 'user' ? 'flex-row-reverse self-end' : 'self-start',
      )}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault()
          event.stopPropagation()
          openFromKeyboard()
        }
      }}
    >
      {children(messageTextRef)}
      <button
        ref={optionsButtonRef}
        type="button"
        className="text-passive-1 hover:bg-contrast focus:bg-contrast flex flex-shrink-0 rounded p-1 focus:outline-none"
        aria-label="Message options"
        title="Message options"
        onClick={toggleOptionsMenu}
      >
        <Icon type="more" size="small" />
      </button>
      {menuAnchor?.kind === 'point' && (
        <Popover
          title="Message options"
          open={true}
          anchorPoint={{ x: menuAnchor.x, y: menuAnchor.y }}
          togglePopover={() => closeMenu(false)}
          side="bottom"
          align="start"
          className="py-2"
          containerClassName="md:!w-auto md:!min-w-0"
        >
          {menu}
        </Popover>
      )}
      <Popover
        title="Message options"
        open={menuAnchor?.kind === 'element'}
        anchorElement={optionsButtonRef}
        togglePopover={() => closeMenu(false)}
        side="bottom"
        align="start"
        className="py-2"
        containerClassName="md:!w-auto md:!min-w-0"
      >
        {menu}
      </Popover>
    </div>
  )
}

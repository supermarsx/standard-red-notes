import {
  IconType,
  FileItem,
  SNNote,
  SNTag,
  DecryptedItemInterface,
  SmartView,
  isFolderItem,
  DefaultFolderIconName,
  VectorIconNameOrEmoji,
} from '@standardnotes/snjs'
import { getIconAndTintForNoteType } from './getIconAndTintForNoteType'
import { getIconForFileType } from './getIconForFileType'
import { WebApplicationInterface } from '@standardnotes/ui-services'
import { IconNameToSvgMapping } from '@/Components/Icon/IconNameToSvgMapping'
import { getEmojiLength } from '@/Components/Icon/EmojiLength'

/**
 * `Icon` falls through to the emoji path for any name it cannot resolve, rendering the
 * name itself as text — which is how three wrong icon names have shipped here. The icon
 * picker only ever stores a mapped name or a single-grapheme emoji, so anything else in
 * a folder's `iconString` arrived from older data or another client and would print raw
 * into the linking popover. Both shapes the picker can produce are preserved.
 */
function folderIcon(iconString: VectorIconNameOrEmoji | undefined): IconType {
  if (!iconString) {
    return DefaultFolderIconName
  }

  // `EmojiString` is `Omit<string, IconType>`, so the value has to be widened back to a
  // plain string before it can be looked up or measured.
  const value = String(iconString)
  const resolvesToGlyph = value in IconNameToSvgMapping
  const isSingleGrapheme = getEmojiLength(value) === 1

  return resolvesToGlyph || isSingleGrapheme ? (iconString as IconType) : DefaultFolderIconName
}

export function getIconForItem(item: DecryptedItemInterface, application: WebApplicationInterface): [IconType, string] {
  if (item instanceof SNNote) {
    const editorForNote = application.componentManager.editorForNote(item)
    const [icon, tint] = getIconAndTintForNoteType(editorForNote.noteType)
    const className = `text-accessory-tint-${tint}`
    return [icon, className]
  } else if (item instanceof FileItem) {
    const icon = getIconForFileType(item.mimeType)
    return [icon, 'text-info']
  } else if (item instanceof SNTag || item instanceof SmartView) {
    return [item.iconString as IconType, 'text-info']
  } else if (isFolderItem(item)) {
    /**
     * A folder is an SNFolder, never an SNTag, so neither branch above catches it and
     * every caller here (LinkedItemMeta, LinkedItemBubble, LinkedItemsSectionItem) would
     * have thrown mid-render.
     */
    return [folderIcon(item.iconString), 'text-info']
  }

  throw new Error('Unhandled case in getItemIcon')
}

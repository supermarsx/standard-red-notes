import { IconType } from './../../Utilities/Icon/IconType'
import { ItemContent } from '../../Abstract/Content/ItemContent'
import { EmojiString } from '../../Utilities/Icon/IconType'

export interface FolderContentSpecialized {
  title: string
  expanded: boolean
  iconString: IconType | EmojiString
  /**
   * Optional hex color (e.g. "#086dd6") used to color-code the folder in the UI.
   * An empty string or undefined means no color is set.
   */
  color?: string
}

export type FolderContent = FolderContentSpecialized & ItemContent

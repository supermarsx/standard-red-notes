import { IconType } from './../../Utilities/Icon/IconType'
import { ItemContent } from '../../Abstract/Content/ItemContent'
import { EmojiString } from '../../Utilities/Icon/IconType'
import { TagPreferences } from './TagPreferences'

export interface TagContentSpecialized {
  title: string
  expanded: boolean
  iconString: IconType | EmojiString
  /**
   * Optional hex color (e.g. "#086dd6") used to color-code the tag in the UI.
   * An empty string or undefined means no color is set.
   */
  color?: string
  preferences?: TagPreferences
}

export type TagContent = TagContentSpecialized & ItemContent

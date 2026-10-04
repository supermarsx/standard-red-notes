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
  /**
   * When true the client keeps this folder's row out of the navigation sidebar, along with
   * the rows of every subfolder beneath it. Presentation only, and deliberately NOT a
   * protection mechanism: the folder and its notes stay in the database, keep syncing, and
   * remain reachable through All Notes, search and the organize-everything surface. Vaults
   * are the feature that actually restricts access.
   *
   * Mirrors `TagContent.hidden` so one rule covers both halves of the sidebar tree.
   * Absent means shown.
   */
  hidden?: boolean
}

export type FolderContent = FolderContentSpecialized & ItemContent

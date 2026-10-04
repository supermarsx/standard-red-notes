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
  /**
   * When true this tag is presented as a Folder (a hierarchical container) rather
   * than a flat label. Folders and tags share the same item type for sync
   * compatibility; this flag only changes how the client groups and renders them.
   */
  isFolder?: boolean
  /**
   * When true the client keeps this tag's row out of the navigation sidebar, along with
   * the rows of everything nested under it. Presentation only, and deliberately NOT a
   * protection mechanism: the tag and its notes stay in the database, keep syncing, and
   * remain reachable through All Notes, search, a note's own tag list and the
   * organize-everything surface. Vaults are the feature that actually restricts access.
   *
   * Stored as a top-level content field rather than in `preferences` because `preferences`
   * describes how a tag's NOTE LIST is displayed (sort order, panel width, which notes to
   * include), whereas this — like `expanded`, `color` and `iconString` beside it —
   * describes the tag's own row. Absent means shown.
   */
  hidden?: boolean
  preferences?: TagPreferences
}

export type TagContent = TagContentSpecialized & ItemContent

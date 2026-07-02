import { IconType } from '@standardnotes/snjs'
import { PreferencePaneId } from '@standardnotes/services'

export interface PreferencesMenuItem {
  readonly id: PreferencePaneId
  readonly icon: IconType
  readonly label: string
  readonly order: number
  readonly bubbleCount?: number
  readonly hasErrorIndicator?: boolean
  /**
   * When true the pane's content column renders at double the standard width
   * (62.5rem instead of 31.25rem, still capped to the available space). Meant
   * for panes hosting large tables (e.g. Admin's users list / audit log / logs).
   */
  readonly wide?: boolean
}

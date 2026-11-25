import { ToolbarButtonId, ToolbarGroupDescriptor } from './ToolbarConfig'

/** These actions inspect, select or copy a note without changing its contents. */
export const READONLY_TOOLBAR_BUTTONS: ReadonlySet<ToolbarButtonId> = new Set([
  ToolbarButtonId.Copy,
  ToolbarButtonId.Print,
  ToolbarButtonId.Search,
  ToolbarButtonId.FindNext,
  ToolbarButtonId.TableOfContents,
  ToolbarButtonId.SelectAll,
  ToolbarButtonId.SelectAllText,
  ToolbarButtonId.Deselect,
  ToolbarButtonId.FormattingMarks,
])

export const readonlyToolbarGroups = (groups: ToolbarGroupDescriptor[]): ToolbarGroupDescriptor[] =>
  groups
    .map((group) => ({ ...group, buttons: group.buttons.filter(({ id }) => READONLY_TOOLBAR_BUTTONS.has(id)) }))
    .filter((group) => group.buttons.length > 0)

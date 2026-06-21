import {
  CAPTURE_SAVE_COMMAND,
  CHANGE_EDITOR_COMMAND,
  CHANGE_EDITOR_WIDTH_COMMAND,
  CREATE_NEW_NOTE_KEYBOARD_COMMAND,
  CREATE_NEW_TAG_COMMAND,
  DELETE_NOTE_KEYBOARD_COMMAND,
  FOCUS_TAGS_INPUT_COMMAND,
  KeyboardCommand,
  OPEN_NOTE_HISTORY_COMMAND,
  OPEN_PREFERENCES_COMMAND,
  PIN_NOTE_COMMAND,
  SEARCH_KEYBOARD_COMMAND,
  SELECT_ALL_ITEMS_KEYBOARD_COMMAND,
  STAR_NOTE_COMMAND,
  SUPER_SEARCH_NEXT_RESULT,
  SUPER_SEARCH_PREVIOUS_RESULT,
  SUPER_SEARCH_TOGGLE_CASE_SENSITIVE,
  SUPER_SEARCH_TOGGLE_REPLACE_MODE,
  SUPER_SHOW_MARKDOWN_PREVIEW,
  SUPER_TOGGLE_SEARCH,
  SUPER_TOGGLE_TOOLBAR,
  TOGGLE_COMMAND_PALETTE,
  TOGGLE_DARK_MODE_COMMAND,
  TOGGLE_FOCUS_MODE_COMMAND,
  TOGGLE_KEYBOARD_SHORTCUTS_MODAL,
  TOGGLE_LIST_PANE_KEYBOARD_COMMAND,
  TOGGLE_NAVIGATION_PANE_KEYBOARD_COMMAND,
} from './KeyboardCommands'
import { KeyboardShortcutCategory } from './KeyboardShortcut'

/**
 * Standard Red Notes: catalog of the keyboard commands that are exposed in the
 * "Keyboard shortcuts" preferences pane for user reassignment.
 *
 * We intentionally do NOT list every command. Pure-navigation / control keys
 * such as Tab, Escape, the arrow-key list navigation, "show hidden options"
 * (bare Alt) and the cancel-search Escape are deliberately omitted because they
 * are structural (reassigning them would break baseline editing/navigation) or
 * are not single-chord shortcuts a user would expect to rebind.
 */
export type KeyboardCommandCatalogEntry = {
  command: KeyboardCommand
  label: string
  category: KeyboardShortcutCategory
}

export const KEYBOARD_COMMAND_CATALOG: KeyboardCommandCatalogEntry[] = [
  { command: TOGGLE_LIST_PANE_KEYBOARD_COMMAND, label: 'Toggle notes list pane', category: 'General' },
  { command: TOGGLE_NAVIGATION_PANE_KEYBOARD_COMMAND, label: 'Toggle navigation pane', category: 'General' },
  { command: TOGGLE_FOCUS_MODE_COMMAND, label: 'Toggle focus mode', category: 'General' },
  { command: TOGGLE_DARK_MODE_COMMAND, label: 'Toggle dark mode', category: 'General' },
  { command: OPEN_PREFERENCES_COMMAND, label: 'Open preferences', category: 'General' },
  { command: TOGGLE_KEYBOARD_SHORTCUTS_MODAL, label: 'Toggle keyboard shortcuts help', category: 'General' },
  { command: TOGGLE_COMMAND_PALETTE, label: 'Toggle command palette', category: 'General' },

  { command: CREATE_NEW_NOTE_KEYBOARD_COMMAND, label: 'Create new note', category: 'Notes list' },
  { command: SEARCH_KEYBOARD_COMMAND, label: 'Search notes', category: 'Notes list' },
  { command: SELECT_ALL_ITEMS_KEYBOARD_COMMAND, label: 'Select all notes', category: 'Notes list' },
  { command: CREATE_NEW_TAG_COMMAND, label: 'Create new tag', category: 'Notes list' },
  { command: FOCUS_TAGS_INPUT_COMMAND, label: 'Focus tags input', category: 'Notes list' },

  { command: CAPTURE_SAVE_COMMAND, label: 'Save note', category: 'Current note' },
  { command: DELETE_NOTE_KEYBOARD_COMMAND, label: 'Delete note', category: 'Current note' },
  { command: STAR_NOTE_COMMAND, label: 'Star / unstar note', category: 'Current note' },
  { command: PIN_NOTE_COMMAND, label: 'Pin / unpin note', category: 'Current note' },
  { command: OPEN_NOTE_HISTORY_COMMAND, label: 'Open note history', category: 'Current note' },
  { command: CHANGE_EDITOR_COMMAND, label: 'Change note editor', category: 'Current note' },
  { command: CHANGE_EDITOR_WIDTH_COMMAND, label: 'Change editor width', category: 'Current note' },

  { command: SUPER_TOGGLE_TOOLBAR, label: 'Toggle toolbar', category: 'Super notes' },
  { command: SUPER_TOGGLE_SEARCH, label: 'Toggle search', category: 'Super notes' },
  { command: SUPER_SEARCH_TOGGLE_REPLACE_MODE, label: 'Toggle search & replace', category: 'Super notes' },
  { command: SUPER_SEARCH_TOGGLE_CASE_SENSITIVE, label: 'Toggle case-sensitive search', category: 'Super notes' },
  { command: SUPER_SEARCH_NEXT_RESULT, label: 'Next search result', category: 'Super notes' },
  { command: SUPER_SEARCH_PREVIOUS_RESULT, label: 'Previous search result', category: 'Super notes' },
  { command: SUPER_SHOW_MARKDOWN_PREVIEW, label: 'Toggle Markdown preview', category: 'Super notes' },
]

/**
 * The stable persistence key for a command is its `Symbol.description`. Every
 * catalog command is created with a description, but the type allows `undefined`,
 * so callers should guard. Commands without a description cannot be overridden.
 */
export function descriptionForCommand(command: KeyboardCommand): string | undefined {
  return command.description
}

import { createCommand, LexicalCommand } from 'lexical'

/**
 * Non-toggling commands the toolbar's "Selection" group dispatches to drive the
 * in-note search/replace UI. Unlike the keyboard SUPER_TOGGLE_SEARCH (which
 * flips open/closed), these always OPEN the panel — pressing the toolbar button
 * again keeps it open rather than dismissing it.
 */
export const OPEN_SUPER_SEARCH_COMMAND: LexicalCommand<void> = createCommand('OPEN_SUPER_SEARCH_COMMAND')
export const OPEN_SUPER_SEARCH_REPLACE_COMMAND: LexicalCommand<void> = createCommand('OPEN_SUPER_SEARCH_REPLACE_COMMAND')
export const SUPER_SEARCH_GO_TO_NEXT_COMMAND: LexicalCommand<void> = createCommand('SUPER_SEARCH_GO_TO_NEXT_COMMAND')

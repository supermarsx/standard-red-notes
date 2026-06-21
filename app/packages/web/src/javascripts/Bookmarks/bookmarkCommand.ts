/**
 * Standard Red Notes: the "Bookmark this spot" keyboard command.
 *
 * A KeyboardCommand is just a Symbol, so we define our own in the web layer (no
 * ui-services edit). It is shared so multiple entry points can drive the SAME
 * capture flow registered in NoteView:
 *  - the Ctrl/Cmd+M shortcut (binding + handler registered in NoteView),
 *  - the note-options "Bookmark this spot" menu item (triggers the command).
 * The Super Insert "/" menu uses its own Lexical command path.
 */
export const BOOKMARK_SPOT_COMMAND: symbol = Symbol('SRN_BOOKMARK_SPOT_COMMAND')

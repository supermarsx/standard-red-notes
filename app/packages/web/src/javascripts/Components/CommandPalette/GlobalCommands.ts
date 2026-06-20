import { IconType } from '@standardnotes/snjs'
import {
  CHANGE_EDITOR_COMMAND,
  CREATE_NEW_NOTE_KEYBOARD_COMMAND,
  CREATE_NEW_TAG_COMMAND,
  KeyboardCommand,
  OPEN_PREFERENCES_COMMAND,
  SEARCH_KEYBOARD_COMMAND,
  TOGGLE_DARK_MODE_COMMAND,
  TOGGLE_KEYBOARD_SHORTCUTS_MODAL,
} from '@standardnotes/ui-services'
import { PreferencePaneId } from '@standardnotes/services'
import { WebApplication } from '@/Application/WebApplication'
import { openOrFocusConstellationWindow } from '../Constellation/constellationWindow'

/**
 * A single command exposed in the command palette that is available globally
 * (i.e. not tied to a specific mounted component). Each entry maps a stable id
 * and human-readable title to a real, callable application action.
 *
 * To add a new global command, append an entry to {@link GLOBAL_COMMANDS}. Keep
 * `run` thin — delegate to existing controllers/services rather than
 * re-implementing behaviour, and only add a command whose action genuinely
 * exists. Optionally provide `isAvailable` to hide a command when its action
 * can't be performed in the current state (e.g. lock requires a passcode).
 */
export interface GlobalCommand {
  /** Stable, unique id. Also used as the recents key. */
  id: string
  /** Title shown in the palette and matched/highlighted by the fuzzy search. */
  title: string
  /** Extra search terms (synonyms) that match but aren't shown/highlighted. */
  keywords?: string[]
  icon: IconType
  /** When set, the palette shows this command's bound keyboard shortcut. */
  shortcut?: KeyboardCommand
  /** Perform the action. Should be safe to call without further arguments. */
  run: (application: WebApplication) => void
  /** When provided and it returns false, the command is omitted from the registry. */
  isAvailable?: (application: WebApplication) => boolean
}

function openPreferencesPane(pane: PreferencePaneId): (application: WebApplication) => void {
  return (application) => application.openPreferences(pane)
}

export const GLOBAL_COMMANDS: GlobalCommand[] = [
  // --- Creation -----------------------------------------------------------
  {
    id: 'global-create-note',
    title: 'New note',
    keywords: ['create', 'add', 'compose'],
    icon: 'add',
    shortcut: CREATE_NEW_NOTE_KEYBOARD_COMMAND,
    run: (application) => application.keyboardService.triggerCommand(CREATE_NEW_NOTE_KEYBOARD_COMMAND),
  },
  {
    id: 'global-create-tag',
    title: 'New tag or folder',
    keywords: ['create', 'add', 'folder'],
    icon: 'folder',
    shortcut: CREATE_NEW_TAG_COMMAND,
    run: (application) => application.keyboardService.triggerCommand(CREATE_NEW_TAG_COMMAND),
  },

  // --- Navigation / search ------------------------------------------------
  {
    id: 'global-focus-search',
    title: 'Search notes',
    keywords: ['find', 'filter', 'focus'],
    icon: 'search',
    shortcut: SEARCH_KEYBOARD_COMMAND,
    run: (application) => application.keyboardService.triggerCommand(SEARCH_KEYBOARD_COMMAND),
  },
  {
    id: 'global-go-home',
    title: 'Go to all notes',
    keywords: ['home', 'navigate'],
    icon: 'notes',
    run: (application) => void application.navigationController.selectHomeNavigationView(),
  },
  {
    id: 'global-go-files',
    title: 'Go to files',
    keywords: ['navigate', 'attachments'],
    icon: 'file',
    run: (application) => void application.navigationController.selectFilesView(),
  },
  {
    id: 'global-open-constellation',
    title: 'Open constellation graph',
    keywords: ['graph', 'stars', 'links', 'visualize'],
    icon: 'asterisk',
    run: () => openOrFocusConstellationWindow(),
  },

  // --- Editor -------------------------------------------------------------
  {
    id: 'global-change-editor',
    title: 'Change note type / editor',
    keywords: ['switch', 'editor', 'super', 'markdown', 'plain'],
    icon: 'dashboard',
    shortcut: CHANGE_EDITOR_COMMAND,
    run: (application) => application.keyboardService.triggerCommand(CHANGE_EDITOR_COMMAND),
  },

  // --- Appearance ---------------------------------------------------------
  {
    id: 'global-toggle-dark-mode',
    title: 'Toggle dark mode',
    keywords: ['theme', 'appearance', 'light'],
    icon: 'themes',
    shortcut: TOGGLE_DARK_MODE_COMMAND,
    run: (application) => application.keyboardService.triggerCommand(TOGGLE_DARK_MODE_COMMAND),
  },
  {
    id: 'global-open-appearance',
    title: 'Open Appearance preferences',
    keywords: ['theme', 'settings', 'font', 'editor width'],
    icon: 'themes',
    run: openPreferencesPane('appearance'),
  },

  // --- Preferences (deep links) ------------------------------------------
  {
    id: 'global-open-preferences',
    title: 'Open Preferences',
    keywords: ['settings', 'options', 'config'],
    icon: 'settings',
    shortcut: OPEN_PREFERENCES_COMMAND,
    run: (application) => application.openPreferences(),
  },
  {
    id: 'global-open-pref-security',
    title: 'Open Security preferences',
    keywords: ['settings', 'passcode', 'encryption', 'protections'],
    icon: 'security',
    run: openPreferencesPane('security'),
  },
  {
    id: 'global-open-pref-backups',
    title: 'Open Backups preferences',
    keywords: ['settings', 'export', 'data'],
    icon: 'restore',
    run: openPreferencesPane('backups'),
  },
  {
    id: 'global-open-pref-assistant',
    title: 'Open Assistant preferences',
    keywords: ['settings', 'ai', 'narration'],
    icon: 'dashboard',
    run: openPreferencesPane('assistant'),
  },
  {
    id: 'global-open-pref-accessibility',
    title: 'Open Accessibility preferences',
    keywords: ['settings', 'spellcheck', 'a11y'],
    icon: 'accessibility',
    run: openPreferencesPane('accessibility'),
  },
  {
    id: 'global-open-pref-conflicts',
    title: 'Open Sync Conflicts',
    keywords: ['settings', 'sync', 'duplicate', 'resolve'],
    icon: 'sync',
    run: openPreferencesPane('conflicts'),
  },

  // --- Maintenance / security --------------------------------------------
  {
    id: 'global-empty-trash',
    title: 'Empty trash',
    keywords: ['delete', 'clear', 'permanently'],
    icon: 'trash',
    run: (application) => void application.notesController.emptyTrash(),
  },
  {
    id: 'global-lock-application',
    title: 'Lock application',
    keywords: ['passcode', 'secure', 'sign out screen'],
    icon: 'lock',
    isAvailable: (application) => application.hasPasscode(),
    run: (application) => void application.lock(),
  },

  // --- Help ---------------------------------------------------------------
  {
    id: 'global-keyboard-shortcuts',
    title: 'Show keyboard shortcuts',
    keywords: ['help', 'keys', 'hotkeys', 'bindings'],
    icon: 'keyboard',
    shortcut: TOGGLE_KEYBOARD_SHORTCUTS_MODAL,
    run: (application) => application.keyboardService.triggerCommand(TOGGLE_KEYBOARD_SHORTCUTS_MODAL),
  },
]

/**
 * Register every available global command with the application's CommandService
 * so it appears in the palette (searchable, recents-tracked). Returns a
 * disposer that unregisters all of them.
 */
export function registerGlobalCommands(application: WebApplication): () => void {
  const disposers: Array<() => void> = []
  for (const command of GLOBAL_COMMANDS) {
    if (command.isAvailable && !command.isAvailable(application)) {
      continue
    }
    disposers.push(
      application.commands.add(
        command.id,
        command.title,
        () => command.run(application),
        command.icon,
        command.shortcut,
      ),
    )
  }
  return () => disposers.forEach((dispose) => dispose())
}

/**
 * Standard Red Notes: the ACHIEVEMENTS / gamification catalog.
 *
 * Each achievement unlocks when a named counter `metric` reaches `threshold`.
 * Counters are maintained web-locally by {@link AchievementsService} (localStorage)
 * and incremented by fire-and-forget instrumentation across the app. For boolean
 * "did this once" achievements the threshold is 1 and the metric is bumped via
 * `markEvent`/`setAtLeast(metric, 1)`.
 *
 * `hidden: true` marks a "mystery" achievement — its name/description/criteria are
 * NOT revealed in the UI (shown as "???") nor to the AI assistant until it is
 * unlocked, at which point the full details appear.
 *
 * Copy is intentionally plain English here (no i18n) — the Internationalization
 * effort owns translation separately and must not be touched by this subsystem.
 */

export type AchievementDefinition = {
  id: string
  name: string
  description: string
  /** The counter key that drives this achievement. */
  metric: string
  /** The counter value at which the achievement unlocks (1 for boolean events). */
  threshold: number
  /** When true, this is a mystery achievement: hidden until unlocked. */
  hidden?: boolean
  /** Grouping label for the preferences pane. */
  category: string
}

/** Stable category labels used to group achievements in the pane. */
export const ACHIEVEMENT_CATEGORIES = {
  Tenure: 'Tenure',
  Writing: 'Writing',
  Files: 'Files',
  Linking: 'Linking',
  Editor: 'Editor',
  Safety: 'Safety & Recovery',
  Sync: 'Sync',
  Assistant: 'AI Assistant',
  Appearance: 'Appearance',
  Backups: 'Backups',
  Extensibility: 'Extensibility',
  Security: 'Security',
  Mishaps: 'Mishaps',
  Learning: 'Learning',
  Power: 'Power User',
  Organization: 'Organization',
  Meta: 'Meta',
} as const

// Metric keys — referenced by both the catalog and the instrumentation sites.
// Centralizing them avoids typos between the emitter and the definition.
export const METRICS = {
  accountAgeYears: 'accountAgeYears',
  maxNoteEdits: 'maxNoteEdits',
  fileAttachmentsTotal: 'fileAttachmentsTotal',
  noteLinksTotal: 'noteLinksTotal',
  customTablesCreated: 'customTablesCreated',
  spreadsheetNotesCreated: 'spreadsheetNotesCreated',
  survivorSwitchEnabled: 'survivorSwitchEnabled',
  syncConflictsTotal: 'syncConflictsTotal',
  aiAssistantMessages: 'aiAssistantMessages',
  appearanceCustomized: 'appearanceCustomized',
  backupUnencrypted: 'backupUnencrypted',
  backupEncrypted: 'backupEncrypted',
  backupImported: 'backupImported',
  pluginInstalled: 'pluginInstalled',
  embeddedWebsitesTotal: 'embeddedWebsitesTotal',
  shortcutsChanged: 'shortcutsChanged',
  trustedDeviceAdded: 'trustedDeviceAdded',
  mcpTokenAdded: 'mcpTokenAdded',
  recoveryMethodAdded: 'recoveryMethodAdded',
  passcodeLockAdded: 'passcodeLockAdded',
  maxPrivacyEnabled: 'maxPrivacyEnabled',
  failedLoginsTotal: 'failedLoginsTotal',
  documentationOpened: 'documentationOpened',
  documentationHoursSpent: 'documentationHoursSpent',
  manualSyncTotal: 'manualSyncTotal',
  workspaceSwitchTotal: 'workspaceSwitchTotal',
  notesPinnedTotal: 'notesPinnedTotal',
  decadeOfTrash: 'decadeOfTrash',
  achievementsViewed: 'achievementsViewed',
  searchTweaked: 'searchTweaked',
  multipleAccountsUsed: 'multipleAccountsUsed',
  itemsDeletedTotal: 'itemsDeletedTotal',
  itemsRestoredTotal: 'itemsRestoredTotal',
  sameItemRestores: 'sameItemRestores',
  fileDetached: 'fileDetached',
  trashEmptied: 'trashEmptied',
  appHoursSpent: 'appHoursSpent',
  /** Set to 1 by the service when every non-hidden achievement in a category unlocks. */
  editorCategoryComplete: 'editorCategoryComplete',
  securityCategoryComplete: 'securityCategoryComplete',
  powerCategoryComplete: 'powerCategoryComplete',
  /** Maintained by the service after each unlock = number of unlocked achievements. */
  unlockedCount: 'unlockedCount',
} as const

export const ACHIEVEMENTS: AchievementDefinition[] = [
  // --- Old-timer / tenure ---------------------------------------------------
  {
    id: 'seasoned-scribbler',
    name: 'Seasoned Scribbler',
    description: 'One year with your account.',
    metric: METRICS.accountAgeYears,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Tenure,
  },
  {
    id: 'old-timer',
    name: 'Old Timer',
    description: 'Five years with your account.',
    metric: METRICS.accountAgeYears,
    threshold: 5,
    category: ACHIEVEMENT_CATEGORIES.Tenure,
  },
  {
    id: 'digital-fossil',
    name: 'Digital Fossil',
    description: 'Twenty years; archaeologists will study your notes.',
    metric: METRICS.accountAgeYears,
    threshold: 20,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Tenure,
  },

  // --- Note edits (per-note max) -------------------------------------------
  {
    id: 'tinkerer',
    name: 'Tinkerer',
    description: 'Edit a single note 1,000 times.',
    metric: METRICS.maxNoteEdits,
    threshold: 1000,
    category: ACHIEVEMENT_CATEGORIES.Writing,
  },
  {
    id: 'never-satisfied',
    name: 'Never Satisfied',
    description: 'Edit a single note 50,000 times.',
    metric: METRICS.maxNoteEdits,
    threshold: 50000,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Writing,
  },

  // --- File attachments -----------------------------------------------------
  {
    id: 'pack-rat',
    name: 'Pack Rat',
    description: 'Attach 1,000 files in total.',
    metric: METRICS.fileAttachmentsTotal,
    threshold: 1000,
    category: ACHIEVEMENT_CATEGORIES.Files,
  },
  {
    id: 'digital-hoarder',
    name: 'Digital Hoarder',
    description: 'Attach 50,000 files in total.',
    metric: METRICS.fileAttachmentsTotal,
    threshold: 50000,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Files,
  },

  // --- Note links -----------------------------------------------------------
  {
    id: 'connect-the-dots',
    name: 'Connect the Dots',
    description: 'Link one note to another.',
    metric: METRICS.noteLinksTotal,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Linking,
  },
  {
    id: 'web-weaver',
    name: 'Web Weaver',
    description: 'Create 50,000 note links.',
    metric: METRICS.noteLinksTotal,
    threshold: 50000,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Linking,
  },

  // --- Editor blocks --------------------------------------------------------
  {
    id: 'table-stakes',
    name: 'Table Stakes',
    description: 'Create a custom table.',
    metric: METRICS.customTablesCreated,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Editor,
  },
  {
    id: 'number-cruncher',
    name: 'Number Cruncher',
    description: 'Create a spreadsheet note.',
    metric: METRICS.spreadsheetNotesCreated,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Editor,
  },
  {
    id: 'bean-counter',
    name: 'Bean Counter',
    description: 'Create 100 spreadsheet notes.',
    metric: METRICS.spreadsheetNotesCreated,
    threshold: 100,
    category: ACHIEVEMENT_CATEGORIES.Editor,
  },
  {
    id: 'lord-of-the-cells',
    name: 'Lord of the Cells',
    description: 'Create 10,000 spreadsheet notes.',
    metric: METRICS.spreadsheetNotesCreated,
    threshold: 10000,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Editor,
  },
  {
    id: 'frame-job',
    name: 'Frame Job',
    description: 'Embed a website in a note.',
    metric: METRICS.embeddedWebsitesTotal,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Editor,
  },
  {
    id: 'iframe-inception',
    name: 'Iframe Inception',
    description: 'Embed 100 websites.',
    metric: METRICS.embeddedWebsitesTotal,
    threshold: 100,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Editor,
  },

  // --- Survivor switch ------------------------------------------------------
  {
    id: 'just-in-case',
    name: 'Just In Case',
    description: 'Enable a survivor switch.',
    metric: METRICS.survivorSwitchEnabled,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Safety,
  },

  // --- Sync conflicts -------------------------------------------------------
  {
    id: 'conflict-of-interest',
    name: 'Conflict of Interest',
    description: 'Encounter your first sync conflict.',
    metric: METRICS.syncConflictsTotal,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Sync,
  },
  {
    id: 'merge-veteran',
    name: 'Merge Veteran',
    description: 'Live through 50 sync conflicts.',
    metric: METRICS.syncConflictsTotal,
    threshold: 50,
    category: ACHIEVEMENT_CATEGORIES.Sync,
  },
  {
    id: 'two-devices-one-dream',
    name: 'Two Devices, One Dream',
    description: 'Survive 10,000 sync conflicts.',
    metric: METRICS.syncConflictsTotal,
    threshold: 10000,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Sync,
  },

  // --- AI assistant ---------------------------------------------------------
  {
    id: 'hello-robot',
    name: 'Hello, Robot',
    description: 'Send your first message to the AI assistant.',
    metric: METRICS.aiAssistantMessages,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Assistant,
  },
  {
    id: 'chatty',
    name: 'Chatty',
    description: 'Send 100 messages to the AI assistant.',
    metric: METRICS.aiAssistantMessages,
    threshold: 100,
    category: ACHIEVEMENT_CATEGORIES.Assistant,
  },
  {
    id: 'robot-whisperer',
    name: 'Robot Whisperer',
    description: 'Send 1,000 messages to the AI assistant.',
    metric: METRICS.aiAssistantMessages,
    threshold: 1000,
    category: ACHIEVEMENT_CATEGORIES.Assistant,
  },
  {
    id: 'sentient-suspicion',
    name: 'Sentient Suspicion',
    description: 'Send 50,000 messages to the AI assistant.',
    metric: METRICS.aiAssistantMessages,
    threshold: 50000,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Assistant,
  },

  // --- Appearance -----------------------------------------------------------
  {
    id: 'interior-decorator',
    name: 'Interior Decorator',
    description: 'Customize your appearance settings.',
    metric: METRICS.appearanceCustomized,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Appearance,
  },

  // --- Backups --------------------------------------------------------------
  {
    id: 'plaintext-cowboy',
    name: 'Plaintext Cowboy',
    description: 'Download an unencrypted backup.',
    metric: METRICS.backupUnencrypted,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Backups,
  },
  {
    id: 'better-safe',
    name: 'Better Safe',
    description: 'Download an encrypted backup.',
    metric: METRICS.backupEncrypted,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Backups,
  },
  {
    id: 'restore-point',
    name: 'Restore Point',
    description: 'Import a backup.',
    metric: METRICS.backupImported,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Backups,
  },

  // --- Plugins --------------------------------------------------------------
  {
    id: 'modder',
    name: 'Modder',
    description: 'Install a plugin.',
    metric: METRICS.pluginInstalled,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Extensibility,
  },

  // --- Keyboard shortcuts ---------------------------------------------------
  {
    id: 'my-rules',
    name: 'My Rules',
    description: 'Change a keyboard shortcut.',
    metric: METRICS.shortcutsChanged,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Editor,
  },

  // --- Security -------------------------------------------------------------
  {
    id: 'trust-established',
    name: 'Trust, Established',
    description: 'Add a trusted device.',
    metric: METRICS.trustedDeviceAdded,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Security,
  },
  {
    id: 'token-gesture',
    name: 'Token Gesture',
    description: 'Create an MCP token.',
    metric: METRICS.mcpTokenAdded,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Security,
  },
  {
    id: 'plan-b',
    name: 'Plan B',
    description: 'Add a recovery method.',
    metric: METRICS.recoveryMethodAdded,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Security,
  },
  {
    id: 'locked-in',
    name: 'Locked In',
    description: 'Add a passcode lock.',
    metric: METRICS.passcodeLockAdded,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Security,
  },
  {
    id: 'ghost-protocol',
    name: 'Ghost Protocol',
    description: 'Turn every privacy option on.',
    metric: METRICS.maxPrivacyEnabled,
    threshold: 1,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Security,
  },

  // --- Failed logins --------------------------------------------------------
  {
    id: 'fat-fingers',
    name: 'Fat Fingers',
    description: 'Fail to sign in 5 times.',
    metric: METRICS.failedLoginsTotal,
    threshold: 5,
    category: ACHIEVEMENT_CATEGORIES.Mishaps,
  },
  {
    id: 'tried-password-manager',
    name: 'Have You Tried Your Password Manager?',
    description: 'Fail to sign in 500 times.',
    metric: METRICS.failedLoginsTotal,
    threshold: 500,
    category: ACHIEVEMENT_CATEGORIES.Mishaps,
  },
  {
    id: 'definitely-not-going-to-work',
    name: "It's Definitely Not Going to Work",
    description: 'Fail to sign in 1,500 times.',
    metric: METRICS.failedLoginsTotal,
    threshold: 1500,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Mishaps,
  },

  // --- Documentation --------------------------------------------------------
  {
    id: 'rtfm',
    name: 'RTFM',
    description: 'Open the documentation.',
    metric: METRICS.documentationOpened,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Learning,
  },
  {
    id: 'studious',
    name: 'Studious',
    description: 'Spend 5 hours in the documentation.',
    metric: METRICS.documentationHoursSpent,
    threshold: 5,
    category: ACHIEVEMENT_CATEGORIES.Learning,
  },
  {
    id: 'touch-grass',
    name: 'Touch Grass',
    description: 'Spend 500 hours in the documentation.',
    metric: METRICS.documentationHoursSpent,
    threshold: 500,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Learning,
  },

  // --- Manual sync (consolidated under Sync alongside sync conflicts) -------
  {
    id: 'manual-override',
    name: 'Manual Override',
    description: 'Trigger a manual sync.',
    metric: METRICS.manualSyncTotal,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Sync,
  },
  {
    id: 'control-freak',
    name: 'Control Freak',
    description: 'Trigger 10 manual syncs.',
    metric: METRICS.manualSyncTotal,
    threshold: 10,
    category: ACHIEVEMENT_CATEGORIES.Sync,
  },
  {
    id: 'trust-no-autosave',
    name: 'Trust No Autosave',
    description: 'Trigger 2,500 manual syncs.',
    metric: METRICS.manualSyncTotal,
    threshold: 2500,
    category: ACHIEVEMENT_CATEGORIES.Sync,
  },
  {
    id: 'f5-wore-out',
    name: 'F5 Wore Out',
    description: 'Trigger 50,000 manual syncs.',
    metric: METRICS.manualSyncTotal,
    threshold: 50000,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Sync,
  },

  // --- Workspace switching --------------------------------------------------
  {
    id: 'double-life',
    name: 'Double Life',
    description: 'Switch workspaces.',
    metric: METRICS.workspaceSwitchTotal,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Power,
  },
  {
    id: 'quick-change-artist',
    name: 'Quick-Change Artist',
    description: 'Switch workspaces 50 times.',
    metric: METRICS.workspaceSwitchTotal,
    threshold: 50,
    category: ACHIEVEMENT_CATEGORIES.Power,
  },
  {
    id: 'multiverse-manager',
    name: 'Multiverse Manager',
    description: 'Switch workspaces 5,000 times.',
    metric: METRICS.workspaceSwitchTotal,
    threshold: 5000,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Power,
  },

  // --- Pinned notes ---------------------------------------------------------
  {
    id: 'pinned-it',
    name: 'Pinned It',
    description: 'Pin a note.',
    metric: METRICS.notesPinnedTotal,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Organization,
  },
  {
    id: 'pin-cushion',
    name: 'Pin Cushion',
    description: 'Pin 50 notes.',
    metric: METRICS.notesPinnedTotal,
    threshold: 50,
    category: ACHIEVEMENT_CATEGORIES.Organization,
  },

  // --- Time in the app ------------------------------------------------------
  {
    id: 'just-getting-started',
    name: 'Just Getting Started',
    description: 'Spend 1 hour in the app.',
    metric: METRICS.appHoursSpent,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Tenure,
  },
  {
    id: 'clocked-in',
    name: 'Clocked In',
    description: 'Spend 500 hours in the app.',
    metric: METRICS.appHoursSpent,
    threshold: 500,
    category: ACHIEVEMENT_CATEGORIES.Tenure,
  },
  {
    id: 'where-did-time-go',
    name: 'Where Did the Time Go?',
    description: 'Spend 10,000 hours in the app.',
    metric: METRICS.appHoursSpent,
    threshold: 10000,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Tenure,
  },
  {
    id: 'one-with-the-app',
    name: 'One With the App',
    description: 'Spend 40,000 hours in the app — a lifetime of notes.',
    metric: METRICS.appHoursSpent,
    threshold: 40000,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Tenure,
  },

  // --- Deletion / search / multi-account -----------------------------------
  {
    id: 'butterfingers',
    name: 'Butterfingers',
    description: 'Permanently delete your first item. Whoops.',
    metric: METRICS.itemsDeletedTotal,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Mishaps,
  },
  {
    id: 'declutterer',
    name: 'Declutterer',
    description: 'Permanently delete 50 items.',
    metric: METRICS.itemsDeletedTotal,
    threshold: 50,
    category: ACHIEVEMENT_CATEGORIES.Organization,
  },
  {
    id: 'necromancer',
    name: 'Necromancer',
    description: 'Raise an item from the Trash (restore it).',
    metric: METRICS.itemsRestoredTotal,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Safety,
  },
  {
    id: 'chronic-second-guesser',
    name: 'Chronic Second-Guesser',
    description: 'Restore 50 items from the Trash. Trust your instincts!',
    metric: METRICS.itemsRestoredTotal,
    threshold: 50,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Mishaps,
  },
  {
    id: 'make-up-your-mind',
    name: 'Make Up Your Mind',
    description: 'Delete and restore the SAME item five times. It clearly means a lot to you.',
    metric: METRICS.sameItemRestores,
    threshold: 5,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Mishaps,
  },
  {
    id: 'now-where-did-i-put-that',
    name: 'Now Where Did I Put That?',
    description: 'Detach a file from a note and misplace it.',
    metric: METRICS.fileDetached,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Mishaps,
  },
  {
    id: 'trash-compactor',
    name: 'Trash Compactor',
    description: 'Empty the Trash.',
    metric: METRICS.trashEmptied,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Organization,
  },
  {
    id: 'marie-kondo',
    name: 'Marie Kondo',
    description: 'Empty the Trash 25 times. Does it spark joy?',
    metric: METRICS.trashEmptied,
    threshold: 25,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Organization,
  },
  {
    id: 'search-tweaker',
    name: 'Search Tweaker',
    description: 'Adjust a search filter or option.',
    metric: METRICS.searchTweaked,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Organization,
  },
  {
    id: 'double-agent',
    name: 'Double Agent',
    description: 'Use more than one account or workspace.',
    metric: METRICS.multipleAccountsUsed,
    threshold: 1,
    category: ACHIEVEMENT_CATEGORIES.Power,
  },

  // --- Achievements meta-engagement ----------------------------------------
  {
    id: 'trophy-polisher',
    name: 'Trophy Polisher',
    description: 'Open the Achievements pane 500 times. You really like these, huh?',
    metric: METRICS.achievementsViewed,
    threshold: 500,
    category: ACHIEVEMENT_CATEGORIES.Meta,
  },

  // --- Category masters (unlock every non-hidden achievement in a category) -
  {
    id: 'editor-virtuoso',
    name: 'Editor Virtuoso',
    description: 'Unlock every Editor achievement.',
    metric: METRICS.editorCategoryComplete,
    threshold: 1,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Editor,
  },
  {
    id: 'security-sentinel',
    name: 'Security Sentinel',
    description: 'Unlock every Security achievement.',
    metric: METRICS.securityCategoryComplete,
    threshold: 1,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Security,
  },
  {
    id: 'power-user-supreme',
    name: 'Power User Supreme',
    description: 'Unlock every Power User achievement.',
    metric: METRICS.powerCategoryComplete,
    threshold: 1,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Power,
  },

  // --- Trash housekeeping ---------------------------------------------------
  {
    id: 'decade-of-decay',
    name: 'Decade of Decay',
    description: 'Set the Trash to auto-empty after ten whole years. Commitment issues? Or just a slow composter.',
    metric: METRICS.decadeOfTrash,
    threshold: 1,
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Mishaps,
  },

  // --- Meta -----------------------------------------------------------------
  {
    id: 'pin-collector',
    name: 'Pin Collector',
    description: 'Unlock 10 achievements.',
    metric: METRICS.unlockedCount,
    threshold: 10,
    category: ACHIEVEMENT_CATEGORIES.Meta,
  },
  // "Completionist" threshold = number of non-hidden achievements; computed below
  // and patched in so it always tracks the catalog as it grows.
  {
    id: 'completionist',
    name: 'Completionist',
    description: 'Unlock every visible achievement.',
    metric: METRICS.unlockedCount,
    threshold: 0, // patched below to the count of non-hidden achievements
    hidden: true,
    category: ACHIEVEMENT_CATEGORIES.Meta,
  },
]

// The "Completionist" achievement unlocks once the user has unlocked every
// NON-HIDDEN achievement. We derive that count here (excluding Completionist
// itself, which is hidden) so the threshold stays correct as the catalog evolves.
const NON_HIDDEN_COUNT = ACHIEVEMENTS.filter((a) => !a.hidden).length
const completionist = ACHIEVEMENTS.find((a) => a.id === 'completionist')
if (completionist) {
  completionist.threshold = NON_HIDDEN_COUNT
}

/** Number of non-hidden achievements (the Completionist target). */
export const NON_HIDDEN_ACHIEVEMENT_COUNT = NON_HIDDEN_COUNT

/** All distinct metric keys referenced by the catalog. */
export const ALL_METRICS: string[] = Array.from(new Set(ACHIEVEMENTS.map((a) => a.metric)))

/**
 * "Category master" achievements: each unlocks (via its boolean `metric`) once
 * every NON-HIDDEN achievement in `category` — excluding the master itself — has
 * been unlocked. The service evaluates these after each normal unlock.
 */
export const CATEGORY_COMPLETION_ACHIEVEMENTS: { metric: string; category: string }[] = [
  { metric: METRICS.editorCategoryComplete, category: ACHIEVEMENT_CATEGORIES.Editor },
  { metric: METRICS.securityCategoryComplete, category: ACHIEVEMENT_CATEGORIES.Security },
  { metric: METRICS.powerCategoryComplete, category: ACHIEVEMENT_CATEGORIES.Power },
]

/** Lookup of definitions by the metric they depend on. */
export function definitionsForMetric(metric: string): AchievementDefinition[] {
  return ACHIEVEMENTS.filter((a) => a.metric === metric)
}

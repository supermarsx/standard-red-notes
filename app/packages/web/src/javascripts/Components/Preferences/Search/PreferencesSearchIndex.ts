import { PreferencePaneId } from '@standardnotes/services'

/**
 * Static, easily-extendable keyword index for the Preferences search box.
 *
 * Each entry maps a {@link PreferencePaneId} to a list of keywords. The pane's
 * own human title (from `PREFERENCES_MENU_ITEMS`) is always searched in addition
 * to these keywords, so this map only needs to capture the *extra* terms that a
 * user might type to find a setting — primarily the section/subtitle labels that
 * live inside each pane.
 *
 * Why a static map (rather than live-enumerating each pane's `Title`/`Subtitle`
 * components): the panes are independent React trees that are only mounted when
 * selected, and many render their sections conditionally (desktop-only, vault
 * gated, admin gated, etc.). Crawling them at runtime would require mounting
 * every pane and is brittle. A hand-maintained keyword map is pragmatic, fast,
 * and trivially unit-testable. The trade-off: section labels here must be kept
 * roughly in sync with the panes by hand.
 *
 * To extend: add the pane's id and any synonyms / section titles a user might
 * search for. Keys are matched case-insensitively as substrings/fuzzy tokens by
 * `searchPreferences`.
 */
export const PREFERENCES_SEARCH_KEYWORDS: Partial<Record<PreferencePaneId, string[]>> = {
  'whats-new': ['changelog', 'updates', 'release notes', 'new features', 'version'],

  account: [
    'email',
    'change email',
    'password',
    'change password',
    'credentials',
    'sign out',
    'sign out all',
    'subscription',
    'sync',
    'delete account',
    'files',
    'storage',
    'encryption status',
  ],

  general: [
    'tools',
    'defaults',
    'new note defaults',
    'editor default',
    'spellcheck',
    'smart views',
    'labs',
    'experimental',
    'moments',
    'persistence',
    'local storage',
    'always open last note',
    'add to dock',
  ],

  security: [
    'two factor',
    'two-factor',
    '2fa',
    'mfa',
    'authenticator',
    'passcode',
    'lock',
    'passkey',
    'unlock with passkey',
    'webauthn',
    'biometrics',
    'face id',
    'touch id',
    'encryption',
    'protections',
    'privacy',
    'trusted devices',
    'app passwords',
    'server access key',
    'mcp tokens',
    'u2f',
    'security keys',
    'fido',
    'magic link',
    'errored items',
    'multitasking privacy',
  ],

  backups: [
    'data backups',
    'email backups',
    'automatic backups',
    'file backups',
    'text backups',
    'plaintext backups',
    'import',
    'export',
    'restore',
    'download backup',
  ],

  appearance: [
    'theme',
    'themes',
    'dark mode',
    'light mode',
    'color',
    'colour',
    'font',
    'font size',
    'editor appearance',
    'monospace',
    'ligatures',
    'font ligatures',
    'line height',
    'margin',
  ],

  assistant: ['ai', 'assistant', 'chat', 'prompt', 'language model'],

  shortcuts: ['keyboard', 'keyboard shortcuts', 'hotkeys', 'key bindings', 'commands'],

  plugins: ['extensions', 'add-ons', 'addons', 'install plugin', 'custom plugin', 'manage plugins', 'browse plugins'],

  accessibility: ['a11y', 'screen reader', 'contrast', 'reduce motion', 'font size'],

  'help-feedback': ['documentation', 'docs', 'help', 'support', 'feedback', 'faq'],

  vaults: ['vault', 'vaults', 'shared vaults', 'contacts', 'invites', 'collaboration', 'members'],

  admin: ['administration', 'server admin', 'users', 'roles', 'management'],

  'home-server': ['self host', 'self-hosted', 'server', 'database', 'environment', 'home server settings'],

  shares: ['share links', 'public links', 'read only', 'read-only', 'sharing'],

  'survivor-switch': ['dead man switch', 'inheritance', 'survivor', 'designate survivor', 'legacy'],

  'recent-notes': ['recent notes', 'history', 'recently opened', 'recently viewed'],

  searchIndexing: [
    'search',
    'search index',
    'indexing',
    'full text search',
    'full-text',
    'rebuild index',
    'purge index',
    'reindex',
    'scheduler',
    'on change',
    'idle',
    'interval',
    'inclusions',
    'exclusions',
    'whitelist',
    'blacklist',
    'index scope',
    'min query length',
    'query cache',
    'max indexed notes',
    'body length',
  ],

  sync: [
    'sync',
    'selective sync',
    'local only',
    'local-only',
    'offline',
    'device only',
    'synced',
    "what's synced",
    'exclude from sync',
    'keep on device',
    // Merged in from the former standalone "Sync Conflicts" pane.
    'sync conflicts',
    'conflict',
    'merge',
    'resolve conflicts',
    'duplicates',
  ],
}

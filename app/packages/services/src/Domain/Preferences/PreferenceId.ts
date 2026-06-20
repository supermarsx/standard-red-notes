const PREFERENCE_PANE_IDS = [
  'general',
  'account',
  'security',
  'home-server',
  'vaults',
  'appearance',
  'assistant',
  'backups',
  'plugins',
  'shortcuts',
  'accessibility',
  'help-feedback',
  'whats-new',
  'admin',
  'shares',
  'survivor-switch',
  'conflicts',
  'recent-notes',
  'achievements',
  'sharing',
] as const

export type PreferencePaneId = (typeof PREFERENCE_PANE_IDS)[number]

/**
 * English strings for authentication flows (sign in / register, two-factor,
 * passcode/biometrics, account recovery, session management). Source of truth:
 * other locales fall back to these until translated.
 */
const auth = {
  // AdvancedOptions
  unableToComputePrivateUsername: 'Unable to compute private username.',
  advancedOptions: 'Advanced options',
  privateUsernameMode: 'Private username mode',
  username: 'Username',
  useStrictSignIn: 'Use strict sign-in',
  useRecoveryCode: 'Use recovery code',
  recoveryCode: 'Recovery code',

  // ConfirmNoMergeDialog
  deleteLocalDataTitle: 'Delete local data?',
  noMergeWarning:
    'You have chosen not to merge your local data. If you proceed, your local notes and topics will be permanently deleted and replaced with data from your account. This action cannot be undone.',
  noMergeConfirmQuestion: 'Are you sure you want to continue without merging?',
  deleteLocalDataAndContinue: 'Delete Local Data and Continue',

  // ConfirmPassword
  passwordResetWarningPart1: 'Because your notes are encrypted using your password,',
  passwordResetWarningHighlight: 'Standard Red Notes does not have a password reset option',
  passwordResetWarningPart2: '. If you forget your password, you will permanently lose access to your data.',
  confirmPassword: 'Confirm password',
  creatingAccount: 'Creating account...',
  createAccountAndSignIn: 'Create account & sign in',
  staySignedIn: 'Stay signed in',
  goBack: 'Go back',
  humanVerification: 'Human verification',
  confirmPasswordTitle: 'Confirm password',

  // CreateAccount
  createAccount: 'Create account',
  workspaceNameOptional: 'Workspace name (optional)',

  // GeneralAccountMenu
  generalAccountMenuLabel: 'General account menu',
  signedInAs: "You're signed in as:",
  syncing: 'Syncing...',
  lastSynced: 'Last synced:',
  offlineSignInPrompt:
    'You’re offline. Sign in to sync your notes and preferences across all your devices and enable end-to-end encryption.',
  offline: 'Offline',
  accountSettings: 'Account settings',
  createFreeAccount: 'Create free account',
  documentation: 'Documentation',
  keyboardShortcuts: 'Keyboard shortcuts',
  commandPalette: 'Command palette',
  signOutWorkspace: 'Sign out workspace',

  // MergeLocalDataCheckbox
  mergeLocalData: 'Merge local data ({{count}} notes and topics)',
  mergeLocalDataTooltip:
    'If unchecked, your local notes and topics will be permanently deleted and replaced with data from your account.',

  // ServerPicker
  homeServerNotRunning:
    'Home server is not running. Please open the prefences and home server tab to start it.',
  serverDefault: 'Default',
  serverCustom: 'Custom',
  serverHomeServer: 'Home Server',
  syncServer: 'Sync Server',

  // SignIn
  signingIn: 'Signing in...',

  // User
  syncUnreachable: 'Sync Unreachable',
  syncUnreachableMessage: "Hmm...we can't seem to sync your account. The reason: {{reason}}",

  // WorkspaceSwitcherMenu
  workspaceSwitcherMenuLabel: 'Workspace switcher menu',
  signOutAllWorkspacesConfirm: 'Are you sure you want to sign out of all workspaces on this device?',
  signOutAll: 'Sign out all',
  addAnotherWorkspace: 'Add another workspace',
  signOutAllWorkspaces: 'Sign out all workspaces',

  // ConfirmDeleteAccountModal
  deleteAccountTitle: 'Delete account?',
  deleteMyAccountForGood: 'Delete my account for good',

  // NoAccountWarningContent
  dataNotBackedUp: 'Data not backed up',
  signInOrRegisterToSync:
    'Sign in or register to sync your notes to your other devices with end-to-end encryption.',
  openAccountMenu: 'Open Account menu',
  ignoreWarning: 'Ignore warning',

  // U2FAuthIframe
  waitingForSecurityKey: 'Waiting for security key...',
  authenticationSuccessful: 'Authentication successful!',
  insertSecurityKeyPrompt: 'Insert your hardware security key, then press the button below to authenticate.',
  authenticate: 'Authenticate',
}

export default auth

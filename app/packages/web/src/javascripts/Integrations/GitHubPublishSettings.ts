// Device-local settings for the "Publish note to GitHub" feature. Stored in
// localStorage (unsynced) like the narration settings — these are per-device UI
// conveniences, not synced preferences.
//
// SECURITY: the PAT is a secret. It is stored ONLY when the user explicitly
// opts in ("Remember token on this device"), in a SEPARATE storage key from the
// non-secret repo/branch/path so it can be cleared independently. It is never
// synced to the server's settings store. Clearing the opt-in wipes the key.

const SETTINGS_KEY = 'standardnotes.github.publish.settings.v1'
const TOKEN_KEY = 'standardnotes.github.publish.token.v1'

export interface GitHubPublishSettings {
  /** "owner/repo" as last entered. */
  repo: string
  /** Target branch, defaults to "main". */
  branch: string
  /** Directory prefix within the repo (no filename). */
  pathPrefix: string
  /** Whether the user chose to remember the PAT on this device. */
  rememberToken: boolean
}

export const DEFAULT_GITHUB_PUBLISH_SETTINGS: GitHubPublishSettings = {
  repo: '',
  branch: 'main',
  pathPrefix: '',
  rememberToken: false,
}

export function loadGitHubPublishSettings(): GitHubPublishSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) {
      return { ...DEFAULT_GITHUB_PUBLISH_SETTINGS }
    }
    const parsed = JSON.parse(raw) as Partial<GitHubPublishSettings>
    return {
      repo: typeof parsed.repo === 'string' ? parsed.repo : '',
      branch: typeof parsed.branch === 'string' && parsed.branch.trim().length > 0 ? parsed.branch : 'main',
      pathPrefix: typeof parsed.pathPrefix === 'string' ? parsed.pathPrefix : '',
      rememberToken: parsed.rememberToken === true,
    }
  } catch {
    return { ...DEFAULT_GITHUB_PUBLISH_SETTINGS }
  }
}

export function saveGitHubPublishSettings(settings: GitHubPublishSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* storage may be unavailable (private mode); feature still works without persistence */
  }
}

/** Returns the remembered PAT, or '' when none is stored. */
export function loadRememberedToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Persists the PAT on this device (only call when the user opted in). */
export function saveRememberedToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* storage unavailable; user will re-enter the token next time */
  }
}

/** Removes any stored PAT from this device. */
export function clearRememberedToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* nothing to do */
  }
}

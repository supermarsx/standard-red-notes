/** Build-time constants */
declare const IS_SNAP: boolean

export const isSnap = IS_SNAP
export const autoUpdatingAvailable = !isSnap
export const keychainAccessIsUserConfigurable = isSnap

/**
 * The fork's GitHub repository that hosts releases. Update checks (both the
 * electron-updater auto-update feed and the lightweight "notify me" release
 * poll) target this repository's public GitHub releases. No token is required
 * for reading public releases.
 */
export const UpdateRepo = {
  owner: 'supermarsx',
  repo: 'standard-red-notes',
}

export const UpdateRepoReleasesUrl = `https://github.com/${UpdateRepo.owner}/${UpdateRepo.repo}/releases`
export const UpdateRepoLatestReleaseApiUrl = `https://api.github.com/repos/${UpdateRepo.owner}/${UpdateRepo.repo}/releases/latest`

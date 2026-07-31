/**
 * These names are owned by the Standard Red Notes server. The web app's
 * published @standardnotes/domain-core dependency does not yet include them,
 * so they intentionally use the settings service's raw-name API.
 */
export const NextcloudBackupSettingName = {
  Frequency: 'NEXTCLOUD_BACKUP_FREQUENCY',
  Url: 'NEXTCLOUD_BACKUP_URL',
  Folder: 'NEXTCLOUD_BACKUP_FOLDER',
  AppPassword: 'NEXTCLOUD_BACKUP_APP_PASSWORD',
} as const

export const NextcloudBackupFrequency = {
  Disabled: 'disabled',
  Daily: 'daily',
  Weekly: 'weekly',
  Monthly: 'monthly',
} as const

export type NextcloudFrequency = (typeof NextcloudBackupFrequency)[keyof typeof NextcloudBackupFrequency]

export type NextcloudBackupDraft = {
  frequency: NextcloudFrequency
  persistedFrequency: NextcloudFrequency
  url: string
  folder: string
  appPassword: string
  appPasswordIsSet: boolean
}

export type NextcloudSettingUpdater = (settingName: string, payload: string, sensitive?: boolean) => Promise<boolean>

export type SaveNextcloudBackupSettingsResult = {
  success: boolean
  appPasswordSaved: boolean
  effectiveFrequency: NextcloudFrequency
  failedSetting?: string
  validationError?: string
}

export function getNextcloudBackupValidationError(draft: NextcloudBackupDraft): string | undefined {
  const url = draft.url.trim()
  const folder = draft.folder.trim()
  const suppliedPassword = draft.appPassword
  const isEnabled = draft.frequency !== NextcloudBackupFrequency.Disabled

  if (url !== '') {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return 'Enter a valid Nextcloud base URL.'
    }
    if (parsed.protocol !== 'https:') {
      return 'Nextcloud backups require HTTPS; HTTP would expose the app password.'
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return 'Remove credentials from the Nextcloud URL and use the app-password field.'
    }
    if (parsed.search !== '' || parsed.hash !== '' || /[?#]/.test(url)) {
      return 'Use the final Nextcloud base URL without a query or fragment.'
    }
  }

  if (folder !== '') {
    const segments = folder.split('/').map((segment) => segment.trim())
    if (
      segments.some(
        (segment) =>
          segment === '' ||
          segment === '.' ||
          segment === '..' ||
          segment.includes('\\') ||
          containsControlCharacter(segment),
      )
    ) {
      return 'Use a safe folder path without empty, dot, dot-dot, backslash, or control-character segments.'
    }
  }

  if (suppliedPassword !== '' && suppliedPassword.trim() !== suppliedPassword) {
    return 'Remove leading or trailing whitespace from the app password.'
  }

  if (isEnabled) {
    if (url === '') {
      return 'Enter the final HTTPS Nextcloud base URL before enabling backups.'
    }
    if (!draft.appPasswordIsSet && suppliedPassword === '') {
      return 'Enter a dedicated, low-privilege Nextcloud app password before enabling backups.'
    }
  }

  return undefined
}

/**
 * Fail closed when editing an active setup: disable scheduling first, mutate
 * the destination and credential, then reactivate only after every write has
 * succeeded. Each write is attempted once and the sequence stops at the first
 * failure. A disabled target is never redundantly written at the end.
 */
export async function saveNextcloudBackupSettings(
  draft: NextcloudBackupDraft,
  updateSetting: NextcloudSettingUpdater,
): Promise<SaveNextcloudBackupSettingsResult> {
  const validationError = getNextcloudBackupValidationError(draft)
  if (validationError) {
    return {
      success: false,
      appPasswordSaved: false,
      effectiveFrequency: draft.persistedFrequency,
      validationError,
    }
  }

  let effectiveFrequency = draft.persistedFrequency
  if (draft.persistedFrequency !== NextcloudBackupFrequency.Disabled) {
    if (!(await updateSetting(NextcloudBackupSettingName.Frequency, NextcloudBackupFrequency.Disabled))) {
      return {
        success: false,
        appPasswordSaved: false,
        effectiveFrequency,
        failedSetting: NextcloudBackupSettingName.Frequency,
      }
    }
    effectiveFrequency = NextcloudBackupFrequency.Disabled
  }

  if (!(await updateSetting(NextcloudBackupSettingName.Url, draft.url.trim()))) {
    return {
      success: false,
      appPasswordSaved: false,
      effectiveFrequency,
      failedSetting: NextcloudBackupSettingName.Url,
    }
  }
  if (!(await updateSetting(NextcloudBackupSettingName.Folder, draft.folder.trim()))) {
    return {
      success: false,
      appPasswordSaved: false,
      effectiveFrequency,
      failedSetting: NextcloudBackupSettingName.Folder,
    }
  }

  let appPasswordSaved = false
  if (draft.appPassword !== '') {
    if (!(await updateSetting(NextcloudBackupSettingName.AppPassword, draft.appPassword, true))) {
      return {
        success: false,
        appPasswordSaved: false,
        effectiveFrequency,
        failedSetting: NextcloudBackupSettingName.AppPassword,
      }
    }
    appPasswordSaved = true
  }

  if (draft.frequency !== NextcloudBackupFrequency.Disabled) {
    if (!(await updateSetting(NextcloudBackupSettingName.Frequency, draft.frequency))) {
      return {
        success: false,
        appPasswordSaved,
        effectiveFrequency,
        failedSetting: NextcloudBackupSettingName.Frequency,
      }
    }
    effectiveFrequency = draft.frequency
  }

  return { success: true, appPasswordSaved, effectiveFrequency }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

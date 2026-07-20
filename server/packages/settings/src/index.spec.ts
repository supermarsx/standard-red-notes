import * as settings from './index'

import { MuteFailedBackupsEmailsOption } from './Domain/MuteFailedBackupsEmails/MuteFailedBackupsEmailsOption'

// Every value below is persisted verbatim as a user setting value and compared against by
// `@standardnotes/auth` (SettingsAssociationService, SessionService, VerifyPredicate,
// TriggerPostSettingUpdateActions, TriggerNextcloudBackupForUser, NextcloudBackupDueCalculator).
// Renaming one silently changes the meaning of rows that are already stored, so the literal
// strings — not the enum member names — are the contract these tests exist to pin.

describe('settings', () => {
  it('exposes exactly the four persisted email backup frequencies', () => {
    expect({ ...settings.EmailBackupFrequency }).toEqual({
      Disabled: 'disabled',
      Daily: 'daily',
      Weekly: 'weekly',
      Monthly: 'monthly',
    })
  })

  it('exposes exactly the four persisted Nextcloud backup frequencies', () => {
    expect({ ...settings.NextcloudBackupFrequency }).toEqual({
      Disabled: 'disabled',
      Daily: 'daily',
      Weekly: 'weekly',
      Monthly: 'monthly',
    })
  })

  it('exposes exactly the two persisted session user agent logging options', () => {
    expect({ ...settings.LogSessionUserAgentOption }).toEqual({
      Disabled: 'disabled',
      Enabled: 'enabled',
    })
  })

  it('exposes exactly the two persisted marketing email mute options', () => {
    expect({ ...settings.MuteMarketingEmailsOption }).toEqual({
      Muted: 'muted',
      NotMuted: 'not_muted',
    })
  })

  it('exposes exactly the two persisted sign-in email mute options', () => {
    expect({ ...settings.MuteSignInEmailsOption }).toEqual({
      Muted: 'muted',
      NotMuted: 'not_muted',
    })
  })

  it('exposes exactly the two persisted failed-backup email mute options', () => {
    expect({ ...MuteFailedBackupsEmailsOption }).toEqual({
      Muted: 'muted',
      NotMuted: 'not_muted',
    })
  })

  it('shares the same disabled sentinel between both backup frequencies', () => {
    // VerifyPredicate and TriggerNextcloudBackupForUser both read 'disabled' as
    // "no backup scheduled" without knowing which frequency enum produced the value.
    expect(String(settings.EmailBackupFrequency.Disabled)).toEqual(String(settings.NextcloudBackupFrequency.Disabled))
  })

  it('uses the same muted/not_muted pair for every mute option', () => {
    // Auth stores all three mute settings through one code path; divergent literals
    // would make a muted setting read back as unmuted.
    expect(String(settings.MuteMarketingEmailsOption.Muted)).toEqual(String(settings.MuteSignInEmailsOption.Muted))
    expect(String(settings.MuteMarketingEmailsOption.Muted)).toEqual(String(MuteFailedBackupsEmailsOption.Muted))
    expect(String(settings.MuteMarketingEmailsOption.NotMuted)).toEqual(String(MuteFailedBackupsEmailsOption.NotMuted))
  })

  it('exports exactly this published runtime surface', () => {
    // NOTE: MuteFailedBackupsEmailsOption is absent because src/Domain/index.ts never
    // re-exports it. That omission is a reported defect, not an intended API shape; this
    // assertion is here to catch *accidental* additions to or removals from a published package.
    expect(Object.keys(settings).sort()).toEqual([
      'EmailBackupFrequency',
      'LogSessionUserAgentOption',
      'MuteMarketingEmailsOption',
      'MuteSignInEmailsOption',
      'NextcloudBackupFrequency',
    ])
  })

  it('declares every option as a string enum with no numeric reverse mapping', () => {
    for (const [name, enumeration] of Object.entries(settings)) {
      for (const [key, value] of Object.entries(enumeration as Record<string, string>)) {
        expect(`${name}.${key}: ${typeof value}`).toEqual(`${name}.${key}: string`)
        expect((enumeration as Record<string, unknown>)[value]).toBeUndefined()
      }
    }
  })
})

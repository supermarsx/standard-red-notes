/**
 * Standard Red Notes: Typography Profiles — Phase 4 (Settings management UI).
 *
 * The management surface for the multiple typography profiles introduced in P1.
 * Lives in the Appearance preferences pane (a "Style profiles" subtab). Lets the
 * user pick the ACTIVE profile (P1's NoteView re-applies live) and manage the
 * full set: create, rename, set-default (single winner), duplicate, delete
 * (guarded), edit styles (reuses the generalised P3 modal for the selected
 * profile), and import / export a profile as sanitised JSON.
 *
 * All mutations persist immutably through `application.setPreference`. The pure
 * CRUD / sanitisation logic lives in `Utils/typographyProfileEditor` and
 * `Utils/typographyProfileImportExport`; this component is just the wiring.
 */
import { FunctionComponent, useMemo, useState } from 'react'
import { PrefKey } from '@standardnotes/snjs'
import { confirmDialog, alertDialog } from '@standardnotes/ui-services'
import { ClassicFileReader } from '@standardnotes/filepicker'
import { useApplication } from '@/Components/ApplicationProvider'
import usePreference from '@/Hooks/usePreference'
import { Subtitle, Text, SmallText } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import Button from '@/Components/Button/Button'
import Dropdown from '@/Components/Dropdown/Dropdown'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import { resolveActiveTypographyProfile } from '@/Utils/typographyProfiles'
import {
  canDeleteProfile,
  createProfile,
  deleteProfile,
  duplicateProfile,
  renameProfile,
  setDefaultProfile,
  uniqueProfileName,
} from '@/Utils/typographyProfileEditor'
import {
  exportFileNameForProfile,
  parseImportedProfile,
  profileToExportJson,
} from '@/Utils/typographyProfileImportExport'
import TypographyStyleEditorModal from '@/Components/SuperEditor/Plugins/ToolbarPlugin/TypographyStyleEditorModal'

const StyleProfiles: FunctionComponent = () => {
  const application = useApplication()
  const profiles = usePreference(PrefKey.TypographyProfiles)
  const activeIdPref = usePreference(PrefKey.ActiveTypographyProfileId)

  const activeProfile = useMemo(() => resolveActiveTypographyProfile(profiles, activeIdPref), [profiles, activeIdPref])
  const activeId = activeProfile?.id ?? activeIdPref

  const [editingProfileId, setEditingProfileId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const persistProfiles = (updated: typeof profiles): void => {
    void application.setPreference(PrefKey.TypographyProfiles, updated)
  }

  const setActive = (id: string): void => {
    void application.setPreference(PrefKey.ActiveTypographyProfileId, id)
  }

  const profileItems = useMemo(
    () => profiles.map((profile) => ({ label: profile.name, value: profile.id })),
    [profiles],
  )

  const handleNew = (): void => {
    const { profiles: updated } = createProfile(profiles)
    persistProfiles(updated)
  }

  const handleDuplicate = (id: string): void => {
    const { profiles: updated } = duplicateProfile(profiles, id)
    persistProfiles(updated)
  }

  const startRename = (id: string, currentName: string): void => {
    setRenamingId(id)
    setRenameValue(currentName)
  }

  const commitRename = (): void => {
    if (renamingId) {
      persistProfiles(renameProfile(profiles, renamingId, renameValue))
    }
    setRenamingId(null)
    setRenameValue('')
  }

  const handleSetDefault = async (id: string, name: string): Promise<void> => {
    const confirmed = await confirmDialog({
      title: 'Set default profile',
      text: `Make "${name}" the default typography profile? It will be used when no other profile is active.`,
      confirmButtonText: 'Set default',
    })
    if (confirmed) {
      persistProfiles(setDefaultProfile(profiles, id))
    }
  }

  const handleDelete = async (id: string, name: string): Promise<void> => {
    const confirmed = await confirmDialog({
      title: 'Delete profile',
      text: `Delete the typography profile "${name}"? This cannot be undone.`,
      confirmButtonText: 'Delete',
      confirmButtonStyle: 'danger',
    })
    if (!confirmed) {
      return
    }
    const { profiles: updated, activeId: nextActiveId } = deleteProfile(profiles, activeId, id)
    persistProfiles(updated)
    if (nextActiveId && nextActiveId !== activeId) {
      setActive(nextActiveId)
    }
  }

  const handleExport = (profile: (typeof profiles)[number]): void => {
    const blob = new Blob([profileToExportJson(profile)], { type: 'application/json' })
    application.archiveService.downloadData(blob, exportFileNameForProfile(profile))
  }

  const handleImport = async (): Promise<void> => {
    const files = await ClassicFileReader.selectFiles()
    const file = files[0]
    if (!file) {
      return
    }
    let text: string
    try {
      text = await file.text()
    } catch {
      void alertDialog({ title: 'Import failed', text: 'The selected file could not be read.' })
      return
    }
    const result = parseImportedProfile(text)
    if (!result.ok) {
      void alertDialog({ title: 'Import failed', text: result.error })
      return
    }
    const imported = { ...result.profile, name: uniqueProfileName(profiles, result.profile.name) }
    persistProfiles([...profiles, imported])
  }

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Subtitle>Active profile</Subtitle>
        <Text>
          The typography profile applied to Super notes — the editor, the read-only viewer and previews all update live.
          Profiles are synced across your devices.
        </Text>
        <div className="mt-2 max-w-xs">
          <Dropdown
            label="Select the active typography profile"
            items={profileItems}
            value={activeId ?? ''}
            onChange={setActive}
          />
        </div>

        <HorizontalSeparator classes="my-4" />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Subtitle>Profiles</Subtitle>
          <div className="flex flex-shrink-0 items-center gap-2">
            <Button small label="Import…" onClick={() => void handleImport()} />
            <Button small primary label="New profile" onClick={handleNew} />
          </div>
        </div>
        <Text>Create, edit and organise your typography profiles. Import shares a profile from a .json file.</Text>

        <div className="mt-3 flex flex-col gap-2">
          {profiles.map((profile) => {
            const isActive = profile.id === activeId
            const isRenaming = renamingId === profile.id
            const deletable = canDeleteProfile(profiles, profile.id)
            return (
              <div
                key={profile.id}
                className="border-border flex flex-col gap-2 rounded border px-3 py-2 md:flex-row md:items-center md:justify-between"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {isRenaming ? (
                    <input
                      type="text"
                      autoFocus
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          commitRename()
                        } else if (event.key === 'Escape') {
                          setRenamingId(null)
                          setRenameValue('')
                        }
                      }}
                      className="border-border bg-default text-text focus:border-info min-w-0 rounded border px-2 py-1 text-sm focus:outline-none"
                    />
                  ) : (
                    <span className="text-text truncate text-sm font-medium">{profile.name}</span>
                  )}
                  {profile.isDefault && <span className="text-passive-0 flex-shrink-0 text-xs font-bold">default</span>}
                  {isActive && <span className="text-info flex-shrink-0 text-xs font-bold">active</span>}
                </div>

                <div className="flex min-w-0 flex-wrap items-center gap-2 md:justify-end">
                  <Button small label="Edit styles…" onClick={() => setEditingProfileId(profile.id)} />
                  <Button small label="Rename" onClick={() => startRename(profile.id, profile.name)} />
                  <Button
                    small
                    label="Set default"
                    disabled={profile.isDefault}
                    onClick={() => void handleSetDefault(profile.id, profile.name)}
                  />
                  <Button small label="Duplicate" onClick={() => handleDuplicate(profile.id)} />
                  <Button small label="Export" onClick={() => handleExport(profile)} />
                  <Button
                    small
                    colorStyle="danger"
                    label="Delete"
                    disabled={!deletable}
                    onClick={() => void handleDelete(profile.id, profile.name)}
                  />
                </div>
              </div>
            )
          })}
          {profiles.length === 0 && <SmallText className="text-passive-0">No profiles.</SmallText>}
        </div>
      </PreferencesSegment>

      <TypographyStyleEditorModal
        isOpen={editingProfileId !== null}
        close={() => setEditingProfileId(null)}
        profileId={editingProfileId ?? undefined}
      />
    </PreferencesGroup>
  )
}

export default StyleProfiles

import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'

import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import { ToastType, addToast } from '@standardnotes/toast'
import { AdminAssignmentsView } from './adminHelpers'
import { MaskedAiProfile } from './aiProfiles'

/** The four canonical roles a profile may be assigned to (server-validated). */
const ASSIGNABLE_ROLES: { name: string; label: string }[] = [
  { name: 'INTERNAL_TEAM_USER', label: 'Admin (internal team)' },
  { name: 'PRO_USER', label: 'Full user (Pro)' },
  { name: 'CORE_USER', label: 'Core user' },
  { name: 'VAULTS_USER', label: 'Vaults user' },
]

type Props = {
  profiles: MaskedAiProfile[]
  assignments: AdminAssignmentsView
  busy: boolean
  onSave: (update: { assignments: AdminAssignmentsView }) => Promise<boolean>
}

type UserRow = { identifier: string; profileId: string }

const signatureOf = (assignments: AdminAssignmentsView): string => JSON.stringify(assignments)

/**
 * Standard Red Notes: assign an assistant profile to specific users (by email or
 * uuid) and to the canonical roles. At request time the gateway resolves the
 * effective profile with precedence USER > ROLE > server default.
 */
const ProfileAssignmentsSection: FunctionComponent<Props> = ({ profiles, assignments, busy, onSave }) => {
  const signature = useMemo(() => signatureOf(assignments), [assignments])
  const [userRows, setUserRows] = useState<UserRow[]>(() =>
    Object.entries(assignments.users ?? {}).map(([identifier, profileId]) => ({ identifier, profileId })),
  )
  const [roleMap, setRoleMap] = useState<Record<string, string>>(() => ({ ...(assignments.roles ?? {}) }))
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setUserRows(Object.entries(assignments.users ?? {}).map(([identifier, profileId]) => ({ identifier, profileId })))
    setRoleMap({ ...(assignments.roles ?? {}) })
    setDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  const enabledProfiles = useMemo(() => profiles.filter((profile) => profile.enabled), [profiles])

  const mutateUserRow = useCallback((index: number, patch: Partial<UserRow>) => {
    setUserRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
    setDirty(true)
  }, [])

  const addUserRow = useCallback(() => {
    setUserRows((current) => [...current, { identifier: '', profileId: enabledProfiles[0]?.id ?? '' }])
    setDirty(true)
  }, [enabledProfiles])

  const removeUserRow = useCallback((index: number) => {
    setUserRows((current) => current.filter((_, i) => i !== index))
    setDirty(true)
  }, [])

  const setRole = useCallback((roleName: string, profileId: string) => {
    setRoleMap((current) => {
      const next = { ...current }
      if (profileId === '') {
        delete next[roleName]
      } else {
        next[roleName] = profileId
      }
      return next
    })
    setDirty(true)
  }, [])

  const handleSave = useCallback(async () => {
    const users: Record<string, string> = {}
    for (const row of userRows) {
      const identifier = row.identifier.trim().toLowerCase()
      if (identifier === '') {
        continue
      }
      if (row.profileId === '') {
        addToast({ type: ToastType.Error, message: `Pick a profile for "${row.identifier}".` })
        return
      }
      users[identifier] = row.profileId
    }
    await onSave({ assignments: { users, roles: roleMap } })
  }, [userRows, roleMap, onSave])

  const profileOptions = (includeNone: boolean) => (
    <>
      {includeNone && <option value="">— none —</option>}
      {enabledProfiles.map((profile) => (
        <option key={profile.id} value={profile.id}>
          {profile.name || profile.id}
        </option>
      ))}
    </>
  )

  return (
    <PreferencesSegment>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Title>Profile assignments</Title>
        <div className="flex items-center gap-2">
          <Button label="Add user assignment" onClick={addUserRow} disabled={busy} />
          <Button
            label={busy ? 'Saving…' : 'Save assignments'}
            primary
            onClick={() => void handleSave()}
            disabled={busy || !dirty}
          />
        </div>
      </div>
      <Text className="mt-1">
        Assign an assistant profile to specific users or to a role. At request time the effective profile is resolved
        with precedence <strong>user &gt; role &gt; default</strong>. Users are matched by email or uuid.
      </Text>

      <Subtitle className="mt-4">By user</Subtitle>
      {userRows.length === 0 && <Text className="mt-1 text-passive-1">No per-user assignments.</Text>}
      {userRows.map((row, index) => (
        <div key={index} className="mt-2 flex flex-wrap items-center gap-2">
          <DecoratedInput
            className={{ container: 'w-72' }}
            placeholder="user email or uuid"
            value={row.identifier}
            onChange={(value) => mutateUserRow(index, { identifier: value })}
            disabled={busy}
          />
          <select
            className="rounded border border-border bg-default px-2 py-1.5 text-foreground"
            value={row.profileId}
            onChange={(event) => mutateUserRow(index, { profileId: event.target.value })}
            disabled={busy}
          >
            {profileOptions(false)}
          </select>
          <Button label="Remove" colorStyle="danger" onClick={() => removeUserRow(index)} disabled={busy} />
        </div>
      ))}

      <Subtitle className="mt-4">By role</Subtitle>
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
        {ASSIGNABLE_ROLES.map((role) => (
          <div key={role.name} className="flex items-center justify-between gap-2 rounded border border-border p-2">
            <span className="text-sm font-medium text-foreground">{role.label}</span>
            <select
              className="rounded border border-border bg-default px-2 py-1.5 text-foreground"
              value={roleMap[role.name] ?? ''}
              onChange={(event) => setRole(role.name, event.target.value)}
              disabled={busy}
            >
              {profileOptions(true)}
            </select>
          </div>
        ))}
      </div>

      <HorizontalSeparator classes="my-4" />
    </PreferencesSegment>
  )
}

export default ProfileAssignmentsSection

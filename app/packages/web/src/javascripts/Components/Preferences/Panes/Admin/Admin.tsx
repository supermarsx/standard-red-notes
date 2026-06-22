import { observer } from 'mobx-react-lite'
import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Switch from '@/Components/Switch/Switch'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import { ToastType, addToast } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'

type Props = {
  application: WebApplication
}

type LookedUpUser = {
  uuid: string
  email: string
}

type AdminGroup = {
  uuid: string
  name: string
  description: string | null
  roleNames: string[]
}

type GroupMember = {
  uuid: string
  email: string | null
}

// Server-only Standard Red Notes setting names. The client's published
// domain-core does not carry these, so use the literal strings the server
// expects (must match the server's SettingName.NAMES values exactly).
const AI_ENABLED = 'AI_ENABLED'
const AI_REQUEST_LIMIT = 'AI_REQUEST_LIMIT'
const COLLABORATION_ENABLED = 'COLLABORATION_ENABLED'
const LIVE_SYNC_ENABLED = 'LIVE_SYNC_ENABLED'
// OPT-IN server-side PDF OCR. Defaults OFF (privacy: enabling lets this user send
// decrypted PDF page images to the server, which leaves end-to-end encryption).
const OCR_SERVER_ALLOWED = 'OCR_SERVER_ALLOWED'
// OPT-IN scheduled Nextcloud backups. Defaults OFF. Backups remain E2E ciphertext
// (content stays private), but the server-stored app password grants Nextcloud file
// access and upload timing/size are exposed. See the privacy alert near the toggle.
const NEXTCLOUD_BACKUP_ALLOWED = 'NEXTCLOUD_BACKUP_ALLOWED'
// READ-ONLY view of the user's Nextcloud backup cadence (disabled|daily|weekly|
// monthly). Surfaced so the admin can SEE the user's backup state.
const NEXTCLOUD_BACKUP_FREQUENCY = 'NEXTCLOUD_BACKUP_FREQUENCY'

const Admin: FunctionComponent<Props> = ({ application }: Props) => {
  const isAdmin = application.featuresController.isAdminUser()

  const [email, setEmail] = useState('')
  const [lookingUp, setLookingUp] = useState(false)
  const [user, setUser] = useState<LookedUpUser | undefined>(undefined)

  const [aiEnabled, setAiEnabled] = useState(false)
  const [aiRequestLimit, setAiRequestLimit] = useState('')
  // Collaboration and live sync default to ENABLED; they are gated off only when
  // the per-user setting is explicitly 'false'.
  const [collaborationEnabled, setCollaborationEnabled] = useState(true)
  const [liveSyncEnabled, setLiveSyncEnabled] = useState(true)
  // Server OCR is OFF by default (opt-in E2E downgrade); only 'true' enables it.
  const [ocrServerAllowed, setOcrServerAllowed] = useState(false)
  // Nextcloud backups are OFF by default; only 'true' enables them. The cadence and
  // app-password-configured status are read-only context for the admin.
  const [nextcloudBackupAllowed, setNextcloudBackupAllowed] = useState(false)
  const [nextcloudBackupFrequency, setNextcloudBackupFrequency] = useState<string | null>(null)
  const [nextcloudAppPasswordConfigured, setNextcloudAppPasswordConfigured] = useState(false)
  const [flagsLoading, setFlagsLoading] = useState(false)
  const [savingLimit, setSavingLimit] = useState(false)

  const [banned, setBanned] = useState(false)
  const [banningInProgress, setBanningInProgress] = useState(false)

  const [registrationDisabled, setRegistrationDisabled] = useState(false)
  const [registrationLoading, setRegistrationLoading] = useState(false)

  // RBAC groups & permissions state.
  const [availableRoles, setAvailableRoles] = useState<string[]>([])
  const [groups, setGroups] = useState<AdminGroup[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupDescription, setNewGroupDescription] = useState('')
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [selectedGroupUuid, setSelectedGroupUuid] = useState<string | null>(null)
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [newMemberUuid, setNewMemberUuid] = useState('')

  const loadGroups = useCallback(async () => {
    if (!isAdmin) {
      return
    }
    setGroupsLoading(true)
    try {
      const [rolesResponse, groupsResponse] = await Promise.all([
        application.legacyApi.adminGetAvailableRoles(),
        application.legacyApi.adminListGroups(),
      ])
      if (!isErrorResponse(rolesResponse)) {
        const data = (rolesResponse as { data?: { roleNames?: string[] } }).data
        setAvailableRoles(data?.roleNames ?? [])
      }
      if (!isErrorResponse(groupsResponse)) {
        const data = (groupsResponse as { data?: { groups?: AdminGroup[] } }).data
        setGroups(data?.groups ?? [])
      }
    } catch (error) {
      console.error(error)
    } finally {
      setGroupsLoading(false)
    }
  }, [application, isAdmin])

  useEffect(() => {
    void loadGroups()
  }, [loadGroups])

  const createGroup = useCallback(async () => {
    if (!newGroupName.trim()) {
      return
    }
    setCreatingGroup(true)
    try {
      const response = await application.legacyApi.adminCreateGroup(
        newGroupName.trim(),
        newGroupDescription.trim() === '' ? null : newGroupDescription.trim(),
        [],
      )
      if (isErrorResponse(response)) {
        addToast({ type: ToastType.Error, message: 'Failed to create group.' })
        return
      }
      setNewGroupName('')
      setNewGroupDescription('')
      addToast({ type: ToastType.Success, message: 'Group created.' })
      await loadGroups()
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to create group.' })
    } finally {
      setCreatingGroup(false)
    }
  }, [application, newGroupName, newGroupDescription, loadGroups])

  const deleteGroup = useCallback(
    async (group: AdminGroup) => {
      const confirmed = await confirmDialog({
        title: 'Delete group',
        text: `Delete group "${group.name}"? Members will lose any roles this group conferred.`,
        confirmButtonText: 'Delete group',
        confirmButtonStyle: 'danger',
      })
      if (!confirmed) {
        return
      }
      try {
        const response = await application.legacyApi.adminDeleteGroup(group.uuid)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to delete group.' })
          return
        }
        if (selectedGroupUuid === group.uuid) {
          setSelectedGroupUuid(null)
          setGroupMembers([])
        }
        await loadGroups()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to delete group.' })
      }
    },
    [application, loadGroups, selectedGroupUuid],
  )

  const toggleGroupRole = useCallback(
    async (group: AdminGroup, roleName: string, enabled: boolean) => {
      const nextRoles = enabled
        ? Array.from(new Set([...group.roleNames, roleName]))
        : group.roleNames.filter((name) => name !== roleName)
      // Optimistic update of the local group list.
      setGroups((current) => current.map((g) => (g.uuid === group.uuid ? { ...g, roleNames: nextRoles } : g)))
      try {
        const response = await application.legacyApi.adminSetGroupRoles(group.uuid, nextRoles)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to update group roles.' })
          await loadGroups()
        }
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to update group roles.' })
        await loadGroups()
      }
    },
    [application, loadGroups],
  )

  const loadGroupMembers = useCallback(
    async (groupUuid: string) => {
      setSelectedGroupUuid(groupUuid)
      setMembersLoading(true)
      try {
        const response = await application.legacyApi.adminListGroupMembers(groupUuid)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to load group members.' })
          return
        }
        const data = (response as { data?: { members?: GroupMember[] } }).data
        setGroupMembers(data?.members ?? [])
      } catch (error) {
        console.error(error)
      } finally {
        setMembersLoading(false)
      }
    },
    [application],
  )

  const addMember = useCallback(async () => {
    if (!selectedGroupUuid || !newMemberUuid.trim()) {
      return
    }
    try {
      const response = await application.legacyApi.adminAddUserToGroup(selectedGroupUuid, newMemberUuid.trim())
      if (isErrorResponse(response)) {
        addToast({ type: ToastType.Error, message: 'Failed to add member. Provide a valid user UUID.' })
        return
      }
      setNewMemberUuid('')
      await loadGroupMembers(selectedGroupUuid)
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to add member.' })
    }
  }, [application, selectedGroupUuid, newMemberUuid, loadGroupMembers])

  const removeMember = useCallback(
    async (memberUuid: string) => {
      if (!selectedGroupUuid) {
        return
      }
      try {
        const response = await application.legacyApi.adminRemoveUserFromGroup(selectedGroupUuid, memberUuid)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to remove member.' })
          return
        }
        await loadGroupMembers(selectedGroupUuid)
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to remove member.' })
      }
    },
    [application, selectedGroupUuid, loadGroupMembers],
  )

  const loadRegistrationFlag = useCallback(async () => {
    if (!isAdmin) {
      return
    }
    setRegistrationLoading(true)
    try {
      const response = await application.legacyApi.adminGetRegistrationFlag()
      if (!isErrorResponse(response)) {
        const data = (response as { data?: { registrationDisabled?: boolean } }).data
        setRegistrationDisabled(Boolean(data?.registrationDisabled))
      }
    } catch (error) {
      console.error(error)
    } finally {
      setRegistrationLoading(false)
    }
  }, [application, isAdmin])

  useEffect(() => {
    void loadRegistrationFlag()
  }, [loadRegistrationFlag])

  const loadFlags = useCallback(
    async (userUuid: string) => {
      setFlagsLoading(true)
      try {
        const response = await application.legacyApi.adminGetUserFeatureFlags(userUuid)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to load user feature flags.' })
          return
        }
        const data = (response as {
          data?: { flags?: Record<string, string | null>; nextcloudAppPasswordConfigured?: boolean }
        }).data
        const flags = data?.flags ?? {}
        setAiEnabled(flags[AI_ENABLED] === 'true')
        setAiRequestLimit(flags[AI_REQUEST_LIMIT] ?? '')
        setCollaborationEnabled(flags[COLLABORATION_ENABLED] !== 'false')
        setLiveSyncEnabled(flags[LIVE_SYNC_ENABLED] !== 'false')
        setOcrServerAllowed(flags[OCR_SERVER_ALLOWED] === 'true')
        setNextcloudBackupAllowed(flags[NEXTCLOUD_BACKUP_ALLOWED] === 'true')
        setNextcloudBackupFrequency(flags[NEXTCLOUD_BACKUP_FREQUENCY] ?? null)
        setNextcloudAppPasswordConfigured(Boolean(data?.nextcloudAppPasswordConfigured))
      } catch (error) {
        console.error(error)
      } finally {
        setFlagsLoading(false)
      }
    },
    [application],
  )

  const loadBanStatus = useCallback(
    async (lookupEmail: string) => {
      try {
        const response = await application.legacyApi.adminGetUserBanStatus(lookupEmail)
        if (isErrorResponse(response)) {
          return
        }
        const data = (response as { data?: { banned?: boolean } }).data
        setBanned(Boolean(data?.banned))
      } catch (error) {
        console.error(error)
      }
    },
    [application],
  )

  const lookupUser = useCallback(async () => {
    if (!email.trim()) {
      return
    }
    setLookingUp(true)
    setUser(undefined)
    setBanned(false)
    try {
      const response = await application.legacyApi.adminLookupUser(email.trim())
      if (isErrorResponse(response)) {
        addToast({ type: ToastType.Error, message: 'No user found with that email.' })
        return
      }
      const data = (response as { data?: { uuid?: string } }).data
      if (!data?.uuid) {
        addToast({ type: ToastType.Error, message: 'No user found with that email.' })
        return
      }
      const lookedUp = { uuid: data.uuid, email: email.trim() }
      setUser(lookedUp)
      await Promise.all([loadFlags(lookedUp.uuid), loadBanStatus(lookedUp.email)])
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to look up user.' })
    } finally {
      setLookingUp(false)
    }
  }, [application, email, loadFlags, loadBanStatus])

  const toggleAiEnabled = useCallback(
    async (nextValue: boolean) => {
      if (!user) {
        return
      }
      const previous = aiEnabled
      setAiEnabled(nextValue)
      try {
        const response = await application.legacyApi.adminSetUserFeatureFlag(
          user.uuid,
          AI_ENABLED,
          nextValue ? 'true' : 'false',
        )
        if (isErrorResponse(response)) {
          setAiEnabled(previous)
          addToast({ type: ToastType.Error, message: 'Failed to update AI access.' })
        }
      } catch (error) {
        console.error(error)
        setAiEnabled(previous)
        addToast({ type: ToastType.Error, message: 'Failed to update AI access.' })
      }
    },
    [application, user, aiEnabled],
  )

  const toggleUserFlag = useCallback(
    async (
      settingName: string,
      enabled: boolean,
      setLocal: (value: boolean) => void,
      previous: boolean,
      failureMessage: string,
    ) => {
      if (!user) {
        return
      }
      setLocal(enabled)
      try {
        // Enabled is the default, so we only persist an explicit 'false' to gate
        // the feature off; turning it back on stores 'true'.
        const response = await application.legacyApi.adminSetUserFeatureFlag(
          user.uuid,
          settingName,
          enabled ? 'true' : 'false',
        )
        if (isErrorResponse(response)) {
          setLocal(previous)
          addToast({ type: ToastType.Error, message: failureMessage })
        }
      } catch (error) {
        console.error(error)
        setLocal(previous)
        addToast({ type: ToastType.Error, message: failureMessage })
      }
    },
    [application, user],
  )

  const saveRequestLimit = useCallback(async () => {
    if (!user) {
      return
    }
    setSavingLimit(true)
    try {
      const response = await application.legacyApi.adminSetUserFeatureFlag(
        user.uuid,
        AI_REQUEST_LIMIT,
        aiRequestLimit.trim() === '' ? null : aiRequestLimit.trim(),
      )
      if (isErrorResponse(response)) {
        addToast({ type: ToastType.Error, message: 'Failed to update AI request limit.' })
        return
      }
      addToast({ type: ToastType.Success, message: 'AI request limit saved.' })
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to update AI request limit.' })
    } finally {
      setSavingLimit(false)
    }
  }, [application, user, aiRequestLimit])

  const toggleBan = useCallback(
    async (nextBanned: boolean) => {
      if (!user) {
        return
      }

      const confirmed = await confirmDialog({
        title: nextBanned ? 'Ban user' : 'Unban user',
        text: nextBanned
          ? `Ban ${user.email}? They will be signed out and blocked from accessing their account until unbanned.`
          : `Unban ${user.email}? They will regain access to their account.`,
        confirmButtonText: nextBanned ? 'Ban user' : 'Unban user',
        confirmButtonStyle: nextBanned ? 'danger' : 'info',
      })
      if (!confirmed) {
        return
      }

      const previous = banned
      setBanned(nextBanned)
      setBanningInProgress(true)
      try {
        const response = await application.legacyApi.adminSetUserBanStatus(user.uuid, nextBanned)
        if (isErrorResponse(response)) {
          setBanned(previous)
          addToast({ type: ToastType.Error, message: 'Failed to update ban status.' })
          return
        }
        addToast({
          type: ToastType.Success,
          message: nextBanned ? 'User has been banned.' : 'User has been unbanned.',
        })
      } catch (error) {
        console.error(error)
        setBanned(previous)
        addToast({ type: ToastType.Error, message: 'Failed to update ban status.' })
      } finally {
        setBanningInProgress(false)
      }
    },
    [application, user, banned],
  )

  const toggleRegistration = useCallback(
    async (nextValue: boolean) => {
      const previous = registrationDisabled
      setRegistrationDisabled(nextValue)
      try {
        const response = await application.legacyApi.adminSetRegistrationFlag(nextValue)
        if (isErrorResponse(response)) {
          setRegistrationDisabled(previous)
          addToast({ type: ToastType.Error, message: 'Failed to update registration setting.' })
        }
      } catch (error) {
        console.error(error)
        setRegistrationDisabled(previous)
        addToast({ type: ToastType.Error, message: 'Failed to update registration setting.' })
      }
    },
    [application, registrationDisabled],
  )

  if (!isAdmin) {
    return (
      <PreferencesPane>
        <PreferencesGroup>
          <PreferencesSegment>
            <Title>Admin</Title>
            <Text>
              You do not have administrator access. This panel is only available to users with the internal team role.
            </Text>
          </PreferencesSegment>
        </PreferencesGroup>
      </PreferencesPane>
    )
  }

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Administrator</Title>
          <Text>
            You are signed in with the internal team (admin) role. Use the tools below to manage other users' access to
            AI features and to control whether new signups are allowed. All actions are re-verified against your role on
            the server.
          </Text>
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Manage user AI access</Title>
          <Subtitle>Look up a user by email to manage their per-user feature flags.</Subtitle>
          <div className="mt-3 flex items-center gap-3">
            <DecoratedInput
              className={{ container: 'flex-grow' }}
              placeholder="user@example.com"
              value={email}
              onChange={setEmail}
              onEnter={() => void lookupUser()}
              type="email"
            />
            <Button label="Look up" onClick={() => void lookupUser()} disabled={lookingUp} />
          </div>
          {lookingUp && <Spinner className="mt-3 h-5 w-5" />}

          {user && (
            <div className="mt-4">
              <HorizontalSeparator classes="my-3" />
              <Subtitle>
                Editing: {user.email} ({user.uuid})
              </Subtitle>

              {flagsLoading ? (
                <Spinner className="mt-3 h-5 w-5" />
              ) : (
                <>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <div className="flex flex-col">
                      <Subtitle>AI access</Subtitle>
                      <Text>Allow this user to use AI-powered features.</Text>
                    </div>
                    <Switch checked={aiEnabled} onChange={(checked) => void toggleAiEnabled(checked)} />
                  </div>

                  <HorizontalSeparator classes="my-3" />

                  <div className="flex flex-col gap-2">
                    <Subtitle>AI request / token limit</Subtitle>
                    <Text>Maximum number of AI requests/tokens allowed for this user. Leave blank for no limit.</Text>
                    <div className="mt-1 flex items-center gap-3">
                      <DecoratedInput
                        className={{ container: 'w-40' }}
                        placeholder="e.g. 1000"
                        value={aiRequestLimit}
                        onChange={setAiRequestLimit}
                        type="number"
                      />
                      <Button label="Save limit" onClick={() => void saveRequestLimit()} disabled={savingLimit} />
                    </div>
                  </div>

                  <HorizontalSeparator classes="my-3" />

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-col">
                      <Subtitle>Collaboration</Subtitle>
                      <Text>Allow this user to create shared vaults and invite collaborators.</Text>
                    </div>
                    <Switch
                      checked={collaborationEnabled}
                      onChange={(checked) =>
                        void toggleUserFlag(
                          COLLABORATION_ENABLED,
                          checked,
                          setCollaborationEnabled,
                          collaborationEnabled,
                          'Failed to update collaboration access.',
                        )
                      }
                    />
                  </div>

                  <HorizontalSeparator classes="my-3" />

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-col">
                      <Subtitle>Live sync</Subtitle>
                      <Text>Push real-time updates to this user's other devices. Disabling keeps manual sync working.</Text>
                    </div>
                    <Switch
                      checked={liveSyncEnabled}
                      onChange={(checked) =>
                        void toggleUserFlag(
                          LIVE_SYNC_ENABLED,
                          checked,
                          setLiveSyncEnabled,
                          liveSyncEnabled,
                          'Failed to update live sync access.',
                        )
                      }
                    />
                  </div>

                  <HorizontalSeparator classes="my-3" />

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-col">
                      <Subtitle>Server-side OCR</Subtitle>
                      <Text>
                        Allow this user to run PDF OCR on the server. WARNING: server OCR uploads decrypted PDF page
                        images to the server, which <strong>leaves end-to-end encryption</strong> (the server can read
                        that content), like the AI assistant. Browser OCR stays on the user's device and is unaffected.
                        Requires the OCR_SERVER_ENABLED operator switch. Off by default.
                      </Text>
                    </div>
                    <Switch
                      checked={ocrServerAllowed}
                      onChange={(checked) =>
                        void toggleUserFlag(
                          OCR_SERVER_ALLOWED,
                          checked,
                          setOcrServerAllowed,
                          ocrServerAllowed,
                          'Failed to update server OCR access.',
                        )
                      }
                    />
                  </div>

                  <HorizontalSeparator classes="my-3" />

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-col">
                      <Subtitle>Nextcloud backups</Subtitle>
                      <Text>
                        Allow scheduled encrypted backups of this user's data to their configured Nextcloud. Backups are
                        end-to-end <strong>ciphertext</strong> &mdash; the content stays private and neither this server nor
                        Nextcloud can read it. However, the dedicated Nextcloud <strong>app password is server-stored</strong>{' '}
                        and grants Nextcloud file access, and the upload <strong>timing and size are exposed</strong> to the
                        server and Nextcloud. Use a dedicated <strong>low-privilege Nextcloud app password</strong>. Requires
                        the NEXTCLOUD_BACKUPS_ENABLED operator switch and the user's own URL/folder/frequency/app-password
                        setup. Off by default.
                      </Text>
                      <Text className="mt-1">
                        Current state: cadence{' '}
                        <strong>{nextcloudBackupFrequency && nextcloudBackupFrequency !== '' ? nextcloudBackupFrequency : 'not set'}</strong>
                        , app password{' '}
                        <strong>{nextcloudAppPasswordConfigured ? 'configured' : 'not configured'}</strong>. (The app
                        password itself is never shown.)
                      </Text>
                    </div>
                    <Switch
                      checked={nextcloudBackupAllowed}
                      onChange={(checked) =>
                        void toggleUserFlag(
                          NEXTCLOUD_BACKUP_ALLOWED,
                          checked,
                          setNextcloudBackupAllowed,
                          nextcloudBackupAllowed,
                          'Failed to update Nextcloud backup access.',
                        )
                      }
                    />
                  </div>

                  <HorizontalSeparator classes="my-3" />

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-col">
                      <Subtitle>Account banned</Subtitle>
                      <Text>
                        {banned
                          ? 'This account is banned. The user is blocked from signing in and any existing session is rejected.'
                          : "Ban this user to block sign-in and revoke access from this user's existing sessions."}
                      </Text>
                    </div>
                    <Switch
                      checked={banned}
                      disabled={banningInProgress}
                      onChange={(checked) => void toggleBan(checked)}
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Registration</Title>
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <Subtitle>Disable new signups</Subtitle>
              <Text>
                When enabled, new users cannot register on this instance. Note: enforcement at signup currently also
                depends on the server's DISABLE_USER_REGISTRATION configuration.
              </Text>
            </div>
            {registrationLoading ? (
              <Spinner className="h-5 w-5" />
            ) : (
              <Switch
                checked={registrationDisabled}
                onChange={(checked) => void toggleRegistration(checked)}
              />
            )}
          </div>
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Groups &amp; permissions</Title>
          <Text>
            Groups confer a set of roles on every member. A user&apos;s effective permissions are the union of their own
            roles and the roles granted by their groups. Users in no groups behave exactly as before.
          </Text>

          <div className="mt-3 flex flex-col gap-2">
            <Subtitle>Create a group</Subtitle>
            <DecoratedInput placeholder="Group name" value={newGroupName} onChange={setNewGroupName} />
            <DecoratedInput
              placeholder="Description (optional)"
              value={newGroupDescription}
              onChange={setNewGroupDescription}
            />
            <div>
              <Button label="Create group" onClick={() => void createGroup()} disabled={creatingGroup} />
            </div>
          </div>

          <HorizontalSeparator classes="my-4" />

          {groupsLoading ? (
            <Spinner className="h-5 w-5" />
          ) : groups.length === 0 ? (
            <Text>No groups yet.</Text>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map((group) => (
                <div key={group.uuid} className="rounded border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-col">
                      <Subtitle>{group.name}</Subtitle>
                      {group.description && <Text>{group.description}</Text>}
                      <Text className="mt-1 text-xs">{group.uuid}</Text>
                    </div>
                    <Button label="Delete" onClick={() => void deleteGroup(group)} />
                  </div>

                  <div className="mt-3">
                    <Subtitle>Conferred roles</Subtitle>
                    <div className="mt-2 flex flex-col gap-1">
                      {availableRoles.map((roleName) => (
                        <div key={roleName} className="flex items-center justify-between gap-2">
                          <Text>{roleName}</Text>
                          <Switch
                            checked={group.roleNames.includes(roleName)}
                            onChange={(checked) => void toggleGroupRole(group, roleName, checked)}
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  <HorizontalSeparator classes="my-3" />

                  <Button
                    label={selectedGroupUuid === group.uuid ? 'Hide members' : 'Manage members'}
                    onClick={() =>
                      selectedGroupUuid === group.uuid
                        ? setSelectedGroupUuid(null)
                        : void loadGroupMembers(group.uuid)
                    }
                  />

                  {selectedGroupUuid === group.uuid && (
                    <div className="mt-3">
                      <Subtitle>Members</Subtitle>
                      {membersLoading ? (
                        <Spinner className="mt-2 h-5 w-5" />
                      ) : (
                        <>
                          <div className="mt-2 flex flex-col gap-1">
                            {groupMembers.length === 0 ? (
                              <Text>No members.</Text>
                            ) : (
                              groupMembers.map((member) => (
                                <div key={member.uuid} className="flex items-center justify-between gap-2">
                                  <Text>{member.email ?? member.uuid}</Text>
                                  <Button label="Remove" onClick={() => void removeMember(member.uuid)} />
                                </div>
                              ))
                            )}
                          </div>
                          <div className="mt-3 flex items-center gap-2">
                            <DecoratedInput
                              className={{ container: 'flex-grow' }}
                              placeholder="User UUID to add"
                              value={newMemberUuid}
                              onChange={setNewMemberUuid}
                              onEnter={() => void addMember()}
                            />
                            <Button label="Add" onClick={() => void addMember()} />
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(Admin)

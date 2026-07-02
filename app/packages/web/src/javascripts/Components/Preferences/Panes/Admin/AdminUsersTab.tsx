import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'
import {
  ADMIN_USERS_DEFAULT_PAGE_SIZE,
  AdminUserRow,
  AdminUsersFilterState,
  buildAdminListUsersParams,
  emptyAdminUsersFilterState,
  formatAdminUserDate,
  formatAdminUserRoles,
  formatAdminUserStorage,
  formatAdminUserSubscription,
} from './adminHelpers'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Switch from '@/Components/Switch/Switch'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Dropdown from '@/Components/Dropdown/Dropdown'
import Spinner from '@/Components/Spinner/Spinner'
import { ToastType, addToast } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'
import { formatSizeToReadableString } from '@standardnotes/filepicker'

export type LookedUpUser = {
  uuid: string
  email: string
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
// OPT-IN n8n-backed workflows (automations). Defaults OFF. Keep in sync with the
// server's SettingName.NAMES value (SettingName.WorkflowsEnabled = 'WORKFLOWS_ENABLED'
// in server/packages/domain-core). Also requires the WORKFLOWS_ENABLED operator env.
const WORKFLOWS_ENABLED = 'WORKFLOWS_ENABLED'
// OPT-IN scheduled Nextcloud backups. Defaults OFF. Backups remain E2E ciphertext
// (content stays private), but the server-stored app password grants Nextcloud file
// access and upload timing/size are exposed. See the privacy alert near the toggle.
const NEXTCLOUD_BACKUP_ALLOWED = 'NEXTCLOUD_BACKUP_ALLOWED'
// READ-ONLY view of the user's Nextcloud backup cadence (disabled|daily|weekly|
// monthly). Surfaced so the admin can SEE the user's backup state.
const NEXTCLOUD_BACKUP_FREQUENCY = 'NEXTCLOUD_BACKUP_FREQUENCY'
// Per-user SERVER storage limit in bytes. On the server this is a SUBSCRIPTION
// setting (not a plain user setting); -1 means unlimited — the only value the
// files server treats as unlimited. Managed via the same feature-flags endpoints.
const FILE_UPLOAD_BYTES_LIMIT = 'FILE_UPLOAD_BYTES_LIMIT'

// Match @standardnotes/filepicker's binary units so the displayed current value
// (formatSizeToReadableString) round-trips with what the admin enters here.
const BYTES_IN_ONE_MEGABYTE = 1_048_576
const BYTES_IN_ONE_GIGABYTE = 1_073_741_824

// The admin (internal team) role name — must match the server's
// RoleName.NAMES.InternalTeamUser value.
const INTERNAL_TEAM_USER = 'INTERNAL_TEAM_USER'

type StorageInfo = {
  hasSubscription: boolean
  uploadBytesLimit: number | null
  uploadBytesUsed: number | null
}

type EffectivePermissions = {
  directRoleNames: string[]
  groupRoleNames: string[]
  effectiveRoleNames: string[]
  effectivePermissionNames: string[]
}

const describeStorageLimit = (storage: StorageInfo | null): string => {
  if (!storage || !storage.hasSubscription || storage.uploadBytesLimit === -1) {
    return 'Unlimited'
  }
  if (storage.uploadBytesLimit === null) {
    return 'Not set (server default)'
  }
  return formatSizeToReadableString(storage.uploadBytesLimit)
}

const formatLimitAmount = (amount: number): string => (Number.isInteger(amount) ? String(amount) : amount.toFixed(2))

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
  // The looked-up user (and the email field feeding the lookup) live in the
  // Admin shell so they survive tab switches — inactive tab panels unmount.
  email: string
  setEmail: (email: string) => void
  user: LookedUpUser | undefined
  setUser: (user: LookedUpUser | undefined) => void
}

const AdminUsersTab: FunctionComponent<Props> = ({ application, noteIfForbidden, email, setEmail, user, setUser }) => {
  const [lookingUp, setLookingUp] = useState(false)

  const [aiEnabled, setAiEnabled] = useState(false)
  const [aiRequestLimit, setAiRequestLimit] = useState('')
  // Collaboration and live sync default to ENABLED; they are gated off only when
  // the per-user setting is explicitly 'false'.
  const [collaborationEnabled, setCollaborationEnabled] = useState(true)
  const [liveSyncEnabled, setLiveSyncEnabled] = useState(true)
  // Server OCR is OFF by default (opt-in E2E downgrade); only 'true' enables it.
  const [ocrServerAllowed, setOcrServerAllowed] = useState(false)
  // Workflows are OFF by default; only 'true' enables them for the user.
  const [workflowsEnabled, setWorkflowsEnabled] = useState(false)
  // Nextcloud backups are OFF by default; only 'true' enables them. The cadence and
  // app-password-configured status are read-only context for the admin.
  const [nextcloudBackupAllowed, setNextcloudBackupAllowed] = useState(false)
  const [nextcloudBackupFrequency, setNextcloudBackupFrequency] = useState<string | null>(null)
  const [nextcloudAppPasswordConfigured, setNextcloudAppPasswordConfigured] = useState(false)
  // Per-user SERVER storage limit (bytes; -1 = unlimited). Read from and written
  // to the user's subscription settings via the admin feature-flags endpoints.
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null)
  const [storageLimitValue, setStorageLimitValue] = useState('')
  const [storageLimitUnit, setStorageLimitUnit] = useState<'MB' | 'GB' | 'unlimited'>('unlimited')
  const [savingStorageLimit, setSavingStorageLimit] = useState(false)
  const [flagsLoading, setFlagsLoading] = useState(false)
  const [savingLimit, setSavingLimit] = useState(false)

  const [banned, setBanned] = useState(false)
  const [banningInProgress, setBanningInProgress] = useState(false)

  // Effective roles/permissions readout + the direct admin-role toggle.
  const [permissions, setPermissions] = useState<EffectivePermissions | null>(null)
  const [permissionsVisible, setPermissionsVisible] = useState(false)
  const [adminRoleInProgress, setAdminRoleInProgress] = useState(false)
  // Panel equivalents of the srn-admin CLI's reset-mfa / fix-quota commands.
  const [resettingMfa, setResettingMfa] = useState(false)
  const [fixingQuota, setFixingQuota] = useState(false)

  const loadFlags = useCallback(
    async (userUuid: string) => {
      setFlagsLoading(true)
      try {
        const response = await application.legacyApi.adminGetUserFeatureFlags(userUuid)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to load user feature flags.' })
          return
        }
        const data = (
          response as {
            data?: {
              flags?: Record<string, string | null>
              nextcloudAppPasswordConfigured?: boolean
              storage?: StorageInfo | null
            }
          }
        ).data
        const flags = data?.flags ?? {}
        setAiEnabled(flags[AI_ENABLED] === 'true')
        setAiRequestLimit(flags[AI_REQUEST_LIMIT] ?? '')
        setCollaborationEnabled(flags[COLLABORATION_ENABLED] !== 'false')
        setLiveSyncEnabled(flags[LIVE_SYNC_ENABLED] !== 'false')
        setOcrServerAllowed(flags[OCR_SERVER_ALLOWED] === 'true')
        setWorkflowsEnabled(flags[WORKFLOWS_ENABLED] === 'true')
        setNextcloudBackupAllowed(flags[NEXTCLOUD_BACKUP_ALLOWED] === 'true')
        setNextcloudBackupFrequency(flags[NEXTCLOUD_BACKUP_FREQUENCY] ?? null)
        setNextcloudAppPasswordConfigured(Boolean(data?.nextcloudAppPasswordConfigured))

        const storage = data?.storage ?? null
        setStorageInfo(storage)
        // Seed the editor with the user's current limit so "Save" without edits
        // is a no-op. No explicit setting and -1 both surface as Unlimited.
        const currentLimit = storage?.uploadBytesLimit ?? null
        if (currentLimit === null || currentLimit === -1) {
          setStorageLimitUnit('unlimited')
          setStorageLimitValue('')
        } else if (currentLimit >= BYTES_IN_ONE_GIGABYTE) {
          setStorageLimitUnit('GB')
          setStorageLimitValue(formatLimitAmount(currentLimit / BYTES_IN_ONE_GIGABYTE))
        } else {
          setStorageLimitUnit('MB')
          setStorageLimitValue(formatLimitAmount(currentLimit / BYTES_IN_ONE_MEGABYTE))
        }
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

  const loadPermissions = useCallback(
    async (userUuid: string) => {
      try {
        const response = await application.legacyApi.adminGetUserEffectivePermissions(userUuid)
        if (isErrorResponse(response)) {
          setPermissions(null)
          return
        }
        const data = (response as { data?: EffectivePermissions }).data
        setPermissions(
          data
            ? {
                directRoleNames: data.directRoleNames ?? [],
                groupRoleNames: data.groupRoleNames ?? [],
                effectiveRoleNames: data.effectiveRoleNames ?? [],
                effectivePermissionNames: data.effectivePermissionNames ?? [],
              }
            : null,
        )
      } catch (error) {
        console.error(error)
        setPermissions(null)
      }
    },
    [application],
  )

  // Load (or reload) the looked-up user's flags, ban status and effective
  // roles/permissions whenever the user changes — including on remount, so
  // switching back to this tab restores fresh data for the user that stayed in
  // the shell.
  useEffect(() => {
    if (!user) {
      return
    }
    setBanned(false)
    setPermissions(null)
    setPermissionsVisible(false)
    void Promise.all([loadFlags(user.uuid), loadBanStatus(user.email), loadPermissions(user.uuid)])
  }, [user, loadFlags, loadBanStatus, loadPermissions])

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
        noteIfForbidden(response)
        addToast({ type: ToastType.Error, message: 'No user found with that email.' })
        return
      }
      const data = (response as { data?: { uuid?: string } }).data
      if (!data?.uuid) {
        addToast({ type: ToastType.Error, message: 'No user found with that email.' })
        return
      }
      // Setting the user triggers the effect above, which loads flags + ban status.
      setUser({ uuid: data.uuid, email: email.trim() })
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to look up user.' })
    } finally {
      setLookingUp(false)
    }
  }, [application, email, setUser, noteIfForbidden])

  // -------------------------------------------------------------------------
  // Paginated users list (most-recent-first) + filters. Sits above the email
  // lookup; selecting a row reuses the exact same manage flow (setUser).
  // -------------------------------------------------------------------------
  const [rows, setRows] = useState<AdminUserRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(ADMIN_USERS_DEFAULT_PAGE_SIZE)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [filters, setFilters] = useState<AdminUsersFilterState>(emptyAdminUsersFilterState())
  // Raw email box value, debounced into `filters.email`.
  const [emailSearchInput, setEmailSearchInput] = useState('')
  const [availableRoles, setAvailableRoles] = useState<string[]>([])

  const loadUsers = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      const params = buildAdminListUsersParams(filters, page, pageSize)
      const response = await application.legacyApi.adminListUsers(params)
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        setListError('The users list is not available on this server.')
        setRows([])
        setTotal(0)
        return
      }
      const data = (response as { data?: { users?: AdminUserRow[]; total?: number } }).data
      setRows(data?.users ?? [])
      setTotal(data?.total ?? 0)
    } catch (error) {
      console.error(error)
      setListError('Could not load the users list.')
      setRows([])
      setTotal(0)
    } finally {
      setListLoading(false)
    }
  }, [application, noteIfForbidden, filters, page, pageSize])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  // Debounce the email search box into the filter (and reset to the first page).
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setFilters((prev) => {
        if (prev.email === emailSearchInput) {
          return prev
        }
        setPage(0)
        return { ...prev, email: emailSearchInput }
      })
    }, 400)
    return () => window.clearTimeout(handle)
  }, [emailSearchInput])

  // Populate the role filter dropdown (best-effort; absent on older servers).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await application.legacyApi.adminGetAvailableRoles()
        if (cancelled || isErrorResponse(response)) {
          return
        }
        const data = (response as { data?: { roleNames?: string[] } }).data
        setAvailableRoles(data?.roleNames ?? [])
      } catch (error) {
        console.error(error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [application])

  // Non-email filter setters reset to the first page so results stay coherent.
  const setFilterField = useCallback(
    <K extends keyof AdminUsersFilterState>(key: K, value: AdminUsersFilterState[K]) => {
      setFilters((prev) => ({ ...prev, [key]: value }))
      setPage(0)
    },
    [],
  )

  const selectRow = useCallback(
    (row: AdminUserRow) => {
      // Reuse the existing lookup->manage flow: setting the user (and email)
      // triggers the effect that loads flags, ban status and permissions.
      setEmail(row.email)
      setUser({ uuid: row.uuid, email: row.email })
    },
    [setEmail, setUser],
  )

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const firstShown = total === 0 ? 0 : page * pageSize + 1
  const lastShown = page * pageSize + rows.length

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

  const saveStorageLimit = useCallback(async () => {
    if (!user) {
      return
    }

    let bytesValue: string
    if (storageLimitUnit === 'unlimited') {
      // -1 is the server/files-service sentinel for unlimited storage.
      bytesValue = '-1'
    } else {
      const amount = Number(storageLimitValue)
      if (!Number.isFinite(amount) || amount <= 0) {
        addToast({ type: ToastType.Error, message: 'Enter a storage limit greater than zero, or choose Unlimited.' })
        return
      }
      bytesValue = String(
        Math.round(amount * (storageLimitUnit === 'GB' ? BYTES_IN_ONE_GIGABYTE : BYTES_IN_ONE_MEGABYTE)),
      )
    }

    setSavingStorageLimit(true)
    try {
      const response = await application.legacyApi.adminSetUserFeatureFlag(
        user.uuid,
        FILE_UPLOAD_BYTES_LIMIT,
        bytesValue,
      )
      if (isErrorResponse(response)) {
        addToast({ type: ToastType.Error, message: 'Failed to update storage limit.' })
        return
      }
      addToast({ type: ToastType.Success, message: 'Storage limit saved. It applies to new uploads.' })
      // Re-read so the display reflects the canonical stored value.
      await loadFlags(user.uuid)
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to update storage limit.' })
    } finally {
      setSavingStorageLimit(false)
    }
  }, [application, user, storageLimitUnit, storageLimitValue, loadFlags])

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

  const userIsAdmin = permissions?.directRoleNames.includes(INTERNAL_TEAM_USER) ?? false

  const toggleAdminRole = useCallback(async () => {
    if (!user || !permissions) {
      return
    }
    const granting = !userIsAdmin

    const confirmed = await confirmDialog({
      title: granting ? 'Grant admin role' : 'Revoke admin role',
      text: granting
        ? `Grant the admin (internal team) role to ${user.email}? They will gain FULL administrative access to this instance: managing users, bans, groups, server settings and the audit log.`
        : `Revoke the admin (internal team) role from ${user.email}? They will lose access to this admin panel. (Revoking your own admin role is refused by the server.)`,
      confirmButtonText: granting ? 'Grant admin' : 'Revoke admin',
      confirmButtonStyle: 'danger',
    })
    if (!confirmed) {
      return
    }

    setAdminRoleInProgress(true)
    try {
      const response = await application.legacyApi.adminSetUserAdminRole(user.uuid, granting)
      if (isErrorResponse(response)) {
        const message = (response as { data?: { error?: { message?: string } } }).data?.error?.message
        addToast({ type: ToastType.Error, message: message ?? 'Failed to update admin role.' })
        return
      }
      addToast({
        type: ToastType.Success,
        message: granting
          ? 'Admin role granted. It takes effect when their session refreshes.'
          : 'Admin role revoked. It takes effect when their session refreshes.',
      })
      await loadPermissions(user.uuid)
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to update admin role.' })
    } finally {
      setAdminRoleInProgress(false)
    }
  }, [application, user, permissions, userIsAdmin, loadPermissions])

  const resetMfa = useCallback(async () => {
    if (!user) {
      return
    }
    const confirmed = await confirmDialog({
      title: 'Reset two-factor authentication',
      text: `Reset 2FA for ${user.email}? Their authenticator secret and recovery requirement are cleared, so anyone with their account password can sign in until they re-enroll. Only do this after verifying the request out-of-band.`,
      confirmButtonText: 'Reset 2FA',
      confirmButtonStyle: 'danger',
    })
    if (!confirmed) {
      return
    }

    setResettingMfa(true)
    try {
      const response = await application.legacyApi.adminResetUserMFA(user.uuid)
      if (isErrorResponse(response)) {
        const message = (response as { data?: { error?: { message?: string } } }).data?.error?.message
        addToast({ type: ToastType.Error, message: message ?? 'Failed to reset 2FA.' })
        return
      }
      addToast({ type: ToastType.Success, message: '2FA has been reset for this user.' })
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to reset 2FA.' })
    } finally {
      setResettingMfa(false)
    }
  }, [application, user])

  const fixQuota = useCallback(async () => {
    if (!user) {
      return
    }
    const confirmed = await confirmDialog({
      title: 'Recalculate storage quota',
      text: `Recalculate the storage usage counter for ${user.email} from their actually stored files? Useful when the displayed usage has drifted (e.g. after failed uploads).`,
      confirmButtonText: 'Recalculate',
      confirmButtonStyle: 'info',
    })
    if (!confirmed) {
      return
    }

    setFixingQuota(true)
    try {
      const response = await application.legacyApi.adminFixUserQuota(user.uuid)
      if (isErrorResponse(response)) {
        const message = (response as { data?: { error?: { message?: string } } }).data?.error?.message
        addToast({ type: ToastType.Error, message: message ?? 'Failed to fix storage quota.' })
        return
      }
      addToast({
        type: ToastType.Success,
        message: 'Quota recalculation requested. The refreshed usage appears here once the server finishes.',
      })
      // Re-read so the usage display picks up the (asynchronously) fresh value.
      await loadFlags(user.uuid)
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to fix storage quota.' })
    } finally {
      setFixingQuota(false)
    }
  }, [application, user, loadFlags])

  return (
    <PreferencesSegment>
      <Title>Users</Title>
      <Subtitle>
        The most-recent users, newest first. Filter the list, then click a row to manage that user below. The email
        lookup underneath is a quick path to a single known account.
      </Subtitle>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-col">
          <Text className="mb-1 text-xs">Email search</Text>
          <DecoratedInput
            className={{ container: 'w-56' }}
            placeholder="Search by email…"
            value={emailSearchInput}
            onChange={setEmailSearchInput}
            type="email"
          />
        </div>
        <div className="flex flex-col">
          <Text className="mb-1 text-xs">Created after</Text>
          <DecoratedInput
            className={{ container: 'w-40' }}
            value={filters.createdAfter}
            onChange={(value) => setFilterField('createdAfter', value)}
            type="date"
          />
        </div>
        <div className="flex flex-col">
          <Text className="mb-1 text-xs">Created before</Text>
          <DecoratedInput
            className={{ container: 'w-40' }}
            value={filters.createdBefore}
            onChange={(value) => setFilterField('createdBefore', value)}
            type="date"
          />
        </div>
        <div className="flex flex-col">
          <Text className="mb-1 text-xs">Subscription</Text>
          <Dropdown
            label="Subscription filter"
            items={[
              { label: 'Any', value: 'any' },
              { label: 'Active', value: 'active' },
              { label: 'Inactive', value: 'inactive' },
              { label: 'None', value: 'none' },
            ]}
            value={filters.subscription}
            onChange={(value) => setFilterField('subscription', value as AdminUsersFilterState['subscription'])}
          />
        </div>
        <div className="flex flex-col">
          <Text className="mb-1 text-xs">Banned</Text>
          <Dropdown
            label="Banned filter"
            items={[
              { label: 'Any', value: 'any' },
              { label: 'Banned', value: 'yes' },
              { label: 'Not banned', value: 'no' },
            ]}
            value={filters.banned}
            onChange={(value) => setFilterField('banned', value as AdminUsersFilterState['banned'])}
          />
        </div>
        {availableRoles.length > 0 && (
          <div className="flex flex-col">
            <Text className="mb-1 text-xs">Role</Text>
            <Dropdown
              label="Role filter"
              items={[{ label: 'Any', value: '' }, ...availableRoles.map((role) => ({ label: role, value: role }))]}
              value={filters.role}
              onChange={(value) => setFilterField('role', value)}
            />
          </div>
        )}
        <Button label="Refresh" onClick={() => void loadUsers()} disabled={listLoading} />
      </div>

      <div className="mt-3">
        {listLoading ? (
          <Spinner className="h-5 w-5" />
        ) : listError ? (
          <Text className="text-danger">{listError}</Text>
        ) : rows.length === 0 ? (
          <Text>No users match these filters.</Text>
        ) : (
          <>
            <div className="overflow-x-auto rounded border border-border">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-contrast">
                    <th className="p-2 font-bold">Email</th>
                    <th className="p-2 font-bold">Created</th>
                    <th className="p-2 font-bold">Roles</th>
                    <th className="p-2 font-bold">Subscription</th>
                    <th className="p-2 font-bold">Banned</th>
                    <th className="p-2 font-bold">MFA</th>
                    <th className="p-2 font-bold">Storage</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.uuid}
                      onClick={() => selectRow(row)}
                      className={`cursor-pointer border-b border-border last:border-b-0 hover:bg-info-backdrop ${
                        user?.uuid === row.uuid ? 'bg-info-backdrop' : ''
                      }`}
                    >
                      <td className="p-2">{row.email}</td>
                      <td className="whitespace-nowrap p-2">{formatAdminUserDate(row.createdAt)}</td>
                      <td className="p-2">{formatAdminUserRoles(row.roles)}</td>
                      <td className="p-2">{formatAdminUserSubscription(row.subscription)}</td>
                      <td className="p-2">{row.banned ? 'Yes' : 'No'}</td>
                      <td className="p-2">{row.mfaEnabled ? 'On' : 'Off'}</td>
                      <td className="whitespace-nowrap p-2">
                        {formatAdminUserStorage(row.storageUsedBytes, row.storageLimitBytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Text>
                {total > 0 ? (
                  <>
                    Showing {firstShown}&ndash;{lastShown} of {total}
                  </>
                ) : (
                  'No users'
                )}
              </Text>
              <div className="flex items-center gap-2">
                <Button label="Previous" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} />
                <Text>
                  Page {page + 1} of {pageCount}
                </Text>
                <Button
                  label="Next"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page + 1 >= pageCount || lastShown >= total}
                />
              </div>
              <Dropdown
                label="Users per page"
                items={[
                  { label: '100 / page', value: '100' },
                  { label: '250 / page', value: '250' },
                  { label: '500 / page', value: '500' },
                  { label: '1000 / page', value: '1000' },
                  { label: '1500 / page', value: '1500' },
                ]}
                value={String(pageSize)}
                onChange={(value) => {
                  setPageSize(Number(value))
                  setPage(0)
                }}
              />
            </div>
          </>
        )}
      </div>

      <HorizontalSeparator classes="my-4" />

      <Title>Manage user by email</Title>
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
                    Allow this user to run PDF OCR on the server. WARNING: server OCR uploads decrypted PDF page images
                    to the server, which <strong>leaves end-to-end encryption</strong> (the server can read that
                    content), like the AI assistant. Browser OCR stays on the user's device and is unaffected. Requires
                    the OCR_SERVER_ENABLED operator switch. Off by default.
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
                  <Subtitle>Workflows</Subtitle>
                  <Text>
                    Allow this user to use the n8n-backed Workflows automation engine (build visual automations that
                    react to notebook events, run AI steps, and send emails/notes/files). The user must still explicitly
                    connect from their Workflows pane; connecting provisions a revocable, scoped access token — never
                    their master key or note contents. Requires the WORKFLOWS_ENABLED operator switch. Off by default.
                  </Text>
                </div>
                <Switch
                  checked={workflowsEnabled}
                  onChange={(checked) =>
                    void toggleUserFlag(
                      WORKFLOWS_ENABLED,
                      checked,
                      setWorkflowsEnabled,
                      workflowsEnabled,
                      'Failed to update workflows access.',
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
                    Nextcloud can read it. However, the dedicated Nextcloud{' '}
                    <strong>app password is server-stored</strong> and grants Nextcloud file access, and the upload{' '}
                    <strong>timing and size are exposed</strong> to the server and Nextcloud. Use a dedicated{' '}
                    <strong>low-privilege Nextcloud app password</strong>. Requires the NEXTCLOUD_BACKUPS_ENABLED
                    operator switch and the user's own URL/folder/frequency/app-password setup. Off by default.
                  </Text>
                  <Text className="mt-1">
                    Current state: cadence{' '}
                    <strong>
                      {nextcloudBackupFrequency && nextcloudBackupFrequency !== ''
                        ? nextcloudBackupFrequency
                        : 'not set'}
                    </strong>
                    , app password <strong>{nextcloudAppPasswordConfigured ? 'configured' : 'not configured'}</strong>.
                    (The app password itself is never shown.)
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

              <div className="flex flex-col gap-2">
                <Subtitle>Server storage limit</Subtitle>
                <Text>
                  Maximum total size of this user's files stored on the server. Current usage:{' '}
                  <strong>
                    {storageInfo?.uploadBytesUsed != null
                      ? formatSizeToReadableString(storageInfo.uploadBytesUsed)
                      : 'unknown'}
                  </strong>
                  , limit: <strong>{describeStorageLimit(storageInfo)}</strong>. A new limit applies to new uploads;
                  upload tokens issued before the change keep the previous limit until they expire.
                </Text>
                {storageInfo && !storageInfo.hasSubscription ? (
                  <Text>
                    This account has no subscription record, so the server treats its storage as unlimited and the limit
                    cannot be changed here.
                  </Text>
                ) : (
                  <div className="mt-1 flex items-center gap-3">
                    <DecoratedInput
                      className={{ container: 'w-28' }}
                      placeholder="e.g. 5"
                      value={storageLimitUnit === 'unlimited' ? '' : storageLimitValue}
                      onChange={setStorageLimitValue}
                      type="number"
                      disabled={storageLimitUnit === 'unlimited'}
                    />
                    <Dropdown
                      label="Storage limit unit"
                      items={[
                        { label: 'MB', value: 'MB' },
                        { label: 'GB', value: 'GB' },
                        { label: 'Unlimited', value: 'unlimited' },
                      ]}
                      value={storageLimitUnit}
                      onChange={(value) => setStorageLimitUnit(value as 'MB' | 'GB' | 'unlimited')}
                    />
                    <Button
                      label="Save limit"
                      onClick={() => void saveStorageLimit()}
                      disabled={savingStorageLimit || flagsLoading}
                    />
                  </div>
                )}
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
                <Switch checked={banned} disabled={banningInProgress} onChange={(checked) => void toggleBan(checked)} />
              </div>

              <HorizontalSeparator classes="my-3" />

              <div className="flex flex-col gap-2">
                <Subtitle>Roles &amp; permissions</Subtitle>
                {permissions ? (
                  <>
                    <Text>
                      Direct roles: <strong>{permissions.directRoleNames.join(', ') || '(none)'}</strong>
                    </Text>
                    {permissions.groupRoleNames.length > 0 && (
                      <Text>
                        Via groups: <strong>{permissions.groupRoleNames.join(', ')}</strong>
                      </Text>
                    )}
                    <Text>
                      Effective permissions: <strong>{permissions.effectivePermissionNames.length}</strong>{' '}
                      <button
                        className="cursor-pointer border-0 bg-transparent p-0 text-info underline"
                        onClick={() => setPermissionsVisible((current) => !current)}
                      >
                        {permissionsVisible ? 'hide' : 'show'}
                      </button>
                    </Text>
                    {permissionsVisible && (
                      <Text className="text-xs">
                        {permissions.effectivePermissionNames.length > 0
                          ? permissions.effectivePermissionNames.join(', ')
                          : '(none)'}
                      </Text>
                    )}
                  </>
                ) : (
                  <Text>Effective roles/permissions could not be loaded for this user.</Text>
                )}

                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex flex-col">
                    <Subtitle>Administrator access</Subtitle>
                    <Text>
                      {userIsAdmin
                        ? 'This user holds the admin (internal team) role and has full administrative access.'
                        : 'Grant the admin (internal team) role to give this user full administrative access, including this panel.'}
                    </Text>
                  </div>
                  <Button
                    label={userIsAdmin ? 'Revoke admin' : 'Grant admin'}
                    colorStyle={userIsAdmin ? 'danger' : 'default'}
                    onClick={() => void toggleAdminRole()}
                    disabled={adminRoleInProgress || !permissions}
                  />
                </div>
              </div>

              <HorizontalSeparator classes="my-3" />

              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col">
                  <Subtitle>Reset two-factor authentication</Subtitle>
                  <Text>
                    Clears this user's authenticator secret (and recovery requirement) so they can sign in with their
                    password alone and re-enroll 2FA. Verify a reset request out-of-band before using this.
                  </Text>
                </div>
                <Button
                  label="Reset 2FA"
                  colorStyle="danger"
                  onClick={() => void resetMfa()}
                  disabled={resettingMfa}
                />
              </div>

              <HorizontalSeparator classes="my-3" />

              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col">
                  <Subtitle>Recalculate storage quota</Subtitle>
                  <Text>
                    Recomputes the "storage used" counter from this user's actually stored files. Use when the usage
                    shown above looks wrong (e.g. after interrupted uploads). Runs asynchronously on the server.
                  </Text>
                </div>
                <Button label="Fix quota" onClick={() => void fixQuota()} disabled={fixingQuota} />
              </div>
            </>
          )}
        </div>
      )}
    </PreferencesSegment>
  )
}

export default AdminUsersTab

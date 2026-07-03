import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { HttpResponse, isErrorResponse } from '@standardnotes/snjs'
import {
  ADMIN_USERS_DEFAULT_PAGE_SIZE,
  AdminUserRow,
  AdminUsersFilterState,
  adminUsersFiltersAreEmpty,
  buildAdminListUsersParams,
  emptyAdminUsersFilterState,
  formatAdminUserDate,
  formatAdminUserRoles,
  formatAdminUserStorage,
  formatAdminUserSubscription,
} from './adminHelpers'
import { describeAdminUsersActiveFilters } from './adminUsersUi'
import AdminPagination from './AdminPagination'
import {
  BulkItemResult,
  excludeSelfTarget,
  pageSelectionState,
  runBulkWithConcurrency,
  selectedUuidsOnPage,
  setPageSelection,
  summarizeBulkOutcome,
  toggleSelected,
} from './adminUsersBulk'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Switch from '@/Components/Switch/Switch'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Dropdown from '@/Components/Dropdown/Dropdown'
import Icon from '@/Components/Icon/Icon'
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

// Bulk actions run the per-user admin calls a handful at a time (a bounded
// worker pool) rather than all-at-once, to avoid hammering the server.
const BULK_CONCURRENCY = 5

// The boolean per-user feature flags the bulk "Set feature flag" control can
// toggle. Each maps to the SAME adminSetUserFeatureFlag('true'|'false') call
// the single-user switches above use, so bulk composes cleanly with them.
const BULK_FLAG_OPTIONS: { label: string; value: string }[] = [
  { label: 'AI access', value: AI_ENABLED },
  { label: 'Collaboration', value: COLLABORATION_ENABLED },
  { label: 'Live sync', value: LIVE_SYNC_ENABLED },
  { label: 'Server-side OCR', value: OCR_SERVER_ALLOWED },
  { label: 'Workflows', value: WORKFLOWS_ENABLED },
  { label: 'Nextcloud backups', value: NEXTCLOUD_BACKUP_ALLOWED },
]

const pluralizeUsers = (count: number): string => (count === 1 ? 'user' : 'users')

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

  // -------------------------------------------------------------------------
  // Bulk selection + actions over the CURRENT page. The selected set holds
  // uuids from the currently loaded page only; it is cleared on every list
  // reload (page/filter/page-size change, manual Refresh and the post-action
  // refresh), so what is checked is exactly what a bulk action targets.
  // -------------------------------------------------------------------------
  const [selectedUuids, setSelectedUuids] = useState<Set<string>>(() => new Set())
  const [bulkInProgress, setBulkInProgress] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ completed: number; total: number } | null>(null)
  const [bulkFailures, setBulkFailures] = useState<BulkItemResult[] | null>(null)
  const [bulkFlagName, setBulkFlagName] = useState<string>(BULK_FLAG_OPTIONS[0].value)
  const [bulkFlagValue, setBulkFlagValue] = useState<'true' | 'false'>('true')

  const loadUsers = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    // Selection belongs to the page being replaced — drop it on every reload.
    setSelectedUuids(new Set())
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

  // One-click reset of every list filter (the debounced search box included).
  // Clearing the box while filters.email is already '' leaves the debounce
  // effect a no-op, so this causes exactly one reload.
  const clearFilters = useCallback(() => {
    setEmailSearchInput('')
    setFilters(emptyAdminUsersFilterState())
    setPage(0)
  }, [])

  const activeFilterChips = describeAdminUsersActiveFilters(filters)
  const filtersActive = !adminUsersFiltersAreEmpty(filters)

  const selectRow = useCallback(
    (row: AdminUserRow) => {
      // Reuse the existing lookup->manage flow: setting the user (and email)
      // triggers the effect that loads flags, ban status and permissions.
      setEmail(row.email)
      setUser({ uuid: row.uuid, email: row.email })
    },
    [setEmail, setUser],
  )

  // Keep the paginated table row in sync after a SINGLE-user mutation without a
  // full reload (which would clear the selection and flash a spinner). Patches
  // only the row for `uuid` if it is currently on the page; a no-op otherwise.
  const patchUserRow = useCallback((uuid: string, patch: Partial<AdminUserRow>) => {
    setRows((current) => current.map((row) => (row.uuid === uuid ? { ...row, ...patch } : row)))
  }, [])

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const firstShown = total === 0 ? 0 : page * pageSize + 1
  const lastShown = page * pageSize + rows.length

  // ---- Bulk selection derived state -------------------------------------
  const pageUuids = rows.map((row) => row.uuid)
  const selectedOnPage = selectedUuidsOnPage(selectedUuids, pageUuids)
  const selectionCount = selectedOnPage.length
  const headerSelectionState = pageSelectionState(selectedUuids, pageUuids)

  const toggleRowSelected = useCallback((uuid: string) => {
    setSelectedUuids((prev) => toggleSelected(prev, uuid))
  }, [])

  const toggleSelectAllOnPage = useCallback(() => {
    setSelectedUuids((prev) => setPageSelection(prev, pageUuids, pageSelectionState(prev, pageUuids) !== 'all'))
  }, [pageUuids])

  const clearSelection = useCallback(() => {
    setSelectedUuids(new Set())
    setBulkFailures(null)
  }, [])

  const emailForUuid = useCallback((uuid: string) => rows.find((row) => row.uuid === uuid)?.email ?? uuid, [rows])

  // Shared executor: run a per-user worker over the targets with bounded
  // concurrency + live progress, collect partial failures, summarise, then
  // refresh the list. A single failing user never aborts the batch.
  const executeBulk = useCallback(
    async (targets: string[], pastVerb: string, worker: (uuid: string) => Promise<void>) => {
      if (targets.length === 0) {
        return
      }
      setBulkFailures(null)
      setBulkInProgress(true)
      setBulkProgress({ completed: 0, total: targets.length })
      try {
        const summary = await runBulkWithConcurrency(targets, (uuid) => uuid, worker, {
          concurrency: BULK_CONCURRENCY,
          onProgress: (completed, total) => setBulkProgress({ completed, total }),
        })
        const { message, hasFailures } = summarizeBulkOutcome(pastVerb, summary)
        addToast({ type: hasFailures ? ToastType.Error : ToastType.Success, message })
        setBulkFailures(hasFailures ? summary.failed : null)
        // Refresh so ban/role/flag changes are reflected; this also clears the
        // selection (loadUsers drops it), matching the documented behaviour.
        await loadUsers()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'The bulk action could not be completed.' })
      } finally {
        setBulkInProgress(false)
        setBulkProgress(null)
      }
    },
    [loadUsers],
  )

  const throwIfError = (response: HttpResponse): void => {
    if (isErrorResponse(response)) {
      const message = (response as { data?: { error?: { message?: string } } }).data?.error?.message
      throw new Error(message ?? 'Request failed')
    }
  }

  const bulkSetBan = useCallback(
    async (nextBanned: boolean) => {
      const targets = selectedUuidsOnPage(
        selectedUuids,
        rows.map((row) => row.uuid),
      )
      if (targets.length === 0) {
        return
      }
      const confirmed = await confirmDialog({
        title: nextBanned ? 'Ban selected users' : 'Unban selected users',
        text: nextBanned
          ? `Ban ${targets.length} selected ${pluralizeUsers(targets.length)}? They will be signed out and blocked from accessing their accounts until unbanned.`
          : `Unban ${targets.length} selected ${pluralizeUsers(targets.length)}? They will regain access to their accounts.`,
        confirmButtonText: nextBanned ? 'Ban users' : 'Unban users',
        confirmButtonStyle: nextBanned ? 'danger' : 'info',
      })
      if (!confirmed) {
        return
      }
      await executeBulk(targets, nextBanned ? 'Banned' : 'Unbanned', async (uuid) => {
        throwIfError(await application.legacyApi.adminSetUserBanStatus(uuid, nextBanned))
      })
    },
    [application, rows, selectedUuids, executeBulk],
  )

  const bulkSetAdminRole = useCallback(
    async (granting: boolean) => {
      let targets = selectedUuidsOnPage(
        selectedUuids,
        rows.map((row) => row.uuid),
      )
      if (targets.length === 0) {
        return
      }
      // Mirror the single self-revoke guard: never let the admin bulk-revoke
      // their OWN admin role (the server refuses it anyway).
      let selfNote = ''
      if (!granting) {
        const selfUuid = application.sessions.getUser()?.uuid
        const { targets: filtered, excludedSelf } = excludeSelfTarget(targets, selfUuid)
        targets = filtered
        if (excludedSelf) {
          selfNote = ' (Your own account is excluded — admins cannot revoke their own admin role.)'
        }
        if (targets.length === 0) {
          addToast({
            type: ToastType.Regular,
            message: 'Only your own account was selected; you cannot bulk-revoke your own admin role.',
          })
          return
        }
      }
      const confirmed = await confirmDialog({
        title: granting ? 'Grant admin to selected' : 'Revoke admin from selected',
        text: granting
          ? `Grant the admin (internal team) role to ${targets.length} selected ${pluralizeUsers(targets.length)}? They will gain FULL administrative access to this instance: managing users, bans, groups, server settings and the audit log.`
          : `Revoke the admin (internal team) role from ${targets.length} selected ${pluralizeUsers(targets.length)}? They will lose access to this admin panel.${selfNote}`,
        confirmButtonText: granting ? 'Grant admin' : 'Revoke admin',
        confirmButtonStyle: 'danger',
      })
      if (!confirmed) {
        return
      }
      await executeBulk(targets, granting ? 'Granted admin to' : 'Revoked admin from', async (uuid) => {
        throwIfError(await application.legacyApi.adminSetUserAdminRole(uuid, granting))
      })
    },
    [application, rows, selectedUuids, executeBulk],
  )

  const bulkSetFlag = useCallback(async () => {
    const targets = selectedUuidsOnPage(
      selectedUuids,
      rows.map((row) => row.uuid),
    )
    if (targets.length === 0) {
      return
    }
    const option = BULK_FLAG_OPTIONS.find((item) => item.value === bulkFlagName)
    const label = option?.label ?? bulkFlagName
    const enable = bulkFlagValue === 'true'
    const confirmed = await confirmDialog({
      title: 'Set feature flag for selected',
      text: `${enable ? 'Enable' : 'Disable'} "${label}" for ${targets.length} selected ${pluralizeUsers(targets.length)}?`,
      confirmButtonText: enable ? 'Enable flag' : 'Disable flag',
      confirmButtonStyle: 'info',
    })
    if (!confirmed) {
      return
    }
    await executeBulk(targets, `${enable ? 'Enabled' : 'Disabled'} ${label} for`, async (uuid) => {
      throwIfError(await application.legacyApi.adminSetUserFeatureFlag(uuid, bulkFlagName, bulkFlagValue))
    })
  }, [application, rows, selectedUuids, bulkFlagName, bulkFlagValue, executeBulk])

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
        // Keep the table's Banned column in sync with the detail editor.
        patchUserRow(user.uuid, { banned: nextBanned })
      } catch (error) {
        console.error(error)
        setBanned(previous)
        addToast({ type: ToastType.Error, message: 'Failed to update ban status.' })
      } finally {
        setBanningInProgress(false)
      }
    },
    [application, user, banned, patchUserRow],
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
      // Keep the table's Roles column in sync with the detail editor.
      setRows((current) =>
        current.map((row) =>
          row.uuid === user.uuid
            ? {
                ...row,
                roles: granting
                  ? Array.from(new Set([...row.roles, INTERNAL_TEAM_USER]))
                  : row.roles.filter((name) => name !== INTERNAL_TEAM_USER),
              }
            : row,
        ),
      )
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
      // 2FA is now cleared — keep the table's MFA column in sync.
      patchUserRow(user.uuid, { mfaEnabled: false })
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to reset 2FA.' })
    } finally {
      setResettingMfa(false)
    }
  }, [application, user, patchUserRow])

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

      {/* Filter bar: search + the quick dropdowns on one airy row, the date
          range and page size on a lighter second row, and an active-filters
          summary with one-click clear when anything is narrowing the list. */}
      <div className="mt-3 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-[280px] flex-grow flex-col">
            <Text className="mb-1 text-xs font-medium text-passive-1">Search</Text>
            <DecoratedInput
              className={{ container: 'w-full' }}
              left={[<Icon type="search" size="small" className="flex-shrink-0 text-passive-1" />]}
              placeholder="Search by email…"
              value={emailSearchInput}
              onChange={setEmailSearchInput}
              type="email"
            />
          </div>
          <div className="flex flex-col">
            <Text className="mb-1 text-xs font-medium text-passive-1">Subscription</Text>
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
            <Text className="mb-1 text-xs font-medium text-passive-1">Banned</Text>
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
              <Text className="mb-1 text-xs font-medium text-passive-1">Role</Text>
              <Dropdown
                label="Role filter"
                items={[{ label: 'Any', value: '' }, ...availableRoles.map((role) => ({ label: role, value: role }))]}
                value={filters.role}
                onChange={(value) => setFilterField('role', value)}
              />
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="flex flex-col">
            <Text className="mb-1 text-xs font-medium text-passive-1">Created after</Text>
            <DecoratedInput
              className={{ container: 'w-40' }}
              value={filters.createdAfter}
              onChange={(value) => setFilterField('createdAfter', value)}
              type="date"
            />
          </div>
          <div className="flex flex-col">
            <Text className="mb-1 text-xs font-medium text-passive-1">Created before</Text>
            <DecoratedInput
              className={{ container: 'w-40' }}
              value={filters.createdBefore}
              onChange={(value) => setFilterField('createdBefore', value)}
              type="date"
            />
          </div>
          <div className="flex flex-col">
            <Text className="mb-1 text-xs font-medium text-passive-1">Per page</Text>
            <Dropdown
              label="Users per page"
              items={[
                { label: '100', value: '100' },
                { label: '250', value: '250' },
                { label: '500', value: '500' },
                { label: '1000', value: '1000' },
                { label: '1500', value: '1500' },
              ]}
              value={String(pageSize)}
              onChange={(value) => {
                setPageSize(Number(value))
                setPage(0)
              }}
            />
          </div>
          <Button small label="Refresh" onClick={() => void loadUsers()} disabled={listLoading} />
          {!listLoading && !listError && (
            <Text className="ml-auto pb-1.5 text-xs text-passive-1">
              {total.toLocaleString()} {filtersActive ? 'matching ' : ''}
              {total === 1 ? 'user' : 'users'}
            </Text>
          )}
        </div>

        {activeFilterChips.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Text className="text-xs text-passive-1">Filtering:</Text>
            {activeFilterChips.map((chip) => (
              <span
                key={chip.key}
                className="rounded-full bg-info-backdrop px-2.5 py-0.5 text-xs font-medium text-foreground"
              >
                {chip.label}
              </span>
            ))}
            <button
              className="cursor-pointer border-0 bg-transparent p-0 text-xs text-info underline"
              onClick={clearFilters}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>

      <div className="mt-3">
        {listLoading ? (
          <Spinner className="h-5 w-5" />
        ) : listError ? (
          <Text className="text-danger">{listError}</Text>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-start gap-2 rounded-md border border-border p-4">
            <Text>{filtersActive ? 'No users match these filters.' : 'No users yet.'}</Text>
            {filtersActive && (
              <button
                className="cursor-pointer border-0 bg-transparent p-0 text-sm text-info underline"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Bulk action bar — unobtrusive, appears above the table only when
                at least one row on the page is selected. Acts on the current
                selection with bounded concurrency + partial-failure handling. */}
            {selectionCount > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-info bg-info-backdrop p-3">
                <Text className="font-semibold text-foreground">{selectionCount} selected</Text>
                <button
                  className="cursor-pointer border-0 bg-transparent p-0 text-xs text-info underline disabled:opacity-50"
                  onClick={clearSelection}
                  disabled={bulkInProgress}
                >
                  Clear selection
                </button>

                <div className="mx-1 h-5 w-px bg-border" />

                <Button
                  small
                  label="Ban selected"
                  colorStyle="danger"
                  onClick={() => void bulkSetBan(true)}
                  disabled={bulkInProgress}
                />
                <Button small label="Unban selected" onClick={() => void bulkSetBan(false)} disabled={bulkInProgress} />
                <Button
                  small
                  label="Grant admin"
                  onClick={() => void bulkSetAdminRole(true)}
                  disabled={bulkInProgress}
                />
                <Button
                  small
                  label="Revoke admin"
                  colorStyle="danger"
                  onClick={() => void bulkSetAdminRole(false)}
                  disabled={bulkInProgress}
                />

                <div className="mx-1 h-5 w-px bg-border" />

                {/* Bulk feature flag: reuses the per-user adminSetUserFeatureFlag
                    call, so it composes cleanly with the single-user switches. */}
                <Text className="text-xs text-passive-1">Flag:</Text>
                <Dropdown
                  label="Bulk feature flag"
                  items={BULK_FLAG_OPTIONS}
                  value={bulkFlagName}
                  onChange={setBulkFlagName}
                  disabled={bulkInProgress}
                />
                <Dropdown
                  label="Bulk feature flag value"
                  items={[
                    { label: 'Enable', value: 'true' },
                    { label: 'Disable', value: 'false' },
                  ]}
                  value={bulkFlagValue}
                  onChange={(value) => setBulkFlagValue(value as 'true' | 'false')}
                  disabled={bulkInProgress}
                />
                <Button small label="Apply flag" onClick={() => void bulkSetFlag()} disabled={bulkInProgress} />

                {bulkInProgress && bulkProgress && (
                  <div className="ml-auto flex items-center gap-2">
                    <Spinner className="h-4 w-4" />
                    <Text className="text-xs text-passive-1">
                      Processing {bulkProgress.completed}/{bulkProgress.total}…
                    </Text>
                  </div>
                )}
              </div>
            )}

            {/* Partial-failure detail — survives the post-action refresh (which
                clears the selection) so the admin can see which users failed. */}
            {bulkFailures && bulkFailures.length > 0 && (
              <div className="mb-3 rounded-md border border-danger p-3">
                <div className="flex items-center justify-between gap-2">
                  <Text className="font-semibold text-danger">
                    {bulkFailures.length} {pluralizeUsers(bulkFailures.length)} failed
                  </Text>
                  <button
                    className="cursor-pointer border-0 bg-transparent p-0 text-xs text-info underline"
                    onClick={() => setBulkFailures(null)}
                  >
                    Dismiss
                  </button>
                </div>
                <ul className="mt-2 max-h-40 list-disc overflow-auto pl-5 text-xs text-passive-1">
                  {bulkFailures.map((failure) => (
                    <li key={failure.uuid}>
                      {emailForUuid(failure.uuid)}
                      {failure.error ? ` — ${failure.error}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Vertical max-height makes the sticky header useful on tall
                pages; horizontal overflow keeps narrow widths scrollable. */}
            <div className="max-h-[32rem] overflow-auto rounded-md border border-border">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr>
                    <th className="sticky top-0 z-10 w-10 border-b border-border bg-contrast px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select all users on this page"
                        className="cursor-pointer align-middle"
                        checked={headerSelectionState === 'all'}
                        ref={(el) => {
                          if (el) {
                            el.indeterminate = headerSelectionState === 'partial'
                          }
                        }}
                        onChange={toggleSelectAllOnPage}
                      />
                    </th>
                    <th className="sticky top-0 z-10 border-b border-border bg-contrast px-3 py-2 font-semibold">
                      Email
                    </th>
                    <th className="sticky top-0 z-10 border-b border-border bg-contrast px-3 py-2 font-semibold">
                      Created
                    </th>
                    <th className="sticky top-0 z-10 border-b border-border bg-contrast px-3 py-2 font-semibold">
                      Roles
                    </th>
                    <th className="sticky top-0 z-10 border-b border-border bg-contrast px-3 py-2 font-semibold">
                      Subscription
                    </th>
                    <th className="sticky top-0 z-10 border-b border-border bg-contrast px-3 py-2 font-semibold">
                      Banned
                    </th>
                    <th className="sticky top-0 z-10 border-b border-border bg-contrast px-3 py-2 font-semibold">
                      MFA
                    </th>
                    <th className="sticky top-0 z-10 border-b border-border bg-contrast px-3 py-2 text-right font-semibold">
                      Storage
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row) => (
                    <tr
                      key={row.uuid}
                      onClick={() => selectRow(row)}
                      className={`cursor-pointer hover:bg-info-backdrop ${
                        selectedUuids.has(row.uuid) || user?.uuid === row.uuid ? 'bg-info-backdrop' : ''
                      }`}
                    >
                      {/* Stop propagation so ticking the box does not also open
                          the row's manage flow. */}
                      <td className="px-3 py-2.5" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.email}`}
                          className="cursor-pointer align-middle"
                          checked={selectedUuids.has(row.uuid)}
                          onChange={() => toggleRowSelected(row.uuid)}
                        />
                      </td>
                      <td className="px-3 py-2.5">{row.email}</td>
                      <td className="whitespace-nowrap px-3 py-2.5">{formatAdminUserDate(row.createdAt)}</td>
                      <td className="px-3 py-2.5">{formatAdminUserRoles(row.roles)}</td>
                      <td className="px-3 py-2.5">{formatAdminUserSubscription(row.subscription)}</td>
                      <td className="px-3 py-2.5">{row.banned ? 'Yes' : 'No'}</td>
                      <td className="px-3 py-2.5">{row.mfaEnabled ? 'On' : 'Off'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                        {formatAdminUserStorage(row.storageUsedBytes, row.storageLimitBytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <Text className="text-xs text-passive-1">
                Showing {firstShown}&ndash;{lastShown} of {total.toLocaleString()}
              </Text>
              <AdminPagination
                previousDisabled={page === 0}
                nextDisabled={page + 1 >= pageCount || lastShown >= total}
                onPrevious={() => setPage((p) => Math.max(0, p - 1))}
                onNext={() => setPage((p) => p + 1)}
              >
                <Text className="whitespace-nowrap text-xs">
                  Page {page + 1} of {pageCount}
                </Text>
              </AdminPagination>
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
                  <div className="flex min-w-0 flex-col">
                    <Subtitle>Administrator access</Subtitle>
                    <Text>
                      {userIsAdmin
                        ? 'This user holds the admin (internal team) role and has full administrative access.'
                        : 'Grant the admin (internal team) role to give this user full administrative access, including this panel.'}
                    </Text>
                  </div>
                  <Button
                    className="inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap"
                    colorStyle={userIsAdmin ? 'danger' : 'default'}
                    onClick={() => void toggleAdminRole()}
                    disabled={adminRoleInProgress || !permissions}
                  >
                    <Icon type="accessibility" size="small" />
                    {userIsAdmin ? 'Revoke admin' : 'Grant admin'}
                  </Button>
                </div>
              </div>

              <HorizontalSeparator classes="my-3" />

              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                  <Subtitle>Reset two-factor authentication</Subtitle>
                  <Text>
                    Clears this user's authenticator secret (and recovery requirement) so they can sign in with their
                    password alone and re-enroll 2FA. Verify a reset request out-of-band before using this.
                  </Text>
                </div>
                <Button
                  className="inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap"
                  colorStyle="danger"
                  onClick={() => void resetMfa()}
                  disabled={resettingMfa}
                >
                  <Icon type="authenticator" size="small" />
                  Reset 2FA
                </Button>
              </div>

              <HorizontalSeparator classes="my-3" />

              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col">
                  <Subtitle>Recalculate storage quota</Subtitle>
                  <Text>
                    Recomputes the "storage used" counter from this user's actually stored files. Use when the usage
                    shown above looks wrong (e.g. after interrupted uploads). Runs asynchronously on the server.
                  </Text>
                </div>
                <Button
                  className="inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap"
                  onClick={() => void fixQuota()}
                  disabled={fixingQuota}
                >
                  <Icon type="tune" size="small" />
                  Fix quota
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </PreferencesSegment>
  )
}

export default AdminUsersTab

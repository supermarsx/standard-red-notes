import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import Icon from '@/Components/Icon/Icon'
import TabList from '@/Components/Tabs/TabList'
import Tab from '@/Components/Tabs/Tab'
import TabPanel from '@/Components/Tabs/TabPanel'
import { useTabState } from '@/Components/Tabs/useTabState'
import { ToastType, addToast } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'
import { rolePickerOptions, toggleRoleName } from './adminGroupsUi'
import {
  AdminRole,
  PermissionCatalogEntry,
  RoleHolders,
  RoleSetResolution,
  canonicalRoleLabel,
  canonicalRoleDescription,
  conferrableRoleNames,
  filterPermissionNames,
  groupPermissionsByCategory,
  permissionLabel,
  permissionPickerOptions,
  permissionSetsEqual,
  togglePermissionName,
} from './adminRolesUi'

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

type EffectivePermissions = {
  userUuid: string
  directRoleNames: string[]
  groupRoleNames: string[]
  effectiveRoleNames: string[]
  effectivePermissionNames: string[]
}

/** Always-visible badge for a role/permission chip. */
const Chip: FunctionComponent<{ name: string; title?: string }> = ({ name, title }) => (
  <span
    title={title}
    className="bg-info-backdrop text-foreground rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
  >
    {name}
  </span>
)

/** Clickable on/off chip used by the role & permission pickers. */
const ToggleChip: FunctionComponent<{ name: string; selected: boolean; title?: string; onToggle: () => void }> = ({
  name,
  selected,
  title,
  onToggle,
}) => (
  <button
    type="button"
    aria-pressed={selected}
    title={title}
    onClick={onToggle}
    className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${
      selected ? 'border-info bg-info text-info-contrast' : 'border-border text-text hover:bg-contrast bg-transparent'
    }`}
  >
    {name}
  </button>
)

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
}

const AdminGroupsTab: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  // Second-level tabs inside this pane, subordinate to the main admin sub-tab
  // bar: split the (heavy) role-management and group-management surfaces.
  const subTab = useTabState({ defaultTab: 'roles' })

  // ---- Groups state ---------------------------------------------------------
  const [availableRoles, setAvailableRoles] = useState<string[]>([])
  const [groups, setGroups] = useState<AdminGroup[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupDescription, setNewGroupDescription] = useState('')
  const [newGroupRoles, setNewGroupRoles] = useState<string[]>([])
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [editingRolesUuid, setEditingRolesUuid] = useState<string | null>(null)
  const [selectedGroupUuid, setSelectedGroupUuid] = useState<string | null>(null)
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [newMemberUuid, setNewMemberUuid] = useState('')

  // ---- Roles state ----------------------------------------------------------
  const [roles, setRoles] = useState<AdminRole[]>([])
  const [permissionCatalogNames, setPermissionCatalogNames] = useState<string[]>([])
  const [rolesLoading, setRolesLoading] = useState(false)
  const [editingRoleUuid, setEditingRoleUuid] = useState<string | null>(null)
  const [draftPermissions, setDraftPermissions] = useState<string[]>([])
  const [editorSearch, setEditorSearch] = useState('')
  const [savingRole, setSavingRole] = useState(false)
  // Role inspector: role uuid -> who holds it. Loaded for all roles up-front so
  // the Roles table can show the "who has it" counts.
  const [holders, setHolders] = useState<Record<string, RoleHolders>>({})

  // ---- Permission catalog browser ------------------------------------------
  const [catalog, setCatalog] = useState<PermissionCatalogEntry[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogSearch, setCatalogSearch] = useState('')
  const [catalogCategory, setCatalogCategory] = useState<string>('')

  // ---- Effective-permissions simulator -------------------------------------
  const [simRoles, setSimRoles] = useState<string[]>([])
  const [simResult, setSimResult] = useState<RoleSetResolution | null>(null)
  const [simLoading, setSimLoading] = useState(false)
  const [testEmail, setTestEmail] = useState('')
  const [testResult, setTestResult] = useState<EffectivePermissions | null>(null)
  const [testLoading, setTestLoading] = useState(false)

  // ---- Loaders --------------------------------------------------------------
  const loadRoles = useCallback(async () => {
    setRolesLoading(true)
    try {
      const response = await application.legacyApi.adminListRolesWithPermissions()
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        return
      }
      const data = (response as { data?: { roles?: AdminRole[]; permissions?: string[] } }).data
      setRoles(data?.roles ?? [])
      setPermissionCatalogNames(data?.permissions ?? [])
    } catch (error) {
      console.error(error)
    } finally {
      setRolesLoading(false)
    }
  }, [application, noteIfForbidden])

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true)
    try {
      const response = await application.legacyApi.adminGetPermissionCatalog()
      if (isErrorResponse(response)) {
        noteIfForbidden(response)
        return
      }
      const data = (response as { data?: { permissions?: PermissionCatalogEntry[] } }).data
      setCatalog(data?.permissions ?? [])
    } catch (error) {
      console.error(error)
    } finally {
      setCatalogLoading(false)
    }
  }, [application, noteIfForbidden])

  const loadGroups = useCallback(async () => {
    setGroupsLoading(true)
    try {
      const [rolesResponse, groupsResponse] = await Promise.all([
        application.legacyApi.adminGetAvailableRoles(),
        application.legacyApi.adminListGroups(),
      ])
      if (!isErrorResponse(rolesResponse)) {
        const data = (rolesResponse as { data?: { roleNames?: string[] } }).data
        setAvailableRoles(data?.roleNames ?? [])
      } else {
        noteIfForbidden(rolesResponse)
      }
      if (!isErrorResponse(groupsResponse)) {
        const data = (groupsResponse as { data?: { groups?: AdminGroup[] } }).data
        setGroups(data?.groups ?? [])
      } else {
        noteIfForbidden(groupsResponse)
      }
    } catch (error) {
      console.error(error)
    } finally {
      setGroupsLoading(false)
    }
  }, [application, noteIfForbidden])

  useEffect(() => {
    void loadRoles()
    void loadCatalog()
    void loadGroups()
  }, [loadRoles, loadCatalog, loadGroups])

  // ---- Role editor ----------------------------------------------------------
  const beginEditingRole = useCallback((role: AdminRole) => {
    setEditingRoleUuid(role.uuid)
    setDraftPermissions([...role.permissionNames])
    setEditorSearch('')
  }, [])

  const saveRolePermissions = useCallback(
    async (role: AdminRole) => {
      setSavingRole(true)
      try {
        const response = await application.legacyApi.adminSetRolePermissions(role.uuid, draftPermissions)
        if (isErrorResponse(response)) {
          const message =
            (response as { data?: { error?: { message?: string } } }).data?.error?.message ??
            'Failed to update role permissions.'
          addToast({ type: ToastType.Error, message })
          return
        }
        addToast({ type: ToastType.Success, message: `Updated permissions for ${role.name}.` })
        setEditingRoleUuid(null)
        await Promise.all([loadRoles(), loadCatalog()])
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to update role permissions.' })
      } finally {
        setSavingRole(false)
      }
    },
    [application, draftPermissions, loadRoles, loadCatalog],
  )

  // Load holder counts for every role in parallel so the Roles table can show a
  // "who has it" column without a per-row click. Best-effort: a failed role is
  // simply left without counts. Merges into the same `holders` map the inspector
  // uses, so the group chips stay available.
  const loadAllRoleHolders = useCallback(
    async (rolesToLoad: AdminRole[]) => {
      try {
        const results = await Promise.all(
          rolesToLoad.map(async (role) => {
            const response = await application.legacyApi.adminGetRoleHolders(role.uuid)
            if (isErrorResponse(response)) {
              return null
            }
            const data = (response as { data?: RoleHolders }).data
            return data ? { uuid: role.uuid, holders: data } : null
          }),
        )
        setHolders((current) => {
          const next = { ...current }
          for (const result of results) {
            if (result) {
              next[result.uuid] = result.holders
            }
          }
          return next
        })
      } catch (error) {
        console.error(error)
      }
    },
    [application],
  )

  // Refresh holder counts whenever the role list (re)loads.
  useEffect(() => {
    if (roles.length > 0) {
      void loadAllRoleHolders(roles)
    }
  }, [roles, loadAllRoleHolders])

  // ---- Simulator ------------------------------------------------------------
  const runSimulation = useCallback(
    async (nextRoles: string[]) => {
      if (nextRoles.length === 0) {
        setSimResult(null)
        return
      }
      setSimLoading(true)
      try {
        const response = await application.legacyApi.adminResolveRoleSetPermissions(nextRoles)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to resolve permissions.' })
          return
        }
        const data = response as { data?: RoleSetResolution }
        setSimResult(data.data ?? null)
      } catch (error) {
        console.error(error)
      } finally {
        setSimLoading(false)
      }
    },
    [application],
  )

  const toggleSimRole = useCallback(
    (roleName: string) => {
      setSimRoles((current) => {
        const next = current.includes(roleName) ? current.filter((name) => name !== roleName) : [...current, roleName]
        void runSimulation(next)
        return next
      })
    },
    [runSimulation],
  )

  const testUser = useCallback(async () => {
    const email = testEmail.trim()
    if (!email) {
      return
    }
    setTestLoading(true)
    setTestResult(null)
    try {
      const lookup = await application.legacyApi.adminLookupUser(email)
      if (isErrorResponse(lookup)) {
        addToast({ type: ToastType.Error, message: `No user found for ${email}.` })
        return
      }
      const uuid = (lookup as { data?: { uuid?: string } }).data?.uuid
      if (!uuid) {
        addToast({ type: ToastType.Error, message: `No user found for ${email}.` })
        return
      }
      const response = await application.legacyApi.adminGetUserEffectivePermissions(uuid)
      if (isErrorResponse(response)) {
        addToast({ type: ToastType.Error, message: 'Failed to load effective permissions.' })
        return
      }
      const data = response as { data?: EffectivePermissions }
      setTestResult(data.data ?? null)
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to test user.' })
    } finally {
      setTestLoading(false)
    }
  }, [application, testEmail])

  // ---- Group handlers (unchanged behaviour) --------------------------------
  const createGroup = useCallback(async () => {
    if (!newGroupName.trim()) {
      return
    }
    setCreatingGroup(true)
    try {
      const response = await application.legacyApi.adminCreateGroup(
        newGroupName.trim(),
        newGroupDescription.trim() === '' ? null : newGroupDescription.trim(),
        newGroupRoles,
      )
      if (isErrorResponse(response)) {
        addToast({ type: ToastType.Error, message: 'Failed to create group.' })
        return
      }
      setNewGroupName('')
      setNewGroupDescription('')
      setNewGroupRoles([])
      addToast({ type: ToastType.Success, message: 'Group created.' })
      await loadGroups()
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to create group.' })
    } finally {
      setCreatingGroup(false)
    }
  }, [application, newGroupName, newGroupDescription, newGroupRoles, loadGroups])

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
        if (editingRolesUuid === group.uuid) {
          setEditingRolesUuid(null)
        }
        await loadGroups()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to delete group.' })
      }
    },
    [application, loadGroups, selectedGroupUuid, editingRolesUuid],
  )

  const toggleGroupRole = useCallback(
    async (group: AdminGroup, roleName: string, enabled: boolean) => {
      const nextRoles = toggleRoleName(group.roleNames, roleName, enabled)
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

  // ---- Derived values -------------------------------------------------------
  const groupRolePickerBase = useMemo(() => conferrableRoleNames(availableRoles, roles), [availableRoles, roles])

  const catalogCategories = useMemo(() => {
    const set = new Set<string>()
    for (const entry of catalog) {
      set.add(entry.category)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [catalog])

  const filteredCatalog = useMemo(() => {
    const needle = catalogSearch.trim().toLowerCase()
    return catalog.filter((entry) => {
      if (catalogCategory && entry.category !== catalogCategory) {
        return false
      }
      if (needle.length === 0) {
        return true
      }
      return (
        entry.name.toLowerCase().includes(needle) ||
        permissionLabel(entry.name).toLowerCase().includes(needle) ||
        entry.grantedByRoleNames.some((roleName) => roleName.toLowerCase().includes(needle))
      )
    })
  }, [catalog, catalogSearch, catalogCategory])

  const groupedCatalog = useMemo(
    () => groupPermissionsByCategory(filteredCatalog.map((entry) => entry.name)),
    [filteredCatalog],
  )
  const grantedByLookup = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const entry of catalog) {
      map.set(entry.name, entry.grantedByRoleNames)
    }
    return map
  }, [catalog])

  // The role currently open in the permission editor (rendered below the table).
  const editingRole = roles.find((role) => role.uuid === editingRoleUuid) ?? null
  // Groups whose expandable panels are open (rendered below the groups table).
  const editingRolesGroup = groups.find((group) => group.uuid === editingRolesUuid) ?? null
  const membersGroup = groups.find((group) => group.uuid === selectedGroupUuid) ?? null

  return (
    <>
      {/* ================= SECOND-LEVEL TABS ================= */}
      <PreferencesSegment>
        <Title>Groups &amp; roles</Title>
        <Text>
          Manage the four canonical roles (which permissions each grants) and the groups that confer roles on their
          members. A user&apos;s effective permissions are the union of their own roles and the roles their groups
          confer.
        </Text>
        <div className="border-border mt-3 overflow-x-auto border-b">
          <TabList state={subTab} className="flex min-w-max whitespace-nowrap">
            <Tab id="roles" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="accessibility" size="medium" />
              Roles
            </Tab>
            <Tab id="catalog" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="list-check" size="medium" />
              Permission catalog
            </Tab>
            <Tab id="effective" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="user-switch" size="medium" />
              Effective permissions
            </Tab>
            <Tab id="groups" className="inline-flex items-center gap-1.5 !text-xs">
              <Icon type="group" size="medium" />
              Groups
            </Tab>
          </TabList>
        </div>
      </PreferencesSegment>

      {/* ================= ROLES TAB ================= */}
      <TabPanel state={subTab} id="roles">
        {/* ---- Roles table ---- */}
        <PreferencesSegment>
          <Title>Roles</Title>
          <Text>
            The system exposes exactly four roles — Admin, Full, Core and Vaults users. Each grants a set of
            permissions; use the Edit permissions row action to change which permissions a role grants, drawing from the
            server&apos;s permission catalog below.
          </Text>

          <div className="mt-3 flex items-center gap-2">
            <Button small label="Refresh" onClick={() => void Promise.all([loadRoles(), loadCatalog()])} />
          </div>

          {rolesLoading ? (
            <Spinner className="mt-3 h-5 w-5" />
          ) : roles.length === 0 ? (
            <Text className="mt-3">No roles reported by this server.</Text>
          ) : (
            <div className="border-border mt-3 overflow-auto rounded-md border">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr>
                    <th className="border-border bg-contrast border-b px-3 py-2 font-semibold">Role</th>
                    <th className="border-border bg-contrast border-b px-3 py-2 font-semibold">Permissions</th>
                    <th className="border-border bg-contrast border-b px-3 py-2 font-semibold">Who has it</th>
                    <th className="border-border bg-contrast border-b px-3 py-2 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {roles.map((role) => {
                    const isEditing = editingRoleUuid === role.uuid
                    const holderInfo = holders[role.uuid]
                    // DB description wins (server already resolves that); fall back
                    // to the canonical default so the built-in four always show one.
                    const description = role.description || canonicalRoleDescription(role.name)
                    return (
                      <tr key={role.uuid} className={isEditing ? 'bg-info-backdrop' : ''}>
                        <td className="px-3 py-2.5">
                          <div className="flex min-w-0 flex-col">
                            <Subtitle>{role.label ?? canonicalRoleLabel(role.name)}</Subtitle>
                            <Text className="text-passive-1 text-xs">{role.name}</Text>
                            {description && <Text className="text-passive-1 mt-0.5 text-xs">{description}</Text>}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">
                          {role.permissionNames.length} permission{role.permissionNames.length === 1 ? '' : 's'}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {holderInfo ? (
                            <span className="tabular-nums">
                              {holderInfo.directUserCount} direct · {holderInfo.groups.length} group
                              {holderInfo.groups.length === 1 ? '' : 's'}
                            </span>
                          ) : (
                            <span className="text-passive-1">…</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <Button
                            small
                            label={isEditing ? 'Close' : 'Edit permissions'}
                            onClick={() => (isEditing ? setEditingRoleUuid(null) : beginEditingRole(role))}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Permission editor + role inspector for the role being edited. */}
          {editingRole &&
            (() => {
              const pickerOptions = permissionPickerOptions(permissionCatalogNames, draftPermissions)
              const visibleOptions = filterPermissionNames(pickerOptions, editorSearch)
              const groupedOptions = groupPermissionsByCategory(visibleOptions)
              const unchanged = permissionSetsEqual(draftPermissions, editingRole.permissionNames)
              const holderInfo = holders[editingRole.uuid]
              return (
                <div className="border-info mt-3 rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Subtitle>
                      Editing: {editingRole.label ?? canonicalRoleLabel(editingRole.name)}{' '}
                      <span className="text-passive-1 text-xs font-normal">{editingRole.name}</span>
                    </Subtitle>
                    <Button small label="Close" onClick={() => setEditingRoleUuid(null)} />
                  </div>

                  {/* Role inspector: who has it (group chips) */}
                  {holderInfo && holderInfo.groups.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Text className="text-passive-1 text-xs">Conferred by groups:</Text>
                      {holderInfo.groups.map((group) => (
                        <Chip key={group.uuid} name={group.name} />
                      ))}
                    </div>
                  )}

                  <div className="border-border mt-3 rounded border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Text className="text-passive-1 text-xs">
                        Toggle permissions, then Save. {draftPermissions.length} selected
                        {unchanged ? '' : ' — unsaved changes'}.
                      </Text>
                      <DecoratedInput
                        className={{ container: 'min-w-[180px]' }}
                        placeholder="Filter permissions…"
                        value={editorSearch}
                        onChange={setEditorSearch}
                      />
                    </div>
                    {groupedOptions.length === 0 ? (
                      <Text className="mt-2">No matching permissions.</Text>
                    ) : (
                      <div className="mt-2 flex flex-col gap-3">
                        {groupedOptions.map(({ category, permissions }) => {
                          const allSelected = permissions.every((p) => draftPermissions.includes(p))
                          return (
                            <div key={category}>
                              <div className="flex items-center gap-2">
                                <Text className="text-passive-1 text-xs font-semibold uppercase">{category}</Text>
                                <button
                                  type="button"
                                  className="text-info cursor-pointer text-xs hover:underline"
                                  onClick={() =>
                                    setDraftPermissions((current) => {
                                      let next = current
                                      for (const permission of permissions) {
                                        next = togglePermissionName(next, permission, !allSelected)
                                      }
                                      return next
                                    })
                                  }
                                >
                                  {allSelected ? 'Clear all' : 'Select all'}
                                </button>
                              </div>
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {permissions.map((permission) => {
                                  const selected = draftPermissions.includes(permission)
                                  return (
                                    <ToggleChip
                                      key={permission}
                                      name={permission}
                                      title={permissionLabel(permission)}
                                      selected={selected}
                                      onToggle={() =>
                                        setDraftPermissions((current) =>
                                          togglePermissionName(current, permission, !selected),
                                        )
                                      }
                                    />
                                  )
                                })}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    <div className="mt-3 flex items-center gap-2">
                      <Button
                        small
                        label={savingRole ? 'Saving…' : 'Save permissions'}
                        disabled={savingRole || unchanged}
                        onClick={() => void saveRolePermissions(editingRole)}
                      />
                      <Button small label="Cancel" onClick={() => setEditingRoleUuid(null)} />
                    </div>
                  </div>
                </div>
              )
            })()}
        </PreferencesSegment>
      </TabPanel>

      {/* ================= PERMISSION CATALOG TAB ================= */}
      <TabPanel state={subTab} id="catalog">
        <PreferencesSegment>
          <Title>Permission catalog</Title>
          <Text>
            Every permission the server knows about, grouped by category, with the roles that currently grant each one.
          </Text>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <DecoratedInput
              className={{ container: 'min-w-[220px] flex-grow' }}
              placeholder="Search permissions or granting roles…"
              value={catalogSearch}
              onChange={setCatalogSearch}
            />
            <select
              className="border-border bg-default text-text rounded border px-2 py-1.5 text-sm"
              value={catalogCategory}
              onChange={(event) => setCatalogCategory(event.target.value)}
            >
              <option value="">All categories ({catalog.length})</option>
              {catalogCategories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>

          {catalogLoading ? (
            <Spinner className="mt-3 h-5 w-5" />
          ) : catalog.length === 0 ? (
            <Text className="mt-3">This server reports no permission catalog.</Text>
          ) : groupedCatalog.length === 0 ? (
            <Text className="mt-3">No permissions match your filter.</Text>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              {groupedCatalog.map(({ category, permissions }) => (
                <div key={category} className="border-border rounded-md border p-3">
                  <Subtitle>
                    {category} ({permissions.length})
                  </Subtitle>
                  <div className="divide-border mt-2 divide-y">
                    {permissions.map((permission) => {
                      const grantedBy = grantedByLookup.get(permission) ?? []
                      return (
                        <div key={permission} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                          <div className="flex min-w-0 flex-col">
                            <Text>{permissionLabel(permission)}</Text>
                            <Text className="text-passive-1 text-xs">{permission}</Text>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {grantedBy.length > 0 ? (
                              grantedBy.map((roleName) => (
                                <Chip key={roleName} name={canonicalRoleLabel(roleName)} title={roleName} />
                              ))
                            ) : (
                              <Text className="text-passive-1 text-xs italic">Granted by no role</Text>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </PreferencesSegment>
      </TabPanel>

      {/* ================= EFFECTIVE PERMISSIONS TAB ================= */}
      <TabPanel state={subTab} id="effective">
        <PreferencesSegment>
          <Title>Effective-permissions simulator</Title>
          <Text>
            Select a set of roles to see the union of the permissions they grant, or test a specific user by email to
            see their direct + group roles and resolved permissions.
          </Text>

          <div className="border-border mt-3 rounded-md border p-3">
            <Subtitle>Resolve a role set</Subtitle>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {groupRolePickerBase.map((roleName) => (
                <ToggleChip
                  key={roleName}
                  name={canonicalRoleLabel(roleName)}
                  title={roleName}
                  selected={simRoles.includes(roleName)}
                  onToggle={() => toggleSimRole(roleName)}
                />
              ))}
            </div>
            {simLoading ? (
              <Spinner className="mt-3 h-5 w-5" />
            ) : simResult ? (
              <div className="mt-3">
                <Text className="text-passive-1 text-xs">
                  {simResult.effectivePermissionNames.length} effective permission
                  {simResult.effectivePermissionNames.length === 1 ? '' : 's'} across {simResult.roleNames.length} role
                  {simResult.roleNames.length === 1 ? '' : 's'}
                  {simResult.unknownRoleNames.length > 0 ? ` (${simResult.unknownRoleNames.join(', ')} not found)` : ''}
                  .
                </Text>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {simResult.effectivePermissionNames.map((permission) => (
                    <Chip key={permission} name={permission} title={permissionLabel(permission)} />
                  ))}
                </div>
              </div>
            ) : (
              <Text className="text-passive-1 mt-2 text-xs italic">Select one or more roles above.</Text>
            )}
          </div>

          <div className="border-border mt-3 rounded-md border p-3">
            <Subtitle>Test a user</Subtitle>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <DecoratedInput
                className={{ container: 'min-w-[220px] flex-grow' }}
                placeholder="user@example.com"
                value={testEmail}
                onChange={setTestEmail}
                onEnter={() => void testUser()}
              />
              <Button
                label={testLoading ? 'Testing…' : 'Test user'}
                disabled={testLoading}
                onClick={() => void testUser()}
              />
            </div>
            {testResult && (
              <div className="mt-3 flex flex-col gap-2">
                <div>
                  <Text className="text-passive-1 text-xs font-semibold uppercase">Direct roles</Text>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {testResult.directRoleNames.length > 0 ? (
                      testResult.directRoleNames.map((roleName) => (
                        <Chip key={roleName} name={canonicalRoleLabel(roleName)} title={roleName} />
                      ))
                    ) : (
                      <Text className="text-passive-1 text-xs italic">None</Text>
                    )}
                  </div>
                </div>
                <div>
                  <Text className="text-passive-1 text-xs font-semibold uppercase">Group-conferred roles</Text>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {testResult.groupRoleNames.length > 0 ? (
                      testResult.groupRoleNames.map((roleName) => (
                        <Chip key={roleName} name={canonicalRoleLabel(roleName)} title={roleName} />
                      ))
                    ) : (
                      <Text className="text-passive-1 text-xs italic">None</Text>
                    )}
                  </div>
                </div>
                <div>
                  <Text className="text-passive-1 text-xs font-semibold uppercase">
                    Effective permissions ({testResult.effectivePermissionNames.length})
                  </Text>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {testResult.effectivePermissionNames.map((permission) => (
                      <Chip key={permission} name={permission} title={permissionLabel(permission)} />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </PreferencesSegment>
      </TabPanel>

      {/* ================= GROUPS TAB ================= */}
      <TabPanel state={subTab} id="groups">
        <PreferencesSegment>
          <Title>Groups</Title>
          <Text>
            Groups confer a set of roles on every member. A user&apos;s effective permissions are the union of their own
            roles and the roles granted by their groups. Groups may confer built-in <em>and</em> custom roles.
          </Text>

          <div className="border-border mt-3 rounded-md border p-3">
            <Subtitle>Create a group</Subtitle>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <DecoratedInput
                className={{ container: 'min-w-[220px] flex-grow' }}
                placeholder="Group name"
                value={newGroupName}
                onChange={setNewGroupName}
                onEnter={() => void createGroup()}
              />
              <DecoratedInput
                className={{ container: 'min-w-[220px] flex-grow' }}
                placeholder="Description (optional)"
                value={newGroupDescription}
                onChange={setNewGroupDescription}
                onEnter={() => void createGroup()}
              />
              <Button
                label="Create group"
                onClick={() => void createGroup()}
                disabled={creatingGroup || newGroupName.trim() === ''}
              />
            </div>
            {groupRolePickerBase.length > 0 && (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <Text className="text-passive-1 mr-1 text-xs">Confer roles:</Text>
                {groupRolePickerBase.map((roleName) => (
                  <ToggleChip
                    key={roleName}
                    name={canonicalRoleLabel(roleName)}
                    title={roleName}
                    selected={newGroupRoles.includes(roleName)}
                    onToggle={() =>
                      setNewGroupRoles((current) => toggleRoleName(current, roleName, !current.includes(roleName)))
                    }
                  />
                ))}
              </div>
            )}
          </div>

          <HorizontalSeparator classes="my-4" />

          {groupsLoading ? (
            <Spinner className="h-5 w-5" />
          ) : groups.length === 0 ? (
            <Text>No groups yet.</Text>
          ) : (
            <div className="border-border overflow-auto rounded-md border">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr>
                    <th className="border-border bg-contrast border-b px-3 py-2 font-semibold">Group</th>
                    <th className="border-border bg-contrast border-b px-3 py-2 font-semibold">Conferred roles</th>
                    <th className="border-border bg-contrast border-b px-3 py-2 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {groups.map((group) => {
                    const isEditingRoles = editingRolesUuid === group.uuid
                    const isShowingMembers = selectedGroupUuid === group.uuid
                    return (
                      <tr key={group.uuid} className={isEditingRoles || isShowingMembers ? 'bg-info-backdrop' : ''}>
                        <td className="px-3 py-2.5">
                          <div className="flex min-w-0 flex-col">
                            <Subtitle>{group.name}</Subtitle>
                            {group.description && <Text className="text-passive-1">{group.description}</Text>}
                            <Text className="text-passive-1 mt-0.5 text-xs">{group.uuid}</Text>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {group.roleNames.length > 0 ? (
                              group.roleNames.map((roleName) => (
                                <Chip key={roleName} name={canonicalRoleLabel(roleName)} title={roleName} />
                              ))
                            ) : (
                              <Text className="text-passive-1 text-xs italic">No roles conferred</Text>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-2">
                            <Button
                              small
                              label={isEditingRoles ? 'Done' : 'Edit roles'}
                              onClick={() => setEditingRolesUuid(isEditingRoles ? null : group.uuid)}
                            />
                            <Button
                              small
                              label={isShowingMembers ? 'Hide members' : 'Members'}
                              onClick={() => {
                                if (isShowingMembers) {
                                  setSelectedGroupUuid(null)
                                } else {
                                  void loadGroupMembers(group.uuid)
                                }
                              }}
                            />
                            <Button small colorStyle="danger" label="Delete" onClick={() => void deleteGroup(group)} />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Edit-roles panel for the group whose roles are being edited. */}
          {editingRolesGroup &&
            (() => {
              const pickerOptions = rolePickerOptions(groupRolePickerBase, editingRolesGroup.roleNames)
              return (
                <div className="border-info mt-3 rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Subtitle>Roles conferred by: {editingRolesGroup.name}</Subtitle>
                    <Button small label="Done" onClick={() => setEditingRolesUuid(null)} />
                  </div>
                  <Text className="text-passive-1 mt-1 text-xs">
                    Toggle the roles this group confers on every member. Changes are saved immediately.
                  </Text>
                  {pickerOptions.length === 0 ? (
                    <Text className="mt-2">This server does not report any assignable roles.</Text>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {pickerOptions.map((roleName) => {
                        const conferred = editingRolesGroup.roleNames.includes(roleName)
                        return (
                          <ToggleChip
                            key={roleName}
                            name={canonicalRoleLabel(roleName)}
                            title={roleName}
                            selected={conferred}
                            onToggle={() => void toggleGroupRole(editingRolesGroup, roleName, !conferred)}
                          />
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })()}

          {/* Members panel for the group whose members are shown. */}
          {membersGroup && (
            <div className="border-info mt-3 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Subtitle>
                  Members of {membersGroup.name}
                  {membersLoading ? '' : ` (${groupMembers.length})`}
                </Subtitle>
                <Button small label="Hide members" onClick={() => setSelectedGroupUuid(null)} />
              </div>
              {membersLoading ? (
                <Spinner className="mt-2 h-5 w-5" />
              ) : (
                <>
                  {groupMembers.length === 0 ? (
                    <Text className="text-passive-1 mt-2 italic">No members yet.</Text>
                  ) : (
                    <div className="divide-border mt-2 divide-y">
                      {groupMembers.map((member) => (
                        <div key={member.uuid} className="flex items-center justify-between gap-2 py-1.5">
                          <Text>{member.email ?? member.uuid}</Text>
                          <Button small label="Remove" onClick={() => void removeMember(member.uuid)} />
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <DecoratedInput
                      className={{ container: 'flex-grow' }}
                      placeholder="User UUID to add"
                      value={newMemberUuid}
                      onChange={setNewMemberUuid}
                      onEnter={() => void addMember()}
                    />
                    <Button small label="Add" onClick={() => void addMember()} />
                  </div>
                </>
              )}
            </div>
          )}
        </PreferencesSegment>
      </TabPanel>
    </>
  )
}

export default AdminGroupsTab

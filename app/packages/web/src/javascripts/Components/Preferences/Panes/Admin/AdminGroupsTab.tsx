import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import { ToastType, addToast } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'
import { rolePickerOptions, toggleRoleName } from './adminGroupsUi'
import {
  AdminRole,
  PermissionCatalogEntry,
  RoleHolders,
  RoleSetResolution,
  canonicalRoleLabel,
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
    className="whitespace-nowrap rounded-full bg-info-backdrop px-2.5 py-0.5 text-xs font-medium text-foreground"
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
    className={`cursor-pointer whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${
      selected ? 'border-info bg-info text-info-contrast' : 'border-border bg-transparent text-text hover:bg-contrast'
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
  // Role inspector: role uuid -> who holds it.
  const [holders, setHolders] = useState<Record<string, RoleHolders>>({})
  const [holdersLoadingUuid, setHoldersLoadingUuid] = useState<string | null>(null)

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

  const loadRoleHolders = useCallback(
    async (role: AdminRole) => {
      setHoldersLoadingUuid(role.uuid)
      try {
        const response = await application.legacyApi.adminGetRoleHolders(role.uuid)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to load role holders.' })
          return
        }
        const data = response as { data?: RoleHolders }
        if (data.data) {
          setHolders((current) => ({ ...current, [role.uuid]: data.data as RoleHolders }))
        }
      } catch (error) {
        console.error(error)
      } finally {
        setHoldersLoadingUuid(null)
      }
    },
    [application],
  )

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
        const next = current.includes(roleName)
          ? current.filter((name) => name !== roleName)
          : [...current, roleName]
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

  return (
    <>
      {/* ================= ROLES ================= */}
      <PreferencesSegment>
        <Title>Roles &amp; permissions</Title>
        <Text>
          The system exposes exactly four roles — Admin, Full, Core and Vaults users. Each grants a set of permissions;
          use the Edit permissions button on a role to change which permissions it grants, drawing from the server&apos;s
          permission catalog.
        </Text>

        <div className="mt-3 flex items-center gap-2">
          <Button small label="Refresh" onClick={() => void Promise.all([loadRoles(), loadCatalog()])} />
        </div>

        {rolesLoading ? (
          <Spinner className="mt-3 h-5 w-5" />
        ) : roles.length === 0 ? (
          <Text className="mt-3">No roles reported by this server.</Text>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {roles.map((role) => {
              const isEditing = editingRoleUuid === role.uuid
              const pickerOptions = permissionPickerOptions(
                permissionCatalogNames,
                isEditing ? draftPermissions : role.permissionNames,
              )
              const visibleOptions = filterPermissionNames(pickerOptions, editorSearch)
              const groupedOptions = groupPermissionsByCategory(visibleOptions)
              const unchanged = permissionSetsEqual(draftPermissions, role.permissionNames)
              const holderInfo = holders[role.uuid]
              return (
                <div key={role.uuid} className="rounded-md border border-border p-3">
                  {/* Header: label + permission preview on the left; the Edit
                      permissions control is pinned TOP-RIGHT of every card. */}
                  <div className="flex items-start justify-between gap-x-3 gap-y-2">
                    <div className="flex min-w-0 flex-grow flex-col">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <Subtitle>{role.label ?? canonicalRoleLabel(role.name)}</Subtitle>
                        <Text className="text-xs text-passive-1">{role.name}</Text>
                        <Text className="text-xs text-passive-1">
                          · {role.permissionNames.length} permission{role.permissionNames.length === 1 ? '' : 's'}
                        </Text>
                      </div>
                      {role.description && <Text className="mt-0.5 text-passive-1">{role.description}</Text>}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {role.permissionNames.length > 0 ? (
                          role.permissionNames.map((permission) => (
                            <Chip key={permission} name={permission} title={permissionLabel(permission)} />
                          ))
                        ) : (
                          <Text className="text-xs italic text-passive-1">No permissions granted</Text>
                        )}
                      </div>
                      <div className="mt-2">
                        <Button
                          small
                          label={holderInfo ? 'Refresh holders' : 'Who has it'}
                          disabled={holdersLoadingUuid === role.uuid}
                          onClick={() => void loadRoleHolders(role)}
                        />
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-start">
                      <Button
                        label={isEditing ? 'Close' : 'Edit permissions'}
                        onClick={() => (isEditing ? setEditingRoleUuid(null) : beginEditingRole(role))}
                      />
                    </div>
                  </div>

                  {/* Role inspector: who has it */}
                  {holderInfo && (
                    <div className="mt-3 rounded border border-border p-3">
                      <Text className="text-xs text-passive-1">
                        Held directly by <strong>{holderInfo.directUserCount}</strong> user
                        {holderInfo.directUserCount === 1 ? '' : 's'}; conferred by{' '}
                        <strong>{holderInfo.groups.length}</strong> group
                        {holderInfo.groups.length === 1 ? '' : 's'}.
                      </Text>
                      {holderInfo.groups.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {holderInfo.groups.map((group) => (
                            <Chip key={group.uuid} name={group.name} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Richer permission editor: grouped, searchable, per-group select-all */}
                  {isEditing && (
                    <div className="mt-3 rounded border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Text className="text-xs text-passive-1">
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
                                  <Text className="text-xs font-semibold uppercase text-passive-1">{category}</Text>
                                  <button
                                    type="button"
                                    className="cursor-pointer text-xs text-info hover:underline"
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
                          onClick={() => void saveRolePermissions(role)}
                        />
                        <Button small label="Cancel" onClick={() => setEditingRoleUuid(null)} />
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </PreferencesSegment>

      {/* ================= PERMISSION CATALOG ================= */}
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
            className="rounded border border-border bg-default px-2 py-1.5 text-sm text-text"
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
              <div key={category} className="rounded-md border border-border p-3">
                <Subtitle>
                  {category} ({permissions.length})
                </Subtitle>
                <div className="mt-2 divide-y divide-border">
                  {permissions.map((permission) => {
                    const grantedBy = grantedByLookup.get(permission) ?? []
                    return (
                      <div key={permission} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                        <div className="flex min-w-0 flex-col">
                          <Text>{permissionLabel(permission)}</Text>
                          <Text className="text-xs text-passive-1">{permission}</Text>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {grantedBy.length > 0 ? (
                            grantedBy.map((roleName) => (
                              <Chip key={roleName} name={canonicalRoleLabel(roleName)} title={roleName} />
                            ))
                          ) : (
                            <Text className="text-xs italic text-passive-1">Granted by no role</Text>
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

      {/* ================= SIMULATOR ================= */}
      <PreferencesSegment>
        <Title>Effective-permissions simulator</Title>
        <Text>
          Select a set of roles to see the union of the permissions they grant, or test a specific user by email to see
          their direct + group roles and resolved permissions.
        </Text>

        <div className="mt-3 rounded-md border border-border p-3">
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
              <Text className="text-xs text-passive-1">
                {simResult.effectivePermissionNames.length} effective permission
                {simResult.effectivePermissionNames.length === 1 ? '' : 's'} across {simResult.roleNames.length} role
                {simResult.roleNames.length === 1 ? '' : 's'}
                {simResult.unknownRoleNames.length > 0 ? ` (${simResult.unknownRoleNames.join(', ')} not found)` : ''}.
              </Text>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {simResult.effectivePermissionNames.map((permission) => (
                  <Chip key={permission} name={permission} title={permissionLabel(permission)} />
                ))}
              </div>
            </div>
          ) : (
            <Text className="mt-2 text-xs italic text-passive-1">Select one or more roles above.</Text>
          )}
        </div>

        <div className="mt-3 rounded-md border border-border p-3">
          <Subtitle>Test a user</Subtitle>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <DecoratedInput
              className={{ container: 'min-w-[220px] flex-grow' }}
              placeholder="user@example.com"
              value={testEmail}
              onChange={setTestEmail}
              onEnter={() => void testUser()}
            />
            <Button label={testLoading ? 'Testing…' : 'Test user'} disabled={testLoading} onClick={() => void testUser()} />
          </div>
          {testResult && (
            <div className="mt-3 flex flex-col gap-2">
              <div>
                <Text className="text-xs font-semibold uppercase text-passive-1">Direct roles</Text>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {testResult.directRoleNames.length > 0 ? (
                    testResult.directRoleNames.map((roleName) => (
                      <Chip key={roleName} name={canonicalRoleLabel(roleName)} title={roleName} />
                    ))
                  ) : (
                    <Text className="text-xs italic text-passive-1">None</Text>
                  )}
                </div>
              </div>
              <div>
                <Text className="text-xs font-semibold uppercase text-passive-1">Group-conferred roles</Text>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {testResult.groupRoleNames.length > 0 ? (
                    testResult.groupRoleNames.map((roleName) => (
                      <Chip key={roleName} name={canonicalRoleLabel(roleName)} title={roleName} />
                    ))
                  ) : (
                    <Text className="text-xs italic text-passive-1">None</Text>
                  )}
                </div>
              </div>
              <div>
                <Text className="text-xs font-semibold uppercase text-passive-1">
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

      {/* ================= GROUPS ================= */}
      <PreferencesSegment>
        <Title>Groups</Title>
        <Text>
          Groups confer a set of roles on every member. A user&apos;s effective permissions are the union of their own
          roles and the roles granted by their groups. Groups may confer built-in <em>and</em> custom roles.
        </Text>

        <div className="mt-3 rounded-md border border-border p-3">
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
              <Text className="mr-1 text-xs text-passive-1">Confer roles:</Text>
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
          <div className="flex flex-col gap-3">
            {groups.map((group) => {
              const pickerOptions = rolePickerOptions(groupRolePickerBase, group.roleNames)
              const isEditingRoles = editingRolesUuid === group.uuid
              const isShowingMembers = selectedGroupUuid === group.uuid
              return (
                <div key={group.uuid} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                    <div className="flex min-w-0 flex-grow flex-col">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <Subtitle>{group.name}</Subtitle>
                        {group.description && <Text className="text-passive-1">{group.description}</Text>}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {group.roleNames.length > 0 ? (
                          group.roleNames.map((roleName) => (
                            <Chip key={roleName} name={canonicalRoleLabel(roleName)} title={roleName} />
                          ))
                        ) : (
                          <Text className="text-xs italic text-passive-1">No roles conferred</Text>
                        )}
                      </div>
                      <Text className="mt-1 text-xs text-passive-1">{group.uuid}</Text>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
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
                  </div>

                  {isEditingRoles && (
                    <div className="mt-3 rounded border border-border p-3">
                      <Text className="text-xs text-passive-1">
                        Toggle the roles this group confers on every member. Changes are saved immediately.
                      </Text>
                      {pickerOptions.length === 0 ? (
                        <Text className="mt-2">This server does not report any assignable roles.</Text>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {pickerOptions.map((roleName) => {
                            const conferred = group.roleNames.includes(roleName)
                            return (
                              <ToggleChip
                                key={roleName}
                                name={canonicalRoleLabel(roleName)}
                                title={roleName}
                                selected={conferred}
                                onToggle={() => void toggleGroupRole(group, roleName, !conferred)}
                              />
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {isShowingMembers && (
                    <div className="mt-3 rounded border border-border p-3">
                      <Subtitle>Members{membersLoading ? '' : ` (${groupMembers.length})`}</Subtitle>
                      {membersLoading ? (
                        <Spinner className="mt-2 h-5 w-5" />
                      ) : (
                        <>
                          {groupMembers.length === 0 ? (
                            <Text className="mt-2 italic text-passive-1">No members yet.</Text>
                          ) : (
                            <div className="mt-2 divide-y divide-border">
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
                </div>
              )
            })}
          </div>
        )}
      </PreferencesSegment>
    </>
  )
}

export default AdminGroupsTab

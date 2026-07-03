import { FunctionComponent, useCallback, useEffect, useState } from 'react'
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

/** Always-visible badge for a role a group currently confers. */
const RoleChip: FunctionComponent<{ name: string }> = ({ name }) => (
  <span className="whitespace-nowrap rounded-full bg-info-backdrop px-2.5 py-0.5 text-xs font-medium text-foreground">
    {name}
  </span>
)

/** Clickable on/off chip used by the role pickers (create form + group editor). */
const RoleToggleChip: FunctionComponent<{ name: string; selected: boolean; onToggle: () => void }> = ({
  name,
  selected,
  onToggle,
}) => (
  <button
    type="button"
    aria-pressed={selected}
    onClick={onToggle}
    className={`cursor-pointer whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${
      selected ? 'border-info bg-info text-info-contrast' : 'border-border bg-transparent text-text hover:bg-contrast'
    }`}
  >
    {name}
  </button>
)

/** Static "built-in" marker for a role that is enum + migration bound. */
const BuiltInBadge: FunctionComponent = () => (
  <span className="whitespace-nowrap rounded-full bg-warning px-2 py-0.5 text-xs font-medium text-warning-contrast">
    Built-in
  </span>
)

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
}

const AdminGroupsTab: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  // RBAC groups & permissions state. Loaded lazily: this component only mounts
  // when the Groups & roles tab is opened.
  const [availableRoles, setAvailableRoles] = useState<string[]>([])
  const [groups, setGroups] = useState<AdminGroup[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupDescription, setNewGroupDescription] = useState('')
  const [newGroupRoles, setNewGroupRoles] = useState<string[]>([])
  const [creatingGroup, setCreatingGroup] = useState(false)
  // Which group's role picker is expanded (the conferred-role CHIPS are always
  // visible on every row; this only gates the editor).
  const [editingRolesUuid, setEditingRolesUuid] = useState<string | null>(null)
  const [selectedGroupUuid, setSelectedGroupUuid] = useState<string | null>(null)
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [newMemberUuid, setNewMemberUuid] = useState('')

  // Role management: the roles themselves (which permissions each role grants).
  // Roles are enum + migration bound server-side, so this section is READ +
  // edit-permission-assignments only — never create/delete a role type.
  const [roles, setRoles] = useState<AdminRole[]>([])
  const [permissionCatalog, setPermissionCatalog] = useState<string[]>([])
  const [rolesLoading, setRolesLoading] = useState(false)
  // Which role's permission editor is expanded (permission CHIPS are always
  // visible on every row; this only gates the editor).
  const [editingRoleUuid, setEditingRoleUuid] = useState<string | null>(null)
  // Working copy of the permissions for the role currently being edited.
  const [draftPermissions, setDraftPermissions] = useState<string[]>([])
  const [savingRole, setSavingRole] = useState(false)

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
      setPermissionCatalog(data?.permissions ?? [])
    } catch (error) {
      console.error(error)
    } finally {
      setRolesLoading(false)
    }
  }, [application, noteIfForbidden])

  useEffect(() => {
    void loadRoles()
  }, [loadRoles])

  const beginEditingRole = useCallback((role: AdminRole) => {
    setEditingRoleUuid(role.uuid)
    setDraftPermissions([...role.permissionNames])
  }, [])

  const saveRolePermissions = useCallback(
    async (role: AdminRole) => {
      setSavingRole(true)
      try {
        const response = await application.legacyApi.adminSetRolePermissions(role.uuid, draftPermissions)
        if (isErrorResponse(response)) {
          const message =
            ((response as { data?: { error?: { message?: string } } }).data?.error?.message) ??
            'Failed to update role permissions.'
          addToast({ type: ToastType.Error, message })
          return
        }
        addToast({ type: ToastType.Success, message: `Updated permissions for ${role.name}.` })
        setEditingRoleUuid(null)
        await loadRoles()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to update role permissions.' })
      } finally {
        setSavingRole(false)
      }
    },
    [application, draftPermissions, loadRoles],
  )

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

  return (
    <>
      <PreferencesSegment>
        <Title>Roles &amp; permissions</Title>
        <Text>
          Each role grants a set of permissions. Roles are built into the server (a fixed list plus database
          migrations), so new role <em>types</em> cannot be created here — adding one requires a migration. You can,
          however, edit which permissions each existing role grants, drawing from the server&apos;s permission catalog.
        </Text>

        {rolesLoading ? (
          <Spinner className="mt-3 h-5 w-5" />
        ) : roles.length === 0 ? (
          <Text className="mt-3">No roles reported by this server.</Text>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {roles.map((role) => {
              const isEditing = editingRoleUuid === role.uuid
              const options = permissionPickerOptions(
                permissionCatalog,
                isEditing ? draftPermissions : role.permissionNames,
              )
              const unchanged = permissionSetsEqual(draftPermissions, role.permissionNames)
              return (
                <div key={role.uuid} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                    <div className="flex min-w-0 flex-grow flex-col">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <Subtitle>{role.name}</Subtitle>
                        {role.isBuiltIn && <BuiltInBadge />}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {role.permissionNames.length > 0 ? (
                          role.permissionNames.map((permission) => <RoleChip key={permission} name={permission} />)
                        ) : (
                          <Text className="text-xs italic text-passive-1">No permissions granted</Text>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <Button
                        small
                        label={isEditing ? 'Close' : 'Edit permissions'}
                        onClick={() => (isEditing ? setEditingRoleUuid(null) : beginEditingRole(role))}
                      />
                    </div>
                  </div>

                  {isEditing && (
                    <div className="mt-3 rounded border border-border p-3">
                      <Text className="text-xs text-passive-1">
                        Toggle the permissions this role grants, then Save. Only permissions from the server catalog can
                        be assigned.
                      </Text>
                      {options.length === 0 ? (
                        <Text className="mt-2">This server reports no permission catalog.</Text>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {options.map((permission) => {
                            const selected = draftPermissions.includes(permission)
                            return (
                              <RoleToggleChip
                                key={permission}
                                name={permission}
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

      <PreferencesSegment>
        <Title>Groups</Title>
        <Text>
          Groups confer a set of roles on every member. A user&apos;s effective permissions are the union of their own
          roles and the roles granted by their groups. Users in no groups behave exactly as before.
        </Text>

      {/* Create-group form: name + description + Create on one aligned row,
          with an optional role picker underneath so a group can be born with
          its conferred roles. */}
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
        {availableRoles.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <Text className="mr-1 text-xs text-passive-1">Confer roles:</Text>
            {availableRoles.map((roleName) => (
              <RoleToggleChip
                key={roleName}
                name={roleName}
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
            const pickerOptions = rolePickerOptions(availableRoles, group.roleNames)
            const isEditingRoles = editingRolesUuid === group.uuid
            const isShowingMembers = selectedGroupUuid === group.uuid
            return (
              <div key={group.uuid} className="rounded-md border border-border p-3">
                {/* Header: name + description + always-visible role chips on
                    the left, actions right-aligned. */}
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                  <div className="flex min-w-0 flex-grow flex-col">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <Subtitle>{group.name}</Subtitle>
                      {group.description && <Text className="text-passive-1">{group.description}</Text>}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {group.roleNames.length > 0 ? (
                        group.roleNames.map((roleName) => <RoleChip key={roleName} name={roleName} />)
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

                {/* Role picker: every role the server offers (plus any the
                    group already confers), current ones pre-selected. Each
                    toggle saves immediately via the set-group-roles endpoint. */}
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
                            <RoleToggleChip
                              key={roleName}
                              name={roleName}
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

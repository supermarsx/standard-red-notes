import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Switch from '@/Components/Switch/Switch'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import { ToastType, addToast } from '@standardnotes/toast'
import { confirmDialog } from '@standardnotes/ui-services'

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
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [selectedGroupUuid, setSelectedGroupUuid] = useState<string | null>(null)
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [newMemberUuid, setNewMemberUuid] = useState('')

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

  return (
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
                onClick={() => {
                  if (selectedGroupUuid === group.uuid) {
                    setSelectedGroupUuid(null)
                  } else {
                    void loadGroupMembers(group.uuid)
                  }
                }}
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
  )
}

export default AdminGroupsTab

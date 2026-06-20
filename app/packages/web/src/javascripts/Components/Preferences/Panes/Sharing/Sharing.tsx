import { observer } from 'mobx-react-lite'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ContentType,
  DecryptedItemInterface,
  InviteRecord,
  ProtocolVersion,
  SharedVaultInviteServerHash,
  SharedVaultListingInterface,
  SharedVaultUserServerHash,
  TrustedContactInterface,
  VaultInviteServiceEvent,
  VaultListingInterface,
  VaultUserServiceEvent,
  compareVersions,
  isClientDisplayableError,
} from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'
import { useApplication } from '@/Components/ApplicationProvider'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import PreferencesPane from '../../PreferencesComponents/PreferencesPane'
import Button from '@/Components/Button/Button'
import Icon from '@/Components/Icon/Icon'
import { PreferencesProps } from '../../PreferencesProps'
import {
  canLeaveVault,
  canRemoveMembers,
  deriveVaultRole,
  formatVaultRole,
  groupSharedItemsByType,
  SharedItemGroup,
  VaultRole,
} from './sharingSummary'

type SharedVaultOverview = {
  vault: SharedVaultListingInterface
  role: VaultRole
  members: SharedVaultUserServerHash[]
  itemGroups: SharedItemGroup[]
  outboundInvites: SharedVaultInviteServerHash[]
}

/** Best-effort display title for a shared item (note title, tag name...). */
function itemTitle(item: DecryptedItemInterface): string {
  const title = (item as { title?: string }).title
  return title && title.length > 0 ? title : 'Untitled'
}

type SharingPaneProps = Pick<PreferencesProps, 'application'>

const Sharing = observer(({ application }: SharingPaneProps) => {
  const hasAccount = application.hasAccount()
  const isSharedVaultsEnabled = application.featuresController.isEntitledToSharedVaults()

  const [overviews, setOverviews] = useState<SharedVaultOverview[]>([])
  const [incomingInvites, setIncomingInvites] = useState<InviteRecord[]>([])
  const [contactsByUuid, setContactsByUuid] = useState<Map<string, TrustedContactInterface>>(new Map())

  const selfUuid = application.sessions.getUser()?.uuid

  const nameForUser = useCallback(
    (userUuid: string): string => {
      if (userUuid === selfUuid) {
        return 'You'
      }
      return contactsByUuid.get(userUuid)?.name || userUuid
    },
    [contactsByUuid, selfUuid],
  )

  const refresh = useCallback(async () => {
    const contactMap = new Map<string, TrustedContactInterface>()
    for (const contact of application.contacts.getAllContacts()) {
      contactMap.set(contact.contactUuid, contact)
    }
    setContactsByUuid(contactMap)

    setIncomingInvites(application.vaultInvites.getCachedPendingInviteRecords())

    const sharedVaults = application.vaults
      .getVaults()
      .filter((vault): vault is SharedVaultListingInterface => vault.isSharedVaultListing())

    const allItems = application.items.items

    const built = await Promise.all(
      sharedVaults.map(async (vault) => {
        const members = (await application.vaultUsers.getSharedVaultUsersFromServer(vault)) || []
        const role = deriveVaultRole({
          isOwner: application.vaultUsers.isCurrentUserSharedVaultOwner(vault),
          isAdmin: application.vaultUsers.isCurrentUserSharedVaultAdmin(vault),
          isReadonly: application.vaultUsers.isCurrentUserReadonlyVaultMember(vault),
        })

        const vaultItems = allItems
          .filter((item) => item.key_system_identifier === vault.systemIdentifier)
          .map((item) => ({ uuid: item.uuid, content_type: item.content_type, title: itemTitle(item) }))

        // Outbound invites are only meaningful (and authorized) for an admin/owner.
        let outboundInvites: SharedVaultInviteServerHash[] = []
        if (canRemoveMembers(role)) {
          const result = await application.vaultInvites.getOutboundInvites(vault)
          if (!isClientDisplayableError(result)) {
            outboundInvites = result
          }
        }

        return {
          vault,
          role,
          members,
          itemGroups: groupSharedItemsByType(vaultItems),
          outboundInvites,
        }
      }),
    )

    setOverviews(built)
  }, [application.contacts, application.items, application.vaultInvites, application.vaultUsers, application.vaults])

  useEffect(() => {
    void application.vaultInvites.downloadInboundInvites().then(() => refresh())
  }, [application.vaultInvites, refresh])

  useEffect(() => {
    return application.vaultUsers.addEventObserver((event) => {
      if (event === VaultUserServiceEvent.UsersChanged) {
        void refresh()
      }
    })
  }, [application.vaultUsers, refresh])

  useEffect(() => {
    return application.vaultInvites.addEventObserver((event) => {
      if (event === VaultInviteServiceEvent.InvitesReloaded) {
        void refresh()
      }
    })
  }, [application.vaultInvites, refresh])

  useEffect(() => {
    return application.items.streamItems(
      [ContentType.TYPES.VaultListing, ContentType.TYPES.Note, ContentType.TYPES.Tag],
      () => {
        void refresh()
      },
    )
  }, [application.items, refresh])

  const acceptInvite = useCallback(
    async (record: InviteRecord) => {
      const result = await application.vaultInvites.acceptInvite(record)
      if (result.isFailed()) {
        await application.alerts.alert(result.getError())
      } else {
        addToast({ type: ToastType.Success, message: 'Invite accepted' })
        void refresh()
      }
    },
    [application.alerts, application.vaultInvites, refresh],
  )

  const declineInvite = useCallback(
    async (record: InviteRecord) => {
      if (!(await application.alerts.confirm('Decline this vault invite?'))) {
        return
      }
      const result = await application.vaultInvites.deleteInvite(record.invite)
      if (isClientDisplayableError(result)) {
        await application.alerts.alert(result.text)
      } else {
        addToast({ type: ToastType.Success, message: 'Invite declined' })
        void refresh()
      }
    },
    [application.alerts, application.vaultInvites, refresh],
  )

  const cancelOutboundInvite = useCallback(
    async (invite: SharedVaultInviteServerHash) => {
      if (!(await application.alerts.confirm('Cancel this pending invite?'))) {
        return
      }
      const result = await application.vaultInvites.deleteInvite(invite)
      if (isClientDisplayableError(result)) {
        await application.alerts.alert(result.text)
      } else {
        addToast({ type: ToastType.Success, message: 'Invite cancelled' })
        void refresh()
      }
    },
    [application.alerts, application.vaultInvites, refresh],
  )

  const removeMember = useCallback(
    async (vault: SharedVaultListingInterface, member: SharedVaultUserServerHash) => {
      if (!(await application.alerts.confirm(`Remove ${nameForUser(member.user_uuid)} from this vault?`))) {
        return
      }
      const result = await application.vaultUsers.removeUserFromSharedVault(vault, member.user_uuid)
      if (result.isFailed()) {
        await application.alerts.alert(result.getError())
      } else {
        addToast({ type: ToastType.Success, message: 'Member removed' })
        void refresh()
      }
    },
    [application.alerts, application.vaultUsers, nameForUser, refresh],
  )

  const leaveVault = useCallback(
    async (vault: SharedVaultListingInterface) => {
      if (!(await application.alerts.confirm('Leave this shared vault? You will lose access to its items.'))) {
        return
      }
      const result = await application.vaultUsers.leaveSharedVault(vault)
      if (isClientDisplayableError(result)) {
        await application.alerts.alert(result.text)
      } else {
        addToast({ type: ToastType.Success, message: 'Left vault' })
        void refresh()
      }
    },
    [application.alerts, application.vaultUsers, refresh],
  )

  const openVaultsPane = useCallback(() => {
    application.preferencesController.openPreferences('vaults')
  }, [application.preferencesController])

  const totalSharedItems = useMemo(
    () => overviews.reduce((sum, overview) => sum + overview.itemGroups.reduce((s, g) => s + g.count, 0), 0),
    [overviews],
  )

  if (!hasAccount || !isSharedVaultsEnabled) {
    return (
      <PreferencesPane>
        <PreferencesGroup>
          <PreferencesSegment>
            <Title>Sharing</Title>
            <Subtitle>Shared vaults let you collaborate on notes with trusted contacts.</Subtitle>
            <Text className="mt-2">
              {hasAccount
                ? 'Shared vaults are not enabled for your plan.'
                : 'Sign in to an account to use shared vaults and collaboration.'}
            </Text>
          </PreferencesSegment>
        </PreferencesGroup>
      </PreferencesPane>
    )
  }

  return (
    <PreferencesPane>
      {/* Disclosure / honesty banner */}
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Sharing &amp; Collaboration</Title>
          <Subtitle>An overview of what you share and who you collaborate with.</Subtitle>
          <div className="mt-2.5 rounded border border-border bg-contrast p-3 text-sm">
            <div className="mb-1.5 flex items-center gap-2 font-semibold">
              <Icon type="info" size="small" />
              How collaboration works
            </div>
            <ul className="ml-4 list-disc space-y-1">
              <li>
                Notes in a shared vault support <strong>live, character-by-character co-editing</strong> with
                end-to-end encryption — edits appear in real time for everyone with the note open.
              </li>
              <li>
                Collaborative editing of <strong>folder, tag, and workspace metadata is not yet supported</strong> and
                is planned for a future update. Those still sync normally, just without live co-editing.
              </li>
              <li>
                Your server can see vault <strong>membership</strong> and <strong>when</strong> an encrypted edit
                happens (timing/relay metadata), but never the <strong>titles, contents, or cursors</strong> — those
                stay encrypted on your devices.
              </li>
            </ul>
          </div>
          <Button className="mt-3" label="Manage vaults, contacts & invites" onClick={openVaultsPane} />
        </PreferencesSegment>
      </PreferencesGroup>

      {/* What's shared — the lead, genuinely new visibility */}
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>What you're sharing</Title>
          <Subtitle>
            {totalSharedItems > 0
              ? `${totalSharedItems} item${totalSharedItems === 1 ? '' : 's'} across ${overviews.length} shared vault${
                  overviews.length === 1 ? '' : 's'
                }.`
              : 'Items you move into a shared vault appear here.'}
          </Subtitle>
          {overviews.length === 0 && (
            <Text className="mt-2">
              You aren't a member of any shared vaults yet. Create one or accept an invite to start collaborating.
            </Text>
          )}
          {overviews.map((overview) => (
            <div key={overview.vault.uuid} className="mt-3 rounded border border-border p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Icon type="safe-square" size="small" />
                <span className="font-semibold">{overview.vault.name}</span>
                <span className="rounded bg-info px-1.5 py-0.5 text-xs text-info-contrast">
                  {formatVaultRole(overview.role)}
                </span>
              </div>
              {overview.itemGroups.length === 0 ? (
                <Text className="text-passive-1">No items shared in this vault yet.</Text>
              ) : (
                <div className="space-y-2">
                  {overview.itemGroups.map((group) => (
                    <div key={group.contentType}>
                      <div className="text-xs font-semibold uppercase tracking-wide text-passive-0">
                        {group.label} ({group.count})
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {group.items.slice(0, 8).map((item) => (
                          <li key={item.uuid} className="truncate text-sm text-text">
                            {item.title || 'Untitled'}
                          </li>
                        ))}
                        {group.items.length > 8 && (
                          <li className="text-xs text-passive-1">+{group.items.length - 8} more…</li>
                        )}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </PreferencesSegment>
      </PreferencesGroup>

      {/* Incoming invites — natural to action on an overview */}
      {incomingInvites.length > 0 && (
        <PreferencesGroup>
          <PreferencesSegment>
            <Title>Pending invites for you</Title>
            <div className="mt-2 space-y-3">
              {incomingInvites.map((record) => {
                const meta = record.message.data.metadata
                const permission = application.vaultUsers.getFormattedMemberPermission(record.invite.permission)
                return (
                  <div key={record.invite.uuid} className="rounded border border-border p-3">
                    <div className="text-sm font-semibold">{meta.name}</div>
                    {meta.description && <div className="text-sm text-passive-1">{meta.description}</div>}
                    <div className="mt-1 text-xs text-passive-1">Permission: {permission}</div>
                    {record.trusted ? (
                      <div className="mt-2 flex gap-2">
                        <Button small label="Accept" onClick={() => acceptInvite(record)} />
                        <Button small label="Decline" onClick={() => declineInvite(record)} />
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-passive-1">
                        Sender isn't a trusted contact yet. Add them as a trusted contact from the Vaults pane to
                        accept.
                        <div className="mt-2">
                          <Button small label="Decline" onClick={() => declineInvite(record)} />
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </PreferencesSegment>
        </PreferencesGroup>
      )}

      {/* Per-vault collaborators + outbound invites + leave/remove */}
      {overviews.length > 0 && (
        <PreferencesGroup>
          <PreferencesSegment>
            <Title>Vaults &amp; collaborators</Title>
            <Subtitle>Who you're collaborating with. Full contact management lives in the Vaults pane.</Subtitle>
            <div className="mt-2 space-y-4">
              {overviews.map((overview) => (
                <div key={overview.vault.uuid} className="rounded border border-border p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{overview.vault.name}</span>
                      <span className="rounded bg-info px-1.5 py-0.5 text-xs text-info-contrast">
                        {formatVaultRole(overview.role)}
                      </span>
                    </div>
                    {canLeaveVault(overview.role) && (
                      <Button small colorStyle="danger" label="Leave" onClick={() => leaveVault(overview.vault)} />
                    )}
                  </div>

                  <div className="space-y-1.5">
                    {overview.members.map((member) => {
                      const isOwnerMember = application.vaultUsers.isVaultUserOwner(member)
                      const isSelf = member.user_uuid === selfUuid
                      return (
                        <div key={member.uuid} className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <Icon type="user" size="small" />
                            <span className="truncate text-sm">{nameForUser(member.user_uuid)}</span>
                            <span className="text-xs text-passive-1">
                              {application.vaultUsers.getFormattedMemberPermission(member.permission)}
                              {isOwnerMember ? ' · Owner' : ''}
                            </span>
                          </div>
                          {canRemoveMembers(overview.role) && !isOwnerMember && !isSelf && (
                            <Button small label="Remove" onClick={() => removeMember(overview.vault, member)} />
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {overview.outboundInvites.length > 0 && (
                    <div className="mt-2.5 border-t border-border pt-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-passive-0">
                        Pending invites sent
                      </div>
                      <div className="mt-1 space-y-1.5">
                        {overview.outboundInvites.map((invite) => (
                          <div key={invite.uuid} className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm text-passive-1">{nameForUser(invite.user_uuid)}</span>
                            <Button small label="Cancel" onClick={() => cancelOutboundInvite(invite)} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </PreferencesSegment>
        </PreferencesGroup>
      )}
    </PreferencesPane>
  )
})

const SharingWrapper = ({ application }: SharingPaneProps) => {
  const accountProtocolVersion = application.getUserVersion()
  const isAccountProtocolNotSupported =
    accountProtocolVersion && compareVersions(accountProtocolVersion, ProtocolVersion.V004) < 0

  if (application.hasAccount() && isAccountProtocolNotSupported) {
    return (
      <PreferencesPane>
        <PreferencesGroup>
          <PreferencesSegment>
            <Title>Account update required</Title>
            <Subtitle>To use sharing, update your account to the latest encryption version (from the Vaults pane).</Subtitle>
          </PreferencesSegment>
        </PreferencesGroup>
      </PreferencesPane>
    )
  }

  return <Sharing application={application} />
}

export default observer(SharingWrapper)

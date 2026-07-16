import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Spinner from '@/Components/Spinner/Spinner'
import {
  activeInviteLinkCount,
  buildCreateInviteBody,
  CreateInviteForm,
  emptyCreateInviteForm,
  formatInviteLinkDate,
  inviteLinkAbsoluteUrl,
  inviteLinkStatusChipClass,
  inviteLinkStatusLabel,
  inviteLinkUsesLabel,
  parseCreatedInviteLink,
  parseSelfServeInviteState,
  SelfServeInviteLinkView,
  SelfServeInviteState,
} from './inviteLinks'

type Props = {
  application: WebApplication
}

const originForInviteLinks = (): string => (typeof window !== 'undefined' ? window.location.origin : '')

/**
 * Standard Red Notes: user-facing SELF-SERVE Invite pane (t69 §7.5). A normal
 * user mints their OWN invite links, within the server's per-user quota
 * (`registration.invitesPerUser`; 0 = self-serve disabled, in which case this
 * pane is not registered in the menu). Shows the quota used/total + how many
 * people the user has invited, a create form (max uses / expiry / label — NO
 * role or domain fields, because a user link can never carry a privilege
 * override; the auth server enforces that guard), and the user's own active
 * links with revoke.
 *
 * The raw invite token is returned EXACTLY ONCE at creation — the list never
 * carries it — so the shareable URL + copy button appear only in the one-time
 * "just created" panel, not on the existing-links rows.
 */
const Invite: FunctionComponent<Props> = ({ application }: Props) => {
  const [state, setState] = useState<SelfServeInviteState>({ enabled: true, links: [], invitedCount: 0 })
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<CreateInviteForm>(emptyCreateInviteForm)
  const [creating, setCreating] = useState(false)
  const [revokingUuid, setRevokingUuid] = useState<string | undefined>(undefined)
  const [justCreatedUrl, setJustCreatedUrl] = useState<string | undefined>(undefined)

  const loadLinks = useCallback(async () => {
    setLoading(true)
    try {
      const response = await application.legacyApi.listMyInviteLinks()
      setState(parseSelfServeInviteState(response))
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }, [application])

  useEffect(() => {
    void loadLinks()
  }, [loadLinks])

  const activeCount = useMemo(() => activeInviteLinkCount(state.links), [state.links])
  const quota = state.invitesPerUser
  const quotaReached = quota !== undefined && activeCount >= quota

  const updateForm = useCallback((patch: Partial<CreateInviteForm>) => {
    setForm((prev) => ({ ...prev, ...patch }))
  }, [])

  const handleCreate = useCallback(async () => {
    const built = buildCreateInviteBody(form)
    if (!built.ok) {
      addToast({ type: ToastType.Error, message: built.error })
      return
    }

    setCreating(true)
    try {
      const response = await application.legacyApi.createMyInviteLink(built.value)
      const created = parseCreatedInviteLink(response)
      if (!created) {
        const data = (response as { data?: { error?: { message?: string } } }).data
        addToast({ type: ToastType.Error, message: data?.error?.message ?? 'Failed to create invite link.' })
        return
      }

      const url = inviteLinkAbsoluteUrl(originForInviteLinks(), created.path)
      setJustCreatedUrl(url)
      setForm(emptyCreateInviteForm())
      addToast({ type: ToastType.Success, message: 'Invite link created.' })
      await loadLinks()
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to create invite link.' })
    } finally {
      setCreating(false)
    }
  }, [application, form, loadLinks])

  const handleCopy = useCallback((url: string) => {
    navigator?.clipboard
      ?.writeText(url)
      .then(() => addToast({ type: ToastType.Success, message: 'Invite link copied to clipboard.' }))
      .catch((error) => {
        console.error(error)
        addToast({ type: ToastType.Error, message: "Couldn't copy to clipboard." })
      })
  }, [])

  const handleRevoke = useCallback(
    async (link: SelfServeInviteLinkView) => {
      const confirmed = await application.alerts.confirm(
        'Revoke this invite link? Anyone still holding it will no longer be able to sign up with it. This cannot be undone.',
        'Revoke invite link',
        'Revoke',
      )
      if (!confirmed) {
        return
      }

      setRevokingUuid(link.uuid)
      try {
        const response = await application.legacyApi.revokeMyInviteLink(link.uuid)
        const data = (response as { data?: { error?: { message?: string } }; error?: unknown }).data
        if (data?.error) {
          addToast({ type: ToastType.Error, message: data.error.message ?? 'Failed to revoke invite link.' })
          return
        }
        addToast({ type: ToastType.Success, message: 'Invite link revoked.' })
        await loadLinks()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to revoke invite link.' })
      } finally {
        setRevokingUuid(undefined)
      }
    },
    [application, loadLinks],
  )

  // Defensive: the pane is only registered in the menu when self-serve is enabled,
  // but a stale deep-link could still mount it. Show a plain message rather than an
  // empty pane if the server reports the feature off.
  if (!loading && !state.enabled) {
    return (
      <PreferencesPane>
        <PreferencesGroup>
          <PreferencesSegment>
            <Title>Invite friends</Title>
            <Text className="mt-2">Self-serve invites are not currently available on this server.</Text>
          </PreferencesSegment>
        </PreferencesGroup>
      </PreferencesPane>
    )
  }

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Invite friends</Title>
          <Text>
            Create your own invite links to bring people onto this server. Each link can allow one or more signups and
            can optionally expire. The full invite URL is shown once, right after you create it — copy it then, because
            it can’t be shown again.
          </Text>

          <HorizontalSeparator classes="my-4" />

          <Subtitle>Your invite quota</Subtitle>
          {quota !== undefined ? (
            <Text className="mt-1">
              Using <span className="font-bold">{activeCount}</span> of <span className="font-bold">{quota}</span>{' '}
              active invite link{quota === 1 ? '' : 's'}.{quotaReached ? ' Revoke one to create another.' : ''}
            </Text>
          ) : (
            <Text className="mt-1">
              You have <span className="font-bold">{activeCount}</span> active invite link{activeCount === 1 ? '' : 's'}
              .
            </Text>
          )}
          <Text className="text-passive-1 mt-1">
            You’ve invited <span className="font-bold">{state.invitedCount}</span> person
            {state.invitedCount === 1 ? '' : 's'} so far.
          </Text>
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Subtitle>Create an invite link</Subtitle>
          <Text className="mt-1">
            Choose how many people may use the link and, optionally, when it expires and a label to help you remember
            what it’s for.
          </Text>

          <div className="mt-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium lg:text-xs">Max uses</span>
              <input
                type="number"
                className="border-border bg-default w-32 rounded border px-2 py-1.5 text-sm"
                min={1}
                step={1}
                value={form.maxUses}
                aria-label="Maximum number of signups this link allows"
                onChange={(event) => updateForm({ maxUses: event.target.value })}
              />
              <span className="text-passive-1 text-xs">1 = single-use. Up to 100000.</span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium lg:text-xs">Expires in (hours)</span>
              <input
                type="number"
                className="border-border bg-default w-32 rounded border px-2 py-1.5 text-sm"
                min={1}
                step={1}
                value={form.expiresInHours}
                placeholder="Never"
                aria-label="Hours until this link expires (blank for never)"
                onChange={(event) => updateForm({ expiresInHours: event.target.value })}
              />
              <span className="text-passive-1 text-xs">Blank = never expires. Up to 8760 (1 year).</span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium lg:text-xs">Label (optional)</span>
              <input
                type="text"
                className="border-border bg-default w-full max-w-sm rounded border px-2 py-1.5 text-sm"
                value={form.label}
                placeholder="e.g. For my study group"
                aria-label="An optional label to remember this link"
                onChange={(event) => updateForm({ label: event.target.value })}
              />
            </label>
          </div>

          <Button
            className="mt-3"
            label={creating ? 'Creating…' : 'Create invite link'}
            primary
            disabled={creating || quotaReached}
            disabledReason={
              quotaReached ? 'You’ve reached your invite-link quota. Revoke one to create another.' : undefined
            }
            onClick={handleCreate}
          />

          {justCreatedUrl && (
            <div className="border-info bg-info-faded mt-3 rounded border border-solid p-3">
              <Text className="font-semibold">Your invite link is ready — copy it now.</Text>
              <Text className="text-passive-1 mt-1">
                This is the only time the full link is shown. If you lose it, revoke it and create a new one.
              </Text>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <code
                  className="bg-passive-4 min-w-0 flex-1 truncate rounded px-2 py-1.5 text-xs"
                  title={justCreatedUrl}
                >
                  {justCreatedUrl}
                </code>
                <Button className="flex-shrink-0" label="Copy link" small onClick={() => handleCopy(justCreatedUrl)} />
              </div>
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>

      <PreferencesGroup>
        <PreferencesSegment>
          <Subtitle>Your invite links</Subtitle>
          {loading && <Spinner className="mt-2 h-4 w-4" />}
          {!loading && state.links.length === 0 && (
            <Text className="mt-2">You haven’t created any invite links yet.</Text>
          )}
          {!loading && state.links.length > 0 && (
            <div className="divide-border mt-2 flex flex-col divide-y">
              {state.links.map((link) => (
                <div key={link.uuid} className="flex items-center justify-between gap-3 py-2">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium lg:text-xs" title={link.label ?? undefined}>
                      {link.label && link.label.trim() !== '' ? link.label : 'Invite link'}
                    </span>
                    <span className="text-passive-1 truncate text-xs">
                      Uses {inviteLinkUsesLabel(link.usedCount, link.maxUses)} · Created{' '}
                      {formatInviteLinkDate(link.createdAt)} · Expires {formatInviteLinkDate(link.expiresAt, 'Never')}
                    </span>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${inviteLinkStatusChipClass(link.status)}`}
                    >
                      {inviteLinkStatusLabel(link.status)}
                    </span>
                    {link.status === 'active' && (
                      <Button
                        label="Revoke"
                        small
                        disabled={revokingUuid === link.uuid}
                        onClick={() => handleRevoke(link)}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </PreferencesSegment>
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(Invite)

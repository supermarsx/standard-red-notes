import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { isErrorResponse } from '@standardnotes/snjs'
import { SNWebCrypto } from '@standardnotes/sncrypto-web'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Checkbox from '@/Components/Checkbox/Checkbox'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import CopyButton from '../TwoFactorAuth/CopyButton'

import { wrapItemsKeys, WrappableItemsKey } from './wrapKeys'

type Props = {
  application: WebApplication
}

type McpToken = {
  uuid: string
  label: string
  scope: string
  scopeTagUuids: string[] | null
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

type McpTokenScope = 'read-only' | 'read-write'

const formatDate = (value: string | null): string => {
  if (!value) {
    return 'Never'
  }
  const date = new Date(value)
  return isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

const McpTokens: FunctionComponent<Props> = ({ application }: Props) => {
  const [mcpTokens, setMcpTokens] = useState<McpToken[]>([])
  const [loading, setLoading] = useState(false)
  const [label, setLabel] = useState('')
  const [scope, setScope] = useState<McpTokenScope>('read-only')
  const [scopeTagUuids, setScopeTagUuids] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [createdToken, setCreatedToken] = useState<string | null>(null)

  const tags = useMemo(() => application.items.getDisplayableTags(), [application])

  const loadMcpTokens = useCallback(async () => {
    setLoading(true)
    try {
      const response = await application.legacyApi.listMcpTokens()
      if (!isErrorResponse(response)) {
        const data = (response as { data?: { mcpTokens?: McpToken[] } }).data
        setMcpTokens(data?.mcpTokens ?? [])
      }
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }, [application])

  useEffect(() => {
    void loadMcpTokens()
  }, [loadMcpTokens])

  const toggleTag = useCallback((tagUuid: string) => {
    setScopeTagUuids((current) =>
      current.includes(tagUuid) ? current.filter((uuid) => uuid !== tagUuid) : [...current, tagUuid],
    )
  }, [])

  const handleCreate = useCallback(async () => {
    const trimmed = label.trim()
    if (trimmed.length === 0) {
      addToast({ type: ToastType.Error, message: 'Please enter a label for the MCP token.' })
      return
    }

    setCreating(true)
    try {
      const itemsKeys: WrappableItemsKey[] = application.items.getDisplayableItemsKeys().map((key) => ({
        uuid: key.uuid,
        itemsKey: key.itemsKey,
        version: key.keyVersion,
      }))

      if (itemsKeys.length === 0) {
        addToast({
          type: ToastType.Error,
          message: 'No encryption keys are available on this account, so a usable MCP token cannot be created.',
        })
        return
      }

      const crypto = new SNWebCrypto()
      await crypto.initialize()
      let wrapped
      try {
        wrapped = await wrapItemsKeys(itemsKeys, crypto)
      } finally {
        crypto.deinit()
      }

      const response = await application.legacyApi.createMcpToken({
        label: trimmed,
        scope,
        scopeTagUuids: scopeTagUuids.length > 0 ? scopeTagUuids : undefined,
        wrappedKeys: wrapped.wrappedKeys,
        kdfSalt: wrapped.kdfSalt,
        kdfParams: wrapped.kdfParams,
      })

      if (isErrorResponse(response)) {
        const data = response.data as { error?: { message?: string } } | undefined
        addToast({ type: ToastType.Error, message: data?.error?.message ?? 'Failed to create MCP token.' })
        return
      }

      const data = (response as { data?: { token?: string } }).data
      const serverToken = data?.token
      if (!serverToken) {
        addToast({ type: ToastType.Error, message: 'The server did not return a token.' })
        return
      }

      // The full token is the server token plus the client-only wrap secret.
      // It is never logged and never persisted; it is shown to the user once.
      const fullToken = serverToken + '.' + wrapped.wrapSecret
      setCreatedToken(fullToken)
      setLabel('')
      setScope('read-only')
      setScopeTagUuids([])
      await loadMcpTokens()
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to create MCP token.' })
    } finally {
      setCreating(false)
    }
  }, [application, label, scope, scopeTagUuids, loadMcpTokens])

  const handleDelete = useCallback(
    async (mcpTokenId: string) => {
      const confirmed = await application.alerts.confirm(
        'Are you sure you want to revoke this MCP token? The MCP bridge using it will immediately lose access.',
        'Revoke MCP Token',
        'Revoke',
      )
      if (!confirmed) {
        return
      }

      try {
        const response = await application.legacyApi.deleteMcpToken(mcpTokenId)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to revoke MCP token.' })
          return
        }
        await loadMcpTokens()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to revoke MCP token.' })
      }
    },
    [application, loadMcpTokens],
  )

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>MCP Tokens</Title>
        <Text>
          MCP tokens let the headless MCP bridge access your notes without your account email and password. Your notes
          stay end-to-end encrypted: when you create a token, this browser wraps your account's encryption keys under a
          secret that is appended to the token and never sent to the server. The server only ever stores ciphertext.
        </Text>
        <Text className="mt-2">
          The full token is shown once at creation and never again. Revoke a token to immediately cut off the bridge
          using it.
        </Text>

        <div className="mt-4 rounded border border-solid border-warning bg-warning-faded p-3">
          <Subtitle className="text-warning">The full token can decrypt and read your notes</Subtitle>
          <Text className="mt-1">
            This token grants the MCP bridge programmatic, decrypting access to your notes within the scope you choose
            (read-only or read-write, optionally limited to selected tags). Because the full token carries the wrapped
            key material needed to decrypt your content, anyone who obtains it can read your notes — not just the bridge
            you intended. Keep the full token secret, and revoke it immediately if it is leaked or no longer needed.
          </Text>
        </div>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <Subtitle>Create a new MCP token</Subtitle>
        <div className="mt-2 flex flex-col gap-2">
          <DecoratedInput
            placeholder="Label (e.g. MCP Bridge)"
            value={label}
            onChange={(value) => setLabel(value)}
            disabled={creating}
          />

          <div className="mt-1 flex flex-col">
            <Subtitle>Scope</Subtitle>
            <label className="mt-1 flex items-center text-sm">
              <input
                className="mr-2"
                type="radio"
                name="mcp-token-scope"
                checked={scope === 'read-only'}
                onChange={() => setScope('read-only')}
                disabled={creating}
              />
              Read-only
            </label>
            <label className="flex items-center text-sm">
              <input
                className="mr-2"
                type="radio"
                name="mcp-token-scope"
                checked={scope === 'read-write'}
                onChange={() => setScope('read-write')}
                disabled={creating}
              />
              Read-write
            </label>
          </div>

          <div className="mt-1 flex flex-col">
            <Subtitle>Limit to tags (optional)</Subtitle>
            <Text className="mb-2">Leave all unchecked to grant access to all notes.</Text>
            {tags.length === 0 && <Text>You have no tags.</Text>}
            {tags.map((tag) => (
              <Checkbox
                key={tag.uuid}
                name={`mcp-token-tag-${tag.uuid}`}
                label={tag.title}
                checked={scopeTagUuids.includes(tag.uuid)}
                onChange={() => toggleTag(tag.uuid)}
                disabled={creating}
              />
            ))}
          </div>

          <div>
            <Button label="Create" primary disabled={creating} onClick={handleCreate} />
          </div>
        </div>

        {createdToken && (
          <div className="mt-3 rounded border border-solid border-border p-3">
            <Subtitle>Copy your new MCP token now</Subtitle>
            <Text className="mb-2">
              Copy now — it grants decrypting access and won't be shown again. Set it as STANDARD_RED_NOTES_MCP_TOKEN in
              the MCP bridge.
            </Text>
            <div className="flex flex-row items-center gap-2">
              <code className="select-text break-all rounded bg-contrast px-2 py-1 text-sm">{createdToken}</code>
              <CopyButton copyValue={createdToken} />
            </div>
            <Button className="mt-3" label="Done" onClick={() => setCreatedToken(null)} />
          </div>
        )}
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />

      <PreferencesSegment>
        <Subtitle>Your MCP tokens</Subtitle>
        {loading && <Spinner className="mt-2 h-4 w-4" />}
        {!loading && mcpTokens.length === 0 && <Text className="mt-2">You have no MCP tokens.</Text>}
        {!loading &&
          mcpTokens.map((mcpToken) => (
            <div
              key={mcpToken.uuid}
              className="mt-2 flex flex-col gap-2 rounded border border-solid border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col">
                <span className="break-words text-base font-medium lg:text-sm">{mcpToken.label}</span>
                <span className="break-words text-sm text-passive-0 lg:text-xs">
                  {mcpToken.scope} ·{' '}
                  {mcpToken.scopeTagUuids && mcpToken.scopeTagUuids.length > 0
                    ? `${mcpToken.scopeTagUuids.length} tag(s)`
                    : 'all notes'}
                </span>
                <span className="break-words text-sm text-passive-0 lg:text-xs">
                  Created {formatDate(mcpToken.createdAt)} · Last used {formatDate(mcpToken.lastUsedAt)}
                </span>
              </div>
              <Button className="flex-shrink-0" label="Revoke" onClick={() => handleDelete(mcpToken.uuid)} />
            </div>
          ))}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(McpTokens)

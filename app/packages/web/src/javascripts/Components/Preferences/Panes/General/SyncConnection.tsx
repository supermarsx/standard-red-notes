import { WebApplication } from '@/Application/WebApplication'
import { useCallback, useEffect, useState } from 'react'
import { Subtitle, Text, Title } from '../../PreferencesComponents/Content'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import { describeTransport, type TransportStatusInput } from '../Admin/syncDiagnostics'

type Props = {
  application: WebApplication
}

/**
 * Standard Red Notes (t99): "which transport carries my saves", for a NON-ADMIN.
 *
 * The websocket sync lane degrades to HTTP silently and by design — a gateway
 * that binds no durable command port withholds SYNC_ITEMS, every other
 * capability negotiates, and the socket stays open and healthy. Until now the
 * only readout of that decision was `syncTransportStatus`, rendered exclusively
 * in the admin-gated Diagnostics tab (the Admin pane is not even in the menu
 * without the ADMIN_USER role). So the person whose saves were affected was
 * precisely the person who could not find out — which is how an ordinary
 * configuration difference became a user pasting network logs asking why every
 * keystroke pause costs a POST.
 *
 * This is deliberately a READOUT, not a control: there is nothing here to
 * configure, and the transport is chosen per connection by capability
 * negotiation rather than by preference. It reuses `describeTransport` — the
 * same verdict the admin panel renders — so the two can never disagree about
 * what a state means.
 */
const SyncConnection = ({ application }: Props) => {
  const [status, setStatus] = useState<TransportStatusInput | undefined>(undefined)

  const read = useCallback(() => {
    const live = application.syncTransportStatus
    setStatus(live ? { ...live, operations: [...live.operations] } : undefined)
  }, [application])

  // Read live rather than at mount: the question is "what am I on RIGHT NOW",
  // and a value captured once is wrong within seconds of a reconnect. Same
  // cadence as the admin panel.
  useEffect(() => {
    read()
    const timer = setInterval(read, 2000)
    return () => clearInterval(timer)
  }, [read])

  const verdict = describeTransport(status)
  const carriesSync = status?.operations.includes('SYNC_ITEMS') === true

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title className="mb-1">Sync connection</Title>
        <Subtitle className="mb-2">{verdict.label}</Subtitle>
        <Text className="mb-2">{verdict.detail}</Text>
        <Text>
          {carriesSync
            ? 'Note syncing is running over the websocket.'
            : 'Note syncing is running over HTTP requests, which is fully supported — each save is one request.'}
        </Text>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default SyncConnection

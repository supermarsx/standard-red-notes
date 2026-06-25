import { useCallback, useEffect, useMemo, useState } from 'react'
import { ServerType } from './ServerType'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Icon from '@/Components/Icon/Icon'
import { useApplication } from '@/Components/ApplicationProvider'
import { isDesktopApplication } from '@/Utils'
import RadioButtonGroup from '@/Components/RadioButtonGroup/RadioButtonGroup'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'

type Props = {
  className?: string
}

const ServerPicker = ({ className }: Props) => {
  const application = useApplication()
  const { t } = useTranslation('auth')

  const [currentType, setCurrentType] = useState<ServerType>('standard')

  const { server, setServer } = application.accountMenuController

  const determineServerType = useCallback(async () => {
    const homeServerUrl = await application.homeServer?.getHomeServerUrl()
    if (homeServerUrl && server === homeServerUrl) {
      setCurrentType('home server')
    } else if (server === window.defaultSyncServer) {
      setCurrentType('standard')
    } else {
      setCurrentType('custom')
    }
  }, [application.homeServer, server])

  const handleSyncServerChange = useCallback(
    (server: string, websocketUrl?: string) => {
      setServer(server)
      void determineServerType()
      application.setCustomHost(server, websocketUrl).catch(console.error)
    },
    [application, setServer, determineServerType],
  )

  useEffect(() => {
    void determineServerType()
  }, [application, server, determineServerType])

  const selectTab = async (type: ServerType) => {
    setCurrentType(type)
    if (type === 'standard') {
      // The default sync server is whatever the app was loaded with
      // (window.defaultSyncServer / window.websocketUrl) — same-origin by
      // default, overridable via the SYNC_SERVER env var. NOT the hosted
      // api.standardnotes.com.
      handleSyncServerChange(window.defaultSyncServer, window.websocketUrl)
    } else if (type === 'home server') {
      if (!application.homeServer) {
        application.alerts
          .alert(t('homeServerNotRunning'))
          .catch(console.error)

        return
      }

      const homeServerUrl = await application.homeServer.getHomeServerUrl()
      if (!homeServerUrl) {
        application.alerts
          .alert(t('homeServerNotRunning'))
          .catch(console.error)

        return
      }

      handleSyncServerChange(homeServerUrl)
    }
  }

  const options = useMemo(
    () =>
      [
        { label: t('serverDefault'), value: 'standard' },
        { label: t('serverCustom'), value: 'custom' },
      ].concat(isDesktopApplication() ? [{ label: t('serverHomeServer'), value: 'home server' }] : []) as {
        label: string
        value: ServerType
      }[],
    [t],
  )

  return (
    <div className={`flex h-full flex-grow flex-col px-3 pb-1.5 ${className}`}>
      <div className="mb-2 flex font-bold">{t('syncServer')}</div>
      <RadioButtonGroup value={currentType} items={options} onChange={selectTab} />
      {currentType === 'custom' && (
        <DecoratedInput
          className={{
            container: 'mt-1',
          }}
          type="text"
          left={[<Icon type="server" className="text-neutral" />]}
          placeholder={window.defaultSyncServer}
          value={server}
          onChange={handleSyncServerChange}
        />
      )}
    </div>
  )
}

// observer: the custom-server input is bound to the observable
// accountMenuController.server, so the component must re-render on each
// keystroke — without this the controlled input appears frozen ("can't type").
export default observer(ServerPicker)

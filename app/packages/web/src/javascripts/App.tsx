'use strict'

declare global {
  interface Window {
    dashboardUrl?: string
    defaultSyncServer: string
    devAccountEmail?: string
    devAccountPassword?: string
    devAccountServer?: string
    enabledUnfinishedFeatures: boolean
    /**
     * Server-exposed enable flag for the BROWSER PDF OCR action. Files are
     * end-to-end encrypted so this (default) OCR path runs in the browser; this
     * global only gates whether the client OFFERS it. Injected from the operator's
     * OCR_ENABLED env (see app Docker entrypoint / docker-compose).
     *
     * NOTE: the OPT-IN SERVER OCR path (which uploads decrypted page images and
     * thus leaves end-to-end encryption) is NOT a window flag — its availability
     * is per-user (admin-managed) and is fetched at runtime from the authenticated
     * /v1/ocr/config endpoint. See pdfOcr.ts / PdfPreview.tsx.
     */
    ocrEnabled?: boolean
    /** Default tesseract language (e.g. "eng"). From OCR_DEFAULT_LANGUAGE env. */
    ocrDefaultLanguage?: string
    plansUrl?: string
    purchaseUrl?: string
    startApplication?: StartApplication
    websocketUrl: string
    electronAppVersion?: string
    webClient?: DesktopManagerInterface
    electronRemoteBridge?: unknown
    reactNativeDevice?: WebDevice
    ReactNativeWebView?: {
      postMessage: (message: string) => void
    }
    platform?: Platform
    isClipper?: boolean

    application?: WebApplication
    mainApplicationGroup?: WebApplicationGroup
    MSStream?: unknown
  }
}

import { lazy, Suspense } from 'react'
import { disableIosTextFieldZoom, getPlatform } from '@/Utils'
import { IsWebPlatform, WebAppVersion } from '@/Constants/Version'
import { DesktopManagerInterface, Environment, Platform, SNLog } from '@standardnotes/snjs'
import { WebDevice } from './Application/Device/WebDevice'
import type { StartApplication } from './Application/Device/StartApplication'
import type { WebApplicationGroup } from './Application/WebApplicationGroup'
import type { WebOrDesktopDevice } from './Application/Device/WebOrDesktopDevice'
import type { WebApplication } from './Application/WebApplication'
import { createRoot, Root } from 'react-dom/client'
import { ElementIds } from './Constants/ElementIDs'
import { setDefaultMonospaceFont } from './setDefaultMonospaceFont'
import { RouteParser, RouteType } from '@standardnotes/ui-services'
import U2FAuthIframe from './Components/U2FAuthIframe/U2FAuthIframe'

/*
 * Standard Red Notes: the four screens this entry can mount are DYNAMIC
 * imports, so webpack emits one chunk each instead of folding all of them into
 * the single `app.js` that `index.html` loads.
 *
 * The share route is why. A share link is PUBLIC and unauthenticated, and with
 * a static import of `ApplicationGroupView` the reader of a shared note
 * downloaded the entire authenticated application — every editor, every
 * preferences pane, the vault and account UI — before a single word of the
 * note appeared. Measured on a production build of this tree: `app.js` was
 * 11 335 189 bytes, all of it eagerly loaded on the share route.
 *
 * `WebApplication`, `WebApplicationGroup`, `WebOrDesktopDevice` and
 * `StartApplication` are used here only in type positions (the `declare global`
 * block above and this function's signature), so they are `import type` and
 * contribute no runtime graph at all.
 */
const ApplicationGroupView = lazy(() => import('./Components/ApplicationGroupView/ApplicationGroupView'))
const SharedView = lazy(() => import('./Components/SharedView/SharedView'))
const EmailConfirmationView = lazy(() => import('./Components/EmailConfirmationView/EmailConfirmationView'))

let keyCount = 0
const getKey = () => {
  return keyCount++
}

const startApplication: StartApplication = async function startApplication(
  defaultSyncServerHost: string,
  device: WebOrDesktopDevice,
  enableUnfinishedFeatures: boolean,
  webSocketUrl: string,
) {
  // eslint-disable-next-line no-console
  SNLog.onLog = console.log
  SNLog.onError = console.error
  let root: Root

  const onDestroy = () => {
    const rootElement = document.getElementById(ElementIds.RootId) as HTMLElement
    root.unmount()
    rootElement.remove()
    renderApp()
  }

  const renderApp = () => {
    const rootElement = document.createElement('div')
    rootElement.id = ElementIds.RootId
    rootElement.className = 'h-full'
    const appendedRootNode = document.body.appendChild(rootElement)
    root = createRoot(appendedRootNode)

    disableIosTextFieldZoom()

    setDefaultMonospaceFont(device.platform)

    const route = new RouteParser(window.location.href)

    if (route.type === RouteType.AppViewRoute && route.appViewRouteParam === 'u2f') {
      root.render(<U2FAuthIframe />)
      return
    }

    // Standard Red Notes: public, unauthenticated read-only share viewer. It must
    // render with NO WebApplication/session, so we early-return before the authed
    // ApplicationGroupView, mirroring the U2F standalone-screen branch above.
    if (route.type === RouteType.Shared) {
      root.render(
        <Suspense fallback={null}>
          <SharedView shareId={route.sharedParams.shareId} />
        </Suspense>,
      )
      return
    }

    // Standard Red Notes: public, unauthenticated email-confirmation landing. Like
    // the share viewer it renders with NO WebApplication/session, so we early-return
    // before the authed ApplicationGroupView.
    if (route.type === RouteType.EmailConfirmation) {
      root.render(
        <Suspense fallback={null}>
          <EmailConfirmationView token={route.emailConfirmationParams.token} />
        </Suspense>,
      )
      return
    }

    root.render(
      <Suspense fallback={null}>
        <ApplicationGroupView
          key={getKey()}
          server={defaultSyncServerHost}
          device={device}
          enableUnfinished={enableUnfinishedFeatures}
          websocketUrl={webSocketUrl}
          onDestroy={onDestroy}
        />
      </Suspense>,
    )

    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage('appLoaded')
    }
  }

  const domReady = document.readyState === 'complete' || document.readyState === 'interactive'

  if (domReady) {
    renderApp()
  } else {
    window.addEventListener('DOMContentLoaded', function callback() {
      renderApp()

      window.removeEventListener('DOMContentLoaded', callback)
    })
  }
}

if (IsWebPlatform) {
  const ReactNativeWebViewInitializationTimeout = 0

  setTimeout(() => {
    const device = window.reactNativeDevice || new WebDevice(WebAppVersion)
    if (window.isClipper) {
      device.environment = Environment.Clipper
    }
    window.platform = getPlatform(device)

    startApplication(window.defaultSyncServer, device, window.enabledUnfinishedFeatures, window.websocketUrl).catch(
      console.error,
    )
  }, ReactNativeWebViewInitializationTimeout)
} else {
  window.startApplication = startApplication
}

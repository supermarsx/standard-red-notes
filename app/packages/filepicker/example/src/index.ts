import { SNApplication, Environment, Platform, SNLog, AlertService, ApiVersion } from '../../../snjs'
import WebDeviceInterface from './web_device_interface'
import { SNWebCrypto } from '../../../sncrypto-web'
import { ClassicFileApi } from './classic_file_api'
import { FileSystemApi } from './file_system_api'

SNLog.onLog = console.log
SNLog.onError = console.error

class BrowserAlerts extends AlertService {
  async confirm(text: string): Promise<boolean> {
    return window.confirm(text)
  }

  async confirmV2(dto: Parameters<AlertService['confirmV2']>[0]): Promise<boolean> {
    return this.confirm(dto.text)
  }

  async alert(text: string): Promise<void> {
    window.alert(text)
  }

  async alertV2(dto: Parameters<AlertService['alertV2']>[0]): Promise<void> {
    return this.alert(dto.text)
  }

  blockingDialog(text: string): () => void {
    window.alert(text)
    return () => undefined
  }
}

/**
 * Important:
 * If reusing e2e docker servers, you must edit docker/auth.env ACCESS_TOKEN_AGE
 * and REFRESH_TOKEN_AGE and increase their ttl.
 */

const host = 'http://localhost:3123'
const mocksHost = 'http://localhost:3124'

const application = new SNApplication({
  environment: Environment.Web,
  platform: Platform.MacWeb,
  deviceInterface: new WebDeviceInterface(),
  crypto: new SNWebCrypto(),
  alertService: new BrowserAlerts(),
  identifier: crypto.randomUUID(),
  defaultHost: host,
  appVersion: '1.0.0',
  apiVersion: ApiVersion.v1,
})

console.log('Created demo application')

export async function publishMockedEvent(eventType: string, eventPayload: unknown): Promise<void> {
  await fetch(`${mocksHost}/events`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      eventType,
      eventPayload,
    }),
  })
}

const run = async () => {
  console.log('Preparing for launch...')
  await application.prepareForLaunch({
    receiveChallenge: () => {
      console.warn('Ignoring challenge')
    },
  })
  await application.launch()
  console.log('Application launched...')

  const email = `filepicker-${crypto.randomUUID()}@example.test`
  const password = crypto.randomUUID()

  console.log('Registering account...')
  await application.register(email, password, '')
  console.log('Registered demo account. Be sure to edit docker/auth.env to increase session TTL.')

  console.log('Creating mock subscription...')
  await publishMockedEvent('SUBSCRIPTION_PURCHASED', {
    userEmail: email,
    subscriptionId: 1,
    subscriptionName: 'PLUS_PLAN',
    subscriptionExpiresAt: (new Date().getTime() + 3_600_000) * 1_000,
    timestamp: Date.now(),
    offline: false,
  })
  console.log('Successfully created mock subscription...')

  new ClassicFileApi(application)
  new FileSystemApi(application)
}

void run()

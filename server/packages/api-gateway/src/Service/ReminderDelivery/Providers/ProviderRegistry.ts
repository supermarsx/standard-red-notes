import { DeliveryChannel, ReminderDeliveryProvider } from '../Types'

/**
 * Standard Red Notes: selects the delivery adapter for a channel.
 *
 * Built once at container wiring time from the three concrete adapters. Every
 * adapter is constructed regardless of whether its credentials are present —
 * an unconfigured adapter simply NO-OPs when asked to send, so selection never
 * needs to know about configuration. `get` returns undefined for an unknown
 * channel (fail-closed: the scheduler skips it).
 */
export class ProviderRegistry {
  private readonly byChannel: Map<DeliveryChannel, ReminderDeliveryProvider>

  constructor(providers: ReminderDeliveryProvider[]) {
    this.byChannel = new Map(providers.map((provider) => [provider.channel, provider]))
  }

  get(channel: DeliveryChannel): ReminderDeliveryProvider | undefined {
    return this.byChannel.get(channel)
  }

  channels(): DeliveryChannel[] {
    return Array.from(this.byChannel.keys())
  }
}

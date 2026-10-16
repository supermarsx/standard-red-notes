import { addToast, ToastType } from '@standardnotes/toast'

/** Coalesce one outage across SDK calls, socket RPC and raw app-server fetches. */
export class ServerAvailabilityAlert {
  private lastToastAt = -Infinity
  constructor(private readonly now: () => number = Date.now) {}
  observeStatus(status: number): void {
    if (status !== 502 || this.now() - this.lastToastAt < 30_000) {
      return
    }
    this.lastToastAt = this.now()
    addToast({
      type: ToastType.Error,
      message: 'The app may be offline or restarting (HTTP 502). Please try again shortly.',
    })
  }
}

export async function fetchWithServerAvailability(
  alert: ServerAvailabilityAlert | undefined,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init)
  alert?.observeStatus(response.status)
  return response
}

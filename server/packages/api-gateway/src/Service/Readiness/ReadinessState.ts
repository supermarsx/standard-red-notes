/**
 * Mutable startup/shutdown gate shared with the home-server HTTP controller.
 * Dependency checks alone are not enough while the listener is up but the
 * in-process scheduler and signal lifecycle have not yet been adopted.
 */
export class ReadinessState {
  constructor(private ready = false) {}

  markReady(): void {
    this.ready = true
  }

  markUnavailable(): void {
    this.ready = false
  }

  isReady(): boolean {
    return this.ready
  }
}

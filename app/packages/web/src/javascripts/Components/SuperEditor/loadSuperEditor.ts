// Share a requested editor chunk between controller preparation and React.lazy.
// This loads code only; note hydration and authorization remain in their existing paths.
let pending: Promise<typeof import('./SuperEditorLazy')> | undefined

export function loadSuperEditor(): Promise<typeof import('./SuperEditorLazy')> {
  if (!pending) {
    pending = import('./SuperEditorLazy').catch((error: unknown) => {
      pending = undefined
      throw error
    })
  }
  return pending
}

export function preloadSuperEditor(): void {
  // A failed speculative import must neither reject the open nor poison lazy retry.
  void loadSuperEditor().catch(() => undefined)
}

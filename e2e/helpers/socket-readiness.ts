import type { Page } from "@playwright/test";

/** Socket readiness is worker state, independent of whether a tab is painting. */
export async function waitForSocketReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const app = (window as any).mainApplicationGroup?.primaryApplication;
      return app?._webSocketSyncTransport?.transportStatus?.state === "READY";
    },
    undefined,
    // Background tabs can suspend animation frames while their workers connect.
    // Keep the same readiness condition and deadline without depending on rAF.
    { timeout: 20_000, polling: 100 },
  );
}

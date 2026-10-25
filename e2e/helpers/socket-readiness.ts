import { expect, type Page } from "@playwright/test";

/** Socket readiness is worker state, independent of whether a tab is painting. */
export async function waitForSocketReady(page: Page): Promise<void> {
  // Poll from the test runner, not a timer inside the background tab. Chromium
  // can throttle page timers even while a dedicated worker negotiates READY.
  // Each observation still reads the real transport; no foregrounding or mocks.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const app = (window as any).mainApplicationGroup?.primaryApplication;
          const status = app?.syncTransportStatus;
          return status?.state === "READY"
            ? "READY"
            : `${status?.state ?? "NO_TRANSPORT"}:${status?.fallbackReason ?? "none"}:${document.visibilityState}`;
        }),
      {
        timeout: 20_000,
        intervals: [100],
        message: "This tab must establish its own ready socket transport",
      },
    )
    .toBe("READY");
}

import { test, expect } from "@playwright/test";
import { waitForSocketReady } from "../helpers/socket-readiness";

test("socket readiness observes worker progress while animation frames are suspended", async ({
  page,
}) => {
  await page.goto("about:blank");
  await page.evaluate(() => {
    // Model a background tab: callbacks on the paint clock are suspended, but
    // worker messages and timers can still update transport state.
    window.requestAnimationFrame = () => 0;
    (window as any).resetTransport = () => {
      let state = "CONNECTING";
      let started = false;
      (window as any).mainApplicationGroup = {
        primaryApplication: {
          // Match the public application facade used by the readiness helper.
          get syncTransportStatus() {
            return this._webSocketSyncTransport.transportStatus;
          },
          _webSocketSyncTransport: {
            get transportStatus() {
              if (!started) {
                started = true;
                setTimeout(() => {
                  state = "READY";
                }, 100);
              }
              return { state };
            },
          },
        },
      };
    };
    (window as any).resetTransport();
  });

  // Characterize the old polling mechanism, including READY arriving after its
  // initial synchronous check. The assertion itself must never depend on paint.
  await expect(
    page.waitForFunction(
      () =>
        (window as any).mainApplicationGroup.primaryApplication
          ._webSocketSyncTransport.transportStatus.state === "READY",
      undefined,
      { timeout: 400 },
    ),
  ).rejects.toThrow(/Timeout/);
  await page.evaluate(() => (window as any).resetTransport());
  await waitForSocketReady(page);
  expect(
    await page.evaluate(
      () =>
        (window as any).mainApplicationGroup.primaryApplication
          ._webSocketSyncTransport.transportStatus.state,
    ),
  ).toBe("READY");
});

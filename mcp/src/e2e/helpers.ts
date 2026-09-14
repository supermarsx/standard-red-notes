import "../polyfill.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapHeadlessApp, type HeadlessApp } from "../snjs/bootstrap.js";

/** The public front door — the only origin a real client ever uses. */
export const SERVER =
  process.env.STANDARD_RED_NOTES_SERVER_URL ?? "http://localhost:3001";
/**
 * The gateway's OWN port, bypassing the front door. Only the liveness probe
 * uses this: it is the one check that wants to know whether the gateway
 * process itself is up, separately from whether nginx is routing to it.
 * Everything else must go through SERVER, because the front door is where
 * origin checks, header stripping and rate limits actually apply.
 */
export const GATEWAY_HTTP = process.env.GATEWAY_HTTP ?? "http://localhost:3106";
/**
 * The legacy WebSocket lane through the front door. Contract C13 pins it to
 * the exact pathname `/sockets`; any other path is closed 1008 `unknown path`,
 * so this value already includes it and callers append `?authToken=…`.
 */
export const GATEWAY_WS =
  process.env.GATEWAY_WS ?? "ws://localhost:3001/sockets";
export const INTERNAL_SECRET =
  process.env.WEBSOCKET_GATEWAY_INTERNAL_SECRET ??
  "dev-ws-internal-secret-change-me";
/**
 * A push is either a bare notification or an inlined payload depending on
 * `WEBSOCKET_SYNC_PUSH_ENABLED`, which defaults to OFF. Tests that only care
 * that a push arrived must accept either.
 */
export const PUSH_FRAME_TYPES = [
  "ITEMS_CHANGED_ON_SERVER",
  "SYNC_ITEMS_PUSHED",
] as const;

/** True when `frame` is any realtime push notification. */
export function isPushFrame(frame: string | null | undefined): boolean {
  return (
    typeof frame === "string" &&
    PUSH_FRAME_TYPES.some((type) => frame.includes(type))
  );
}

let failures = 0;
export function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   - ${name}`);
  } else {
    console.log(`  FAIL - ${name}`);
    failures++;
  }
}

/** Record a non-fatal skip (e.g. a precondition the live build doesn't satisfy). */
export function skip(name: string, reason: string): void {
  console.log(`  skip - ${name} (${reason})`);
}
export function finish(): void {
  console.log(failures === 0 ? "\nE2E PASSED" : `\nE2E FAILED (${failures})`);
  // Delay the exit so any closing async handles (sockets, child-process stdio)
  // finish closing first — calling process.exit() mid-close trips a libuv
  // UV_HANDLE_CLOSING assertion (abort -> bogus non-zero code) on Node/Windows.
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 400);
}

export async function serverUp(): Promise<boolean> {
  const code = await fetch(`${SERVER}/healthcheck`)
    .then((r) => r.status)
    .catch(() => 0);
  return code === 200;
}

/** Bootstrap + register a fresh throwaway account in a temp data dir. */
export async function freshAccount(): Promise<{
  app: HeadlessApp;
  email: string;
  password: string;
  dataDir: string;
}> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "srn-e2e-"));
  const stamp = Date.now() + "-" + Math.floor(performance.now());
  const email = `e2e-${stamp}@example.com`;
  const password = `pw-${stamp}-correcthorse`;
  const app = await bootstrapHeadlessApp({
    serverUrl: SERVER,
    dataDir,
    password,
    syncIntervalMs: 0,
  });
  // Register has an occasional transient challenge; retry a couple of times.
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      await app.register(email, password);
      return { app, email, password, dataDir };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function cleanup(
  app: HeadlessApp,
  dataDir: string,
): Promise<void> {
  await app.deinit();
  await fs.rm(dataDir, { recursive: true, force: true });
}

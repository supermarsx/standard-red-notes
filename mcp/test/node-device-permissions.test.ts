import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

await import("../src/polyfill.js");
const { NodeDevice } = await import("../src/snjs/NodeDevice.js");

const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "srn-node-device-permissions-"),
);

afterAll(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("headless account-state permissions", () => {
  test("creates account storage with owner-only permissions on POSIX", async () => {
    const device = new NodeDevice(directory);
    await device.setRawStorageValue("test", "secret");
    await device.flushWrites();

    expect(await fs.readFile(path.join(directory, "storage.json"), "utf8")).toBe(
      '{"test":"secret"}',
    );
    if (process.platform !== "win32") {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect(
        (await fs.stat(path.join(directory, "storage.json"))).mode & 0o777,
      ).toBe(0o600);
    }
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// snjs touches browser globals at import time; the bridge's polyfill installs
// them. It must be imported before anything that pulls in @standardnotes/snjs.
import "../src/polyfill.ts";
import { NodeDevice } from "../src/snjs/NodeDevice.ts";

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "srn-mcp-device-"));
}

test("raw storage round-trips through storage.json", async () => {
  const dir = await tempDir();
  const device = new NodeDevice(dir);

  await device.setRawStorageValue("alpha", "one");
  await device.setRawStorageValue("beta", "two");
  await device.flushWrites();

  assert.equal(await device.getRawStorageValue("alpha"), "one");
  assert.equal(await device.getRawStorageValue("missing"), undefined);

  const onDisk = JSON.parse(
    await fs.readFile(path.join(dir, "storage.json"), "utf8"),
  );
  assert.deepEqual(onDisk, { alpha: "one", beta: "two" });

  // A fresh device over the same directory must see the persisted values.
  const reopened = new NodeDevice(dir);
  assert.equal(await reopened.getRawStorageValue("beta"), "two");
});

test("getJsonParsedRawStorageValue parses JSON and falls back to the raw string", async () => {
  const device = new NodeDevice(await tempDir());

  await device.setRawStorageValue("json", JSON.stringify({ n: 1 }));
  await device.setRawStorageValue("plain", "not-json");

  assert.deepEqual(await device.getJsonParsedRawStorageValue("json"), { n: 1 });
  assert.equal(await device.getJsonParsedRawStorageValue("plain"), "not-json");
  assert.equal(await device.getJsonParsedRawStorageValue("absent"), undefined);
});

test("removeRawStorageValuesForIdentifier drops only matching keys", async () => {
  const device = new NodeDevice(await tempDir());

  await device.setRawStorageValue("ns-alpha:token", "a");
  await device.setRawStorageValue("ns-beta:token", "b");
  await device.removeRawStorageValuesForIdentifier("ns-alpha" as never);
  await device.flushWrites();

  assert.equal(await device.getRawStorageValue("ns-alpha:token"), undefined);
  assert.equal(await device.getRawStorageValue("ns-beta:token"), "b");
});

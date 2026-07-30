import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { AsyncMutex } from "../src/AsyncMutex.js";
import { withHttpRequestTimeout } from "../src/httpSecurity.js";

describe("shared SNJS operation gate", () => {
  test("runs concurrent operations one at a time in FIFO order", async () => {
    const mutex = new AsyncMutex();
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = mutex.runExclusive(async () => {
      events.push("first:start");
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await firstMayFinish;
      active -= 1;
      events.push("first:end");
    });
    const second = mutex.runExclusive(async () => {
      events.push("second:start");
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      active -= 1;
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(maximumActive).toBe(1);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  test("releases the next operation after a failure", async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.runExclusive(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(
      mutex.runExclusive(async () => "recovered"),
    ).resolves.toBe("recovered");
  });

  test("keeps direct client acquisition behind the bridge gate", async () => {
    const source = await readFile(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );
    const calls = [...source.matchAll(/\bgetClient\(\)/g)];
    // One invocation inside useClient plus the getClient declaration itself.
    // A new direct call in a tool handler bypasses shared-app serialization.
    expect(calls).toHaveLength(2);
    expect(source).toContain("bridgeOperations.runExclusive");
  });

  test("keeps serialization held after a 504 until the operation really settles", async () => {
    const mutex = new AsyncMutex();
    let releaseMutation!: () => void;
    const mutationMayFinish = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let followUpStarted = false;
    const mutation = mutex.runExclusive(async () => mutationMayFinish);

    await expect(withHttpRequestTimeout(mutation, 5)).rejects.toThrow(
      "operation outcome is unknown",
    );
    const followUp = mutex.runExclusive(async () => {
      followUpStarted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(followUpStarted).toBe(false);

    releaseMutation();
    await Promise.all([mutation, followUp]);
    expect(followUpStarted).toBe(true);
  });
});

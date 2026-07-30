import { describe, expect, test } from "vitest";

await import("../src/polyfill.js");
const { isUnauthorizedError } = await import("../src/snjs/bootstrap.js");

describe("upstream authorization-loss detection", () => {
  test.each([
    { status: 401 },
    { response: { statusCode: 498 } },
    new Error("sync failed: Unauthorized"),
    { error: { message: "invalid session" } },
  ])("recognizes nested upstream auth failures", (error) => {
    expect(isUnauthorizedError(error)).toBe(true);
  });

  test("does not mistake ordinary sync failures for authorization loss", () => {
    expect(isUnauthorizedError(new Error("connection reset"))).toBe(false);
  });
});

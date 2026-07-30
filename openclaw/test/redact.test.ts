import { describe, it, expect } from "vitest";
import {
  redactForAudit,
  noteSummary,
  redactSensitiveText,
} from "../src/util/redact.js";

describe("redactForAudit", () => {
  it("replaces note body content", () => {
    const out = redactForAudit({
      title: "shopping",
      body: "eggs milk",
    }) as Record<string, unknown>;
    expect(out.title).toBe("shopping");
    expect(out.body).toMatch(/^<note:/);
  });

  it("masks token-like strings", () => {
    const out = redactForAudit("sk-abc12345xyz_more");
    expect(out).toBe("<redacted-token>");
  });

  it("recurses into arrays", () => {
    const out = redactForAudit([{ body: "secret" }, "sk-abc12345xyz"]) as Array<
      Record<string, unknown> | string
    >;
    expect((out[0] as Record<string, unknown>).body).toMatch(/^<note:/);
    expect(out[1]).toBe("<redacted-token>");
  });

  it("redacts filesystem paths at every nesting level", () => {
    const out = redactForAudit({
      path: "/home/user/note.txt",
      nested: {
        outputPath: "C:\\Users\\user\\export.zip",
        directory: "/tmp/private",
      },
    }) as Record<string, unknown>;

    expect(out).toEqual({
      path: "<redacted-path>",
      nested: {
        outputPath: "<redacted-path>",
        directory: "<redacted-path>",
      },
    });
  });

  it("redacts compound path keys and paths embedded in error text", () => {
    expect(
      redactForAudit({
        allowedFilesystemPaths: ["/home/user/private"],
      }),
    ).toEqual({
      allowedFilesystemPaths: "<redacted-path>",
    });
    expect(
      redactSensitiveText(
        "ENOENT opening C:\\Users\\me\\secret.txt and /home/me/private.txt",
      ),
    ).toBe("ENOENT opening <redacted-path> and <redacted-path>");
    expect(
      redactSensitiveText("request failed at https://example.test/mcp"),
    ).toContain("https://example.test/mcp");
  });

  it("is idempotent for note summaries", () => {
    const once = redactForAudit({ body: "private body" });
    expect(redactForAudit(once)).toEqual(once);
  });
});

describe("noteSummary", () => {
  it("encodes length and uuid", () => {
    expect(noteSummary("hello", { uuid: "u1" })).toBe("<note:u1 5 chars>");
  });
});

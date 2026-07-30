import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditSink, expandAuditPath } from "../src/util/audit.js";
import type { AuditEntry } from "../src/mcp/session.js";

const entry: AuditEntry = {
  ts: "2026-07-30T12:00:00.000Z",
  tool: "files.attach",
  scope: "files",
  ok: true,
  durationMs: 12,
  argsRedacted: {
    path: "/home/user/private.txt",
    body: "private note body",
    authorization: "Bearer sk-abc12345secret",
  },
  resultRedacted: {
    content: "private response",
  },
};

describe("secure audit sink", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "openclaw-audit-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("expands only a leading home marker", () => {
    expect(expandAuditPath("~")).toBe(homedir());
    expect(expandAuditPath("~/.openclaw/audit.log")).toBe(
      join(homedir(), ".openclaw/audit.log"),
    );
    expect(expandAuditPath("/tmp/~archive/audit.log")).toBe(
      "/tmp/~archive/audit.log",
    );
  });

  it("creates a parent directory and appends redacted JSON lines", () => {
    const file = join(directory, "private", "audit.jsonl");
    const sink = createAuditSink(file);

    sink(entry);
    sink({ ...entry, tool: "notes.search" });

    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      tool: "files.attach",
      argsRedacted: {
        path: "<redacted-path>",
        body: "<note:unknown 17 chars>",
        authorization: "<redacted-credential>",
      },
      resultRedacted: {
        content: "<note:unknown 16 chars>",
      },
    });
    expect(readFileSync(file, "utf8")).not.toContain("private note body");
    expect(readFileSync(file, "utf8")).not.toContain("abc12345secret");
  });

  it.skipIf(platform() === "win32")(
    "creates a new parent and file with owner-only permissions",
    () => {
      const parent = join(directory, "private");
      const file = join(parent, "audit.jsonl");

      createAuditSink(file)(entry);

      expect(statSync(parent).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(platform() === "win32")(
    "does not chmod an existing shared parent directory",
    () => {
      const file = join(directory, "audit.jsonl");
      chmodSync(directory, 0o755);

      createAuditSink(file)(entry);

      expect(statSync(directory).mode & 0o777).toBe(0o755);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(platform() === "win32")(
    "refuses to follow an audit-file symbolic link",
    () => {
      const outside = join(directory, "outside.log");
      const link = join(directory, "audit.log");
      writeFileSync(outside, "sentinel\n");
      symlinkSync(outside, link, "file");

      expect(() => createAuditSink(link)(entry)).not.toThrow();
      expect(readFileSync(outside, "utf8")).toBe("sentinel\n");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(platform() === "win32")(
    "refuses an existing audit file with multiple hard links",
    () => {
      const outside = join(directory, "outside.log");
      const link = join(directory, "audit.log");
      writeFileSync(outside, "sentinel\n");
      linkSync(outside, link);

      expect(() => createAuditSink(link)(entry)).not.toThrow();
      expect(readFileSync(outside, "utf8")).toBe("sentinel\n");
    },
  );

  it("swallows append failures so auditing cannot break a tool call", () => {
    const targetDirectory = join(directory, "not-a-file");
    mkdirSync(targetDirectory);
    const sink = createAuditSink(targetDirectory);

    expect(() => sink(entry)).not.toThrow();
    expect(statSync(targetDirectory).isDirectory()).toBe(true);
    expect(dirname(targetDirectory)).toBe(directory);
  });
});

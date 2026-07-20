import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { log, setLevel, type LogLevel } from "../src/util/log.js";

let written: string[];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  written = [];
  spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  setLevel("info");
});

afterEach(() => {
  spy.mockRestore();
  setLevel("info");
});

const lines = () => written.map((line) => JSON.parse(line));

describe("log", () => {
  it("writes one newline-terminated JSON object per call to stderr", () => {
    log.info("hello");
    expect(written).toHaveLength(1);
    expect(written[0].endsWith("\n")).toBe(true);
    expect(lines()[0]).toMatchObject({ level: "info", msg: "hello" });
    expect(Date.parse(lines()[0].ts)).not.toBeNaN();
  });

  it("merges structured fields into the log object", () => {
    log.warn("config loaded", { path: "/tmp/a.toml", count: 3 });
    expect(lines()[0]).toMatchObject({
      level: "warn",
      msg: "config loaded",
      path: "/tmp/a.toml",
      count: 3,
    });
  });

  it("suppresses levels below the configured threshold", () => {
    setLevel("warn");
    log.debug("d");
    log.info("i");
    expect(written).toHaveLength(0);
    log.warn("w");
    log.error("e");
    expect(lines().map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("emits everything at debug level", () => {
    setLevel("debug");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines().map((l) => l.level)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
    ]);
  });

  it("emits only errors at error level", () => {
    setLevel("error");
    for (const level of ["debug", "info", "warn"] as LogLevel[]) {
      log[level]("x");
    }
    expect(written).toHaveLength(0);
    log.error("boom");
    expect(lines()[0].msg).toBe("boom");
  });

  it("never writes to stdout, so piped agent output stays clean", () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      setLevel("debug");
      log.debug("d");
      log.error("e", { err: "boom" });
      expect(stdout).not.toHaveBeenCalled();
      expect(written).toHaveLength(2);
    } finally {
      stdout.mockRestore();
    }
  });
});

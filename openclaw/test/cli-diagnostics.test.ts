import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("top-level CLI diagnostics", () => {
  it("redacts sensitive fatal errors emitted by the executable", () => {
    const secret = "sk-abc12345secret";
    const missingConfig = join(tmpdir(), `openclaw-${secret}`, "missing.toml");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "ask", "question"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_CONFIG: missingConfig,
        },
        encoding: "utf8",
        windowsHide: true,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fatal:");
    expect(result.stderr).toContain("<redacted-path>");
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain("missing.toml");
    expect(result.stderr).not.toContain("doctor --write-config");
  });
});

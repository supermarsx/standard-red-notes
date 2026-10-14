import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bash =
  process.platform === "win32" &&
  existsSync("C:/Program Files/Git/bin/bash.exe")
    ? "C:/Program Files/Git/bin/bash.exe"
    : "bash";
const waitScripts = [
  "server/docker/wait-for.sh",
  ...readdirSync(path.join(root, "server/packages"))
    .map((name) => `server/packages/${name}/supervisor/wait-for.sh`)
    .filter((name) => existsSync(path.join(root, name))),
];

for (const source of waitScripts) {
  test(`${source} emits timed, quiet, named dependency events`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "srn-startup-log-"));
    try {
      mkdirSync(path.join(directory, "bin"));
      copyFileSync(path.join(root, source), path.join(directory, "wait.sh"));
      writeFileSync(
        path.join(directory, "bin/nc"),
        `#!/bin/sh
count=0
[ ! -f .nc-count ] || count=$(cat .nc-count)
count=$((count + 1))
printf '%s' "$count" > .nc-count
echo 'private-host-credential-fixture' >&2
[ "$count" -ge 5 ]
`,
      );
      writeFileSync(path.join(directory, "bin/sleep"), "#!/bin/sh\nexit 0\n");
      chmodSync(path.join(directory, "bin/nc"), 0o755);
      chmodSync(path.join(directory, "bin/sleep"), 0o755);
      const result = spawnSync(
        bash,
        [
          "-c",
          'export PATH="$PWD/bin:$PATH"; sh ./wait.sh private-host-credential-fixture 3103',
        ],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.ok(!result.stdout.includes("private-host-credential-fixture"));
      const entries = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        entries.map(({ level, event }) => ({ level, event })),
        [
          { level: "info", event: "dependency.wait" },
          { level: "warn", event: "dependency.wait" },
          { level: "info", event: "dependency.ready" },
        ],
      );
      assert.match(entries[1].message, /auth listener \(30s elapsed\)/);
      assert.match(entries[2].message, /auth listener ready \(40s waited\)/);
      entries.forEach(({ timestamp }) =>
        assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

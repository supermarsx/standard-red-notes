import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Behaviour tests for what deploy.sh remembers between runs.
 *
 * Each test drives the real deploy.sh, top to bottom, in a throwaway Git checkout that holds
 * the real Compose files. Only the `docker` on PATH is replaced, by deploy-docker-double.mjs:
 * it keeps the "daemon" in a JSON file and turns `compose up` into a state change, so a deploy
 * followed by a redeploy can be asserted on without building an image. Compose's own merge
 * rules are NOT faked when a real docker binary is installed -- see the double's header.
 *
 * The accident these tests exist for was measured on a real stack before any of this was
 * written: `./deploy.sh --proxy-network=NAME` followed by a plain `./deploy.sh` recreated the
 * app container off the proxy network (the proxy answered 502) and published a host port on
 * every interface (which answered 200).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doubleScript = path.join(root, "scripts", "deploy-docker-double.mjs");
const STATE_FILE = ".deploy-state";
const GUARD_FILE = "docker-compose.override.yml";
const PROXY_QUESTION = "Behind a containerised reverse proxy?";

function findOnPath(name) {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (directory && existsSync(candidate)) return candidate;
    }
  }
  return "";
}

/**
 * A real docker whose `compose config` works. That is client-side and needs no daemon, so a
 * machine with Docker installed but stopped still qualifies.
 */
function findRealDocker() {
  const candidate = findOnPath("docker");
  if (!candidate) return "";
  const probe = spawnSync(candidate, ["compose", "version"], {
    encoding: "utf8",
  });
  return probe.status === 0 ? candidate : "";
}

const realDocker = findRealDocker();
const realScript = process.platform === "linux" ? findOnPath("script") : "";

/**
 * A skip is a test that did not run, and a suite that skips its way to green in CI is not a
 * gate. Locally a missing tool skips with its name; on a CI runner it fails instead.
 */
function unavailable(reason) {
  if (process.env.CI) {
    return {
      skip: false,
      missing: `${reason} (refusing to skip on a CI runner)`,
    };
  }
  return { skip: reason, missing: "" };
}

const needsRealCompose = realDocker
  ? { skip: false, missing: "" }
  : unavailable(
      "no working `docker compose` on PATH, so Compose's own rendering cannot be consulted",
    );
const needsTerminal = realScript
  ? { skip: false, missing: "" }
  : unavailable(
      "needs util-linux `script` on Linux to give deploy.sh a real terminal",
    );

const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !/^(COMPOSE_|SRN_|APP_PORT$|APP_BIND_ADDRESS$|MYSQL_|DOCKER_HOST$)/.test(
        name,
      ),
  ),
);

/**
 * Runs a command to completion without blocking the event loop. A deploy takes seconds (the
 * script makes dozens of docker calls), and the tests only finish in reasonable time because
 * they run side by side, each in its own checkout with its own docker double.
 */
function execute(command, args, { cwd, env, input = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function git(checkout, ...args) {
  const result = spawnSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

const NPM_HOST = Object.freeze({
  networks: {
    npm_default: { project: "npm", members: ["npm-app-1"] },
    edge_default: { project: "edge", members: ["edge-traefik-1"] },
    metrics_default: { project: "metrics", members: ["metrics-db-1"] },
  },
  roster: [
    {
      name: "npm-app-1",
      image: "jc21/nginx-proxy-manager:latest",
      ports: "0.0.0.0:80-81->80-81/tcp, 0.0.0.0:443->443/tcp",
    },
    { name: "edge-traefik-1", image: "traefik:v3", ports: "" },
    { name: "metrics-db-1", image: "postgres:18-alpine", ports: "" },
  ],
});

/**
 * A committed checkout of the real deploy.sh and Compose files, in a directory that is
 * deliberately NOT called standard-red-notes, beside a fake host described by `host`.
 */
function createSandbox(t, { configured = true, host = NPM_HOST } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "srn-deploy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, "checkout");
  const bin = path.join(directory, "bin");
  mkdirSync(path.join(checkout, "scripts"), { recursive: true });
  mkdirSync(bin);

  for (const file of [
    "deploy.sh",
    "docker-compose.yml",
    "docker-compose.single.yml",
    "docker-compose.proxy.yml",
    "docker-compose.proxy-publish.yml",
    "docker-compose.single.proxy.yml",
    ".gitignore",
    ".gitattributes",
  ]) {
    cpSync(path.join(root, file), path.join(checkout, file));
  }
  // Stands in for scripts/setup.sh, which deploy.sh runs on a first install and whose own
  // behaviour is not under test here: it writes the two variables docker-compose.yml requires.
  writeFileSync(
    path.join(checkout, "scripts", "setup.sh"),
    [
      "#!/usr/bin/env bash",
      'cd "$(dirname "$0")/.."',
      "printf 'MYSQL_PASSWORD=fixture\\nMYSQL_ROOT_PASSWORD=fixture\\n' > .env",
      "",
    ].join("\n"),
  );
  git(checkout, "init", "--quiet", "--initial-branch=main");
  git(checkout, "config", "core.autocrlf", "false");
  git(checkout, "config", "user.name", "deploy test");
  git(checkout, "config", "user.email", "deploy-test@example.invalid");
  git(checkout, "add", "--all");
  git(checkout, "commit", "--quiet", "--message", "fixture");
  if (configured) {
    writeFileSync(
      path.join(checkout, ".env"),
      "MYSQL_PASSWORD=fixture\nMYSQL_ROOT_PASSWORD=fixture\n",
    );
  }

  writeFileSync(
    path.join(bin, "docker"),
    '#!/usr/bin/env bash\nexec node "$SRN_DOCKER_DOUBLE_SCRIPT" "$@"\n',
  );
  // deploy.sh probes the published port from the host with curl. There is no server behind
  // the double, so the probe is answered here; what is under test is which port it was told.
  writeFileSync(
    path.join(bin, "curl"),
    "#!/usr/bin/env bash\nprintf '%s' '{\"status\":\"ready\"}'\n",
  );
  chmodSync(path.join(bin, "docker"), 0o755);
  chmodSync(path.join(bin, "curl"), 0o755);

  const statePath = path.join(directory, "docker-double.json");
  writeFileSync(
    statePath,
    JSON.stringify({ ...structuredClone(host), containers: {}, calls: [] }),
  );

  const sandbox = {
    checkout,
    statePath,
    revision: git(checkout, "rev-parse", "HEAD"),
    file: (name) => path.join(checkout, name),
    read: (name) => readFileSync(path.join(checkout, name), "utf8"),
    exists: (name) => existsSync(path.join(checkout, name)),
    docker: () => JSON.parse(readFileSync(statePath, "utf8")),
    editDocker(change) {
      const state = sandbox.docker();
      change(state);
      writeFileSync(statePath, JSON.stringify(state));
    },
    environment(extra = {}) {
      return {
        ...cleanEnvironment,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        SRN_DOCKER_DOUBLE_STATE: statePath,
        SRN_DOCKER_DOUBLE_SCRIPT: doubleScript,
        SRN_DOCKER_DOUBLE_REAL: realDocker,
        ...extra,
      };
    },
    /** Runs ./deploy.sh with no terminal attached, and returns what it did. */
    async deploy(args, { env = {}, input = "" } = {}) {
      const before = sandbox.docker().calls.length;
      const result = await execute("bash", ["./deploy.sh", ...args], {
        cwd: checkout,
        input,
        env: sandbox.environment(env),
      });
      const calls = sandbox.docker().calls.slice(before);
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
        calls,
        ups: calls.filter(
          (call) => call.argv[0] === "compose" && call.argv.includes("up"),
        ),
      };
    },
    /** The app container the last `compose up` left behind, or null. */
    app(project) {
      return (
        Object.values(sandbox.docker().containers).find(
          (container) =>
            container.service === "app" &&
            (project === undefined || container.project === project),
        ) ?? null
      );
    },
  };
  return sandbox;
}

function composeFiles(call) {
  return call.argv.flatMap((value, index, all) =>
    all[index - 1] === "-f" ? [path.basename(value.replace(/\\/g, "/"))] : [],
  );
}

function settings(sandbox, file = STATE_FILE) {
  return Object.fromEntries(
    sandbox
      .read(file)
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
}

function succeeded(run) {
  assert.equal(run.status, 0, `deploy.sh exited ${run.status}:\n${run.output}`);
}

function writeState(sandbox, lines) {
  writeFileSync(sandbox.file(STATE_FILE), `${lines.join("\n")}\n`);
}

const PROXY_STATE = Object.freeze([
  "version=1",
  "topology=multi",
  "compose_file=",
  "project=",
  "proxy=on",
  "proxy_network=npm_default",
  "proxy_alias=standard-red-notes-app",
  "proxy_publish_ports=no",
]);

const ONE_SHOT = ["--yes", "--no-pull", "--no-backup"];

// Side by side: every test has its own checkout and its own docker double, and a deploy is
// mostly waiting on child processes.
describe("what deploy.sh remembers between runs", { concurrency: true }, () => {
  test("web handover dry-runs keep the public container and distinguish frontend-only, full updates and rollback", async (t) => {
    const sandbox = createSandbox(t);
    for (const [flag, mode] of [
      ["--web-only", ""],
      ["--rolling-web", "--full-update"],
      ["--web-rollback", "--rollback"],
    ]) {
      const result = await sandbox.deploy([flag, "--dry-run", ...ONE_SHOT]);
      succeeded(result);
      assert.match(result.output, /scripts\/deploy-web\.mjs/);
      if (mode) assert.ok(result.output.includes(mode), result.output);
      assert.equal(result.ups.length, 0);
    }
  });

  test("web handover rejects single-container mode and contradictory backend choices", async (t) => {
    const sandbox = createSandbox(t);
    const single = await sandbox.deploy([
      "--single",
      "--web-only",
      ...ONE_SHOT,
    ]);
    assert.notEqual(single.status, 0);
    assert.match(single.output, /separate app and server/);
    const conflict = await sandbox.deploy([
      "--rolling-web",
      "--web-only",
      ...ONE_SHOT,
    ]);
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.output, /Choose one/);
  });

  // ---------------------------------------------------------------------------------------
  // The accident itself
  // ---------------------------------------------------------------------------------------

  test("a plain redeploy stays on the remembered proxy network and publishes no port", async (t) => {
    const sandbox = createSandbox(t);

    const first = await sandbox.deploy(["--proxy-network=npm_default", ...ONE_SHOT]);
    succeeded(first);
    assert.deepEqual(Object.keys(sandbox.app().networks).sort(), [
      "npm_default",
      "standard-red-notes_standard-red-notes",
    ]);

    const second = await sandbox.deploy(ONE_SHOT);
    succeeded(second);

    // From the settings file, not from the fallback that reads the network back off the
    // running container: that one only exists for deployments older than the file.
    assert.match(second.output, /This run: as remembered\./);
    assert.doesNotMatch(second.output, /Nothing is remembered yet/);
    assert.equal(second.ups.length, 1);
    assert.deepEqual(composeFiles(second.ups[0]), [
      "docker-compose.yml",
      "docker-compose.proxy.yml",
    ]);
    assert.equal(second.ups[0].env.SRN_PROXY_NETWORK, "npm_default");
    assert.equal(second.ups[0].env.SRN_PROXY_ALIAS, "standard-red-notes-app");

    const app = sandbox.app();
    assert.ok(
      app.networks.npm_default?.includes("standard-red-notes-app"),
      `the app container left the proxy network: ${JSON.stringify(app.networks)}`,
    );
    assert.deepEqual(
      app.ports,
      [],
      "a host port appeared on a deployment that is behind a proxy",
    );
  });

  test("every run says which file it read and what it took from it, before anything else", async (t) => {
    const sandbox = createSandbox(t);

    const fresh = await sandbox.deploy(["--dry-run", "--no-pull", "--no-backup"]);
    succeeded(fresh);
    assert.match(fresh.output, /Remembered settings\n.*\.deploy-state \(does not exist: nothing is remembered yet\)/);

    succeeded(await sandbox.deploy(["--proxy-network=npm_default", ...ONE_SHOT]));
    const later = await sandbox.deploy(ONE_SHOT);
    succeeded(later);

    const announced = later.output.indexOf("Remembered settings");
    const loaded = later.output.indexOf(
      "behind reverse-proxy network 'npm_default' as 'standard-red-notes-app', no host port",
    );
    const firstDockerUse = later.output.indexOf("Found Git, Docker, and Compose");
    assert.ok(announced !== -1 && loaded > announced, later.output);
    assert.ok(
      loaded < firstDockerUse,
      "the loaded settings must be printed before the script does anything",
    );
    assert.match(later.output, /File: {3}.*\.deploy-state \(saved \d{4}-\d\d-\d\dT/);
    assert.match(later.output, /Loaded: the multi-container stack \(docker-compose\.yml\)/);
    assert.match(later.output, /This run: as remembered\./);
  });

  test("a remembered network that no longer exists stops the deploy and touches nothing", async (t) => {
    const sandbox = createSandbox(t);
    succeeded(await sandbox.deploy(["--proxy-network=npm_default", ...ONE_SHOT]));
    const runningBefore = JSON.stringify(sandbox.docker().containers);
    const stateBefore = sandbox.read(STATE_FILE);
    sandbox.editDocker((state) => {
      delete state.networks.npm_default;
    });

    const run = await sandbox.deploy(ONE_SHOT);

    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /The reverse-proxy network 'npm_default' does not exist any more\./);
    assert.match(run.output, /\.\/deploy\.sh --proxy-network=<its-network>/);
    assert.match(run.output, /\.\/deploy\.sh --no-proxy/);
    assert.match(run.output, /the running stack is untouched/);
    assert.equal(run.ups.length, 0, "the stack was restarted anyway");
    assert.equal(
      JSON.stringify(sandbox.docker().containers),
      runningBefore,
      "the running containers changed",
    );
    assert.equal(sandbox.read(STATE_FILE), stateBefore);
    assert.equal(
      run.calls.some((call) => call.argv.includes("create")),
      false,
      "a missing proxy network must never be recreated implicitly",
    );
  });

  // ---------------------------------------------------------------------------------------
  // Changing it is explicit, announced, and remembered in turn
  // ---------------------------------------------------------------------------------------

  test("--no-proxy is honoured, announced before anything happens, and remembered", async (t) => {
    const sandbox = createSandbox(t);
    succeeded(await sandbox.deploy(["--proxy-network=npm_default", ...ONE_SHOT]));

    const leaving = await sandbox.deploy(["--no-proxy", ...ONE_SHOT]);
    succeeded(leaving);
    const announced = leaving.output.indexOf(
      "CHANGE: leaving the reverse-proxy network 'npm_default' (--no-proxy).",
    );
    assert.ok(announced !== -1, leaving.output);
    assert.ok(announced < leaving.output.indexOf("Found Git, Docker, and Compose"));
    assert.deepEqual(composeFiles(leaving.ups[0]), ["docker-compose.yml"]);
    assert.equal(settings(sandbox).proxy, "off");
    assert.equal(settings(sandbox).proxy_network, "");

    const later = await sandbox.deploy(ONE_SHOT);
    succeeded(later);
    assert.deepEqual(composeFiles(later.ups[0]), ["docker-compose.yml"]);
    assert.deepEqual(Object.keys(sandbox.app().networks), [
      "standard-red-notes_standard-red-notes",
    ]);
    assert.equal(sandbox.app().ports.length, 1);
    assert.match(later.output, /no reverse-proxy network: the app publishes APP_PORT on the host/);
  });

  test("a different --proxy-network moves the container and is remembered", async (t) => {
    const sandbox = createSandbox(t);
    succeeded(await sandbox.deploy(["--proxy-network=npm_default", ...ONE_SHOT]));

    const moving = await sandbox.deploy(["--proxy-network=edge_default", ...ONE_SHOT]);
    succeeded(moving);
    const announced = moving.output.indexOf(
      "CHANGE: reverse-proxy network 'npm_default' -> 'edge_default'.",
    );
    assert.ok(announced !== -1, moving.output);
    assert.ok(announced < moving.output.indexOf("Found Git, Docker, and Compose"));
    assert.equal(moving.ups[0].env.SRN_PROXY_NETWORK, "edge_default");
    assert.equal(settings(sandbox).proxy_network, "edge_default");
    assert.deepEqual(Object.keys(sandbox.app().networks).sort(), [
      "edge_default",
      "standard-red-notes_standard-red-notes",
    ]);

    const later = await sandbox.deploy(ONE_SHOT);
    succeeded(later);
    assert.equal(later.ups[0].env.SRN_PROXY_NETWORK, "edge_default");
    assert.ok(sandbox.app().networks.edge_default);
    assert.equal(sandbox.app().networks.npm_default, undefined);
  });

  test("--publish-ports, --no-publish-ports and --proxy-alias are remembered too", async (t) => {
    const sandbox = createSandbox(t);
    succeeded(
      await sandbox.deploy([
        "--proxy-network=npm_default",
        "--publish-ports",
        "--proxy-alias",
        "notes-upstream",
        ...ONE_SHOT,
      ]),
    );

    const later = await sandbox.deploy(ONE_SHOT);
    succeeded(later);
    assert.deepEqual(composeFiles(later.ups[0]), [
      "docker-compose.yml",
      "docker-compose.proxy.yml",
      "docker-compose.proxy-publish.yml",
    ]);
    assert.equal(later.ups[0].env.SRN_PROXY_ALIAS, "notes-upstream");
    assert.ok(sandbox.app().networks.npm_default.includes("notes-upstream"));
    assert.deepEqual(sandbox.app().ports.map((port) => port.hostIp), ["127.0.0.1"]);

    const unpublished = await sandbox.deploy(["--no-publish-ports", ...ONE_SHOT]);
    succeeded(unpublished);
    assert.match(unpublished.output, /CHANGE: no longer publishing APP_PORT on 127\.0\.0\.1/);
    succeeded(await sandbox.deploy(ONE_SHOT));
    assert.deepEqual(sandbox.app().ports, []);
    assert.ok(
      sandbox.app().networks.npm_default.includes("notes-upstream"),
      "the alias was lost when the port was unpublished",
    );
  });

  test("a bare --proxy-network means the remembered network, not a network called proxy", async (t) => {
    const sandbox = createSandbox(t);
    succeeded(await sandbox.deploy(["--proxy-network=npm_default", ...ONE_SHOT]));

    const again = await sandbox.deploy(["--proxy-network", ...ONE_SHOT]);
    succeeded(again);
    assert.equal(again.ups[0].env.SRN_PROXY_NETWORK, "npm_default");
    assert.doesNotMatch(again.output, /CHANGE:/);
  });

  // ---------------------------------------------------------------------------------------
  // The file itself
  // ---------------------------------------------------------------------------------------

  test("the settings file is human-readable, holds no secrets and is never committable", async (t) => {
    const sandbox = createSandbox(t);
    writeFileSync(
      sandbox.file(".env"),
      "MYSQL_PASSWORD=hunter2-not-for-the-state-file\nMYSQL_ROOT_PASSWORD=also-secret\n",
    );
    succeeded(await sandbox.deploy(["--proxy-network=npm_default", ...ONE_SHOT]));

    const text = sandbox.read(STATE_FILE);
    assert.doesNotMatch(text, /hunter2|also-secret/);
    assert.match(text, /^# Standard Red Notes - what \.\/deploy\.sh remembers/);
    assert.deepEqual(
      { ...settings(sandbox), saved_at: "", saved_revision: "" },
      {
        version: "1",
        topology: "multi",
        compose_file: "",
        project: "",
        proxy: "on",
        proxy_network: "npm_default",
        proxy_alias: "standard-red-notes-app",
        proxy_publish_ports: "no",
        saved_at: "",
        saved_revision: "",
      },
    );
    assert.equal(settings(sandbox).saved_revision, sandbox.revision);
    assert.equal(text.includes("\r"), false);

    // Ignored, so neither `git status` nor `git add --all` can ever pick it up -- and the
    // checkout guard, which compares content, still sees a clean tree.
    assert.equal(git(sandbox.checkout, "status", "--porcelain"), "");
    assert.match(
      git(sandbox.checkout, "status", "--porcelain", "--ignored"),
      /^!! \.deploy-state$/m,
    );
    const next = await sandbox.deploy(ONE_SHOT);
    succeeded(next);
    assert.match(next.output, /Checkout content matches HEAD/);
  });

  test("the settings survive a git pull between two deploys", async (t) => {
    const sandbox = createSandbox(t);
    const upstream = path.join(path.dirname(sandbox.checkout), "upstream.git");
    git(sandbox.checkout, "clone", "--quiet", "--bare", sandbox.checkout, upstream);
    git(sandbox.checkout, "remote", "add", "origin", upstream);
    git(sandbox.checkout, "fetch", "--quiet", "origin");
    git(sandbox.checkout, "branch", "--quiet", "--set-upstream-to=origin/main", "main");

    succeeded(await sandbox.deploy(["--proxy-network=npm_default", "--yes", "--no-backup"]));

    // Something arrives upstream, as it does before every real redeploy.
    const other = path.join(path.dirname(sandbox.checkout), "other");
    git(sandbox.checkout, "clone", "--quiet", upstream, other);
    git(other, "config", "user.name", "deploy test");
    git(other, "config", "user.email", "deploy-test@example.invalid");
    writeFileSync(path.join(other, "CHANGELOG"), "a newer release\n");
    git(other, "add", "CHANGELOG");
    git(other, "commit", "--quiet", "--message", "release");
    git(other, "push", "--quiet", "origin", "main");
    const arrived = git(other, "rev-parse", "HEAD");

    const redeploy = await sandbox.deploy(["--yes", "--no-backup"]);
    succeeded(redeploy);
    assert.match(redeploy.output, new RegExp(`Updated ${sandbox.revision} -> ${arrived}`));
    assert.equal(redeploy.ups[0].env.SRN_PROXY_NETWORK, "npm_default");
    assert.equal(redeploy.ups[0].env.SRN_DEPLOY_REVISION, arrived);
    assert.ok(sandbox.app().networks.npm_default);
    assert.equal(settings(sandbox).saved_revision, arrived);
  });

  test("--dry-run writes nothing, whether or not something is already remembered", async (t) => {
    const sandbox = createSandbox(t);

    const fresh = await sandbox.deploy([
      "--proxy-network=npm_default",
      "--dry-run",
      "--no-pull",
      "--no-backup",
    ]);
    succeeded(fresh);
    assert.match(fresh.output, /would write: .*\.deploy-state/);
    assert.match(fresh.output, /proxy_network=npm_default/);
    assert.equal(sandbox.exists(STATE_FILE), false);
    assert.equal(sandbox.exists(GUARD_FILE), false);
    assert.equal(fresh.ups.length, 0);

    succeeded(await sandbox.deploy(["--proxy-network=npm_default", ...ONE_SHOT]));
    const stateBefore = sandbox.read(STATE_FILE);
    const guardBefore = sandbox.exists(GUARD_FILE) ? sandbox.read(GUARD_FILE) : null;

    const leaving = await sandbox.deploy(["--no-proxy", "--dry-run", "--no-pull", "--no-backup"]);
    succeeded(leaving);
    assert.match(leaving.output, /CHANGE: leaving the reverse-proxy network/);
    assert.equal(sandbox.read(STATE_FILE), stateBefore);
    assert.equal(
      sandbox.exists(GUARD_FILE) ? sandbox.read(GUARD_FILE) : null,
      guardBefore,
    );
    assert.equal(leaving.ups.length, 0);
    assert.ok(sandbox.app().networks.npm_default);
  });

  test("the settings file is parsed, never executed", async (t) => {
    const sandbox = createSandbox(t);
    const marker = sandbox.file("executed");
    for (const hostile of [
      `proxy_network=$(touch '${marker}')`,
      `proxy_network=\`touch '${marker}'\``,
      `proxy_network=npm_default; touch '${marker}'`,
      `touch '${marker}'`,
      `$(touch '${marker}')`,
    ]) {
      writeState(sandbox, [
        ...PROXY_STATE.filter((line) => !line.startsWith("proxy_network=")),
        hostile,
      ]);
      const run = await sandbox.deploy(ONE_SHOT);
      assert.equal(run.status, 1, `${hostile}\n${run.output}`);
      assert.match(run.output, /REFUSING to deploy: the remembered settings in .* cannot be used\./);
      assert.equal(existsSync(marker), false, `executed: ${hostile}`);
      assert.equal(run.ups.length, 0);
    }
  });

  test("a network name read back from the file is validated before it reaches a command line", async (t) => {
    const sandbox = createSandbox(t);
    for (const name of ["--help", "-v", "npm default", "npm_default/../x", "", "a;b"]) {
      writeState(sandbox, [
        ...PROXY_STATE.filter((line) => !line.startsWith("proxy_network=")),
        `proxy_network=${name}`,
      ]);
      const run = await sandbox.deploy(ONE_SHOT);
      assert.equal(run.status, 1, `'${name}' was accepted:\n${run.output}`);
      assert.match(run.output, /is not a Docker network name/);
      assert.deepEqual(
        run.calls.map((call) => call.argv.join(" ")),
        [],
        `docker was reached with an unvalidated name '${name}'`,
      );
    }
  });

  test("a settings file that cannot be fully understood stops the deploy instead of being half applied", async (t) => {
    const sandbox = createSandbox(t);
    const without = (key) => PROXY_STATE.filter((line) => !line.startsWith(`${key}=`));
    const cases = [
      [[...PROXY_STATE, "proxy_mode=strict"], /sets 'proxy_mode', which this deploy\.sh does not know/],
      [[...PROXY_STATE, "proxy=off"], /sets 'proxy' a second time/],
      [without("version"), /version is 'missing'/],
      [[...without("version"), "version=2"], /version is '2'; this deploy\.sh reads version 1/],
      [[...without("proxy"), "proxy=maybe"], /proxy is 'maybe'; it must be on or off/],
      [[...without("proxy"), "proxy=off"], /proxy=off but proxy_network='npm_default' is set/],
      [without("proxy"), /proxy is 'missing'/],
      [[...without("topology"), "topology=swarm"], /topology is 'swarm'/],
      [[...without("project"), "project=Has Spaces"], /is not a Compose project name/],
      [[...without("proxy_alias"), "proxy_alias=-x"], /cannot be used as a network alias/],
      [[...PROXY_STATE, "not a setting"], /Line 9 is not of the form key=value/],
      [[], /version is 'missing'/],
    ];
    for (const [lines, expected] of cases) {
      writeState(sandbox, lines);
      const run = await sandbox.deploy(ONE_SHOT);
      assert.equal(run.status, 1, `${lines.join(" | ")}\n${run.output}`);
      assert.match(run.output, expected);
      assert.match(run.output, /Nothing has been changed\./);
      assert.equal(run.ups.length, 0, "deployed on a settings file it refused");
    }

    // A file edited on Windows, with comments and trailing blanks, is still the same file.
    writeFileSync(
      sandbox.file(STATE_FILE),
      `# edited by hand\r\n\r\n${PROXY_STATE.map((line) => `${line}  \r\n`).join("")}`,
    );
    const tolerant = await sandbox.deploy(ONE_SHOT);
    succeeded(tolerant);
    assert.equal(tolerant.ups[0].env.SRN_PROXY_NETWORK, "npm_default");
  });

  // ---------------------------------------------------------------------------------------
  // Never prompt without a terminal; ask on a first install with one
  // ---------------------------------------------------------------------------------------

  test("a first install never asks about a proxy without a terminal or with --yes", async (t) => {
    for (const args of [["--yes", "--no-pull"], ["--no-pull"], ["--dry-run", "--no-pull"]]) {
      const sandbox = createSandbox(t, { configured: false });
      // Answers are waiting on stdin. A script that prompted would consume them and end up
      // behind npm_default.
      const run = await sandbox.deploy(args, { input: "y\n1\ny\ny\n" });

      assert.match(run.output, /SETUP \(first install\)/);
      assert.equal(run.output.includes(PROXY_QUESTION), false, run.output);
      assert.match(run.output, /First install: not asking about a reverse proxy/);
      for (const up of run.ups) {
        assert.deepEqual(composeFiles(up), ["docker-compose.yml"]);
      }
      assert.equal(sandbox.exists(STATE_FILE), false);
      if (args.includes("--yes")) {
        succeeded(run);
        assert.equal(run.ups.length, 1);
      }
    }
  });

  test(
    "a first install with a terminal asks, lists the networks with the proxy's first, and remembers the answer",
    { skip: needsTerminal.skip },
    async (t) => {
      assert.equal(needsTerminal.missing, "");
      const sandbox = createSandbox(t, { configured: false });
      // `script` gives deploy.sh a real pseudo-terminal on stdin and stdout. The answers: yes,
      // behind a proxy; Enter, which is refused because two networks carry a proxy here and
      // the script will not pick one of them itself; network 1; yes, start the stack.
      const result = await execute(
        realScript,
        ["-qec", "bash ./deploy.sh --no-pull", "/dev/null"],
        { cwd: sandbox.checkout, input: "y\n\n1\ny\n", env: sandbox.environment() },
      );
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 0, output);

      assert.ok(output.includes(PROXY_QUESTION), output);
      assert.match(output, /Which network is your proxy on\? Number or name: /);
      assert.match(output, /Enter the number or the exact name of one of the networks above\./);
      const listed = (name) => output.indexOf(`) ${name}`);
      assert.match(
        output,
        /1\) npm_default\s+<- reverse proxy on it: npm-app-1 \(jc21\/nginx-proxy-manager:latest, publishes 80\/443\)/,
      );
      assert.match(output, /edge_default\s+<- reverse proxy on it: edge-traefik-1 \(traefik:v3\)/);
      assert.match(output, /metrics_default\s+1 container, not recognisably a reverse proxy/);
      assert.ok(listed("npm_default") < listed("metrics_default"), output);
      assert.ok(listed("edge_default") < listed("metrics_default"), output);

      assert.equal(settings(sandbox).proxy, "on");
      assert.equal(settings(sandbox).proxy_network, "npm_default");
      assert.ok(sandbox.app().networks.npm_default.includes("standard-red-notes-app"));
      assert.deepEqual(sandbox.app().ports, []);
    },
  );

  test(
    "answering no on a first install is remembered as a decision, and a wrong network name is asked again",
    { skip: needsTerminal.skip },
    async (t) => {
      assert.equal(needsTerminal.missing, "");
      const declined = createSandbox(t, { configured: false });
      const no = await execute(realScript, ["-qec", "bash ./deploy.sh --no-pull", "/dev/null"], {
        cwd: declined.checkout,
        input: "n\ny\n",
        env: declined.environment(),
      });
      assert.equal(no.status, 0, `${no.stdout}${no.stderr}`);
      assert.equal(settings(declined).proxy, "off");
      assert.equal(declined.app().ports.length, 1);

      // One proxy only, so there is a default; a typo is refused and asked again, by name.
      const typo = createSandbox(t, {
        configured: false,
        host: {
          networks: { npm_default: NPM_HOST.networks.npm_default },
          roster: [NPM_HOST.roster[0]],
        },
      });
      const retried = await execute(realScript, ["-qec", "bash ./deploy.sh --no-pull", "/dev/null"], {
        cwd: typo.checkout,
        input: "y\nnpm-default\nnpm_default\ny\n",
        env: typo.environment(),
      });
      const output = `${retried.stdout}${retried.stderr}`;
      assert.equal(retried.status, 0, output);
      assert.match(output, /'npm-default' is not one of the networks above/);
      assert.match(output, /Number or name .*\[1\]/);
      assert.equal(settings(typo).proxy_network, "npm_default");
    },
  );

  // ---------------------------------------------------------------------------------------
  // Deployments that never used a flag, and deployments made before anything was remembered
  // ---------------------------------------------------------------------------------------

  test("a deployment with nothing remembered runs the same commands as before and leaves no file behind", async (t) => {
    const sandbox = createSandbox(t);

    const dry = await sandbox.deploy(["--dry-run", "--no-backup"]);
    succeeded(dry);
    assert.deepEqual(
      dry.output.split("\n").filter((line) => line.includes("would ")),
      [
        `would run: env SRN_DEPLOY_REVISION=${sandbox.revision} docker compose -f ${dry.output.match(/Using Compose file (.*)/)[1]} up -d --build`,
        "would wait for container healthchecks, then probe the readiness endpoint",
        "would run node scripts/verify-deployment-identity.mjs against the live stack",
      ],
    );

    const real = await sandbox.deploy(ONE_SHOT);
    succeeded(real);
    assert.deepEqual(composeFiles(real.ups[0]), ["docker-compose.yml"]);
    assert.equal(real.ups[0].env.SRN_PROXY_NETWORK, undefined);
    assert.equal(real.ups[0].env.COMPOSE_PROJECT_NAME, undefined);
    assert.equal(sandbox.exists(STATE_FILE), false);
    assert.equal(sandbox.exists(GUARD_FILE), false);
    assert.equal(sandbox.app().ports.length, 1);
  });

  test("a proxy deployment made before anything was remembered is carried forward, not taken off the network", async (t) => {
    const sandbox = createSandbox(t);
    // What the previous deploy.sh left behind: the overlay applied, and no settings file.
    succeeded(
      await sandbox.deploy(["--proxy-network=npm_default", "--proxy-alias=notes-upstream", ...ONE_SHOT]),
    );
    rmSync(sandbox.file(STATE_FILE));
    rmSync(sandbox.file(GUARD_FILE), { force: true });

    const run = await sandbox.deploy(ONE_SHOT);
    succeeded(run);

    assert.match(run.output, /Nothing is remembered yet, but this deployment's app container was started/);
    assert.match(run.output, /Carrying that forward: this deploy stays on 'npm_default'/);
    assert.equal(run.ups[0].env.SRN_PROXY_NETWORK, "npm_default");
    assert.equal(run.ups[0].env.SRN_PROXY_ALIAS, "notes-upstream");
    assert.ok(sandbox.app().networks.npm_default.includes("notes-upstream"));
    assert.deepEqual(sandbox.app().ports, []);
    assert.equal(settings(sandbox).proxy_network, "npm_default");
    assert.equal(settings(sandbox).proxy_alias, "notes-upstream");
  });

  test("a network attached by hand does not turn a deployment into a proxy one", async (t) => {
    const sandbox = createSandbox(t);
    succeeded(await sandbox.deploy(ONE_SHOT));
    // `docker network connect metrics_default <app>`: an extra network, but the container was
    // not created from the proxy overlay.
    sandbox.editDocker((state) => {
      const app = Object.values(state.containers)[0];
      app.networks.metrics_default = [app.name];
      state.networks.metrics_default.members.push(app.name);
    });

    const run = await sandbox.deploy(ONE_SHOT);
    succeeded(run);
    assert.deepEqual(composeFiles(run.ups[0]), ["docker-compose.yml"]);
    assert.equal(sandbox.exists(STATE_FILE), false);
  });

  // ---------------------------------------------------------------------------------------
  // Which deployment: --single, --file and -p
  // ---------------------------------------------------------------------------------------

  test("-p and an inherited COMPOSE_PROJECT_NAME are remembered, so a redeploy cannot start a second stack", async (t) => {
    for (const [args, env] of [
      [["-p", "notes"], {}],
      [[], { COMPOSE_PROJECT_NAME: "notes" }],
    ]) {
      const sandbox = createSandbox(t);
      succeeded(await sandbox.deploy([...args, ...ONE_SHOT], { env }));
      assert.equal(settings(sandbox).project, "notes");

      const later = await sandbox.deploy(ONE_SHOT);
      succeeded(later);
      assert.equal(later.ups[0].env.COMPOSE_PROJECT_NAME, "notes");
      assert.deepEqual(
        Object.values(sandbox.docker().containers).map((container) => container.project),
        ["notes"],
        "a second stack was started beside the first",
      );
    }
  });

  test("--single is remembered, and goes behind a proxy with its own overlay", async (t) => {
    const sandbox = createSandbox(t, { configured: false });
    succeeded(await sandbox.deploy(["--single", "--proxy-network=npm_default", ...ONE_SHOT]));
    assert.equal(settings(sandbox).topology, "single");

    const later = await sandbox.deploy(ONE_SHOT);
    succeeded(later);
    assert.deepEqual(composeFiles(later.ups[0]), [
      "docker-compose.single.yml",
      "docker-compose.single.proxy.yml",
    ]);
    assert.deepEqual(Object.keys(sandbox.app().networks).sort(), [
      "npm_default",
      "standard-red-notes-single_assistant-pdf",
      "standard-red-notes-single_assistant-search",
      "standard-red-notes-single_default",
    ]);
    assert.deepEqual(sandbox.app().ports, []);
    // Compose only auto-loads an override beside docker-compose.yml, so there is nothing to
    // generate for this topology, and the summary must say the stack needs ./deploy.sh.
    assert.equal(sandbox.exists(GUARD_FILE), false);
    assert.match(later.output, /By hand: {3}start and restart this stack with \.\/deploy\.sh/);
  });

  test("--file is remembered relative to the checkout", async (t) => {
    const sandbox = createSandbox(t);
    // Beside docker-compose.yml, because Compose reads .env from the directory of the first
    // file it is given.
    cpSync(sandbox.file("docker-compose.yml"), sandbox.file("custom-stack.yml"));

    succeeded(await sandbox.deploy(["--file", "custom-stack.yml", ...ONE_SHOT]));
    assert.equal(settings(sandbox).topology, "file");
    assert.equal(settings(sandbox).compose_file, "custom-stack.yml");

    const later = await sandbox.deploy(ONE_SHOT);
    succeeded(later);
    assert.deepEqual(composeFiles(later.ups[0]), ["custom-stack.yml"]);
    assert.match(later.output, /Loaded: the stack in custom-stack\.yml/);
  });

  test("a command line that names a different deployment is refused, never merged with the remembered one", async (t) => {
    const sandbox = createSandbox(t);
    succeeded(await sandbox.deploy(["--proxy-network=npm_default", ...ONE_SHOT]));
    const stateBefore = sandbox.read(STATE_FILE);
    const containersBefore = JSON.stringify(sandbox.docker().containers);

    for (const [args, env, said] of [
      [["--single"], {}, /--single names a different deployment/],
      [["-p", "staging"], {}, /-p staging names a different deployment/],
      [[], { COMPOSE_PROJECT_NAME: "staging" }, /COMPOSE_PROJECT_NAME=staging in the environment names a different deployment/],
      [["--file", "docker-compose.single.yml"], {}, /--file docker-compose\.single\.yml names a different deployment/],
    ]) {
      const run = await sandbox.deploy([...args, ...ONE_SHOT], { env });
      assert.equal(run.status, 2, run.output);
      assert.match(run.output, said);
      assert.match(run.output, /--state-file/);
      assert.equal(run.calls.length, 0, "docker was reached before the refusal");
    }
    assert.equal(sandbox.read(STATE_FILE), stateBefore);
    assert.equal(JSON.stringify(sandbox.docker().containers), containersBefore);

    // Naming Compose's own default out loud is the same deployment, not a different one.
    const same = await sandbox.deploy(["-p", "standard-red-notes", ...ONE_SHOT]);
    succeeded(same);
    assert.equal(same.ups[0].env.SRN_PROXY_NETWORK, "npm_default");
  });

  test("--state-file keeps a second deployment apart from the first", async (t) => {
    const sandbox = createSandbox(t);
    succeeded(await sandbox.deploy(["--proxy-network=npm_default", ...ONE_SHOT]));
    const firstState = sandbox.read(STATE_FILE);

    const staging = ["--state-file", ".deploy-state.staging"];
    succeeded(await sandbox.deploy(["-p", "staging", ...staging, ...ONE_SHOT]));
    const later = await sandbox.deploy([...staging, ...ONE_SHOT]);
    succeeded(later);

    assert.equal(later.ups[0].env.COMPOSE_PROJECT_NAME, "staging");
    assert.deepEqual(
      composeFiles(later.ups[0]),
      ["docker-compose.yml"],
      "the staging stack inherited the first deployment's proxy network",
    );
    assert.equal(sandbox.app("staging").networks.npm_default, undefined);
    assert.ok(sandbox.app("standard-red-notes").networks.npm_default);
    assert.equal(sandbox.read(STATE_FILE), firstState);
    assert.equal(git(sandbox.checkout, "status", "--porcelain"), "");
  });

  // ---------------------------------------------------------------------------------------
  // A bare `docker compose up -d`
  // ---------------------------------------------------------------------------------------

  test(
    "a bare docker compose in the checkout renders exactly what deploy.sh deploys",
    { skip: needsRealCompose.skip },
    async (t) => {
      assert.equal(needsRealCompose.missing, "");
      const sandbox = createSandbox(t);
      const run = await sandbox.deploy(["--proxy-network=npm_default", "-p", "notes", ...ONE_SHOT]);
      succeeded(run);
      assert.match(run.output, /By hand: {3}'docker compose up -d' in .* deploys this too\./);

      const guard = sandbox.read(GUARD_FILE);
      assert.match(guard, /^# GENERATED by deploy\.sh from \.deploy-state\./);
      assert.equal(git(sandbox.checkout, "status", "--porcelain"), "");

      // Asked of Compose itself, with nothing in the environment: the project, the networks
      // the app joins and the ports it publishes, for a hand-typed command and for deploy.sh's.
      const render = (args, env = {}) => {
        const result = spawnSync(realDocker, ["compose", ...args, "config", "--format", "json"], {
          cwd: sandbox.checkout,
          encoding: "utf8",
          env: { ...cleanEnvironment, ...env },
        });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
      };
      const bare = render([]);
      const deployed = render(
        ["-f", "docker-compose.yml", "-f", "docker-compose.proxy.yml"],
        { COMPOSE_PROJECT_NAME: "notes", SRN_PROXY_NETWORK: "npm_default" },
      );
      assert.deepEqual(bare, deployed);
      assert.equal(bare.name, "notes");
      assert.deepEqual(bare.services.app.networks.proxy, { aliases: ["standard-red-notes-app"] });
      assert.equal(bare.services.app.ports, undefined);
      assert.equal(bare.networks.proxy.name, "npm_default");
      assert.equal(bare.networks.proxy.external, true);
      // Only the app joins the proxy network.
      for (const [name, service] of Object.entries(bare.services)) {
        if (name !== "app") {
          assert.equal(Object.keys(service.networks ?? {}).includes("proxy"), false, name);
        }
      }

      // And the double, driven by a bare `up`, ends up where deploy.sh left it.
      const before = sandbox.app("notes").networks;
      const bareUp = spawnSync("bash", ["-c", "docker compose up -d"], {
        cwd: sandbox.checkout,
        encoding: "utf8",
        env: sandbox.environment(),
      });
      assert.equal(bareUp.status, 0, bareUp.stderr);
      assert.deepEqual(sandbox.app("notes").networks, before);
      assert.deepEqual(sandbox.app("notes").ports, []);
      assert.equal(Object.keys(sandbox.docker().containers).length, 1);
    },
  );

  test(
    "the generated override follows the settings, and leaves with them",
    { skip: needsRealCompose.skip },
    async (t) => {
      assert.equal(needsRealCompose.missing, "");
      const sandbox = createSandbox(t);
      succeeded(await sandbox.deploy(["--proxy-network=npm_default", "--publish-ports", ...ONE_SHOT]));
      assert.match(sandbox.read(GUARD_FILE), /ports: !override\n\s+- "127\.0\.0\.1:\$\{APP_PORT:-3001\}:8080"/);

      succeeded(await sandbox.deploy(["--proxy-network=edge_default", "--no-publish-ports", ...ONE_SHOT]));
      assert.match(sandbox.read(GUARD_FILE), /name: "edge_default"/);
      assert.match(sandbox.read(GUARD_FILE), /ports: !reset \[\]/);

      const leaving = await sandbox.deploy(["--no-proxy", ...ONE_SHOT]);
      succeeded(leaving);
      assert.equal(
        sandbox.exists(GUARD_FILE),
        false,
        "a stale override would put a bare `docker compose up -d` back on the proxy network",
      );
    },
  );

  test("an override file the operator wrote is never touched", async (t) => {
    const sandbox = createSandbox(t);
    const mine = "services:\n  app:\n    labels:\n      owner: operator\n";
    writeFileSync(sandbox.file(GUARD_FILE), mine);

    const run = await sandbox.deploy(["--proxy-network=npm_default", ...ONE_SHOT]);
    succeeded(run);
    assert.equal(sandbox.read(GUARD_FILE), mine);
    assert.match(run.output, /exists and was not generated by this script, so it is left alone/);
    assert.match(run.output, /By hand: {3}start and restart this stack with \.\/deploy\.sh/);

    succeeded(await sandbox.deploy(["--no-proxy", ...ONE_SHOT]));
    assert.equal(sandbox.read(GUARD_FILE), mine);
  });

  test("deleting the settings with the stack removed forgets them, and retires the override generated from them", async (t) => {
    // The one way memory is lost: the file is deleted by hand AND nothing is left running to
    // read the proxy network back from. The override must not outlive the settings it copied,
    // or a bare `docker compose up -d` would deploy somewhere this script no longer does.
    const sandbox = createSandbox(t);
    succeeded(await sandbox.deploy(["--proxy-network=npm_default", ...ONE_SHOT]));
    assert.ok(sandbox.exists(GUARD_FILE), "the override was never generated");
    rmSync(sandbox.file(STATE_FILE));
    sandbox.editDocker((state) => {
      state.containers = {}; // docker compose down
    });

    const run = await sandbox.deploy(ONE_SHOT);
    succeeded(run);
    assert.deepEqual(composeFiles(run.ups[0]), ["docker-compose.yml"]);
    assert.equal(sandbox.exists(STATE_FILE), false);
    assert.equal(sandbox.exists(GUARD_FILE), false);
    assert.match(run.output, /generated from settings that are no longer remembered/);
  });

  test(
    "the generated override is removed again when Compose would not load it",
    { skip: needsRealCompose.skip },
    async (t) => {
      assert.equal(needsRealCompose.missing, "");
      const sandbox = createSandbox(t);
      // COMPOSE_FILE in .env makes a bare `docker compose` skip the override file entirely.
      writeFileSync(
        sandbox.file(".env"),
        "MYSQL_PASSWORD=fixture\nMYSQL_ROOT_PASSWORD=fixture\nCOMPOSE_FILE=docker-compose.yml\n",
      );
      const run = await sandbox.deploy(["--proxy-network=npm_default", ...ONE_SHOT]);
      succeeded(run);
      assert.match(run.output, /A bare 'docker compose' here does NOT render what this script deploys/);
      assert.equal(sandbox.exists(GUARD_FILE), false);
      assert.match(run.output, /By hand: {3}start and restart this stack with \.\/deploy\.sh/);
      // The deploy itself is unaffected.
      assert.ok(sandbox.app().networks.npm_default);
    },
  );

  // ---------------------------------------------------------------------------------------
  // The overlays, as Compose reads them
  // ---------------------------------------------------------------------------------------

  test(
    "Compose accepts the all-in-one overlay, and refuses the multi-container one on that stack",
    { skip: needsRealCompose.skip },
    async () => {
      assert.equal(needsRealCompose.missing, "");
      const render = (...files) =>
        spawnSync(
          realDocker,
          ["compose", ...files.flatMap((file) => ["-f", file]), "config", "--format", "json"],
          {
            cwd: root,
            encoding: "utf8",
            env: { ...cleanEnvironment, SRN_PROXY_NETWORK: "npm_default" },
          },
        );

      const single = render("docker-compose.single.yml", "docker-compose.single.proxy.yml");
      assert.equal(single.status, 0, single.stderr);
      const config = JSON.parse(single.stdout);
      assert.deepEqual(config.services.app.networks, {
        "assistant-pdf": null,
        "assistant-search": null,
        default: {},
        proxy: { aliases: ["standard-red-notes-app"] },
      });
      assert.equal(config.services.app.ports, undefined);
      assert.equal(config.networks.proxy.name, "npm_default");
      assert.equal(config.networks.proxy.external, true);

      const published = render(
        "docker-compose.single.yml",
        "docker-compose.single.proxy.yml",
        "docker-compose.proxy-publish.yml",
      );
      assert.equal(published.status, 0, published.stderr);
      assert.deepEqual(
        JSON.parse(published.stdout).services.app.ports.map((port) => port.host_ip),
        ["127.0.0.1"],
      );

      // Why the all-in-one stack has an overlay of its own.
      const wrong = render("docker-compose.single.yml", "docker-compose.proxy.yml");
      assert.notEqual(wrong.status, 0);
      assert.match(wrong.stderr, /undefined network standard-red-notes/);
    },
  );

  // ---------------------------------------------------------------------------------------
  // The project name Compose actually uses
  // ---------------------------------------------------------------------------------------

  test("a deployment whose .env was lost is recognised whatever the checkout directory is called", async (t) => {
    const sandbox = createSandbox(t, { configured: false });
    assert.notEqual(path.basename(sandbox.checkout), "standard-red-notes");
    // docker-compose.yml declares `name: standard-red-notes`, so that is the project its
    // volumes belong to -- not the directory's name.
    sandbox.editDocker((state) => {
      state.volumes = [
        { name: "standard-red-notes_mariadb-data", project: "standard-red-notes" },
      ];
    });

    const run = await sandbox.deploy(["--yes", "--no-pull"]);

    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /REFUSING to treat this as a first install\./);
    assert.match(run.output, /volumes: {4}standard-red-notes_mariadb-data/);
    assert.equal(sandbox.exists(".env"), false, "fresh secrets were generated over existing data");
    assert.equal(run.ups.length, 0);
  });

  test("flags that contradict each other, or mean nothing without a proxy, are refused up front", async (t) => {
    const sandbox = createSandbox(t);
    for (const [args, expected] of [
      [["--proxy-network=npm_default", "--no-proxy"], /--proxy-network and --no-proxy contradict each other/],
      [["--publish-ports", "--no-publish-ports"], /--publish-ports and --no-publish-ports contradict each other/],
      [["--no-proxy", "--create-network"], /--no-proxy leaves it/],
      [["--create-network"], /--create-network only means something with --proxy-network/],
      [["--publish-ports"], /--publish-ports only means something with --proxy-network/],
      [["--proxy-alias", "x"], /only mean something with --proxy-network/],
      [["--proxy-network=-rm"], /is not a Docker network name/],
      [["--proxy-network="], /was given an empty network name/],
      [["--proxy-network=npm_default", "--proxy-alias=bad alias"], /cannot be used as a network alias/],
      [["-p", "Not Valid"], /not a Compose project name/],
      [["--single", "--file", "x.yml"], /mutually exclusive/],
    ]) {
      const run = await sandbox.deploy([...args, ...ONE_SHOT]);
      assert.equal(run.status, 2, `${args.join(" ")}\n${run.output}`);
      assert.match(run.output, expected);
      assert.equal(run.calls.length, 0);
    }
    assert.equal(sandbox.exists(STATE_FILE), false);
  });
});

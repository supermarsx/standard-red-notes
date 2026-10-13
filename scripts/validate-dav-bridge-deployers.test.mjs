import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every environment variable the DAV bridge reads has to exist in THREE
 * deployers, or it is silently absent on one of them:
 *
 *   - docker-compose.yml: a bare name in the shared server environment reaches
 *     the api-gateway through the container environment;
 *   - docker-compose.single.yml TOGETHER WITH server/docker/single/entrypoint.sh:
 *     the entrypoint writes only the names it lists into the env file the
 *     backend reads, so a variable set on the container and not listed there
 *     never arrives. The CalDAV feed's switch was missing from that file once
 *     and the whole feature was dead on the all-in-one container;
 *   - deploy/lxc/install.sh, which writes its own env file.
 *
 * The list of variables is not written here. It is read from the code that
 * consumes them, so adding a variable to the bridge and forgetting a deployer
 * turns this red without anyone remembering to update a list.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(join(repoRoot, file), "utf8");

const FACTORY =
  "server/packages/api-gateway/src/Service/DavBridge/DavBridgeFactory.ts";

/** Names read through the env getter in the factory: get('DAV_BRIDGE_…'). */
function variablesReadBy(source) {
  return [
    ...new Set(
      [...source.matchAll(/\bget\('(DAV_BRIDGE_[A-Z0-9_]+)'\)/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
}

/** The body of the first heredoc that writes the home-server env file. */
function lxcEnvFile(source) {
  const start = source.indexOf('cat > "${HS_DIR}/.env" <<EOF');
  assert.ok(start >= 0, "deploy/lxc/install.sh no longer writes ${HS_DIR}/.env with a heredoc");
  const end = source.indexOf("\nEOF\n", start);
  assert.ok(end > start, "could not find the end of the LXC env heredoc");
  return source.slice(start, end);
}

/** The top-level `x-server-env` mapping of docker-compose.yml. */
function composeServerEnvironment(source) {
  const start = source.indexOf("x-server-env: &server-env");
  assert.ok(start >= 0, "docker-compose.yml no longer has the x-server-env anchor");
  const end = source.indexOf("\nservices:", start);
  assert.ok(end > start, "could not find the end of x-server-env");
  return source.slice(start, end);
}

test("the bridge reads the variables this contract expects to find (denominator)", async () => {
  const variables = variablesReadBy(await read(FACTORY));

  // If the factory stops reading its settings this way, every check below
  // would pass over an empty list. Pin the list so that cannot happen quietly.
  assert.deepEqual(variables, [
    "DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS",
    "DAV_BRIDGE_ALLOWLIST_ENV_ONLY",
    "DAV_BRIDGE_ALLOW_ALL_USERS",
    "DAV_BRIDGE_DATA_PATH",
    "DAV_BRIDGE_ENABLED",
    "DAV_BRIDGE_MAX_ACCOUNTS_PER_USER",
    "DAV_BRIDGE_MODE",
  ]);
});

test("docker-compose.yml passes every operator-set DAV bridge variable to the server container", async () => {
  const variables = variablesReadBy(await read(FACTORY));
  const environment = composeServerEnvironment(await read("docker-compose.yml"));

  for (const name of variables) {
    if (name === "DAV_BRIDGE_DATA_PATH") {
      // Not passed on compose on purpose: the gateway's default lands under
      // its data directory, which is the server-data volume there.
      continue;
    }
    assert.match(
      environment,
      new RegExp(`^  ${name}: \\$\\{${name}:-[^}]*\\}$`, "m"),
      `docker-compose.yml x-server-env does not pass ${name}`,
    );
  }
  // The data directory default is only safe while that directory is a volume.
  assert.match(
    await read("docker-compose.yml"),
    /- server-data:\/opt\/server\/packages\/api-gateway\/data\b/,
    "the api-gateway data directory is no longer a named volume on compose, so DAV bridge accounts would not survive a recreate",
  );
});

test("the all-in-one container receives every DAV bridge variable AND its entrypoint writes it", async () => {
  const variables = variablesReadBy(await read(FACTORY));
  const compose = await read("docker-compose.single.yml");
  const entrypoint = await read("server/docker/single/entrypoint.sh");

  for (const name of variables) {
    if (name === "DAV_BRIDGE_DATA_PATH") {
      // Always written, under the data volume; never taken from the operator.
      assert.match(
        entrypoint,
        /^put DAV_BRIDGE_DATA_PATH "\$\{DATA_DIR\}\/dav-bridge"$/m,
        "the single-container entrypoint does not put the DAV bridge data path on the data volume",
      );
      continue;
    }
    assert.match(
      compose,
      new RegExp(`^      ${name}: \\$\\{${name}:-[^}]*\\}$`, "m"),
      `docker-compose.single.yml does not pass ${name} to the container`,
    );
    assert.match(
      entrypoint,
      new RegExp(`^put_opt ${name} "\\$\\{${name}:-\\}"$`, "m"),
      `server/docker/single/entrypoint.sh does not write ${name}, so it never reaches the api-gateway on the all-in-one container`,
    );
  }
});

test("the LXC installer writes every DAV bridge variable into the env file", async () => {
  const variables = variablesReadBy(await read(FACTORY));
  const envFile = lxcEnvFile(await read("deploy/lxc/install.sh"));

  for (const name of variables) {
    assert.match(
      envFile,
      new RegExp(`^${name}=`, "m"),
      `deploy/lxc/install.sh does not write ${name}`,
    );
  }
  assert.match(
    envFile,
    /^DAV_BRIDGE_DATA_PATH=\$\{DATA_DIR\}\/dav-bridge$/m,
    "the LXC installer does not put the DAV bridge data path under the data directory",
  );
});

test("the bridge is off by default in every deployer", async () => {
  assert.match(
    composeServerEnvironment(await read("docker-compose.yml")),
    /^  DAV_BRIDGE_ENABLED: \$\{DAV_BRIDGE_ENABLED:-false\}$/m,
  );
  assert.match(
    await read("docker-compose.single.yml"),
    /^      DAV_BRIDGE_ENABLED: \$\{DAV_BRIDGE_ENABLED:-false\}$/m,
  );
  assert.match(
    lxcEnvFile(await read("deploy/lxc/install.sh")),
    /^DAV_BRIDGE_ENABLED=\$\{DAV_BRIDGE_ENABLED:-false\}$/m,
  );
  // No deployer grants the permission to everyone or opens a private origin.
  for (const file of ["docker-compose.yml", "docker-compose.single.yml", "deploy/lxc/install.sh"]) {
    const source = await read(file);
    assert.match(source, /DAV_BRIDGE_ALLOW_ALL_USERS[:=] ?\$\{DAV_BRIDGE_ALLOW_ALL_USERS:-false\}/, file);
    assert.match(source, /DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS[:=] ?\$\{DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS:-\}/, file);
  }
});

test("the home-server defaults the data path under its data directory", async () => {
  assert.match(
    await read("server/packages/home-server/src/Server/HomeServer.ts"),
    /DAV_BRIDGE_DATA_PATH: `\$\{dataDirectoryPath\}\/dav-bridge`,/,
  );
});

test("this contract fails when a deployer forgets a variable", async () => {
  // The same checks, run against copies with one line removed each, so a green
  // result above is known to be able to turn red.
  const variables = variablesReadBy(await read(FACTORY));
  const entrypoint = await read("server/docker/single/entrypoint.sh");
  const withoutMode = entrypoint.replace(
    'put_opt DAV_BRIDGE_MODE "${DAV_BRIDGE_MODE:-}"\n',
    "",
  );
  assert.notEqual(withoutMode, entrypoint, "the line this test removes is not there");

  const missing = variables.filter(
    (name) =>
      name !== "DAV_BRIDGE_DATA_PATH" &&
      !new RegExp(`^put_opt ${name} "\\$\\{${name}:-\\}"$`, "m").test(withoutMode),
  );
  assert.deepEqual(missing, ["DAV_BRIDGE_MODE"]);

  const lxc = lxcEnvFile(await read("deploy/lxc/install.sh"));
  const lxcWithoutList = lxc.replace(/^DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS=.*\n/m, "");
  assert.notEqual(lxcWithoutList, lxc);
  assert.deepEqual(
    variables.filter((name) => !new RegExp(`^${name}=`, "m").test(lxcWithoutList)),
    ["DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS"],
  );

  // A variable added to the factory and to no deployer is caught as well.
  const factoryWithNew = `${await read(FACTORY)}\nconst x = get('DAV_BRIDGE_NEW_SETTING')\n`;
  assert.ok(variablesReadBy(factoryWithNew).includes("DAV_BRIDGE_NEW_SETTING"));
  assert.equal(
    new RegExp('^put_opt DAV_BRIDGE_NEW_SETTING "', "m").test(entrypoint),
    false,
  );
});

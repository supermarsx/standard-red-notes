#!/usr/bin/env node
/**
 * A test double for the `docker` CLI, used only by deploy-remembered-settings.test.mjs.
 *
 * deploy.sh cannot be exercised without Docker, and a test that really builds and starts the
 * stack takes minutes and needs a daemon. This double answers the daemon-side questions
 * deploy.sh asks (does this network exist, which containers does the project own, what is the
 * app container attached to) from a JSON file, records every invocation in it, and turns
 * `compose up` into a state change, so two deploys in a row can be asserted on.
 *
 * What it deliberately does NOT fake is Compose's merge rules. When a real docker binary is
 * available (SRN_DOCKER_DOUBLE_REAL), every `compose config` is delegated to it, and the app
 * container that `up` "creates" is derived from Compose's own rendering of the same -f list and
 * environment. That is client-side work and needs no daemon. An overlay that Compose would
 * refuse, or would merge differently from what deploy.sh assumes, therefore fails here too.
 * Without a real binary the double falls back to reading file names and the environment, which
 * is enough for the flow tests and is why the Compose-semantics tests skip in that case.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const statePath = process.env.SRN_DOCKER_DOUBLE_STATE;
const realDocker = process.env.SRN_DOCKER_DOUBLE_REAL || "";
const argv = process.argv.slice(2);

if (!statePath) {
  process.stderr.write("docker double: SRN_DOCKER_DOUBLE_STATE is not set\n");
  process.exit(98);
}

const state = JSON.parse(readFileSync(statePath, "utf8"));
state.networks ??= {};
state.containers ??= {};
state.roster ??= [];
state.volumes ??= [];
state.calls ??= [];
state.calls.push({
  argv,
  cwd: process.cwd(),
  env: Object.fromEntries(
    [
      "COMPOSE_PROJECT_NAME",
      "SRN_PROXY_NETWORK",
      "SRN_PROXY_ALIAS",
      "SRN_DEPLOY_REVISION",
    ]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  ),
});

function finish(code, stdout = "", stderr = "") {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}

function unknown(what) {
  // Loud on purpose: a call this double does not understand must not be mistaken for an
  // empty answer, which deploy.sh would read as "no containers" or "no such network".
  finish(97, "", `docker double: unhandled ${what}: ${JSON.stringify(argv)}\n`);
}

function slashes(value) {
  return value.replace(/\\/g, "/");
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function envFileValue(name) {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, "m").exec(
    readText(path.join(process.cwd(), ".env")),
  );
  return match ? match[1].trim().replace(/^(["'])(.*)\1$/, "$2") : "";
}

function variable(name) {
  return process.env[name] ?? envFileValue(name);
}

/** The -f list Compose would use: the explicit one, or its own default discovery. */
function composeFiles(explicit) {
  if (explicit.length > 0) {
    return explicit.map((file) => path.resolve(file));
  }
  const base = path.join(process.cwd(), "docker-compose.yml");
  const override = path.join(process.cwd(), "docker-compose.override.yml");
  return existsSync(override) ? [base, override] : [base];
}

function missingRequiredVariables(files) {
  const missing = [];
  for (const file of files) {
    for (const match of readText(file).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?/g)) {
      if (!variable(match[1])) missing.push(match[1]);
    }
  }
  return [...new Set(missing)];
}

/** Compose's project-name precedence, without rendering anything. */
function projectName(files) {
  const fromEnvironment = variable("COMPOSE_PROJECT_NAME");
  if (fromEnvironment) return fromEnvironment;
  let name = "";
  for (const file of files) {
    const match = /^name:\s*["']?([A-Za-z0-9_.-]+)/m.exec(readText(file));
    if (match) name = match[1];
  }
  return (
    name ||
    path
      .basename(path.dirname(files[0]))
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
  );
}

/**
 * What `up` would create for the app service: its project, the networks it joins (real names,
 * aliases, whether external) and its published ports.
 */
function effectiveApp(explicitFiles) {
  const files = composeFiles(explicitFiles);

  if (realDocker) {
    const arguments_ = ["compose"];
    for (const file of explicitFiles) arguments_.push("-f", file);
    arguments_.push("config", "--format", "json");
    const rendered = spawnSync(realDocker, arguments_, { encoding: "utf8" });
    if (rendered.status !== 0) {
      finish(rendered.status ?? 1, "", rendered.stderr);
    }
    const config = JSON.parse(rendered.stdout);
    const app = config.services?.app ?? {};
    return {
      files,
      project: config.name,
      networks: Object.entries(app.networks ?? {}).map(([key, value]) => ({
        name: config.networks?.[key]?.name ?? `${config.name}_${key}`,
        aliases: value?.aliases ?? [],
        external: Boolean(config.networks?.[key]?.external),
      })),
      ports: (app.ports ?? []).map((port) => ({
        hostIp: port.host_ip ?? "0.0.0.0",
        published: String(port.published),
      })),
    };
  }

  const names = files.map((file) => path.basename(slashes(file)));
  const project = projectName(files);
  const single = names.includes("docker-compose.single.yml");
  const networks = [
    {
      name: single ? `${project}_default` : `${project}_standard-red-notes`,
      aliases: [],
      external: false,
    },
  ];
  let ports = [
    {
      hostIp: variable("APP_BIND_ADDRESS") || "0.0.0.0",
      published: variable("APP_PORT") || "3001",
    },
  ];
  const loopback = [
    { hostIp: "127.0.0.1", published: variable("APP_PORT") || "3001" },
  ];
  if (
    names.includes("docker-compose.proxy.yml") ||
    names.includes("docker-compose.single.proxy.yml")
  ) {
    networks.push({
      name: variable("SRN_PROXY_NETWORK") || "proxy",
      aliases: [variable("SRN_PROXY_ALIAS") || "standard-red-notes-app"],
      external: true,
    });
    ports = names.includes("docker-compose.proxy-publish.yml") ? loopback : [];
  }
  const override = files.find(
    (file) => path.basename(slashes(file)) === "docker-compose.override.yml",
  );
  if (override) {
    const text = readText(override);
    const network = /^networks:\n {2}proxy:\n {4}name: "([^"]+)"/m.exec(text);
    const alias = /aliases:\n\s+- "([^"]+)"/.exec(text);
    if (network) {
      networks.push({
        name: network[1],
        aliases: alias ? [alias[1]] : [],
        external: true,
      });
      ports = /ports: !override/.test(text) ? loopback : [];
    }
  }
  return { files, project, networks, ports };
}

function containersOf(project) {
  return Object.entries(state.containers)
    .filter(([, container]) => container.project === project)
    .map(([id, container]) => ({ id, ...container }));
}

function findContainer(reference) {
  for (const [id, container] of Object.entries(state.containers)) {
    if (
      id === reference ||
      id.startsWith(reference) ||
      container.name === reference
    ) {
      return { id, ...container };
    }
  }
  return null;
}

function compose(args) {
  const explicit = [];
  let index = 0;
  while (index < args.length) {
    if (args[index] === "-f" || args[index] === "--file") {
      explicit.push(args[index + 1]);
      index += 2;
    } else {
      break;
    }
  }
  const [subcommand, ...rest] = args.slice(index);
  const files = composeFiles(explicit);

  if (subcommand === "version") {
    finish(0, "Docker Compose version v0.0.0-double\n");
  }

  if (subcommand === "config") {
    if (realDocker) {
      const real = spawnSync(realDocker, ["compose", ...args], {
        stdio: "inherit",
      });
      finish(real.status ?? 1);
    }
    for (const file of files) {
      if (!existsSync(file)) finish(1, "", `open ${file}: no such file\n`);
    }
    const missing = missingRequiredVariables(files);
    if (missing.length > 0) {
      finish(
        1,
        "",
        `required variable ${missing[0]} is missing a value\n`,
      );
    }
    if (rest.includes("--quiet")) finish(0);
    if (rest.includes("--services")) {
      const services = /^services:\n((?: {2}.*\n|\n)*)/m.exec(
        readText(files[0]),
      );
      const names = [
        ...(services?.[1] ?? "").matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm),
      ].map((match) => match[1]);
      finish(0, `${names.join("\n")}\n`);
    }
    const { project, networks, ports } = effectiveApp(explicit);
    finish(0, `${JSON.stringify({ project, networks, ports })}\n`);
  }

  if (subcommand === "ps") {
    const missing = missingRequiredVariables(files);
    if (missing.length > 0) {
      finish(
        1,
        "",
        `required variable ${missing[0]} is missing a value\n`,
      );
    }
    const all = rest.includes("-a");
    const service = rest.find((value) => !value.startsWith("-"));
    const listed = containersOf(projectName(files)).filter(
      (container) =>
        (all || container.state === "running") &&
        (!service || container.service === service),
    );
    if (rest.includes("-q")) {
      finish(0, listed.map((container) => `${container.id}\n`).join(""));
    }
    finish(
      0,
      listed
        .map((container) => `${container.name} ${container.state}\n`)
        .join(""),
    );
  }

  if (subcommand === "port") {
    const app = containersOf(projectName(files)).find(
      (container) => container.service === "app",
    );
    const port = app?.ports?.[0];
    finish(0, port ? `${port.hostIp}:${port.published}\n` : "");
  }

  if (subcommand === "up") {
    const app = effectiveApp(explicit);
    for (const network of app.networks) {
      if (network.external && !state.networks[network.name]) {
        finish(
          1,
          "",
          `network ${network.name} declared as external, but could not be found\n`,
        );
      }
    }
    const name = `${app.project}-app-1`;
    for (const [id, container] of Object.entries(state.containers)) {
      if (container.project === app.project && container.service === "app") {
        delete state.containers[id];
      }
    }
    for (const network of Object.values(state.networks)) {
      network.members = (network.members ?? []).filter(
        (member) => member !== name,
      );
    }
    for (const network of app.networks) {
      state.networks[network.name] ??= { project: app.project, members: [] };
      state.networks[network.name].members.push(name);
    }
    state.containers[randomBytes(32).toString("hex")] = {
      name,
      service: "app",
      project: app.project,
      image: `${app.project}/app:double`,
      state: "running",
      health: "healthy",
      exit: 0,
      revision: process.env.SRN_DEPLOY_REVISION ?? "",
      configFiles: app.files,
      networks: Object.fromEntries(
        app.networks.map((network) => [
          network.name,
          [name, "app", ...network.aliases],
        ]),
      ),
      ports: app.ports,
    };
    finish(0, "", ` Container ${name} Started\n`);
  }

  if (subcommand === "logs" || subcommand === "exec") {
    finish(0);
  }

  unknown("compose subcommand");
}

/** Splits `[--format FORMAT] NAME...` into the format and the names. */
function splitFormat(args) {
  const index = args.indexOf("--format");
  return {
    format: index === -1 ? "" : args[index + 1],
    names: args.filter(
      (value, position) =>
        (index === -1 || (position !== index && position !== index + 1)) &&
        !value.startsWith("-"),
    ),
  };
}

function inspect(args) {
  const { format, names } = splitFormat(args);
  const reference = names[0];
  const container = findContainer(reference ?? "");
  if (!container) {
    finish(1, "", `Error response from daemon: No such object: ${reference}\n`);
  }
  if (format === "{{.Name}}") finish(0, `/${container.name}\n`);
  if (format.includes("com.docker.compose.project.config_files")) {
    finish(0, `${container.configFiles.join(",")}\n`);
  }
  if (format.includes("com.docker.compose.service")) {
    finish(0, `${container.service}\n`);
  }
  if (format.includes('"com.docker.compose.project"')) {
    finish(0, `${container.project}\n`);
  }
  if (format === "{{.State.Status}}") finish(0, `${container.state}\n`);
  if (format === "{{.State.Running}}") {
    finish(0, `${container.state === "running"}\n`);
  }
  if (format.includes(".State.Health")) finish(0, `${container.health}\n`);
  if (format === "{{.State.ExitCode}}") finish(0, `${container.exit}\n`);
  if (format === "{{.Config.Image}}") finish(0, `${container.image}\n`);
  if (format.includes("with index .NetworkSettings.Networks")) {
    const wanted = /Networks "([^"]+)"/.exec(format)?.[1] ?? "";
    const aliases = container.networks[wanted] ?? [];
    finish(0, `${aliases.map((alias) => `${alias} `).join("")}\n`);
  }
  if (format.includes(".NetworkSettings.Networks")) {
    finish(
      0,
      `${Object.keys(container.networks)
        .map((name) => `${name} `)
        .join("")}\n`,
    );
  }
  if (format.includes(".HostConfig.PortBindings")) {
    finish(0, container.ports.length > 0 ? "8080/tcp \n" : "\n");
  }
  unknown("inspect format");
}

function network(args) {
  const [subcommand, ...rest] = args;
  if (subcommand === "ls") {
    finish(
      0,
      ["bridge", "host", "none", ...Object.keys(state.networks)]
        .map((name) => `${name}\n`)
        .join(""),
    );
  }
  if (subcommand === "create") {
    state.networks[rest.at(-1)] = { project: "", members: [] };
    finish(0, `${randomBytes(32).toString("hex")}\n`);
  }
  if (subcommand === "inspect") {
    const { format, names } = splitFormat(rest);
    const builtin = { project: "", members: [] };
    const lines = [];
    for (const name of names) {
      const found =
        state.networks[name] ??
        (["bridge", "host", "none"].includes(name) ? builtin : null);
      if (!found) {
        finish(
          1,
          lines.join(""),
          `Error response from daemon: network ${name} not found\n`,
        );
      }
      if (format.startsWith("{{.Name}}|")) {
        lines.push(
          `${name}|${found.project ?? ""}|${(found.members ?? [])
            .map((member) => `${member} `)
            .join("")}\n`,
        );
      } else if (format.includes("com.docker.compose.project")) {
        lines.push(`${found.project ?? ""}\n`);
      } else if (format === "") {
        lines.push(`[{"Name":"${name}"}]\n`);
      } else {
        unknown("network inspect format");
      }
    }
    finish(0, lines.join(""));
  }
  unknown("network subcommand");
}

function run(args) {
  // docker run --rm --network NET --entrypoint sh IMAGE -c "wget -qO- ... http://ALIAS:8080/PATH"
  const networkName = args[args.indexOf("--network") + 1];
  const url = /http:\/\/([^:/\s]+):8080(\/\S*)/.exec(args.at(-1) ?? "");
  if (!url) unknown("run command");
  const target = Object.values(state.containers).find((container) =>
    (container.networks[networkName] ?? []).includes(url[1]),
  );
  if (!state.networks[networkName] || !target) {
    finish(1, "", `wget: bad address '${url[1]}:8080'\n`);
  }
  const identity = `"revision":"${target.revision}","version":"src-${target.revision.slice(0, 12)}"`;
  if (url[2].includes("srn-deployment.json")) {
    finish(0, `{${identity}}`);
  }
  finish(0, `{"status":"ready","deployment":{${identity}}}`);
}

const [command, ...args] = argv;
if (command === "info") finish(0, "double\n");
if (command === "compose") compose(args);
if (command === "inspect") inspect(args);
if (command === "network") network(args);
if (command === "run") run(args);
if (command === "ps") {
  finish(
    0,
    [
      ...state.roster,
      ...Object.values(state.containers).map((container) => ({
        name: container.name,
        image: container.image,
        ports: container.ports
          .map((port) => `${port.hostIp}:${port.published}->8080/tcp`)
          .join(", "),
      })),
    ]
      .map((entry) => `${entry.name}|${entry.image}|${entry.ports ?? ""}\n`)
      .join(""),
  );
}
if (command === "volume" && args[0] === "ls") {
  const filter = args.find((value) => value.startsWith("label="));
  const project = filter?.split("=").at(-1) ?? "";
  finish(
    0,
    state.volumes
      .filter((volume) => volume.project === project)
      .map((volume) => `${volume.name}\n`)
      .join(""),
  );
}
unknown("command");

#!/usr/bin/env node
/** Health-gated frontend releases. Backend containers and routes stay in place. */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = "/etc/nginx/conf.d/default.conf";
const safeName = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,150}$/.test(value);

function privateJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Deployment metadata was not valid JSON.");
  }
}

export function assertFrontDoorCompatible({
  service,
  environment,
  bindings,
  networks,
  networkDefinitions,
  project,
  frontName,
}) {
  const changed = [
    "PUBLIC_URL",
    "ENFORCE_HTTPS_FROM_PROXY",
    "APP_BIND_ADDRESS",
  ].filter(
    (name) =>
      String(environment[name] ?? "") !==
      String(service.environment?.[name] ?? ""),
  );
  const actualPorts = Object.entries(bindings ?? {})
    .flatMap(([target, entries]) =>
      (entries ?? []).map(
        (entry) => `${entry.HostIp || "0.0.0.0"}:${entry.HostPort}:${target}`,
      ),
    )
    .sort();
  const desiredPorts = (service.ports ?? [])
    .map(
      (entry) =>
        `${entry.host_ip || "0.0.0.0"}:${entry.published}:${entry.target}/${entry.protocol || "tcp"}`,
    )
    .sort();
  if (JSON.stringify(actualPorts) !== JSON.stringify(desiredPorts))
    changed.push("published ports");
  const desiredNetworks = Object.fromEntries(
    Object.entries(service.networks ?? {}).map(([key, settings]) => [
      networkDefinitions?.[key]?.name ?? `${project}_${key}`,
      (settings?.aliases ?? [])
        .filter((alias) => alias !== "app" && alias !== frontName)
        .sort(),
    ]),
  );
  const actualNetworks = Object.fromEntries(
    Object.entries(networks ?? {}).map(([name, settings]) => [
      name,
      (settings.Aliases ?? [])
        .filter((alias) => alias !== "app" && alias !== frontName)
        .sort(),
    ]),
  );
  const canonical = (value) =>
    JSON.stringify(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  if (canonical(actualNetworks) !== canonical(desiredNetworks))
    changed.push("networks or aliases");
  if (changed.length)
    throw new Error(
      `Front-door settings changed (${changed.join(", ")}); use a conventional full deploy before web handovers.`,
    );
}

export function backendServicesForUpdate(services, enabledProfiles = "") {
  const profiles = new Set(enabledProfiles.split(",").filter(Boolean));
  const selected = Object.entries(services)
    .filter(
      ([name, service]) =>
        name !== "app" &&
        (!service.profiles?.length ||
          profiles.has("*") ||
          service.profiles.some((profile) => profiles.has(profile))),
    )
    .map(([name]) => name);
  const seen = new Set();
  const visit = (name) => {
    if (name === "app")
      throw new Error(
        "A backend service depends on the public app; this custom topology cannot use a web handover.",
      );
    if (seen.has(name)) return;
    seen.add(name);
    const service = services[name] ?? {};
    for (const dependency of Object.keys(service.depends_on ?? {}))
      visit(dependency);
    const references = [
      ...(service.links ?? []),
      ...(service.volumes_from ?? []),
    ];
    if (
      references.some((value) => value.split(":")[0] === "app") ||
      service.network_mode === "service:app" ||
      service.ipc === "service:app"
    )
      visit("app");
  };
  selected.forEach(visit);
  return selected;
}

// Balance nginx blocks without interpreting braces in comments or strings.
export function locationBlocks(source) {
  const blocks = [];
  const pattern = /^  location ([^\n{]+)\{/gm;
  let match;
  while ((match = pattern.exec(source))) {
    let depth = 1,
      quote = "",
      comment = false,
      escaped = false,
      end = pattern.lastIndex;
    for (; end < source.length && depth; end++) {
      const char = source[end];
      if (comment) {
        if (char === "\n") comment = false;
        continue;
      }
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "#") {
        comment = true;
        continue;
      }
      if (char === "{") depth++;
      if (char === "}") depth--;
    }
    if (depth)
      throw new Error("Unbalanced nginx location; frontend was not changed.");
    blocks.push({ start: match.index, end, selector: match[1].trim() });
    pattern.lastIndex = end;
  }
  return blocks;
}

export function frontendConfig(source, active, previous) {
  if (!safeName(active) || (previous && !safeName(previous)))
    throw new Error("Invalid release container name.");
  if (
    !source.includes("resolver 127.0.0.11") ||
    source.includes("srn_rollout_active")
  ) {
    throw new Error("Expected the original bundled web nginx configuration.");
  }
  const blocks = locationBlocks(source);
  const staticSelectors = new Set([
    "/",
    "= /.well-known/srn-deployment.json",
    "/components/",
    "= /sandbox.html",
  ]);
  const proxy = (
    selector,
    target,
    fallback = false,
  ) => `  location ${selector} {
    set $srn_rollout_active ${target}:8080;
    proxy_pass http://$srn_rollout_active$request_uri;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $srn_forwarded_for;
    proxy_set_header X-Forwarded-Proto $srn_forwarded_proto;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_connect_timeout 5s;
    proxy_read_timeout 60s;
    ${fallback ? "proxy_intercept_errors on;\n    error_page 404 = @srn_rollout_previous;" : ""}
  }`;
  let result = source,
    replaced = 0;
  for (const block of [...blocks].reverse()) {
    if (
      !staticSelectors.has(block.selector) &&
      !block.selector.startsWith("~ ^/assets/pdf/")
    )
      continue;
    let replacement = proxy(block.selector, active, block.selector === "/");
    if (block.selector === "/") {
      // Keep the original shell's CSP pin in an unreachable named location.
      // The original container's restart entrypoint still verifies its own shell.
      const original = source
        .slice(block.start, block.end)
        .replace("location / {", "location @srn_rollout_bootstrap {");
      const oldAssets = previous
        ? proxy("@srn_rollout_previous", previous)
        : `  location @srn_rollout_previous { try_files $uri =404; }`;
      const guarded = oldAssets.replace(
        "{",
        '{\n    if ($uri !~ "^/([0-9a-f]{20}\\.worker\\.js|[^/]+\\.[0-9a-f]{20}\\.app\\.(js|css))$") { return 404; }',
      );
      replacement = `${original}\n${replacement}\n${guarded}`;
    }
    result =
      result.slice(0, block.start) + replacement + result.slice(block.end);
    replaced++;
  }
  if (replaced !== 5)
    throw new Error(
      "The web nginx layout changed; no configuration was installed.",
    );
  return result;
}

function command(
  binary,
  args,
  { capture = true, allowFailure = false, input, timeoutMs } = {},
) {
  const result = spawnSync(binary, args, {
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: capture ? "pipe" : "inherit",
    windowsHide: true,
    timeout: timeoutMs,
  });
  if (result.error && !allowFailure) throw result.error;
  if (result.status !== 0 && !allowFailure)
    throw new Error(
      `${path.basename(binary)} ${args[0]} failed (exit ${result.status}).`,
    );
  return { ok: result.status === 0, stdout: result.stdout?.trim() ?? "" };
}

export async function deployWeb(
  {
    compose,
    timeout = 600,
    skipBuild = false,
    rollback = false,
    fullUpdate = false,
    stateRoot = path.resolve(".deploy-web"),
  },
  {
    run = command,
    now = Date.now,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const [binary, ...prefix] = compose;
  if (!binary) throw new Error("Pass the Compose command after --.");
  const cc = (...args) => run(binary, [...prefix, ...args]);
  const docker = (...args) => run("docker", args);
  // Compose config can carry credentials: parse it privately; never log it.
  const config = privateJson(cc("config", "--format", "json").stdout);
  const project = config.name;
  if (!safeName(project) || !config.services.app || !config.services.server)
    throw new Error(
      "Web handover requires the bundled Compose stack with separate app/server services.",
    );
  if (!Number.isSafeInteger(timeout) || timeout < 1)
    throw new Error("Timeout must be a positive integer in seconds.");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(stateRoot, `${project}.lock`);
  mkdirSync(lock, { mode: 0o700 });
  const stateFile = path.join(stateRoot, `${project}.json`);
  let candidate,
    backupCandidate,
    switched = false,
    committed = false,
    restore;
  try {
    const ids = cc("ps", "-q", "app").stdout.split(/\s+/).filter(Boolean);
    if (ids.length !== 1)
      throw new Error("Exactly one running public app container is required.");
    const front = ids[0];
    const frontEnvironment = Object.fromEntries(
      privateJson(
        docker("inspect", "--format", "{{json .Config.Env}}", front).stdout,
      ).map((value) => {
        const separator = value.indexOf("=");
        return [value.slice(0, separator), value.slice(separator + 1)];
      }),
    );
    assertFrontDoorCompatible({
      service: config.services.app,
      environment: frontEnvironment,
      bindings: privateJson(
        docker(
          "inspect",
          "--format",
          "{{json .HostConfig.PortBindings}}",
          front,
        ).stdout,
      ),
      networks: privateJson(
        docker(
          "inspect",
          "--format",
          "{{json .NetworkSettings.Networks}}",
          front,
        ).stdout,
      ),
      networkDefinitions: config.networks,
      project,
      frontName: docker(
        "inspect",
        "--format",
        "{{.Name}}",
        front,
      ).stdout.replace(/^\//, ""),
    });
    let state = existsSync(stateFile)
      ? privateJson(readFileSync(stateFile, "utf8"))
      : undefined;
    const currentPath = path.join(lock, "current.conf");
    docker("cp", `${front}:${CONFIG}`, currentPath);
    const current = readFileSync(currentPath, "utf8");
    // A normal/full-stack deploy replaces the public container and resets this layer.
    if (state?.front !== front)
      state = { front, base: current, active: null, previous: null };
    // Refuse unsupported front-door layouts before any backend update begins.
    frontendConfig(state.base, "srn-handover-preflight");
    // Each readiness phase gets its own budget. Docker start_period is only a
    // healthcheck grace period, never the deployment startup deadline.
    const waitFor = async (description, probe) => {
      const deadline = now() + timeout * 1000;
      while (true) {
        const remaining = deadline - now();
        if (remaining <= 0)
          throw new Error(
            `${description} timed out; routing has not been committed.`,
          );
        if (probe(Math.min(10000, remaining))) return;
        await pause(Math.min(1000, Math.max(0, deadline - now())));
      }
    };
    const healthy = (name, timeoutMs = 10000) => {
      const status = run(
        "docker",
        ["inspect", "--format", "{{.State.Health.Status}}", name],
        { allowFailure: true, timeoutMs },
      );
      return status.ok && status.stdout === "healthy";
    };
    const waitHealthy = (name) =>
      waitFor("Replacement frontend health", (timeoutMs) => {
        const deadline = now() + timeoutMs;
        if (healthy(name, timeoutMs)) return true;
        if (now() >= deadline) return false;
        const status = run(
          "docker",
          ["inspect", "--format", "{{.State.Status}}", name],
          { allowFailure: true, timeoutMs: Math.max(1, deadline - now()) },
        );
        if (status.ok && ["exited", "dead"].includes(status.stdout))
          throw new Error(
            "Replacement frontend exited; the current release is unchanged.",
          );
        return false;
      });
    const reachable = (url, timeoutMs) =>
      run(
        "docker",
        [
          "exec",
          front,
          "wget",
          "-qO-",
          "--timeout=5",
          "--header=X-Forwarded-Proto: https",
          url,
        ],
        { allowFailure: true, timeoutMs },
      ).ok;
    const install = (contents) => {
      // /tmp is tmpfs in the bundled app. docker cp can write beneath that
      // mount; write through the running container's namespace instead.
      run(
        "docker",
        [
          "exec",
          "-i",
          front,
          "sh",
          "-c",
          "umask 077; cat > /tmp/srn-web-rollout.next.conf",
        ],
        { input: contents },
      );
      // Running workers keep their configuration until the validated reload.
      docker(
        "exec",
        front,
        "sh",
        "-c",
        `cp ${CONFIG} /tmp/srn-web-rollout.backup.conf && cp /tmp/srn-web-rollout.next.conf ${CONFIG} && if nginx -t && nginx -s reload; then :; else cp /tmp/srn-web-rollout.backup.conf ${CONFIG}; exit 1; fi`,
      );
    };
    restore = () => install(current);
    let active, previous;
    if (rollback) {
      if (!state.previous || !healthy(state.previous))
        throw new Error("No healthy previous frontend release is available.");
      active = state.previous;
      previous = state.active;
    } else {
      if (!skipBuild) {
        console.log(
          "Building the web image while the current frontend keeps serving.",
        );
        run(binary, [...prefix, "build", "app"], { capture: false });
      }
      candidate = `${project.slice(0, 32)}-web-${now().toString(36)}-${randomBytes(3).toString("hex")}`;
      // Compose run inherits runtime settings/networks but publishes no host port.
      cc(
        "run",
        "-d",
        "--no-deps",
        "--name",
        candidate,
        "--label",
        `srn.web-rollout.project=${project}`,
        "app",
      );
      docker("update", "--restart", "unless-stopped", candidate);
      console.log("Waiting for the replacement frontend to become healthy.");
      await waitHealthy(candidate);
      active = candidate;
      previous = state.active;
      if (previous) {
        // Rebuilding the same web release during a backend-only change should
        // not evict the last distinct frontend (and its old lazy chunks).
        const runtimeIdentity = (name) =>
          JSON.stringify({
            image: docker("inspect", "--format", "{{.Image}}", name).stdout,
            environment: privateJson(
              docker("inspect", "--format", "{{json .Config.Env}}", name)
                .stdout,
            ).sort(),
          });
        if (runtimeIdentity(candidate) === runtimeIdentity(previous))
          previous = state.previous ?? previous;
      }
      if (!previous) {
        // Bootstrap rollback/old chunks from the exact image and runtime values
        // currently served by the public container. Its address never changes.
        const image = docker("inspect", "--format", "{{.Image}}", front).stdout;
        const environment = Object.fromEntries(
          privateJson(
            docker("inspect", "--format", "{{json .Config.Env}}", front).stdout,
          ).map((value) => {
            const separator = value.indexOf("=");
            return [value.slice(0, separator), value.slice(separator + 1)];
          }),
        );
        const backupFile = path.join(lock, "bootstrap.json");
        writeFileSync(
          backupFile,
          JSON.stringify({ services: { app: { image, environment } } }),
          { mode: 0o600 },
        );
        backupCandidate = `${project.slice(0, 32)}-web-bootstrap-${randomBytes(4).toString("hex")}`;
        run(binary, [
          ...prefix,
          "-f",
          backupFile,
          "run",
          "-d",
          "--no-deps",
          "--name",
          backupCandidate,
          "--label",
          `srn.web-rollout.project=${project}`,
          "app",
        ]);
        docker("update", "--restart", "unless-stopped", backupCandidate);
        await waitHealthy(backupCandidate);
        previous = backupCandidate;
      }
    }
    // Prove the stable front door can resolve/reach the replacement privately.
    await waitFor("Replacement frontend reachability", (timeoutMs) =>
      reachable(`http://${active}:8080/health`, timeoutMs),
    );
    // Validate the replacement before disrupting any currently serving backend.
    if (fullUpdate && !rollback) {
      const services = backendServicesForUpdate(
        config.services,
        process.env.COMPOSE_PROFILES,
      );
      if (!services.length) throw new Error("No backend services found.");
      console.log(
        "Updating backend services while the current web frontend keeps serving.",
      );
      run(binary, [...prefix, "up", "-d", "--build", ...services], {
        capture: false,
      });
    }
    console.log(
      "Waiting for backend readiness through the existing public frontend before handover.",
    );
    await waitFor("Backend readiness", (timeoutMs) =>
      reachable("http://127.0.0.1:8080/healthcheck/readiness", timeoutMs),
    );
    const expected = Object.fromEntries(
      ["index.html", "app.js"].map((file) => {
        const hash = docker(
          "exec",
          active,
          "sha256sum",
          `/usr/share/nginx/html/${file}`,
        ).stdout.split(/\s+/)[0];
        if (!/^[0-9a-f]{64}$/.test(hash))
          throw new Error(
            "Replacement web shell/bundle could not be verified.",
          );
        return [file, hash];
      }),
    );
    switched = true;
    install(frontendConfig(state.base, active, previous));
    // New workers start asynchronously. Probe the actual public listener, not just the candidate.
    await waitFor("Public replacement bundle verification", (timeoutMs) => {
      const deadline = now() + timeoutMs;
      return Object.entries(expected).every(([file, hash]) => {
        if (now() >= deadline) return false;
        const served = run(
          "docker",
          [
            "exec",
            front,
            "sh",
            "-c",
            `wget -qO- --timeout=5 --header="X-Forwarded-Proto: https" http://127.0.0.1:8080/${file} | sha256sum`,
          ],
          { allowFailure: true, timeoutMs: Math.max(1, deadline - now()) },
        );
        return served.ok && served.stdout.split(/\s+/)[0] === hash;
      });
    });
    const next = {
      front,
      base: state.base,
      active,
      previous,
      updatedAt: new Date().toISOString(),
    };
    const temporary = `${stateFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, stateFile);
    committed = true;
    // Keep one healthy previous release for rollback and old immutable lazy chunks.
    // Only retire older containers explicitly labelled by this helper/project.
    const owned = docker(
      "ps",
      "-aq",
      "--filter",
      `label=srn.web-rollout.project=${project}`,
    )
      .stdout.split(/\s+/)
      .filter(Boolean);
    for (const id of owned) {
      const name = docker(
        "inspect",
        "--format",
        "{{.Name}}",
        id,
      ).stdout.replace(/^\//, "");
      if (name !== active && name !== previous) {
        run("docker", ["stop", "--time", "30", id], { allowFailure: true });
        run("docker", ["rm", id], { allowFailure: true });
      }
    }
    console.log(
      rollback
        ? "Frontend rolled back. Backend containers were not restarted."
        : fullUpdate
          ? "Healthy frontend is serving after backend readiness passed. Previous frontend retained."
          : "Healthy frontend is serving. Previous release retained; backend containers were not restarted.",
    );
    return next;
  } catch (error) {
    if (switched && !committed) {
      try {
        restore();
      } catch {
        throw new Error(
          "Could not confirm routing restoration; replacement containers were kept running for recovery.",
        );
      }
      console.error(
        "Frontend handover failed; the previous routing was restored.",
      );
    }
    if (candidate && !committed)
      run("docker", ["rm", "-f", candidate], { allowFailure: true });
    if (backupCandidate && !committed)
      run("docker", ["rm", "-f", backupCandidate], { allowFailure: true });
    throw error;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2),
    separator = args.indexOf("--");
  const options = args.slice(0, separator < 0 ? args.length : separator);
  const timeoutIndex = options.indexOf("--timeout");
  deployWeb({
    compose: separator < 0 ? [] : args.slice(separator + 1),
    timeout: timeoutIndex < 0 ? 600 : Number(options[timeoutIndex + 1]),
    skipBuild: options.includes("--skip-build"),
    rollback: options.includes("--rollback"),
    fullUpdate: options.includes("--full-update"),
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

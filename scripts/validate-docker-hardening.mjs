#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const REQUIRED_SERVICES = Object.freeze([
  "app",
  "server",
  "db",
  "cache",
  "floci",
]);
const INTERNAL_ONLY_SERVICES = Object.freeze([
  "server",
  "db",
  "cache",
  "floci",
]);

function upperList(value) {
  return (Array.isArray(value) ? value : []).map((item) =>
    String(item).toUpperCase(),
  );
}

function hasNoNewPrivileges(value) {
  return (Array.isArray(value) ? value : []).some(
    (item) => String(item).toLowerCase() === "no-new-privileges:true",
  );
}

function positiveNumber(value) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0;
}

function mountSource(volume) {
  if (typeof volume === "string") {
    return volume.split(":", 1)[0];
  }
  return volume?.source ?? "";
}

export function validateServerDockerfileContract(dockerfile) {
  const errors = [];
  const instructions = String(dockerfile)
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const finalStageStart = instructions.findLastIndex((instruction) =>
    /^FROM(?:\s|$)/i.test(instruction),
  );
  const finalStage = instructions.slice(Math.max(0, finalStageStart));
  const adminCliCopies = finalStage
    .map((instruction, index) => ({ instruction, index }))
    .filter(
      ({ instruction }) =>
        /^COPY(?:\s|$)/i.test(instruction) &&
        /\bdocker\/srn-admin\.sh\b/i.test(instruction) &&
        /\/usr\/local\/bin\/srn-admin\b/i.test(instruction),
    );
  const installedAdminCli = adminCliCopies.at(-1);
  const installsAdminCli = installedAdminCli !== undefined;

  let makesAdminCliExecutable = false;
  if (installedAdminCli !== undefined) {
    const copyMode = /--chmod=0?[0-7]{2}[1357](?:\s|$)/i.test(
      installedAdminCli.instruction,
    );
    const nextUser = finalStage.findIndex(
      (instruction, index) =>
        index > installedAdminCli.index && /^USER(?:\s|$)/i.test(instruction),
    );
    const beforeUser =
      nextUser === -1
        ? finalStage.slice(installedAdminCli.index + 1)
        : finalStage.slice(installedAdminCli.index + 1, nextUser);
    const chmodsAdminCli = beforeUser.some((instruction) =>
      [...instruction.matchAll(/\bchmod\s+(\S+)\s+([^;&|]+)/gi)].some(
        ([, mode, targets]) =>
          (/^(?:\+x|a\+x|ugo\+x)$/i.test(mode) ||
            /^0?[0-7]{2}[1357]$/.test(mode)) &&
          targets.trim().split(/\s+/).includes("/usr/local/bin/srn-admin"),
      ),
    );
    makesAdminCliExecutable = copyMode || chmodsAdminCli;
  }

  if (!installsAdminCli) {
    errors.push(
      "server Dockerfile: must install docker/srn-admin.sh as /usr/local/bin/srn-admin",
    );
  }
  if (!makesAdminCliExecutable) {
    errors.push(
      "server Dockerfile: /usr/local/bin/srn-admin must be executable",
    );
  }

  return errors;
}

export function validateComposeHardening(config) {
  const errors = [];
  const services = config?.services ?? {};

  for (const name of REQUIRED_SERVICES) {
    const service = services[name];
    if (!service) {
      errors.push(`compose: missing required ${name} service`);
      continue;
    }
    if (!upperList(service.cap_drop).includes("ALL")) {
      errors.push(`compose ${name}: must drop ALL capabilities`);
    }
    if (!hasNoNewPrivileges(service.security_opt)) {
      errors.push(`compose ${name}: must set no-new-privileges:true`);
    }
    if (!positiveNumber(service.mem_limit)) {
      errors.push(`compose ${name}: must set a positive memory limit`);
    }
    if (!positiveNumber(service.pids_limit)) {
      errors.push(`compose ${name}: must set a positive PID limit`);
    }
  }

  for (const name of INTERNAL_ONLY_SERVICES) {
    if ((services[name]?.ports ?? []).length > 0) {
      errors.push(`compose ${name}: must not publish host ports`);
    }
  }

  const serverMounts = services.server?.volumes ?? [];
  if (
    serverMounts.some(
      (volume) => mountSource(volume) === "/var/run/docker.sock",
    )
  ) {
    errors.push("compose server: raw Docker socket must not be mounted");
  }

  return errors;
}

export function validateImageHardening(serviceName, inspect) {
  const errors = [];
  const config = inspect?.Config ?? {};
  const user = String(config.User ?? "")
    .trim()
    .toLowerCase();

  if (
    ["app", "server"].includes(serviceName) &&
    (!user || user === "0" || user === "root" || user.startsWith("0:"))
  ) {
    errors.push(`image ${serviceName}: runtime user must be non-root`);
  }
  if (
    !Array.isArray(config.Healthcheck?.Test) ||
    config.Healthcheck.Test.length === 0
  ) {
    errors.push(`image ${serviceName}: healthcheck is missing`);
  }

  return errors;
}

export function validateContainerHardening(serviceName, inspect) {
  const errors = [];
  const host = inspect?.HostConfig ?? {};
  const state = inspect?.State ?? {};
  const user = String(inspect?.Config?.User ?? "")
    .trim()
    .toLowerCase();

  if (host.Privileged !== false) {
    errors.push(`container ${serviceName}: privileged mode must be disabled`);
  }
  if (!upperList(host.CapDrop).includes("ALL")) {
    errors.push(`container ${serviceName}: must drop ALL capabilities`);
  }
  if (!hasNoNewPrivileges(host.SecurityOpt)) {
    errors.push(`container ${serviceName}: must set no-new-privileges:true`);
  }
  if (!positiveNumber(host.Memory)) {
    errors.push(`container ${serviceName}: memory limit is missing`);
  }
  if (!positiveNumber(host.PidsLimit)) {
    errors.push(`container ${serviceName}: PID limit is missing`);
  }
  if (state.Health?.Status !== "healthy") {
    errors.push(
      `container ${serviceName}: expected healthy state, got ${state.Health?.Status ?? "missing"}`,
    );
  }
  if (
    ["app", "server"].includes(serviceName) &&
    (!user || user === "0" || user === "root" || user.startsWith("0:"))
  ) {
    errors.push(`container ${serviceName}: runtime user must be non-root`);
  }

  return errors;
}

function parseNamedValue(value, flag) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${flag} requires service=target`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function parseArgs(argv) {
  const result = { images: new Map(), containers: new Map() };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--image" || flag === "--container") {
      const value = argv[++index];
      if (!value) {
        throw new Error(`${flag} requires service=target`);
      }
      const [service, target] = parseNamedValue(value, flag);
      (flag === "--image" ? result.images : result.containers).set(
        service,
        target,
      );
    } else if (flag === "--help" || flag === "-h") {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return result;
}

function dockerJson(args) {
  return JSON.parse(
    execFileSync("docker", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }),
  );
}

export function runDockerHardeningValidation(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "Usage: node scripts/validate-docker-hardening.mjs [--image service=image] [--container service=name]",
    );
    return { composeServices: 0, images: 0, containers: 0 };
  }

  const errors = validateServerDockerfileContract(
    readFileSync(path.join(repositoryRoot, "server", "Dockerfile"), "utf8"),
  );
  errors.push(
    ...validateComposeHardening(
      dockerJson(["compose", "config", "--format", "json"]),
    ),
  );

  for (const [service, image] of args.images) {
    const inspections = dockerJson(["image", "inspect", image]);
    errors.push(...validateImageHardening(service, inspections[0]));
  }
  for (const [service, container] of args.containers) {
    const inspections = dockerJson(["inspect", container]);
    errors.push(...validateContainerHardening(service, inspections[0]));
  }

  if (errors.length > 0) {
    throw new Error(
      `Docker hardening validation failed:\n- ${errors.join("\n- ")}`,
    );
  }

  const result = {
    composeServices: REQUIRED_SERVICES.length,
    images: args.images.size,
    containers: args.containers.size,
  };
  console.log(
    `Docker hardening valid: ${result.composeServices} Compose services, ${result.images} images, ${result.containers} live containers.`,
  );
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    runDockerHardeningValidation();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

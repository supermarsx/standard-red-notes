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
const ASSISTANT_ENV_KEYS = Object.freeze([
  "ASSISTANT_ANTHROPIC_API_KEY",
  "ASSISTANT_OPENAI_API_KEY",
  "ASSISTANT_OPENAI_BASE_URL",
  "ASSISTANT_OPENAI_MODEL",
  "ASSISTANT_OLLAMA_URL",
  "ASSISTANT_DEFAULT_PROVIDER",
  "ASSISTANT_DEFAULT_MODEL",
  "ASSISTANT_DAILY_REQUEST_LIMIT",
  "ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY",
  "ASSISTANT_SUBSCRIPTION_TOKEN_PATH",
  "ASSISTANT_CHATGPT_OAUTH_AUTHORIZE_URL",
  "ASSISTANT_CHATGPT_OAUTH_TOKEN_URL",
  "ASSISTANT_CHATGPT_OAUTH_CLIENT_ID",
  "ASSISTANT_CHATGPT_OAUTH_REDIRECT_URI",
  "ASSISTANT_CHATGPT_OAUTH_SCOPES",
  "ASSISTANT_CHATGPT_OAUTH_ACCOUNT_ID_CLAIM",
  "ASSISTANT_OPENAI_AUTH_MODE",
  "ASSISTANT_OPENAI_SUBSCRIPTION_TOKEN",
  "ASSISTANT_OPENAI_SUBSCRIPTION_BASE_URL",
  "ASSISTANT_OPENAI_ACCOUNT_ID",
  "ASSISTANT_OPENAI_BETA",
  "ASSISTANT_OPENAI_EXTRA_HEADERS",
]);
const AUTH_STEP_UP_THRESHOLD_ENV_KEYS = Object.freeze([
  "APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2",
  "APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3",
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

function mountTarget(volume) {
  if (typeof volume === "string") {
    return volume.split(":")[1] ?? "";
  }
  return volume?.target ?? "";
}

function environmentMap(environment) {
  if (!Array.isArray(environment)) {
    return environment ?? {};
  }
  return Object.fromEntries(
    environment.map((entry) => {
      const value = String(entry);
      const separator = value.indexOf("=");
      return separator < 0
        ? [value, ""]
        : [value.slice(0, separator), value.slice(separator + 1)];
    }),
  );
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

export function validatePairingDockerfileContract(dockerfile) {
  const errors = [];
  const normalized = String(dockerfile).replace(/\\\r?\n/g, " ");
  const finalStageStart = [...normalized.matchAll(/^\s*FROM(?:\s|$)/gim)].at(
    -1,
  )?.index;
  const finalStage = normalized.slice(finalStageStart ?? 0);
  const userIndex = finalStage.search(/^\s*USER\s+srn(?::srn)?\s*$/im);
  const beforeUser =
    userIndex < 0 ? finalStage : finalStage.slice(0, userIndex);
  const dataPath = "/opt/server/packages/api-gateway/data";

  if (
    !new RegExp(
      `\\bmkdir\\s+-p\\b[^\\n]*${dataPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "i",
    ).test(beforeUser)
  ) {
    errors.push(`server Dockerfile: must create ${dataPath} before USER srn`);
  }
  if (
    !/\bchown\s+-R\s+srn:srn\b[^\n]*(?:\/opt\/server(?:\s|$)|\/opt\/server\/packages\/api-gateway\/data)/i.test(
      beforeUser,
    )
  ) {
    errors.push(
      `server Dockerfile: must make ${dataPath} writable by srn before USER`,
    );
  }

  return errors;
}

export function validatePairingComposeContract(
  config,
  { serviceName, label, dataTarget, expectedVolumeSource },
) {
  const errors = [];
  const service = config?.services?.[serviceName];
  if (!service) {
    return [`${label}: missing ${serviceName} service`];
  }
  const environment = environmentMap(service.environment);
  for (const key of ASSISTANT_ENV_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(environment, key)) {
      errors.push(`${label} ${serviceName}: must propagate ${key}`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(environment, "PUBLIC_URL")) {
    errors.push(`${label} ${serviceName}: must propagate PUBLIC_URL`);
  }

  const tokenPath = environment.ASSISTANT_SUBSCRIPTION_TOKEN_PATH;
  const canonicalDataTarget = path.posix.resolve(dataTarget);
  const canonicalTokenPath =
    typeof tokenPath === "string" && path.posix.isAbsolute(tokenPath)
      ? path.posix.resolve(tokenPath)
      : undefined;
  const tokenPathRelativeToData =
    canonicalTokenPath === undefined
      ? undefined
      : path.posix.relative(canonicalDataTarget, canonicalTokenPath);
  const tokenPathIsInsideData =
    tokenPathRelativeToData === "" ||
    (tokenPathRelativeToData !== undefined &&
      tokenPathRelativeToData !== ".." &&
      !tokenPathRelativeToData.startsWith("../") &&
      !path.posix.isAbsolute(tokenPathRelativeToData));
  if (!tokenPathIsInsideData) {
    errors.push(
      `${label} ${serviceName}: pairing token path must stay inside ${dataTarget}`,
    );
  }

  const dataMount = (service.volumes ?? []).find(
    (volume) => mountTarget(volume) === dataTarget,
  );
  if (!dataMount || mountSource(dataMount) !== expectedVolumeSource) {
    errors.push(
      `${label} ${serviceName}: ${dataTarget} must use the ${expectedVolumeSource} named volume`,
    );
  }

  return errors;
}

export function validateAuthStepUpComposeContract(
  config,
  { serviceName, label },
) {
  const service = config?.services?.[serviceName];
  if (!service) {
    return [`${label}: missing ${serviceName} service`];
  }

  const environment = environmentMap(service.environment);
  return AUTH_STEP_UP_THRESHOLD_ENV_KEYS.flatMap((key) => {
    if (!Object.prototype.hasOwnProperty.call(environment, key)) {
      return [`${label} ${serviceName}: must propagate ${key}`];
    }
    if (String(environment[key] ?? "").trim().length === 0) {
      return [`${label} ${serviceName}: ${key} must have a secure default`];
    }
    return [];
  });
}

export function validateAuthStepUpComposeSource(composeSource, { label }) {
  const source = String(composeSource);
  return AUTH_STEP_UP_THRESHOLD_ENV_KEYS.flatMap((key) => {
    const expected = `${key}: \${${key}:-0.0.0}`;
    return source.includes(expected)
      ? []
      : [
          `${label}: ${key} must expose an operator override defaulting to 0.0.0`,
        ];
  });
}

export function validateSingleEntrypointAuthStepUpPropagation(
  entrypointSource,
) {
  const source = String(entrypointSource);
  return AUTH_STEP_UP_THRESHOLD_ENV_KEYS.flatMap((key) => {
    const expected = `put ${key} "\${${key}:-0.0.0}"`;
    return source.includes(expected)
      ? []
      : [`single entrypoint: must write ${key} with a secure default`];
  });
}

export function validatePairingComposeSource(
  composeSource,
  { label, defaultTokenPath },
) {
  const errors = [];
  const source = String(composeSource);
  if (!/^\s*PUBLIC_URL:\s*\$\{PUBLIC_URL:-\}\s*$/m.test(source)) {
    errors.push(
      `${label}: PUBLIC_URL must have an explicit empty default (no localhost fallback)`,
    );
  }
  const expected =
    `ASSISTANT_SUBSCRIPTION_TOKEN_PATH: ` +
    `\${ASSISTANT_SUBSCRIPTION_TOKEN_PATH:-${defaultTokenPath}}`;
  if (!source.includes(expected)) {
    errors.push(
      `${label}: pairing token path must default to ${defaultTokenPath}`,
    );
  }
  return errors;
}

export function validateSingleEntrypointAssistantPropagation(entrypoint) {
  const errors = [];
  const source = String(entrypoint);
  for (const key of ASSISTANT_ENV_KEYS) {
    if (!new RegExp(`\\bput(?:_opt)?\\s+${key}\\b`).test(source)) {
      errors.push(
        `single entrypoint: must write ${key} to the home-server env`,
      );
    }
  }
  if (
    !source.includes(
      'put ASSISTANT_SUBSCRIPTION_TOKEN_PATH "${ASSISTANT_SUBSCRIPTION_TOKEN_PATH:-${DATA_DIR}/assistant-subscription.json}"',
    )
  ) {
    errors.push(
      "single entrypoint: pairing token path must default inside DATA_DIR",
    );
  }
  if (!/\bput_opt\s+PUBLIC_URL\b/.test(source)) {
    errors.push(
      "single entrypoint: must propagate PUBLIC_URL without inventing it",
    );
  }
  return errors;
}

function exactLocationBody(nginxConfig, route) {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [
    ...String(nginxConfig).matchAll(
      new RegExp(
        `location\\s*=\\s*${escaped}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`,
        "g",
      ),
    ),
  ];
  return matches.length === 1 ? matches[0][1] : undefined;
}

export function validatePairingCallbackNginxContract(
  nginxConfig,
  { label, proxyPass },
) {
  const errors = [];
  const route = "/v1/assistant/subscription/callback";
  const body = exactLocationBody(nginxConfig, route);
  if (!body) {
    return [`${label}: must define one exact ${route} location`];
  }
  const required = [
    ["disable access logging", /\baccess_log\s+off\s*;/],
    [
      `proxy to ${proxyPass}`,
      new RegExp(
        `\\bproxy_pass\\s+${proxyPass.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\$request_uri)?\\s*;`,
      ),
    ],
    ["preserve HTTP/1.1", /\bproxy_http_version\s+1\.1\s*;/],
    ["forward Host", /\bproxy_set_header\s+Host\s+\$host\s*;/],
    [
      "forward client chain",
      /\bproxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for\s*;/,
    ],
    ["forward scheme", /\bproxy_set_header\s+X-Forwarded-Proto\s+\$scheme\s*;/],
    [
      "forward client address",
      /\bproxy_set_header\s+X-Real-IP\s+\$remote_addr\s*;/,
    ],
    ["preserve API body policy", /\bclient_max_body_size\s+0\s*;/],
    ["preserve request streaming", /\bproxy_request_buffering\s+off\s*;/],
    ["preserve API timeout", /\bproxy_read_timeout\s+300s\s*;/],
  ];
  for (const [description, pattern] of required) {
    if (!pattern.test(body)) {
      errors.push(`${label}: callback location must ${description}`);
    }
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
  const serverDockerfile = readFileSync(
    path.join(repositoryRoot, "server", "Dockerfile"),
    "utf8",
  );
  const multiComposeSource = readFileSync(
    path.join(repositoryRoot, "docker-compose.yml"),
    "utf8",
  );
  const singleComposeSource = readFileSync(
    path.join(repositoryRoot, "docker-compose.single.yml"),
    "utf8",
  );
  const singleEntrypoint = readFileSync(
    path.join(repositoryRoot, "server", "docker", "single", "entrypoint.sh"),
    "utf8",
  );
  const multiNginx = readFileSync(
    path.join(repositoryRoot, "app", "docker", "nginx.conf"),
    "utf8",
  );
  const singleNginx = readFileSync(
    path.join(repositoryRoot, "app", "docker", "single", "nginx.conf"),
    "utf8",
  );
  const multiConfig = dockerJson(["compose", "config", "--format", "json"]);
  const singleConfig = dockerJson([
    "compose",
    "-f",
    "docker-compose.single.yml",
    "config",
    "--format",
    "json",
  ]);
  errors.push(...validatePairingDockerfileContract(serverDockerfile));
  errors.push(
    ...validateComposeHardening(multiConfig),
    ...validatePairingComposeContract(multiConfig, {
      serviceName: "server",
      label: "multi compose",
      dataTarget: "/opt/server/packages/api-gateway/data",
      expectedVolumeSource: "server-data",
    }),
    ...validatePairingComposeContract(singleConfig, {
      serviceName: "app",
      label: "single compose",
      dataTarget: "/data",
      expectedVolumeSource: "single-data",
    }),
    ...validateAuthStepUpComposeContract(multiConfig, {
      serviceName: "server",
      label: "multi compose",
    }),
    ...validateAuthStepUpComposeContract(singleConfig, {
      serviceName: "app",
      label: "single compose",
    }),
    ...validateAuthStepUpComposeSource(multiComposeSource, {
      label: "multi compose",
    }),
    ...validateAuthStepUpComposeSource(singleComposeSource, {
      label: "single compose",
    }),
    ...validateSingleEntrypointAuthStepUpPropagation(singleEntrypoint),
    ...validatePairingComposeSource(multiComposeSource, {
      label: "multi compose",
      defaultTokenPath:
        "/opt/server/packages/api-gateway/data/assistant-subscription.json",
    }),
    ...validatePairingComposeSource(singleComposeSource, {
      label: "single compose",
      defaultTokenPath: "/data/assistant-subscription.json",
    }),
    ...validateSingleEntrypointAssistantPropagation(singleEntrypoint),
    ...validatePairingCallbackNginxContract(multiNginx, {
      label: "multi nginx",
      proxyPass: "http://$srn_api",
    }),
    ...validatePairingCallbackNginxContract(singleNginx, {
      label: "single nginx",
      proxyPass: "http://127.0.0.1:3000",
    }),
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

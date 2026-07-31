#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");

export const MANIFEST_PATH = "docs/_data/standard_notes_compatibility.json";
export const DOCUMENT_PATH = "docs/standard-notes-compatibility.md";

const EXPECTED_PROTOCOLS = ["001", "002", "003", "004"];
const EXPECTED_API_VERSIONS = ["20161215", "20190520", "20200115", "20240226"];

export function normalizedSha256(source) {
  return createHash("sha256")
    .update(source.replace(/\r\n?/g, "\n"))
    .digest("hex");
}

function readText(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateFileMap(root, files, label) {
  const diagnostics = [];
  if (!isRecord(files) || Object.keys(files).length === 0) {
    return [
      `${MANIFEST_PATH}: ${label} must contain at least one audited file`,
    ];
  }

  for (const [relativePath, expectedHash] of Object.entries(files)) {
    if (!/^[a-f0-9]{64}$/.test(String(expectedHash))) {
      diagnostics.push(
        `${MANIFEST_PATH}: ${label} has an invalid SHA-256 for ${relativePath}`,
      );
      continue;
    }
    const absolutePath = path.resolve(root, relativePath);
    const relativeToRoot = path.relative(root, absolutePath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      diagnostics.push(
        `${MANIFEST_PATH}: ${label} path escapes the repository: ${relativePath}`,
      );
      continue;
    }
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      diagnostics.push(
        `${MANIFEST_PATH}: audited file is missing: ${relativePath}`,
      );
      continue;
    }
    const actualHash = normalizedSha256(fs.readFileSync(absolutePath, "utf8"));
    if (actualHash !== expectedHash) {
      diagnostics.push(
        `${relativePath}: compatibility-audited content changed (${expectedHash.slice(0, 12)} -> ${actualHash.slice(0, 12)}); compare the pinned upstream snapshot and update the matrix before accepting the new hash`,
      );
    }
  }
  return diagnostics;
}

function requireSource(source, pattern, file, explanation) {
  return pattern.test(source)
    ? []
    : [`${file}: compatibility contract missing: ${explanation}`];
}

export function validateManifest(manifest, root = repositoryRoot) {
  const diagnostics = [];
  if (!isRecord(manifest)) {
    return [`${MANIFEST_PATH}: root must be an object`];
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.auditedAt ?? "")) {
    diagnostics.push(
      `${MANIFEST_PATH}: auditedAt must be an ISO calendar date`,
    );
  }

  for (const name of ["app", "server"]) {
    const snapshot = manifest.upstream?.[name];
    if (!isRecord(snapshot)) {
      diagnostics.push(`${MANIFEST_PATH}: upstream.${name} must be an object`);
      continue;
    }
    if (snapshot.repository !== `https://github.com/standardnotes/${name}`) {
      diagnostics.push(
        `${MANIFEST_PATH}: upstream.${name}.repository must name the official Standard Notes repository`,
      );
    }
    if (!/^[a-f0-9]{40}$/.test(snapshot.commit ?? "")) {
      diagnostics.push(
        `${MANIFEST_PATH}: upstream.${name}.commit must be a full immutable commit hash`,
      );
    }
    diagnostics.push(
      ...validateFileMap(
        root,
        snapshot.exactLocalFiles,
        `upstream.${name}.exactLocalFiles`,
      ),
    );
  }
  diagnostics.push(
    ...validateFileMap(root, manifest.forkAuditedFiles, "forkAuditedFiles"),
  );

  if (
    JSON.stringify(manifest.contracts?.protocolVersions) !==
    JSON.stringify(EXPECTED_PROTOCOLS)
  ) {
    diagnostics.push(
      `${MANIFEST_PATH}: contracts.protocolVersions must be ${EXPECTED_PROTOCOLS.join(", ")}`,
    );
  }
  if (manifest.contracts?.latestProtocolVersion !== "004") {
    diagnostics.push(
      `${MANIFEST_PATH}: contracts.latestProtocolVersion must be 004`,
    );
  }
  if (
    JSON.stringify(manifest.contracts?.apiVersions) !==
    JSON.stringify(EXPECTED_API_VERSIONS)
  ) {
    diagnostics.push(
      `${MANIFEST_PATH}: contracts.apiVersions must be ${EXPECTED_API_VERSIONS.join(", ")}`,
    );
  }
  if (manifest.contracts?.modernResponseFactory !== "20200115") {
    diagnostics.push(
      `${MANIFEST_PATH}: contracts.modernResponseFactory must record the 20200115 response shape`,
    );
  }
  if (!manifest.contracts?.forkOnlyContentTypes?.includes("Folder")) {
    diagnostics.push(
      `${MANIFEST_PATH}: contracts.forkOnlyContentTypes must include Folder`,
    );
  }

  const semanticChecks = [
    [
      "app/packages/models/src/Domain/Local/Protocol/ProtocolVersion.ts",
      /ProtocolVersionLatest\s*=\s*ProtocolVersion\.V004/,
      "004 is the latest protocol",
    ],
    [
      "app/packages/services/src/Domain/Encryption/EncryptionService.ts",
      /return \[ProtocolVersion\.V001, ProtocolVersion\.V002, ProtocolVersion\.V003, ProtocolVersion\.V004\]/,
      "the client registers exactly protocols 001 through 004",
    ],
    [
      "app/packages/services/src/Domain/Import/CreateEncryptedBackupFile.ts",
      /version:\s*ProtocolVersionLatest/,
      "new native backups declare the latest protocol",
    ],
    [
      "app/packages/services/src/Domain/Import/ImportData.ts",
      /data\.auth_params\s*\|\|\s*data\.keyParams/,
      "the importer recognizes legacy auth_params and current keyParams",
    ],
    [
      "app/packages/services/src/Domain/Import/ImportData.ts",
      /const valid = \[\.\.\.decrypted, \.\.\.encrypted\]/,
      "the fork preserves payloads that remain encrypted during import",
    ],
    [
      "server/packages/auth/src/Domain/Auth/AuthResponseFactoryResolver.ts",
      /case ApiVersion\.VERSIONS\.v20240226:[\s\S]{0,120}return this\.authResponseFactory20200115/,
      "auth API 20240226 resolves to the 20200115 response factory",
    ],
    [
      "server/packages/syncing-server/src/Domain/Item/SyncResponse/SyncResponseFactoryResolver.ts",
      /case ApiVersion\.v20240226:[\s\S]{0,120}return this\.syncResponseFactory20200115/,
      "sync API 20240226 resolves to the 20200115 response factory",
    ],
    [
      "app/packages/models/src/Domain/Syncable/Folder/FolderContentType.ts",
      /FolderContentType\s*=\s*'Folder'/,
      "Folder is a fork content type",
    ],
    [
      "server/packages/domain-core/src/Domain/Common/ContentType.ts",
      /Folder:\s*'Folder'/,
      "the fork server accepts Folder items",
    ],
    [
      "docs/assets/safety-alerts.css",
      /\.compatibility-badge--incompatible\s*\{[\s\S]*?color:\s*#8b1722;/,
      "known incompatible boundaries use a dedicated danger badge",
    ],
    [
      "app/packages/snjs/lib/Domain/UseCase/AccountRecovery/AccountRecoveryEscrowTypes.ts",
      /ACCOUNT_RECOVERY_CODE_PREFIX\s*=\s*'SRN-RECOVERY-V2'/,
      "account recovery uses the fork-specific v2 recovery-code contract",
    ],
  ];
  for (const [file, pattern, explanation] of semanticChecks) {
    diagnostics.push(
      ...requireSource(readText(root, file), pattern, file, explanation),
    );
  }

  return diagnostics;
}

function tableRows(markdown) {
  return markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => /^\|.+\|\s*$/.test(line));
}

export function validateCompatibilityDocument(markdown, manifest) {
  const diagnostics = [];
  const required = [
    [
      "not documented or tested as a drop-in replacement",
      "the no-drop-in guarantee",
    ],
    ["Confirmed inside this fork", "the fork-only meaning of Confirmed"],
    ["Known incompatible boundary", "a label for demonstrated incompatibility"],
    ["20240226", "the latest accepted legacy API marker"],
    ["20200115 response shape", "the aliased response-factory boundary"],
    ["content_type_error", "the known upstream Folder rejection"],
    [
      "full 001/002 native-backup import fixture",
      "the oldest-backup evidence gap",
    ],
    ["current original-client ↔ fork-server", "the absent cross-product test"],
  ];
  for (const [needle, explanation] of required) {
    if (!markdown.includes(needle)) {
      diagnostics.push(`${DOCUMENT_PATH}: missing ${explanation}`);
    }
  }

  for (const snapshot of Object.values(manifest.upstream ?? {})) {
    if (snapshot?.commit && !markdown.includes(snapshot.commit)) {
      diagnostics.push(
        `${DOCUMENT_PATH}: missing pinned upstream snapshot ${snapshot.commit}`,
      );
    }
  }

  const overclaims = [
    /\bfully compatible with (?:all|current) Standard Notes\b/i,
    /\bdrop-in compatible\b/i,
    /\bguaranteed compatibility\b/i,
    /\binterchangeable clients? and servers?\b/i,
  ];
  for (const pattern of overclaims) {
    if (pattern.test(markdown)) {
      diagnostics.push(
        `${DOCUMENT_PATH}: unsupported interoperability claim matches ${pattern}`,
      );
    }
  }

  for (const row of tableRows(markdown)) {
    const crossProduct =
      /original Standard Notes|hosted Standard Notes|original desktop\/mobile/i.test(
        row,
      );
    if (crossProduct && /compatibility-badge--confirmed/.test(row)) {
      diagnostics.push(
        `${DOCUMENT_PATH}: cross-product matrix rows may not be marked Confirmed: ${row.slice(0, 120)}`,
      );
    }
    if (
      /Known (?:incompatible|unsupported)/.test(row) &&
      !/compatibility-badge--incompatible/.test(row)
    ) {
      diagnostics.push(
        `${DOCUMENT_PATH}: known incompatible/unsupported matrix rows must use the danger badge: ${row.slice(0, 120)}`,
      );
    }
  }

  return diagnostics;
}

export function validateCompatibilityContract(root = repositoryRoot) {
  const manifest = JSON.parse(readText(root, MANIFEST_PATH));
  return [
    ...validateManifest(manifest, root),
    ...validateCompatibilityDocument(readText(root, DOCUMENT_PATH), manifest),
  ];
}

function main() {
  const diagnostics = validateCompatibilityContract(repositoryRoot);
  if (diagnostics.length > 0) {
    console.error(
      `Standard Notes compatibility validation failed with ${diagnostics.length} issue(s):`,
    );
    for (const diagnostic of diagnostics) {
      console.error(`- ${diagnostic}`);
    }
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(readText(repositoryRoot, MANIFEST_PATH));
  const upstreamParityCount = Object.values(manifest.upstream ?? {}).reduce(
    (total, snapshot) =>
      total + Object.keys(snapshot?.exactLocalFiles ?? {}).length,
    0,
  );
  const forkAuditCount = Object.keys(manifest.forkAuditedFiles ?? {}).length;
  console.log(
    `Standard Notes compatibility contract is current (${upstreamParityCount} upstream-parity files; ${forkAuditCount} fork audit files).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main();
}

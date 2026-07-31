#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  classifyNativeCliExecutorSemanticChange,
  classifyReleasePackagingContractSemanticChange,
  NATIVE_CLI_RELEASE_PRODUCTS,
  RELEASE_PACKAGING_CONTRACT_PRODUCTS,
} from "./native-cli-release.mjs";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const VERSION_PROFILES = new Set([
  "rolling-year",
  "rolling-year-or-semver",
  "semver",
]);
const MAX_FORCE_REASON_LENGTH = 500;
const NATIVE_EXECUTOR_PATH = "scripts/native-cli-release.mjs";
const RELEASE_PACKAGING_CONTRACT_PATH =
  "scripts/release-packaging-contract.mjs";

export const WORKSPACE_ROOTS = Object.freeze({
  root: {
    directory: "",
    manifest: "package.json",
    configPaths: ["package.json", "yarn.lock", ".yarnrc.yml"],
    configPrefixes: [".yarn/releases/"],
  },
  app: {
    directory: "app",
    manifest: "app/package.json",
    configPaths: [
      "app/package.json",
      "app/yarn.lock",
      "app/.nvmrc",
      "app/.yarnrc.yml",
      "app/babel.config.js",
      "app/tsconfig.base.json",
    ],
    configPrefixes: ["app/.yarn/patches/", "app/.yarn/releases/"],
  },
  server: {
    directory: "server",
    manifest: "server/package.json",
    configPaths: [
      "server/package.json",
      "server/yarn.lock",
      "server/.nvmrc",
      "server/.yarnrc.yml",
      "server/linter.tsconfig.json",
      "server/tsconfig.json",
    ],
    configPrefixes: ["server/.yarn/releases/"],
  },
});

const appProductConfig = {
  workspaceRoot: "app",
  configPaths: [],
  configPrefixes: [],
};

const serverProductConfig = {
  workspaceRoot: "server",
  configPaths: [],
  configPrefixes: [],
};

export const RELEASE_TARGETS = Object.freeze({
  "srn-admin": {
    ...serverProductConfig,
    tagPrefix: "srn-admin-v",
    versioning: "rolling-year",
    packageNames: ["@standardnotes/auth-server"],
    configPaths: [
      ".github/workflows/srn-admin.yml",
      "scripts/native-cli-release.mjs",
      "scripts/package-lock.json",
      "scripts/package.json",
      "scripts/release-packaging-contract.mjs",
    ],
  },
  "srn-client": {
    tagPrefix: "srn-client-v",
    versioning: "rolling-year",
    packageDirs: [
      {
        name: "@standard-red-notes/srn-client",
        directory: "cli/srn-client",
      },
    ],
    configPaths: [
      ".github/workflows/srn-client.yml",
      "cli/.prettierrc",
      "scripts/native-cli-release.mjs",
      "scripts/package-lock.json",
      "scripts/package.json",
      "scripts/release-packaging-contract.mjs",
    ],
    configPrefixes: [],
  },
  "srn-desktop": {
    ...appProductConfig,
    tagPrefix: "srn-desktop-v",
    versioning: "rolling-year",
    packageNames: ["@standardnotes/desktop"],
    configPaths: [
      ".github/workflows/srn-desktop.yml",
      "app/.github/workflows/desktop.release.reuse.yml",
      "app/scripts/verify-desktop-updater-metadata.rb",
      "scripts/package-lock.json",
      "scripts/package.json",
      "scripts/release-packaging-contract.mjs",
    ],
  },
  "srn-home-server": {
    ...serverProductConfig,
    tagPrefix: "srn-home-server-v",
    versioning: "rolling-year",
    packageNames: ["@standardnotes/home-server"],
    configPaths: [
      ".github/workflows/srn-home-server.yml",
      "scripts/native-cli-release.mjs",
      "scripts/package-lock.json",
      "scripts/package.json",
      "scripts/release-packaging-contract.mjs",
    ],
  },
  "srn-mcp": {
    workspaceRoot: "root",
    tagPrefix: "srn-mcp-v",
    versioning: "rolling-year",
    packageNames: ["@standard-red-notes/mcp"],
    configPaths: [
      ".github/workflows/srn-mcp.yml",
      "scripts/native-cli-release.mjs",
      "scripts/package-lock.json",
      "scripts/package.json",
      "scripts/release-packaging-contract.mjs",
    ],
    configPrefixes: [],
  },
  "srn-mobile": {
    ...appProductConfig,
    tagPrefix: "@standardnotes/mobile@",
    versioning: "semver",
    packageNames: ["@standardnotes/mobile"],
    configPaths: [
      ".github/workflows/srn-mobile.yml",
      "app/.github/workflows/mobile.release.prod.yml",
      "scripts/package-lock.json",
      "scripts/package.json",
      "scripts/release-packaging-contract.mjs",
    ],
  },
  "srn-openclaw": {
    workspaceRoot: "root",
    tagPrefix: "srn-openclaw-v",
    versioning: "rolling-year-or-semver",
    packageNames: ["@standard-red-notes/openclaw"],
    configPaths: [
      ".github/workflows/srn-openclaw.yml",
      "scripts/package-lock.json",
      "scripts/package.json",
      "scripts/release-packaging-contract.mjs",
    ],
    configPrefixes: [],
  },
  "srn-server": {
    tagPrefix: "srn-server-v",
    versioning: "rolling-year",
    packageDirs: [
      {
        name: "@standard-red-notes/srn-server",
        directory: "cli/srn-server",
      },
    ],
    configPaths: [
      ".github/workflows/srn-server.yml",
      "cli/.prettierrc",
      "scripts/native-cli-release.mjs",
      "scripts/package-lock.json",
      "scripts/package.json",
      "scripts/release-packaging-contract.mjs",
    ],
    configPrefixes: [],
  },
});

const CANONICAL_RELEASE_WORKFLOWS = Object.freeze([
  {
    path: ".github/workflows/srn-admin.yml",
    owner: "srn-admin",
    classification: "canonical-change-gated",
    status: "root-active",
    activation: "push-main-paths-and-manual",
    targetKind: "product-distribution",
    targets: ["GitHub Releases: srn-admin native executables"],
    reason:
      "The root workflow is the canonical source-impact and artifact-fingerprint-gated srn-admin publisher.",
  },
  {
    path: ".github/workflows/srn-client.yml",
    owner: "srn-client",
    classification: "canonical-change-gated",
    status: "root-active",
    activation: "push-main-paths-and-manual",
    targetKind: "product-distribution",
    targets: ["GitHub Releases: srn-client native executables"],
    reason:
      "The root workflow is the canonical source-impact and artifact-fingerprint-gated srn-client publisher.",
  },
  {
    path: ".github/workflows/srn-desktop.yml",
    owner: "srn-desktop",
    classification: "canonical-change-gated",
    status: "root-active",
    activation: "push-main-paths-and-manual",
    targetKind: "application-distribution",
    targets: ["GitHub Releases: desktop installers"],
    reason:
      "The root workflow is the canonical change-gated GitHub desktop publisher and owns release identity selection; Snap publication exists only in the embedded recovery implementation.",
  },
  {
    path: ".github/workflows/srn-home-server.yml",
    owner: "srn-home-server",
    classification: "canonical-change-gated",
    status: "root-active",
    activation: "push-main-paths-and-manual",
    targetKind: "product-distribution",
    targets: ["GitHub Releases: home-server native executables and migrations"],
    reason:
      "The root workflow is the canonical source-impact and artifact-fingerprint-gated home-server publisher.",
  },
  {
    path: ".github/workflows/srn-mcp.yml",
    owner: "srn-mcp",
    classification: "canonical-change-gated",
    status: "root-active",
    activation: "push-main-paths-and-manual",
    targetKind: "product-distribution",
    targets: ["GitHub Releases: MCP bridge native executables"],
    reason:
      "The root workflow is the canonical source-impact and artifact-fingerprint-gated MCP publisher.",
  },
  {
    path: ".github/workflows/srn-mobile.yml",
    owner: "srn-mobile",
    classification: "canonical-change-gated",
    status: "root-active",
    activation: "push-main-paths-and-manual",
    targetKind: "application-distribution",
    targets: [
      "Google Play",
      "Apple App Store and TestFlight",
      "GitHub Releases",
    ],
    reason:
      "The root workflow is the canonical change-gated mobile publisher and coordinates the validated store payload.",
  },
  {
    path: ".github/workflows/srn-openclaw.yml",
    owner: "srn-openclaw",
    classification: "canonical-change-gated",
    status: "root-active",
    activation: "push-main-paths-and-manual",
    targetKind: "product-distribution",
    targets: ["GitHub Releases: OpenClaw package tarball and provenance"],
    reason:
      "The root workflow is the canonical source-impact and package-fingerprint-gated OpenClaw publisher.",
  },
  {
    path: ".github/workflows/srn-server.yml",
    owner: "srn-server",
    classification: "canonical-change-gated",
    status: "root-active",
    activation: "push-main-paths-and-manual",
    targetKind: "product-distribution",
    targets: ["GitHub Releases: srn-server native executables"],
    reason:
      "The root workflow is the canonical source-impact and artifact-fingerprint-gated srn-server publisher.",
  },
]);

const STANDALONE_RECOVERY_WORKFLOWS = Object.freeze([
  {
    path: "app/.github/workflows/desktop.release.prod.yml",
    owner: "srn-desktop",
    classification: "noncanonical-manual-recovery",
    status: "non-root-active",
    activation: "manual-only",
    targetKind: "application-distribution",
    targets: ["GitHub Releases: desktop installers", "Snap Store"],
    reason:
      "This nested-app entry point is retained only for explicitly authorized standalone recovery; the root srn-desktop workflow remains canonical.",
  },
  {
    path: "app/.github/workflows/mobile.release.prod.yml",
    owner: "srn-mobile",
    classification: "noncanonical-manual-recovery",
    status: "non-root-active",
    activation: "manual-only",
    targetKind: "application-distribution",
    targets: [
      "Google Play",
      "Apple App Store and TestFlight",
      "GitHub Releases",
    ],
    reason:
      "This nested-app entry point is retained only for explicitly authorized standalone recovery; the root srn-mobile workflow remains canonical.",
  },
]);

const SUPPORTING_RELEASE_WORKFLOWS = Object.freeze([
  {
    path: "app/.github/workflows/desktop.release.reuse.yml",
    owner: "srn-desktop",
    classification: "canonical-support",
    status: "non-root-active",
    activation: "workflow-call-only",
    targetKind: "application-distribution",
    targets: ["GitHub Releases: desktop installers", "Snap Store"],
    reason:
      "The reusable desktop build and publication implementation is invoked by the canonical root publisher and the manual recovery entry point.",
  },
]);

const QUARANTINED_UPSTREAM_WORKFLOWS = Object.freeze([
  {
    path: "app/.github/upstream-workflows-disabled/clipper.release.prod.yml",
    owner: "@standardnotes/clipper",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "application-distribution",
    targets: [
      "Firefox AMO",
      "Chrome Web Store extension heapafmadojoodklnkhjanbinemaagok",
      "upstream @standardnotes/clipper GitHub Releases",
    ],
    reason:
      "The preserved workflow targets upstream browser-store listings and credentials and has no fork-owned release gate.",
    workspacePackages: ["@standardnotes/clipper"],
  },
  {
    path: "app/.github/upstream-workflows-disabled/git-sync.yml",
    owner: "upstream-repository-sync",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "non-package-external-mutation",
    targets: ["standardnotes/app", "standardnotes/internal-app pull requests"],
    reason:
      "The preserved workflow synchronizes every branch into an upstream private repository with SSH and PAT credentials.",
  },
  {
    path: "app/.github/upstream-workflows-disabled/ios.testflight.yml",
    owner: "srn-mobile",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "application-distribution",
    targets: ["upstream Standard Notes TestFlight application"],
    reason:
      "The preserved legacy TestFlight workflow duplicates the active mobile path and names upstream credentials and signing assets.",
  },
  {
    path: "app/.github/upstream-workflows-disabled/publish.yml",
    owner: "upstream-package-publishing",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "mixed-package-and-distribution",
    targets: [
      "npm packages",
      "Docker Hub standardnotes/snjs",
      "Docker Hub standardnotes/web",
      "upstream Standard Notes release commits",
    ],
    reason:
      "The preserved workflow publishes upstream packages, mutable container tags, and release commits with upstream identities.",
  },
  {
    path: "app/.github/upstream-workflows-disabled/releases.notify.yml",
    owner: "upstream-release-notification",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "non-package-external-mutation",
    targets: ["secret-selected upstream release-marketing repository dispatch"],
    reason:
      "The preserved workflow mutates a secret-selected external repository with an upstream PAT.",
  },
  {
    path: "app/.github/upstream-workflows-disabled/web.release.prod.yml",
    owner: "@standardnotes/web",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "application-distribution",
    targets: [
      "s3://app.standardnotes.com",
      "upstream CloudFront distribution",
      "upstream Discord webhook",
    ],
    reason:
      "The preserved workflow deploys and deletes objects in upstream Standard Notes web infrastructure.",
    workspacePackages: ["@standardnotes/web"],
  },
]);

const ACTIVE_NONCANONICAL_EXTERNAL_WORKFLOWS = Object.freeze([
  {
    path: ".github/workflows/docs-pages.yml",
    owner: "repository-documentation",
    classification: "noncanonical-external-mutation",
    status: "root-active",
    activation: "push-main-and-manual",
    targetKind: "documentation-deployment",
    targets: ["GitHub Pages"],
    reason:
      "The documentation site deployment mutates GitHub Pages but is not a package or product release publisher.",
  },
  {
    path: "app/.github/workflows/snjs.pr.yml",
    owner: "upstream-snjs-test-infrastructure",
    classification: "noncanonical-external-mutation",
    status: "non-root-active",
    activation: "pull-request-and-manual",
    targetKind: "non-package-external-mutation",
    targets: [
      "Docker Hub standardnotes/snjs test tags",
      "standardnotes/server E2E workflow dispatch",
    ],
    reason:
      "The standalone app PR workflow publishes upstream test images and dispatches upstream E2E workflows; it is not a package release policy.",
  },
  {
    path: "app/.github/workflows/snjs.upgrade.event.yml",
    owner: "upstream-snjs-update-automation",
    classification: "noncanonical-external-mutation",
    status: "non-root-active",
    activation: "repository-dispatch-and-manual",
    targetKind: "non-package-external-mutation",
    targets: ["repository dependency-update commits and pull requests"],
    reason:
      "The standalone app workflow opens dependency-update pull requests; it is not a package release publisher.",
  },
]);

const ROOT_NONMUTATING_SUPPORT_WORKFLOWS = Object.freeze([
  {
    path: ".github/workflows/ci.yml",
    owner: "repository-ci",
    classification: "root-nonmutating-support",
    status: "root-active",
    activation: "push-pull-schedule-and-manual",
    targetKind: "validation-support",
    targets: ["repository checks and test artifacts"],
    reason:
      "The repository-root CI workflow validates code and uploads test evidence without publishing a product.",
  },
  {
    path: ".github/workflows/release-contract.yml",
    owner: "release-contract",
    classification: "root-nonmutating-support",
    status: "root-active",
    activation: "push-pull-and-manual",
    targetKind: "validation-support",
    targets: ["release contract and impact report artifacts"],
    reason:
      "The repository-root release-contract workflow validates publishers and uploads reports without publishing a product.",
  },
]);

const APP_EMBEDDED_NONMUTATING_SUPPORT_WORKFLOWS = Object.freeze([
  {
    path: "app/.github/workflows/codeql-analysis.yml",
    owner: "embedded-app-security-checks",
    classification: "embedded-nonmutating-support",
    status: "non-root-active",
    activation: "push-pull-and-schedule-portable",
    targetKind: "validation-support",
    targets: ["CodeQL analysis results"],
    reason:
      "This nested app definition is non-root-active in the monorepo and remains portable security-check reference material.",
  },
  {
    path: "app/.github/workflows/pr.yml",
    owner: "embedded-app-pr-checks",
    classification: "embedded-nonmutating-support",
    status: "non-root-active",
    activation: "pull-request-portable",
    targetKind: "validation-support",
    targets: ["app pull-request checks"],
    reason:
      "This nested app definition is non-root-active in the monorepo and remains portable pull-request test material.",
  },
]);

const SERVER_EMBEDDED_NONMUTATING_SUPPORT_WORKFLOWS = Object.freeze([
  {
    path: "server/.github/workflows/common-e2e.yml",
    owner: "embedded-server-e2e",
    classification: "embedded-nonmutating-support",
    status: "non-root-active",
    activation: "workflow-call-portable",
    targetKind: "test-support",
    targets: ["self-hosted and home-server E2E suites"],
    reason:
      "This nested server reusable definition is non-root-active in the monorepo and coordinates test-only E2E jobs.",
  },
  {
    path: "server/.github/workflows/e2e-home-server.yml",
    owner: "embedded-server-e2e",
    classification: "embedded-nonmutating-support",
    status: "non-root-active",
    activation: "workflow-call-portable",
    targetKind: "test-support",
    targets: ["home-server E2E test artifacts"],
    reason:
      "This nested server reusable definition is non-root-active in the monorepo and runs test-only home-server E2E coverage.",
  },
  {
    path: "server/.github/workflows/e2e-self-hosted.yml",
    owner: "embedded-server-e2e",
    classification: "embedded-nonmutating-support",
    status: "non-root-active",
    activation: "workflow-call-portable",
    targetKind: "test-support",
    targets: ["self-hosted E2E test artifacts"],
    reason:
      "This nested server reusable definition is non-root-active in the monorepo and runs test-only self-hosted E2E coverage.",
  },
  {
    path: "server/.github/workflows/e2e-test-suite.yml",
    owner: "embedded-server-e2e",
    classification: "embedded-nonmutating-support",
    status: "non-root-active",
    activation: "schedule-and-manual-portable",
    targetKind: "test-support",
    targets: ["scheduled or manual server E2E suites"],
    reason:
      "This nested server definition is non-root-active in the monorepo and remains a portable scheduled/manual E2E entry point.",
  },
  {
    path: "server/.github/workflows/pr.yml",
    owner: "embedded-server-pr-checks",
    classification: "embedded-nonmutating-support",
    status: "non-root-active",
    activation: "pull-request-portable",
    targetKind: "validation-support",
    targets: ["server pull-request checks"],
    reason:
      "This nested server definition is non-root-active in the monorepo and remains portable pull-request test material.",
  },
]);

const SERVER_QUARANTINED_UPSTREAM_WORKFLOWS = Object.freeze([
  {
    path: "server/.github/upstream-workflows-disabled/analytics.yml",
    owner: "@standardnotes/analytics",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "container-distribution",
    targets: ["Docker Hub standardnotes/analytics", "upstream Amazon ECR"],
    reason:
      "The preserved tag/manual publisher inherits secrets into mutable upstream reusable workflows.",
    workspacePackages: ["@standardnotes/analytics"],
  },
  {
    path: "server/.github/upstream-workflows-disabled/api-gateway.yml",
    owner: "@standardnotes/api-gateway",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "container-distribution",
    targets: ["Docker Hub standardnotes/api-gateway", "upstream Amazon ECR"],
    reason:
      "The preserved tag/manual publisher inherits secrets into mutable upstream reusable workflows.",
    workspacePackages: ["@standardnotes/api-gateway"],
  },
  {
    path: "server/.github/upstream-workflows-disabled/auth.yml",
    owner: "@standardnotes/auth-server",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "container-distribution",
    targets: ["Docker Hub standardnotes/auth", "upstream Amazon ECR"],
    reason:
      "The preserved tag/manual publisher inherits secrets into mutable upstream reusable workflows.",
    workspacePackages: ["@standardnotes/auth-server"],
  },
  {
    path: "server/.github/upstream-workflows-disabled/common-deploy.yml",
    owner: "upstream-server-deployment",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "infrastructure-deployment",
    targets: ["upstream Amazon ECS prod cluster and services"],
    reason:
      "The preserved reusable workflow rewrites production task definitions and deploys them with upstream AWS credentials.",
  },
  {
    path: "server/.github/upstream-workflows-disabled/common-docker-image.yml",
    owner: "upstream-server-container-publishing",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "container-distribution",
    targets: ["upstream Docker Hub and Amazon ECR mutable image tags"],
    reason:
      "The preserved reusable workflow pushes multi-architecture latest and commit-SHA tags to upstream registries.",
  },
  {
    path: "server/.github/upstream-workflows-disabled/common-self-hosting.yml",
    owner: "upstream-server-self-hosting-publishing",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "container-distribution",
    targets: ["Docker Hub standardnotes/server mutable image tags"],
    reason:
      "The preserved reusable workflow pushes upstream self-hosting latest and commit-SHA images.",
  },
  {
    path: "server/.github/upstream-workflows-disabled/common-server-application.yml",
    owner: "upstream-server-application-publishing",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "container-and-infrastructure-distribution",
    targets: [
      "upstream container registries",
      "upstream Amazon ECS deployment",
    ],
    reason:
      "The preserved reusable coordinator inherits secrets into mutable upstream publishing and deployment workflows.",
  },
  {
    path: "server/.github/upstream-workflows-disabled/files.yml",
    owner: "@standardnotes/files-server",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "container-distribution",
    targets: ["Docker Hub standardnotes/files", "upstream Amazon ECR"],
    reason:
      "The preserved tag/manual publisher inherits secrets into mutable upstream reusable workflows.",
    workspacePackages: ["@standardnotes/files-server"],
  },
  {
    path: "server/.github/upstream-workflows-disabled/publish.yml",
    owner: "upstream-server-package-publishing",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "mixed-package-and-distribution",
    targets: [
      "npm server workspaces",
      "Docker Hub standardnotes/server",
      "upstream signed release commits",
    ],
    reason:
      "The preserved main-branch workflow publishes upstream packages, containers, and signed release commits.",
  },
  {
    path: "server/.github/upstream-workflows-disabled/revisions.yml",
    owner: "@standardnotes/revisions-server",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "container-distribution",
    targets: ["Docker Hub standardnotes/revisions", "upstream Amazon ECR"],
    reason:
      "The preserved tag/manual publisher inherits secrets into mutable upstream reusable workflows.",
    workspacePackages: ["@standardnotes/revisions-server"],
  },
  {
    path: "server/.github/upstream-workflows-disabled/scheduler.yml",
    owner: "@standardnotes/scheduler-server",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "container-distribution",
    targets: ["Docker Hub standardnotes/scheduler", "upstream Amazon ECR"],
    reason:
      "The preserved tag/manual publisher inherits secrets into mutable upstream reusable workflows.",
    workspacePackages: ["@standardnotes/scheduler-server"],
  },
  {
    path: "server/.github/upstream-workflows-disabled/syncing-server.yml",
    owner: "@standardnotes/syncing-server",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "container-distribution",
    targets: [
      "Docker Hub standardnotes/syncing-server-js",
      "upstream Amazon ECR",
    ],
    reason:
      "The preserved tag/manual publisher inherits secrets into mutable upstream reusable workflows.",
    workspacePackages: ["@standardnotes/syncing-server"],
  },
  {
    path: "server/.github/upstream-workflows-disabled/websockets.yml",
    owner: "@standardnotes/websockets-server",
    classification: "quarantined-upstream-mutation",
    status: "quarantined",
    activation: "disabled-directory",
    targetKind: "container-distribution",
    targets: ["Docker Hub standardnotes/websockets", "upstream Amazon ECR"],
    reason:
      "The preserved tag/manual publisher inherits secrets into mutable upstream reusable workflows.",
    workspacePackages: ["@standardnotes/websockets-server"],
  },
]);

const DISTRIBUTION_WORKSPACE_SURFACES = Object.freeze({
  "@standardnotes/clipper": {
    kind: "shipped-application",
    expectedPrivate: true,
    packagePublicationPolicy: "not-applicable-distribution-surface",
    distributionStatus: "upstream-publisher-quarantined",
    workflowPaths: [
      "app/.github/upstream-workflows-disabled/clipper.release.prod.yml",
    ],
    targets: ["Firefox add-on", "Chromium extension"],
  },
  "@standardnotes/web": {
    kind: "shipped-application",
    expectedPrivate: true,
    packagePublicationPolicy: "not-applicable-distribution-surface",
    distributionStatus: "upstream-publisher-quarantined",
    workflowPaths: [
      "app/.github/upstream-workflows-disabled/web.release.prod.yml",
    ],
    targets: [
      "embedded web application in desktop and mobile products",
      "standalone web deployment (upstream publisher quarantined)",
    ],
  },
});

const WORKFLOW_TRIGGER_CONTRACTS = Object.freeze({
  ".github/workflows/ci.yml": [
    "pull_request",
    "push",
    "schedule",
    "workflow_dispatch",
  ],
  ".github/workflows/docs-pages.yml": [
    "pull_request",
    "push",
    "workflow_dispatch",
  ],
  ".github/workflows/release-contract.yml": [
    "pull_request",
    "push",
    "workflow_dispatch",
  ],
  ".github/workflows/srn-admin.yml": ["push", "workflow_dispatch"],
  ".github/workflows/srn-client.yml": ["push", "workflow_dispatch"],
  ".github/workflows/srn-desktop.yml": ["push", "workflow_dispatch"],
  ".github/workflows/srn-home-server.yml": ["push", "workflow_dispatch"],
  ".github/workflows/srn-mcp.yml": ["push", "workflow_dispatch"],
  ".github/workflows/srn-mobile.yml": ["push", "workflow_dispatch"],
  ".github/workflows/srn-openclaw.yml": ["push", "workflow_dispatch"],
  ".github/workflows/srn-server.yml": ["push", "workflow_dispatch"],
  "app/.github/workflows/codeql-analysis.yml": [
    "pull_request",
    "push",
    "schedule",
  ],
  "app/.github/workflows/desktop.release.prod.yml": ["workflow_dispatch"],
  "app/.github/workflows/desktop.release.reuse.yml": ["workflow_call"],
  "app/.github/workflows/mobile.release.prod.yml": ["workflow_dispatch"],
  "app/.github/workflows/pr.yml": ["pull_request"],
  "app/.github/workflows/snjs.pr.yml": ["pull_request", "workflow_dispatch"],
  "app/.github/workflows/snjs.upgrade.event.yml": [
    "repository_dispatch",
    "workflow_dispatch",
  ],
  "app/.github/upstream-workflows-disabled/clipper.release.prod.yml": [
    "push",
    "workflow_dispatch",
  ],
  "app/.github/upstream-workflows-disabled/git-sync.yml": [
    "push",
    "workflow_dispatch",
  ],
  "app/.github/upstream-workflows-disabled/ios.testflight.yml": [
    "workflow_dispatch",
  ],
  "app/.github/upstream-workflows-disabled/publish.yml": ["push"],
  "app/.github/upstream-workflows-disabled/releases.notify.yml": [
    "workflow_dispatch",
  ],
  "app/.github/upstream-workflows-disabled/web.release.prod.yml": ["push"],
  "server/.github/workflows/common-e2e.yml": ["workflow_call"],
  "server/.github/workflows/e2e-home-server.yml": ["workflow_call"],
  "server/.github/workflows/e2e-self-hosted.yml": ["workflow_call"],
  "server/.github/workflows/e2e-test-suite.yml": [
    "schedule",
    "workflow_dispatch",
  ],
  "server/.github/workflows/pr.yml": ["pull_request"],
  "server/.github/upstream-workflows-disabled/analytics.yml": [
    "push",
    "workflow_dispatch",
  ],
  "server/.github/upstream-workflows-disabled/api-gateway.yml": [
    "push",
    "workflow_dispatch",
  ],
  "server/.github/upstream-workflows-disabled/auth.yml": [
    "push",
    "workflow_dispatch",
  ],
  "server/.github/upstream-workflows-disabled/common-deploy.yml": [
    "workflow_call",
  ],
  "server/.github/upstream-workflows-disabled/common-docker-image.yml": [
    "workflow_call",
  ],
  "server/.github/upstream-workflows-disabled/common-self-hosting.yml": [
    "workflow_call",
  ],
  "server/.github/upstream-workflows-disabled/common-server-application.yml": [
    "workflow_call",
  ],
  "server/.github/upstream-workflows-disabled/files.yml": [
    "push",
    "workflow_dispatch",
  ],
  "server/.github/upstream-workflows-disabled/publish.yml": ["push"],
  "server/.github/upstream-workflows-disabled/revisions.yml": [
    "push",
    "workflow_dispatch",
  ],
  "server/.github/upstream-workflows-disabled/scheduler.yml": [
    "push",
    "workflow_dispatch",
  ],
  "server/.github/upstream-workflows-disabled/syncing-server.yml": [
    "push",
    "workflow_dispatch",
  ],
  "server/.github/upstream-workflows-disabled/websockets.yml": [
    "push",
    "workflow_dispatch",
  ],
});

export class ReleaseImpactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseImpactError";
    this.code = code;
  }
}

export function createReleaseAnalysisContext(repo = process.cwd()) {
  return {
    repo: path.resolve(repo),
    ancestry: new Map(),
    changedFiles: new Map(),
    commits: new Map(),
    completeHistory: false,
    files: new Map(),
    manifests: new Map(),
    tags: new Map(),
    workspaces: new Map(),
  };
}

function analysisContext(repo, context) {
  const resolvedRepo = path.resolve(repo);
  if (context && context.repo !== resolvedRepo) {
    throw new ReleaseImpactError(
      "analysis-context-mismatch",
      `Analysis context belongs to '${context.repo}', not '${resolvedRepo}'.`,
    );
  }
  return context ?? createReleaseAnalysisContext(resolvedRepo);
}

function normalizePath(value) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function git(repo, args, options = {}) {
  try {
    const output = execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    return Buffer.isBuffer(output) ? output : output.trim();
  } catch (error) {
    const stderr =
      typeof error?.stderr === "string"
        ? error.stderr.trim()
        : Buffer.isBuffer(error?.stderr)
          ? error.stderr.toString("utf8").trim()
          : "";
    throw new ReleaseImpactError(
      "git-command-failed",
      `git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
    );
  }
}

function gitStatus(repo, args) {
  return spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function ensureCompleteHistory(context) {
  if (context.completeHistory) {
    return;
  }
  const shallow = git(context.repo, ["rev-parse", "--is-shallow-repository"]);
  if (shallow !== "false") {
    throw new ReleaseImpactError(
      "shallow-history",
      "Release impact cannot be determined from a shallow repository; fetch complete history and tags.",
    );
  }
  context.completeHistory = true;
}

function resolveCommit(context, ref, label) {
  if (context.commits.has(ref)) {
    return context.commits.get(ref);
  }
  const result = gitStatus(context.repo, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  if (result.status !== 0) {
    throw new ReleaseImpactError(
      "missing-ref",
      `${label} ref '${ref}' does not resolve to a commit.`,
    );
  }
  const commit = result.stdout.trim();
  context.commits.set(ref, commit);
  return commit;
}

function resolveReleaseTagCommit(context, tag, label = "Release") {
  return resolveCommit(context, `refs/tags/${tag}`, `${label} tag`);
}

function parseSemverVersion(suffix) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      suffix,
    );
  const prerelease = match?.[4]?.split(".") ?? [];
  if (
    !match ||
    prerelease.some(
      (identifier) => /^\d+$/.test(identifier) && /^0\d+/.test(identifier),
    )
  ) {
    return undefined;
  }
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
    build: match[5]?.split(".") ?? [],
    profile: "semver",
  };
}

function parseRollingYearVersion(suffix) {
  const match = /^(\d{2})\.([1-9]\d*)$/.exec(suffix);
  if (!match) {
    return undefined;
  }
  return {
    core: [BigInt(match[1]), BigInt(match[2])],
    prerelease: [],
    build: [],
    profile: "rolling-year",
  };
}

function assertVersionProfile(versioning, prefix) {
  if (!VERSION_PROFILES.has(versioning)) {
    throw new ReleaseImpactError(
      "unknown-version-profile",
      `Release prefix '${prefix}' has unknown version profile '${versioning}'.`,
    );
  }
}

function numericVersion(tag, prefix, versioning) {
  assertVersionProfile(versioning, prefix);
  if (!tag.startsWith(prefix)) {
    return undefined;
  }
  const suffix = tag.slice(prefix.length);
  let version;
  if (versioning === "rolling-year") {
    version = parseRollingYearVersion(suffix);
  } else if (versioning === "semver") {
    version = parseSemverVersion(suffix);
  } else if (versioning === "rolling-year-or-semver") {
    version = parseRollingYearVersion(suffix) ?? parseSemverVersion(suffix);
  }
  if (!version) {
    throw new ReleaseImpactError(
      "malformed-release-ref",
      `Release ref '${tag}' matches prefix '${prefix}' but is invalid for the '${versioning}' version profile.`,
    );
  }
  return version;
}

function compareVersions(left, right) {
  const width = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < width; index += 1) {
    const leftComponent = left.core[index] ?? 0n;
    const rightComponent = right.core[index] ?? 0n;
    if (leftComponent !== rightComponent) {
      return leftComponent < rightComponent ? -1 : 1;
    }
  }
  const coreWidth = left.core.length - right.core.length;
  if (coreWidth !== 0) {
    return coreWidth;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  const prereleaseWidth = Math.max(
    left.prerelease.length,
    right.prerelease.length,
  );
  for (let index = 0; index < prereleaseWidth; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier
        ? 0
        : leftIdentifier === undefined
          ? -1
          : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftIdentifier);
      const rightNumber = BigInt(rightIdentifier);
      return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier.localeCompare(rightIdentifier);
  }
  return 0;
}

function rejectHybridPackageVersionCollisions(parsed, prefix) {
  const rollingVersions = new Map();
  const stableSemverVersions = new Map();
  for (const candidate of parsed) {
    const { version } = candidate;
    if (version.profile === "rolling-year") {
      rollingVersions.set(
        `${version.core[0]}.${version.core[1]}.0`,
        candidate.tag,
      );
    } else if (
      version.prerelease.length === 0 &&
      version.build.length === 0 &&
      version.core[2] === 0n
    ) {
      stableSemverVersions.set(
        `${version.core[0]}.${version.core[1]}.${version.core[2]}`,
        candidate.tag,
      );
    }
  }
  for (const [packageVersion, rollingTag] of rollingVersions) {
    const semverTag = stableSemverVersions.get(packageVersion);
    if (semverTag) {
      throw new ReleaseImpactError(
        "release-version-collision",
        `Release refs '${rollingTag}' and '${semverTag}' under '${prefix}' resolve to the same internal package version '${packageVersion}'.`,
      );
    }
  }
}

function matchingReleaseTags(context, prefix, versioning) {
  const cacheKey = `${prefix}\0${versioning}`;
  if (context.tags.has(cacheKey)) {
    return context.tags.get(cacheKey);
  }
  const output = git(context.repo, ["tag", "--list", `${prefix}*`]);
  if (!output) {
    context.tags.set(cacheKey, []);
    return [];
  }

  const parsed = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((tag) => ({
      tag,
      version: numericVersion(tag, prefix, versioning),
    }));

  if (versioning === "rolling-year-or-semver") {
    rejectHybridPackageVersionCollisions(parsed, prefix);
  }

  parsed.sort((left, right) => {
    const versionOrder = compareVersions(right.version, left.version);
    return versionOrder || left.tag.localeCompare(right.tag);
  });

  for (let index = 1; index < parsed.length; index += 1) {
    if (
      compareVersions(parsed[index - 1].version, parsed[index].version) === 0
    ) {
      throw new ReleaseImpactError(
        "ambiguous-release-history",
        `Release refs '${parsed[index - 1].tag}' and '${parsed[index].tag}' represent the same version.`,
      );
    }
  }

  context.tags.set(cacheKey, parsed);
  return parsed;
}

function isAncestor(context, ancestorSha, headSha) {
  const cacheKey = `${ancestorSha}\0${headSha}`;
  if (context.ancestry.has(cacheKey)) {
    return context.ancestry.get(cacheKey);
  }
  const result = gitStatus(context.repo, [
    "merge-base",
    "--is-ancestor",
    ancestorSha,
    headSha,
  ]);
  if (result.status !== 0 && result.status !== 1) {
    throw new ReleaseImpactError(
      "git-command-failed",
      `git merge-base --is-ancestor ${ancestorSha} ${headSha} failed: ${result.stderr.trim()}`,
    );
  }
  const ancestor = result.status === 0;
  context.ancestry.set(cacheKey, ancestor);
  return ancestor;
}

function selectTopologicalHybridBase(context, candidates, headSha) {
  const ancestors = [];
  const nonAncestorRefs = [];
  for (const candidate of candidates) {
    const sha = resolveReleaseTagCommit(context, candidate.tag);
    if (isAncestor(context, sha, headSha)) {
      ancestors.push({ ...candidate, sha });
    } else {
      nonAncestorRefs.push(candidate.tag);
    }
  }
  if (ancestors.length === 0) {
    return { selected: undefined, nonAncestorRefs };
  }

  const latest = ancestors.filter((candidate) =>
    ancestors.every(
      (other) =>
        other.tag === candidate.tag ||
        (other.sha !== candidate.sha &&
          isAncestor(context, other.sha, candidate.sha)),
    ),
  );
  if (latest.length !== 1) {
    throw new ReleaseImpactError(
      "ambiguous-hybrid-release-history",
      `Hybrid release refs do not have one unique latest ancestor of the requested head: ${ancestors
        .map(({ tag }) => tag)
        .join(", ")}.`,
    );
  }
  return { selected: latest[0], nonAncestorRefs };
}

function resolveBase(
  context,
  prefix,
  versioning,
  explicitBaseRef,
  headSha,
  excludedReleaseRef,
) {
  let candidates = matchingReleaseTags(context, prefix, versioning);
  if (excludedReleaseRef) {
    const excludedVersion = numericVersion(
      excludedReleaseRef,
      prefix,
      versioning,
    );
    if (!excludedVersion) {
      throw new ReleaseImpactError(
        "mismatched-release-ref",
        `Excluded release ref '${excludedReleaseRef}' does not match release prefix '${prefix}'.`,
      );
    }
    if (!candidates.some(({ tag }) => tag === excludedReleaseRef)) {
      throw new ReleaseImpactError(
        "missing-ref",
        `Excluded release tag '${excludedReleaseRef}' does not exist.`,
      );
    }
    const excludedSha = resolveReleaseTagCommit(
      context,
      excludedReleaseRef,
      "Excluded release",
    );
    if (excludedSha !== headSha) {
      throw new ReleaseImpactError(
        "excluded-release-ref-mismatch",
        `Excluded release ref '${excludedReleaseRef}' does not resolve to the requested head.`,
      );
    }
    if (explicitBaseRef === excludedReleaseRef) {
      throw new ReleaseImpactError(
        "invalid-release-ref-selection",
        `Release ref '${excludedReleaseRef}' cannot be both excluded and selected as the baseline.`,
      );
    }
    candidates = candidates.filter(({ tag }) => tag !== excludedReleaseRef);
  }
  let selected;
  const nonAncestorRefs = [];
  if (explicitBaseRef) {
    const explicitVersion = numericVersion(explicitBaseRef, prefix, versioning);
    if (!explicitVersion) {
      throw new ReleaseImpactError(
        "mismatched-release-ref",
        `Base ref '${explicitBaseRef}' does not match release prefix '${prefix}'.`,
      );
    }
    if (!candidates.some(({ tag }) => tag === explicitBaseRef)) {
      throw new ReleaseImpactError(
        "missing-ref",
        `Base release tag '${explicitBaseRef}' does not exist.`,
      );
    }
    const explicitSha = resolveReleaseTagCommit(
      context,
      explicitBaseRef,
      "Base release",
    );
    if (!isAncestor(context, explicitSha, headSha)) {
      throw new ReleaseImpactError(
        "divergent-release-history",
        `Requested release ref '${explicitBaseRef}' is not an ancestor of the requested head.`,
      );
    }
    selected = {
      tag: explicitBaseRef,
      sha: explicitSha,
      version: explicitVersion,
    };
  } else if (versioning === "rolling-year-or-semver") {
    const topological = selectTopologicalHybridBase(
      context,
      candidates,
      headSha,
    );
    selected = topological.selected;
    nonAncestorRefs.push(...topological.nonAncestorRefs);
  } else {
    for (const candidate of candidates) {
      const candidateSha = resolveReleaseTagCommit(context, candidate.tag);
      if (isAncestor(context, candidateSha, headSha)) {
        selected ??= { ...candidate, sha: candidateSha };
      } else {
        nonAncestorRefs.push(candidate.tag);
      }
    }
  }

  if (!selected) {
    return {
      ref: null,
      sha: null,
      firstRelease: candidates.length === 0,
      noAncestorBaseline: candidates.length > 0,
      matchingRefs: candidates.map(({ tag }) => tag),
      nonAncestorRefs,
      nonAncestorNewerRefs: nonAncestorRefs,
    };
  }

  if (explicitBaseRef) {
    for (const candidate of candidates) {
      if (candidate.tag === explicitBaseRef) {
        continue;
      }
      const candidateSha = resolveReleaseTagCommit(context, candidate.tag);
      if (!isAncestor(context, candidateSha, headSha)) {
        nonAncestorRefs.push(candidate.tag);
      }
    }
  }

  const nonAncestorNewerRefs = nonAncestorRefs.filter((tag) => {
    const candidate = candidates.find((entry) => entry.tag === tag);
    return (
      candidate && compareVersions(candidate.version, selected.version) > 0
    );
  });

  return {
    ref: selected.tag,
    sha: selected.sha,
    firstRelease: false,
    noAncestorBaseline: false,
    matchingRefs: candidates.map(({ tag }) => tag),
    nonAncestorRefs,
    nonAncestorNewerRefs,
  };
}

function readAtRef(context, ref, file) {
  const normalizedFile = normalizePath(file);
  const key = `${ref}\0${normalizedFile}`;
  if (context.manifests.has(key)) {
    return context.manifests.get(key);
  }
  const result = gitStatus(context.repo, ["show", `${ref}:${normalizedFile}`]);
  if (result.status !== 0) {
    context.manifests.set(key, undefined);
    return undefined;
  }
  context.manifests.set(key, result.stdout);
  return result.stdout;
}

function parseJsonAtRef(context, ref, file, label) {
  const content = readAtRef(context, ref, file);
  if (content === undefined) {
    throw new ReleaseImpactError(
      "missing-manifest",
      `${label} manifest '${file}' is missing at ${ref}.`,
    );
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new ReleaseImpactError(
      "malformed-manifest",
      `${label} manifest '${file}' is not valid JSON at ${ref}.`,
    );
  }
}

function filesAtRef(context, ref) {
  if (context.files.has(ref)) {
    return context.files.get(ref);
  }
  const output = git(
    context.repo,
    ["ls-tree", "-r", "--name-only", "-z", ref],
    {
      encoding: "buffer",
    },
  );
  if (!output) {
    context.files.set(ref, []);
    return [];
  }
  const files = output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .sort();
  context.files.set(ref, files);
  return files;
}

function changedFilesBetween(context, baseSha, headSha) {
  const key = `${baseSha}\0${headSha}`;
  if (context.changedFiles.has(key)) {
    return context.changedFiles.get(key);
  }
  const output = git(
    context.repo,
    [
      "diff",
      "--no-renames",
      "--name-only",
      "--diff-filter=ACDMRTUXB",
      "-z",
      baseSha,
      headSha,
    ],
    { encoding: "buffer" },
  );
  if (!output) {
    context.changedFiles.set(key, []);
    return [];
  }
  const files = output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .sort();
  context.changedFiles.set(key, files);
  return files;
}

function globPatternToRegex(pattern) {
  const normalized = normalizePath(pattern);
  let result = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        result += ".*";
        index += 1;
      } else {
        result += "[^/]*";
      }
    } else if (character === "?") {
      result += "[^/]";
    } else {
      result += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${result}$`);
}

function workspacePatterns(manifest) {
  if (Array.isArray(manifest.workspaces)) {
    return manifest.workspaces;
  }
  if (Array.isArray(manifest.workspaces?.packages)) {
    return manifest.workspaces.packages;
  }
  throw new ReleaseImpactError(
    "missing-workspaces",
    "Workspace root manifest does not declare a supported workspaces list.",
  );
}

function loadWorkspace(context, ref, workspaceRootName) {
  const definition = WORKSPACE_ROOTS[workspaceRootName];
  if (!definition) {
    throw new ReleaseImpactError(
      "unknown-workspace-root",
      `Unknown workspace root '${workspaceRootName}'.`,
    );
  }

  const cacheKey = `${ref}\0${workspaceRootName}`;
  if (context.workspaces.has(cacheKey)) {
    return context.workspaces.get(cacheKey);
  }

  const rootManifest = parseJsonAtRef(
    context,
    ref,
    definition.manifest,
    "Workspace root",
  );
  const trackedFiles = filesAtRef(context, ref);
  const manifestMatchers = workspacePatterns(rootManifest).map((pattern) => {
    const relativeManifest = `${normalizePath(pattern)}/package.json`;
    const rootedManifest = definition.directory
      ? `${definition.directory}/${relativeManifest}`
      : relativeManifest;
    return globPatternToRegex(rootedManifest);
  });

  const packageManifestPaths = trackedFiles.filter((file) =>
    manifestMatchers.some((matcher) => matcher.test(file)),
  );
  const packages = new Map();
  for (const manifestPath of packageManifestPaths) {
    const manifest = parseJsonAtRef(
      context,
      ref,
      manifestPath,
      "Workspace package",
    );
    if (typeof manifest.name !== "string" || !manifest.name) {
      throw new ReleaseImpactError(
        "unnamed-workspace-package",
        `Workspace manifest '${manifestPath}' has no package name at ${ref}.`,
      );
    }
    if (packages.has(manifest.name)) {
      throw new ReleaseImpactError(
        "duplicate-workspace-package",
        `Workspace package '${manifest.name}' is declared more than once at ${ref}.`,
      );
    }
    packages.set(manifest.name, {
      name: manifest.name,
      manifest,
      manifestPath,
      directory: path.posix.dirname(manifestPath),
    });
  }

  const workspace = {
    definition,
    packages,
    rootManifest,
  };
  context.workspaces.set(cacheKey, workspace);
  return workspace;
}

function dependencyNames(manifest) {
  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      names.add(name);
    }
  }
  return names;
}

function transitiveWorkspacePackages(
  workspace,
  rootPackageNames,
  options = {},
) {
  const queue = [...rootPackageNames];
  const visited = new Set();
  while (queue.length > 0) {
    const packageName = queue.shift();
    if (visited.has(packageName)) {
      continue;
    }
    const workspacePackage = workspace.packages.get(packageName);
    if (!workspacePackage) {
      if (options.allowMissingRoot && rootPackageNames.includes(packageName)) {
        continue;
      }
      throw new ReleaseImpactError(
        "missing-workspace-package",
        `Workspace package '${packageName}' is not present in the selected workspace.`,
      );
    }
    visited.add(packageName);
    for (const dependencyName of dependencyNames(workspacePackage.manifest)) {
      if (workspace.packages.has(dependencyName)) {
        queue.push(dependencyName);
      }
    }
  }
  return [...visited]
    .map((name) => workspace.packages.get(name))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function mergeUnique(values) {
  return [...new Set(values.filter(Boolean).map(normalizePath))].sort();
}

function packageSurfaceForDefinition(context, ref, definition, options = {}) {
  if (definition.packageDirs) {
    return {
      packages: definition.packageDirs
        .map((entry) => ({
          name: entry.name,
          directory: normalizePath(entry.directory),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      workspaceConfigPaths: [],
      workspaceConfigPrefixes: [],
    };
  }

  const workspace = loadWorkspace(context, ref, definition.workspaceRoot);
  return {
    packages: transitiveWorkspacePackages(
      workspace,
      definition.packageNames,
      options,
    ).map(({ name, directory }) => ({ name, directory })),
    workspaceConfigPaths: workspace.definition.configPaths,
    workspaceConfigPrefixes: workspace.definition.configPrefixes,
  };
}

function matchesDirectory(file, directory) {
  return file === directory || file.startsWith(`${directory}/`);
}

function classifyChangedFiles(
  changedFiles,
  packages,
  configPaths,
  configPrefixes,
  rootPackageNames,
) {
  const matchedFiles = [];
  const ignoredFiles = [];
  const reasonBuckets = new Map();

  const sortedPackages = [...packages].sort(
    (left, right) => right.directory.length - left.directory.length,
  );

  const addReasonPath = (code, file, packageName) => {
    const key = `${code}\0${packageName ?? ""}`;
    const bucket = reasonBuckets.get(key) ?? {
      code,
      ...(packageName ? { package: packageName } : {}),
      paths: [],
    };
    bucket.paths.push(file);
    reasonBuckets.set(key, bucket);
  };

  for (const file of changedFiles) {
    const workspacePackage = sortedPackages.find((entry) =>
      matchesDirectory(file, entry.directory),
    );
    const exactConfig = configPaths.includes(file);
    const prefixConfig = configPrefixes.find((prefix) =>
      file.startsWith(prefix),
    );

    if (workspacePackage) {
      matchedFiles.push(file);
      addReasonPath(
        rootPackageNames.includes(workspacePackage.name)
          ? "target-package-change"
          : "workspace-dependency-change",
        file,
        workspacePackage.name,
      );
    } else if (exactConfig || prefixConfig) {
      matchedFiles.push(file);
      addReasonPath("release-build-config-change", file);
    } else {
      ignoredFiles.push(file);
    }
  }

  return {
    ignoredFiles,
    matchedFiles,
    reasons: [...reasonBuckets.values()]
      .map((reason) => ({ ...reason, paths: reason.paths.sort() }))
      .sort((left, right) => {
        const codeOrder = left.code.localeCompare(right.code);
        return (
          codeOrder || (left.package ?? "").localeCompare(right.package ?? "")
        );
      }),
  };
}

function applyNativeExecutorSemanticImpact({
  classified,
  context,
  baseSha,
  headSha,
  identity,
}) {
  const beforeSource = readAtRef(context, baseSha, NATIVE_EXECUTOR_PATH);
  const afterSource = readAtRef(context, headSha, NATIVE_EXECUTOR_PATH);
  const semanticChange = classifyNativeCliExecutorSemanticChange({
    beforeSource,
    afterSource,
  });
  if (semanticChange.classification === "ambiguous") {
    throw new ReleaseImpactError(
      "ambiguous-native-executor-semantics",
      `Native executor semantics cannot be classified safely: ${semanticChange.error ?? "unknown semantic parser error"}.`,
    );
  }
  const affectsTarget = semanticChange.affectedProducts.includes(identity);
  const destination = affectsTarget
    ? classified.matchedFiles
    : classified.ignoredFiles;
  destination.push(NATIVE_EXECUTOR_PATH);
  destination.sort();

  if (!affectsTarget) {
    return semanticChange;
  }
  const code =
    semanticChange.classification === "shared"
      ? "native-executor-shared-semantic-change"
      : "native-executor-product-semantic-change";
  classified.reasons.push({
    code,
    paths: [NATIVE_EXECUTOR_PATH],
    products: semanticChange.affectedProducts,
    ...(semanticChange.migration
      ? {
          migration: true,
          migrationReason: semanticChange.migrationReason,
        }
      : {}),
    ...(semanticChange.error ? { error: semanticChange.error } : {}),
  });
  classified.reasons.sort((left, right) => left.code.localeCompare(right.code));
  return semanticChange;
}

function applyReleasePackagingContractSemanticImpact({
  classified,
  context,
  baseSha,
  headSha,
  identity,
}) {
  const beforeSource = readAtRef(
    context,
    baseSha,
    RELEASE_PACKAGING_CONTRACT_PATH,
  );
  const afterSource = readAtRef(
    context,
    headSha,
    RELEASE_PACKAGING_CONTRACT_PATH,
  );
  const semanticChange = classifyReleasePackagingContractSemanticChange({
    beforeSource,
    afterSource,
  });
  if (semanticChange.classification === "ambiguous") {
    throw new ReleaseImpactError(
      "ambiguous-release-packaging-contract-semantics",
      `Release packaging contract semantics cannot be classified safely: ${semanticChange.error ?? "unknown semantic parser error"}.`,
    );
  }
  const affectsTarget = semanticChange.affectedProducts.includes(identity);
  const destination = affectsTarget
    ? classified.matchedFiles
    : classified.ignoredFiles;
  destination.push(RELEASE_PACKAGING_CONTRACT_PATH);
  destination.sort();

  if (!affectsTarget) {
    return semanticChange;
  }
  classified.reasons.push({
    code: `release-packaging-contract-${semanticChange.classification}-semantic-change`,
    paths: [RELEASE_PACKAGING_CONTRACT_PATH],
    products: semanticChange.affectedProducts,
    ...(semanticChange.migration
      ? {
          migration: true,
          migrationReason: semanticChange.migrationReason,
        }
      : {}),
    ...(semanticChange.error ? { error: semanticChange.error } : {}),
  });
  classified.reasons.sort((left, right) => left.code.localeCompare(right.code));
  return semanticChange;
}

function validateForce(force, forceReason) {
  const normalizedReason =
    typeof forceReason === "string" ? forceReason.trim() : "";
  if (force && !normalizedReason) {
    throw new ReleaseImpactError(
      "unaudited-force",
      "A forced release requires a non-empty --force-reason.",
    );
  }
  if (!force && normalizedReason) {
    throw new ReleaseImpactError(
      "unexpected-force-reason",
      "--force-reason was supplied without --force true.",
    );
  }
  if (normalizedReason.length > MAX_FORCE_REASON_LENGTH) {
    throw new ReleaseImpactError(
      "force-reason-too-long",
      `--force-reason must not exceed ${MAX_FORCE_REASON_LENGTH} characters.`,
    );
  }
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(normalizedReason)) {
    throw new ReleaseImpactError(
      "invalid-force-reason",
      "--force-reason must be a single printable line.",
    );
  }
  return normalizedReason;
}

export function analyzeDefinitionImpact({
  repo = process.cwd(),
  context: providedContext,
  definition,
  identity,
  headRef = "HEAD",
  baseRef,
  excludeReleaseRef,
  force = false,
  forceReason = "",
}) {
  const auditedForceReason = validateForce(force, forceReason);
  assertVersionProfile(definition.versioning, definition.tagPrefix);
  const context = analysisContext(repo, providedContext);
  ensureCompleteHistory(context);
  const headSha = resolveCommit(context, headRef, "Head");
  const base = resolveBase(
    context,
    definition.tagPrefix,
    definition.versioning,
    baseRef,
    headSha,
    excludeReleaseRef,
  );

  const headSurface = packageSurfaceForDefinition(context, headSha, definition);
  const baseSurface = base.sha
    ? packageSurfaceForDefinition(context, base.sha, definition, {
        allowMissingRoot: true,
      })
    : {
        packages: [],
        workspaceConfigPaths: [],
        workspaceConfigPrefixes: [],
      };

  const packagesByName = new Map();
  for (const workspacePackage of [
    ...baseSurface.packages,
    ...headSurface.packages,
  ]) {
    packagesByName.set(workspacePackage.name, workspacePackage);
  }
  const packages = [...packagesByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  const configPaths = mergeUnique([
    ...(definition.configPaths ?? []),
    ...baseSurface.workspaceConfigPaths,
    ...headSurface.workspaceConfigPaths,
  ]);
  const configPrefixes = mergeUnique([
    ...(definition.configPrefixes ?? []),
    ...baseSurface.workspaceConfigPrefixes,
    ...headSurface.workspaceConfigPrefixes,
  ]);

  const changedFiles = base.sha
    ? changedFilesBetween(context, base.sha, headSha)
    : [];
  const hasNativeExecutorChange =
    base.sha &&
    NATIVE_CLI_RELEASE_PRODUCTS.includes(identity) &&
    changedFiles.includes(NATIVE_EXECUTOR_PATH);
  const hasReleasePackagingContractChange =
    base.sha &&
    RELEASE_PACKAGING_CONTRACT_PRODUCTS.includes(identity) &&
    changedFiles.includes(RELEASE_PACKAGING_CONTRACT_PATH);
  const semanticConfigPaths = new Set([
    ...(hasNativeExecutorChange ? [NATIVE_EXECUTOR_PATH] : []),
    ...(hasReleasePackagingContractChange
      ? [RELEASE_PACKAGING_CONTRACT_PATH]
      : []),
  ]);
  const genericallyClassifiedFiles = changedFiles.filter(
    (file) => !semanticConfigPaths.has(file),
  );
  const classified = classifyChangedFiles(
    genericallyClassifiedFiles,
    packages,
    configPaths,
    configPrefixes,
    definition.packageNames ?? definition.packageDirs.map(({ name }) => name),
  );
  if (hasNativeExecutorChange) {
    applyNativeExecutorSemanticImpact({
      classified,
      context,
      baseSha: base.sha,
      headSha,
      identity,
    });
  }
  if (hasReleasePackagingContractChange) {
    applyReleasePackagingContractSemanticImpact({
      classified,
      context,
      baseSha: base.sha,
      headSha,
      identity,
    });
  }

  const reasons = [...classified.reasons];
  if (base.firstRelease) {
    reasons.unshift({
      code: "first-release",
      message: `No prior release ref matching '${definition.tagPrefix}*' exists.`,
    });
  }
  if (base.noAncestorBaseline) {
    reasons.unshift({
      code: "no-ancestor-baseline",
      message: `Release refs matching '${definition.tagPrefix}*' exist, but none is an ancestor of the requested head.`,
      refs: base.nonAncestorRefs,
    });
  } else if (base.nonAncestorRefs.length > 0) {
    const hasNewerDivergentRelease = base.nonAncestorNewerRefs.length > 0;
    reasons.push({
      code:
        definition.versioning === "rolling-year-or-semver"
          ? "divergent-release"
          : hasNewerDivergentRelease
            ? "divergent-newer-release"
            : "divergent-release",
      message:
        definition.versioning === "rolling-year-or-semver"
          ? "Version-valid release refs exist outside the requested head history."
          : hasNewerDivergentRelease
            ? "Newer version-valid release refs exist outside the requested head history."
            : "Older version-valid release refs exist outside the requested head history.",
      refs: base.nonAncestorRefs,
    });
  }
  if (force) {
    reasons.unshift({
      code: "forced-release",
      message: auditedForceReason,
    });
  }

  return {
    schemaVersion: 1,
    mode: "single",
    identity,
    tagPrefix: definition.tagPrefix,
    versioning: definition.versioning,
    changed:
      force ||
      base.firstRelease ||
      base.noAncestorBaseline ||
      base.nonAncestorRefs.length > 0 ||
      classified.matchedFiles.length > 0,
    forced: force,
    forceReason: force ? auditedForceReason : null,
    publicationGate: force
      ? "force-requested"
      : base.noAncestorBaseline || base.nonAncestorRefs.length > 0
        ? "blocked-release-history"
        : base.firstRelease
          ? "first-release-candidate"
          : classified.matchedFiles.length > 0
            ? "build-and-compare"
            : "no-source-impact",
    firstRelease: base.firstRelease,
    noAncestorBaseline: base.noAncestorBaseline,
    baselinePolicy:
      definition.versioning === "rolling-year-or-semver"
        ? "latest-topological-ancestor"
        : "latest-version-valid-ancestor",
    baselineStatus: base.firstRelease
      ? "first-release"
      : base.noAncestorBaseline
        ? "no-ancestor"
        : base.nonAncestorRefs.length > 0
          ? definition.versioning === "rolling-year-or-semver"
            ? "ancestor-with-divergent-tags"
            : base.nonAncestorNewerRefs.length > 0
              ? "ancestor-with-newer-divergent-tags"
              : "ancestor-with-divergent-tags"
          : "ancestor",
    baseRef: base.ref,
    baseSha: base.sha,
    headRef,
    headSha,
    excludedReleaseRef: excludeReleaseRef || null,
    matchingReleaseRefs: base.matchingRefs,
    latestMatchingReleaseRef: base.matchingRefs[0] ?? null,
    latestReleaseRef:
      definition.versioning === "rolling-year-or-semver"
        ? base.ref
        : (base.matchingRefs[0] ?? null),
    divergentReleaseRefs: base.nonAncestorRefs,
    divergentNewerReleaseRefs: base.nonAncestorNewerRefs,
    packages,
    dependencyClosure: packages.map(({ name }) => name),
    configPaths,
    configPrefixes,
    changedFiles,
    matchedFiles: classified.matchedFiles,
    ignoredFiles: classified.ignoredFiles,
    reasons,
  };
}

export function analyzeProductImpact(options) {
  const definition = RELEASE_TARGETS[options.target];
  if (!definition) {
    throw new ReleaseImpactError(
      "unknown-release-target",
      `Unknown release target '${options.target}'.`,
    );
  }
  return analyzeDefinitionImpact({
    ...options,
    definition,
    identity: options.target,
  });
}

export function discoverReleaseTargetSurface({
  repo = process.cwd(),
  context: providedContext,
  target,
  headRef = "HEAD",
}) {
  const definition = RELEASE_TARGETS[target];
  if (!definition) {
    throw new ReleaseImpactError(
      "unknown-release-target",
      `Unknown release target '${target}'.`,
    );
  }
  const context = analysisContext(repo, providedContext);
  const headSha = resolveCommit(context, headRef, "Head");
  const surface = packageSurfaceForDefinition(context, headSha, definition);
  return {
    target,
    headRef,
    headSha,
    packageDirectories: surface.packages.map(({ directory }) => directory),
    dependencyClosure: surface.packages.map(({ name }) => name),
    configPaths: mergeUnique([
      ...(definition.configPaths ?? []),
      ...surface.workspaceConfigPaths,
    ]),
    configPrefixes: mergeUnique([
      ...(definition.configPrefixes ?? []),
      ...surface.workspaceConfigPrefixes,
    ]),
  };
}

function workspaceRootForPackage(context, headRef, packageName, requestedRoot) {
  const rootNames = requestedRoot
    ? [requestedRoot]
    : Object.keys(WORKSPACE_ROOTS);
  const matches = [];
  for (const rootName of rootNames) {
    const workspace = loadWorkspace(context, headRef, rootName);
    if (workspace.packages.has(packageName)) {
      matches.push(rootName);
    }
  }
  if (matches.length === 0) {
    throw new ReleaseImpactError(
      "missing-workspace-package",
      `Package '${packageName}' was not found in the selected workspace roots.`,
    );
  }
  if (matches.length > 1) {
    throw new ReleaseImpactError(
      "ambiguous-workspace-package",
      `Package '${packageName}' exists in multiple workspace roots: ${matches.join(", ")}.`,
    );
  }
  return matches[0];
}

export function analyzeWorkspacePackageImpact({
  repo = process.cwd(),
  context: providedContext,
  packageName,
  workspaceRoot,
  ...options
}) {
  const context = analysisContext(repo, providedContext);
  ensureCompleteHistory(context);
  const headSha = resolveCommit(context, options.headRef ?? "HEAD", "Head");
  const resolvedWorkspaceRoot = workspaceRootForPackage(
    context,
    headSha,
    packageName,
    workspaceRoot,
  );
  return analyzeDefinitionImpact({
    repo,
    context,
    ...options,
    definition: {
      workspaceRoot: resolvedWorkspaceRoot,
      packageNames: [packageName],
      tagPrefix: `${packageName}@`,
      versioning: "semver",
      configPaths: [],
      configPrefixes: [],
    },
    identity: packageName,
  });
}

export function analyzeAllWorkspacePackages({
  repo = process.cwd(),
  context: providedContext,
  workspaceRoot,
  headRef = "HEAD",
  force = false,
  forceReason = "",
}) {
  if (!WORKSPACE_ROOTS[workspaceRoot]) {
    throw new ReleaseImpactError(
      "unknown-workspace-root",
      `Unknown workspace root '${workspaceRoot}'.`,
    );
  }
  const context = analysisContext(repo, providedContext);
  ensureCompleteHistory(context);
  const headSha = resolveCommit(context, headRef, "Head");
  const workspace = loadWorkspace(context, headSha, workspaceRoot);
  const packages = [...workspace.packages.keys()].sort().map((packageName) => {
    const workspacePackage = workspace.packages.get(packageName);
    const releaseTargets = releaseTargetsForPackage(packageName);
    return {
      ...analyzeWorkspacePackageImpact({
        repo,
        context,
        packageName,
        workspaceRoot,
        headRef,
        force,
        forceReason,
      }),
      workspaceRoot,
      category: releaseCategory(workspacePackage, releaseTargets),
      releaseTargets,
    };
  });

  return {
    schemaVersion: 1,
    mode: "all-workspaces",
    workspaceRoot,
    headRef,
    headSha,
    changed: packages.some((entry) => entry.changed),
    changedPackages: packages
      .filter((entry) => entry.changed)
      .map((entry) => entry.identity),
    packages,
  };
}

function releaseTargetsForPackage(packageName) {
  return Object.entries(RELEASE_TARGETS)
    .filter(([, definition]) => definition.packageNames?.includes(packageName))
    .map(([target]) => target)
    .sort();
}

function releaseCategory(workspacePackage, releaseTargets) {
  if (releaseTargets.length > 0) {
    return "release-managed";
  }
  if (DISTRIBUTION_WORKSPACE_SURFACES[workspacePackage.name]) {
    return "distribution-surface";
  }
  return workspacePackage.manifest.private === true
    ? "private"
    : "publishable-unmanaged";
}

export function discoverWorkspaceInventory({
  repo = process.cwd(),
  context: providedContext,
  headRef = "HEAD",
} = {}) {
  const context = analysisContext(repo, providedContext);
  const headSha = resolveCommit(context, headRef, "Head");
  const workspaces = [];
  for (const workspaceRoot of Object.keys(WORKSPACE_ROOTS)) {
    const workspace = loadWorkspace(context, headSha, workspaceRoot);
    for (const packageName of [...workspace.packages.keys()].sort()) {
      const workspacePackage = workspace.packages.get(packageName);
      const releaseTargets = releaseTargetsForPackage(packageName);
      workspaces.push({
        identity: packageName,
        workspaceRoot,
        manifestPath: workspacePackage.manifestPath,
        manifestPrivate: workspacePackage.manifest.private === true,
        category: releaseCategory(workspacePackage, releaseTargets),
        releaseTargets,
      });
    }
  }
  const categoryCounts = Object.fromEntries(
    [
      "release-managed",
      "distribution-surface",
      "publishable-unmanaged",
      "private",
    ].map((category) => [
      category,
      workspaces.filter((entry) => entry.category === category).length,
    ]),
  );
  return { headRef, headSha, categoryCounts, workspaces };
}

export function discoverStandaloneManagedPackages({
  repo = process.cwd(),
  context: providedContext,
  headRef = "HEAD",
} = {}) {
  const context = analysisContext(repo, providedContext);
  const headSha = resolveCommit(context, headRef, "Head");
  const packages = [];

  for (const [releaseTarget, definition] of Object.entries(RELEASE_TARGETS)) {
    for (const packageEntry of definition.packageDirs ?? []) {
      const directory = normalizePath(packageEntry.directory);
      const manifestPath = `${directory}/package.json`;
      const manifest = parseJsonAtRef(
        context,
        headSha,
        manifestPath,
        "Standalone managed package",
      );
      if (manifest.name !== packageEntry.name) {
        throw new ReleaseImpactError(
          "standalone-package-name-mismatch",
          `Standalone package '${manifestPath}' declares '${manifest.name}', expected '${packageEntry.name}'.`,
        );
      }
      packages.push({
        identity: packageEntry.name,
        releaseTarget,
        directory,
        manifestPath,
        category: "release-managed",
      });
    }
  }

  return {
    headRef,
    headSha,
    packages: packages.sort((left, right) =>
      left.identity.localeCompare(right.identity),
    ),
  };
}

const WORKFLOW_INVENTORY_PREFIXES = Object.freeze([
  ".github/workflows/",
  "app/.github/workflows/",
  "app/.github/upstream-workflows-disabled/",
  "server/.github/workflows/",
  "server/.github/upstream-workflows-disabled/",
]);

function workflowFilesAtRef(context, ref) {
  return filesAtRef(context, ref).filter(
    (file) =>
      WORKFLOW_INVENTORY_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
      /\.ya?ml$/i.test(file),
  );
}

function workflowTriggers(content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const onLine = lines.findIndex((line) => /^on\s*:/.test(line));
  if (onLine === -1) {
    return [];
  }
  const inline = lines[onLine].replace(/^on\s*:\s*/, "").trim();
  if (inline) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .sort();
  }
  const triggers = [];
  for (const line of lines.slice(onLine + 1)) {
    if (/^\S/.test(line) && !/^\s*#/.test(line)) {
      break;
    }
    const match = /^ {2}([A-Za-z_][\w-]*)\s*:/.exec(line);
    if (match) {
      triggers.push(match[1]);
    }
  }
  return [...new Set(triggers)].sort();
}

function isReleaseOrExternalMutationWorkflow(file, content) {
  const basename = path.posix.basename(file).toLowerCase();
  if (
    /(?:^srn-|\.release(?:\.|-)|^publish\.|^releases?\.notify\.|^git-sync\.|testflight|deploy)/.test(
      basename,
    )
  ) {
    return true;
  }
  return [
    /\bgh release (?:create|upload)\b/,
    /softprops\/action-gh-release@/,
    /\b(?:npm publish|yarn npm publish|docker push|snapcraft upload)\b/,
    /\baws s3 sync\b/,
    /\bupload_to_(?:testflight|app_store|play_store)\b/,
    /\bbundle exec fastlane (?:android|ios) (?:publish|upload|distribute|submit)_prod\b/,
    /peter-evans\/repository-dispatch@/,
    /peter-evans\/create-pull-request@/,
    /convictional\/trigger-workflow-and-wait@/,
    /(?:^|\s)uses:\s*actions\/deploy-pages@/m,
    /(?:^|\s)uses:\s*wei\/git-sync@/m,
  ].some((pattern) => pattern.test(content));
}

function workflowRepositoryMetadata(workflowPath) {
  if (workflowPath.startsWith(".github/workflows/")) {
    return {
      status: "root-active",
      rootDiscoverable: true,
      embeddedPortable: false,
    };
  }
  if (
    workflowPath.startsWith("app/.github/workflows/") ||
    workflowPath.startsWith("server/.github/workflows/")
  ) {
    return {
      status: "non-root-active",
      rootDiscoverable: false,
      embeddedPortable: true,
    };
  }
  return {
    status: "quarantined",
    rootDiscoverable: false,
    embeddedPortable: false,
  };
}

function cloneWorkflowEntry(entry, declaredTriggers) {
  const repositoryMetadata = workflowRepositoryMetadata(entry.path);
  return {
    ...entry,
    ...repositoryMetadata,
    declaredTriggers: [...declaredTriggers],
    ...(repositoryMetadata.rootDiscoverable
      ? { rootTriggers: [...declaredTriggers] }
      : { portableTriggers: [...declaredTriggers] }),
    targets: [...entry.targets],
    ...(entry.workspacePackages
      ? { workspacePackages: [...entry.workspacePackages] }
      : {}),
  };
}

function assertExpectedWorkflowPath(context, headSha, entry, trackedWorkflows) {
  if (trackedWorkflows.has(entry.path)) {
    return readAtRef(context, headSha, entry.path);
  }
  const basename = path.posix.basename(entry.path);
  const familyPrefix = entry.path.startsWith("app/")
    ? "app/.github/"
    : entry.path.startsWith("server/")
      ? "server/.github/"
      : ".github/";
  const misplaced = [...trackedWorkflows].find(
    (candidate) =>
      candidate.startsWith(familyPrefix) &&
      path.posix.basename(candidate) === basename,
  );
  if (misplaced) {
    throw new ReleaseImpactError(
      "release-workflow-misplaced",
      `Expected release workflow '${entry.path}' is missing at ${headSha}; '${basename}' is active or preserved at '${misplaced}' instead.`,
    );
  }
  const code =
    entry.classification === "quarantined-upstream-mutation"
      ? "missing-quarantined-workflow"
      : "missing-release-workflow";
  throw new ReleaseImpactError(
    code,
    `Expected ${entry.classification} workflow '${entry.path}' is missing at ${headSha}.`,
  );
}

function assertWorkflowActivation(entry, content) {
  const triggers = workflowTriggers(content);
  const expectedTriggers = WORKFLOW_TRIGGER_CONTRACTS[entry.path];
  if (!expectedTriggers) {
    throw new ReleaseImpactError(
      "missing-workflow-trigger-contract",
      `Workflow '${entry.path}' has no trigger contract.`,
    );
  }
  if (
    triggers.length !== expectedTriggers.length ||
    triggers.some((trigger, index) => trigger !== expectedTriggers[index])
  ) {
    throw new ReleaseImpactError(
      "workflow-activation-mismatch",
      `Workflow '${entry.path}' is classified as '${entry.activation}' and must declare exactly [${expectedTriggers.join(", ")}], but declares [${triggers.join(", ")}].`,
    );
  }
  if (
    entry.classification === "canonical-change-gated" &&
    (!/^ {4}branches:\s*\[\s*main\s*\]\s*$/m.test(content) ||
      !/^ {4}paths:\s*$/m.test(content))
  ) {
    throw new ReleaseImpactError(
      "workflow-activation-mismatch",
      `Canonical workflow '${entry.path}' must scope push activation to main and an explicit path inventory.`,
    );
  }
  return triggers;
}

function validateDistributionWorkspaceSurfaces(workspaces, workflows) {
  const workflowsByPath = new Map(
    workflows.map((entry) => [entry.path, entry]),
  );
  const surfaces = [];
  for (const [identity, policy] of Object.entries(
    DISTRIBUTION_WORKSPACE_SURFACES,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    const matches = workspaces.filter((entry) => entry.identity === identity);
    if (matches.length !== 1) {
      throw new ReleaseImpactError(
        "distribution-workspace-missing",
        `Distribution surface '${identity}' must resolve to exactly one Yarn workspace; found ${matches.length}.`,
      );
    }
    const workspace = matches[0];
    if (
      workspace.manifestPrivate !== policy.expectedPrivate ||
      workspace.releaseTargets.length !== 0 ||
      workspace.category !== "distribution-surface"
    ) {
      throw new ReleaseImpactError(
        "distribution-workspace-policy-mismatch",
        `Distribution surface '${identity}' must remain a private, non-package-published workspace owned by quarantined distribution workflows; observed private=${workspace.manifestPrivate}, releaseTargets=${workspace.releaseTargets.join(",") || "none"}, category=${workspace.category}.`,
      );
    }
    for (const workflowPath of policy.workflowPaths) {
      const workflow = workflowsByPath.get(workflowPath);
      if (
        workflow?.classification !== "quarantined-upstream-mutation" ||
        workflow.targetKind !== "application-distribution"
      ) {
        throw new ReleaseImpactError(
          "distribution-workflow-policy-mismatch",
          `Distribution surface '${identity}' expects quarantined application publisher '${workflowPath}'.`,
        );
      }
    }
    surfaces.push({
      identity,
      workspaceRoot: workspace.workspaceRoot,
      manifestPath: workspace.manifestPath,
      manifestPrivate: workspace.manifestPrivate,
      kind: policy.kind,
      packagePublicationPolicy: policy.packagePublicationPolicy,
      distributionStatus: policy.distributionStatus,
      workflowPaths: [...policy.workflowPaths],
      targets: [...policy.targets],
    });
  }
  return surfaces;
}

export function discoverWorkflowOwnership({
  repo = process.cwd(),
  context: providedContext,
  headRef = "HEAD",
} = {}) {
  const context = analysisContext(repo, providedContext);
  const headSha = resolveCommit(context, headRef, "Head");
  const trackedWorkflowPaths = workflowFilesAtRef(context, headSha);
  const trackedWorkflows = new Set(trackedWorkflowPaths);
  const expectedEntries = [
    ...CANONICAL_RELEASE_WORKFLOWS,
    ...STANDALONE_RECOVERY_WORKFLOWS,
    ...SUPPORTING_RELEASE_WORKFLOWS,
    ...QUARANTINED_UPSTREAM_WORKFLOWS,
    ...ACTIVE_NONCANONICAL_EXTERNAL_WORKFLOWS,
    ...ROOT_NONMUTATING_SUPPORT_WORKFLOWS,
    ...APP_EMBEDDED_NONMUTATING_SUPPORT_WORKFLOWS,
    ...SERVER_EMBEDDED_NONMUTATING_SUPPORT_WORKFLOWS,
    ...SERVER_QUARANTINED_UPSTREAM_WORKFLOWS,
  ];
  const expectedPaths = new Set(expectedEntries.map((entry) => entry.path));
  if (expectedPaths.size !== expectedEntries.length) {
    throw new ReleaseImpactError(
      "duplicate-workflow-ownership",
      "The workflow ownership ledger assigns at least one path more than once.",
    );
  }
  const triggerContractPaths = Object.keys(WORKFLOW_TRIGGER_CONTRACTS).sort();
  const sortedExpectedPaths = [...expectedPaths].sort();
  if (
    triggerContractPaths.length !== sortedExpectedPaths.length ||
    triggerContractPaths.some(
      (workflowPath, index) => workflowPath !== sortedExpectedPaths[index],
    )
  ) {
    throw new ReleaseImpactError(
      "workflow-trigger-inventory-mismatch",
      "Every owned workflow must have exactly one trigger contract and no stale trigger contracts may remain.",
    );
  }

  const declaredTriggersByPath = new Map();
  for (const entry of expectedEntries) {
    const content = assertExpectedWorkflowPath(
      context,
      headSha,
      entry,
      trackedWorkflows,
    );
    declaredTriggersByPath.set(
      entry.path,
      assertWorkflowActivation(entry, content),
    );
    if (entry.classification === "canonical-change-gated") {
      const definition = RELEASE_TARGETS[entry.owner];
      if (!definition?.configPaths.includes(entry.path)) {
        throw new ReleaseImpactError(
          "canonical-workflow-owner-mismatch",
          `Canonical workflow '${entry.path}' is not owned by release target '${entry.owner}'.`,
        );
      }
    }
  }

  const quarantineContracts = [
    {
      scope: "app",
      prefix: "app/.github/upstream-workflows-disabled/",
      entries: QUARANTINED_UPSTREAM_WORKFLOWS,
      exactCount: 6,
    },
    {
      scope: "server",
      prefix: "server/.github/upstream-workflows-disabled/",
      entries: SERVER_QUARANTINED_UPSTREAM_WORKFLOWS,
      exactCount: 13,
    },
  ];
  for (const contract of quarantineContracts) {
    const expectedQuarantinedPaths = new Set(
      contract.entries.map((entry) => entry.path),
    );
    const actualQuarantinedPaths = trackedWorkflowPaths.filter((file) =>
      file.startsWith(contract.prefix),
    );
    if (
      expectedQuarantinedPaths.size !== contract.exactCount ||
      actualQuarantinedPaths.length !== contract.exactCount ||
      actualQuarantinedPaths.some((file) => !expectedQuarantinedPaths.has(file))
    ) {
      throw new ReleaseImpactError(
        "quarantined-workflow-inventory-mismatch",
        `The ${contract.scope} disabled upstream workflow directory must contain exactly ${contract.exactCount} registered workflows: ${[...expectedQuarantinedPaths].sort().join(", ")}. Observed: ${actualQuarantinedPaths.join(", ") || "none"}.`,
      );
    }
    for (const quarantinedPath of expectedQuarantinedPaths) {
      const basename = path.posix.basename(quarantinedPath);
      const reactivated = trackedWorkflowPaths.find(
        (candidate) =>
          /\.github\/workflows\//.test(candidate) &&
          path.posix.basename(candidate) === basename,
      );
      if (reactivated) {
        throw new ReleaseImpactError(
          "quarantined-workflow-reactivated",
          `Quarantined upstream workflow '${quarantinedPath}' is also active or portable at '${reactivated}'.`,
        );
      }
    }
  }

  for (const workflowPath of trackedWorkflowPaths) {
    if (expectedPaths.has(workflowPath)) {
      continue;
    }
    const content = readAtRef(context, headSha, workflowPath) ?? "";
    if (isReleaseOrExternalMutationWorkflow(workflowPath, content)) {
      throw new ReleaseImpactError(
        "unclassified-external-mutation-workflow",
        `Production or external-mutation workflow '${workflowPath}' is not classified in the workflow ownership ledger.`,
      );
    }
    throw new ReleaseImpactError(
      "unclassified-workflow",
      `Workflow '${workflowPath}' is not classified in the workflow ownership ledger.`,
    );
  }

  const workflows = expectedEntries
    .map((entry) =>
      cloneWorkflowEntry(entry, declaredTriggersByPath.get(entry.path)),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  const classificationCounts = Object.fromEntries(
    [
      "canonical-change-gated",
      "noncanonical-manual-recovery",
      "canonical-support",
      "quarantined-upstream-mutation",
      "noncanonical-external-mutation",
      "root-nonmutating-support",
      "embedded-nonmutating-support",
    ].map((classification) => [
      classification,
      workflows.filter((entry) => entry.classification === classification)
        .length,
    ]),
  );
  const scopeCounts = {
    rootDiscoverable: workflows.filter((entry) => entry.rootDiscoverable)
      .length,
    embeddedPortable: workflows.filter((entry) => entry.embeddedPortable)
      .length,
    quarantined: workflows.filter((entry) => entry.status === "quarantined")
      .length,
  };
  const quarantineCounts = {
    app: QUARANTINED_UPSTREAM_WORKFLOWS.length,
    server: SERVER_QUARANTINED_UPSTREAM_WORKFLOWS.length,
    total:
      QUARANTINED_UPSTREAM_WORKFLOWS.length +
      SERVER_QUARANTINED_UPSTREAM_WORKFLOWS.length,
  };
  const embeddedSupportCounts = {
    app: APP_EMBEDDED_NONMUTATING_SUPPORT_WORKFLOWS.length,
    server: SERVER_EMBEDDED_NONMUTATING_SUPPORT_WORKFLOWS.length,
    total:
      APP_EMBEDDED_NONMUTATING_SUPPORT_WORKFLOWS.length +
      SERVER_EMBEDDED_NONMUTATING_SUPPORT_WORKFLOWS.length,
  };

  return {
    schemaVersion: 2,
    headRef,
    headSha,
    classificationCounts,
    scopeCounts,
    quarantineCounts,
    embeddedSupportCounts,
    workflows,
  };
}

export function analyzeRepositoryReleaseImpact({
  repo = process.cwd(),
  context: providedContext,
  headRef = "HEAD",
  force = false,
  forceReason = "",
} = {}) {
  validateForce(force, forceReason);
  const context = analysisContext(repo, providedContext);
  ensureCompleteHistory(context);
  const headSha = resolveCommit(context, headRef, "Head");
  const products = Object.keys(RELEASE_TARGETS)
    .sort()
    .map((target) =>
      analyzeProductImpact({
        repo,
        context,
        target,
        headRef,
        force,
        forceReason,
      }),
    );
  const productsByTarget = new Map(
    products.map((product) => [product.identity, product]),
  );
  const inventory = discoverWorkspaceInventory({
    repo,
    context,
    headRef,
  });
  const standaloneInventory = discoverStandaloneManagedPackages({
    repo,
    context,
    headRef,
  });
  const workflowOwnership = discoverWorkflowOwnership({
    repo,
    context,
    headRef,
  });
  const distributionSurfaces = validateDistributionWorkspaceSurfaces(
    inventory.workspaces,
    workflowOwnership.workflows,
  );
  const distributionSurfacesByIdentity = new Map(
    distributionSurfaces.map((surface) => [surface.identity, surface]),
  );
  const workspaces = inventory.workspaces.map((workspaceEntry) => {
    const { identity: packageName, releaseTargets } = workspaceEntry;
    if (releaseTargets.length > 1) {
      throw new ReleaseImpactError(
        "ambiguous-release-management",
        `Workspace package '${packageName}' is directly managed by multiple release targets: ${releaseTargets.join(", ")}.`,
      );
    }
    const managedProduct =
      releaseTargets.length === 1
        ? productsByTarget.get(releaseTargets[0])
        : undefined;
    const distributionSurface = distributionSurfacesByIdentity.get(packageName);
    const analysis = managedProduct
      ? {
          ...managedProduct,
          analysisStatus: "release-managed",
          publicationPolicy: "managed",
          releaseSurfaceKind: "managed-product",
        }
      : distributionSurface
        ? {
            schemaVersion: 1,
            mode: "distribution-inventory",
            identity: packageName,
            changed: null,
            analysisStatus: "distribution-surface",
            publicationPolicy: "upstream-distribution-publisher-quarantined",
            releaseSurfaceKind: distributionSurface.kind,
            packagePublicationPolicy:
              distributionSurface.packagePublicationPolicy,
            distributionStatus: distributionSurface.distributionStatus,
            distributionWorkflowPaths: distributionSurface.workflowPaths,
            distributionTargets: distributionSurface.targets,
            tagPrefix: null,
            latestReleaseRef: null,
            baseRef: null,
            divergentReleaseRefs: [],
            reasons: [
              {
                code: "shipped-distribution-upstream-publisher-quarantined",
                message:
                  "This private workspace is a shipped application surface, not a releasable package policy. Its preserved upstream publisher is quarantined.",
              },
            ],
          }
        : {
            schemaVersion: 1,
            mode: "inventory-only",
            identity: packageName,
            changed: null,
            analysisStatus: "inventory-only",
            publicationPolicy:
              workspaceEntry.category === "private"
                ? "disabled-private"
                : "unmanaged",
            releaseSurfaceKind: "package-inventory",
            tagPrefix: null,
            latestReleaseRef: null,
            baseRef: null,
            divergentReleaseRefs: [],
            reasons: [
              {
                code: "not-release-managed",
                message:
                  workspaceEntry.category === "private"
                    ? "The package is private and has no repository release publisher."
                    : "The package manifest permits publication, but this repository has no publisher for it.",
              },
            ],
          };
    return {
      ...analysis,
      ...workspaceEntry,
      productIdentity: managedProduct ? releaseTargets[0] : null,
    };
  });
  const standaloneManagedPackages = standaloneInventory.packages.map(
    (packageEntry) => ({
      ...productsByTarget.get(packageEntry.releaseTarget),
      ...packageEntry,
      productIdentity: packageEntry.releaseTarget,
    }),
  );

  return {
    schemaVersion: 3,
    mode: "repository",
    headRef,
    headSha,
    changed: products.some((entry) => entry.changed),
    workspaceSignalsChanged: workspaces.some(
      (entry) =>
        entry.analysisStatus === "release-managed" && entry.changed === true,
    ),
    categoryCounts: inventory.categoryCounts,
    workspaceCategoryCounts: inventory.categoryCounts,
    inventoryCounts: {
      managedProducts: products.length,
      yarnWorkspaces: workspaces.length,
      standaloneManagedPackages: standaloneManagedPackages.length,
      workflowOwners: workflowOwnership.workflows.length,
      distributionSurfaces: distributionSurfaces.length,
    },
    changedProducts: products
      .filter((entry) => entry.changed)
      .map((entry) => entry.identity),
    changedWorkspaces: workspaces
      .filter(
        (entry) =>
          entry.analysisStatus === "release-managed" && entry.changed === true,
      )
      .map((entry) => entry.identity),
    products,
    standaloneManagedPackages,
    workflowOwnership,
    distributionSurfaces,
    workspaces,
  };
}

function markdownCell(value) {
  if (value === null || value === undefined || value === "") {
    return "none";
  }
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  return text.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function reasonSummary(entry) {
  return entry.reasons.map(({ code }) => code).join(", ") || "unchanged";
}

export function renderReleaseImpactReport(result) {
  if (result.mode !== "repository") {
    throw new ReleaseImpactError(
      "invalid-report-mode",
      "The readable release report requires --all-workspaces all.",
    );
  }

  const lines = [
    "# Repository Release Impact",
    "",
    `Head: \`${result.headSha}\``,
    "",
    "This report is an inventory and impact audit. `publishable-unmanaged` means a package manifest is not private; it does not assert that this repository publishes that package to npm or any other registry.",
    "",
    "## Managed release products",
    "",
    "| Product | Tag prefix | Latest tag by profile policy | Selected baseline | Source impact | Publication gate | Reasons | Divergent off-history tags |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const entry of result.products) {
    lines.push(
      `| ${markdownCell(entry.identity)} | ${markdownCell(entry.tagPrefix)} | ${markdownCell(entry.latestReleaseRef)} | ${markdownCell(entry.baseRef)} | ${entry.changed ? "yes" : "no"} | ${markdownCell(entry.publicationGate)} | ${markdownCell(reasonSummary(entry))} | ${markdownCell(entry.divergentReleaseRefs)} |`,
    );
  }

  lines.push(
    "",
    "## Workflow and distribution ownership",
    "",
    "Only workflows under the repository-root `.github/workflows/` directory are `rootDiscoverable` and active in this monorepo. Definitions under `app/.github/workflows/` and `server/.github/workflows/` are `embeddedPortable`: they are non-root-active here, while `portableTriggers` records what would activate them if that subtree became a repository. Mutation-capable upstream definitions remain quarantined outside every workflow directory.",
    "",
    `Workflow counts: ${Object.entries(
      result.workflowOwnership.classificationCounts,
    )
      .map(([classification, count]) => `${classification}=${count}`)
      .join(", ")}.`,
    "",
    `Scope counts: rootDiscoverable=${result.workflowOwnership.scopeCounts.rootDiscoverable}, embeddedPortable=${result.workflowOwnership.scopeCounts.embeddedPortable}, quarantined=${result.workflowOwnership.scopeCounts.quarantined}. Quarantine counts: app=${result.workflowOwnership.quarantineCounts.app}, server=${result.workflowOwnership.quarantineCounts.server}. Embedded nonmutating support: app=${result.workflowOwnership.embeddedSupportCounts.app}, server=${result.workflowOwnership.embeddedSupportCounts.server}.`,
    "",
    "| Workflow | Repository scope | Status | Classification | Owner | Declared or portable triggers | Target kind | Targets | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );

  for (const entry of result.workflowOwnership.workflows) {
    const repositoryScope = entry.rootDiscoverable
      ? "rootDiscoverable"
      : entry.embeddedPortable
        ? "embeddedPortable"
        : "quarantined";
    lines.push(
      `| ${markdownCell(entry.path)} | ${repositoryScope} | ${markdownCell(entry.status)} | ${markdownCell(entry.classification)} | ${markdownCell(entry.owner)} | ${markdownCell(entry.rootTriggers ?? entry.portableTriggers)} | ${markdownCell(entry.targetKind)} | ${markdownCell(entry.targets)} | ${markdownCell(entry.reason)} |`,
    );
  }

  lines.push(
    "",
    "### Shipped workspace distribution surfaces",
    "",
    "The `distribution-surface` category records private workspaces that ship as applications. A manifest's `private` flag prevents package-registry publication; it does not disable the application or turn it into a private-package release policy. Their upstream standalone publishers remain quarantined.",
    "",
    "| Workspace | Root | Manifest | Manifest private | Surface kind | Package publication policy | Distribution status | Workflows | Targets |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );

  for (const entry of result.distributionSurfaces) {
    lines.push(
      `| ${markdownCell(entry.identity)} | ${markdownCell(entry.workspaceRoot)} | ${markdownCell(entry.manifestPath)} | ${entry.manifestPrivate ? "yes" : "no"} | ${markdownCell(entry.kind)} | ${markdownCell(entry.packagePublicationPolicy)} | ${markdownCell(entry.distributionStatus)} | ${markdownCell(entry.workflowPaths)} | ${markdownCell(entry.targets)} |`,
    );
  }

  lines.push(
    "",
    "## Standalone managed packages",
    "",
    "These package manifests live outside the three Yarn workspace roots. Their products are already included in the managed-product table above.",
    "",
    "| Package | Product | Manifest | Selected baseline | Source impact | Publication gate | Reasons |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );

  for (const entry of result.standaloneManagedPackages) {
    lines.push(
      `| ${markdownCell(entry.identity)} | ${markdownCell(entry.releaseTarget)} | ${markdownCell(entry.manifestPath)} | ${markdownCell(entry.baseRef)} | ${entry.changed ? "yes" : "no"} | ${markdownCell(entry.publicationGate)} | ${markdownCell(reasonSummary(entry))} |`,
    );
  }

  lines.push(
    "",
    "## Yarn workspace inventory",
    "",
    `This table contains ${result.inventoryCounts.yarnWorkspaces} Yarn workspace manifests and excludes the ${result.inventoryCounts.standaloneManagedPackages} standalone managed CLI manifests listed above.`,
    "",
    `Workspace counts: ${Object.entries(result.workspaceCategoryCounts)
      .map(([category, count]) => `${category}=${count}`)
      .join(", ")}.`,
    "",
    "Only `release-managed` rows receive a release decision. `distribution-surface` rows describe shipped applications and quarantined upstream publishers without inventing a package release. Unmanaged and private rows remain inventory-only and never infer a tag or publisher.",
    "",
    "| Root | Package | Category | Publication policy | Managed by | Tag prefix | Latest tag by profile policy | Selected baseline | Managed source impact | Publication gate | Reasons | Divergent off-history tags |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );

  for (const entry of result.workspaces) {
    const managedSourceImpact =
      entry.analysisStatus === "release-managed"
        ? entry.changed
          ? "yes"
          : "no"
        : "not evaluated";
    lines.push(
      `| ${markdownCell(entry.workspaceRoot)} | ${markdownCell(entry.identity)} | ${markdownCell(entry.category)} | ${markdownCell(entry.publicationPolicy)} | ${markdownCell(entry.releaseTargets)} | ${markdownCell(entry.tagPrefix)} | ${markdownCell(entry.latestReleaseRef)} | ${markdownCell(entry.baseRef)} | ${managedSourceImpact} | ${markdownCell(entry.publicationGate ?? "not-managed")} | ${markdownCell(reasonSummary(entry))} | ${markdownCell(entry.divergentReleaseRefs)} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function parseBoolean(value, flag) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new ReleaseImpactError(
    "invalid-argument",
    `${flag} must be 'true' or 'false'.`,
  );
}

function parseArguments(argv) {
  const supportedArguments = new Set([
    "--all-workspaces",
    "--base-ref",
    "--exclude-release-ref",
    "--force",
    "--force-reason",
    "--github-output",
    "--head",
    "--output",
    "--package",
    "--report",
    "--repo",
    "--target",
    "--workspace-root",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new ReleaseImpactError(
        "invalid-argument",
        `Unexpected positional argument '${argument}'.`,
      );
    }
    if (!supportedArguments.has(argument)) {
      throw new ReleaseImpactError(
        "invalid-argument",
        `Unknown argument '${argument}'.\n${usage()}`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ReleaseImpactError(
        "invalid-argument",
        `Missing value for '${argument}'.`,
      );
    }
    if (values.has(argument)) {
      throw new ReleaseImpactError(
        "invalid-argument",
        `Argument '${argument}' was supplied more than once.`,
      );
    }
    values.set(argument, value);
    index += 1;
  }
  return values;
}

function appendGithubOutputs(file, result) {
  const reasons = result.mode === "single" ? result.reasons : [];
  const changedFiles = result.mode === "single" ? result.matchedFiles : [];
  const aggregateEntries =
    result.mode === "all-workspaces"
      ? result.packages
      : result.mode === "repository"
        ? [...result.products, ...result.workspaces]
        : [];
  const githubSummary =
    result.mode === "single"
      ? {
          schemaVersion: result.schemaVersion,
          mode: result.mode,
          identity: result.identity,
          changed: result.changed,
          forced: result.forced,
          forceReason: result.forceReason,
          firstRelease: result.firstRelease,
          noAncestorBaseline: result.noAncestorBaseline,
          baselineStatus: result.baselineStatus,
          publicationGate: result.publicationGate,
          baseRef: result.baseRef,
          baseSha: result.baseSha,
          excludedReleaseRef: result.excludedReleaseRef,
          headSha: result.headSha,
          matchedFiles: result.matchedFiles,
          reasons: result.reasons,
        }
      : result.mode === "all-workspaces"
        ? {
            schemaVersion: result.schemaVersion,
            mode: result.mode,
            workspaceRoot: result.workspaceRoot,
            changed: result.changed,
            changedPackages: result.changedPackages,
            headSha: result.headSha,
          }
        : {
            schemaVersion: result.schemaVersion,
            mode: result.mode,
            changed: result.changed,
            categoryCounts: result.categoryCounts,
            changedProducts: result.changedProducts,
            changedWorkspaces: result.changedWorkspaces,
            headSha: result.headSha,
          };
  const outputs = {
    changed: String(result.changed),
    forced: String(
      result.mode === "single"
        ? result.forced
        : aggregateEntries.some((entry) => entry.forced),
    ),
    base_ref: result.mode === "single" && result.baseRef ? result.baseRef : "",
    base_sha: result.mode === "single" && result.baseSha ? result.baseSha : "",
    baseline_status:
      result.mode === "single" ? result.baselineStatus : "aggregate",
    publication_gate:
      result.mode === "single" ? result.publicationGate : "aggregate",
    head_sha: result.headSha,
    reason_codes: JSON.stringify(reasons.map(({ code }) => code)),
    changed_files: JSON.stringify(changedFiles),
    result_json: JSON.stringify(githubSummary),
  };
  appendFileSync(
    file,
    `${Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

function usage() {
  return [
    "Usage:",
    "  node scripts/analyze-release-impact.mjs --target <srn-*> [options]",
    "  node scripts/analyze-release-impact.mjs --package <name> [--workspace-root root|app|server] [options]",
    "  node scripts/analyze-release-impact.mjs --all-workspaces <root|app|server|all> [options]",
    "",
    "Options: --repo <path> --head <ref> --base-ref <tag> --exclude-release-ref <tag>",
    "         --force <true|false>",
    "         --force-reason <text> --output <json-file> --report <markdown-file>",
    "         --github-output <file>",
  ].join("\n");
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const repo = path.resolve(args.get("--repo") ?? process.cwd());
  const headRef = args.get("--head") ?? "HEAD";
  const baseRef = args.get("--base-ref");
  const excludeReleaseRef = args.get("--exclude-release-ref");
  const force = parseBoolean(args.get("--force") ?? "false", "--force");
  const forceReason = args.get("--force-reason") ?? "";

  const modes = [
    args.has("--target"),
    args.has("--package"),
    args.has("--all-workspaces"),
  ].filter(Boolean).length;
  if (modes !== 1) {
    throw new ReleaseImpactError(
      "invalid-argument",
      `Choose exactly one analysis mode.\n${usage()}`,
    );
  }
  if (!args.has("--package") && args.has("--workspace-root")) {
    throw new ReleaseImpactError(
      "invalid-argument",
      "--workspace-root is supported only with --package; --all-workspaces takes its workspace root as the mode value.",
    );
  }
  if (args.has("--report") && args.get("--all-workspaces") !== "all") {
    throw new ReleaseImpactError(
      "invalid-argument",
      "--report requires --all-workspaces all.",
    );
  }
  if (excludeReleaseRef && args.has("--all-workspaces")) {
    throw new ReleaseImpactError(
      "invalid-argument",
      "--exclude-release-ref is supported only with --target or --package.",
    );
  }

  let result;
  if (args.has("--target")) {
    result = analyzeProductImpact({
      repo,
      target: args.get("--target"),
      headRef,
      baseRef,
      excludeReleaseRef,
      force,
      forceReason,
    });
  } else if (args.has("--package")) {
    result = analyzeWorkspacePackageImpact({
      repo,
      packageName: args.get("--package"),
      workspaceRoot: args.get("--workspace-root"),
      headRef,
      baseRef,
      excludeReleaseRef,
      force,
      forceReason,
    });
  } else {
    if (baseRef) {
      throw new ReleaseImpactError(
        "invalid-argument",
        "--base-ref is not supported with --all-workspaces because every package has its own tag.",
      );
    }
    result =
      args.get("--all-workspaces") === "all"
        ? analyzeRepositoryReleaseImpact({
            repo,
            headRef,
            force,
            forceReason,
          })
        : analyzeAllWorkspacePackages({
            repo,
            workspaceRoot: args.get("--all-workspaces"),
            headRef,
            force,
            forceReason,
          });
  }

  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (args.has("--output")) {
    writeFileSync(path.resolve(repo, args.get("--output")), serialized);
  }
  if (args.has("--report")) {
    writeFileSync(
      path.resolve(repo, args.get("--report")),
      renderReleaseImpactReport(result),
    );
  }
  if (args.has("--github-output")) {
    appendGithubOutputs(args.get("--github-output"), result);
  }
  process.stdout.write(serialized);
  return result;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    runCli();
  } catch (error) {
    const code =
      error instanceof ReleaseImpactError ? error.code : "unexpected-error";
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        changed: null,
        error: {
          code,
          message: error instanceof Error ? error.message : String(error),
        },
      })}\n`,
    );
    process.exitCode = 1;
  }
}

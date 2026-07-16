export const TOOL_NAME = "srn-openclaw";
export const PACKAGE_NAME = "@standard-red-notes/openclaw";
export const PACKAGE_MANAGER = "yarn@4.17.1";
export const NODE_RANGE = ">=26.0.0";
export const SOURCE_REPOSITORY =
  "https://github.com/supermarsx/standard-red-notes";

export const SMOKE_TARGETS = Object.freeze([
  Object.freeze({
    id: "windows-x64",
    runner: "windows-2025",
    platform: "win32",
    architecture: "x64",
  }),
  Object.freeze({
    id: "windows-arm64",
    runner: "windows-11-arm",
    platform: "win32",
    architecture: "arm64",
  }),
  Object.freeze({
    id: "linux-x64",
    runner: "ubuntu-24.04",
    platform: "linux",
    architecture: "x64",
  }),
  Object.freeze({
    id: "linux-arm64",
    runner: "ubuntu-24.04-arm",
    platform: "linux",
    architecture: "arm64",
  }),
  Object.freeze({
    id: "macos-x64",
    runner: "macos-15-intel",
    platform: "darwin",
    architecture: "x64",
  }),
  Object.freeze({
    id: "macos-arm64",
    runner: "macos-15",
    platform: "darwin",
    architecture: "arm64",
  }),
]);

const RELEASE_TAG_PATTERN =
  /^srn-openclaw-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function versionFromReleaseTag(tag) {
  if (!RELEASE_TAG_PATTERN.test(tag)) {
    throw new Error(
      `release tag must be ${TOOL_NAME}-v<semver> without build metadata; received ${JSON.stringify(tag)}`,
    );
  }

  return tag.slice(`${TOOL_NAME}-v`.length);
}

export function packageArtifactName(version) {
  return `${TOOL_NAME}-${version}-node-any.tgz`;
}

export function releaseManifestName(version) {
  return `${TOOL_NAME}-${version}-node-any.manifest.json`;
}

export function provenanceBundleName(version) {
  return `${TOOL_NAME}-${version}-node-any.provenance.sigstore.json`;
}

export function targetById(targetId) {
  const target = SMOKE_TARGETS.find(({ id }) => id === targetId);
  if (!target) {
    throw new Error(`unknown OpenClaw smoke target: ${targetId}`);
  }

  return target;
}

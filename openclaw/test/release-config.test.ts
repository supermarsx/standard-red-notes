import { describe, it, expect } from "vitest";
import {
  NODE_RANGE,
  PACKAGE_MANAGER,
  PACKAGE_NAME,
  SMOKE_TARGETS,
  TOOL_NAME,
  packageArtifactName,
  provenanceBundleName,
  releaseManifestName,
  targetById,
  versionFromReleaseTag,
} from "../scripts/release-config.mjs";

describe("versionFromReleaseTag", () => {
  it("strips the tool prefix from a well-formed tag", () => {
    expect(versionFromReleaseTag("srn-openclaw-v0.1.0")).toBe("0.1.0");
    expect(versionFromReleaseTag("srn-openclaw-v12.34.56")).toBe("12.34.56");
  });

  it("accepts dotted and dashed prerelease identifiers", () => {
    expect(versionFromReleaseTag("srn-openclaw-v1.2.3-rc.1")).toBe(
      "1.2.3-rc.1",
    );
    expect(versionFromReleaseTag("srn-openclaw-v1.2.3-beta-2")).toBe(
      "1.2.3-beta-2",
    );
  });

  it("accepts and preserves SemVer build metadata", () => {
    expect(versionFromReleaseTag("srn-openclaw-v1.2.3+build.5")).toBe(
      "1.2.3+build.5",
    );
    expect(versionFromReleaseTag("srn-openclaw-v1.2.3-rc.1+linux.arm64")).toBe(
      "1.2.3-rc.1+linux.arm64",
    );
  });

  it("rejects leading zeros in any semver segment", () => {
    for (const tag of [
      "srn-openclaw-v01.2.3",
      "srn-openclaw-v1.02.3",
      "srn-openclaw-v1.2.03",
    ]) {
      expect(() => versionFromReleaseTag(tag)).toThrow(/release tag must be/);
    }
  });

  it("rejects tags for another tool or with a missing prefix", () => {
    for (const tag of [
      "v1.2.3",
      "1.2.3",
      "srn-openclaw-1.2.3",
      "srn-desktop-v1.2.3",
      "srn-openclaw-v1.2",
      "srn-openclaw-v1.2.3.4",
      "srn-openclaw-v1.2.3+",
      "srn-openclaw-v1.2.3+build..5",
      "srn-openclaw-v1.2.3+build_5",
      "srn-openclaw-v1.2.3-01",
      "",
    ]) {
      expect(() => versionFromReleaseTag(tag)).toThrow(/release tag must be/);
    }
  });

  it("quotes the offending tag in the error so CI logs are actionable", () => {
    expect(() => versionFromReleaseTag("nope")).toThrow(/"nope"/);
  });
});

describe("release artifact names", () => {
  it("derives every filename from the same tool name and version", () => {
    const version = versionFromReleaseTag("srn-openclaw-v2.0.0");
    expect(packageArtifactName(version)).toBe(
      "srn-openclaw-2.0.0-node-any.tgz",
    );
    expect(releaseManifestName(version)).toBe(
      "srn-openclaw-2.0.0-node-any.manifest.json",
    );
    expect(provenanceBundleName(version)).toBe(
      "srn-openclaw-2.0.0-node-any.provenance.sigstore.json",
    );
  });

  it("keeps the three names distinct and prefixed by the tool name", () => {
    const names = [
      packageArtifactName("1.0.0"),
      releaseManifestName("1.0.0"),
      provenanceBundleName("1.0.0"),
    ];
    expect(new Set(names).size).toBe(3);
    for (const name of names)
      expect(name.startsWith(`${TOOL_NAME}-`)).toBe(true);
  });
});

describe("release constants", () => {
  it("pins the published package identity", () => {
    expect(PACKAGE_NAME).toBe("@standard-red-notes/openclaw");
    expect(TOOL_NAME).toBe("srn-openclaw");
    expect(NODE_RANGE).toBe(">=26.0.0");
    expect(PACKAGE_MANAGER).toMatch(/^yarn@\d+\.\d+\.\d+$/);
  });

  it("covers all six platform/arch smoke combinations exactly once", () => {
    expect(SMOKE_TARGETS).toHaveLength(6);
    const combos = SMOKE_TARGETS.map((t) => `${t.platform}/${t.architecture}`);
    expect(new Set(combos).size).toBe(6);
    expect(combos.sort()).toEqual(
      [
        "darwin/arm64",
        "darwin/x64",
        "linux/arm64",
        "linux/x64",
        "win32/arm64",
        "win32/x64",
      ].sort(),
    );
    const osLabel: Record<string, string> = {
      win32: "windows",
      linux: "linux",
      darwin: "macos",
    };
    for (const target of SMOKE_TARGETS) {
      expect(target.runner).toBeTruthy();
      expect(target.id).toBe(
        `${osLabel[target.platform]}-${target.architecture}`,
      );
    }
  });

  it("is frozen so a consumer cannot mutate the release matrix", () => {
    expect(Object.isFrozen(SMOKE_TARGETS)).toBe(true);
    expect(Object.isFrozen(SMOKE_TARGETS[0])).toBe(true);
  });
});

describe("targetById", () => {
  it("returns the matching target object", () => {
    expect(targetById("linux-x64")).toMatchObject({
      id: "linux-x64",
      platform: "linux",
      architecture: "x64",
      runner: "ubuntu-24.04",
    });
  });

  it("resolves every declared id", () => {
    for (const target of SMOKE_TARGETS) {
      expect(targetById(target.id)).toBe(target);
    }
  });

  it("throws with the unknown id echoed back", () => {
    expect(() => targetById("linux-riscv")).toThrow(
      /unknown OpenClaw smoke target: linux-riscv/,
    );
    expect(() => targetById(undefined)).toThrow(
      /unknown OpenClaw smoke target/,
    );
  });
});

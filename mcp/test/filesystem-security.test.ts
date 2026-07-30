import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  resolveAllowedInputFile,
  resolveAllowedOutputFile,
  rootsFromEnvironment,
  writePrivateOutputFile,
} from "../src/security/filesystem.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srn-mcp-fs-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("MCP filesystem allowlists", () => {
  test("fails closed when no root is configured", async () => {
    await expect(resolveAllowedInputFile("C:\\secret.txt", [])).rejects.toThrow(
      "filesystem access is disabled",
    );
  });

  test("allows a regular input file within a canonical root", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "attachment.txt");
    await fs.writeFile(file, "safe");
    await expect(resolveAllowedInputFile(file, [root])).resolves.toEqual({
      path: await fs.realpath(file),
      size: 4,
    });
  });

  test("rejects a sibling-prefix traversal", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "allowed");
    const sibling = path.join(parent, "allowed-escape");
    await fs.mkdir(root);
    await fs.mkdir(sibling);
    const file = path.join(sibling, "secret.txt");
    await fs.writeFile(file, "secret");
    await expect(resolveAllowedInputFile(file, [root])).rejects.toThrow(
      "outside the configured allowlist",
    );
  });

  test("canonicalizes the output parent and preserves the requested basename", async () => {
    const root = await temporaryDirectory();
    const output = path.join(root, "backup.json");
    await expect(resolveAllowedOutputFile(output, [root])).resolves.toBe(
      output,
    );
  });

  test("never follows an existing output symlink or junction on overwrite", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "allowed");
    await fs.mkdir(root);

    const external =
      process.platform === "win32"
        ? path.join(parent, "outside-directory")
        : path.join(parent, "outside.json");
    if (process.platform === "win32") {
      await fs.mkdir(external);
      await fs.writeFile(path.join(external, "marker"), "untouched");
    } else {
      await fs.writeFile(external, "untouched");
    }
    const target = path.join(root, "backup.json");
    await fs.symlink(
      external,
      target,
      process.platform === "win32" ? "junction" : "file",
    );

    await expect(
      writePrivateOutputFile(target, "should-not-escape", true),
    ).rejects.toThrow("refusing to overwrite");
    if (process.platform === "win32") {
      expect(
        await fs.readFile(path.join(external, "marker"), "utf8"),
      ).toBe("untouched");
    } else {
      expect(await fs.readFile(external, "utf8")).toBe("untouched");
    }
    expect(
      (await fs.readdir(root)).filter((name) =>
        name.startsWith(".srn-export-"),
      ),
    ).toEqual([]);
  });

  test("publishes a new private output without overwriting an existing leaf", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "backup.json");
    await writePrivateOutputFile(target, "first", false);
    await expect(
      writePrivateOutputFile(target, "second", false),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(target, "utf8")).toBe("first");
  });

  test("splits configured roots using the platform path delimiter", () => {
    expect(
      rootsFromEnvironment(["one", "two"].join(path.delimiter)),
    ).toEqual(["one", "two"]);
  });
});

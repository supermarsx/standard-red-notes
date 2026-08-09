#!/usr/bin/env node

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MERMAID_VERSION = "11.16.0";
export const MERMAID_INCLUDE = "{% include mermaid.html %}";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");

export function extractMermaidFences(markdown, file = "<markdown>") {
  const lines = markdown.split(/\r?\n/);
  const diagrams = [];

  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index].match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (!opening) {
      continue;
    }

    const marker = opening[1][0];
    const minimumLength = opening[1].length;
    const startLine = index + 1;
    const isMermaid = opening[2].trim().toLowerCase() === "mermaid";
    const source = [];
    let closed = false;

    for (index += 1; index < lines.length; index += 1) {
      const closing = lines[index].match(/^\s*(`+|~+)\s*$/);
      if (
        closing &&
        closing[1][0] === marker &&
        closing[1].length >= minimumLength
      ) {
        closed = true;
        break;
      }
      if (isMermaid) {
        source.push(lines[index]);
      }
    }

    if (!closed) {
      if (isMermaid) {
        throw new Error(`${file}:${startLine}: unterminated Mermaid fence`);
      }
      continue;
    }
    if (isMermaid && source.every((line) => line.trim() === "")) {
      throw new Error(`${file}:${startLine}: empty Mermaid fence`);
    }
    if (isMermaid) {
      diagrams.push({
        file,
        line: startLine,
        source: source.join("\n"),
      });
    }
  }

  return diagrams;
}

export function listMarkdownFiles(root = repositoryRoot) {
  const result = spawnSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "*.md",
      "*.markdown",
    ],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed: ${result.stderr || `exit code ${result.status}`}`,
    );
  }

  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => existsSync(path.join(root, file)))
    .sort();
}

export async function collectMermaidDocuments(
  root = repositoryRoot,
  files = listMarkdownFiles(root),
) {
  const documents = [];

  for (const file of files) {
    const markdown = await readFile(path.join(root, file), "utf8");
    const diagrams = extractMermaidFences(markdown, file);
    if (diagrams.length === 0) {
      continue;
    }

    if (file.startsWith("docs/") && !markdown.includes(MERMAID_INCLUDE)) {
      throw new Error(`${file}: Mermaid fences require ${MERMAID_INCLUDE}`);
    }

    documents.push(...diagrams);
  }

  return documents;
}

export async function assertMermaidRuntimeContract(root = repositoryRoot) {
  const include = await readFile(
    path.join(root, "docs/_includes/mermaid.html"),
    "utf8",
  );
  const runtime = await readFile(
    path.join(root, "docs/assets/mermaid-init.js"),
    "utf8",
  );
  const stylesheetPath = path.join(root, "docs/assets/mermaid.css");

  if (!include.includes("/assets/mermaid-init.js")) {
    throw new Error(
      "docs/_includes/mermaid.html must load /assets/mermaid-init.js",
    );
  }
  if (!runtime.includes(`mermaid@${MERMAID_VERSION}/`)) {
    throw new Error(
      `docs/assets/mermaid-init.js must pin Mermaid ${MERMAID_VERSION}`,
    );
  }
  if (!/securityLevel\s*:\s*['"]strict['"]/.test(runtime)) {
    throw new Error(
      "docs/assets/mermaid-init.js must use Mermaid securityLevel 'strict'",
    );
  }
  await stat(stylesheetPath);
}

function npxInvocation() {
  if (process.platform !== "win32") {
    return { command: "npx", prefixArguments: [] };
  }

  const result = spawnSync("where.exe", ["npx.cmd"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const launcher = result.stdout?.split(/\r?\n/).find(Boolean);
  const cli =
    launcher &&
    path.join(path.dirname(launcher), "node_modules/npm/bin/npx-cli.js");
  if (!cli || !existsSync(cli)) {
    throw new Error(
      "Could not resolve the npm npx-cli.js launcher from npx.cmd",
    );
  }

  return { command: process.execPath, prefixArguments: [cli] };
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(`${command} exited with ${code}\n${stderr || stdout}`),
        );
      }
    });
  });
}

export async function renderDiagramWithCli(
  diagram,
  index,
  temporaryDirectory,
  root = repositoryRoot,
) {
  const input = path.join(temporaryDirectory, `diagram-${index + 1}.mmd`);
  const output = path.join(temporaryDirectory, `diagram-${index + 1}.svg`);
  await writeFile(input, `${diagram.source}\n`, "utf8");
  const npx = npxInvocation();

  try {
    await run(
      npx.command,
      [
        ...npx.prefixArguments,
        "--yes",
        "--package",
        `@mermaid-js/mermaid-cli@${MERMAID_VERSION}`,
        "mmdc",
        "--quiet",
        "--input",
        input,
        "--output",
        output,
        "--backgroundColor",
        "transparent",
        "--puppeteerConfigFile",
        path.join(root, "scripts/mermaid-puppeteer-config.json"),
      ],
      { cwd: root },
    );
    if ((await stat(output)).size === 0) {
      throw new Error("renderer produced an empty SVG");
    }
  } catch (error) {
    throw new Error(
      `${diagram.file}:${diagram.line}: Mermaid ${MERMAID_VERSION} render failed\n${error.message}`,
    );
  }
}

export async function validateMermaidDocuments({
  root = repositoryRoot,
  files,
  renderDiagram = renderDiagramWithCli,
} = {}) {
  await assertMermaidRuntimeContract(root);
  const diagrams = await collectMermaidDocuments(
    root,
    files ?? listMarkdownFiles(root),
  );
  if (diagrams.length === 0) {
    throw new Error(
      "No Mermaid fences found; the validation gate would not exercise the renderer",
    );
  }

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "srn-mermaid-"));
  try {
    for (const [index, diagram] of diagrams.entries()) {
      await renderDiagram(diagram, index, temporaryDirectory, root);
      console.log(`OK ${diagram.file}:${diagram.line}`);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(
    `Rendered ${diagrams.length} Mermaid diagram(s) with Mermaid CLI ${MERMAID_VERSION}.`,
  );
  return diagrams;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await validateMermaidDocuments();
}

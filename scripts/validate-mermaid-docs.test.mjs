import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MERMAID_INCLUDE,
  MERMAID_VERSION,
  assertMermaidRuntimeContract,
  collectMermaidDocuments,
  extractMermaidFences,
  validateMermaidDocuments,
} from "./validate-mermaid-docs.mjs";

test("extractMermaidFences supports backtick and tilde fences with line numbers", () => {
  const markdown = [
    "# Diagrams",
    "",
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
    "",
    "~~~mermaid",
    "sequenceDiagram",
    "  A->>B: hello",
    "~~~~",
  ].join("\n");

  assert.deepEqual(extractMermaidFences(markdown, "docs/example.md"), [
    {
      file: "docs/example.md",
      line: 3,
      source: "flowchart LR\n  A --> B",
    },
    {
      file: "docs/example.md",
      line: 8,
      source: "sequenceDiagram\n  A->>B: hello",
    },
  ]);
});

test("extractMermaidFences ignores other code blocks", () => {
  assert.deepEqual(
    extractMermaidFences("```js\nconst mermaid = true\n```"),
    [],
  );
});

test("extractMermaidFences ignores Mermaid examples nested in a longer code fence", () => {
  const markdown = [
    "````",
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
    "````",
  ].join("\n");
  assert.deepEqual(extractMermaidFences(markdown), []);
});

test("extractMermaidFences rejects empty and unterminated diagrams", () => {
  assert.throws(
    () => extractMermaidFences("```mermaid\n```", "empty.md"),
    /empty\.md:1: empty Mermaid fence/,
  );
  assert.throws(
    () => extractMermaidFences("```mermaid\nflowchart LR", "open.md"),
    /open\.md:1: unterminated Mermaid fence/,
  );
});

test("collectMermaidDocuments requires the Jekyll bootstrap in docs pages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "srn-mermaid-test-"));
  try {
    await mkdir(path.join(root, "docs"));
    await writeFile(
      path.join(root, "docs/diagram.md"),
      "```mermaid\nflowchart LR\nA --> B\n```\n",
    );

    await assert.rejects(
      collectMermaidDocuments(root, ["docs/diagram.md"]),
      new RegExp(
        `Mermaid fences require ${MERMAID_INCLUDE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collectMermaidDocuments accepts the bootstrap and preserves source locations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "srn-mermaid-test-"));
  try {
    await mkdir(path.join(root, "docs"));
    await writeFile(
      path.join(root, "docs/diagram.md"),
      `${MERMAID_INCLUDE}\n\n\`\`\`mermaid\nflowchart LR\nA --> B\n\`\`\`\n`,
    );

    assert.deepEqual(await collectMermaidDocuments(root, ["docs/diagram.md"]), [
      {
        file: "docs/diagram.md",
        line: 3,
        source: "flowchart LR\nA --> B",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateMermaidDocuments invokes the renderer for every diagram", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "srn-mermaid-test-"));
  const rendered = [];
  try {
    await mkdir(path.join(root, "docs/_includes"), { recursive: true });
    await mkdir(path.join(root, "docs/assets"), { recursive: true });
    await writeFile(
      path.join(root, "docs/_includes/mermaid.html"),
      "/assets/mermaid-init.js",
    );
    await writeFile(
      path.join(root, "docs/assets/mermaid-init.js"),
      `const url = 'https://cdn.example/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs'; const options = { securityLevel: 'strict' }`,
    );
    await writeFile(
      path.join(root, "docs/assets/mermaid.css"),
      ".docs-mermaid {}",
    );
    await writeFile(
      path.join(root, "diagram.md"),
      "```mermaid\nflowchart LR\nA --> B\n```\n\n```mermaid\nflowchart LR\nB --> C\n```\n",
    );

    const diagrams = await validateMermaidDocuments({
      root,
      files: ["diagram.md"],
      renderDiagram: async (diagram) => rendered.push(diagram.source),
    });

    assert.equal(diagrams.length, 2);
    assert.deepEqual(rendered, [
      "flowchart LR\nA --> B",
      "flowchart LR\nB --> C",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the committed runtime pins the same Mermaid version as the validator", async () => {
  await assertMermaidRuntimeContract(path.resolve(import.meta.dirname, ".."));
});

test("the runtime contract accepts formatted string quotes but rejects a weaker security level", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "srn-mermaid-runtime-test-"));
  try {
    await mkdir(path.join(root, "docs/_includes"), { recursive: true });
    await mkdir(path.join(root, "docs/assets"), { recursive: true });
    await writeFile(
      path.join(root, "docs/_includes/mermaid.html"),
      "/assets/mermaid-init.js",
    );
    await writeFile(
      path.join(root, "docs/assets/mermaid.css"),
      ".docs-mermaid {}",
    );

    const runtimePath = path.join(root, "docs/assets/mermaid-init.js");
    await writeFile(
      runtimePath,
      `const url = 'https://cdn.example/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs'; const options = { securityLevel: "strict" }`,
    );
    await assertMermaidRuntimeContract(root);

    await writeFile(
      runtimePath,
      `const url = 'https://cdn.example/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs'; const options = { securityLevel: "loose" }`,
    );
    await assert.rejects(
      () => assertMermaidRuntimeContract(root),
      /must use Mermaid securityLevel 'strict'/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

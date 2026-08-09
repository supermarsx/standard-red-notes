const MERMAID_MODULE_URL =
  "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs";
let renderGeneration = 0;

function installStylesheet() {
  if (document.querySelector("link[data-srn-mermaid-styles]")) {
    return;
  }

  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = new URL("./mermaid.css", import.meta.url).href;
  stylesheet.dataset.srnMermaidStyles = "";
  document.head.append(stylesheet);
}

function diagramContainerFor(code) {
  return code.closest(".highlighter-rouge") ?? code.closest("pre");
}

async function renderMermaidDiagrams() {
  const diagrams = [
    ...[...document.querySelectorAll("code.language-mermaid")].map((code) => ({
      container: diagramContainerFor(code),
      source: code.textContent?.trim(),
    })),
    ...[...document.querySelectorAll(".docs-mermaid[data-mermaid-source]")].map(
      (figure) => ({
        container: figure,
        source: figure.dataset.mermaidSource,
      }),
    ),
  ].filter(({ container, source }) => container && source);

  if (diagrams.length === 0) {
    return;
  }

  installStylesheet();
  const generation = ++renderGeneration;

  try {
    const { default: mermaid } = await import(MERMAID_MODULE_URL);
    const darkMode = document.documentElement.dataset.theme !== "light";
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: darkMode ? "dark" : "neutral",
    });

    for (const [index, { container, source }] of diagrams.entries()) {
      try {
        const { svg, bindFunctions } = await mermaid.render(
          `srn-mermaid-${generation}-${index + 1}`,
          source,
        );
        if (generation !== renderGeneration) {
          return;
        }
        const figure = document.createElement("figure");
        figure.className = "docs-mermaid";
        figure.setAttribute("aria-label", "Diagram");
        figure.dataset.mermaidSource = source;
        figure.innerHTML = svg;
        container.replaceWith(figure);
        bindFunctions?.(figure);
      } catch (error) {
        container.classList.add("docs-mermaid-source-error");
        console.error(
          "Unable to render Mermaid diagram; showing its source instead.",
          error,
        );
      }
    }
  } catch (error) {
    console.error(
      "Unable to load Mermaid; showing diagram source instead.",
      error,
    );
  }
}

window.addEventListener("srn:themechange", () => void renderMermaidDiagrams());

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => void renderMermaidDiagrams(),
    { once: true },
  );
} else {
  void renderMermaidDiagrams();
}

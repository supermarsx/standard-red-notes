import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { JSDOM } from "jsdom";

const docsUiSource = await readFile(
  new URL("../docs/assets/docs-ui.js", import.meta.url),
  "utf8",
);
const docsSearchSource = await readFile(
  new URL("../docs/assets/docs-search.js", import.meta.url),
  "utf8",
);
const docsSearchMarkup = await readFile(
  new URL("../docs/_includes/search.html", import.meta.url),
  "utf8",
);
const docsSidebarMarkup = await readFile(
  new URL("../docs/_includes/sidebar.html", import.meta.url),
  "utf8",
);
const docsLayoutMarkup = await readFile(
  new URL("../docs/_layouts/default.html", import.meta.url),
  "utf8",
);
const docsStyles = await readFile(
  new URL("../docs/assets/docs.css", import.meta.url),
  "utf8",
);
const docsExtraStyles = await readFile(
  new URL("../docs/assets/docs-extras.css", import.meta.url),
  "utf8",
);
const docsAlertStyles = await readFile(
  new URL("../docs/assets/safety-alerts.css", import.meta.url),
  "utf8",
);
const mermaidSource = await readFile(
  new URL("../docs/assets/mermaid-init.js", import.meta.url),
  "utf8",
);

function createDom(html, url) {
  return new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url,
  });
}

function flush(window) {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function themeToken(block, token) {
  const value = block.match(
    new RegExp(`--${token}:\\s*(#[0-9a-f]{6})`, "i"),
  )?.[1];
  assert.ok(value, `missing hexadecimal --${token} theme token`);
  return value;
}

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const luminances = [relativeLuminance(first), relativeLuminance(second)].sort(
    (left, right) => right - left,
  );
  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}

test("docs search markup names the dialog, status, results, and keyboard shortcuts", () => {
  assert.match(docsSearchMarkup, /aria-labelledby="docs-search-title"/);
  assert.match(docsSearchMarkup, /aria-describedby="docs-search-status"/);
  assert.match(docsSearchMarkup, /aria-live="polite" aria-atomic="true"/);
  assert.match(docsSearchMarkup, /aria-label="Documentation search results"/);
  assert.match(docsSearchMarkup, /aria-keyshortcuts="Control\+K Meta\+K \/"/);
  assert.doesNotMatch(docsSearchMarkup, /aria-autocomplete=/);
});

test("docs Pages ship a dark-first theme contract with a persistent light escape hatch", () => {
  assert.match(docsLayoutMarkup, /<html lang="en" data-theme="dark">/);
  assert.match(
    docsLayoutMarkup,
    /<meta name="color-scheme" content="dark light"/,
  );
  assert.match(docsLayoutMarkup, /data-docs-theme-color/);
  assert.match(
    docsLayoutMarkup,
    /localStorage\.getItem\(\s*["']standard-red-notes-docs-theme["']/,
  );
  assert.ok(
    docsLayoutMarkup.indexOf("standard-red-notes-docs-theme") <
      docsLayoutMarkup.indexOf("/assets/docs.css"),
  );
  assert.match(docsSidebarMarkup, /data-docs-theme-toggle/);
  assert.match(docsStyles, /:root\s*{[\s\S]*?color-scheme: dark/);
  assert.match(
    docsStyles,
    /:root\[data-theme="light"\]\s*{[\s\S]*?color-scheme: light/,
  );
  assert.match(docsStyles, /--accent-fill: #be1f2d/);
  assert.match(docsAlertStyles, /:root\[data-theme="light"\] \.safety-alert/);
  assert.match(
    mermaidSource,
    /document\.documentElement\.dataset\.theme !== ["']light["']/,
  );
  assert.match(mermaidSource, /["']srn:themechange["']/);

  const darkTheme = docsStyles.match(/^:root\s*{([\s\S]*?)^}/m)?.[1];
  const lightTheme = docsStyles.match(
    /^:root\[data-theme="light"\]\s*{([\s\S]*?)^}/m,
  )?.[1];
  assert.ok(darkTheme);
  assert.ok(lightTheme);

  for (const [foreground, background, minimum, label] of [
    ["ink", "paper", 4.5, "dark body text"],
    ["muted", "paper", 4.5, "dark muted text"],
    ["red", "paper", 4.5, "dark links"],
    ["on-accent", "accent-fill", 4.5, "dark filled actions"],
    ["placeholder", "panel", 4.5, "dark placeholders"],
    ["field-border", "panel", 3, "dark control borders"],
  ]) {
    assert.ok(
      contrastRatio(
        themeToken(darkTheme, foreground),
        themeToken(darkTheme, background),
      ) >= minimum,
      `${label} must meet ${minimum}:1 contrast`,
    );
  }

  for (const [foreground, background, minimum, label] of [
    ["ink", "paper", 4.5, "light body text"],
    ["muted", "paper", 4.5, "light muted text"],
    ["red", "paper", 4.5, "light links"],
    ["on-accent", "accent-fill", 4.5, "light filled actions"],
    ["placeholder", "panel", 4.5, "light placeholders"],
    ["field-border", "panel", 3, "light control borders"],
  ]) {
    assert.ok(
      contrastRatio(
        themeToken(lightTheme, foreground),
        themeToken(lightTheme, background),
      ) >= minimum,
      `${label} must meet ${minimum}:1 contrast`,
    );
  }
});

test("docs keep focus visible in forced colors and use readable print alert colors", () => {
  for (const styles of [docsStyles, docsExtraStyles]) {
    assert.doesNotMatch(styles, /:focus-visible[^{}]*\{[^}]*outline:\s*none/i);
  }
  assert.match(
    docsExtraStyles,
    /@media \(forced-colors: active\)\s*\{[\s\S]*?:focus-visible\s*\{[\s\S]*?outline:\s*3px solid Highlight/,
  );

  const printStart = docsAlertStyles.indexOf("@media print");
  const forcedColorsStart = docsAlertStyles.indexOf(
    "@media (forced-colors: active)",
  );
  assert.ok(printStart >= 0 && forcedColorsStart > printStart);
  const printStyles = docsAlertStyles.slice(printStart, forcedColorsStart);
  assert.match(
    printStyles,
    /\.safety-alert__icon\s*\{[^}]*background:\s*transparent[^}]*color:\s*var\(--alert-accent\)/s,
  );

  for (const [foreground, label] of [
    ["#8f5b00", "warning alert"],
    ["#a31320", "danger alert"],
    ["#315d75", "trust alert"],
    ["#3c5f2f", "info alert"],
    ["#315f24", "confirmed badge"],
    ["#765000", "conditional badge"],
    ["#2f568a", "export badge"],
    ["#63449a", "fork badge"],
    ["#4b5563", "unverified badge"],
    ["#8b1722", "incompatible badge"],
  ]) {
    assert.match(printStyles, new RegExp(foreground, "i"));
    assert.ok(
      contrastRatio(foreground, "#ffffff") >= 4.5,
      `${label} print foreground must meet 4.5:1 against white paper`,
    );
  }
});

test("docs theme control restores, toggles, labels, colors, and persists the selected theme", () => {
  const dom = createDom(
    `<!doctype html>
      <html data-theme="dark">
        <head><meta name="theme-color" content="#0b090a" data-docs-theme-color></head>
        <body>
          <button type="button" data-docs-theme-toggle hidden>
            <span data-docs-theme-icon></span>
            <span data-docs-theme-label></span>
          </button>
        </body>
      </html>`,
    "https://docs.example/",
  );

  try {
    const { document } = dom.window;
    const themeChanges = [];
    dom.window.localStorage.setItem("standard-red-notes-docs-theme", "light");
    dom.window.addEventListener("srn:themechange", (event) =>
      themeChanges.push(event.detail.theme),
    );

    dom.window.eval(docsUiSource);

    const toggle = document.querySelector("[data-docs-theme-toggle]");
    const meta = document.querySelector("[data-docs-theme-color]");
    assert.equal(document.documentElement.dataset.theme, "light");
    assert.equal(toggle.hidden, false);
    assert.equal(toggle.getAttribute("aria-label"), "Switch to dark theme");
    assert.equal(toggle.getAttribute("title"), "Switch to dark theme");
    assert.equal(
      toggle.querySelector("[data-docs-theme-icon]").textContent,
      "☾",
    );
    assert.equal(meta.getAttribute("content"), "#fffaf6");

    toggle.click();
    assert.equal(document.documentElement.dataset.theme, "dark");
    assert.equal(toggle.getAttribute("aria-label"), "Switch to light theme");
    assert.equal(
      toggle.querySelector("[data-docs-theme-icon]").textContent,
      "☀",
    );
    assert.equal(meta.getAttribute("content"), "#0b090a");
    assert.equal(
      dom.window.localStorage.getItem("standard-red-notes-docs-theme"),
      "dark",
    );
    assert.deepEqual(themeChanges, ["dark"]);
  } finally {
    dom.window.close();
  }
});

test("docs UI builds an active H2-H4 table of contents and operates navigation and copy controls", async () => {
  const dom = createDom(
    `<!doctype html>
      <html>
        <body>
          <aside data-docs-sidebar>
            <button type="button" aria-expanded="false" data-docs-nav-toggle>
              <span data-docs-nav-toggle-label>Browse docs</span>
            </button>
            <div data-docs-page-toc></div>
            <nav>
              <details data-docs-nav-details>
                <summary>Use the app</summary>
                <details data-docs-nav-details>
                  <summary>Security</summary>
                  <a href="/guide.html" data-docs-nav-link>Guide</a>
                  <a href="/guide.html#explicit" data-docs-nav-link>Explicit section</a>
                </details>
              </details>
            </nav>
          </aside>
          <main class="docs-content">
            <article>
              <h2 id="overview">Overview</h2>
              <a id="explicit"></a>
              <h3>Explicit section</h3>
              <h4>Café &amp; sync</h4>
              <pre><code>srn-client notes list</code></pre>
              <pre><code class="language-mermaid">flowchart LR</code></pre>
            </article>
          </main>
        </body>
      </html>`,
    "https://docs.example/guide.html#explicit",
  );

  try {
    const { document, Event, KeyboardEvent, MouseEvent } = dom.window;
    const observedHeadings = [];
    let observerCallback;

    dom.window.matchMedia = () => ({ matches: true });
    dom.window.IntersectionObserver = class {
      constructor(callback) {
        observerCallback = callback;
      }

      observe(heading) {
        observedHeadings.push(heading);
      }
    };

    let copiedText;
    Object.defineProperty(dom.window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(dom.window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          copiedText = value;
        },
      },
    });

    dom.window.eval(docsUiSource);

    const navigationLinks = [
      ...document.querySelectorAll("[data-docs-nav-link]"),
    ];
    assert.equal(navigationLinks[0].hasAttribute("aria-current"), false);
    assert.equal(navigationLinks[1].getAttribute("aria-current"), "location");
    assert.equal(
      document.querySelectorAll("details[data-docs-nav-details][open]").length,
      2,
    );

    const tableOfContents = document.querySelector("[data-docs-page-toc]");
    const tableOfContentsLinks = [...tableOfContents.querySelectorAll("a")];
    assert.deepEqual(
      tableOfContentsLinks.map((link) => link.getAttribute("href")),
      ["#overview", "#explicit", "#cafe-sync"],
    );
    assert.deepEqual(
      [...tableOfContents.querySelectorAll("li")].map((item) => item.className),
      [
        "docs-page-toc__level-2",
        "docs-page-toc__level-3",
        "docs-page-toc__level-4",
      ],
    );
    assert.equal(
      tableOfContentsLinks[1].getAttribute("aria-current"),
      "location",
    );
    assert.equal(observedHeadings.length, 3);

    observerCallback([
      {
        boundingClientRect: { top: 8 },
        isIntersecting: true,
        target: observedHeadings[2],
      },
    ]);
    assert.equal(
      tableOfContentsLinks[2].getAttribute("aria-current"),
      "location",
    );
    assert.equal(tableOfContentsLinks[1].hasAttribute("aria-current"), false);

    const sidebar = document.querySelector("[data-docs-sidebar]");
    const toggle = document.querySelector("[data-docs-nav-toggle]");
    const toggleLabel = toggle.querySelector("[data-docs-nav-toggle-label]");
    toggle.click();
    assert.equal(sidebar.classList.contains("is-open"), true);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggleLabel.textContent, "Close docs");

    navigationLinks[0].addEventListener("click", (event) =>
      event.preventDefault(),
    );
    navigationLinks[0].dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    assert.equal(sidebar.classList.contains("is-open"), false);

    toggle.click();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
    );
    assert.equal(sidebar.classList.contains("is-open"), false);
    assert.equal(document.activeElement, toggle);

    const copyButtons = [...document.querySelectorAll(".docs-copy-button")];
    assert.equal(copyButtons.length, 1);
    copyButtons[0].dispatchEvent(new Event("click", { bubbles: true }));
    await flush(dom.window);
    assert.equal(copiedText, "srn-client notes list");
    assert.equal(copyButtons[0].textContent, "Copied");
  } finally {
    dom.window.close();
  }
});

test("docs search loads locally, supports keyboard opening, highlights results, and restores focus on close", async () => {
  const dom = createDom(
    `<!doctype html>
      <html>
        <body>
          <div
            data-docs-search
            data-search-index-url="/red-notes/assets/search-index.json"
            data-search-base-url="/red-notes/"
          >
            <button type="button" data-search-trigger hidden>
              Search docs
              <kbd data-search-shortcut>Ctrl K</kbd>
            </button>
            <dialog data-search-dialog>
              <input type="search" data-search-input />
              <button type="button" data-search-close>Close</button>
              <p data-search-status></p>
              <ol data-search-results></ol>
            </dialog>
          </div>
        </body>
      </html>`,
    "https://docs.example/red-notes/index.html",
  );

  try {
    const { document, Event, KeyboardEvent } = dom.window;
    const dialog = document.querySelector("[data-search-dialog]");
    dialog.showModal = () => {
      dialog.open = true;
    };
    dialog.close = () => {
      dialog.open = false;
    };

    let requestedUrl;
    dom.window.fetch = async (url) => {
      requestedUrl = url;
      return {
        json: async () => ({
          documents: [
            {
              section: "Write gate",
              text: "Set STANDARD_RED_NOTES_ALLOW_WRITES only after reviewing the Café safety boundary.",
              title: "Security and account",
              url: "security-and-account.html#write-gate",
            },
            {
              section: "Read-only mode",
              text: "Automation safety starts in read-only mode.",
              title: "MCP bridge",
              url: "mcp-bridge.html#read-only-mode",
            },
          ],
          version: 1,
        }),
        ok: true,
      };
    };

    dom.window.eval(docsSearchSource);

    const trigger = document.querySelector("[data-search-trigger]");
    const input = document.querySelector("[data-search-input]");
    const results = document.querySelector("[data-search-results]");
    assert.equal(trigger.hidden, false);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "k" }),
    );
    await flush(dom.window);
    await flush(dom.window);

    assert.equal(dialog.open, true);
    assert.equal(document.activeElement, input);
    assert.equal(requestedUrl, "/red-notes/assets/search-index.json");

    input.value = "standard_red_notes_allow_writes";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    assert.match(
      document.querySelector("[data-search-status]").textContent,
      /^1 result/,
    );
    assert.equal(results.children.length, 1);
    const resultLink = results.querySelector("a");
    assert.equal(
      resultLink.href,
      "https://docs.example/red-notes/security-and-account.html#write-gate",
    );
    assert.ok(resultLink.querySelectorAll("mark").length >= 1);
    assert.equal(resultLink.classList.contains("is-active"), true);
    assert.equal(resultLink.hasAttribute("aria-current"), false);
    assert.equal(resultLink.tabIndex, 0);

    input.value = "safety";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(results.children.length, 2);
    const safetyLinks = [...results.querySelectorAll("a")];
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }),
    );
    assert.ok(document.activeElement.isSameNode(safetyLinks.at(-1)));
    assert.equal(safetyLinks.at(-1).tabIndex, 0);
    assert.equal(safetyLinks[0].tabIndex, -1);

    safetyLinks
      .at(-1)
      .dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Home" }),
      );
    assert.ok(document.activeElement.isSameNode(safetyLinks[0]));
    safetyLinks[0].dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "End" }),
    );
    assert.ok(document.activeElement.isSameNode(safetyLinks.at(-1)));

    input.focus();
    input.value = "cafe";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(results.children.length, 1);
    assert.equal(results.querySelector("mark").textContent, "Café");
    assert.match(
      results.querySelector(".docs-search-result-snippet").textContent,
      /Café safety/,
    );

    input.value = "standard_red_notes_allow_writes";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }),
    );
    assert.ok(document.activeElement.isSameNode(results.querySelector("a")));

    const cancel = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true);
    assert.equal(dialog.open, false);
    assert.equal(document.activeElement, trigger);

    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "/" }),
    );
    assert.equal(dialog.open, false);

    trigger.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "/" }),
    );
    assert.equal(dialog.open, true);
  } finally {
    dom.window.close();
  }
});

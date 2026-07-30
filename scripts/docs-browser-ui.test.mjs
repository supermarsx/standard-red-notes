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
              text: "Set STANDARD_RED_NOTES_ALLOW_WRITES only after reviewing the safety boundary.",
              title: "Security and account",
              url: "security-and-account.html#write-gate",
            },
            {
              section: "Read-only mode",
              text: "Automation starts read only.",
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
    assert.equal(resultLink.getAttribute("aria-current"), "true");

    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }),
    );
    assert.equal(document.activeElement, resultLink);

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

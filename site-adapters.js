// SITE ADAPTERS — this is the single most fragile file in the project, by design.
// The PRD's own risk register names selector-map maintenance as the highest-likelihood
// technical risk in the whole feature: these UIs change without notice, and there is no
// way to guarantee these selectors are correct beyond testing them live right now.
// Selectors below are a best-effort based on each site's documented DOM patterns as of
// 2026-08-15 — NOT verified against the live pages (no browser access from the build
// environment). Expect to need to fix at least one of these after first real test.
//
// If a selector stops working: open the site, right-click the input box, "Inspect",
// and find the actual element — then update findInput() below for that site.
//
// Guarded against double-injection: background.js's sendMessageWithRetry() may inject
// this file a second time into a tab that already has it (recovery path for tabs that
// were open before the extension last reloaded). Re-running a plain `const`/`let` at
// top level a second time throws "already declared" and silently kills the rest of the
// injected script — so everything here lives inside a one-time guard and is attached to
// `window` explicitly, since content scripts from the same extension share one global
// object per page/frame.
if (!window.__promptAssistAdaptersLoaded) {
  window.__promptAssistAdaptersLoaded = true;

  const SITE_ADAPTERS = {
    "chatgpt.com": {
      label: "ChatGPT",
      findInput() {
        return (
          document.querySelector("#prompt-textarea") ||
          document.querySelector('div[contenteditable="true"][data-id]') ||
          document.querySelector('textarea[data-testid="prompt-textarea"]')
        );
      },
      getText(el) {
        return el.tagName === "TEXTAREA" ? el.value : el.innerText;
      },
      setText(el, text) {
        if (el.tagName === "TEXTAREA") window.__paSetTextareaValue(el, text);
        else window.__paSetContentEditableText(el, text);
      },
    },

    "gemini.google.com": {
      label: "Gemini",
      findInput() {
        return (
          document.querySelector('div.ql-editor[contenteditable="true"]') ||
          document.querySelector('rich-textarea div[contenteditable="true"]')
        );
      },
      getText(el) {
        return el.innerText;
      },
      setText(el, text) {
        window.__paSetContentEditableText(el, text);
      },
    },

    "claude.ai": {
      label: "Claude",
      findInput() {
        return (
          document.querySelector('div.ProseMirror[contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"][data-testid="chat-input"]')
        );
      },
      getText(el) {
        return el.innerText;
      },
      setText(el, text) {
        window.__paSetContentEditableText(el, text);
      },
    },
  };

  // Sets text into a contenteditable element in a way React/framework-controlled inputs
  // will actually pick up (naive .innerText = ... does not trigger their state updates).
  window.__paSetContentEditableText = function (el, text) {
    el.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
  };

  // Sets text into a native textarea via the framework-bypassing native setter, since
  // React-controlled textareas ignore a plain .value = ... assignment.
  window.__paSetTextareaValue = function (el, text) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  // GENERIC HEURISTIC — used for user-added custom sites, where there's no hand-written
  // selector to verify against. Best-effort guess, deliberately conservative: prefers
  // the currently-focused field if it's a plausible candidate, otherwise the largest
  // visible textarea/contenteditable nearest the bottom of the page (chat inputs are
  // almost always positioned there). A user-supplied CSS selector (set in the options
  // page for that site) always takes priority over this when present.
  function genericFindInput() {
    const candidates = [...document.querySelectorAll("textarea"), ...document.querySelectorAll('[contenteditable="true"]')];
    const visible = candidates.filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 50 && rect.height > 20 && style.visibility !== "hidden" && style.display !== "none";
    });
    if (visible.length === 0) return null;
    if (document.activeElement && visible.includes(document.activeElement)) return document.activeElement;
    visible.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return visible[0];
  }

  function buildGenericAdapter(hostname, customSelector) {
    return {
      label: hostname,
      findInput() {
        if (customSelector) {
          const el = document.querySelector(customSelector);
          if (el) return el;
          // custom selector didn't match anything on this page load — fall through to
          // the heuristic rather than failing outright, since sites change their DOM
        }
        return genericFindInput();
      },
      getText(el) {
        return el.tagName === "TEXTAREA" ? el.value : el.innerText;
      },
      setText(el, text) {
        if (el.tagName === "TEXTAREA") window.__paSetTextareaValue(el, text);
        else window.__paSetContentEditableText(el, text);
      },
    };
  }

  // Custom sites are stored async in chrome.storage.local, but getCurrentAdapter() is
  // called synchronously everywhere in this codebase. Fetch once on load into this
  // cache rather than threading async through every call site — the brief gap before
  // this resolves is harmless since the user hasn't started typing yet at page-load time.
  let customSiteConfig = null;
  if (chrome?.storage?.local) {
    chrome.storage.local.get(["customSites"]).then(({ customSites }) => {
      const match = (customSites || []).find((s) => s.hostname === window.location.hostname);
      if (match) customSiteConfig = match;
    }).catch(() => {});
  }

  window.getCurrentAdapter = function () {
    const hostname = window.location.hostname;
    if (SITE_ADAPTERS[hostname]) return SITE_ADAPTERS[hostname];
    if (customSiteConfig && customSiteConfig.hostname === hostname) {
      return buildGenericAdapter(hostname, customSiteConfig.selector);
    }
    return null;
  };
}

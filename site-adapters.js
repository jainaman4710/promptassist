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
      // Confirmed via first-party sources: an existing conversation's URL is
      // /c/<conversation-id>; a new/provisional chat is at bare / (or / with query params,
      // e.g. a model override). Well-verified, not expected to need fixing.
      isFollowUp() {
        return /^\/c\//.test(window.location.pathname);
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
      // LESS CONFIDENT than the other two — confirmed a new chat starts at bare /app, but
      // could not confirm the exact existing-conversation URL shape from first-party
      // sources the way ChatGPT's /c/ and Claude's /chat/ were. Best-effort heuristic:
      // any path segment beyond /app itself means an existing conversation is loaded.
      // Verify against the live site and fix if wrong, same as this file's selectors.
      isFollowUp() {
        const path = window.location.pathname.replace(/\/+$/, "");
        return path !== "/app";
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
      // Confirmed via Anthropic's own support docs: an existing conversation's URL is
      // /chat/{conversation-id}; a new chat is at /new. Well-verified, not expected to
      // need fixing.
      isFollowUp() {
        return /^\/chat\//.test(window.location.pathname);
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
      // No way to know a custom site's URL scheme for new-vs-existing chats — always
      // false (treat as first message) rather than guess. Deliberate: under-flagging an
      // actual follow-up as new just reproduces today's already-fine full-strictness
      // behavior; over-flagging an actual new chat as a follow-up risks under-auditing a
      // genuinely incomplete first message. Fail toward the proven-safe side.
      isFollowUp() {
        return false;
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

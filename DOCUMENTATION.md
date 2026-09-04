# PromptAssist (Track A Prototype) — Documentation

A Chrome extension implementing the audit-driven prompt-enhancement pipeline described in
the PromptAssist PRD, scoped down to a standalone, client-only prototype (no backend, no
Grammarly integration) per the Track A build brief. This document covers what was built,
how it works, the decisions behind it, and — importantly — the mistakes made and fixed
along the way, since several of them are non-obvious and easy to reintroduce.

---

## 1. What this is

- A Chrome side panel where you paste a rough draft prompt and get back a structured,
  audited, improved version.
- A floating on-page widget on ChatGPT, Gemini, and Claude (plus any custom sites you
  add) that does the same thing without leaving the page.
- A three-step pipeline — **audit → structural enhancement → self-critique** — split
  across two LLM providers (Gemini for audit/critique, Groq for generation), run
  entirely from the browser with your own API keys.

**Explicitly out of scope for this build:** chain-of-thought and few-shot conditional
passes (the audit detects when they're needed but nothing acts on it yet), the
revise/recheck auto-correction loop (a failed critique is surfaced honestly, not
auto-fixed), and any eval harness.

---

## 2. Architecture — file map

| File | Runs where | Responsibility |
|---|---|---|
| `manifest.json` | — | Extension configuration: permissions, content scripts, commands |
| `background.js` | Service worker | Keyboard shortcut handling, port-based pipeline orchestration for the on-page flow, tab messaging with auto-recovery |
| `content-script.js` | Injected into AI-tool pages | Field detection/monitoring, message routing between background and floating-ui.js |
| `site-adapters.js` | Injected into AI-tool pages | Per-site selectors (find/read/write the input field) + generic fallback heuristic for custom sites |
| `floating-ui.js` | Injected into AI-tool pages | The on-page widget: idle icon, loading card, review card — all shadow-DOM based |
| `sidepanel.html` / `sidepanel.js` | Extension page | The side panel UI and its own copy of the enhance flow |
| `options.html` / `options.js` | Extension page | API key entry, custom-site management |
| `shared.js` | Both service worker and side panel (via `importScripts`/`<script>`) | Fetch-with-retry helper |
| `gemini.js` | Same as above | Gemini API wrapper (audit + critique calls) |
| `groq.js` | Same as above | Groq API wrapper (structural pass) |
| `pipeline.js` | Same as above | Orchestrates the three-call pipeline, provider-agnostic |
| `styles.css` | Extension pages only | Theme for side panel + options page |

**Why the same three files (`site-adapters.js`, `floating-ui.js`, `content-script.js`)
get loaded three different ways** (static `manifest.json` content_scripts, dynamic
`chrome.scripting.executeScript` recovery injection, dynamic
`chrome.scripting.registerContentScripts` for custom sites): they all need to run in the
same page context regardless of *how* that page came to have the extension active on it
(loaded fresh vs. reloaded extension vs. custom site added after the fact). This is also
exactly why every one of those three files is guarded against double-injection (see
§4 below) — multiple injection paths mean it's a real, not theoretical, scenario.

---

## 3. The pipeline

```
Draft prompt
    │
    ▼
┌─────────────────┐   Gemini (gemini-3.5-flash)
│  1. Audit        │   Structured JSON: anatomy (instruction/context/input_data/
│                  │   output_indicator: present/weak/missing[/not_applicable]),
│                  │   task_domain, complexity, technique_flags (role_assignment,
│                  │   few_shot_examples, chain_of_thought, explicit_structure,
│                  │   grounding_permission), confidence, intent (goal/register/audience)
└────────┬─────────┘
         ▼
┌─────────────────┐   Groq (openai/gpt-oss-120b)
│  2. Structural   │   Gap-fills weak/missing anatomy elements, applies role_assignment /
│     pass         │   explicit_structure / grounding_permission ONLY where flagged.
│                  │   Also produces the plain-language Recap in the same call.
└────────┬─────────┘
         ▼
┌─────────────────┐   Gemini (gemini-3.5-flash)
│  3. Self-critique│   Checklist verification against the audit: every flagged gap now
│                  │   reads as present, every flagged technique applied, nothing
│                  │   unflagged added. Returns passed:bool + issues:[].
└────────┬─────────┘
         ▼
Enhanced prompt + Recap + critique result → shown for approval, never auto-applied
```

**Provider routing rationale:** Gemini handles the audit and critique calls because both
are JSON-schema-constrained ("does this data conform to a structure") — Gemini's native
`responseSchema` support matters most there. Groq handles the generative structural pass
because it's free-text generation where a higher daily request cap matters more than
schema fidelity. This also spreads load across both free tiers rather than exhausting one.

**Call count:** 3 calls per run (audit → structural → one critique check), fixed in this
build's scope — no conditional CoT/few-shot passes, no revise loop.

---

## 4. Cautionary notes — read this before changing anything

These are lessons from real, confirmed bugs hit during development, not speculative
concerns. Several took many debugging rounds to isolate.

### 4.1 Never use `innerHTML` in content-script-injected UI
`floating-ui.js` builds its entire DOM tree with `document.createElement` /
`appendChild` / `.textContent` — **never** `.innerHTML`. Sites that enforce a Trusted
Types CSP (Gemini among them) throw a `TypeError` on any raw-string `innerHTML`
assignment, even inside a shadow root, and that error gets silently swallowed if it
happens inside an event handler or interval callback. This was the root cause of the
floating widget never appearing at all for an extended debugging stretch — the widget
was being *called* correctly the whole time; it just never got *built*. The one safe
exception found: setting `<style>.textContent` is fine (not subject to Trusted Types,
since it's not HTML parsing).

### 4.2 Guard every content-script file against double-injection
`site-adapters.js` and `floating-ui.js` both wrap their entire body in
`if (!window.__promptAssistXLoaded) { window.__promptAssistXLoaded = true; ... }`.
Without this, re-injecting a file that's already present (which happens routinely via
`background.js`'s recovery path — see §4.3) throws `Identifier has already been
declared` on the second `const`/`let` at top level, which silently kills the rest of
that script execution. This was a second, separate root cause behind the same
"floating widget doesn't appear" symptom as §4.1 — two independent bugs producing an
identical symptom, which is part of why it took so long to isolate.

### 4.3 Content scripts don't retroactively inject into already-open tabs
Reloading the extension does **not** re-run content scripts in tabs that were already
open before the reload — they only auto-inject on page load. `background.js`'s
`sendMessageWithRetry()` exists specifically to paper over this: if a message to a tab
fails, it injects the three content-script files via `chrome.scripting.executeScript`
and retries once. This is also why §4.2's guard is load-bearing rather than defensive
paranoia.

### 4.4 A fire-and-forget message does NOT keep a Manifest V3 service worker alive
Chrome kills an MV3 service worker after ~30s of inactivity, and a pending `fetch()`
alone is not a reliable exemption (acknowledged as inconsistent by Chrome's own
extensions team). The original design triggered the pipeline via a one-shot
`chrome.runtime.sendMessage`, which let the "event" complete immediately from Chrome's
perspective while the actual multi-call pipeline kept running in the background —
resulting in the service worker being killed mid-run, silently, with the on-page
widget stuck on "loading" forever. **The fix:** the enhance flow runs over a
**persistent port** (`chrome.runtime.connect` / `onConnect`), which Chrome explicitly
keeps a worker alive for. See `runEnhanceFlowOverPort` in `background.js` and
`window.__paTriggerEnhanceFlow` in `content-script.js`. Do not revert this to a plain
`sendMessage` for anything that runs longer than a trivial amount of time.

### 4.5 Ad/annoyance-blocker cosmetic filters can clip the widget to zero size
A generic content-blocker cosmetic filter (not a targeted rule — these are broad
"hide floating chat-bubble-shaped widgets" rules many blockers ship by default) was
observed clipping the widget's light-DOM host element to `width:0; height:0` via an
injected stylesheet, while everything *inside* the shadow root remained completely
unaffected (shadow DOM genuinely blocks generic CSS selector-based filters from
reaching in — confirmed both by a 2019 uBlock Origin GitHub issue and by direct
observation in this project). **Mitigation applied:** every layout-critical property
on the host element (`position`, `width`, `height`, `display`, `visibility`, `z-index`)
is set with `!important` inline, which beats external stylesheet rules of equal or
lower specificity. Also avoid `z-index: 2147483647` (the literal max value) — it's a
well-known signature pattern some filter lists specifically target; this project uses
`999999` instead. This is a mitigation, not a guarantee — some blockers reapply hiding
via JavaScript/MutationObserver, which inline styles can't defend against. The
practical fallback is the toolbar-icon tooltip pointing to the side panel (see
`checkWidgetActuallyVisible` in `content-script.js` and the `widgetBlocked` handler in
`background.js`), since the side panel isn't page content and can't be targeted this way.

### 4.6 Don't poll for content — poll only for existence, then switch to events
The field-monitoring logic in `content-script.js` is deliberately event-driven (`input`
listener + `MutationObserver`), not a timer that continuously reads the field's text.
The *only* timer that remains checks whether the input element exists yet on the page
(a boolean check, never reads its content) and stops permanently once found. An earlier
version polled the field's actual text every 800ms indefinitely, which is a real
"passive surveillance" behavior mismatched with what the extension claims to do — see
§4.9 on keeping the disclaimer honest.

### 4.7 API keys: header-based auth, not URL query parameters
Gemini's key is sent via the `x-goog-api-key` header, not `?key=...` in the URL. A key
in a URL ends up in the Network tab's URL column, browser history, and any proxy or
referrer logging — a header does not. Groq's key was already correctly header-based
(`Authorization: Bearer`). Neither key is ever logged to console anywhere in this
codebase — verify this holds if you add new API calls.

### 4.8 Model IDs will drift — this is not hypothetical, it already happened twice
`gemini-2.5-flash` was retired for new API keys ahead of its own posted shutdown date.
`llama-3.3-70b-versatile` was fully decommissioned by Groq mid-project. **Re-verify
both model IDs** (`GEMINI_MODEL` in `gemini.js`, `GROQ_MODEL` in `groq.js`) against
current provider documentation before assuming a 404 or "model not found" error is a
code bug. `openai/gpt-oss-120b` (the current Groq model) is a reasoning model with
documented quirks — occasionally putting output in a `reasoning`/`reasoning_content`
field instead of `content`, or leaking internal control tokens like `<|return|>` — the
parsing in `groq.js` defends against both, but if a *new* failure mode shows up, check
Groq's community forum for `gpt-oss-120b` first; this is an actively-quirky model.

### 4.9 Selector fragility is permanent, not a bug to eventually fix
`site-adapters.js`'s hand-written selectors for ChatGPT, Gemini, and Claude are
best-effort and were never verified against a live browser during initial development
(no browser access from the build environment) — they were confirmed working only
through real user testing after the fact. These will break without warning whenever
any of the three sites ships a UI update. This is the single highest-likelihood
ongoing maintenance item. When it breaks: open the site, inspect the input element,
update `findInput()` for that site.

### 4.10 Keep the disclaimer (in `options.html`) honest as behavior changes
The disclaimer text was wrong for a period — it claimed drafts are only read "when
you click Enhance," while the field-monitoring logic was already reading field content
continuously (before the event-driven fix in §4.6) and the on-page write-on-Apply
behavior wasn't mentioned at all. If field monitoring, read triggers, or write
triggers change again, update the disclaimer in the same change — don't let it drift.

### 4.11 Keyboard shortcut reliability is outside this codebase's control
The `Ctrl+Shift+E` shortcut (or whatever it's rebound to) depends on Chrome actually
receiving the keypress, which depends on nothing else on the system intercepting it
first — OS-level input-method/language-switch hotkeys are a common, real conflict
(e.g. `Alt+Shift` is a default Windows layout-switch combo). The toolbar badge flash
(`👁` in `background.js`'s `onCommand` listener) exists specifically as an isolated
diagnostic: if it never appears when the shortcut is pressed, the problem is upstream
of this extension entirely, and no code change here will fix it.

---

## 5. Known limitations (accepted, not bugs)

- **No CoT/few-shot passes, no revise loop** — audit detects the need, nothing acts on
  it yet. Explicitly deferred.
- **No eval harness** — quality is currently judged by manual testing only.
- **API keys stored in plaintext** in `chrome.storage.local` — inherent to the
  no-backend architecture; anything with access to this extension's storage can read
  them. Acceptable for personal use; would need real infrastructure to improve.
- **Keys don't sync across browser profiles/devices** — `chrome.storage.local` is
  per-profile by design.
- **No cancel/abort button** once a pipeline run starts.
- **Custom sites use a generic heuristic** (largest visible text field nearest the
  bottom of the page, or the currently-focused field) unless a manual CSS selector is
  provided — expect the first try on any new site to sometimes guess wrong.
- **Field-hugging position tracking was tried and reverted.** An earlier version
  positioned the widget relative to the input field (via `ResizeObserver` + scroll
  listeners), anchored just outside its corner. It was reverted back to a static,
  fixed viewport corner — the field-relative version had more moving parts across
  three independently-changing third-party layouts than was worth the risk for a
  prototype. The widget now always sits at a fixed bottom-right screen position.
- **If a site swaps out the input DOM node entirely** (e.g. starting a new
  conversation on some sites re-renders the input from scratch), the specific
  event listeners bound to the old node go stale until the page is reloaded, since
  the one-time discovery poll has already stopped by then.

---

## 6. Setup

1. Unzip the extension folder.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the
   folder.
3. Right-click the toolbar icon → **Options** (or Details → Extension options).
4. Enter a Gemini key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey))
   and a Groq key ([console.groq.com/keys](https://console.groq.com/keys)) — both free,
   no card required.
5. On `chrome://extensions`, confirm **Site access** is granted for
   `chatgpt.com`, `claude.ai`, and `gemini.google.com` individually (Chrome sometimes
   requires this to be granted per-site even when the manifest declares it).
6. Click the toolbar icon to open the side panel, or visit any of the three sites and
   type a draft prompt — the on-page icon should appear.

**After any manifest permission change** (adding a new host permission, `commands`,
`scripting`, etc.), do a full **Remove** + **Load unpacked** rather than the reload
button — Chrome does not always pick up new permission grants on a plain reload.

---

## 7. Full source code

### `manifest.json`
```json
{
  "manifest_version": 3,
  "name": "PromptAssist (Track A Prototype)",
  "version": "0.1.0",
  "description": "Audit-driven prompt enhancement prototype. Paste a draft prompt, get a structured, improved version.",
  "permissions": ["storage", "sidePanel", "scripting"],
  "host_permissions": [
    "https://generativelanguage.googleapis.com/*",
    "https://api.groq.com/*",
    "https://chatgpt.com/*",
    "https://gemini.google.com/*",
    "https://claude.ai/*"
  ],
  "optional_host_permissions": ["https://*/*"],
  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*", "https://gemini.google.com/*", "https://claude.ai/*"],
      "js": ["site-adapters.js", "floating-ui.js", "content-script.js"],
      "run_at": "document_idle"
    }
  ],
  "commands": {
    "enhance-and-inject": {
      "suggested_key": {
        "default": "Ctrl+Shift+E",
        "mac": "Command+Shift+E"
      },
      "description": "Enhance the draft prompt on this page"
    }
  },
  "action": {
    "default_title": "Open PromptAssist"
  },
  "background": {
    "service_worker": "background.js"
  },
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "options_page": "options.html",
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

### `background.js`
```javascript
// Service workers use importScripts (not ES module imports) to bring in the plain
// global-scope pipeline functions shared with the side panel.
importScripts("shared.js", "gemini.js", "groq.js", "pipeline.js");

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Ensures the side panel is enabled globally (not just on specific sites),
// since this is a standalone paste-in tool, not tied to any particular page.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    // setPanelBehavior + explicit onClicked handler can conflict on some Chrome
    // versions; the onClicked listener above is the fallback if this fails.
  });
});

// Sends a message to a tab's content script, and if that fails because the content
// script was never injected there (most commonly: the tab was already open before the
// extension was last reloaded — content scripts only auto-inject on page load), injects
// it on the fly and retries once. This is what makes the keyboard shortcut work without
// requiring the user to remember to refresh the page after every extension reload.
async function sendMessageWithRetry(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["site-adapters.js", "floating-ui.js", "content-script.js"],
      });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (retryErr) {
      throw new Error(`Could not reach the page — try refreshing the tab and running the shortcut again. (${retryErr.message || retryErr})`);
    }
  }
}

// Toolbar badge as a second, always-reliable status channel: it doesn't depend on the
// content script being reachable at all, so it still shows *something* went wrong even
// in the case sendMessageWithRetry itself can't recover from (e.g. a chrome:// tab).
function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// Shared by the enhance flow: read the draft, run the pipeline, produce a result.
// Runs over a persistent port (see below) rather than a one-shot message, because a
// fire-and-forget chrome.runtime.sendMessage does NOT reliably keep the service worker
// alive for the full duration of a multi-call pipeline — Chrome's docs say a service
// worker is killed after 30s of inactivity, and in practice a pending fetch() alone is
// not a guaranteed exemption (Chrome's own extensions team has acknowledged this is
// inconsistent). An open port IS one of the mechanisms Chrome explicitly keeps a worker
// alive for, which is what actually fixes the "stuck on Auditing forever" bug.
async function runEnhanceFlowOverPort(port, tabId) {
  const notify = (state, message) => {
    try {
      port.postMessage({ action: "showFloatingStatus", state, message });
    } catch {
      // port may have already disconnected (e.g. user navigated away) — nothing more to do
    }
  };

  setBadge("…", "#38bdf8");

  try {
    notify("loading");

    const draftResponse = await sendMessageWithRetry(tabId, { action: "getDraft" });
    if (!draftResponse?.ok || !draftResponse.text?.trim()) {
      notify("error", draftResponse?.error || "No draft text found in the input field.");
      setBadge("!", "#f87171");
      return;
    }

    const { geminiKey, groqKey } = await chrome.storage.local.get(["geminiKey", "groqKey"]);
    if (!geminiKey || !groqKey) {
      notify("error", "Missing API key(s) — add both in PromptAssist's options page.");
      setBadge("!", "#f87171");
      return;
    }

    const result = await runPipeline(draftResponse.text, { geminiKey, groqKey }, (stage) => notify("loading", stage));

    port.postMessage({
      action: "showReviewCard",
      data: {
        enhancedPrompt: result.enhancedPrompt,
        recap: result.recap,
        criticalIssuesFound: result.criticalIssuesFound,
        issues: result.critique?.issues || [],
      },
    });

    setBadge("", null);
  } catch (err) {
    notify("error", err.message || String(err));
    setBadge("!", "#f87171");
  } finally {
    try {
      port.disconnect();
    } catch {}
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "enhance-and-inject") return;

  // Independent of anything page-side — if this badge never appears when the shortcut
  // is pressed, Chrome isn't receiving the keypress at all (most likely an OS-level
  // hotkey conflict), which rules out everything else in this file as the cause.
  setBadge("👁", "#7dd3fc");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setBadge("!", "#f87171");
    return;
  }

  try {
    // Tells content-script.js to invoke the SAME port-based trigger used by clicking
    // the page icon — one code path for icon click, shortcut, and "Try again", already
    // proven to keep the service worker alive for the full pipeline duration.
    await sendMessageWithRetry(tab.id, { action: "runEnhanceFlow" });
    setTimeout(() => setBadge("", null), 1200);
  } catch (err) {
    setBadge("!", "#f87171");
  }
});

// Click on the persistent page icon opens this port (see content-script.js). Using
// onConnect + a long-lived port, not onMessage, is the deliberate fix for the service
// worker being killed mid-pipeline — see the comment on runEnhanceFlowOverPort above.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "promptassist-enhance") return;
  const tabId = port.sender?.tab?.id;
  if (!tabId) return;

  port.onMessage.addListener((msg) => {
    if (msg.action === "start") {
      runEnhanceFlowOverPort(port, tabId);
    }
  });
});

// If content-script.js detects that the on-page widget isn't actually visible despite
// being told to show (most likely a cosmetic ad/annoyance-blocker filter overriding it —
// see the conversation history on this), set a tooltip on the toolbar icon pointing the
// user at the side panel, which is immune to this since it isn't page content at all.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "widgetBlocked") {
    chrome.action.setTitle({
      tabId: sender.tab?.id,
      title: "PromptAssist: the on-page icon appears blocked (likely an ad/content blocker on this site). Click the toolbar icon to use the side panel instead — it isn't affected by this.",
    });
    sendResponse({ ok: true });
    return true;
  }
});
```

### `content-script.js`
```javascript
// Unconditional — proves whether Chrome executed this file at all, independent of
// anything else below (including the double-injection guard itself).
console.log("[PromptAssist] content-script.js was executed on this page.");

// Runs only on the domains declared in manifest.json's content_scripts. Bridges the
// side panel and background script to the page's actual input field via messages.
// Guarded against double-injection: background.js may inject this script on demand
// as a recovery path if the tab was already open before the extension last reloaded,
// which would otherwise register a second onMessage listener on top of the automatic one.
if (!window.__promptAssistContentScriptLoaded) {
  window.__promptAssistContentScriptLoaded = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "showFloatingStatus") {
      showFloatingStatus(message.state, message.message);
      sendResponse({ ok: true });
      return true;
    }

    if (message.action === "showReviewCard") {
      showReviewCard(message.data);
      sendResponse({ ok: true });
      return true;
    }

    if (message.action === "runEnhanceFlow") {
      // Used by the keyboard shortcut — runs the SAME port-based flow as clicking the
      // page icon. No confirm step: this goes straight to running the pipeline.
      if (typeof window.__paTriggerEnhanceFlow === "function") {
        window.__paTriggerEnhanceFlow();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Enhance trigger not available yet." });
      }
      return true;
    }

    const adapter = getCurrentAdapter();
    if (!adapter) {
      sendResponse({ ok: false, error: "No adapter registered for this site." });
      return true;
    }

    if (message.action === "getDraft") {
      const el = adapter.findInput();
      if (!el) {
        sendResponse({ ok: false, error: `Could not find ${adapter.label}'s input field — its UI may have changed since this selector was written.` });
        return true;
      }
      sendResponse({ ok: true, text: adapter.getText(el) });
      return true;
    }

    if (message.action === "injectText") {
      const el = adapter.findInput();
      if (!el) {
        sendResponse({ ok: false, error: `Could not find ${adapter.label}'s input field — its UI may have changed since this selector was written.` });
        return true;
      }
      adapter.setText(el, message.text);
      sendResponse({ ok: true });
      return true;
    }

    sendResponse({ ok: false, error: "Unknown action." });
    return true;
  });

  // Opens a persistent port to the service worker for the enhance flow, and routes
  // messages that come back over it to the appropriate floating-ui.js function. A port
  // (not a one-shot sendMessage) is required here — see the comment in background.js
  // on runEnhanceFlowOverPort for why.
  window.__paTriggerEnhanceFlow = function () {
    let reachedTerminalState = false;
    const port = chrome.runtime.connect({ name: "promptassist-enhance" });
    port.onMessage.addListener((msg) => {
      if (msg.action === "showFloatingStatus") {
        window.showFloatingStatus(msg.state, msg.message);
        if (msg.state !== "loading") reachedTerminalState = true;
      } else if (msg.action === "showReviewCard") {
        window.showReviewCard(msg.data);
        reachedTerminalState = true;
      }
    });
    port.onDisconnect.addListener(() => {
      if (!reachedTerminalState) {
        window.showFloatingStatus("error", "Lost connection to the extension mid-run — please try again.");
      }
    });
    port.postMessage({ action: "start" });
  };

  // FIELD MONITORING — deliberately event-driven, not blind polling. The extension
  // should only read the field's content in response to something the user actually
  // did (typing), not on a continuous timer regardless of intent. Two layers:
  //   1. Discovery: a cheap, low-frequency check for whether the input field EXISTS
  //      yet on the page (existence only — never reads its content). Stops entirely
  //      once found.
  //   2. Once found: real 'input' listener (fires on the user's own keystrokes) plus
  //      a MutationObserver as a fallback for React-driven fields that don't always
  //      fire native input events — both are reactions to an actual change, not a timer.
  function instrumentField(adapter, fieldEl) {
    let debounceTimer = null;
    const handleChange = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const text = adapter.getText(fieldEl).trim();
        if (text.length > 0) {
          showIdleTrigger();
          checkWidgetActuallyVisible();
        } else {
          hideIdleTrigger();
        }
      }, 300);
    };

    fieldEl.addEventListener("input", handleChange);
    new MutationObserver(handleChange).observe(fieldEl, { childList: true, characterData: true, subtree: true });
  }

  (function discoverField() {
    let instrumented = false;
    const discoveryInterval = setInterval(() => {
      if (instrumented) {
        clearInterval(discoveryInterval);
        return;
      }
      const adapter = getCurrentAdapter();
      if (!adapter) return;
      const fieldEl = adapter.findInput();
      if (!fieldEl) return; // field not rendered yet — existence check only, no content read

      instrumented = true;
      clearInterval(discoveryInterval);
      instrumentField(adapter, fieldEl);
    }, 1000);
  })();

  // One-time check: if the widget claims to be showing but its rendered geometry says
  // otherwise (something external — most likely an ad/annoyance blocker's cosmetic
  // filter — is overriding our styles), tell the background script so it can point the
  // user at the side panel instead, which isn't page content and can't be blocked this way.
  let widgetVisibilityChecked = false;
  function checkWidgetActuallyVisible() {
    if (widgetVisibilityChecked) return;
    const hostEl = document.getElementById("promptassist-floating-status-host");
    if (!hostEl) return;
    widgetVisibilityChecked = true;

    const rect = hostEl.getBoundingClientRect();
    const style = getComputedStyle(hostEl);
    const blocked = rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden";
    if (blocked) {
      chrome.runtime.sendMessage({ action: "widgetBlocked" }).catch(() => {});
    }
  }
}
```

### `site-adapters.js`
```javascript
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
```

### `floating-ui.js`
```javascript
// Floating UI. States:
//   - idle: small clickable icon shown whenever the input field has text
//   - running: expands into a card showing step-by-step pipeline progress
//   - card: the enhanced prompt + recap with Apply/Dismiss/Try again — nothing is
//     written to the page's input field until the user clicks Apply.
// No confirm step: clicking the icon (or the keyboard shortcut, or "Try again") goes
// straight to running the pipeline. The review card is the one real approval gate,
// since that's the point where something would actually get written to the page.
//
// Position: a fixed viewport corner (bottom-right), not tracking the input field.
// Field-relative tracking was tried and reverted — simpler and more reliable this way.
//
// Uses a shadow DOM so styles can't collide with (or be overridden by) the host page.
//
// IMPORTANT: built entirely with createElement/appendChild/textContent, NOT innerHTML.
// Sites that enforce a Trusted Types CSP throw on raw-string innerHTML assignment, even
// inside a shadow root — createElement-based construction isn't subject to that.
//
// Guarded against double-injection — see the comment in site-adapters.js for why.
if (!window.__promptAssistFloatingUILoaded) {
  window.__promptAssistFloatingUILoaded = true;

  const state = { host: null, root: null, hideTimeout: null, mode: "hidden" };
  const STEP_ORDER = ["audit", "structural", "critique"];
  const ICON_SIZE = 60;

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "style") e.style.cssText = v;
      else if (k === "text") e.textContent = v;
      else if (k === "class") e.className = v;
      else e.setAttribute(k, v);
    }
    for (const child of children) e.appendChild(child);
    return e;
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .badge {
      width: 44px; height: 44px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: #ffffff; border: 1.5px solid #e5e3de;
      box-shadow: 0 4px 16px rgba(5,55,46,0.15);
      position: relative;
    }
    .spinner {
      width: 18px; height: 18px; border-radius: 50%;
      border: 2.5px solid #e6f7f2; border-top-color: #15c39a;
      animation: pa-spin 0.7s linear infinite;
    }
    @keyframes pa-spin { to { transform: rotate(360deg); } }
    .icon { font-size: 18px; line-height: 1; }
    .tooltip {
      position: absolute; bottom: 52px; right: 0;
      background: #1a2e28; color: #ffffff; border: none;
      border-radius: 10px; padding: 8px 12px; font-size: 12px;
      max-width: 240px; display: none; white-space: normal;
      box-shadow: 0 4px 16px rgba(5,55,46,0.2);
    }
    .badge:hover .tooltip { display: block; }
    .card {
      display: none; flex-direction: column; gap: 12px;
      width: 320px; max-width: calc(100vw - 40px);
      max-height: min(400px, 70vh);
      position: absolute; bottom: 0; right: 0;
      background: #ffffff; border: 1px solid #e5e3de; border-radius: 16px;
      box-shadow: 0 12px 32px rgba(5,55,46,0.18);
      padding: 16px; color: #1a2e28; font-size: 13px; line-height: 1.5;
    }
    .card-header {
      font-size: 13px; font-weight: 700; color: #05372e;
      display: flex; justify-content: space-between; align-items: center;
    }
    .card-close { cursor: pointer; color: #9aa8a3; font-size: 15px; line-height: 1; padding: 2px 4px; }
    .card-close:hover { color: #1a2e28; }
    .card-recap-details { font-size: 12.5px; background: #f4f3f0; border-radius: 10px; padding: 2px 10px; }
    .card-recap-details summary {
      color: #0b8a6c; font-weight: 600; cursor: pointer; list-style: none; user-select: none; padding: 8px 0;
    }
    .card-recap-details summary::-webkit-details-marker { display: none; }
    .card-recap-details summary::before { content: "▸ "; }
    .card-recap-details[open] summary::before { content: "▾ "; }
    .card-recap-body { padding-bottom: 10px; color: #1a2e28; }
    .card-recap-note { margin-top: 6px; padding-top: 6px; border-top: 1px solid #e5e3de; color: #6b7280; font-size: 12px; }
    .card-text {
      background: #f4f3f0; border: 1px solid #e5e3de; border-radius: 10px;
      padding: 11px; max-height: 180px; overflow-y: auto;
      white-space: pre-wrap; font-size: 12.5px;
    }
    textarea.card-text {
      width: 100%; resize: vertical; color: #1a2e28; font-family: inherit;
      outline: none; min-height: 100px;
    }
    textarea.card-text:focus { border-color: #15c39a; box-shadow: 0 0 0 3px #e6f7f2; }
    .card-actions { display: flex; gap: 8px; }
    button { font-size: 13px; font-weight: 700; border: none; border-radius: 999px; padding: 9px 16px; cursor: pointer; flex: 1; }
    .btn-apply { background: #15c39a; color: #ffffff; }
    .btn-apply:hover { background: #0b8a6c; }
    .btn-dismiss { background: #ffffff; color: #0b8a6c; border: 1.5px solid #e5e3de; }
    .btn-dismiss:hover { background: #e6f7f2; border-color: #15c39a; }
    .step-list { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; }
    .step { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: #9aa8a3; transition: color 0.15s ease; }
    .step.active { color: #05372e; font-weight: 600; }
    .step.done { color: #0b8a6c; }
    .step-icon {
      width: 16px; height: 16px; flex-shrink: 0; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: bold;
    }
    .step.pending .step-icon { background: #e5e3de; }
    .step.active .step-icon { border: 2px solid #e6f7f2; border-top-color: #15c39a; animation: pa-spin 0.7s linear infinite; }
    .step.done .step-icon { background: #e6f7f2; color: #15c39a; }
    .step.done .step-icon::after { content: "✓"; }
  `;

  function ensureFloatingUI() {
    if (state.host) return state.root;

    state.host = document.createElement("div");
    state.host.id = "promptassist-floating-status-host";
    // Static, fixed viewport corner — deliberately not tracking the input field's
    // position (that was tried and reverted; simpler and more reliable this way).
    state.host.style.cssText = `position:fixed !important; bottom:24px !important; right:24px !important; width:${ICON_SIZE}px !important; height:${ICON_SIZE}px !important; overflow:visible !important; z-index:999999 !important; opacity:0; display:block !important; visibility:visible !important; transition:opacity 0.2s ease;`;
    document.documentElement.appendChild(state.host);

    state.root = state.host.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    styleEl.textContent = CSS; // .textContent, not .innerHTML — safe under Trusted Types

    const badge = el("div", { id: "badge", class: "badge" }, [
      el("div", { id: "spinner", class: "spinner", style: "display:none;" }),
      el("span", { id: "icon", class: "icon", style: "display:none;" }),
      el("div", { id: "tooltip", class: "tooltip" }),
    ]);

    const stepList = el(
      "div",
      { class: "step-list" },
      STEP_ORDER.map((key, i) =>
        el("div", { id: `step-${key}`, class: "step pending" }, [
          el("span", { class: "step-icon" }),
          el("span", { text: ["Audit", "Structural pass", "Self-critique"][i] }),
        ])
      )
    );

    const loadingCard = el("div", { id: "loading-card", class: "card" }, [
      el("div", { class: "card-header" }, [el("span", { text: "Enhancing your prompt…" })]),
      stepList,
    ]);

    const reviewText = document.createElement("textarea");
    reviewText.id = "review-text";
    reviewText.className = "card-text";

    const reviewCard = el("div", { id: "review-card", class: "card" }, [
      el("div", { class: "card-header" }, [
        el("span", { text: "PromptAssist suggestion" }),
        el("span", { id: "review-close", class: "card-close", text: "✕" }),
      ]),
      el("details", { class: "card-recap-details" }, [
        el("summary", { text: "Recap — what changed" }),
        el("div", { class: "card-recap-body" }, [
          el("div", { id: "review-recap" }),
          el("div", { id: "review-note", class: "card-recap-note", style: "display:none;" }),
        ]),
      ]),
      reviewText,
      el("div", { class: "card-actions" }, [
        el("button", { id: "review-dismiss", class: "btn-dismiss", text: "Dismiss" }),
        el("button", { id: "review-tryagain", class: "btn-dismiss", text: "Try again" }),
        el("button", { id: "review-apply", class: "btn-apply", text: "Apply to page" }),
      ]),
    ]);

    state.root.appendChild(styleEl);
    state.root.appendChild(badge);
    state.root.appendChild(loadingCard);
    state.root.appendChild(reviewCard);

    return state.root;
  }

  function hideAllPanels(root) {
    root.getElementById("loading-card").style.display = "none";
    root.getElementById("review-card").style.display = "none";
  }

  function showIdleTrigger() {
    if (state.mode === "running" || state.mode === "card") return;
    const root = ensureFloatingUI();
    state.mode = "idle";
    clearTimeout(state.hideTimeout);
    state.host.style.opacity = "1";

    hideAllPanels(root);
    const badge = root.getElementById("badge");
    badge.style.display = "flex";
    badge.style.cursor = "pointer";

    const spinner = root.getElementById("spinner");
    const icon = root.getElementById("icon");
    const tooltip = root.getElementById("tooltip");

    spinner.style.display = "none";
    icon.style.display = "block";
    icon.textContent = "✧";
    icon.style.color = "#15c39a";
    tooltip.textContent = "Click to enhance this prompt with PromptAssist";

    // No confirm step — clicking runs the pipeline directly. The review card (after
    // the pipeline completes) is the actual approval gate, since that's the point
    // where something would get written to the page.
    badge.onclick = () => {
      if (typeof window.__paTriggerEnhanceFlow === "function") {
        window.__paTriggerEnhanceFlow();
      } else {
        showFloatingStatus("error", "Internal error: enhance trigger not available. Try reloading the page.");
      }
    };
  }

  function hideIdleTrigger() {
    if (state.mode !== "idle") return;
    state.mode = "hidden";
    if (state.host) state.host.style.opacity = "0";
  }

  function renderLoadingSteps(currentStepKey) {
    const root = ensureFloatingUI();
    const currentIndex = currentStepKey ? STEP_ORDER.indexOf(currentStepKey) : -1;
    STEP_ORDER.forEach((key, i) => {
      const stepEl = root.getElementById(`step-${key}`);
      if (!stepEl) return;
      stepEl.className = "step " + (i < currentIndex ? "done" : i === currentIndex ? "active" : "pending");
    });
  }

  /**
   * @param {"loading"|"success"|"error"} status
   * @param {{step: string, label: string}|string} [message] - structured stage object
   *   for "loading" (renders the step list), plain string for "success"/"error".
   */
  function showFloatingStatus(status, message) {
    const root = ensureFloatingUI();
    clearTimeout(state.hideTimeout);
    state.host.style.opacity = "1";

    if (status === "loading") {
      state.mode = "running";
      hideAllPanels(root);
      root.getElementById("badge").style.display = "none";
      root.getElementById("loading-card").style.display = "flex";
      renderLoadingSteps(message && message.step);
      return;
    }

    // success / error — brief badge + tooltip, not a card (terminal, short-lived)
    state.mode = "running";
    hideAllPanels(root);
    const badge = root.getElementById("badge");
    badge.style.display = "flex";
    badge.style.cursor = "default";
    badge.onclick = null;

    const spinner = root.getElementById("spinner");
    const icon = root.getElementById("icon");
    const tooltip = root.getElementById("tooltip");
    spinner.style.display = "none";
    icon.style.display = "block";

    if (status === "success") {
      icon.textContent = "✓";
      icon.style.color = "#15c39a";
      tooltip.textContent = message || "Applied.";
      state.hideTimeout = setTimeout(hideFloatingStatus, 2000);
    } else if (status === "error") {
      icon.textContent = "✕";
      icon.style.color = "#e0554f";
      tooltip.textContent = message || "Something went wrong.";
      state.hideTimeout = setTimeout(hideFloatingStatus, 6000);
    }
  }

  function hideFloatingStatus() {
    state.mode = "hidden";
    if (state.host) state.host.style.opacity = "0";
  }

  function showReviewCard(data) {
    const root = ensureFloatingUI();
    state.mode = "card";
    clearTimeout(state.hideTimeout);
    state.host.style.opacity = "1";

    hideAllPanels(root);
    root.getElementById("badge").style.display = "none";
    const card = root.getElementById("review-card");
    card.style.display = "flex";

    root.getElementById("review-recap").textContent = data.recap || "";
    root.getElementById("review-text").value = data.enhancedPrompt || "";

    const noteEl = root.getElementById("review-note");
    if (data.criticalIssuesFound) {
      noteEl.style.display = "block";
      noteEl.textContent = `Self-critique noted: ${(data.issues || []).join("; ")}`;
    } else {
      noteEl.style.display = "none";
    }

    const applyBtn = root.getElementById("review-apply");
    const dismissBtn = root.getElementById("review-dismiss");
    const closeBtn = root.getElementById("review-close");
    const tryAgainBtn = root.getElementById("review-tryagain");

    applyBtn.onclick = () => {
      const editedText = root.getElementById("review-text").value;
      const adapter = typeof window.getCurrentAdapter === "function" ? window.getCurrentAdapter() : null;
      const targetEl = adapter && adapter.findInput();
      if (adapter && targetEl) {
        adapter.setText(targetEl, editedText);
        hideReviewCard();
        showFloatingStatus("success", "Applied to the page.");
      } else {
        showFloatingStatus("error", "Could not find the input field to apply to — the page's UI may have changed.");
      }
    };
    dismissBtn.onclick = hideReviewCard;
    closeBtn.onclick = hideReviewCard;
    tryAgainBtn.onclick = () => {
      // Re-runs the whole flow (re-reads the field, which still has the original draft
      // since Apply hasn't happened) rather than reusing the previous result.
      if (typeof window.__paTriggerEnhanceFlow === "function") {
        window.__paTriggerEnhanceFlow();
      }
    };
  }

  function hideReviewCard() {
    if (!state.root) return;
    state.root.getElementById("review-card").style.display = "none";
    state.mode = "hidden";
    hideFloatingStatus();
  }

  window.showFloatingStatus = showFloatingStatus;
  window.showReviewCard = showReviewCard;
  window.showIdleTrigger = showIdleTrigger;
  window.hideIdleTrigger = hideIdleTrigger;
}
```

### `shared.js`
```javascript
/**
 * Fetch with exponential backoff retry on 429 (rate limit) responses.
 * PRD requirement: retry with exponential backoff on 429s for both providers.
 * Shared between gemini.js and groq.js — load this script before either.
 */
async function fetchWithRetry(url, options, maxRetries = 3) {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, options);
    if (res.status !== 429 || attempt >= maxRetries) {
      if (!res.ok && res.status !== 429) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Request failed (${res.status}): ${errText.slice(0, 200)}`);
      }
      return res;
    }
    const delayMs = 500 * Math.pow(2, attempt);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempt += 1;
  }
}
```

### `gemini.js`
```javascript
// Thin wrapper around the Gemini API for calls that need constrained JSON output
// (audit, critique-check). Model pinned 2026-08-15 to gemini-3.5-flash after
// gemini-2.5-flash was retired for new users ahead of its official Oct 16, 2026
// shutdown date — Gemini retires free-tier models on short notice, re-verify at
// https://ai.google.dev/gemini-api/docs/models if this call starts 404ing again.
const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * Calls Gemini with a system instruction + user content, constrained to a JSON schema.
 * @param {string} apiKey
 * @param {string} systemInstruction
 * @param {string} userContent
 * @param {object} responseSchema - Gemini's OpenAPI-subset schema object
 * @returns {Promise<object>} parsed JSON matching responseSchema
 */
async function callGeminiJSON(apiKey, systemInstruction, userContent, responseSchema) {
  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: userContent }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.2,
    },
  };

  const res = await fetchWithRetry(GEMINI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey, // header, not ?key= query param — keeps the key out of URLs (Network tab, history, referrers)
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned no content — check API key and model availability.");
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Gemini response was not valid JSON: ${text.slice(0, 200)}`);
  }
}
```

### `groq.js`
```javascript
// Thin wrapper around Groq's OpenAI-compatible API for generation calls (structural
// pass, CoT pass, few-shot pass, revise). Model updated 2026-08-16 to openai/gpt-oss-120b
// after llama-3.3-70b-versatile was decommissioned by Groq on that date — this is
// Groq's own recommended replacement (free tier: 1,000 req/day, 8,000 TPM). Re-verify
// at https://console.groq.com/docs/models if this call starts failing.
const GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Calls Groq for a JSON-structured generation response.
 * Groq's JSON mode is a "best-effort" contract (unlike Gemini's schema-enforced one),
 * so the system prompt must spell out the exact shape expected, and callers should
 * validate the parsed result rather than trust it blindly.
 * @param {string} apiKey
 * @param {string} systemPrompt
 * @param {string} userContent
 * @returns {Promise<object>} parsed JSON
 */
async function callGroqJSON(apiKey, systemPrompt, userContent) {
  const body = {
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
    temperature: 0.4,
    // gpt-oss is a reasoning model. "low" effort suits a straightforward rewrite task
    // (faster, and reduces how much reasoning text there is to potentially leak).
    // include_reasoning:false is the correct param for gpt-oss specifically — it does
    // NOT support reasoning_format (that's for other reasoning models on Groq).
    reasoning_effort: "low",
    include_reasoning: false,
  };

  const res = await fetchWithRetry(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  // Documented gpt-oss quirk: the actual answer sometimes ends up in a reasoning
  // field instead of content — fall back to those if content is empty.
  let text = message?.content || message?.reasoning_content || message?.reasoning;
  if (!text) {
    throw new Error("Groq returned no content — check API key and model availability.");
  }

  // Another documented quirk: leaked internal control tokens like "<|return|>" can
  // appear in the text — strip anything matching that pattern before parsing.
  text = text.replace(/<\|[^|]*\|>/g, "").trim();

  try {
    return JSON.parse(text);
  } catch (e) {
    // json_object mode occasionally still wraps the JSON in surrounding prose —
    // try to salvage the first {...} block before giving up entirely.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through to the error below
      }
    }
    throw new Error(`Groq response was not valid JSON: ${text.slice(0, 200)}`);
  }
}
```

### `pipeline.js`
```javascript
// PIPELINE — CURRENT SCOPE (step 2 of the build sequence):
//   audit (Gemini) -> structural pass (Groq) -> one critique check (Gemini)
// NOT YET WIRED: CoT pass, few-shot pass, revise+recheck loop. Those are the next
// build increments. runPipeline() below returns a `criticalIssuesFound` flag so the
// UI can surface an honest "critique flagged issues, but auto-revise isn't wired up
// yet" state instead of silently hiding a failed check.

const AUDIT_SCHEMA = {
  type: "OBJECT",
  properties: {
    anatomy: {
      type: "OBJECT",
      properties: {
        instruction: { type: "STRING", enum: ["present", "weak", "missing"] },
        context: { type: "STRING", enum: ["present", "weak", "missing"] },
        input_data: { type: "STRING", enum: ["present", "weak", "missing", "not_applicable"] },
        output_indicator: { type: "STRING", enum: ["present", "weak", "missing"] },
      },
      required: ["instruction", "context", "input_data", "output_indicator"],
    },
    task_domain: {
      type: "STRING",
      enum: ["creative", "factual_qa", "analysis_reasoning", "coding", "summarization", "extraction", "other"],
    },
    complexity: { type: "STRING", enum: ["single_step", "multi_part"] },
    technique_flags: {
      type: "OBJECT",
      properties: {
        role_assignment: { type: "BOOLEAN" },
        few_shot_examples: { type: "BOOLEAN" },
        chain_of_thought: { type: "BOOLEAN" },
        explicit_structure: { type: "BOOLEAN" },
        grounding_permission: { type: "BOOLEAN" },
      },
      required: ["role_assignment", "few_shot_examples", "chain_of_thought", "explicit_structure", "grounding_permission"],
    },
    confidence: { type: "NUMBER" },
    intent: {
      type: "OBJECT",
      properties: {
        goal: { type: "STRING" },
        register: { type: "STRING" },
        audience: { type: "STRING" },
      },
      required: ["goal", "register", "audience"],
    },
  },
  required: ["anatomy", "task_domain", "complexity", "technique_flags", "confidence", "intent"],
};

const AUDIT_SYSTEM_PROMPT = `You are the audit step in a prompt-enhancement pipeline. Given a user's draft prompt, assess it structurally. Do not rewrite it — only assess it.

Rules:
- For instruction, context, output_indicator: mark "present" if clearly there, "weak" if present but vague/thin, "missing" if absent.
- For input_data: same three options, PLUS "not_applicable" if this kind of prompt genuinely has no separate data block (many prompts don't — this is not a gap).
- task_domain: pick the single best-fitting category.
- complexity: "multi_part" only if the prompt asks for genuinely multiple distinct things; otherwise "single_step".
- technique_flags: flag a technique TRUE only if the specific gap it addresses is genuinely present in THIS prompt. Do not flag by default or "to be safe" — over-flagging is a named failure mode. A short, clear, well-formed prompt should have most or all flags false.
- confidence: calibrated 0.0-1.0 reflecting how confident you are in this assessment overall.
- intent: infer the user's actual underlying goal, the register/tone implied, and the apparent audience, from the draft as written.

Return only the JSON matching the provided schema.`;

const STRUCTURAL_SYSTEM_PROMPT = `You are the structural enhancement pass in a prompt-enhancement pipeline. You receive a draft prompt and an audit of it. Apply ONLY the following, and only where the audit indicates a genuine gap:
- Fill in any anatomy element marked "weak" or "missing" (instruction, context, output_indicator; input_data only if not "not_applicable").
- If technique_flags.role_assignment is true, prepend an appropriate role/persona line.
- If technique_flags.explicit_structure is true, organize the prompt with clear structure (e.g. labelled sections).
- If technique_flags.grounding_permission is true, append a line giving the model permission to say "I don't know" or ask for clarification rather than guess.
- Do NOT add chain-of-thought framing or few-shot examples — those are handled by separate passes.
- Do NOT change anything the audit marked "present" or add anything not flagged.
- Preserve the user's original intent, goal, register, and audience (given in the audit's intent field) — you are structuring their request, not replacing it.

Return a JSON object with exactly two fields:
{
  "enhanced_prompt": "the improved prompt text",
  "recap": "1-2 plain-language sentences on what changed and why, e.g. 'Added a clear output format so the response comes back structured the way you'll actually use it.' If nothing needed changing, say so briefly."
}`;

const CRITIQUE_SCHEMA = {
  type: "OBJECT",
  properties: {
    passed: { type: "BOOLEAN" },
    issues: {
      type: "ARRAY",
      items: { type: "STRING" },
    },
  },
  required: ["passed", "issues"],
};

const CRITIQUE_SYSTEM_PROMPT = `You are the self-critique step in a prompt-enhancement pipeline. You receive an enhanced prompt and the audit findings that were supposed to drive its enhancement. Verify, as a checklist:
1. Every anatomy element the audit marked "weak" or "missing" now reads as present in the enhanced prompt.
2. Every technique flagged true in the audit was actually applied.
3. No technique flagged false was added anyway (over-application is a failure).

Return JSON: { "passed": true/false, "issues": ["short description of each failed checklist item, if any"] }. If everything checks out, passed=true and issues=[].`;

async function auditPrompt(draftPrompt, geminiKey) {
  return callGeminiJSON(geminiKey, AUDIT_SYSTEM_PROMPT, draftPrompt, AUDIT_SCHEMA);
}

async function structuralPass(draftPrompt, auditResult, groqKey) {
  const userContent = JSON.stringify({ draft_prompt: draftPrompt, audit: auditResult });
  return callGroqJSON(groqKey, STRUCTURAL_SYSTEM_PROMPT, userContent);
}

async function critiqueCheck(currentPrompt, auditResult, geminiKey) {
  const userContent = JSON.stringify({ enhanced_prompt: currentPrompt, audit: auditResult });
  return callGeminiJSON(geminiKey, CRITIQUE_SYSTEM_PROMPT, userContent, CRITIQUE_SCHEMA);
}

/**
 * Runs the current pipeline scope: audit -> structural -> one critique check.
 * @param {string} draftPrompt
 * @param {{geminiKey: string, groqKey: string}} keys
 * @param {(stage: {step: string, label: string}) => void} onProgress
 */
async function runPipeline(draftPrompt, keys, onProgress = () => {}) {
  onProgress({ step: "audit", label: "Auditing your draft…" });
  const audit = await auditPrompt(draftPrompt, keys.geminiKey);

  onProgress({ step: "structural", label: "Applying structural improvements…" });
  const structural = await structuralPass(draftPrompt, audit, keys.groqKey);

  onProgress({ step: "critique", label: "Running self-critique…" });
  const critique = await critiqueCheck(structural.enhanced_prompt, audit, keys.geminiKey);

  return {
    enhancedPrompt: structural.enhanced_prompt,
    recap: structural.recap,
    audit,
    critique,
    criticalIssuesFound: critique.passed === false,
  };
}
```

### `sidepanel.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>PromptAssist</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="wrap">
    <div>
      <h1>PromptAssist <span class="dim">· prototype</span></h1>
      <p class="subtitle">Paste a rough draft prompt. Get an audited, structurally improved version.</p>
    </div>

    <div id="keys-warning" class="status error"></div>
    <div id="site-status" class="status success" style="display:none;"></div>

    <!-- Screen 1: input -->
    <div id="screen-input">
      <div class="field">
        <label for="draft-input">Draft prompt</label>
        <textarea id="draft-input" placeholder="e.g. write me something about recursion for my assignment, keep it simple"></textarea>
      </div>
      <div class="row" style="margin-top: 10px;">
        <button id="enhance-btn" class="primary">Enhance</button>
        <button id="clear-btn" class="secondary">Clear</button>
        <button id="read-page-btn" class="secondary" style="display:none;">Read from page</button>
      </div>
    </div>

    <!-- Screen 2: loading -->
    <div id="screen-loading" class="loading">
      <div class="step-list-vertical" id="loading-step-list"></div>
    </div>

    <!-- Screen 3: result -->
    <div id="screen-result" class="result">
      <div class="field">
        <label for="result-box">Enhanced prompt</label>
        <textarea id="result-box" class="result-box" rows="10"></textarea>
      </div>

      <details class="recap">
        <summary>▸ Recap — what changed</summary>
        <div class="recap-body" id="recap-body">—</div>
      </details>

      <div class="row">
        <button id="copy-btn" class="primary">Copy</button>
        <button id="send-page-btn" class="primary" style="display:none;">Send to page</button>
        <button id="back-btn" class="secondary">Start over</button>
      </div>
    </div>

    <div class="footer-note">Draft prompt text is sent to Gemini/Groq only when you click Enhance. On supported AI-tool pages, PromptAssist also reads the field as you type (to show its icon) and writes to it on Apply.</div>
  </div>

  <script src="shared.js"></script>
  <script src="gemini.js"></script>
  <script src="groq.js"></script>
  <script src="pipeline.js"></script>
  <script src="sidepanel.js"></script>
</body>
</html>
```

### `sidepanel.js`
```javascript
// Side panel logic: screen transitions (input -> loading -> result), key presence
// check, site detection (built-in + custom sites), and running the real pipeline.

const screenInput = document.getElementById("screen-input");
const screenLoading = document.getElementById("screen-loading");
const screenResult = document.getElementById("screen-result");
const keysWarning = document.getElementById("keys-warning");
const siteStatus = document.getElementById("site-status");

const draftInput = document.getElementById("draft-input");
const enhanceBtn = document.getElementById("enhance-btn");
const clearBtn = document.getElementById("clear-btn");
const readPageBtn = document.getElementById("read-page-btn");
const copyBtn = document.getElementById("copy-btn");
const sendPageBtn = document.getElementById("send-page-btn");
const backBtn = document.getElementById("back-btn");
const resultBox = document.getElementById("result-box");
const recapBody = document.getElementById("recap-body");

const BUILT_IN_HOSTS = ["chatgpt.com", "gemini.google.com", "claude.ai"];
const STEP_LABELS = { audit: "Audit", structural: "Structural pass", critique: "Self-critique" };
let lastActiveStepRow = null;

function resetLoadingSteps() {
  document.getElementById("loading-step-list").textContent = "";
  lastActiveStepRow = null;
}

// Progressive reveal: only the step currently running is shown, appended below the
// previous one, which converts from spinner to checkmark at that moment.
function advanceToStep(stepKey) {
  if (lastActiveStepRow) lastActiveStepRow.className = "loading-step done";

  const row = document.createElement("div");
  row.className = "loading-step active";
  const icon = document.createElement("span");
  icon.className = "loading-step-icon";
  const label = document.createElement("span");
  label.textContent = STEP_LABELS[stepKey] || stepKey;
  row.appendChild(icon);
  row.appendChild(label);

  document.getElementById("loading-step-list").appendChild(row);
  lastActiveStepRow = row;
}

function finishLoadingSteps() {
  if (lastActiveStepRow) lastActiveStepRow.className = "loading-step done";
}

// Detects whether the active tab is a supported site — either of the three built-in
// ones, or a custom site the user has added via the options page.
async function detectActiveSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    const hostname = new URL(tab.url).hostname;
    if (BUILT_IN_HOSTS.includes(hostname)) return { tabId: tab.id, hostname };
    const { customSites = [] } = await chrome.storage.local.get(["customSites"]);
    if (customSites.some((s) => s.hostname === hostname)) return { tabId: tab.id, hostname };
    return null;
  } catch {
    return null;
  }
}

async function refreshSiteStatus() {
  const site = await detectActiveSite();
  if (site) {
    siteStatus.textContent = "";
    const dot = document.createElement("span");
    dot.style.cssText = "display:inline-block; width:7px; height:7px; border-radius:50%; background:#15c39a; margin-right:6px;";
    siteStatus.appendChild(dot);
    siteStatus.appendChild(document.createTextNode(`Connected: ${site.hostname} — you can read the draft from the page and send the result back to it.`));
    siteStatus.style.display = "flex";
    siteStatus.style.alignItems = "center";
    readPageBtn.style.display = "inline-block";
    sendPageBtn.style.display = "inline-block";
  } else {
    siteStatus.style.display = "none";
    readPageBtn.style.display = "none";
    sendPageBtn.style.display = "none";
  }
  return site;
}

function showScreen(name) {
  screenInput.style.display = name === "input" ? "block" : "none";
  screenLoading.classList.toggle("visible", name === "loading");
  screenResult.classList.toggle("visible", name === "result");
}

async function getStoredKeys() {
  const { geminiKey, groqKey } = await chrome.storage.local.get(["geminiKey", "groqKey"]);
  return { geminiKey, groqKey };
}

async function checkKeysPresent() {
  const { geminiKey, groqKey } = await getStoredKeys();
  if (!geminiKey || !groqKey) {
    keysWarning.textContent = "Missing API key(s). Add both a Gemini and a Groq key in the extension's options page before running.";
    keysWarning.classList.add("visible");
    enhanceBtn.disabled = true;
    return false;
  }
  keysWarning.classList.remove("visible");
  enhanceBtn.disabled = false;
  return true;
}

enhanceBtn.addEventListener("click", async () => {
  const draft = draftInput.value.trim();
  if (!draft) {
    draftInput.focus();
    return;
  }

  const keysOk = await checkKeysPresent();
  if (!keysOk) return;

  const keys = await getStoredKeys();

  showScreen("loading");
  resetLoadingSteps();

  try {
    const result = await runPipeline(draft, keys, (stage) => {
      advanceToStep(stage.step);
    });
    finishLoadingSteps(); // critique never gets its own "next step" to trigger the checkmark
    await new Promise((r) => setTimeout(r, 350)); // let the final checkmark actually be seen

    resultBox.value = result.enhancedPrompt;

    // Current pipeline scope has no revise/recheck loop yet — a failed critique
    // check is surfaced honestly rather than silently swallowed.
    if (result.criticalIssuesFound) {
      recapBody.textContent =
        `${result.recap}\n\n⚠ Self-critique flagged issues that weren't auto-corrected yet ` +
        `(revise loop isn't wired up in this build): ${result.critique.issues.join("; ")}`;
    } else {
      recapBody.textContent = result.recap;
    }

    showScreen("result");
  } catch (err) {
    showScreen("input");
    keysWarning.textContent = `Something went wrong: ${err.message || err}`;
    keysWarning.classList.add("visible");
  }
});

clearBtn.addEventListener("click", () => {
  draftInput.value = "";
  draftInput.focus();
});

readPageBtn.addEventListener("click", async () => {
  const site = await detectActiveSite();
  if (!site) {
    keysWarning.textContent = "No supported AI tool detected on the active tab.";
    keysWarning.classList.add("visible");
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(site.tabId, { action: "getDraft" });
    if (!response?.ok) throw new Error(response?.error || "Unknown error reading the page.");
    draftInput.value = response.text;
    keysWarning.classList.remove("visible");
  } catch (err) {
    keysWarning.textContent = `Couldn't read from the page: ${err.message || err}. You can still paste manually.`;
    keysWarning.classList.add("visible");
  }
});

sendPageBtn.addEventListener("click", async () => {
  const site = await detectActiveSite();
  if (!site) {
    keysWarning.textContent = "No supported AI tool detected on the active tab.";
    keysWarning.classList.add("visible");
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(site.tabId, { action: "injectText", text: resultBox.value });
    if (!response?.ok) throw new Error(response?.error || "Unknown error writing to the page.");
    const original = sendPageBtn.textContent;
    sendPageBtn.textContent = "Sent";
    setTimeout(() => (sendPageBtn.textContent = original), 1200);
  } catch (err) {
    keysWarning.textContent = `Couldn't send to the page: ${err.message || err}. Use Copy instead.`;
    keysWarning.classList.add("visible");
  }
});

backBtn.addEventListener("click", () => {
  showScreen("input");
});

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(resultBox.value);
  const original = copyBtn.textContent;
  copyBtn.textContent = "Copied";
  setTimeout(() => (copyBtn.textContent = original), 1200);
});

// Re-check keys whenever the panel gains focus, so enabling the button doesn't
// require a full reload after the user saves keys in the options page.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    checkKeysPresent();
    refreshSiteStatus();
  }
});

checkKeysPresent();
refreshSiteStatus();
showScreen("input");
```

### `options.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>PromptAssist — Settings</title>
  <link rel="stylesheet" href="styles.css" />
  <style>
    body { max-width: 480px; margin: 0 auto; }
  </style>
</head>
<body>
  <div class="wrap">
    <div>
      <h1>PromptAssist <span class="dim">· settings</span></h1>
      <p class="subtitle">API keys are stored only in this browser's local storage. They are never sent anywhere except directly to Gemini or Groq when you run the tool.</p>
    </div>

    <div class="field">
      <label for="gemini-key">Gemini API key</label>
      <input type="password" id="gemini-key" placeholder="AIza…" autocomplete="off" />
      <div id="gemini-key-hint" class="hint"></div>
    </div>

    <div class="field">
      <label for="groq-key">Groq API key</label>
      <input type="password" id="groq-key" placeholder="gsk_…" autocomplete="off" />
      <div id="groq-key-hint" class="hint"></div>
    </div>

    <div class="row">
      <button id="save-btn" class="primary">Save</button>
      <button id="toggle-visibility-btn" class="secondary">Show keys</button>
    </div>

    <div id="save-status" class="status success">Saved.</div>

    <div class="field" style="margin-top: 8px;">
      <label>Custom sites</label>
      <p class="subtitle" style="margin: 0 0 10px 0;">
        Add another AI tool site beyond the three built in. PromptAssist can't verify a
        selector for a site it's never seen — it uses a best-effort generic guess (largest
        visible text field near the bottom of the page) unless you provide a specific CSS
        selector below.
      </p>
      <div class="row">
        <input type="text" id="new-site-input" placeholder="e.g. poe.com" />
        <button id="add-site-btn" class="secondary">Add site</button>
      </div>
      <div id="custom-sites-list" class="custom-sites-list" style="margin-top: 10px;"></div>
    </div>

    <div class="disclaimer">
      Draft prompt text is sent to Gemini and/or Groq only when you click Enhance (in the
      side panel or on the page). On supported AI-tool pages, PromptAssist also reads the
      input field's text when you type into it (only to show its icon and offer to help —
      nothing is sent anywhere at that point) and writes the enhanced prompt into that
      field if you click "Apply to page." Nothing else is collected, logged, or
      transmitted by this extension.
    </div>
  </div>

  <script src="options.js"></script>
</body>
</html>
```

### `options.js`
```javascript
const geminiKeyInput = document.getElementById("gemini-key");
const groqKeyInput = document.getElementById("groq-key");
const geminiKeyHint = document.getElementById("gemini-key-hint");
const groqKeyHint = document.getElementById("groq-key-hint");
const saveBtn = document.getElementById("save-btn");
const toggleBtn = document.getElementById("toggle-visibility-btn");
const saveStatus = document.getElementById("save-status");
const newSiteInput = document.getElementById("new-site-input");
const addSiteBtn = document.getElementById("add-site-btn");
const customSitesList = document.getElementById("custom-sites-list");

async function loadKeys() {
  const { geminiKey, groqKey } = await chrome.storage.local.get(["geminiKey", "groqKey"]);
  if (geminiKey) geminiKeyInput.value = geminiKey;
  if (groqKey) groqKeyInput.value = groqKey;
  checkKeyFormat(geminiKeyInput, geminiKeyHint, "AIza", "Gemini");
  checkKeyFormat(groqKeyInput, groqKeyHint, "gsk_", "Groq");
}

// Lightweight sanity check only — not a real validation call. Just catches an obvious
// paste mistake (wrong key pasted, truncated copy, etc.) before it causes a confusing
// failure the first time the pipeline actually runs.
function checkKeyFormat(input, hintEl, expectedPrefix, label) {
  const value = input.value.trim();
  if (!value) {
    hintEl.classList.remove("visible");
    return;
  }
  if (value.startsWith(expectedPrefix)) {
    hintEl.textContent = `Looks like a ${label} key.`;
    hintEl.className = "hint visible ok";
  } else {
    hintEl.textContent = `Doesn't look like a typical ${label} key (usually starts with "${expectedPrefix}") — double-check it before saving.`;
    hintEl.className = "hint visible warn";
  }
}

geminiKeyInput.addEventListener("input", () => checkKeyFormat(geminiKeyInput, geminiKeyHint, "AIza", "Gemini"));
groqKeyInput.addEventListener("input", () => checkKeyFormat(groqKeyInput, groqKeyHint, "gsk_", "Groq"));

saveBtn.addEventListener("click", async () => {
  const geminiKey = geminiKeyInput.value.trim();
  const groqKey = groqKeyInput.value.trim();

  await chrome.storage.local.set({ geminiKey, groqKey });

  saveStatus.textContent = "Saved.";
  saveStatus.classList.add("visible");
  setTimeout(() => saveStatus.classList.remove("visible"), 2000);
});

toggleBtn.addEventListener("click", () => {
  const showing = geminiKeyInput.type === "text";
  const nextType = showing ? "password" : "text";
  geminiKeyInput.type = nextType;
  groqKeyInput.type = nextType;
  toggleBtn.textContent = showing ? "Show keys" : "Hide keys";
});

// CUSTOM SITES — user-initiated only. Adding a site triggers Chrome's own native
// permission prompt for that exact origin (chrome.permissions.request), shown only
// because the user just clicked "Add" — nothing ambient, nothing on sites never asked
// about. Once granted, we dynamically register the content scripts for it so it works
// immediately without needing a full extension reload.
function normalizeHostname(raw) {
  return raw
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

async function getCustomSites() {
  const { customSites = [] } = await chrome.storage.local.get(["customSites"]);
  return customSites;
}

async function renderCustomSites() {
  const sites = await getCustomSites();
  customSitesList.textContent = "";

  if (sites.length === 0) {
    const empty = document.createElement("p");
    empty.className = "subtitle";
    empty.style.margin = "0";
    empty.textContent = "No custom sites added yet.";
    customSitesList.appendChild(empty);
    return;
  }

  for (const site of sites) {
    const row = document.createElement("div");
    row.className = "custom-site-row";

    const hostnameEl = document.createElement("span");
    hostnameEl.className = "hostname";
    hostnameEl.textContent = site.hostname;

    const selectorInput = document.createElement("input");
    selectorInput.type = "text";
    selectorInput.placeholder = "optional CSS selector override";
    selectorInput.value = site.selector || "";
    selectorInput.addEventListener("change", async () => {
      const sitesNow = await getCustomSites();
      const match = sitesNow.find((s) => s.hostname === site.hostname);
      if (match) {
        match.selector = selectorInput.value.trim();
        await chrome.storage.local.set({ customSites: sitesNow });
      }
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "secondary";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      await removeCustomSite(site.hostname);
      renderCustomSites();
    });

    row.appendChild(hostnameEl);
    row.appendChild(selectorInput);
    row.appendChild(removeBtn);
    customSitesList.appendChild(row);
  }
}

async function addCustomSite() {
  const hostname = normalizeHostname(newSiteInput.value);
  if (!hostname || !hostname.includes(".")) {
    saveStatus.textContent = "Enter a valid domain, e.g. poe.com";
    saveStatus.className = "status error visible";
    setTimeout(() => (saveStatus.className = "status success"), 3000);
    return;
  }

  const existing = await getCustomSites();
  if (existing.some((s) => s.hostname === hostname)) {
    newSiteInput.value = "";
    return;
  }

  const origin = `https://${hostname}/*`;
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [origin] });
  } catch (err) {
    saveStatus.textContent = `Couldn't request permission: ${err.message || err}`;
    saveStatus.className = "status error visible";
    setTimeout(() => (saveStatus.className = "status success"), 3000);
    return;
  }
  if (!granted) return; // user declined the native prompt — nothing more to do

  try {
    await chrome.scripting.registerContentScripts([
      {
        id: `promptassist-custom-${hostname}`,
        matches: [origin],
        js: ["site-adapters.js", "floating-ui.js", "content-script.js"],
        runAt: "document_idle",
      },
    ]);
  } catch (err) {
    // Registration can fail if an id already exists (e.g. re-adding after a partial
    // removal) — not fatal, the site may already be functionally registered.
  }

  existing.push({ hostname, selector: "" });
  await chrome.storage.local.set({ customSites: existing });
  newSiteInput.value = "";
  renderCustomSites();
}

async function removeCustomSite(hostname) {
  const origin = `https://${hostname}/*`;
  await chrome.permissions.remove({ origins: [origin] }).catch(() => {});
  await chrome.scripting.unregisterContentScripts({ ids: [`promptassist-custom-${hostname}`] }).catch(() => {});
  const sites = await getCustomSites();
  await chrome.storage.local.set({ customSites: sites.filter((s) => s.hostname !== hostname) });
}

addSiteBtn.addEventListener("click", addCustomSite);
newSiteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addCustomSite();
});

loadKeys();
renderCustomSites();
```

### `styles.css`
```css
:root {
  --bg: #fbfaf8;
  --surface: #ffffff;
  --surface-raised: #f4f3f0;
  --border: #e5e3de;
  --text: #1a2e28;
  --text-dim: #6b7280;
  --accent: #15c39a;
  --accent-strong: #0b8a6c;
  --accent-soft: #e6f7f2;
  --danger: #e0554f;
  --danger-soft: #fbeceb;
  --success: #15c39a;
  --success-soft: #e6f7f2;
  --radius: 14px;
  --radius-pill: 999px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
}

.wrap {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100vh;
}

h1 {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
  letter-spacing: -0.01em;
  color: #05372e;
}

h1 .dim {
  color: var(--text-dim);
  font-weight: 500;
}

.subtitle {
  color: var(--text-dim);
  font-size: 12.5px;
  margin: 4px 0 0 0;
}

label {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-dim);
  margin-bottom: 6px;
}

textarea,
input[type="text"],
input[type="password"] {
  width: 100%;
  background: var(--surface);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 11px 14px;
  font-family: inherit;
  font-size: 13.5px;
  resize: vertical;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

textarea:focus,
input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

#draft-input {
  min-height: 160px;
}

button {
  font-family: inherit;
  font-size: 13.5px;
  font-weight: 700;
  border: none;
  border-radius: var(--radius-pill);
  padding: 11px 20px;
  cursor: pointer;
  transition: opacity 0.15s ease, transform 0.05s ease, background 0.15s ease;
}

button:active {
  transform: scale(0.98);
}

button.primary {
  background: var(--accent);
  color: #ffffff;
}

button.primary:hover {
  background: var(--accent-strong);
}

button.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

button.secondary {
  background: var(--surface);
  color: var(--accent-strong);
  border: 1.5px solid var(--border);
}

button.secondary:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.status {
  font-size: 12.5px;
  padding: 10px 14px;
  border-radius: var(--radius);
  display: none;
  font-weight: 500;
}

.status.visible {
  display: block;
}

.status.success {
  background: var(--success-soft);
  color: var(--accent-strong);
  border: 1px solid rgba(21, 195, 154, 0.25);
}

.status.error {
  background: var(--danger-soft);
  color: var(--danger);
  border: 1px solid rgba(224, 85, 79, 0.25);
}

.disclaimer {
  font-size: 11.5px;
  color: var(--text-dim);
  border-top: 1px solid var(--border);
  padding-top: 14px;
  margin-top: 4px;
}

.loading {
  display: none;
  padding: 14px 0;
}

.loading.visible {
  display: block;
}

.step-list-vertical {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 0;
}

@keyframes pa-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes pa-fade-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.loading-step {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  animation: pa-fade-in 0.2s ease;
}

.loading-step-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: bold;
}

.loading-step.active .loading-step-icon {
  border: 2.5px solid var(--accent-soft);
  border-top-color: var(--accent);
  animation: pa-spin 0.7s linear infinite;
}

.loading-step.done {
  color: var(--accent-strong);
}

.loading-step.done .loading-step-icon {
  background: var(--accent-soft);
  color: var(--accent-strong);
  border: none;
}

.loading-step.done .loading-step-icon::after {
  content: "✓";
}

.hint {
  font-size: 11px;
  margin-top: 4px;
  display: none;
}

.hint.visible {
  display: block;
}

.hint.ok {
  color: var(--accent-strong);
}

.hint.warn {
  color: #b45309;
}

.custom-sites-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.custom-site-row {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 10px;
}

.custom-site-row .hostname {
  font-size: 12.5px;
  font-weight: 600;
  flex-shrink: 0;
}

.custom-site-row input {
  flex: 1;
  padding: 6px 10px;
  font-size: 12px;
  min-width: 0;
}

.custom-site-row button {
  flex: 0 0 auto;
  padding: 6px 12px;
  font-size: 12px;
}

.result {
  display: none;
  flex-direction: column;
  gap: 12px;
}

.result.visible {
  display: flex;
}

.result-box {
  background: var(--surface);
  border: 1.5px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  font-size: 13.5px;
  white-space: pre-wrap;
  min-height: 100px;
}

.recap {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.recap summary {
  padding: 11px 14px;
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--accent-strong);
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.recap summary::-webkit-details-marker {
  display: none;
}

.recap[open] summary {
  border-bottom: 1px solid var(--border);
}

.recap-body {
  padding: 11px 14px;
  font-size: 13px;
  color: var(--text);
}

.row {
  display: flex;
  gap: 8px;
}

.footer-note {
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
}

a {
  color: var(--accent-strong);
}
```

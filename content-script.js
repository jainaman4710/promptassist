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
      sendResponse({ ok: true, text: adapter.getText(el), isFollowUp: adapter.isFollowUp() });
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

  // Shows the floating icon immediately and keeps it visible for this page's lifetime —
  // no dependency on the input field having text, or even existing yet. The icon can
  // read the field on demand when actually clicked (see floating-ui.js's badge handler
  // and background.js's enhance flow); nothing about showing the icon itself requires
  // the field to have any particular content. The user can dismiss the icon via its own
  // close control (floating-ui.js), which hides it for the rest of THIS page's lifetime
  // only — nothing is stored, so it reappears normally on the next page load or
  // navigation, consistent with the extension retaining no state across page loads.
  (function showPersistentIcon() {
    const adapter = getCurrentAdapter();
    if (!adapter || typeof window.showIdleTrigger !== "function") return;
    window.showIdleTrigger();
    // Let the browser actually paint before checking whether something (most likely a
    // cosmetic ad/annoyance blocker) is overriding our styles and hiding it anyway.
    setTimeout(checkWidgetActuallyVisible, 500);
  })();

  // One-time check: if the widget claims to be showing but its rendered geometry says
  // otherwise (something external — most likely an ad/annoyance blocker's cosmetic
  // filter — is overriding our styles), tell the background script so it can point the
  // user at the side panel instead, which isn't page content and can't be blocked this way.
  let widgetVisibilityChecked = false;
  function checkWidgetActuallyVisible() {
    if (widgetVisibilityChecked) return;
    const hostEl = window.__promptAssistFloatingHostEl;
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

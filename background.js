// Service workers use importScripts (not ES module imports) to bring in the plain
// global-scope pipeline functions shared with the side panel.
// gemini.js is back — pipeline.js calls Gemini directly again (no backend), the FastAPI
// detour is over. groq.js stays unused (Groq was already dropped before this pivot).
importScripts("shared.js", "gemini.js", "pipeline.js");

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

    const { geminiKey } = await chrome.storage.local.get(["geminiKey"]);
    if (!geminiKey) {
      notify("error", "Missing Gemini API key — add it in PromptAssist's options page.");
      setBadge("!", "#f87171");
      return;
    }

    const result = await runPipeline(
      draftResponse.text,
      { geminiKey },
      (stage) => notify("loading", stage)
    );

    port.postMessage({
      action: "showReviewCard",
      data: {
        enhancedPrompt: result.enhancedPrompt,
        recap: result.recap,
        criticalIssuesFound: result.criticalIssuesFound,
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

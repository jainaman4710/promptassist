// Floating UI. States:
//   - idle: small clickable icon, visible by default on every page load on a supported
//     site — not tied to the input field having text, or even existing yet. Stays
//     visible for this page's lifetime unless the user dismisses it via the small
//     close control that appears on hover, which hides it for the rest of THIS page's
//     lifetime only (nothing is stored, so it's back on the next page load/navigation).
//   - running: expands into a card showing step-by-step pipeline progress
//   - card: the enhanced prompt + recap with Apply/Dismiss/Try again — nothing is
//     written to the page's input field until the user clicks Apply.
// After a running/card state ends (success, error, or the review card is closed), the
// icon returns to idle rather than disappearing — idle is the resting state now, not
// hidden — unless the user has dismissed it for this page, in which case it stays hidden.
// No confirm step: clicking the icon (or the keyboard shortcut, or "Try again") goes
// straight to running the pipeline. The review card is the one real approval gate,
// since that's the point where something would actually get written to the page.
//
// Position: a fixed viewport corner (bottom-right), not tracking the input field.
// Field-relative tracking was tried and reverted — simpler and more reliable this way.
//
// Uses a shadow DOM for the icon/card contents so styles can't collide with (or be
// overridden by) the host page. The host element itself is also stripped of every
// identifying attribute (no id, no class, no inline style) — everything that makes it
// findable lives inside the shadow-protected :host{} CSS instead, so there's nothing in
// the light DOM for a cosmetic-filtering ad/annoyance blocker to target at all.
//
// IMPORTANT: built entirely with createElement/appendChild/textContent, NOT innerHTML.
// Sites that enforce a Trusted Types CSP throw on raw-string innerHTML assignment, even
// inside a shadow root — createElement-based construction isn't subject to that.
//
// Guarded against double-injection — see the comment in site-adapters.js for why.
if (!window.__promptAssistFloatingUILoaded) {
  window.__promptAssistFloatingUILoaded = true;

  const state = { host: null, root: null, hideTimeout: null, mode: "hidden", dismissedForSession: false };
  // Grammar runs first and unconditionally, so it belongs in this fixed list. cot and
  // fewshot stay out of it — they only run when their flags fire, so a row for them would
  // sit pending forever on the runs where they never execute.
  const STEP_ORDER = ["grammar", "audit", "structural", "critique"];
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
    :host {
      all: initial;
      position: fixed !important; bottom: 24px !important; right: 24px !important;
      width: ${ICON_SIZE}px !important; height: ${ICON_SIZE}px !important;
      overflow: visible !important; z-index: 999999 !important;
      display: block !important; visibility: visible !important;
      opacity: 0; transition: opacity 0.2s ease;
    }
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
    .badge-dismiss {
      position: absolute; top: -6px; right: -6px;
      width: 18px; height: 18px; border-radius: 50%;
      background: #1a2e28; color: #ffffff; font-size: 10px;
      display: none; align-items: center; justify-content: center;
      cursor: pointer; box-shadow: 0 2px 6px rgba(5,55,46,0.25);
    }
    .badge:hover .badge-dismiss { display: flex; }
    .badge-dismiss:hover { background: #05372e; }
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
    // isConnected, not just a truthiness check on state.host. This was the actual bug
    // behind "the icon is there on the first load and gone on the second": state.host
    // outlives the node it points at. If anything detaches our host from the document —
    // the page swapping out documentElement's children, a procedural filter rule removing
    // it, a framework remount — every later call returned a shadow root belonging to a
    // detached node, so every show/hide call succeeded silently against nothing. There
    // was no code path anywhere that could notice or recover from it.
    if (state.host && state.host.isConnected) return state.root;
    state.host = null;
    state.root = null;

    state.host = document.createElement("div");
    // Deliberately no id, no class, no inline style, nothing distinguishing at all in the
    // light DOM — everything that makes this element findable (positioning, sizing,
    // z-index, visibility) now lives entirely in the shadow-protected :host{} CSS rule
    // above instead. A cosmetic-filtering ad/annoyance blocker can only hide elements it
    // can target with a CSS selector; there's nothing here to select against anymore.
    // Exposed via a plain JS reference (not a queryable ID) for content-script.js's
    // widget-visibility self-check below — a JS variable isn't something a CSS-selector-
    // based filter can see or interfere with at all, unlike a DOM id.
    document.documentElement.appendChild(state.host);

    state.root = state.host.attachShadow({ mode: "open" });
    window.__promptAssistFloatingHostEl = state.host;

    const styleEl = document.createElement("style");
    styleEl.textContent = CSS; // .textContent, not .innerHTML — safe under Trusted Types

    const badge = el("div", { id: "badge", class: "badge" }, [
      el("div", { id: "spinner", class: "spinner", style: "display:none;" }),
      el("span", { id: "icon", class: "icon", style: "display:none;" }),
      el("div", { id: "tooltip", class: "tooltip" }),
      el("div", { id: "badge-dismiss", class: "badge-dismiss", text: "✕", title: "Hide for this page" }),
    ]);

    const stepList = el(
      "div",
      { class: "step-list" },
      STEP_ORDER.map((key, i) =>
        el("div", { id: `step-${key}`, class: "step pending" }, [
          el("span", { class: "step-icon" }),
          el("span", { text: ["Grammar", "Audit", "Structural pass", "Self-critique"][i] }),
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
    if (state.dismissedForSession) return;
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

    // Separate from badge.onclick above — stopPropagation so clicking the dismiss "×"
    // doesn't also fire the enhance flow underneath it.
    const dismissBtn = root.getElementById("badge-dismiss");
    dismissBtn.onclick = (e) => {
      e.stopPropagation();
      dismissForSession();
    };
  }

  // Hides the icon for the rest of this page's lifetime — not persisted anywhere, so a
  // reload or navigation brings it back. Distinct from hideFloatingStatus/hideReviewCard
  // below, which return to the idle icon rather than hiding it entirely — this is the
  // one path that actually suppresses it, and only this one checks it going forward.
  function dismissForSession() {
    state.dismissedForSession = true;
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
    // Explicit branch, not just relying on showIdleTrigger()'s own dismissedForSession
    // guard — that guard early-returns without touching opacity, which would leave the
    // icon stuck visible here (showFloatingStatus unconditionally sets opacity to "1"
    // for active-run feedback, correctly, even when dismissed — an explicitly triggered
    // run, e.g. via the keyboard shortcut, should still show its own progress/result).
    // Once that terminal status ends, though, dismissal should win: hide fully rather
    // than falling back to the persistent idle icon the user already dismissed.
    if (state.dismissedForSession) {
      if (state.host) state.host.style.opacity = "0";
      return;
    }
    showIdleTrigger();
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
      // Self-critique's specific reasoning is deliberately internal-only now (see
      // pipeline.js's header comment) — this is an honest "still not fully resolved"
      // signal, not the old detailed issue list, since that text was never meant to be
      // user-facing per the validated critique prompt's own instructions.
      noteEl.textContent = "Self-critique flagged a remaining concern with this enhancement — worth a careful read before using it.";
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

  // ---------------------------------------------------------------------------------
  // SELF-HEALING MOUNT
  //
  // Everything above assumes the host element stays in the document for the page's
  // lifetime once injected. On a single-page app that assumption does not hold, and when
  // it breaks there is no second injection coming: a same-document (SPA) navigation does
  // not re-run content scripts, so whatever Chrome injected at document_idle is all this
  // page will ever get. That is why a one-shot mount reads as "works on the first load,
  // gone after the second" — the second "load" is the app re-rendering, not a new
  // document, and our node did not survive it.
  //
  // Three independent triggers below, deliberately overlapping, because each one covers a
  // case the others miss:
  //   - MutationObserver: instant, catches the node being removed from documentElement.
  //   - history/popstate hooks: catch SPA route changes that rebuild the page wholesale.
  //   - low-frequency interval: the backstop for anything the other two can't see, such
  //     as documentElement itself being replaced (which kills the observer with it).
  function remountIfDetached() {
    if (state.dismissedForSession) return;
    if (state.host && state.host.isConnected) return;
    state.host = null;
    state.root = null;
    // A running pipeline's card went with the old DOM, so there's nothing to restore it
    // to. Falling back to the idle icon is the honest recovery: the user can see the
    // extension is alive and re-run it, which beats an invisible extension.
    if (state.mode === "running" || state.mode === "card") state.mode = "idle";
    showIdleTrigger();
  }

  // Chrome tears down the content script's extension context when the extension is
  // reloaded or updated, but leaves the already-injected JS running on the page. Every
  // chrome.* call from that point throws "Extension context invalidated", so the watchdog
  // has to stop rather than loop forever on a dead context.
  function extensionContextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function installMountWatchdog() {
    if (window.__promptAssistWatchdogInstalled) return;
    window.__promptAssistWatchdogInstalled = true;

    try {
      const observer = new MutationObserver(() => {
        if (!extensionContextAlive()) return observer.disconnect();
        remountIfDetached();
      });
      // childList only, no subtree: the host is a direct child of documentElement, so
      // this fires on our own node being removed and on essentially nothing else. A
      // subtree observer on a chat app would fire on every streamed token.
      observer.observe(document.documentElement, { childList: true });
    } catch (e) {
      // Observer setup failing is survivable — the interval below still covers it.
    }

    // SPA route changes. pushState/replaceState fire no event of their own, so they get
    // wrapped. The wrapper calls through to the original first and never throws into the
    // page's own navigation, since breaking the host site would be far worse than a
    // missing icon.
    const hook = (name) => {
      const original = history[name];
      if (typeof original !== "function") return;
      history[name] = function () {
        const result = original.apply(this, arguments);
        try {
          setTimeout(remountIfDetached, 0);
        } catch (e) {}
        return result;
      };
    };
    hook("pushState");
    hook("replaceState");
    window.addEventListener("popstate", () => setTimeout(remountIfDetached, 0));
    // bfcache restore: the DOM usually comes back intact, but re-asserting is free.
    window.addEventListener("pageshow", () => remountIfDetached());

    const timer = setInterval(() => {
      if (!extensionContextAlive()) return clearInterval(timer);
      remountIfDetached();
    }, 3000);
  }

  window.showFloatingStatus = showFloatingStatus;
  window.showReviewCard = showReviewCard;
  window.showIdleTrigger = showIdleTrigger;
  // Exposed so content-script.js can re-assert the icon on a re-injection without
  // duplicating any of the state logic above.
  window.__paRemountIfDetached = remountIfDetached;
  window.__paInstallMountWatchdog = installMountWatchdog;
}

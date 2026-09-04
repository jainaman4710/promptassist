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

  window.showFloatingStatus = showFloatingStatus;
  window.showReviewCard = showReviewCard;
  window.showIdleTrigger = showIdleTrigger;
  window.hideIdleTrigger = hideIdleTrigger;
}

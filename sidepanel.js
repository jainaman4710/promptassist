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
// Real step-by-step progress again — pipeline.js calls Gemini directly, one step at a
// time, so onProgress fires at the moment each specific call actually starts (audit ->
// structural -> chain_of_thought/few_shot if flagged -> critique). This was collapsed to
// a single "enhance" step during the backend-calling detour (that whole call sequence
// happened server-side, invisible to this file) — restored automatically now that the
// pipeline runs client-side again, not a separate fix.
const STEP_LABELS = {
  audit: "Auditing your draft",
  structural: "Applying structural improvements",
  chain_of_thought: "Adding reasoning framing",
  few_shot: "Adding an example",
  critique: "Running self-critique",
};
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
  const { geminiKey } = await chrome.storage.local.get(["geminiKey"]);
  return { geminiKey };
}

async function checkKeysPresent() {
  const { geminiKey } = await getStoredKeys();
  if (!geminiKey) {
    keysWarning.textContent = "Missing API key. Add your Gemini key in the extension's options page before running.";
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
    finishLoadingSteps(); // the final "critique" call still needs this to flip its own row to done — nothing calls advanceToStep again after it resolves
    await new Promise((r) => setTimeout(r, 350)); // let the final checkmark actually be seen

    resultBox.value = result.enhancedPrompt;

    // Self-critique corrects issues itself (see pipeline.js's critiqueAndCorrect) — this
    // is only shown at all when it still hadn't passed after every correction attempt it
    // was allowed, and the specific reasoning is deliberately internal-only (the
    // validated critique prompt's own instructions say its issue summary is "never shown
    // to the user"), so this is an honest residual signal, not a detailed issue list.
    if (result.criticalIssuesFound) {
      recapBody.textContent =
        `${result.recap}\n\n⚠ Self-critique flagged a remaining concern with this ` +
        `enhancement even after its own correction pass — worth a careful read before using it.`;
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

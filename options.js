const geminiKeyInput = document.getElementById("gemini-key");
const geminiKeyHint = document.getElementById("gemini-key-hint");
const saveBtn = document.getElementById("save-btn");
const toggleBtn = document.getElementById("toggle-visibility-btn");
const saveStatus = document.getElementById("save-status");
const newSiteInput = document.getElementById("new-site-input");
const addSiteBtn = document.getElementById("add-site-btn");
const customSitesList = document.getElementById("custom-sites-list");

async function loadKeys() {
  const { geminiKey } = await chrome.storage.local.get(["geminiKey"]);
  if (geminiKey) geminiKeyInput.value = geminiKey;
  checkKeyFormat(geminiKeyInput, geminiKeyHint, "AIza", "Gemini");
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

saveBtn.addEventListener("click", async () => {
  const geminiKey = geminiKeyInput.value.trim();
  await chrome.storage.local.set({ geminiKey });

  saveStatus.textContent = "Saved.";
  saveStatus.classList.add("visible");
  setTimeout(() => saveStatus.classList.remove("visible"), 2000);
});

toggleBtn.addEventListener("click", () => {
  const showing = geminiKeyInput.type === "text";
  const nextType = showing ? "password" : "text";
  geminiKeyInput.type = nextType;
  toggleBtn.textContent = showing ? "Show key" : "Hide key";
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

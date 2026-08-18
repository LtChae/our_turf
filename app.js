/* ---------------------------------------------------------------------
   Canvass tracker
   Data: VOTERS is loaded from a CSV the user uploads (geocoded client-side
   against Nominatim) and persisted in localStorage. Contact history is
   stored per-voter in localStorage and never touches the roster.
--------------------------------------------------------------------- */

const STORAGE_KEY = "canvass_contacts_v1";
const ROSTER_KEY = "canvass_roster_v1";
const GEOCODE_CACHE_KEY = "canvass_geocode_cache_v1";
const RATE_COLORS = { 1: "var(--rate-1)", 2: "var(--rate-2)", 3: "var(--rate-3)", 4: "var(--rate-4)", 5: "var(--rate-5)" };
const RATE_LABELS = { 1: "Absolutely not", 2: "Leaning no", 3: "Unsure", 4: "Leaning yes", 5: "Definitely yes" };
const DEFAULT_MAP_CENTER = [39.8283, -98.5795]; // continental US center, used until a roster is loaded
const DEFAULT_MAP_ZOOM = 4;

// ---- persistence --------------------------------------------------------

function loadContacts() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}
function saveContacts(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}
let CONTACTS = loadContacts();

function loadRoster() {
  try {
    return JSON.parse(localStorage.getItem(ROSTER_KEY)) || { voters: [] };
  } catch {
    return { voters: [] };
  }
}
function saveRoster(roster) {
  localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
}

function loadGeoCache() {
  try {
    return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY)) || {};
  } catch {
    return {};
  }
}
function saveGeoCache(cache) {
  localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache));
}
let GEO_CACHE = loadGeoCache();

function addContact(voterId, entry) {
  if (!CONTACTS[voterId]) CONTACTS[voterId] = [];
  entry.id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  entry.ts = Date.now();
  CONTACTS[voterId].push(entry);
  saveContacts(CONTACTS);
}
function deleteContact(voterId, entryId) {
  if (!CONTACTS[voterId]) return;
  CONTACTS[voterId] = CONTACTS[voterId].filter((e) => e.id !== entryId);
  saveContacts(CONTACTS);
}
function updateContact(voterId, entryId, patch) {
  if (!CONTACTS[voterId]) return;
  const entry = CONTACTS[voterId].find((e) => e.id === entryId);
  if (!entry) return;
  Object.assign(entry, patch);
  saveContacts(CONTACTS);
}
function getHistory(voterId) {
  return (CONTACTS[voterId] || []).slice().sort((a, b) => b.ts - a.ts);
}
function getLatest(voterId) {
  const h = getHistory(voterId);
  return h.length ? h[0] : null;
}
// Most recent contact that actually recorded a likelihood rating — not
// necessarily the latest contact, since a later "not home" visit has none.
function getLastRatedEntry(voterId) {
  return getHistory(voterId).find((entry) => entry.rating) || null;
}

// ---- roster / households ------------------------------------------------

let VOTERS = [];
let HOUSEHOLDS = new Map();
let HOUSEHOLDS_BY_VOTER = new Map();

function householdKey(v) {
  return `${v.address}|${v.city}|${v.zip}`;
}

// Rebuilds all state derived from VOTERS. Called at startup and after
// every successful CSV import (which replaces VOTERS wholesale).
function rebuildDerivedState() {
  HOUSEHOLDS = new Map();
  HOUSEHOLDS_BY_VOTER = new Map();
  for (const v of VOTERS) {
    const key = householdKey(v);
    if (!HOUSEHOLDS.has(key)) HOUSEHOLDS.set(key, []);
    HOUSEHOLDS.get(key).push(v);
    HOUSEHOLDS_BY_VOTER.set(v.id, v);
  }
}

function householdSummary(householdVoters) {
  let best = null; // highest last-recorded rating among household voters
  let anyContacted = false;
  for (const v of householdVoters) {
    if (getLatest(v.id)) anyContacted = true;
    const lastRated = getLastRatedEntry(v.id);
    if (lastRated && (best === null || lastRated.rating > best)) best = lastRated.rating;
  }
  if (!anyContacted) return { state: "none" };
  if (best === null) return { state: "attempted" };
  return { state: "rated", rating: best };
}

// ---- filters ---------------------------------------------------------

const filters = {
  status: new Set(),
  ratings: new Set(),
  home: new Set(),
  lit: new Set(),
  search: "",
};

function voterMatchesFilters(v) {
  const latest = getLatest(v.id);
  const contacted = !!latest;

  if (filters.status.size) {
    const key = contacted ? "contacted" : "not_contacted";
    if (!filters.status.has(key)) return false;
  }
  if (filters.ratings.size) {
    const lastRated = getLastRatedEntry(v.id);
    const key = lastRated ? String(lastRated.rating) : "none";
    if (!filters.ratings.has(key)) return false;
  }
  if (filters.home.size) {
    if (!contacted) return false;
    const key = latest.home ? "home" : "not_home";
    if (!filters.home.has(key)) return false;
  }
  if (filters.lit.size) {
    if (!contacted) return false;
    const key = latest.literature ? "yes" : "no";
    if (!filters.lit.has(key)) return false;
  }
  if (filters.search) {
    const hay = `${v.firstName} ${v.lastName} ${v.address}`.toLowerCase();
    if (!hay.includes(filters.search)) return false;
  }
  return true;
}

// ---- filter bar UI -----------------------------------------------------

function buildChipGroup(container, options, filterSet, onChange) {
  container.innerHTML = "";
  for (const opt of options) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.innerHTML = (opt.swatch ? `<span class="swatch" style="background:${opt.swatch}"></span>` : "") + opt.label;
    chip.addEventListener("click", () => {
      if (filterSet.has(opt.key)) filterSet.delete(opt.key);
      else filterSet.add(opt.key);
      chip.classList.toggle("active");
      onChange();
    });
    container.appendChild(chip);
  }
}

function initFilterBar() {
  buildChipGroup(document.getElementById("filter-status"), [
    { key: "not_contacted", label: "Not contacted" },
    { key: "contacted", label: "Contacted" },
  ], filters.status, render);

  buildChipGroup(document.getElementById("filter-rating"), [
    { key: "5", label: "5", swatch: "var(--rate-5)" },
    { key: "4", label: "4", swatch: "var(--rate-4)" },
    { key: "3", label: "3", swatch: "var(--rate-3)" },
    { key: "2", label: "2", swatch: "var(--rate-2)" },
    { key: "1", label: "1", swatch: "var(--rate-1)" },
    { key: "none", label: "No rating", swatch: "var(--rate-none)" },
  ], filters.ratings, render);

  buildChipGroup(document.getElementById("filter-home"), [
    { key: "home", label: "Home" },
    { key: "not_home", label: "Not home" },
  ], filters.home, render);

  buildChipGroup(document.getElementById("filter-lit"), [
    { key: "yes", label: "Lit left" },
    { key: "no", label: "No lit" },
  ], filters.lit, render);

  document.getElementById("searchBox").addEventListener("input", (e) => {
    filters.search = e.target.value.trim().toLowerCase();
    render();
  });

  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    filters.status.clear();
    filters.ratings.clear();
    filters.home.clear();
    filters.lit.clear();
    filters.search = "";
    document.getElementById("searchBox").value = "";
    document.querySelectorAll(".chip.active").forEach((c) => c.classList.remove("active"));
    render();
  });
}

// ---- map ---------------------------------------------------------------

const map = L.map("map").setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);

// Re-centers the map on the current roster, or falls back to the default
// view if no roster is loaded. Called at startup and after each import.
function centerMapOnRoster() {
  if (!VOTERS.length) {
    map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    return;
  }
  const avgLat = VOTERS.reduce((s, v) => s + v.lat, 0) / VOTERS.length;
  const avgLon = VOTERS.reduce((s, v) => s + v.lon, 0) / VOTERS.length;
  map.setView([avgLat, avgLon], 15);
}

const legend = L.control({ position: "bottomleft" });
legend.onAdd = () => {
  const div = L.DomUtil.create("div", "legend");
  div.innerHTML = `
    <div><span class="dot" style="background:var(--rate-5)"></span>5 &ndash; definitely yes</div>
    <div><span class="dot" style="background:var(--rate-4)"></span>4 &ndash; leaning yes</div>
    <div><span class="dot" style="background:var(--rate-3)"></span>3 &ndash; unsure</div>
    <div><span class="dot" style="background:var(--rate-2)"></span>2 &ndash; leaning no</div>
    <div><span class="dot" style="background:var(--rate-1)"></span>1 &ndash; absolutely not</div>
    <div><span class="dot" style="background:var(--rate-none);border:1px solid var(--gridline)"></span>Attempted / not contacted</div>
  `;
  return div;
};
legend.addTo(map);

const markerLayer = L.layerGroup().addTo(map);

function markerHtml(summary) {
  let bg, label;
  if (summary.state === "rated") {
    bg = RATE_COLORS[summary.rating];
    label = summary.rating;
  } else if (summary.state === "attempted") {
    bg = "var(--rate-none)";
    label = "&bull;";
  } else {
    bg = "var(--surface-1)";
    label = "";
  }
  return `<div class="voter-marker ${summary.state === "none" ? "rate-none" : ""}" style="width:26px;height:26px;background:${bg};border-color:${summary.state === "none" ? "var(--rate-none)" : "var(--surface-1)"}">${label}</div>`;
}

function renderMap() {
  markerLayer.clearLayers();
  for (const [key, householdVoters] of HOUSEHOLDS) {
    const matching = householdVoters.filter(voterMatchesFilters);
    if (!matching.length) continue;
    const first = householdVoters[0];
    const summary = householdSummary(householdVoters);
    const icon = L.divIcon({
      html: markerHtml(summary),
      className: "",
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    const marker = L.marker([first.lat, first.lon], { icon });
    marker.on("click", () => openPanel(key));
    marker.addTo(markerLayer);
  }
}

// ---- panel (household detail + logging) --------------------------------

const panel = document.getElementById("panel");
const panelOverlay = document.getElementById("panelOverlay");
const panelContent = document.getElementById("panelContent");

document.getElementById("panelClose").addEventListener("click", closePanel);
panelOverlay.addEventListener("click", closePanel);

function closePanel() {
  panel.hidden = true;
  panelOverlay.hidden = true;
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function historyItemHtml(entry, voterId) {
  const method = entry.method || "door";
  const parts = [];
  if (method === "text") {
    parts.push("Texted");
  } else {
    parts.push(entry.home ? "Home" : "Not home");
    parts.push(entry.literature ? "Literature left" : "No literature left");
  }
  parts.push(entry.rating ? `Rated ${entry.rating}/5 (${RATE_LABELS[entry.rating]})` : "No rating yet");

  return `
    <li>
      <div class="hist-line1">
        <span>${fmtDate(entry.date)} &mdash; ${parts.join(" &middot; ")}</span>
        <span class="hist-actions">
          <button type="button" class="hist-edit-rating" data-action="edit-rating" data-voter="${voterId}" data-entry="${entry.id}" title="Set likelihood to vote">${entry.rating ? "Edit rating" : "Add rating"}</button>
          <button type="button" class="hist-delete" data-action="delete-contact" data-voter="${voterId}" data-entry="${entry.id}" title="Delete this contact attempt" aria-label="Delete this contact attempt">&times;</button>
        </span>
      </div>
      <div class="hist-rating-editor" data-entry="${entry.id}" hidden>
        <div class="toggle-row">
          ${[1,2,3,4,5].map(r => `<button type="button" class="toggle-btn rate-btn ${entry.rating === r ? "selected" : ""}" data-action="set-rating" data-voter="${voterId}" data-entry="${entry.id}" data-r="${r}" title="${RATE_LABELS[r]}">${r}</button>`).join("")}
          ${entry.rating ? `<button type="button" class="btn-link" data-action="clear-rating" data-voter="${voterId}" data-entry="${entry.id}">Clear</button>` : ""}
        </div>
      </div>
      ${entry.notes ? `<div class="hist-notes">&ldquo;${escapeHtml(entry.notes)}&rdquo;</div>` : ""}
    </li>`;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function voterCardHtml(v) {
  const history = getHistory(v.id);
  const latest = history[0] || null;
  const lastRated = getLastRatedEntry(v.id);
  let dotColor = "var(--rate-none)";
  if (lastRated) dotColor = RATE_COLORS[lastRated.rating];
  else if (latest) dotColor = "var(--text-muted)";

  const ratingBadge = lastRated
    ? `<span class="badge" style="background:${RATE_COLORS[lastRated.rating]}">${lastRated.rating} &middot; ${RATE_LABELS[lastRated.rating]}</span>`
    : "";
  const staleNote = lastRated && latest && lastRated.id !== latest.id
    ? `<div class="voter-meta" style="margin-top:4px">Rated ${fmtDate(lastRated.date)} &mdash; more recent visit on ${fmtDate(latest.date)} recorded no rating.</div>`
    : "";

  return `
    <div class="voter-card" data-voter="${v.id}">
      <div class="voter-card-head">
        <div>
          <div class="voter-name"><span class="voter-status-dot" style="background:${dotColor}"></span> ${escapeHtml(v.firstName)} ${escapeHtml(v.lastName)}</div>
          <div class="voter-meta">${v.age ? v.age + " yo &middot; " : ""}${v.sex || ""}${v.party ? " &middot; Party: " + v.party : ""}${v.phone ? " &middot; " + v.phone : ""}</div>
        </div>
        ${ratingBadge}
      </div>
      ${staleNote}
      ${history.length ? `<ul class="history-list">${history.map((entry) => historyItemHtml(entry, v.id)).join("")}</ul>` : `<div class="voter-meta" style="margin-top:8px">No contact attempts logged yet.</div>`}
      <div class="add-contact-actions">
        <button class="add-contact-btn" data-action="toggle-form" data-voter="${v.id}" data-method="door">+ Log a contact attempt</button>
        <button class="add-contact-btn" data-action="toggle-form" data-voter="${v.id}" data-method="text">+ Log a text attempt</button>
      </div>
      ${logFormHtml(v.id, "door")}
      ${logFormHtml(v.id, "text")}
    </div>`;
}

function logFormHtml(voterId, method) {
  const doorFields = `
        <div>
          <label>Were they home?</label>
          <div class="toggle-row">
            <button type="button" class="toggle-btn home-btn selected" data-val="true">Home</button>
            <button type="button" class="toggle-btn home-btn" data-val="false">Not home</button>
          </div>
        </div>
        <div>
          <label>Left literature?</label>
          <div class="toggle-row">
            <button type="button" class="toggle-btn lit-btn" data-val="true">Yes</button>
            <button type="button" class="toggle-btn lit-btn selected" data-val="false">No</button>
          </div>
        </div>`;
  const rateLabel = method === "text" ? "Likelihood to vote (leave blank until they reply)" : "Likelihood to vote for our candidate";
  return `
      <form class="log-form" data-voter="${voterId}" data-method="${method}">
        <div class="row">
          <div>
            <label>Date</label>
            <input type="date" name="date" value="${new Date().toISOString().slice(0,10)}" required>
          </div>
        </div>
        ${method === "door" ? doorFields : ""}
        <div>
          <label>${rateLabel}</label>
          <div class="toggle-row">
            ${[1,2,3,4,5].map(r => `<button type="button" class="toggle-btn rate-btn" data-r="${r}" title="${RATE_LABELS[r]}">${r}</button>`).join("")}
          </div>
        </div>
        <div>
          <label>Notes</label>
          <textarea class="notes" name="notes" placeholder="Optional&hellip;"></textarea>
        </div>
        <div class="log-actions">
          <button type="submit" class="btn-primary">${method === "text" ? "Save text attempt" : "Save contact"}</button>
          <button type="button" class="btn-link" data-action="cancel-form">Cancel</button>
        </div>
      </form>`;
}

function openPanel(householdKeyVal) {
  const householdVoters = HOUSEHOLDS.get(householdKeyVal);
  const first = householdVoters[0];
  panelContent.innerHTML = `
    <h2 class="household-address">${escapeHtml(first.address)}</h2>
    <p class="household-sub">${escapeHtml(first.city)}, ${escapeHtml(first.state)} ${escapeHtml(first.zip)} &middot; ${householdVoters.length} registered voter${householdVoters.length > 1 ? "s" : ""}</p>
    ${householdVoters.map(voterCardHtml).join("")}
  `;
  wirePanelEvents();
  panel.hidden = false;
  panelOverlay.hidden = false;
}

function wirePanelEvents() {
  panelContent.querySelectorAll('[data-action="toggle-form"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const form = panelContent.querySelector(`.log-form[data-voter="${btn.dataset.voter}"][data-method="${btn.dataset.method}"]`);
      form.classList.toggle("open");
    });
  });
  panelContent.querySelectorAll('[data-action="cancel-form"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".log-form").classList.remove("open");
    });
  });
  panelContent.querySelectorAll('[data-action="delete-contact"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!confirm("Delete this contact attempt? This can't be undone.")) return;
      const voterId = btn.dataset.voter;
      deleteContact(voterId, btn.dataset.entry);
      const key = householdKey(HOUSEHOLDS_BY_VOTER.get(voterId));
      openPanel(key);
      render();
    });
  });
  panelContent.querySelectorAll('[data-action="edit-rating"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const editor = panelContent.querySelector(`.hist-rating-editor[data-entry="${btn.dataset.entry}"]`);
      editor.hidden = !editor.hidden;
    });
  });
  panelContent.querySelectorAll('[data-action="set-rating"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const voterId = btn.dataset.voter;
      updateContact(voterId, btn.dataset.entry, { rating: parseInt(btn.dataset.r, 10) });
      const key = householdKey(HOUSEHOLDS_BY_VOTER.get(voterId));
      openPanel(key);
      render();
    });
  });
  panelContent.querySelectorAll('[data-action="clear-rating"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const voterId = btn.dataset.voter;
      updateContact(voterId, btn.dataset.entry, { rating: null });
      const key = householdKey(HOUSEHOLDS_BY_VOTER.get(voterId));
      openPanel(key);
      render();
    });
  });
  panelContent.querySelectorAll(".log-form .home-btn, .log-form .lit-btn, .log-form .rate-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const group = btn.classList.contains("home-btn") ? "home-btn" : btn.classList.contains("lit-btn") ? "lit-btn" : "rate-btn";
      const form = btn.closest(".log-form");
      if (group === "rate-btn") {
        // rating is optional single-select; clicking the active one deselects it
        const already = btn.classList.contains("selected");
        form.querySelectorAll(".rate-btn").forEach((b) => b.classList.remove("selected"));
        if (!already) btn.classList.add("selected");
      } else {
        form.querySelectorAll(`.${group}`).forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
      }
    });
  });
  panelContent.querySelectorAll(".log-form").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const voterId = form.dataset.voter;
      const method = form.dataset.method;
      const rateBtn = form.querySelector(".rate-btn.selected");
      const rating = rateBtn ? parseInt(rateBtn.dataset.r, 10) : null;
      const date = form.querySelector('input[name="date"]').value || new Date().toISOString().slice(0, 10);
      const notes = form.querySelector(".notes").value.trim();

      const entry = { date, method, rating, notes };
      if (method === "door") {
        entry.home = form.querySelector(".home-btn.selected").dataset.val === "true";
        entry.literature = form.querySelector(".lit-btn.selected").dataset.val === "true";
      }
      addContact(voterId, entry);

      const key = householdKey(HOUSEHOLDS_BY_VOTER.get(voterId));
      openPanel(key); // re-render panel with new history
      render();
    });
  });
}

// ---- list view -----------------------------------------------------------

const listView = document.getElementById("listView");
const mapDiv = document.getElementById("map");
const toggleListBtn = document.getElementById("toggleListBtn");
let showingList = false;

toggleListBtn.addEventListener("click", () => {
  showingList = !showingList;
  mapDiv.style.display = showingList ? "none" : "block";
  listView.hidden = !showingList;
  toggleListBtn.textContent = showingList ? "Map view" : "List view";
});

function resultBadge(latest, lastRated) {
  if (!latest) return `<span class="badge" style="background:var(--rate-none);color:var(--text-primary)">Not contacted</span>`;
  if (!lastRated) return `<span class="badge" style="background:var(--text-muted)">No rating</span>`;
  return `<span class="badge" style="background:${RATE_COLORS[lastRated.rating]}">${lastRated.rating} &middot; ${RATE_LABELS[lastRated.rating]}</span>`;
}

function renderList() {
  const tbody = document.getElementById("voterTableBody");
  const rows = VOTERS.filter(voterMatchesFilters).map((v) => {
    const latest = getLatest(v.id);
    const lastRated = getLastRatedEntry(v.id);
    return `
      <tr data-household="${escapeHtml(householdKey(v))}">
        <td>${escapeHtml(v.firstName)} ${escapeHtml(v.lastName)}</td>
        <td>${escapeHtml(v.address)}</td>
        <td>${latest ? fmtDate(latest.date) : "&mdash;"}</td>
        <td>${resultBadge(latest, lastRated)}</td>
        <td>${latest ? (latest.home ? "Yes" : "No") : "&mdash;"}</td>
        <td>${latest ? (latest.literature ? "Yes" : "No") : "&mdash;"}</td>
        <td>&rsaquo;</td>
      </tr>`;
  });
  const emptyMessage = VOTERS.length ? "No voters match the current filters." : "No roster loaded yet.";
  tbody.innerHTML = rows.join("") || `<tr><td colspan="7" style="color:var(--text-muted)">${emptyMessage}</td></tr>`;
  tbody.querySelectorAll("tr[data-household]").forEach((tr) => {
    tr.addEventListener("click", () => openPanel(tr.dataset.household));
  });
}

// ---- stats -----------------------------------------------------------

function renderStats() {
  const total = VOTERS.length;
  if (!total) {
    document.getElementById("stats").innerHTML = "No roster loaded &mdash; upload a CSV to get started.";
    return;
  }
  const contacted = VOTERS.filter((v) => getLatest(v.id)).length;
  const rated = VOTERS.map((v) => getLastRatedEntry(v.id)).filter(Boolean);
  const avg = rated.length ? (rated.reduce((s, l) => s + l.rating, 0) / rated.length).toFixed(1) : "&mdash;";
  document.getElementById("stats").innerHTML =
    `${total} voters &middot; ${contacted} contacted (${Math.round((contacted / total) * 100)}%) &middot; avg support ${avg}`;
}

function renderEmptyState() {
  document.getElementById("emptyState").hidden = VOTERS.length > 0;
}

// ---- render orchestration ------------------------------------------------

function render() {
  renderMap();
  renderList();
  renderStats();
  renderEmptyState();
}

// ---- CSV import: parsing ------------------------------------------------

const REQUIRED_CSV_COLUMNS = ["Address", "City", "State", "Zip", "First Name", "Last Name", "VANID"];

function parseCsvFile(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => resolve(results),
      error: (err) => reject(err),
    });
  });
}

function validateCsvColumns(fields) {
  const missing = REQUIRED_CSV_COLUMNS.filter((c) => !fields.includes(c));
  return missing.length ? { ok: false, missing } : { ok: true };
}

// ---- CSV import: geocoding ------------------------------------------------
// Mirrors scripts/geocode.py: same address-key format, same Nominatim
// query, same cache (now in localStorage instead of a JSON file), same
// ~1 req/sec throttle. fetch() can't set a custom User-Agent (browser-
// forbidden header) — the browser's automatic Referer header covers
// Nominatim's client-identification requirement instead.

function addrKey(row) {
  return `${row.Address}, ${row.City}, ${row.State} ${row.Zip}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function geocodeOne(addr) {
  const q = new URLSearchParams({ q: addr, format: "json", limit: 1 });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${q}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

async function geocodeAddresses(addrs, cache, onProgress) {
  for (let i = 0; i < addrs.length; i++) {
    const addr = addrs[i];
    if (!(addr in cache)) {
      try {
        cache[addr] = await geocodeOne(addr);
      } catch {
        cache[addr] = null;
      }
      saveGeoCache(cache); // incremental persist — a refresh mid-run loses at most one request
      onProgress(i + 1, addrs.length, addr);
      if (i < addrs.length - 1) await sleep(1100);
    } else {
      onProgress(i + 1, addrs.length, addr);
    }
  }
}

// A CSV pre-geocoded by scripts/geocode_google.py already has lat/lon per
// row; only rows without usable coordinates fall back to live geocoding.
function rowHasCoords(row) {
  const lat = parseFloat(row.lat);
  const lon = parseFloat(row.lon);
  return Number.isFinite(lat) && Number.isFinite(lon);
}

function csvRowToVoter(row, cache) {
  const coord = rowHasCoords(row)
    ? { lat: parseFloat(row.lat), lon: parseFloat(row.lon) }
    : cache[addrKey(row)];
  if (!coord) return null;
  return {
    id: row.VANID,
    firstName: row["First Name"],
    lastName: row["Last Name"],
    address: row.Address,
    city: row.City,
    state: row.State,
    zip: row.Zip,
    phone: row.Phone,
    sex: row.Sex,
    age: row.Age,
    party: row.Party,
    lat: coord.lat,
    lon: coord.lon,
  };
}

// ---- CSV import: panel UI -------------------------------------------------

const importPanel = document.getElementById("importPanel");
const importPanelOverlay = document.getElementById("importPanelOverlay");
const importPanelContent = document.getElementById("importPanelContent");

document.getElementById("importPanelClose").addEventListener("click", closeImportPanel);
importPanelOverlay.addEventListener("click", closeImportPanel);

function openImportPanel() {
  importPanel.hidden = false;
  importPanelOverlay.hidden = false;
}
function closeImportPanel() {
  importPanel.hidden = true;
  importPanelOverlay.hidden = true;
}

function renderImportPanel(html) {
  importPanelContent.innerHTML = html;
}

function renderImportParsing() {
  renderImportPanel(`<h2 class="household-address">Importing CSV&hellip;</h2><p class="import-status">Parsing file&hellip;</p>`);
}

function renderImportError(title, detail) {
  renderImportPanel(`
    <h2 class="household-address">Import failed</h2>
    <p class="import-status">${escapeHtml(title)}</p>
    ${detail}
  `);
}

function renderImportProgress(done, total, addr) {
  renderImportPanel(`
    <h2 class="household-address">Importing CSV&hellip;</h2>
    <p class="import-status">Geocoding addresses&hellip; ${done}/${total}</p>
    <progress class="import-progress" max="${total}" value="${done}"></progress>
    <p class="import-status">Last: ${escapeHtml(addr)}</p>
    <p class="import-status">You can close this panel &mdash; progress is saved and will resume where it left off.</p>
  `);
}

function renderImportDone(imported, missing) {
  const missingLine = missing
    ? `<p class="import-status">${missing} address${missing === 1 ? "" : "es"} could not be located and ${missing === 1 ? "was" : "were"} excluded.</p>`
    : "";
  renderImportPanel(`
    <h2 class="household-address">Import complete</h2>
    <p class="import-status">${imported} voter${imported === 1 ? "" : "s"} imported.</p>
    ${missingLine}
    <button type="button" class="btn-primary" data-action="close-import">Done</button>
  `);
  importPanelContent.querySelector('[data-action="close-import"]').addEventListener("click", closeImportPanel);
}

// ---- CSV import: orchestration --------------------------------------------

async function importCsvFile(file) {
  openImportPanel();
  renderImportParsing();

  let results;
  try {
    results = await parseCsvFile(file);
  } catch (err) {
    renderImportError("Could not read this file.", `<p class="import-status">${escapeHtml(String(err))}</p>`);
    return;
  }

  const fields = results.meta.fields || [];
  const check = validateCsvColumns(fields);
  if (!check.ok) {
    renderImportError(
      "This CSV is missing required columns.",
      `<ul class="import-error-list">${check.missing.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`
    );
    return;
  }

  const rows = results.data;

  // Only rows lacking usable lat/lon in the CSV itself need live geocoding.
  const rowsNeedingGeocode = rows.filter((r) => !rowHasCoords(r));
  const uniqueAddrs = [...new Set(rowsNeedingGeocode.map(addrKey))].sort();

  if (uniqueAddrs.length) {
    await geocodeAddresses(uniqueAddrs, GEO_CACHE, (done, total, addr) => {
      renderImportProgress(done, total, addr);
    });
  }

  let missing = 0;
  const voters = [];
  for (const row of rows) {
    const voter = csvRowToVoter(row, GEO_CACHE);
    if (!voter) {
      missing++;
      continue;
    }
    voters.push(voter);
  }

  // Geocoding failed for every address (offline, Nominatim down, etc.) —
  // don't silently wipe out a working roster with an empty one.
  if (!voters.length && rows.length) {
    renderImportError(
      "Geocoding failed for every address in this file.",
      `<p class="import-status">This usually means a network problem or Nominatim being unreachable, not bad addresses. Your existing roster (if any) was left unchanged. Check your connection and try again.</p>`
    );
    return;
  }

  saveRoster({
    importedAt: new Date().toISOString(),
    sourceFileName: file.name,
    missingCount: missing,
    voters,
  });

  VOTERS = voters;
  rebuildDerivedState();
  centerMapOnRoster();
  render();
  renderImportDone(voters.length, missing);
}

function initUploadUi() {
  const fileInput = document.getElementById("csvFileInput");
  const triggerUpload = () => fileInput.click();
  document.getElementById("uploadCsvBtn").addEventListener("click", triggerUpload);
  document.getElementById("emptyStateUploadBtn").addEventListener("click", triggerUpload);
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    fileInput.value = ""; // allow re-selecting the same file later
    if (file) importCsvFile(file);
  });
}

// ---- startup ---------------------------------------------------------

VOTERS = loadRoster().voters;
rebuildDerivedState();
centerMapOnRoster();
initFilterBar();
initUploadUi();
render();

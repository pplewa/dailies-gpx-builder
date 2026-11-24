import {
  generateDailiesGPX,
  parseGPXToTimeline,
  polylineDistanceMeters,
  resamplePolyline,
} from "./gpx.js";

const STORAGE_DRAFT_KEY = "dailies_gpx_studio_draft_v1";
const STORAGE_PLACES_KEY = "dailies_gpx_studio_places_v1";
const STORAGE_ACTIVITIES_KEY = "dailies_gpx_studio_activities_v1";

const DEFAULT_ACTIVITIES = [
  { name: "Walking", color: "#158052", routeProfile: "foot", badge: "W" },
  { name: "Scooter", color: "#0284c7", routeProfile: "scooter", badge: "S" },
  { name: "Car", color: "#2563eb", routeProfile: "car", badge: "C" },
  { name: "Biking", color: "#d97706", routeProfile: "bike", badge: "B" },
  { name: "Running", color: "#dc2626", routeProfile: "foot", badge: "R" },
  { name: "Transit", color: "#7c3aed", routeProfile: "car", badge: "T" },
  { name: "Move", color: "#475569", routeProfile: "foot", badge: "M" },
];

const BASEMAPS = {
  voyager: {
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution: "&copy; OpenStreetMap &copy; CARTO",
  },
  positron: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: "&copy; OpenStreetMap &copy; CARTO",
  },
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: "&copy; OpenStreetMap &copy; CARTO",
  },
  osm: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
  },
};

function todayLocalKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addMinutesToHHMM(hhmm, deltaMins) {
  const [h, m] = (hhmm || "09:00").split(":").map(Number);
  const total = Math.max(0, Math.min(23 * 60 + 59, (h || 0) * 60 + (m || 0) + deltaMins));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function durationLabel(startHHMM, endHHMM) {
  const [sh, sm] = (startHHMM || "00:00").split(":").map(Number);
  const [eh, em] = (endHHMM || "00:00").split(":").map(Number);
  const mins = Math.max(0, (eh * 60 + em) - (sh * 60 + sm));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const r = mins % 60;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

function formatDistance(meters) {
  if (!meters || meters < 1) return "0 m";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function formatOffsetLabel(mins) {
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${h}:${m}`;
}

// Application State
const state = {
  localDayKey: todayLocalKey(),
  tzOffsetMinutes: -new Date().getTimezoneOffset(),
  segments: [],
  selectedId: null,
  mode: "pin", // "pin" | "draw"
  drawingSegmentId: null,
  savedPlaces: [],
  customActivities: [],
  basemap: "voyager",
};

// DOM Elements
const localDateInput = document.getElementById("localDateInput");
const tzSelect = document.getElementById("tzSelect");
const utcFilenameBadge = document.getElementById("utcFilenameBadge");
const summaryStats = document.getElementById("summaryStats");
const downloadBtnFilename = document.getElementById("downloadBtnFilename");
const timelineList = document.getElementById("timelineList");
const savedPlacesSection = document.getElementById("savedPlacesSection");
const savedPlacesChips = document.getElementById("savedPlacesChips");
const modePinBtn = document.getElementById("modePinBtn");
const modeDrawBtn = document.getElementById("modeDrawBtn");
const importGpxBtn = document.getElementById("importGpxBtn");
const gpxFileInput = document.getElementById("gpxFileInput");
const clearAllBtn = document.getElementById("clearAllBtn");
const clearSavedPlacesBtn = document.getElementById("clearSavedPlacesBtn");
const previewXmlBtn = document.getElementById("previewXmlBtn");
const downloadGpxBtn = document.getElementById("downloadGpxBtn");

const placeSearchForm = document.getElementById("placeSearchForm");
const placeSearchInput = document.getElementById("placeSearchInput");
const searchResults = document.getElementById("searchResults");
const mapModeBanner = document.getElementById("mapModeBanner");
const drawHud = document.getElementById("drawHud");
const drawHudTitle = document.getElementById("drawHudTitle");
const drawHudStats = document.getElementById("drawHudStats");
const drawUndoBtn = document.getElementById("drawUndoBtn");
const drawSnapBtn = document.getElementById("drawSnapBtn");
const drawClearBtn = document.getElementById("drawClearBtn");
const drawDoneBtn = document.getElementById("drawDoneBtn");
const fitBoundsBtn = document.getElementById("fitBoundsBtn");
const locateMeBtn = document.getElementById("locateMeBtn");
const basemapSelect = document.getElementById("basemapSelect");

const xmlModal = document.getElementById("xmlModal");
const xmlModalMeta = document.getElementById("xmlModalMeta");
const xmlPreviewCode = document.getElementById("xmlPreviewCode");
const copyXmlBtn = document.getElementById("copyXmlBtn");
const modalDownloadBtn = document.getElementById("modalDownloadBtn");
const closeXmlModalBtn = document.getElementById("closeXmlModalBtn");
const toastEl = document.getElementById("toast");

let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2800);
}

function getAllActivities() {
  return [...DEFAULT_ACTIVITIES, ...state.customActivities];
}

function getActivityConfig(name) {
  const found = getAllActivities().find(
    (a) => a.name.toLowerCase() === (name || "").toLowerCase()
  );
  if (found) return found;
  return {
    name: name || "Move",
    color: "#475569",
    routeProfile: "car",
    badge: (name || "M").slice(0, 1).toUpperCase(),
  };
}

// Initialize Timezone Select
function initTimezoneSelect() {
  const offsets = [];
  for (let mins = -720; mins <= 840; mins += 30) {
    if (mins % 60 === 0 || mins === 330 || mins === 345 || mins === 570 || mins === -210 || mins === 270) {
      offsets.push(mins);
    }
  }
  if (!offsets.includes(state.tzOffsetMinutes)) {
    offsets.push(state.tzOffsetMinutes);
    offsets.sort((a, b) => a - b);
  }
  tzSelect.innerHTML = offsets
    .map((m) => `<option value="${m}">${formatOffsetLabel(m)}</option>`)
    .join("");
  tzSelect.value = String(state.tzOffsetMinutes);
}

// Persistence
function loadStorage() {
  try {
    const places = JSON.parse(localStorage.getItem(STORAGE_PLACES_KEY) || "[]");
    if (Array.isArray(places)) state.savedPlaces = places;
  } catch {}

  try {
    const acts = JSON.parse(localStorage.getItem(STORAGE_ACTIVITIES_KEY) || "[]");
    if (Array.isArray(acts)) state.customActivities = acts;
  } catch {}

  try {
    const draft = JSON.parse(localStorage.getItem(STORAGE_DRAFT_KEY) || "null");
    if (draft && Array.isArray(draft.segments)) {
      state.localDayKey = draft.localDayKey || todayLocalKey();
      if (typeof draft.tzOffsetMinutes === "number") {
        state.tzOffsetMinutes = draft.tzOffsetMinutes;
      }
      state.segments = draft.segments;
    }
  } catch {}
}

function persistDraft() {
  try {
    localStorage.setItem(
      STORAGE_DRAFT_KEY,
      JSON.stringify({
        localDayKey: state.localDayKey,
        tzOffsetMinutes: state.tzOffsetMinutes,
        segments: state.segments,
      })
    );
  } catch {}
}

function rememberPlace(name, lat, lon) {
  const clean = (name || "").trim();
  if (!clean || clean.toLowerCase() === "place" || clean.toLowerCase().startsWith("place ")) return;
  const idx = state.savedPlaces.findIndex(
    (p) => p.name.toLowerCase() === clean.toLowerCase()
  );
  if (idx >= 0) {
    state.savedPlaces[idx] = { name: clean, lat, lon };
  } else {
    state.savedPlaces.unshift({ name: clean, lat, lon });
    state.savedPlaces = state.savedPlaces.slice(0, 16);
  }
  try {
    localStorage.setItem(STORAGE_PLACES_KEY, JSON.stringify(state.savedPlaces));
  } catch {}
  renderSavedPlaces();
}

// Leaflet Map Setup
const map = L.map("map", { zoomControl: true }).setView([18.8058, 99.019], 15);
let activeTileLayer = L.tileLayer(BASEMAPS.voyager.url, {
  maxZoom: 19,
  attribution: BASEMAPS.voyager.attribution,
}).addTo(map);

const mapLayers = L.layerGroup().addTo(map);
const vertexLayers = L.layerGroup().addTo(map);

function setBasemap(key) {
  const cfg = BASEMAPS[key] || BASEMAPS.voyager;
  map.removeLayer(activeTileLayer);
  activeTileLayer = L.tileLayer(cfg.url, {
    maxZoom: 19,
    attribution: cfg.attribution,
  }).addTo(map);
  state.basemap = key;
}

// Mode Switching
function setMode(newMode, drawingSegId = null) {
  state.mode = newMode;
  state.drawingSegmentId = newMode === "draw" ? drawingSegId : null;
  modePinBtn.classList.toggle("active", newMode === "pin");
  modeDrawBtn.classList.toggle("active", newMode === "draw");

  if (newMode === "draw") {
    mapModeBanner.textContent = "Click map to add route points · Drag white dots to adjust · Right-click dot to remove";
  } else {
    mapModeBanner.textContent = "Click anywhere on the map to drop a stationary pin";
  }
  updateDrawHud();
  renderMap();
  renderTimeline();
}

function updateDrawHud() {
  if (state.mode !== "draw" || !state.drawingSegmentId) {
    drawHud.hidden = true;
    return;
  }
  const seg = state.segments.find((s) => s.id === state.drawingSegmentId);
  if (!seg) {
    drawHud.hidden = true;
    return;
  }
  drawHud.hidden = false;
  drawHudTitle.textContent = `Editing ${seg.activityName || "Move"} Path`;
  const pts = seg.points || [];
  const dist = polylineDistanceMeters(pts);
  drawHudStats.textContent = `${pts.length} pts · ${formatDistance(dist)} — Click map to append, drag handles, right-click to delete`;
}

// Timeline Mutations
function nextDefaultTimes(kind) {
  if (state.segments.length === 0) {
    return kind === "stationary"
      ? { startTime: "00:00", endTime: "09:00" }
      : { startTime: "09:00", endTime: "09:15" };
  }
  const last = state.segments[state.segments.length - 1];
  const start = last.endTime || "09:00";
  const delta = kind === "stationary" ? 45 : 15;
  return { startTime: start, endTime: addMinutesToHHMM(start, delta) };
}

function addStationaryPin(lat, lon, customName = null) {
  const pinCount = state.segments.filter((s) => s.kind === "stationary").length + 1;
  const { startTime, endTime } = nextDefaultTimes("stationary");
  const seg = {
    id: crypto.randomUUID(),
    kind: "stationary",
    name: customName || `Place ${pinCount}`,
    lat,
    lon,
    startTime,
    endTime,
  };
  state.segments.push(seg);
  state.selectedId = seg.id;
  if (customName) rememberPlace(customName, lat, lon);
  persistDraft();
  renderAll();
  return seg;
}

function insertMoveBetween(prevIndex, activityName = "Walking", autoRoute = false) {
  const prev = state.segments[prevIndex];
  const next = state.segments[prevIndex + 1];
  const startTime = prev?.endTime || "09:00";
  let endTime = next?.startTime || addMinutesToHHMM(startTime, 10);
  if (endTime <= startTime) {
    endTime = addMinutesToHHMM(startTime, 10);
    if (next && next.startTime < endTime) {
      next.startTime = endTime;
      if (next.endTime <= next.startTime) {
        next.endTime = addMinutesToHHMM(next.startTime, 30);
      }
    }
  }

  const pts = [];
  if (prev?.kind === "stationary") pts.push({ lat: prev.lat, lon: prev.lon });
  if (next?.kind === "stationary") pts.push({ lat: next.lat, lon: next.lon });

  const move = {
    id: crypto.randomUUID(),
    kind: "move",
    activityName,
    points: pts.length === 2 ? resamplePolyline(pts, 18) : pts,
    startTime,
    endTime,
  };

  state.segments.splice(prevIndex + 1, 0, move);
  state.selectedId = move.id;
  persistDraft();
  renderAll();

  if (autoRoute) {
    void autoRouteMove(move.id);
  }
  return move;
}

function startNewDrawnMove() {
  const { startTime, endTime } = nextDefaultTimes("move");
  const last = state.segments[state.segments.length - 1];
  const initialPts =
    last && last.kind === "stationary" ? [{ lat: last.lat, lon: last.lon }] : [];
  const move = {
    id: crypto.randomUUID(),
    kind: "move",
    activityName: "Walking",
    points: initialPts,
    startTime,
    endTime,
  };
  state.segments.push(move);
  state.selectedId = move.id;
  persistDraft();
  setMode("draw", move.id);
}

function getAdjacentEndpoints(moveId) {
  const idx = state.segments.findIndex((s) => s.id === moveId);
  if (idx < 0) return { start: null, end: null };
  let start = null;
  let end = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (state.segments[i].kind === "stationary") {
      start = { lat: state.segments[i].lat, lon: state.segments[i].lon };
      break;
    }
  }
  for (let i = idx + 1; i < state.segments.length; i++) {
    if (state.segments[i].kind === "stationary") {
      end = { lat: state.segments[i].lat, lon: state.segments[i].lon };
      break;
    }
  }
  return { start, end };
}

async function autoRouteMove(moveId, useExistingWaypoints = false) {
  const seg = state.segments.find((s) => s.id === moveId);
  if (!seg || seg.kind !== "move") return;

  let waypoints = [];
  if (useExistingWaypoints && seg.points && seg.points.length >= 2) {
    // Keep up to 12 evenly spaced control points when snapping a hand-drawn path to roads.
    const raw = seg.points;
    if (raw.length <= 12) {
      waypoints = raw;
    } else {
      for (let i = 0; i < 12; i++) {
        waypoints.push(raw[Math.round((i * (raw.length - 1)) / 11)]);
      }
    }
  } else {
    const { start, end } = getAdjacentEndpoints(moveId);
    if (start && end) {
      waypoints = [start, end];
    } else if (seg.points && seg.points.length >= 2) {
      waypoints = [seg.points[0], seg.points[seg.points.length - 1]];
    }
  }

  if (waypoints.length < 2) {
    showToast("Add a stationary pin before & after this move, or draw 2+ points first.");
    return;
  }

  const cfg = getActivityConfig(seg.activityName);
  const coordsParam = waypoints.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(";");

  showToast(`Routing ${seg.activityName} path...`);
  try {
    const resp = await fetch(
      `/api/route?profile=${encodeURIComponent(cfg.routeProfile)}&coords=${encodeURIComponent(coordsParam)}`
    );
    const data = await resp.json();
    if (!resp.ok || !Array.isArray(data.coordinates) || data.coordinates.length < 2) {
      throw new Error(data.error || "No road route found");
    }
    const spacing = cfg.routeProfile === "foot" ? 12 : 20;
    seg.points = resamplePolyline(data.coordinates, spacing, 500);
    persistDraft();
    renderAll();
    showToast(`Routed ${formatDistance(polylineDistanceMeters(seg.points))} (${seg.points.length} pts)`);
  } catch (err) {
    // Graceful straight-line fallback
    seg.points = resamplePolyline(waypoints, 18, 120);
    persistDraft();
    renderAll();
    showToast(`Router unavailable — generated straight path (${seg.points.length} pts)`);
  }
}

function setStraightPath(moveId) {
  const seg = state.segments.find((s) => s.id === moveId);
  if (!seg || seg.kind !== "move") return;
  const { start, end } = getAdjacentEndpoints(moveId);
  let endpoints = [];
  if (start && end) {
    endpoints = [start, end];
  } else if (seg.points && seg.points.length >= 2) {
    endpoints = [seg.points[0], seg.points[seg.points.length - 1]];
  }
  if (endpoints.length < 2) {
    showToast("Need start & end points for straight line.");
    return;
  }
  seg.points = resamplePolyline(endpoints, 15, 200);
  persistDraft();
  renderAll();
  showToast(`Straight line generated (${seg.points.length} pts)`);
}

function deleteSegment(id) {
  state.segments = state.segments.filter((s) => s.id !== id);
  if (state.drawingSegmentId === id) {
    setMode("pin");
  }
  if (state.selectedId === id) {
    state.selectedId = null;
  }
  persistDraft();
  renderAll();
}

function moveSegmentOrder(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.segments.length) return;
  const [item] = state.segments.splice(index, 1);
  state.segments.splice(target, 0, item);
  persistDraft();
  renderAll();
}

// Rendering
function renderMeta() {
  const pkg = generateDailiesGPX({
    localDayKey: state.localDayKey,
    tzOffsetMinutes: state.tzOffsetMinutes,
    segments: state.segments,
  });
  utcFilenameBadge.textContent = `UTC: ${pkg.filename}`;
  downloadBtnFilename.textContent = pkg.filename;
  const stops = state.segments.filter((s) => s.kind === "stationary").length;
  const moves = state.segments.filter((s) => s.kind === "move").length;
  summaryStats.textContent = `${stops} stop${stops === 1 ? "" : "s"} · ${moves} move${moves === 1 ? "" : "s"}`;
}

function renderSavedPlaces() {
  if (state.savedPlaces.length === 0) {
    savedPlacesSection.hidden = true;
    return;
  }
  savedPlacesSection.hidden = false;
  savedPlacesChips.innerHTML = "";
  for (const place of state.savedPlaces) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "place-chip";
    btn.textContent = `+ ${place.name}`;
    btn.title = `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;
    btn.addEventListener("click", () => {
      addStationaryPin(place.lat, place.lon, place.name);
      map.panTo([place.lat, place.lon]);
    });
    savedPlacesChips.appendChild(btn);
  }
}

function renderTimeline() {
  timelineList.innerHTML = "";

  if (state.segments.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <h3>Start your daily timeline</h3>
      <p>Click anywhere on the map (or search a venue above) to drop your first Stationary pin. Add another pin, then click <strong>Auto-Route</strong> or <strong>Draw</strong> to build exact GPX tracks.</p>
      <button type="button" class="secondary-btn" id="loadExampleBtn">Load Example Day</button>
    `;
    timelineList.appendChild(empty);
    empty.querySelector("#loadExampleBtn").addEventListener("click", loadSampleDay);
    renderMeta();
    return;
  }

  let pinNumber = 0;

  state.segments.forEach((seg, idx) => {
    const card = document.createElement("article");
    card.className = `seg-card kind-${seg.kind}${state.selectedId === seg.id ? " selected" : ""}`;

    if (seg.kind === "stationary") {
      pinNumber += 1;
      const currentPinNum = pinNumber;

      card.innerHTML = `
        <div class="seg-head">
          <span class="pin-badge" title="Focus on map">${currentPinNum}</span>
          <input class="name-input" type="text" value="${escapeAttr(seg.name)}" placeholder="Place name..." />
          <button type="button" class="icon-btn" data-action="up" title="Move up">↑</button>
          <button type="button" class="icon-btn" data-action="down" title="Move down">↓</button>
          <button type="button" class="icon-btn danger" data-action="delete" title="Delete">×</button>
        </div>
        <div class="time-row">
          <input class="time-input" type="time" data-field="startTime" value="${seg.startTime}" />
          <span class="time-sep">→</span>
          <input class="time-input" type="time" data-field="endTime" value="${seg.endTime}" />
          <span class="dur-chip">${durationLabel(seg.startTime, seg.endTime)}</span>
        </div>
        <div class="seg-meta-row">
          <span>${seg.lat.toFixed(5)}, ${seg.lon.toFixed(5)}</span>
          <span>Stationary &lt;wpt&gt;</span>
        </div>
      `;

      const pinBadge = card.querySelector(".pin-badge");
      pinBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        state.selectedId = seg.id;
        map.flyTo([seg.lat, seg.lon], Math.max(map.getZoom(), 16), { duration: 0.45 });
        renderAll();
      });

      const nameInput = card.querySelector(".name-input");
      nameInput.addEventListener("input", (e) => {
        seg.name = e.target.value;
        persistDraft();
        renderMeta();
      });
      nameInput.addEventListener("blur", () => {
        rememberPlace(seg.name, seg.lat, seg.lon);
        renderMap();
      });
    } else {
      const cfg = getActivityConfig(seg.activityName);
      card.style.setProperty("--move-color", cfg.color);
      const pts = seg.points || [];
      const dist = polylineDistanceMeters(pts);
      const isDrawingThis = state.mode === "draw" && state.drawingSegmentId === seg.id;

      const optionsHtml = getAllActivities()
        .map(
          (a) =>
            `<option value="${escapeAttr(a.name)}"${
              a.name.toLowerCase() === (seg.activityName || "").toLowerCase() ? " selected" : ""
            }>${escapeAttr(a.name)}</option>`
        )
        .join("");

      card.innerHTML = `
        <div class="seg-head">
          <span class="move-badge">${escapeAttr(cfg.badge)}</span>
          <select class="activity-select">
            ${optionsHtml}
            <option value="__custom__">+ Custom Move Type...</option>
          </select>
          <button type="button" class="icon-btn" data-action="up" title="Move up">↑</button>
          <button type="button" class="icon-btn" data-action="down" title="Move down">↓</button>
          <button type="button" class="icon-btn danger" data-action="delete" title="Delete">×</button>
        </div>
        <div class="time-row">
          <input class="time-input" type="time" data-field="startTime" value="${seg.startTime}" />
          <span class="time-sep">→</span>
          <input class="time-input" type="time" data-field="endTime" value="${seg.endTime}" />
          <span class="dur-chip">${durationLabel(seg.startTime, seg.endTime)}</span>
        </div>
        <div class="seg-meta-row">
          <span>${formatDistance(dist)} · ${pts.length} pts</span>
          <span>&lt;type&gt;${escapeAttr(seg.activityName.toLowerCase().replace(/\s+/g, "_"))}&lt;/type&gt;</span>
        </div>
        <div class="seg-actions">
          <button type="button" class="mini-btn route-btn" data-action="route">⚡ Auto-Route</button>
          <button type="button" class="mini-btn${isDrawingThis ? " active" : ""}" data-action="draw">${
            isDrawingThis ? "✓ Drawing..." : "✎ Draw / Edit"
          }</button>
          <button type="button" class="mini-btn" data-action="straight">⇄ Straight</button>
        </div>
      `;

      const select = card.querySelector(".activity-select");
      select.addEventListener("change", (e) => {
        if (e.target.value === "__custom__") {
          const customName = prompt("Custom move type name (e.g. Ferry, Hike, Train):");
          if (customName && customName.trim()) {
            const clean = customName.trim();
            if (!getAllActivities().some((a) => a.name.toLowerCase() === clean.toLowerCase())) {
              state.customActivities.push({
                name: clean,
                color: "#0f766e",
                routeProfile: "car",
                badge: clean.slice(0, 1).toUpperCase(),
              });
              localStorage.setItem(STORAGE_ACTIVITIES_KEY, JSON.stringify(state.customActivities));
            }
            seg.activityName = clean;
          }
        } else {
          seg.activityName = e.target.value;
        }
        persistDraft();
        renderAll();
      });

      card.querySelector('[data-action="route"]').addEventListener("click", (e) => {
        e.stopPropagation();
        void autoRouteMove(seg.id, false);
      });
      card.querySelector('[data-action="draw"]').addEventListener("click", (e) => {
        e.stopPropagation();
        if (isDrawingThis) {
          setMode("pin");
        } else {
          state.selectedId = seg.id;
          setMode("draw", seg.id);
        }
      });
      card.querySelector('[data-action="straight"]').addEventListener("click", (e) => {
        e.stopPropagation();
        setStraightPath(seg.id);
      });
    }

    // Shared Time & Order Handlers
    card.querySelectorAll(".time-input").forEach((inp) => {
      inp.addEventListener("change", (e) => {
        seg[e.target.dataset.field] = e.target.value;
        card.querySelector(".dur-chip").textContent = durationLabel(seg.startTime, seg.endTime);
        persistDraft();
        renderMeta();
      });
    });

    card.querySelector('[data-action="up"]').addEventListener("click", (e) => {
      e.stopPropagation();
      moveSegmentOrder(idx, -1);
    });
    card.querySelector('[data-action="down"]').addEventListener("click", (e) => {
      e.stopPropagation();
      moveSegmentOrder(idx, 1);
    });
    card.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSegment(seg.id);
    });

    card.addEventListener("click", () => {
      if (state.selectedId !== seg.id) {
        state.selectedId = seg.id;
        renderMap();
        renderTimeline();
      }
    });

    timelineList.appendChild(card);

    // Between two consecutive stationary pins, show a convenient 1-click "+ Route Move" button!
    const nextSeg = state.segments[idx + 1];
    if (seg.kind === "stationary" && nextSeg && nextSeg.kind === "stationary") {
      const conn = document.createElement("div");
      conn.className = "between-connector";
      conn.innerHTML = `<button type="button" class="insert-move-btn">+ Insert Auto-Routed Move</button>`;
      conn.querySelector("button").addEventListener("click", () => {
        insertMoveBetween(idx, "Walking", true);
      });
      timelineList.appendChild(conn);
    }
  });

  renderMeta();
  updateDrawHud();
}

function renderMap() {
  mapLayers.clearLayers();
  vertexLayers.clearLayers();

  let pinNumber = 0;

  for (const seg of state.segments) {
    if (seg.kind === "move" && seg.points && seg.points.length >= 2) {
      const cfg = getActivityConfig(seg.activityName);
      const isSelected = state.selectedId === seg.id || state.drawingSegmentId === seg.id;
      const latlngs = seg.points.map((p) => [p.lat, p.lon]);

      const line = L.polyline(latlngs, {
        color: cfg.color,
        weight: isSelected ? 6 : 4,
        opacity: isSelected ? 0.95 : 0.78,
        lineJoin: "round",
        lineCap: "round",
      }).addTo(mapLayers);

      line.bindTooltip(`${seg.activityName} · ${formatDistance(polylineDistanceMeters(seg.points))}`, {
        sticky: true,
      });

      line.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        state.selectedId = seg.id;
        renderAll();
      });
    }
  }

  // Draw pins on top of routes
  for (const seg of state.segments) {
    if (seg.kind !== "stationary") continue;
    pinNumber += 1;
    const isSelected = state.selectedId === seg.id;

    const icon = L.divIcon({
      className: "",
      html: `<div class="custom-pin-marker${isSelected ? " selected" : ""}">${pinNumber}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    const marker = L.marker([seg.lat, seg.lon], {
      icon,
      draggable: state.mode !== "draw",
    }).addTo(mapLayers);

    marker.bindTooltip(`${seg.name} (${seg.startTime}–${seg.endTime})`, {
      direction: "top",
      offset: [0, -14],
    });

    marker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      if (state.mode === "draw" && state.drawingSegmentId) {
        // Clicking an existing pin while drawing snaps the route cleanly to that pin!
        appendPointToDrawing(seg.lat, seg.lon);
        return;
      }
      state.selectedId = seg.id;
      renderAll();
    });

    marker.on("dragend", () => {
      const pos = marker.getLatLng();
      seg.lat = pos.lat;
      seg.lon = pos.lng;
      persistDraft();
      renderAll();
    });
  }

  // Render interactive vertex handles while drawing/editing a Move path
  if (state.mode === "draw" && state.drawingSegmentId) {
    const seg = state.segments.find((s) => s.id === state.drawingSegmentId);
    if (seg && seg.points) {
      const step = seg.points.length > 60 ? Math.ceil(seg.points.length / 40) : 1;
      seg.points.forEach((pt, pIdx) => {
        const isEndpoint = pIdx === 0 || pIdx === seg.points.length - 1;
        if (!isEndpoint && pIdx % step !== 0) return;

        const handleIcon = L.divIcon({
          className: "",
          html: `<div class="vertex-handle"></div>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        });
        const handle = L.marker([pt.lat, pt.lon], {
          icon: handleIcon,
          draggable: true,
        }).addTo(vertexLayers);

        handle.on("drag", () => {
          const ll = handle.getLatLng();
          seg.points[pIdx] = { lat: ll.lat, lon: ll.lng };
          updateDrawHud();
        });
        handle.on("dragend", () => {
          const ll = handle.getLatLng();
          seg.points[pIdx] = { lat: ll.lat, lon: ll.lng };
          persistDraft();
          renderAll();
        });
        handle.on("contextmenu", (e) => {
          L.DomEvent.stopPropagation(e);
          seg.points.splice(pIdx, 1);
          persistDraft();
          renderAll();
        });
      });
    }
  }
}

function appendPointToDrawing(lat, lon) {
  const seg = state.segments.find((s) => s.id === state.drawingSegmentId);
  if (!seg) return;
  if (!Array.isArray(seg.points)) seg.points = [];
  seg.points.push({ lat, lon });
  persistDraft();
  renderAll();
}

function fitAllOnMap() {
  const allCoords = [];
  for (const seg of state.segments) {
    if (seg.kind === "stationary") {
      allCoords.push([seg.lat, seg.lon]);
    } else if (seg.points) {
      for (const p of seg.points) allCoords.push([p.lat, p.lon]);
    }
  }
  if (allCoords.length === 0) return;
  if (allCoords.length === 1) {
    map.flyTo(allCoords[0], 16, { duration: 0.45 });
  } else {
    map.fitBounds(L.latLngBounds(allCoords), { padding: [50, 50], maxZoom: 17 });
  }
}

function renderAll() {
  renderTimeline();
  renderMap();
  renderSavedPlaces();
}

function escapeAttr(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Example Day Loader
function loadSampleDay() {
  state.segments = [
    {
      id: crypto.randomUUID(),
      kind: "stationary",
      name: "Escent Condo",
      lat: 18.805682,
      lon: 99.020049,
      startTime: "00:00",
      endTime: "14:00",
    },
    {
      id: crypto.randomUUID(),
      kind: "move",
      activityName: "Walking",
      points: resamplePolyline(
        [
          { lat: 18.805789, lon: 99.019961 },
          { lat: 18.805674, lon: 99.018434 },
          { lat: 18.806049, lon: 99.017586 },
          { lat: 18.806414, lon: 99.017721 },
        ],
        15
      ),
      startTime: "14:00",
      endTime: "14:05",
    },
    {
      id: crypto.randomUUID(),
      kind: "stationary",
      name: "Central Festival",
      lat: 18.806569,
      lon: 99.01797,
      startTime: "14:05",
      endTime: "14:20",
    },
    {
      id: crypto.randomUUID(),
      kind: "move",
      activityName: "Walking",
      points: resamplePolyline(
        [
          { lat: 18.806414, lon: 99.017721 },
          { lat: 18.806049, lon: 99.017586 },
          { lat: 18.805674, lon: 99.018434 },
          { lat: 18.805789, lon: 99.019961 },
        ],
        15
      ),
      startTime: "14:20",
      endTime: "14:25",
    },
    {
      id: crypto.randomUUID(),
      kind: "stationary",
      name: "Escent Condo",
      lat: 18.805682,
      lon: 99.020049,
      startTime: "14:25",
      endTime: "23:59",
    },
  ];
  persistDraft();
  renderAll();
  fitAllOnMap();
  showToast("Loaded sample day — edit pins, redraw routes, or download GPX");
}

// Download GPX
function triggerDownload() {
  if (state.segments.length === 0) {
    showToast("Add at least one pin or move first.");
    return;
  }
  const pkg = generateDailiesGPX({
    localDayKey: state.localDayKey,
    tzOffsetMinutes: state.tzOffsetMinutes,
    segments: state.segments,
  });
  const blob = new Blob([pkg.xml], { type: "application/gpx+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = pkg.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`Downloaded ${pkg.filename}`);
}

// Event Wiring
map.on("click", (e) => {
  searchResults.hidden = true;
  if (state.mode === "draw" && state.drawingSegmentId) {
    appendPointToDrawing(e.latlng.lat, e.latlng.lng);
  } else {
    addStationaryPin(e.latlng.lat, e.latlng.lng);
  }
});

localDateInput.addEventListener("change", (e) => {
  if (e.target.value) {
    state.localDayKey = e.target.value;
    persistDraft();
    renderMeta();
  }
});

tzSelect.addEventListener("change", (e) => {
  state.tzOffsetMinutes = Number(e.target.value);
  persistDraft();
  renderMeta();
});

modePinBtn.addEventListener("click", () => setMode("pin"));
modeDrawBtn.addEventListener("click", () => {
  if (state.mode === "draw") {
    setMode("pin");
  } else {
    const selectedMove = state.segments.find(
      (s) => s.id === state.selectedId && s.kind === "move"
    );
    if (selectedMove) {
      setMode("draw", selectedMove.id);
    } else {
      startNewDrawnMove();
    }
  }
});

importGpxBtn.addEventListener("click", () => gpxFileInput.click());
gpxFileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = parseGPXToTimeline(text, state.tzOffsetMinutes);
    if (imported.localDayKey) {
      state.localDayKey = imported.localDayKey;
      localDateInput.value = state.localDayKey;
    }
    state.segments = imported.segments;
    state.selectedId = null;
    setMode("pin");
    persistDraft();
    renderAll();
    fitAllOnMap();
    showToast(`Imported ${imported.segments.length} segments from ${file.name}`);
  } catch (err) {
    showToast(err.message || "Could not parse GPX file");
  } finally {
    gpxFileInput.value = "";
  }
});

clearAllBtn.addEventListener("click", () => {
  if (state.segments.length === 0) return;
  if (!confirm("Clear all timeline stops and moves?")) return;
  state.segments = [];
  state.selectedId = null;
  setMode("pin");
  persistDraft();
  renderAll();
});

clearSavedPlacesBtn.addEventListener("click", () => {
  state.savedPlaces = [];
  localStorage.removeItem(STORAGE_PLACES_KEY);
  renderSavedPlaces();
});

// Drawing HUD Controls
drawUndoBtn.addEventListener("click", () => {
  const seg = state.segments.find((s) => s.id === state.drawingSegmentId);
  if (seg && seg.points && seg.points.length > 0) {
    seg.points.pop();
    persistDraft();
    renderAll();
  }
});

drawSnapBtn.addEventListener("click", () => {
  if (state.drawingSegmentId) {
    void autoRouteMove(state.drawingSegmentId, true);
  }
});

drawClearBtn.addEventListener("click", () => {
  const seg = state.segments.find((s) => s.id === state.drawingSegmentId);
  if (seg) {
    seg.points = [];
    persistDraft();
    renderAll();
  }
});

drawDoneBtn.addEventListener("click", () => setMode("pin"));

// Map Controls
fitBoundsBtn.addEventListener("click", fitAllOnMap);
locateMeBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    showToast("Geolocation not supported in this browser");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      map.flyTo([pos.coords.latitude, pos.coords.longitude], 15, { duration: 0.6 });
    },
    () => showToast("Could not get browser location")
  );
});

basemapSelect.addEventListener("change", (e) => setBasemap(e.target.value));

// Place Search
placeSearchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = placeSearchInput.value.trim();
  if (q.length < 2) return;
  const center = map.getCenter();
  searchResults.innerHTML = "<li><strong>Searching...</strong></li>";
  searchResults.hidden = false;

  try {
    const resp = await fetch(
      `/api/search?q=${encodeURIComponent(q)}&lat=${center.lat.toFixed(5)}&lon=${center.lng.toFixed(5)}`
    );
    const data = await resp.json();
    const items = data.results || [];
    if (items.length === 0) {
      searchResults.innerHTML = "<li><strong>No matches found</strong><span>Try a broader name</span></li>";
      return;
    }
    searchResults.innerHTML = "";
    for (const item of items) {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${escapeAttr(item.name)}</strong><span>${escapeAttr(item.displayName)}</span>`;
      li.addEventListener("click", () => {
        searchResults.hidden = true;
        placeSearchInput.value = "";
        addStationaryPin(item.lat, item.lon, item.name);
        map.flyTo([item.lat, item.lon], 16, { duration: 0.5 });
      });
      searchResults.appendChild(li);
    }
  } catch {
    searchResults.innerHTML = "<li><strong>Search failed</strong><span>Check connection and retry</span></li>";
  }
});

// XML Preview Modal
previewXmlBtn.addEventListener("click", () => {
  const pkg = generateDailiesGPX({
    localDayKey: state.localDayKey,
    tzOffsetMinutes: state.tzOffsetMinutes,
    segments: state.segments,
  });
  xmlModalMeta.textContent = `${pkg.filename} · ${pkg.xml.length.toLocaleString()} bytes · Strict UTC ISO-8601`;
  xmlPreviewCode.textContent = pkg.xml;
  xmlModal.hidden = false;
});

closeXmlModalBtn.addEventListener("click", () => {
  xmlModal.hidden = true;
});

xmlModal.addEventListener("click", (e) => {
  if (e.target === xmlModal) xmlModal.hidden = true;
});

copyXmlBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(xmlPreviewCode.textContent || "");
    showToast("Copied GPX XML to clipboard");
  } catch {
    showToast("Copy failed");
  }
});

downloadGpxBtn.addEventListener("click", triggerDownload);
modalDownloadBtn.addEventListener("click", triggerDownload);

// Boot
loadStorage();
initTimezoneSelect();
localDateInput.value = state.localDayKey;
renderAll();
if (state.segments.length > 0) {
  fitAllOnMap();
}

/* Daily v0.1 — Sharp, keyboard-first frontend (zero presets, signed +/- graph, TabPFN + Liquid ODE, DE/EN) */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const t = (key, vars) => (window.DailyI18n ? window.DailyI18n.t(key, vars) : key);
const getLocale = () => (window.DailyI18n ? window.DailyI18n.getLocale() : "de-DE");
const dimName = (d) => (window.DailyI18n ? window.DailyI18n.dimName(d) : d ? d.name : "");
const dimLow = (d) => (window.DailyI18n ? window.DailyI18n.dimLow(d) : d ? d.low_label || "" : "");
const dimHigh = (d) => (window.DailyI18n ? window.DailyI18n.dimHigh(d) : d ? d.high_label || "" : "");
const DEFAULT_DIM_COLORS = {
  stimmung: "#368470",
  "mental-fit": "#3d6b7d",
  stress: "#c85a44",
  anspannung: "#b4783c",
  antrieb: "#6e68a8",
  kraempfe: "#a85d73",
};
const CORE_EVERYDAY_DIMS = new Set(["stimmung", "mental-fit", "stress", "anspannung", "antrieb"]);
const dimColor = (d) => (d && d.color && /^#[0-9a-fA-F]{6}$/.test(d.color) ? d.color : DEFAULT_DIM_COLORS[d && d.id] || "#3d6b7d");

function parseMoodGroups(settingsObj) {
  const raw = settingsObj && settingsObj.mood_groups;
  if (raw) {
    try {
      const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(arr)) {
        return arr
          .filter((g) => g && g.id && g.name && Array.isArray(g.dim_ids))
          .map((g) => ({ id: String(g.id), name: String(g.name), dim_ids: g.dim_ids.map(String) }));
      }
    } catch {}
  }
  return [];
}

function moodGroupLabel(g) {
  if (!g) return "";
  if (g.id === "alltag" && g.name === "Alltag") return t("mg_default_alltag");
  if (g.id === "zyklus" && g.name === "Zyklus") return t("mg_default_zyklus");
  return g.name;
}

// Anti-muddy composite mood color: pick the 1-2 most salient rated axes (ignoring low 1/5 "none" values)
// and build a crisp two-tone orb + whisper-soft row wash instead of averaging 5 colors into brown!
function computeMoodComposite(ratings, dimsById) {
  const entries = Object.entries(ratings || {})
    .filter(([, v]) => v != null && !Number.isNaN(Number(v)))
    .map(([did, v]) => {
      const dim = dimsById[did] || { id: did, sort_order: 99 };
      const val = Number(v);
      return {
        did,
        val,
        salience: Math.max(0, val - 1.5),
        color: dimColor(dim),
        order: Number(dim.sort_order ?? 99),
      };
    });
  if (!entries.length) {
    return { c1: "var(--ai)", c2: "var(--ai)", orbBg: "var(--ai)", orbOpacity: 0.7 };
  }
  entries.sort((a, b) => b.salience - a.salience || b.val - a.val || a.order - b.order);
  const salient = entries.filter((x) => x.salience > 0.05);
  if (!salient.length) {
    // All rated axes are low (1/5): show calm muted tint of the first rated axis
    const c = entries[0].color;
    return { c1: c, c2: c, orbBg: c, orbOpacity: 0.5 };
  }
  if (salient.length === 1 || salient[0].color === salient[1].color) {
    const c = salient[0].color;
    return { c1: c, c2: c, orbBg: c, orbOpacity: 0.94 };
  }
  const a = salient[0];
  const b = salient[1];
  const ratio = a.salience / (a.salience + b.salience);
  const splitLo = Math.max(12, Math.min(72, Math.round(ratio * 100 - 15)));
  const splitHi = Math.max(28, Math.min(88, Math.round(ratio * 100 + 15)));
  return {
    c1: a.color,
    c2: b.color,
    orbBg: `linear-gradient(135deg, ${a.color} 0%, ${a.color} ${splitLo}%, ${b.color} ${splitHi}%, ${b.color} 100%)`,
    orbOpacity: 0.96,
  };
}
const windowLabel = (w) => t(`win_short_${w || "any"}`);
const weekdayShort = (idx) => t(`wd_${idx}`);
const periodShort = (p) => (p === "week" ? t("per_badge_week") : p === "month" ? t("per_badge_month") : "");
const periodSub = (p) => t(`per_sub_${p || "day"}`);

const state = {
  tab: "today",
  day: localDateISO(new Date()),
  todayData: null,
  habits: [],
  archivedHabits: [],
  stateDims: [],
  archivedDims: [],
  edges: [],
  settings: {},
  tags: [],
  filterKind: localStorage.getItem("daily_today_focus") === "1" ? "focus" : "all",
  filterQuery: "",
  sortMode: localStorage.getItem("daily_sort_mode") === "manual" ? "manual" : "smart",
  showDormantToday: false,
  showInactiveMatrix: false,
  showEmptyRhythms: false,
  lastMatrixData: null,
  toggledFocus: [],
  selectedStateCurveId: null,
  lastStateCurves: [],
  lastTimelineMeta: null,
  selectedChartTag: null,
  selectedChartHabitId: null,
  chartView: null, // continuous pan/zoom viewport { startHr, endHr } relative to today 00:00
  matrixEndDay: null, // null = latest 7 days ending today; or "YYYY-MM-DD" when paging back
  stateZoom: localStorage.getItem("daily_state_zoom") || "d14",
  showTabpfnLine: localStorage.getItem("daily_show_tabpfn") !== "0",
  showOdeLine: localStorage.getItem("daily_show_ode") !== "0",
  showRhythmObs: localStorage.getItem("daily_rhythm_show_obs") !== "0",
  showRhythmAi: localStorage.getItem("daily_rhythm_show_ai") !== "0",
  lastRhythmsData: null,
  retroWindowMin: 180,
  retroAmounts: {},
  moodRatings: {},
  moodCauses: new Set(),
  moodGroups: [],
  activeMoodGroup: "alltag",
  mgDraftDims: new Set(),
  editingDimId: null,
  editingSnapId: null,
  editingEvent: null,
  logEventsById: {},
  logSnapsById: {},
  expandedLogEventId: null,
  analysisBoard: null,
  analysisBoardPromise: null,
  logRange: null, // null = single day (state.day); or { start: "YYYY-MM-DD", end: "YYYY-MM-DD" }
  logRangeData: null,
  routeFilterQuery: "",
  openRouteClusters: new Set(),
  routeClustersAllOpen: null, // null = auto (open if <= 8 edges, else collapsed), true/false = explicit toggle
  closedHabitGroups: new Set(),
};

// ---- Cross-Device Auth, Server Base URL & Offline-First Queue ----
function getDeviceId() {
  let id = localStorage.getItem("daily_device_id");
  if (!id) {
    id = "dev-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem("daily_device_id", id);
  }
  return id;
}

function makeUuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "ev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function getServerBase() {
  const custom = (localStorage.getItem("daily_server_url") || "").trim().replace(/\/+$/, "");
  if (custom) return custom;
  if (window.location.protocol === "capacitor:" || window.location.protocol === "file:") {
    return "http://127.0.0.1:8090";
  }
  return "";
}

function getSyncToken() {
  return (localStorage.getItem("daily_sync_token") || "").trim();
}

function capturePairingParams() {
  try {
    const u = new URL(window.location.href);
    const tok = u.searchParams.get("token");
    const srv = u.searchParams.get("server");
    let changed = false;
    if (tok) {
      localStorage.setItem("daily_sync_token", tok.trim());
      u.searchParams.delete("token");
      changed = true;
    }
    if (srv) {
      localStorage.setItem("daily_server_url", srv.trim().replace(/\/+$/, ""));
      u.searchParams.delete("server");
      changed = true;
    }
    if (changed && window.history && window.history.replaceState) {
      window.history.replaceState({}, "", u.pathname + u.search + u.hash);
    }
  } catch {}
}

function loadOfflineQueue() {
  try {
    return JSON.parse(localStorage.getItem("daily_offline_queue") || "[]");
  } catch {
    return [];
  }
}

function saveOfflineQueue(q) {
  localStorage.setItem("daily_offline_queue", JSON.stringify(q));
  updateSyncPill();
}

function loadOfflineSnapshots() {
  try {
    return JSON.parse(localStorage.getItem("daily_offline_snapshots") || "[]");
  } catch {
    return [];
  }
}

function saveOfflineSnapshots(q) {
  localStorage.setItem("daily_offline_snapshots", JSON.stringify(q));
  updateSyncPill();
}

function updateSyncPill() {
  const pill = $("#sync-pill");
  if (!pill) return;
  const total = loadOfflineQueue().length + loadOfflineSnapshots().length;
  if (!navigator.onLine) {
    pill.textContent = total ? `Offline · ${total}` : "Offline";
    pill.classList.remove("hidden");
  } else if (total) {
    pill.textContent = `Sync (${total})`;
    pill.classList.remove("hidden");
  } else {
    pill.classList.add("hidden");
  }
}

async function flushOfflineQueue(silent = true) {
  const qEv = loadOfflineQueue();
  const qSn = loadOfflineSnapshots();
  const total = qEv.length + qSn.length;
  if (!total) {
    updateSyncPill();
    return 0;
  }
  try {
    const res = await api("/api/sync", {
      method: "POST",
      body: JSON.stringify({
        device_id: getDeviceId(),
        mutations: { events: qEv, snapshots: qSn },
      }),
    });
    saveOfflineQueue([]);
    saveOfflineSnapshots([]);
    const nApplied = (res.applied.events || 0) + (res.applied.snapshots || 0);
    if (!silent) toast(t("sync_done_n", { n: nApplied || total }));
    return total;
  } catch (err) {
    updateSyncPill();
    if (!silent) toast(t("sync_deferred", { msg: err.message }));
    return 0;
  }
}

function localDateISO(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTimeHHMM(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatEventTimeRange(ev) {
  const iso = String(ev && ev.occurred_at ? ev.occurred_at : "");
  const endHHMM = iso.slice(11, 16) || "—";
  const win = Number(ev && ev.window_minutes ? ev.window_minutes : 0);
  if (!win || win <= 0 || (ev && ev.source === "retro")) return endHHMM;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return endHHMM;
  const endDt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const startDt = new Date(endDt.getTime() - win * 60000);
  return `${localTimeHHMM(startDt)}–${endHHMM}`;
}

function shiftDate(iso, deltaDays) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + deltaDays);
  return localDateISO(dt);
}

function fmtNum(v) {
  const n = Number(v || 0);
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}

function habitTapStep(h) {
  const s = Number(h && h.tap_step);
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) / 1000 : 1;
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer = null;
function toast(msg, opts = {}) {
  const el = $("#toast");
  el.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = msg;
  el.appendChild(span);

  if (opts.undoEventId) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-undo";
    btn.textContent = t("undo");
    btn.addEventListener("click", async () => {
      el.classList.add("hidden");
      try {
        await api(`/api/events/${opts.undoEventId}`, { method: "DELETE" });
        toast(t("undone"));
        if (state.tab === "today") await loadToday();
        if (state.tab === "analysis") await loadAnalysis();
      } catch (err) {
        toast(t("err_prefix", { msg: err.message }));
      }
    });
    el.appendChild(btn);
  }

  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  const dur = opts.durationMs || (opts.undoEventId ? 5000 : 2600);
  toastTimer = setTimeout(() => el.classList.add("hidden"), dur);
}

function isStandaloneBrowserMode() {
  return !!(window.DailyLocalEngine && window.DailyLocalEngine.isStaticHost());
}

let e2eeDebounceTimer = null;
function scheduleBrowserE2EESync() {
  if (!isStandaloneBrowserMode() || !window.DailyE2EE) return;
  const cfg = window.DailyE2EE.loadCfg();
  if (!cfg.enabled || !cfg.key_b64u) return;
  clearTimeout(e2eeDebounceTimer);
  e2eeDebounceTimer = setTimeout(async () => {
    try {
      await window.DailyE2EE.syncBrowserVault();
    } catch {}
  }, 2500);
}

async function api(url, opts = {}) {
  if (isStandaloneBrowserMode()) {
    const res = window.DailyLocalEngine.request(url, opts);
    const m = (opts.method || "GET").toUpperCase();
    if (m !== "GET") scheduleBrowserE2EESync();
    return res;
  }
  const fullUrl = url.startsWith("http") ? url : `${getServerBase()}${url}`;
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const tok = getSyncToken();
  if (tok) headers["X-Daily-Token"] = tok;
  const res = await fetch(fullUrl, {
    ...opts,
    headers,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = j.detail || detail;
    } catch {}
    throw new Error(detail);
  }
  return res.json();
}

// ---- Theme ----
function initTheme() {
  if (localStorage.getItem("daily_theme") === "dark") {
    document.body.classList.add("dark");
  }
  $("#btn-theme").addEventListener("click", () => {
    document.body.classList.toggle("dark");
    localStorage.setItem("daily_theme", document.body.classList.contains("dark") ? "dark" : "light");
    if (routingGraph) routingGraph.refreshTheme();
  });
}

// ---- Tabs ----
function setTab(tab) {
  state.tab = tab;
  $$("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${tab}`));
  if (tab === "today") loadToday();
  if (tab === "setup") loadSetup();
  if (tab === "analysis") loadAnalysis();
}

function formatDayHeadline(iso) {
  const todayIso = localDateISO(new Date());
  const yestIso = shiftDate(todayIso, -1);
  const tomIso = shiftDate(todayIso, 1);
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const formatted = dt.toLocaleDateString(getLocale(), { weekday: "short", day: "numeric", month: "short" });
  if (iso === todayIso) return `${t("today")} · ${formatted}`;
  if (iso === yestIso) return `${t("yesterday")} · ${formatted}`;
  if (iso === tomIso) return `${t("tomorrow")} · ${formatted}`;
  return formatted;
}

// ---- TODAY VIEW ----
function syncSortUI() {
  $$("#today-sort-switch [data-sort]").forEach((b) => {
    b.classList.toggle("active", b.dataset.sort === state.sortMode);
  });
}

async function loadToday() {
  $("#day-picker").value = state.day;
  const lbl = $("#day-title-label");
  if (lbl) lbl.textContent = formatDayHeadline(state.day);
  const goBtn = $("#btn-go-today");
  if (goBtn) goBtn.classList.toggle("hidden", state.day === localDateISO(new Date()));
  syncSortUI();
  try {
    await flushOfflineQueue(true);
    const [data, meta] = await Promise.all([
      api(`/api/today?day=${encodeURIComponent(state.day)}`),
      api("/api/habits"),
    ]);
    state.todayData = data;
    state.habits = data.habits;
    state.edges = data.active_edges || meta.edges || [];
    state.settings = meta.settings || {};
    state.tags = meta.tags || [];
    localStorage.setItem(`daily_today_cache_${state.day}`, JSON.stringify(data));
    syncRoutingModeUI(data.routing_mode || state.settings.routing_mode || "observed");
    syncNudgeModeUI(state.settings.nudge_mode || "observed");
    renderToday(data);
    if (!qcColorDirty) syncQuickCreateColor();
    if (state.logRange) {
      await loadLogRange(state.logRange.start, state.logRange.end);
    }
  } catch (err) {
    const cached = localStorage.getItem(`daily_today_cache_${state.day}`);
    if (cached) {
      const data = JSON.parse(cached);
      state.todayData = data;
      state.habits = data.habits || [];
      renderToday(data);
      updateSyncPill();
    } else {
      toast(t("conn_prefix", { msg: err.message }));
    }
  }
}

function kindBadgeText(h) {
  const per = periodShort(h.target_period || "day");
  if (h.kind === "min") {
    if (h.target != null) return `↑ ≥ ${fmtNum(h.target)} ${h.unit}${per}`;
    return h.unit && h.unit !== "x" ? `${t("badge_min_open")} · ${h.unit}${per}` : `${t("badge_min_open")}${per}`;
  }
  if (h.kind === "max") {
    if (h.target != null) return `↓ ≤ ${fmtNum(h.target)} ${h.unit}${per}`;
    return h.unit && h.unit !== "x" ? `${t("badge_max_open")} · ${h.unit}${per}` : `${t("badge_max_open")}${per}`;
  }
  return h.unit && h.unit !== "x" ? h.unit : t("kind_neutral");
}

function kindBadgeClass(h) {
  if (h.target != null && h.kind !== "neutral") return h.status || "neutral";
  if (h.kind === "min") return "kind-min";
  if (h.kind === "max") return "kind-max";
  return "neutral";
}

function barPercentAndColor(h) {
  if (h.target == null || h.kind === "neutral") return null;
  const t = Number(h.target);
  const eff = Math.max(0, Number(h.period_effective ?? h.effective));
  if (h.kind === "min") {
    const pct = t > 0 ? Math.min(100, (eff / t) * 100) : 100;
    return { pct, color: eff >= t ? "var(--pos)" : h.color };
  }
  if (t <= 0) {
    return { pct: eff > 0 ? 100 : 0, color: eff > 0 ? "var(--neg)" : "var(--pos)" };
  }
  const pct = Math.min(100, (eff / t) * 100);
  const color = eff > t ? "var(--neg)" : eff >= t * 0.8 ? "var(--warn)" : "var(--pos)";
  return { pct, color };
}

function clearRouteHighlight() {
  $$("#habit-grid .habit-card").forEach((c) => {
    c.classList.remove("route-dim", "route-focus", "route-glow-pos", "route-glow-neg");
  });
}

function applyRouteHighlight(focusId) {
  const rollups = state.edges.filter((e) => e.relation_type === "rollup");
  const related = new Map(); // neighborId -> sign (+1 or -1)
  for (const e of rollups) {
    if (e.source_id === focusId) related.set(e.target_id, e.weight >= 0 ? 1 : -1);
    if (e.target_id === focusId) related.set(e.source_id, e.weight >= 0 ? 1 : -1);
  }
  if (!related.size) return;

  $$("#habit-grid .habit-card").forEach((card) => {
    const cid = card.dataset.id;
    if (cid === focusId) {
      card.classList.add("route-focus");
    } else if (related.has(cid)) {
      card.classList.add(related.get(cid) > 0 ? "route-glow-pos" : "route-glow-neg");
    } else {
      card.classList.add("route-dim");
    }
  });
}

function getConnectedNeighbors(focusId) {
  const rollups = state.edges.filter((e) => e.relation_type === "rollup");
  const out = [];
  const seen = new Set();
  for (const e of rollups) {
    if (e.target_id === focusId && !seen.has(`in:${e.source_id}`)) {
      seen.add(`in:${e.source_id}`);
      out.push({ id: e.source_id, weight: Number(e.weight), dir: "in", isAi: !!e.is_ai });
    }
    if (e.source_id === focusId && !seen.has(`out:${e.target_id}`)) {
      seen.add(`out:${e.target_id}`);
      out.push({ id: e.target_id, weight: Number(e.weight), dir: "out", isAi: !!e.is_ai });
    }
  }
  return out;
}

function formatDurationMin(totalMin) {
  const m = Math.max(1, Math.round(Number(totalMin) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function elapsedMinutesSince(iso) {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.round(ms / 60000)) : 1;
}

function renderHabitCardHtml(h, opts = {}) {
  const bar = barPercentAndColor(h);
  const neighbors = getConnectedNeighbors(h.id);
  const hasLinks = neighbors.length > 0;
  const isToggled = state.toggledFocus.includes(h.id);
  const isActive = !!(h.active_since && String(h.active_since).trim());
  const activeMins = isActive ? elapsedMinutesSince(h.active_since) : 0;
  const activeDurTxt = isActive ? formatDurationMin(activeMins) : "";
  const hasBlockMode = !!(h.block_minutes && Number(h.block_minutes) > 0) || isActive;

  const aiPrefix = `${t("mode_ai")} `;
  const contribHtml = h.contributors.length
    ? h.contributors
        .map((c) => {
          const cls = c.is_ai ? "ai-chip" : c.delta >= 0 ? "pos-chip" : "neg-chip";
          const pfx = c.is_ai ? aiPrefix : "";
          const viaList = Array.isArray(c.via) && c.via.length ? c.via : [];
          const viaHtml = viaList.length
            ? ` <span class="chip-via">· ${esc(t("flow_via", { name: viaList.join(", ") }))}</span>`
            : "";
          return `<span class="chip ${cls}">${pfx}${c.delta >= 0 ? "+" : ""}${fmtNum(c.delta)} ${esc(c.from_name)}${viaHtml}</span>`;
        })
        .join("")
    : "";
  const routesHtml = h.routes_to
    .map((r) => {
      const cls = r.is_ai ? "ai-chip" : r.weight >= 0 ? "pos-chip" : "neg-chip";
      const pfx = r.is_ai ? aiPrefix : "";
      const tip =
        r.is_ai && r.prior_weight != null
          ? `title="Prior: ${r.prior_weight >= 0 ? "+" : ""}${fmtNum(r.prior_weight)} → ${t("mode_ai")}: ${r.weight >= 0 ? "+" : ""}${fmtNum(r.weight)}"`
          : "";
      return `<span class="chip route-out-chip ${cls}" ${tip}>${pfx}${r.weight >= 0 ? "+" : ""}${fmtNum(r.weight)} ${esc(r.target_name)}</span>`;
    })
    .join("");
  const flowRowsHtml = [
    contribHtml
      ? `<div class="hc-flow-row hc-flow-in"><span class="hc-flow-lbl">${esc(t("flow_in_lbl"))}</span><div class="hc-flow-chips">${contribHtml}</div></div>`
      : "",
    routesHtml
      ? `<div class="hc-flow-row hc-flow-out"><span class="hc-flow-lbl">${esc(t("flow_out_lbl"))}</span><div class="hc-flow-chips">${routesHtml}</div></div>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  const per = h.target_period || "day";
  const heroVal = per !== "day" && h.period_effective != null ? h.period_effective : h.effective;
  const subLine =
    per !== "day"
      ? t("card_period_sub", { per: periodSub(per), today: fmtNum(h.effective) })
      : h.routed !== 0
      ? t("card_direct_routed", { d: fmtNum(h.direct), r: `${h.routed > 0 ? "+" : ""}${fmtNum(h.routed)}` })
      : t("card_times_today", { n: h.event_count });
  const denomHtml =
    h.target != null && h.kind !== "neutral"
      ? `<span class="hc-denom">/ ${fmtNum(h.target)}${periodShort(per)}</span>`
      : h.unit && h.unit !== "x"
      ? `<span class="hc-denom">${esc(h.unit)}</span>`
      : "";

  const relTag = opts.relBadge || "";
  const caret = hasLinks
    ? `<span class="toggle-caret" title="${esc(t("card_caret_title"))}">${isToggled ? "▾" : "▸"}</span>`
    : "";
  const extraCls = [
    hasLinks ? "is-clickable" : "",
    opts.asAnchor && isToggled ? "is-toggled" : "",
    isActive ? "is-active" : "",
    opts.softDim ? "card-soft-dim" : "",
    opts.synergy ? "card-synergy" : "",
    opts.relGlow || "",
  ]
    .filter(Boolean)
    .join(" ");

  const activePillHtml = isActive
    ? `<span class="active-chip" data-active-since="${esc(h.active_since)}" data-active-id="${esc(h.id)}" title="${esc(t("session_edit_start_title"))}"><span class="active-dot"></span><span data-active-txt="1">${esc(t("active_badge", { dur: activeDurTxt }))}</span></span>`
    : "";

  const sessionBtnHtml = hasBlockMode
    ? isActive
      ? `<button class="btn sm btn-session-on" data-act="toggle-active" data-id="${esc(h.id)}" data-active-btn="${esc(h.active_since)}" title="${esc(t("btn_stop_title", { since: String(h.active_since).slice(11, 16) }))}">■ ${esc(activeDurTxt)}</button>`
      : `<button class="btn sm btn-session" data-act="toggle-active" data-id="${esc(h.id)}" title="${esc(t("btn_start_title", { m: h.block_minutes || 30 }))}">${esc(t("btn_start_session"))}</button>`
    : "";

  return `
  <div class="habit-card status-${esc(h.status)} ${extraCls}" style="--card-accent:${esc(h.color)}" data-id="${esc(h.id)}" data-has-links="${hasLinks ? "1" : "0"}">
    <div class="hc-top">
      <span class="hc-name">${esc(h.name)}${caret}</span>
      <div class="row-inline hc-badges">${activePillHtml}${relTag}<span class="badge ${esc(kindBadgeClass(h))}">${esc(kindBadgeText(h))}</span></div>
    </div>
    <div class="hc-metrics">
      <span class="hc-val-wrap"><span class="hc-big">${fmtNum(heroVal)}</span>${denomHtml}</span>
      <span class="hc-sub">${esc(subLine)}</span>
    </div>
    ${
      bar
        ? `<div class="bar-track"><div class="bar-fill" style="width:${bar.pct}%;background:${bar.color}"></div></div>`
        : ""
    }
    ${flowRowsHtml ? `<div class="hc-routes">${flowRowsHtml}</div>` : ""}
    <div class="hc-actions">
      ${sessionBtnHtml}
      <button class="btn sm btn-tap" data-act="tap" data-id="${esc(h.id)}">+${fmtNum(habitTapStep(h))}</button>
      <button class="btn sm btn-subtle" data-act="custom" data-id="${esc(h.id)}" title="${esc(t("card_custom_title"))}">${esc(t("card_custom_btn"))}</button>
      <button class="btn sm btn-subtle icon-btn" data-act="edit" data-id="${esc(h.id)}" title="${esc(t("card_edit_title"))}">⇄</button>
    </div>
  </div>`;
}

function buildDailyLogoSvg(progress = 1) {
  const p = Math.max(0.38, Math.min(1, Number(progress)));
  const mt = 1 - p;
  // Cubic Bezier M 52 134 C 74 126, 104 102, 138 58
  const bx = (mt ** 3) * 52 + 3 * (mt ** 2) * p * 74 + 3 * mt * (p ** 2) * 104 + (p ** 3) * 138;
  const by = (mt ** 3) * 134 + 3 * (mt ** 2) * p * 126 + 3 * mt * (p ** 2) * 102 + (p ** 3) * 58;
  const x = bx.toFixed(1);
  const y = by.toFixed(1);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" fill="none">` +
    `<path d="M 159.05 121.47 A 68 68 0 1 1 93.63 28.04" stroke="#7c928c" stroke-opacity="0.62" stroke-width="10" stroke-linecap="round"/>` +
    `<path d="M 52 134 C 74 126 104 102 138 58" stroke="#3d8672" stroke-opacity="0.88" stroke-width="12" stroke-linecap="round"/>` +
    `<circle cx="52" cy="134" r="16.5" fill="#d65644" fill-opacity="0.22"/>` +
    `<circle cx="52" cy="134" r="10.2" fill="#d65644"/>` +
    `<circle cx="${x}" cy="${y}" r="28" fill="#368470" fill-opacity="0.24"/>` +
    `<circle cx="${x}" cy="${y}" r="17.5" fill="#368470"/>` +
    `</svg>`;
}

function updateBrandMark(dayData) {
  try {
    const events = (dayData && dayData.events) || [];
    const posCount = events.filter((ev) => Number(ev.amount) > 0).length;
    const progress = posCount <= 0 ? 0.42 : Math.min(1, 0.42 + 0.58 * (1 - Math.exp(-posCount / 1.8)));
    const svg = buildDailyLogoSvg(progress);
    const slot = $("#brand-logo");
    if (slot) slot.innerHTML = svg;
    const fav = $("#dynamic-favicon");
    if (fav) fav.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch {}
}

function renderNoteWithTags(raw) {
  return esc(raw || "").replace(/(^|\s)(#[a-zA-Z0-9äöüÄÖÜß_-]{2,24})/g, '$1<span class="tag-pill">$2</span>');
}

function noteHasTag(text, tag) {
  const escaped = String(tag || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)#${escaped}(?=\\s|$|[.,;:!?])`, "i").test(String(text || ""));
}

function toggleTagInInput(inputEl, tag) {
  if (!inputEl || !tag) return;
  const val = String(inputEl.value || "");
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\s)#${escaped}(?=\\s|$|[.,;:!?])`, "gi");
  if (re.test(val)) {
    inputEl.value = val.replace(re, "$1").replace(/\s{2,}/g, " ").trim();
  } else {
    const trimmed = val.trim();
    inputEl.value = trimmed ? `${trimmed} #${tag}` : `#${tag}`;
  }
  inputEl.focus();
}

function renderTagSuggestChips(containerSel, inputSel) {
  const box = $(containerSel);
  const inp = $(inputSel);
  if (!box || !inp) return;
  const tags = state.tags || [];
  if (!tags.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  const curVal = inp.value || "";
  box.innerHTML = tags
    .slice(0, 8)
    .map((tg) => {
      const sel = noteHasTag(curVal, tg.tag);
      const tip = tg.ai_active
        ? t("tag_ai_active_tip", { tag: tg.tag, n: tg.days })
        : t("tag_ai_pending_tip", { tag: tg.tag, n: tg.days });
      return `<button type="button" class="tag-suggest-chip ${tg.ai_active ? "is-ai" : ""} ${sel ? "selected" : ""}" data-tag-pick="${esc(tg.tag)}" data-tag-input="${esc(inputSel)}" data-tag-box="${esc(containerSel)}" title="${esc(tip)}">#${esc(tg.tag)} <span class="tag-days">${tg.days}${esc(t("day_short"))}</span></button>`;
    })
    .join("");
}

function evaluateSelectionFit(habitId, selectedIds, byId) {
  let posHits = 0;
  let negHits = 0;
  let netWeight = 0;
  const rels = [];
  for (const anchorId of selectedIds) {
    if (anchorId === habitId) continue;
    const anchor = byId[anchorId];
    if (!anchor) continue;
    const conns = getConnectedNeighbors(anchorId).filter((r) => r.id === habitId);
    for (const r of conns) {
      // For a "Weniger" (max) anchor, negative edges reduce it (helpful!); for "Mehr"/Neutral, positive edges help!
      const effectiveW = anchor.kind === "max" ? -Number(r.weight || 0) : Number(r.weight || 0);
      if (effectiveW > 0) posHits += 1;
      else if (effectiveW < 0) negHits += 1;
      netWeight += effectiveW;
      rels.push({ ...r, anchorId, anchorName: anchor.name, effectiveW });
    }
  }
  return { posHits, negHits, netWeight, rels };
}

function isHabitDormantNow(h, selectedIds, connectedToSelected) {
  if (h.active_since) return false;
  if (Number(h.direct || 0) !== 0 || Number(h.routed || 0) !== 0) return false;
  if (selectedIds.includes(h.id) || connectedToSelected.has(h.id)) return false;
  if (Number(h.days_since_created ?? 0) < 7) return false;
  if (h.target != null && (h.target_period || "day") === "day") return false;
  const med = h.median_interval_days != null ? Number(h.median_interval_days) : null;
  const sinceLast = h.days_since_last != null ? Number(h.days_since_last) : null;
  // Rare multi-week / multi-month cadence (e.g. Psilocybin every 3-6 months): fold right away until ~72% of cycle elapsed!
  if (med != null && med >= 14 && sinceLast != null && sinceLast < 0.72 * med) return true;
  // Single or sporadic event inactive for >14 days and not yet due
  if (sinceLast != null && sinceLast > 14 && (med == null || sinceLast < 0.72 * med)) return true;
  // Never used and >14 days old without a target
  if ((h.total_events || 0) === 0 && Number(h.days_since_created ?? 0) >= 14 && h.target == null) return true;
  return false;
}

function isHabitCadenceDue(h) {
  const med = h.median_interval_days != null ? Number(h.median_interval_days) : null;
  const sinceLast = h.days_since_last != null ? Number(h.days_since_last) : null;
  if (med == null || med < 3 || sinceLast == null) return false;
  if (Number(h.direct || 0) > 0 || h.status === "met") return false;
  return sinceLast / med >= 0.72;
}

function isHabitInFocusNow(h, incomingTargets, selectedIds, connectedToSelected) {
  if (h.active_since) return true;
  if (selectedIds.includes(h.id) || connectedToSelected.has(h.id)) return true;
  if (h.kind === "min" && h.target != null && h.status !== "met") return true;
  if (h.kind === "max" && (h.status === "warning" || h.status === "exceeded")) return true;
  if (incomingTargets.has(h.id) && h.status !== "met") return true;
  if (isHabitCadenceDue(h)) return true;
  if (Number(h.hour_fit || 0) >= 0.55 && h.kind !== "max" && h.status !== "met") return true;
  return false;
}

function computeSmartScore(h, ctx) {
  let score = 0;
  if (h.active_since) score += 1000;
  const fit = ctx.fitById[h.id];
  if (fit && ctx.selectedIds.length) {
    score += fit.posHits * 130 - fit.negHits * 150 + fit.netWeight * 25;
  }
  const med = h.median_interval_days != null ? Number(h.median_interval_days) : null;
  const sinceLast = h.days_since_last != null ? Number(h.days_since_last) : null;
  if (med != null && med >= 2 && sinceLast != null && Number(h.direct || 0) === 0) {
    const dueRatio = sinceLast / med;
    if (dueRatio >= 0.72) score += 55 * Math.min(1.8, dueRatio);
  }
  if (h.kind === "min" && h.status !== "met") {
    score += (h.target_period || "day") === "day" ? 45 : 35;
  }
  const hrFit = Number(h.hour_fit || 0);
  score += (h.kind === "max" ? 18 : 42) * hrFit;
  if (ctx.todayNeighborSet.has(h.id)) score += 18;
  if (h.kind === "max") score -= 24;
  if (h.kind === "min" && h.status === "met") score -= 45;
  return score;
}

function renderToday(data) {
  updateBrandMark(data);
  const grid = $("#habit-grid");
  const clustersBox = $("#focus-clusters");
  const dormantBox = $("#dormant-habits-wrap");
  const empty = $("#empty-state");
  const filterBar = $("#today-filter-bar");
  const clearFocusBtn = $("#btn-clear-focus");

  const byId = {};
  data.habits.forEach((h) => { byId[h.id] = h; });
  // Prune any toggled IDs that no longer exist
  state.toggledFocus = state.toggledFocus.filter((id) => !!byId[id]);

  if (data.habits.length >= 2) {
    filterBar.classList.remove("hidden");
  } else {
    filterBar.classList.add("hidden");
  }

  if (state.toggledFocus.length) {
    clearFocusBtn.classList.remove("hidden");
    $("#focus-count").textContent = String(state.toggledFocus.length);
  } else {
    clearFocusBtn.classList.add("hidden");
  }

  $$("#today-kind-pills [data-fkind]").forEach((p) => p.classList.toggle("active", p.dataset.fkind === state.filterKind));

  const q = state.filterQuery.trim().toLowerCase();
  const visible = data.habits.filter((h) => {
    if (state.filterKind !== "all" && state.filterKind !== "focus" && h.kind !== state.filterKind) return false;
    if (q && !h.name.toLowerCase().includes(q)) return false;
    return true;
  });

  // Precompute smart context (selection fit + neighbors of today's logged events)
  const selectedIds = state.toggledFocus;
  const connectedToSelected = new Set();
  const fitById = {};
  for (const h of data.habits) {
    const fit = evaluateSelectionFit(h.id, selectedIds, byId);
    fitById[h.id] = fit;
    if (fit.rels.length) connectedToSelected.add(h.id);
  }
  const todayNeighborSet = new Set();
  for (const h of data.habits) {
    if (Number(h.direct || 0) > 0) {
      getConnectedNeighbors(h.id).forEach((r) => {
        if (Number(r.weight || 0) > 0) todayNeighborSet.add(r.id);
      });
    }
  }
  const smartCtx = { selectedIds, fitById, todayNeighborSet };
  const isSmart = state.sortMode === "smart";

  if (isSmart) {
    visible.sort((a, b) => {
      const diff = computeSmartScore(b, smartCtx) - computeSmartScore(a, smartCtx);
      if (Math.abs(diff) > 0.01) return diff;
      return (a.sort_order ?? 0) - (b.sort_order ?? 0);
    });
  }

  const cardRenderOpts = (h, extra = {}) => {
    const fit = fitById[h.id] || { posHits: 0, negHits: 0, netWeight: 0, rels: [] };
    const isConflict = selectedIds.length > 0 && fit.negHits > 0 && fit.posHits === 0;
    const isMaxDim = isSmart && h.kind === "max" && !h.active_since && !selectedIds.includes(h.id);
    const isSynergy = selectedIds.length >= 2 && fit.posHits >= 2 && fit.negHits === 0;
    let relBadge = extra.relBadge || "";
    if (!relBadge && isSmart && isHabitCadenceDue(h)) {
      relBadge = `<span class="chip pos-chip">${esc(t("due_badge", { d: Math.round(Number(h.median_interval_days)) }))}</span>`;
    }
    return {
      ...extra,
      relBadge,
      softDim: extra.softDim !== undefined ? extra.softDim : isConflict || isMaxDim,
      synergy: extra.synergy !== undefined ? extra.synergy : isSynergy,
    };
  };

  if (!data.habits.length) {
    empty.classList.remove("hidden");
    clustersBox.classList.add("hidden");
    clustersBox.innerHTML = "";
    grid.innerHTML = "";
    if (dormantBox) {
      dormantBox.classList.add("hidden");
      dormantBox.innerHTML = "";
    }
  } else {
    empty.classList.add("hidden");

    // 1. Render toggled focus cluster(s) — unified multi-select synergy compass when >= 2 cards selected!
    const shownInClusters = new Set();
    if (selectedIds.length >= 2) {
      clustersBox.classList.remove("hidden");
      selectedIds.forEach((id) => shownInClusters.add(id));
      const anchorsHtml = selectedIds
        .map((id) => (byId[id] ? renderHabitCardHtml(byId[id], { asAnchor: true }) : ""))
        .join("");
      const candidateIds = Array.from(connectedToSelected).filter((id) => !shownInClusters.has(id) && !!byId[id]);
      candidateIds.forEach((id) => shownInClusters.add(id));
      candidateIds.sort((aId, bId) => {
        const fa = fitById[aId], fb = fitById[bId];
        if (fb.posHits !== fa.posHits) return fb.posHits - fa.posHits;
        if (fa.negHits !== fb.negHits) return fa.negHits - fb.negHits;
        return computeSmartScore(byId[bId], smartCtx) - computeSmartScore(byId[aId], smartCtx);
      });
      const childrenHtml = candidateIds.length
        ? candidateIds
            .map((cid) => {
              const child = byId[cid];
              const fit = fitById[cid];
              const badges = [];
              if (fit.posHits >= 2 && fit.negHits === 0) {
                badges.push(`<span class="chip pos-chip">${esc(t("synergy_badge", { k: fit.posHits, n: selectedIds.length }))}</span>`);
              } else {
                fit.rels.slice(0, 2).forEach((r) => {
                  const cls = r.isAi ? "ai-chip" : r.effectiveW >= 0 ? "pos-chip" : "neg-chip";
                  const arrowTxt =
                    r.dir === "in"
                      ? `${r.weight >= 0 ? "+" : ""}${fmtNum(r.weight)} → ${r.anchorName}`
                      : `${r.anchorName} → ${r.weight >= 0 ? "+" : ""}${fmtNum(r.weight)}`;
                  badges.push(`<span class="chip ${cls}">${r.isAi ? `${t("mode_ai")} ` : ""}${esc(arrowTxt)}</span>`);
                });
              }
              return renderHabitCardHtml(child, cardRenderOpts(child, { relBadge: badges.join("") }));
            })
            .join("")
        : `<div class="muted sm-text">${esc(t("no_connected"))}</div>`;

      clustersBox.innerHTML = `
      <div class="focus-cluster">
        <div class="focus-anchors-row">${anchorsHtml}</div>
        <div class="focus-children">
          <div class="focus-children-head">
            <span>${esc(t("multi_connected_head", { n: candidateIds.length }))}</span>
          </div>
          <div class="focus-children-grid">${childrenHtml}</div>
        </div>
      </div>`;
    } else if (selectedIds.length === 1) {
      const anchorId = selectedIds[0];
      const anchor = byId[anchorId];
      if (anchor) {
        clustersBox.classList.remove("hidden");
        shownInClusters.add(anchorId);
        const rels = getConnectedNeighbors(anchorId).filter((r) => !!byId[r.id]);
        rels.forEach((r) => shownInClusters.add(r.id));
        rels.sort((a, b) => {
          const wa = anchor.kind === "max" ? -a.weight : a.weight;
          const wb = anchor.kind === "max" ? -b.weight : b.weight;
          if ((wb > 0) !== (wa > 0)) return wb > 0 ? 1 : -1;
          return computeSmartScore(byId[b.id], smartCtx) - computeSmartScore(byId[a.id], smartCtx);
        });
        const renderFocusRelCard = (r) => {
          const child = byId[r.id];
          const effW = anchor.kind === "max" ? -r.weight : r.weight;
          const cls = r.isAi ? "ai-chip" : effW >= 0 ? "pos-chip" : "neg-chip";
          const arrowTxt =
            r.dir === "in"
              ? `${r.weight >= 0 ? "+" : ""}${fmtNum(r.weight)} → ${anchor.name}`
              : `${anchor.name} → ${r.weight >= 0 ? "+" : ""}${fmtNum(r.weight)}`;
          const badge = `<span class="chip ${cls}">${r.isAi ? `${t("mode_ai")} ` : ""}${esc(arrowTxt)}</span>`;
          return renderHabitCardHtml(child, cardRenderOpts(child, { relBadge: badge }));
        };
        const inRels = rels.filter((r) => r.dir === "in");
        const outRels = rels.filter((r) => r.dir === "out");
        const sections = [];
        if (inRels.length) {
          sections.push(`
          <div class="focus-dir-group">
            <div class="focus-children-head">
              <span>${esc(t("connected_in_head", { name: anchor.name, n: inRels.length }))}</span>
            </div>
            <div class="focus-children-grid">${inRels.map(renderFocusRelCard).join("")}</div>
          </div>`);
        }
        if (outRels.length) {
          sections.push(`
          <div class="focus-dir-group">
            <div class="focus-children-head">
              <span>${esc(t("connected_out_head", { name: anchor.name, n: outRels.length }))}</span>
            </div>
            <div class="focus-children-grid">${outRels.map(renderFocusRelCard).join("")}</div>
          </div>`);
        }
        const childrenBodyHtml = sections.length
          ? sections.join("")
          : `<div class="muted sm-text">${esc(t("no_connected"))}</div>`;

        clustersBox.innerHTML = `
        <div class="focus-cluster">
          <div class="focus-anchor-wrap">${renderHabitCardHtml(anchor, { asAnchor: true })}</div>
          <div class="focus-children">${childrenBodyHtml}</div>
        </div>`;
      }
    } else {
      clustersBox.classList.add("hidden");
      clustersBox.innerHTML = "";
    }

    // 2. Render remaining habits in regular grid (+ fold non-focus cards in "Fokus" or rare/dormant cards in "Jetzt"!)
    const rest = selectedIds.length
      ? visible.filter((h) => !shownInClusters.has(h.id))
      : visible;

    let activeRest = rest;
    let dormantRest = [];
    const isFocusFilter = state.filterKind === "focus" && !q;
    if (isFocusFilter) {
      const incomingTargets = new Set(
        (state.edges || []).filter((e) => e.relation_type === "rollup").map((e) => e.target_id)
      );
      activeRest = [];
      for (const h of rest) {
        if (isHabitInFocusNow(h, incomingTargets, selectedIds, connectedToSelected)) activeRest.push(h);
        else dormantRest.push(h);
      }
      if (!activeRest.length && !shownInClusters.size && dormantRest.length) {
        activeRest = dormantRest;
        dormantRest = [];
      }
    } else if (isSmart && !q && state.filterKind === "all") {
      activeRest = [];
      for (const h of rest) {
        if (isHabitDormantNow(h, selectedIds, connectedToSelected)) dormantRest.push(h);
        else activeRest.push(h);
      }
      if (!activeRest.length && !shownInClusters.size && dormantRest.length) {
        activeRest = dormantRest;
        dormantRest = [];
      }
    }

    if (!visible.length) {
      grid.innerHTML = `<div class="muted sm-text" style="padding:12px 2px;">${esc(t("no_filter_match"))}</div>`;
    } else {
      grid.innerHTML = activeRest.map((h) => renderHabitCardHtml(h, cardRenderOpts(h))).join("");
    }

    if (dormantBox) {
      if (dormantRest.length) {
        dormantBox.classList.remove("hidden");
        const showKey = isFocusFilter ? "focus_show_rest" : "dormant_show";
        const hideKey = isFocusFilter ? "focus_hide_rest" : "dormant_hide";
        const btnLbl = state.showDormantToday
          ? t(hideKey, { n: dormantRest.length })
          : t(showKey, { n: dormantRest.length });
        const expandedHtml = state.showDormantToday
          ? `<div class="habit-grid">${dormantRest.map((h) => renderHabitCardHtml(h, cardRenderOpts(h, { softDim: true }))).join("")}</div>`
          : "";
        dormantBox.innerHTML = `
          <div class="dormant-toggle-row">
            <button type="button" class="btn ghost sm" data-toggle-dormant="1">${esc(btnLbl)}</button>
          </div>
          ${expandedHtml}`;
      } else {
        dormantBox.classList.add("hidden");
        dormantBox.innerHTML = "";
      }
    }
  }

  // Day log (events + Momentaufnahmen interleaved chronologically!)
  if (!state.logRange) {
    renderLogTimeline({
      events: data.events || [],
      snapshots: data.snapshots || [],
      state_dimensions: data.state_dimensions || state.stateDims || [],
      habits: data.habits || [],
      singleDay: data.day,
    });
  }
}

function fmtShortDay(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dt.toLocaleDateString(getLocale(), { day: "2-digit", month: "2-digit" });
}

function classifyEventWindow(iso) {
  const m = String(iso || "").match(/T(\d{2})/);
  if (!m) return "any";
  const hr = Number(m[1]);
  if (hr >= 5 && hr < 12) return "morning";
  if (hr >= 12 && hr < 17) return "afternoon";
  if (hr >= 17 && hr < 22) return "evening";
  return "night";
}

async function ensureAnalysisBoard(force = false, fast = false) {
  if (!force && state.analysisBoard && (fast || !state.analysisBoard.fast)) return state.analysisBoard;
  if (!force && state.analysisBoardPromise) return state.analysisBoardPromise;
  const url = fast ? "/api/analysis?days=30&fast=1" : "/api/analysis?days=30";
  const p = api(url)
    .then((board) => {
      // Never downgrade a full AI board with a fast empirical board
      if (!fast || !state.analysisBoard || state.analysisBoard.fast) {
        state.analysisBoard = board;
      }
      if (state.analysisBoardPromise === p) state.analysisBoardPromise = null;
      return state.analysisBoard;
    })
    .catch((err) => {
      if (state.analysisBoardPromise === p) state.analysisBoardPromise = null;
      throw err;
    });
  state.analysisBoardPromise = p;
  return p;
}

function renderEventCounterfactualHtml(ev, dimsById) {
  if (!state.analysisBoard) {
    return `<div class="muted sm-text">${esc(t("log_cf_loading"))}</div>`;
  }
  const cfMap = state.analysisBoard.habit_counterfactuals || {};
  const info = cfMap[ev.habit_id];
  const evWin = classifyEventWindow(ev.occurred_at);
  const wDays = info ? Number(info.days_with || 0) : 0;
  const woDays = info ? Number(info.days_without || 0) : 0;

  let effects = Array.isArray(info?.effects) ? [...info.effects] : [];
  // Fallback if an older server lacks habit_counterfactuals: read ai.assumptions + discovered
  if (!info) {
    const aiAssump = (state.analysisBoard.ai?.assumptions || []).filter((a) => a.source_id === ev.habit_id);
    const disc = (state.analysisBoard.discovered || []).filter((d) => d.source_id === ev.habit_id);
    effects = [
      ...aiAssump.map((a) => ({
        target_id: a.target_id,
        target_name: a.target_name,
        is_state_target: !!a.is_state_target,
        context_window: a.context_window || "any",
        avg_with: a.avg_with,
        avg_without: a.avg_without,
        delta: a.predicted_delta,
        days_with: a.days_with,
        days_without: a.days_without,
        source_kind: "ai",
      })),
      ...disc.map((d) => ({
        target_id: d.target_id,
        target_name: d.target_name,
        is_state_target: false,
        context_window: d.context_window || "any",
        avg_with: d.avg_with,
        avg_without: d.avg_without,
        delta: d.delta,
        days_with: d.days_with,
        days_without: d.days_without,
        source_kind: "empirical",
      })),
    ];
  }

  // Prefer effects matching this event's time window or "any", deduplicated by target
  const seen = new Set();
  effects.sort((a, b) => {
    const aMatch = a.context_window === evWin ? 1.2 : a.context_window === "any" ? 1.0 : 0.75;
    const bMatch = b.context_window === evWin ? 1.2 : b.context_window === "any" ? 1.0 : 0.75;
    const aScore = Math.abs(Number(a.delta || 0)) * (a.is_state_target ? 1.3 : 1.0) * aMatch;
    const bScore = Math.abs(Number(b.delta || 0)) * (b.is_state_target ? 1.3 : 1.0) * bMatch;
    return bScore - aScore;
  });
  const picked = [];
  for (const ef of effects) {
    const key = String(ef.target_id || ef.target_name);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(ef);
    if (picked.length >= 3) break;
  }

  if (!picked.length) {
    if (wDays < 2 || woDays < 2) {
      return `<div class="muted sm-text">${esc(t("log_cf_collecting", { w: wDays, wo: woDays, name: ev.habit_name }))}</div>`;
    }
    return `<div class="muted sm-text">${esc(t("log_cf_neutral", { w: wDays, wo: woDays, name: ev.habit_name }))}</div>`;
  }

  return picked
    .map((ef) => {
      const delta = Number(ef.delta || 0);
      const sign = delta >= 0 ? "+" : "";
      const isAi = ef.source_kind === "ai";
      const chipCls = isAi ? "ai-chip" : delta >= 0 ? "pos-chip" : "neg-chip";
      const targetLabel = ef.is_state_target
        ? dimName(
            (dimsById && dimsById[String(ef.target_id || "").replace(/^state:/, "")]) || {
              id: String(ef.target_id || "").replace(/^state:/, ""),
              name: ef.target_name,
            }
          )
        : ef.target_name;
      const winSuffix =
        ef.context_window && ef.context_window !== "any" ? ` (${windowLabel(ef.context_window)})` : "";
      const tagBadge = ef.is_state_target
        ? `<span class="ev-cf-tag">${esc(t("log_cf_badge_mood"))}</span>`
        : isAi
        ? `<span class="ev-cf-tag">${esc(t("log_cf_badge_ai"))}</span>`
        : "";
      const statsStr =
        ef.avg_with != null && ef.avg_without != null
          ? t("log_cf_stats", { w: fmtNum(ef.avg_with), wo: fmtNum(ef.avg_without) })
          : "";
      const nStr =
        ef.days_with != null && ef.days_without != null
          ? t("log_cf_days", { w: ef.days_with, wo: ef.days_without })
          : "";
      return `
        <div class="ev-detail-route ev-detail-cf-row">
          <span class="chip ev-impact-chip ${chipCls}">${esc(targetLabel)} ${sign}${fmtNum(delta)}</span>
          ${tagBadge}
          ${statsStr ? `<span class="ev-detail-math mono">${esc(statsStr)}${esc(winSuffix)}</span>` : ""}
          ${nStr ? `<span class="ev-detail-target-state mono">${esc(nStr)}</span>` : ""}
        </div>`;
    })
    .join("");
}

function renderLogEntryHtml(entry, dimsById, habitsById) {
  if (entry.kind === "snap") {
    const sn = entry.item;
    const hhmm = sn.occurred_at.slice(11, 16);
    const comp = computeMoodComposite(sn.ratings, dimsById);
    const ratingChips = Object.entries(sn.ratings || {})
      .map(([did, val]) => {
        const dObj = dimsById[did] || { id: did, name: did };
        const dname = dimName(dObj);
        const col = dimColor(dObj);
        return `<span class="chip"><span class="chip-dot" style="background:${esc(col)}"></span>${esc(dname)} ${fmtNum(val)}/5</span>`;
      })
      .join("");
    const causeTxt = (sn.causes || [])
      .map((cid) => (habitsById[cid] ? habitsById[cid].name : cid))
      .join(", ");
    const causeChip = causeTxt ? `<span class="chip">← ${esc(causeTxt)}</span>` : "";
    const hasNote = !!(sn.note && sn.note.trim());
    const fallbackTitle = !ratingChips && !causeChip ? `<strong>${esc(t("btn_mood"))}</strong>` : "";
    const noteHtml = hasNote
      ? `<span class="muted sm-text ev-note" data-snap-edit="${sn.id}" title="${esc(t("edit_entry_title"))}">${renderNoteWithTags(sn.note)}</span>`
      : "";
    return `
    <div class="ev-row snap-row" style="--snap-c1:${esc(comp.c1)};--snap-c2:${esc(comp.c2)};">
      <span class="ev-dot snap-orb" style="background:${comp.orbBg};opacity:${comp.orbOpacity}"></span>
      <span class="ev-time" data-snap-edit="${sn.id}" title="${esc(t("edit_entry_title"))}">${hhmm}</span>
      ${fallbackTitle}
      ${ratingChips || causeChip ? `<div class="row-inline snap-chips">${ratingChips}${causeChip}</div>` : ""}
      ${noteHtml}
      <span class="row-inline snap-actions">
        <button class="btn ghost sm" data-snap-edit="${sn.id}" title="${esc(t("edit_entry_title"))}">Edit</button>
        <button class="btn ghost sm" data-snap-del="${sn.id}" title="${esc(t("del_title"))}">✕</button>
      </span>
    </div>`;
  }
  const ev = entry.item;
  const timeLabel = formatEventTimeRange(ev);
  const winMin = Number(ev.window_minutes || 0);
  const srcTag =
    ev.source === "retro"
      ? `retro ${Math.round((winMin / 60) * 10) / 10}h`
      : winMin > 0
      ? formatDurationMin(winMin)
      : ev.source;
  const hasNote = !!(ev.note && ev.note.trim());
  const srcHabit = habitsById[ev.habit_id];
  const directRoutes = Array.isArray(srcHabit?.routes_to) ? srcHabit.routes_to : [];
  const evAmt = Number(ev.amount || 0);
  const activeImpacts = directRoutes
    .map((r) => {
      const w = Number(r.weight || 0);
      const contrib = Math.round(evAmt * w * 100) / 100;
      if (!Number.isFinite(contrib) || Math.abs(contrib) < 0.001) return null;
      const targetHabit = habitsById[r.target_id];
      return { r, w, contrib, targetHabit };
    })
    .filter(Boolean);

  // Keep collapsed row visually calm so Mood snapshots remain the hero in the timeline;
  // show only a quiet monochrome count cue ("→ 2") and reveal full math + target progress on tap.
  const routeCueTitle = activeImpacts
    .map(({ r, contrib }) => `→ ${contrib >= 0 ? "+" : ""}${fmtNum(contrib)} ${r.target_name}`)
    .join(" · ");
  const routeCueHtml = activeImpacts.length
    ? `<span class="ev-route-cue mono" title="${esc(routeCueTitle)}">→ ${activeImpacts.length}</span>`
    : "";

  const isExpanded = String(state.expandedLogEventId) === String(ev.id);
  const detailImpactsHtml = activeImpacts.length
    ? activeImpacts
        .map(({ r, w, contrib, targetHabit }) => {
          const cls = r.is_ai ? "ai-chip" : contrib >= 0 ? "pos-chip" : "neg-chip";
          const sign = contrib >= 0 ? "+" : "";
          const wSign = w >= 0 ? "+" : "";
          const mathStr = `${evAmt >= 0 ? "+" : ""}${fmtNum(evAmt)} × ${wSign}${fmtNum(w)} = ${sign}${fmtNum(contrib)}`;
          let statusStr = "";
          if (targetHabit && typeof targetHabit.effective === "number") {
            const unit = targetHabit.unit && targetHabit.unit !== "x" ? ` ${targetHabit.unit}` : "";
            const tgtVal = targetHabit.target != null ? ` / ${fmtNum(targetHabit.target)}${unit}` : unit;
            statusStr = `<span class="ev-detail-target-state mono">${esc(t("today"))}: ${fmtNum(targetHabit.effective)}${esc(tgtVal)}</span>`;
          }
          return `
            <div class="ev-detail-route">
              <span class="chip route-out-chip ev-impact-chip ${cls}">→ ${sign}${fmtNum(contrib)} ${esc(r.target_name)}</span>
              <span class="ev-detail-math mono">${esc(mathStr)}</span>
              ${statusStr}
            </div>`;
        })
        .join("")
    : `<div class="muted sm-text">${esc(t("log_no_direct_routes"))}</div>`;

  const fullNoteDetailHtml = hasNote
    ? `<div class="ev-detail-note">${renderNoteWithTags(ev.note)}</div>`
    : "";

  const cfDetailHtml = renderEventCounterfactualHtml(ev, dimsById);

  return `
  <div class="ev-entry${isExpanded ? " expanded" : ""}" data-ev-entry="${ev.id}">
    <div class="ev-row" data-ev-toggle="${ev.id}">
      <span class="ev-dot" style="background:${esc(ev.habit_color)}"></span>
      <span class="ev-time" data-ev-time="${ev.id}" title="${esc(t("edit_time_title"))}">${esc(timeLabel)}</span>
      <strong>${esc(ev.habit_name)}</strong>
      <span class="ev-amt ${ev.amount >= 0 ? "pos" : "neg"}" data-ev-amt="${ev.id}" title="${esc(t("edit_amt_title"))}">${ev.amount >= 0 ? "+" : ""}${fmtNum(ev.amount)}</span>
      ${routeCueHtml}
      <span class="chip">${esc(srcTag)}</span>
      <span class="ev-note ${hasNote ? "" : "empty-note"}" data-ev-note="${ev.id}" title="${esc(t("edit_note_title"))}">${hasNote ? renderNoteWithTags(ev.note) : esc(t("add_note_ph"))}</span>
      <span class="ev-chevron" aria-hidden="true">${isExpanded ? "▾" : "▸"}</span>
    </div>
    <div class="ev-detail${isExpanded ? "" : " hidden"}">
      <div class="ev-detail-section">
        <div class="ev-detail-label">${esc(t("log_direct_impact"))}</div>
        <div class="ev-detail-routes">${detailImpactsHtml}</div>
      </div>
      <div class="ev-detail-section">
        <div class="ev-detail-label">${esc(t("log_cf_heading"))}</div>
        <div class="ev-detail-routes" data-ev-cf-box="${ev.id}">${cfDetailHtml}</div>
      </div>
      ${fullNoteDetailHtml}
      <div class="ev-detail-actions">
        <button class="btn ghost sm" type="button" data-ev-edit="${ev.id}" title="${esc(t("edit_entry_title"))}">${esc(t("btn_edit_entry"))}</button>
        <button class="btn ghost sm ev-detail-del" type="button" data-ev-del="${ev.id}" title="${esc(t("del_title"))}">${esc(t("btn_del_entry"))}</button>
      </div>
    </div>
  </div>`;
}

function renderLogTimeline({ events, snapshots, state_dimensions, habits, singleDay, rangeStart, rangeEnd }) {
  const dimsById = {};
  (state_dimensions || state.stateDims || []).forEach((d) => { dimsById[d.id] = d; });
  const habitsById = {};
  const todayRoutesById = {};
  (state.todayData?.habits || []).forEach((th) => {
    if (Array.isArray(th.routes_to) && th.routes_to.length) {
      todayRoutesById[th.id] = th.routes_to;
    }
  });
  (habits || state.habits || []).forEach((h) => {
    habitsById[h.id] = Array.isArray(h.routes_to)
      ? h
      : { ...h, routes_to: todayRoutesById[h.id] || [] };
  });
  state.logEventsById = {};
  (events || []).forEach((ev) => { state.logEventsById[ev.id] = ev; });
  state.logSnapsById = {};
  (snapshots || []).forEach((sn) => { state.logSnapsById[sn.id] = sn; });

  const timeline = [
    ...(events || []).map((ev) => ({ kind: "event", at: ev.occurred_at, day: String(ev.occurred_at || "").slice(0, 10), item: ev })),
    ...(snapshots || []).map((sn) => ({ kind: "snap", at: sn.occurred_at, day: String(sn.occurred_at || "").slice(0, 10), item: sn })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const isMulti = !!(rangeStart && rangeEnd && rangeStart !== rangeEnd);
  $("#log-count").textContent = isMulti
    ? `(${timeline.length} · ${fmtShortDay(rangeStart)}–${fmtShortDay(rangeEnd)})`
    : `(${timeline.length})`;

  const resetBtn = $("#btn-log-reset");
  if (resetBtn) resetBtn.classList.toggle("hidden", !state.logRange);
  const toggleBtn = $("#btn-toggle-log-range");
  if (toggleBtn) toggleBtn.classList.toggle("active", !!state.logRange);

  const evList = $("#event-list");
  if (!timeline.length) {
    evList.innerHTML = isMulti
      ? `<div class="muted sm-text">${esc(t("no_events_for_range", { start: rangeStart, end: rangeEnd }))}</div>`
      : `<div class="muted sm-text">${esc(t("no_events_for_day", { day: singleDay || state.day }))}</div>`;
    return;
  }

  if (!isMulti) {
    evList.innerHTML = timeline.map((entry) => renderLogEntryHtml(entry, dimsById, habitsById)).join("");
    return;
  }

  // Multi-day grouped view with crisp day dividers
  const groups = new Map();
  for (const entry of timeline) {
    if (!groups.has(entry.day)) groups.set(entry.day, []);
    groups.get(entry.day).push(entry);
  }
  const html = [];
  for (const [dayIso, entries] of groups.entries()) {
    html.push(
      `<div class="log-day-divider"><span>${esc(formatDayHeadline(dayIso))}</span><span class="log-day-count">${entries.length}</span></div>`
    );
    for (const entry of entries) {
      html.push(renderLogEntryHtml(entry, dimsById, habitsById));
    }
  }
  evList.innerHTML = html.join("");
}

async function loadLogRange(startIso, endIso) {
  const s = startIso <= endIso ? startIso : endIso;
  const e = startIso <= endIso ? endIso : startIso;
  state.logRange = { start: s, end: e };
  const sInput = $("#log-range-start");
  const eInput = $("#log-range-end");
  if (sInput) sInput.value = s;
  if (eInput) eInput.value = e;
  try {
    const res = await api(`/api/log?start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`);
    state.logRangeData = res;
    renderLogTimeline({
      events: res.events,
      snapshots: res.snapshots,
      state_dimensions: res.state_dimensions,
      habits: res.habits,
      rangeStart: res.start,
      rangeEnd: res.end,
    });
  } catch (err) {
    toast(t("err_prefix", { msg: err.message }));
  }
}

function resetLogRange(reRender = true) {
  state.logRange = null;
  state.logRangeData = null;
  const bar = $("#log-range-bar");
  if (bar) bar.classList.add("hidden");
  if (reRender && state.todayData) {
    renderLogTimeline({
      events: state.todayData.events || [],
      snapshots: state.todayData.snapshots || [],
      state_dimensions: state.todayData.state_dimensions || state.stateDims || [],
      habits: state.todayData.habits || [],
      singleDay: state.todayData.day,
    });
  }
}

async function toggleHabitActive(habitId) {
  const h = state.habits.find((x) => x.id === habitId);
  if (!h) return;
  const payload = {};
  if (h.active_since) {
    const mins = elapsedMinutesSince(h.active_since);
    // Overnight forgot-to-stop guard (> 10h)
    if (mins > 600) {
      const hrs = (mins / 60).toFixed(1);
      const ans = prompt(t("session_long_prompt", { name: h.name, h: hrs }), String(Math.min(480, Number(h.block_minutes || 60) * 2)));
      if (ans === null || ans.trim() === "") {
        payload.cancel = true;
      } else {
        const parsed = Number(ans.trim().replace(",", "."));
        if (!Number.isFinite(parsed) || parsed <= 0) payload.cancel = true;
        else payload.override_minutes = parsed;
      }
    }
  }
  try {
    const res = await api(`/api/habits/${encodeURIComponent(habitId)}/toggle-active`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (res.active) {
      toast(t("session_started", { name: h.name }));
    } else if (res.logged && res.event) {
      const msgKey = res.trimmed_minutes >= 1 ? "session_stopped_trimmed" : "session_stopped_logged";
      toast(
        t(msgKey, {
          amt: fmtNum(res.amount),
          name: h.name,
          dur: formatDurationMin(res.elapsed_minutes),
          trim: formatDurationMin(res.trimmed_minutes || 0),
        }),
        { undoEventId: res.event.id }
      );
    } else if (res.already_covered) {
      toast(t("session_already_covered", { name: h.name }));
    } else if (res.too_short) {
      toast(t("session_too_short", { name: h.name }));
    } else {
      toast(t("session_cancelled", { name: h.name }));
    }
    await loadToday();
  } catch (err) {
    toast(t("err_prefix", { msg: err.message }));
  }
}

function refreshActiveSessionBadges() {
  $$("[data-active-since]").forEach((el) => {
    const dur = formatDurationMin(elapsedMinutesSince(el.dataset.activeSince));
    const txt = el.querySelector("[data-active-txt]");
    if (txt) txt.textContent = t("active_badge", { dur });
  });
  $$("[data-active-btn]").forEach((btn) => {
    const dur = formatDurationMin(elapsedMinutesSince(btn.dataset.activeBtn));
    btn.textContent = `■ ${dur}`;
  });
}

async function quickTap(habitId) {
  const isToday = state.day === localDateISO(new Date());
  const occurred_at = isToday
    ? `${state.day}T${localTimeHHMM(new Date())}:00`
    : `${state.day}T${localTimeHHMM(new Date())}:00`;
  const client_uuid = makeUuid();
  const h = state.habits.find((x) => x.id === habitId);
  const step = habitTapStep(h);
  try {
    const created = await api("/api/events", {
      method: "POST",
      body: JSON.stringify({ habit_id: habitId, amount: step, occurred_at, source: "tap", client_uuid }),
    });
    toast(`+${fmtNum(step)} ${h ? h.name : ""}`, { undoEventId: created.id });
    state.analysisBoard = null;
    await loadToday();
  } catch (e) {
    // Offline fallback: queue event idempotently via client_uuid and update cached UI immediately
    const q = loadOfflineQueue();
    q.push({ habit_id: habitId, amount: step, occurred_at, source: "tap", client_uuid, note: "" });
    saveOfflineQueue(q);
    if (state.todayData && h) {
      h.direct = Math.round((Number(h.direct || 0) + step) * 100) / 100;
      h.effective = Math.round((Number(h.effective || 0) + step) * 100) / 100;
      h.period_effective = Math.round((Number(h.period_effective ?? h.effective ?? 0) + step) * 100) / 100;
      h.event_count = (h.event_count || 0) + 1;
      localStorage.setItem(`daily_today_cache_${state.day}`, JSON.stringify(state.todayData));
      renderToday(state.todayData);
    }
    toast(t("offline_tap", { name: h ? h.name : "" }));
  }
}

// ---- CUSTOM LOG MODAL ----
function updateCustomLogDurationHint(recalcAmount = false) {
  const hint = $("#cl-duration-hint");
  if (!hint) return;
  const hid = $("#cl-habit-id").value;
  const h = state.habits.find((x) => x.id === hid);
  const startVal = $("#cl-start") ? $("#cl-start").value : "";
  const endVal = $("#cl-time").value;
  const hasBlock = !!(h && h.block_minutes && Number(h.block_minutes) > 0);
  const diffMin = hasBlock ? computeTimeDiffMin(startVal, endVal) : 0;
  if (!hasBlock || diffMin <= 0) {
    hint.classList.add("hidden");
    hint.textContent = "";
    return;
  }
  const dur = formatDurationMin(diffMin);
  const calcAmt = Math.max(0.1, Math.round((diffMin / Number(h.block_minutes)) * 10) / 10);
  if (recalcAmount) $("#cl-amount").value = calcAmt;
  hint.textContent = t("ee_duration_block_hint", { dur, blk: h.block_minutes, amt: fmtNum(calcAmt) });
  hint.classList.remove("hidden");
}

function openCustomLog(habitId) {
  const h = state.habits.find((x) => x.id === habitId);
  if (!h) return;
  const nowDt = new Date();
  const hasBlock = !!(h.block_minutes && Number(h.block_minutes) > 0);
  $("#cl-habit-id").value = habitId;
  $("#cl-title").textContent = t("cl_title_habit", { name: h.name });
  $("#cl-amount").value = hasBlock ? "1" : String(habitTapStep(h));
  $("#cl-time").value = localTimeHHMM(nowDt);
  const startWrap = $("#cl-start-wrap");
  const rangeRow = $("#cl-range-row");
  const timeLbl = $("#cl-time-label");
  if (startWrap) startWrap.classList.toggle("hidden", !hasBlock);
  if (rangeRow) rangeRow.classList.toggle("has-range", hasBlock);
  if (timeLbl) timeLbl.textContent = t(hasBlock ? "cl_to" : "cl_time");
  if ($("#cl-start")) {
    $("#cl-start").value = hasBlock ? localTimeHHMM(new Date(nowDt.getTime() - Number(h.block_minutes) * 60000)) : "";
  }
  $("#cl-note").value = "";
  updateCustomLogDurationHint(false);
  renderTagSuggestChips("#cl-tag-chips", "#cl-note");
  $("#custom-log-modal").classList.remove("hidden");
  if (hasBlock && $("#cl-start")) $("#cl-start").focus();
  else $("#cl-amount").focus();
}

function closeCustomLog() {
  $("#custom-log-modal").classList.add("hidden");
}

// ---- RETRO CHECK-IN MODAL ----
async function openRetroModal() {
  if (!state.habits.length || !state.tags.length) {
    const resp = await api("/api/habits");
    if (!state.habits.length) state.habits = resp.habits;
    if (resp.tags) state.tags = resp.tags;
  }
  state.retroAmounts = {};
  $("#retro-end-time").value = localTimeHHMM(new Date());
  $("#retro-note").value = "";
  $("#retro-new-habit").value = "";
  renderRetroRows();
  renderTagSuggestChips("#retro-tag-chips", "#retro-note");
  $("#retro-modal").classList.remove("hidden");
}

function closeRetroModal() {
  $("#retro-modal").classList.add("hidden");
}

// ---- MOMENTAUFNAHME (BEFINDEN) MODAL ----
async function openMoodModal(editSnap = null) {
  const snap = editSnap && typeof editSnap === "object" && editSnap.id != null ? editSnap : null;
  try {
    const [dimResp, habResp] = await Promise.all([
      api("/api/state/dimensions?include_archived=true"),
      api("/api/habits"),
    ]);
    const allDims = dimResp.dimensions || [];
    state.stateDims = allDims.filter((d) => !d.archived);
    state.archivedDims = allDims.filter((d) => !!d.archived);
    if (!state.habits.length && habResp.habits) state.habits = habResp.habits;
    if (habResp.tags) state.tags = habResp.tags;
    if (habResp.settings) state.settings = habResp.settings;
  } catch {
    // Keep cached dimensions if offline
    if (!state.stateDims.length) {
      state.stateDims = [
        { id: "stimmung", name: "Stimmung", low_label: "melancholisch", high_label: "leicht / gut", color: "#368470" },
        { id: "mental-fit", name: "Mental fit", low_label: "leer / neblig", high_label: "wach / klar", color: "#3d6b7d" },
        { id: "stress", name: "Stress", low_label: "entspannt", high_label: "unter Druck", color: "#c85a44" },
        { id: "anspannung", name: "Anspannung", low_label: "locker", high_label: "angespannt", color: "#b4783c" },
        { id: "antrieb", name: "Antrieb / Offenheit", low_label: "blockiert", high_label: "offen / bereit", color: "#6e68a8" },
      ];
    }
  }
  state.moodGroups = parseMoodGroups(state.settings);
  const savedActive = (state.settings && state.settings.active_mood_group) || (state.moodGroups[0] ? state.moodGroups[0].id : "all");
  state.activeMoodGroup = savedActive === "all" || state.moodGroups.some((g) => g.id === savedActive) ? savedActive : "all";
  // When editing an existing snapshot, make sure all of its rated axes are immediately visible
  if (snap && snap.ratings) {
    const ratedIds = Object.keys(snap.ratings);
    const activeGrp = state.moodGroups.find((g) => g.id === state.activeMoodGroup);
    if (activeGrp && ratedIds.some((id) => !activeGrp.dim_ids.includes(id))) {
      const matchingGrp = state.moodGroups.find((g) => ratedIds.every((id) => g.dim_ids.includes(id)));
      state.activeMoodGroup = matchingGrp ? matchingGrp.id : "all";
    }
  }
  state.editingSnapId = snap ? snap.id : null;
  state.editingDimId = null;
  state.moodRatings = snap ? { ...(snap.ratings || {}) } : {};
  state.moodCauses = new Set(snap ? snap.causes || [] : []);
  resetMoodGroupForm();
  const titleEl = $("#mood-modal-title");
  if (titleEl) titleEl.textContent = t(snap ? "mood_title_edit" : "mood_title");
  const dateEl = $("#mood-date");
  if (dateEl) dateEl.value = snap && snap.occurred_at ? snap.occurred_at.slice(0, 10) : state.day;
  $("#mood-time").value = snap && snap.occurred_at ? snap.occurred_at.slice(11, 16) : localTimeHHMM(new Date());
  $("#mood-note").value = snap ? snap.note || "" : "";
  renderMoodModal();
  renderTagSuggestChips("#mood-tag-chips", "#mood-note");
  $("#mood-modal").classList.remove("hidden");
}

function closeMoodModal() {
  state.editingSnapId = null;
  state.editingDimId = null;
  $("#mood-modal").classList.add("hidden");
}

// ---- DAY LOG EVENT EDITOR MODAL ----
function computeTimeDiffMin(startHHMM, endHHMM) {
  if (!startHHMM || !endHHMM) return 0;
  const sm = startHHMM.match(/^(\d{2}):(\d{2})$/);
  const em = endHHMM.match(/^(\d{2}):(\d{2})$/);
  if (!sm || !em) return 0;
  let diff = Number(em[1]) * 60 + Number(em[2]) - (Number(sm[1]) * 60 + Number(sm[2]));
  if (diff === 0) return 0;
  if (diff < 0) diff += 1440;
  return diff;
}

function updateEditEventDurationHint(recalcAmount = false) {
  const hint = $("#ee-duration-hint");
  if (!hint) return;
  const startVal = $("#ee-start").value;
  const endVal = $("#ee-time").value;
  const diffMin = computeTimeDiffMin(startVal, endVal);
  if (diffMin <= 0) {
    hint.classList.add("hidden");
    hint.textContent = "";
    return;
  }
  const hid = $("#ee-habit").value;
  const allH = [
    ...(state.habits || []),
    ...(state.archivedHabits || []),
    ...((state.logRangeData && state.logRangeData.habits) || []),
  ];
  const hab = allH.find((x) => x.id === hid);
  const dur = formatDurationMin(diffMin);
  if (hab && hab.block_minutes) {
    const calcAmt = Math.max(0.1, Math.round((diffMin / Number(hab.block_minutes)) * 10) / 10);
    if (recalcAmount) $("#ee-amount").value = calcAmt;
    hint.textContent = t("ee_duration_block_hint", { dur, blk: hab.block_minutes, amt: fmtNum(calcAmt) });
  } else {
    hint.textContent = t("ee_duration_hint", { dur });
  }
  hint.classList.remove("hidden");
}

function openEditEventModal(ev, focusSelector = null) {
  if (!ev) return;
  state.editingEvent = ev;
  const allHabits = [];
  const seen = new Set();
  for (const h of [
    ...(state.habits || []),
    ...((state.logRangeData && state.logRangeData.habits) || []),
    ...(state.archivedHabits || []),
  ]) {
    if (h && h.id && !seen.has(h.id)) {
      seen.add(h.id);
      allHabits.push(h);
    }
  }
  if (ev.habit_id && !seen.has(ev.habit_id)) {
    allHabits.push({ id: ev.habit_id, name: ev.habit_name || ev.habit_id });
  }
  $("#ee-id").value = ev.id;
  $("#ee-habit").innerHTML = allHabits.map((h) => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join("");
  $("#ee-habit").value = ev.habit_id || "";
  $("#ee-date").value = String(ev.occurred_at || state.day).slice(0, 10);
  $("#ee-amount").value = ev.amount;

  const endHHMM = String(ev.occurred_at || "").slice(11, 16) || localTimeHHMM(new Date());
  $("#ee-time").value = endHHMM;
  const winMin = Number(ev.window_minutes || 0);
  if (winMin > 0 && ev.source !== "retro") {
    const endDt = new Date(ev.occurred_at);
    if (!Number.isNaN(endDt.getTime())) {
      const startDt = new Date(endDt.getTime() - winMin * 60000);
      $("#ee-start").value = localTimeHHMM(startDt);
    } else {
      $("#ee-start").value = "";
    }
  } else {
    $("#ee-start").value = "";
  }
  $("#ee-note").value = ev.note || "";
  updateEditEventDurationHint(false);
  renderTagSuggestChips("#ee-tag-chips", "#ee-note");
  $("#edit-event-modal").classList.remove("hidden");
  if (focusSelector) {
    const target = $(focusSelector);
    if (target) setTimeout(() => { target.focus(); if (target.select) target.select(); }, 20);
  }
}

function closeEditEventModal() {
  state.editingEvent = null;
  $("#edit-event-modal").classList.add("hidden");
}

async function refreshAfterLogMutation() {
  state.analysisBoard = null;
  await loadToday();
  if (state.logRange) {
    await loadLogRange(state.logRange.start, state.logRange.end);
  }
  if (state.tab === "analysis") await loadAnalysis();
}

// ---- HABIT DELETE / MERGE MODAL ----
function openDeleteHabitModal(habitId) {
  const h = state.habits.find((x) => x.id === habitId);
  if (!h) return;
  $("#dh-habit-id").value = h.id;
  $("#dh-title").textContent = t("dh_title_habit", { name: h.name });
  const others = state.habits.filter((x) => x.id !== h.id);
  const mergeBox = $("#dh-merge-box");
  if (others.length) {
    mergeBox.classList.remove("hidden");
    $("#dh-target-select").innerHTML = others
      .map((o) => `<option value="${esc(o.id)}">→ ${esc(o.name)}</option>`)
      .join("");
  } else {
    mergeBox.classList.add("hidden");
  }
  $("#dh-tag-notes").checked = true;
  $("#delete-habit-modal").classList.remove("hidden");
}

function closeDeleteHabitModal() {
  $("#delete-habit-modal").classList.add("hidden");
}

function resetMoodGroupForm() {
  const idEl = $("#mg-edit-id");
  if (idEl) idEl.value = "";
  const nameEl = $("#mg-name");
  if (nameEl) nameEl.value = "";
  const cancelEl = $("#btn-cancel-mg");
  if (cancelEl) cancelEl.classList.add("hidden");
  const saveEl = $("#btn-save-mg");
  if (saveEl) saveEl.textContent = t("mg_save");
  state.mgDraftDims = new Set(["stimmung", "stress"].filter((id) => state.stateDims.some((d) => d.id === id)));
  renderMoodGroupManager();
}

function populateMoodGroupForm(grp) {
  if (!grp) return;
  $("#mg-edit-id").value = grp.id;
  $("#mg-name").value = grp.name;
  $("#btn-cancel-mg").classList.remove("hidden");
  $("#btn-save-mg").textContent = t("btn_save");
  state.mgDraftDims = new Set(grp.dim_ids || []);
  renderMoodGroupManager();
  $("#mg-name").focus();
}

function localIsoNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function saveMoodGroups(nextGroups, nextActive = state.activeMoodGroup) {
  const ts = localIsoNow();
  const payload = {
    mood_groups: JSON.stringify(nextGroups),
    mood_groups_updated_at: ts,
    active_mood_group: nextActive,
  };
  const updated = await api("/api/settings", { method: "PATCH", body: JSON.stringify(payload) });
  state.settings = { ...state.settings, ...payload, ...updated };
  state.moodGroups = nextGroups;
  state.activeMoodGroup = nextActive;
  renderMoodModal();
}

function renderMoodGroupManager() {
  const gl = $("#mood-group-list");
  if (gl) {
    gl.innerHTML = state.moodGroups.length
      ? state.moodGroups
          .map(
            (g) => `
        <div class="list-row">
          <div class="row-inline" style="gap:6px;">
            <strong>${esc(moodGroupLabel(g))}</strong>
            <span class="muted mono sm-text">(${(g.dim_ids || []).filter((id) => state.stateDims.some((d) => d.id === id)).length})</span>
          </div>
          <div class="row-inline">
            <button type="button" class="btn ghost sm" data-mg-edit="${esc(g.id)}" title="${esc(t("btn_edit"))}">Edit</button>
            <button type="button" class="btn ghost sm" data-mg-del="${esc(g.id)}" title="${esc(t("del_title"))}">✕</button>
          </div>
        </div>`
          )
          .join("")
      : "";
  }
  const picks = $("#mg-dim-picks");
  if (picks) {
    picks.innerHTML = state.stateDims
      .map((d) => {
        const col = dimColor(d);
        const sel = state.mgDraftDims.has(d.id);
        return `<button type="button" class="mg-dim-chip ${sel ? "selected" : ""}" style="--axis-c:${esc(col)}" data-mg-dim="${esc(d.id)}"><span class="chip-dot" style="background:${esc(col)};margin-right:2px;"></span>${esc(dimName(d))}</button>`;
      })
      .join("");
  }
}

function renderMoodModal() {
  // Calm questionnaire group switcher pills (Alltag / Zyklus / Alle / +)
  const gPills = $("#mood-group-pills");
  const activeGrp = state.activeMoodGroup !== "all" ? state.moodGroups.find((g) => g.id === state.activeMoodGroup) : null;
  let visibleDims = state.stateDims;
  if (activeGrp) {
    const dimMap = Object.fromEntries(state.stateDims.map((d) => [d.id, d]));
    const ordered = activeGrp.dim_ids.map((id) => dimMap[id]).filter(Boolean);
    visibleDims = ordered;
  }

  if (gPills) {
    if (state.moodGroups.length) {
      gPills.classList.remove("hidden");
      const dragHintHtml =
        visibleDims.length >= 2
          ? `<span class="muted mood-drag-hint">${esc(t("drag_hint"))}</span>`
          : "";
      gPills.innerHTML =
        state.moodGroups
          .map(
            (g) =>
              `<button type="button" class="pill ${state.activeMoodGroup === g.id ? "active" : ""}" data-mgroup="${esc(g.id)}">${esc(moodGroupLabel(g))}</button>`
          )
          .join("") +
        `<button type="button" class="pill ${state.activeMoodGroup === "all" ? "active" : ""}" data-mgroup="all">${esc(t("mg_all"))}</button>` +
        `<button type="button" class="pill mood-group-add-pill" data-mgroup-new="1" title="${esc(t("mg_add_title"))}">+</button>` +
        dragHintHtml;
    } else {
      gPills.classList.add("hidden");
      gPills.innerHTML = "";
    }
  }

  const list = $("#mood-axes-list");
  list.innerHTML = visibleDims.length
    ? visibleDims
        .map((d) => {
          const col = dimColor(d);
          const cur = state.moodRatings[d.id];
          const isEditing = state.editingDimId === d.id;
          const btns = [1, 2, 3, 4, 5]
            .map(
              (v) =>
                `<button type="button" class="mood-btn ${cur === v ? "selected" : ""}" data-mdim="${esc(d.id)}" data-mval="${v}">${v}</button>`
            )
            .join("");
          const lo = dimLow(d);
          const hi = dimHigh(d);
          const dotPicker = `<label class="dim-dot-picker" style="background:${esc(col)}" title="${esc(t("dim_pick_color_title"))}"><input type="color" data-dim-color="${esc(d.id)}" value="${esc(col)}" /></label>`;
          if (isEditing) {
            return `
      <div class="mood-axis is-editing" data-dim-id="${esc(d.id)}" style="--axis-c:${esc(col)}">
        <form class="dim-inline-edit" data-dim-edit-form="${esc(d.id)}">
          <div class="row-inline" style="gap:6px;">
            ${dotPicker}
            <input type="text" id="dim-edit-name" value="${esc(dimName(d))}" required style="flex:1;" />
            <button type="submit" class="btn primary sm">${esc(t("btn_save"))}</button>
            <button type="button" class="btn ghost sm" data-dim-edit-cancel="1" title="${esc(t("btn_cancel"))}">✕</button>
          </div>
          <div class="row-2" style="gap:6px;">
            <input type="text" id="dim-edit-low" value="${esc(lo)}" placeholder="${esc(t("ma_low_ph"))}" />
            <input type="text" id="dim-edit-high" value="${esc(hi)}" placeholder="${esc(t("ma_high_ph"))}" />
          </div>
        </form>
        <div class="mood-scale">${btns}</div>
      </div>`;
          }
          const anchors =
            lo || hi
              ? `<div class="mood-anchors editable" data-dim-inline-edit="${esc(d.id)}" data-focus="low" title="${esc(t("dim_rename_title"))}"><span>${esc(lo)}</span><span>${esc(hi)}</span></div>`
              : "";
          return `
      <div class="mood-axis" data-dim-id="${esc(d.id)}" title="${esc(t("drag_reorder_title"))}" style="--axis-c:${esc(col)}">
        <div class="mood-axis-head">
          <span class="row-inline" style="gap:6px;">
            ${dotPicker}
            <strong class="mood-axis-title" data-dim-inline-edit="${esc(d.id)}" title="${esc(t("dim_rename_title"))}">${esc(dimName(d))}</strong>
          </span>
          <button type="button" class="btn ghost sm" data-hide-dim="${esc(d.id)}" title="${esc(t("mood_hide_title"))}" style="padding:1px 6px;font-size:11px;">✕</button>
        </div>
        <div class="mood-scale">${btns}</div>
        ${anchors}
      </div>`;
        })
        .join("")
    : `<div class="muted sm-text">${esc(t("mg_empty_group"))}</div>`;

  renderMoodGroupManager();

  const archBox = $("#mood-archived-axes");
  archBox.innerHTML = state.archivedDims.length
    ? `<span class="muted sm-text">${esc(t("mood_hidden_lbl"))}</span>` +
      state.archivedDims
        .map(
          (d) =>
            `<button type="button" class="pill" data-restore-dim="${esc(d.id)}">+ ${esc(dimName(d))}</button>`
        )
        .join("")
    : "";

  const causesWrap = $("#mood-causes-wrap");
  if (!state.habits.length) {
    causesWrap.classList.add("hidden");
  } else {
    causesWrap.classList.remove("hidden");
    $("#mood-causes-chips").innerHTML = state.habits
      .map(
        (h) =>
          `<button type="button" class="cause-pill ${state.moodCauses.has(h.id) ? "active" : ""}" data-mcause="${esc(h.id)}">${esc(h.name)}</button>`
      )
      .join("");
  }
}

function renderRetroRows() {
  const box = $("#retro-rows");
  if (!state.habits.length) {
    box.innerHTML = `<div class="muted sm-text">${esc(t("retro_empty"))}</div>`;
  } else {
    box.innerHTML = state.habits
      .map((h) => {
        const val = state.retroAmounts[h.id] || 0;
        return `
        <div class="retro-row ${val !== 0 ? "has-val" : ""}">
          <div class="row-inline">
            <span class="ev-dot" style="background:${esc(h.color)}"></span>
            <strong>${esc(h.name)}</strong>
            <span class="muted mono sm-text">${esc(h.unit)}</span>
          </div>
          <div class="stepper">
            <button type="button" class="btn ghost sm" data-rstep="${esc(h.id)}" data-d="-1">−</button>
            <span class="stepper-val">${val > 0 ? "+" + fmtNum(val) : fmtNum(val)}</span>
            <button type="button" class="btn primary sm" data-rstep="${esc(h.id)}" data-d="1">+</button>
          </div>
        </div>`;
      })
      .join("");
  }
  const chosen = Object.entries(state.retroAmounts).filter(([, v]) => v !== 0);
  const sumText = chosen.length
    ? chosen
        .map(([id, v]) => {
          const h = state.habits.find((x) => x.id === id);
          return `${v > 0 ? "+" : ""}${fmtNum(v)} ${h ? h.name : id}`;
        })
        .join(" · ")
    : t("retro_pick_hint");
  $("#retro-summary").textContent = sumText;
}

// ---- SETUP & ROUTING VIEW ----
function syncNudgeModeUI(mode) {
  $$("[data-nudge-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.nudgeMode === mode);
  });
}

function syncRoutingModeUI(mode) {
  $$("[data-routing-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.routingMode === mode);
  });
}

async function loadSetup(editId = null) {
  const [data, pairInfo, e2eeInfo] = await Promise.all([
    api("/api/habits?include_archived=true"),
    api("/api/sync/info").catch(() => null),
    isStandaloneBrowserMode()
      ? Promise.resolve(window.DailyE2EE ? window.DailyE2EE.loadCfg() : null)
      : api("/api/e2ee/config").catch(() => null),
  ]);
  const all = data.habits || [];
  state.habits = all.filter((h) => !h.archived);
  state.archivedHabits = all.filter((h) => !!h.archived);
  state.edges = data.edges;
  state.settings = data.settings || {};
  renderSetup(pairInfo, e2eeInfo);
  if (editId) populateHabitForm(editId);
}

function formatAnchorBadge(h) {
  const rt = (h.reminder_time || "").trim();
  if (!rt) return "";
  const days = String(h.reminder_days || "0,1,2,3,4,5,6")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const dayStr =
    days.length >= 7 ? "" : " · " + days.map((d) => weekdayShort(Number(d)) || d).join(",");
  return `<span class="chip">⏰ ${esc(rt)}${esc(dayStr)}</span>`;
}

function setReminderDaysUI(daysCsv) {
  const active = new Set(
    String(daysCsv || "0,1,2,3,4,5,6")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  $$("#hf-rem-days [data-wd]").forEach((b) => {
    b.classList.toggle("active", active.has(b.dataset.wd));
  });
}

function getReminderDaysCSV() {
  const chosen = $$("#hf-rem-days [data-wd].active").map((b) => b.dataset.wd);
  return chosen.length ? chosen.join(",") : "0,1,2,3,4,5,6";
}

function syncE2EEFieldsUI(provider) {
  $("#e2ee-gist-fields").classList.toggle("hidden", provider !== "gist");
  $("#e2ee-url-fields").classList.toggle("hidden", provider !== "url");
}

function renderE2EEPanel(cfg) {
  if (!cfg) return;
  const prov = cfg.provider || "gist";
  $("#e2ee-provider").value = prov;
  syncE2EEFieldsUI(prov);
  $("#e2ee-token").value = prov === "gist" ? cfg.auth_token || "" : "";
  $("#e2ee-gist-id").value = cfg.gist_id || "";
  $("#e2ee-url").value = cfg.endpoint_url || "";
  $("#e2ee-url-token").value = prov === "url" ? cfg.auth_token || "" : "";
  $("#e2ee-key").value = cfg.key_b64u || "";

  const pairUrl =
    (cfg.pairing && cfg.pairing.pair_url) ||
    (window.DailyE2EE && cfg.key_b64u ? window.DailyE2EE.buildPairingUrl(cfg) : "");
  const qrSvg =
    (cfg.pairing && cfg.pairing.qr_svg) ||
    (window.DailyQR && pairUrl ? window.DailyQR.toSvg(pairUrl) : "");

  if (pairUrl) {
    $("#e2ee-pair-wrap").classList.remove("hidden");
    $("#e2ee-pair-url").value = pairUrl;
    if (qrSvg) {
      $("#e2ee-qr-box").classList.remove("hidden");
      $("#e2ee-qr-box").innerHTML = qrSvg;
    } else {
      $("#e2ee-qr-box").classList.add("hidden");
    }
  } else {
    $("#e2ee-pair-wrap").classList.add("hidden");
  }

  const isActive = !!(cfg.enabled && cfg.key_b64u);
  state.e2eeActive = isActive;
  const setupDetails = $("#e2ee-setup-details");
  const setupSummary = $("#e2ee-setup-summary");
  if (setupDetails) {
    setupDetails.open = !isActive;
  }
  if (setupSummary) {
    setupSummary.textContent = t(isActive ? "sync_setup_summary_active" : "sync_setup_summary_unpaired");
  }

  if (isActive) {
    const ts = cfg.last_sync_at ? ` · ${t("sync_last", { ts: cfg.last_sync_at.slice(0, 16).replace("T", " ") })}` : "";
    const provLbl = prov === "gist" ? t("sync_prov_gist_short") : t("sync_prov_url_short");
    const gistTag = prov === "gist" && cfg.gist_id ? ` ${cfg.gist_id.slice(0, 6)}…` : "";
    const keyTag = ` · Key ${cfg.key_b64u.slice(0, 6)}…`;
    $("#e2ee-status-line").innerHTML = `<strong class="pos">${esc(t("sync_status_active"))}</strong> · ${esc(provLbl)}<span class="mono">${esc(gistTag)}${esc(keyTag)}</span>${esc(ts)}`;
  } else {
    $("#e2ee-status-line").innerHTML = t("sync_status_unpaired_html");
  }
}

function renderHabitGroupChips() {
  const box = $("#hf-group-chips");
  const inp = $("#hf-group");
  if (!box || !inp) return;
  const seen = new Set();
  const names = [];
  for (const h of [...(state.habits || []), ...(state.archivedHabits || [])]) {
    const g = String(h.group_name || "").trim();
    if (!g || seen.has(g.toLowerCase())) continue;
    seen.add(g.toLowerCase());
    names.push(g);
  }
  if (!names.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  const cur = inp.value.trim().toLowerCase();
  box.innerHTML = names
    .map(
      (g) =>
        `<button type="button" class="tag-suggest-chip${g.toLowerCase() === cur ? " selected" : ""}" data-hf-group-pick="${esc(g)}">${esc(g)}</button>`
    )
    .join("");
  box.classList.remove("hidden");
}

function renderSetupHabitList() {
  const list = $("#setup-habit-list");
  if (!list) return;
  $("#setup-habit-count").textContent = `(${state.habits.length})`;
  const rollups = (state.edges || []).filter((e) => e.relation_type === "rollup");
  const outMap = {};
  for (const e of rollups) {
    (outMap[e.source_id] ||= []).push(e);
  }
  if (!state.habits.length) {
    list.innerHTML = `<div class="muted sm-text">${esc(t("no_habits_yet"))}</div>`;
    return;
  }
  const rowHtml = (h) => {
    const outs = (outMap[h.id] || [])
      .map(
        (r) =>
          `<span class="chip ${r.weight >= 0 ? "pos-chip" : "neg-chip"}">→ ${r.weight >= 0 ? "+" : ""}${fmtNum(r.weight)} ${esc(r.target_name)}</span>`
      )
      .join("");
    return `
        <div class="list-row setup-drag-row" data-habit-id="${esc(h.id)}" data-orig-group="${esc(h.group_name || "")}" title="${esc(t("drag_reorder_title"))}">
          <div class="row-inline" style="flex:1;min-width:0;">
            <span class="ev-dot" style="background:${esc(h.color)}"></span>
            <strong>${esc(h.name)}</strong>
            <span class="badge ${esc(kindBadgeClass(h))}">${esc(kindBadgeText(h))}</span>
            ${outs}
            ${h.block_minutes ? `<span class="chip">⏱ ${h.block_minutes}m=1</span>` : ""}
            ${habitTapStep(h) !== 1 ? `<span class="chip">+${fmtNum(habitTapStep(h))} ${esc(h.unit || "x")}</span>` : ""}
            ${h.nudge_enabled ? `<span class="chip">Ping −${h.nudge_lead_min}m</span>` : ""}
            ${formatAnchorBadge(h)}
          </div>
          <div class="row-inline">
            <button type="button" class="btn ghost sm" data-setup-edit="${esc(h.id)}" title="${esc(t("btn_edit"))}">Edit</button>
          </div>
        </div>`;
  };

  const hasAnyGroup = state.habits.some((h) => String(h.group_name || "").trim() !== "");
  if (!hasAnyGroup) {
    list.innerHTML = state.habits.map(rowHtml).join("");
    return;
  }

  // Group habits in order of first appearance (each group is a collapsible, draggable block!)
  const bucketMap = new Map();
  const buckets = [];
  for (const h of state.habits) {
    const g = String(h.group_name || "").trim();
    if (!bucketMap.has(g)) {
      const b = { key: g, habits: [] };
      bucketMap.set(g, b);
      buckets.push(b);
    }
    bucketMap.get(g).habits.push(h);
  }
  list.innerHTML = buckets
    .map((b) => {
      const isOpen = !state.closedHabitGroups.has(b.key);
      const label = b.key ? b.key : t("habit_group_ungrouped");
      return `
      <details class="habit-group" data-habit-group="${esc(b.key)}"${isOpen ? " open" : ""}>
        <summary class="habit-group-head" title="${esc(t("drag_reorder_title"))}">
          <span class="row-inline" style="min-width:0;">
            <span class="route-caret"></span>
            <strong>${esc(label)}</strong>
          </span>
          <span class="muted mono sm-text">${b.habits.length}</span>
        </summary>
        <div class="habit-group-items" data-group-container="${esc(b.key)}">
          ${b.habits.map(rowHtml).join("")}
        </div>
      </details>`;
    })
    .join("");
}

function renderSetup(pairInfo = null, e2eeInfo = null) {
  renderSetupHabitList();
  renderHabitGroupChips();

  // Archived / finished temporary cards (books, completed projects)
  const archDetails = $("#archive-details");
  if (state.archivedHabits.length) {
    archDetails.classList.remove("hidden");
    $("#archive-count").textContent = `(${state.archivedHabits.length})`;
    $("#archive-habit-list").innerHTML = state.archivedHabits
      .map(
        (h) => `
      <div class="list-row">
        <div class="row-inline">
          <span class="ev-dot" style="background:${esc(h.color)};opacity:0.6"></span>
          <span class="muted">${esc(h.name)}</span>
        </div>
        <button type="button" class="btn ghost sm" data-unarchive-id="${esc(h.id)}">${esc(t("btn_restore"))}</button>
      </div>`
      )
      .join("");
  } else {
    archDetails.classList.add("hidden");
  }

  // Sync & Pairing info
  const lanClientFields = $("#sync-lan-client-fields");
  if (pairInfo && pairInfo.standalone) {
    $("#sync-qr-box").classList.add("hidden");
    $("#sync-pair-row").classList.add("hidden");
    if (lanClientFields) lanClientFields.classList.remove("hidden");
    $("#sync-hint-text").innerHTML = t("lan_standalone_html");
  } else if (pairInfo) {
    $("#sync-qr-box").classList.remove("hidden");
    $("#sync-pair-row").classList.remove("hidden");
    // On the local PC server itself, hide client-only LAN server/token inputs to avoid confusion
    if (lanClientFields) lanClientFields.classList.add("hidden");
    $("#sync-pair-url").value = pairInfo.primary_url || "";
    $("#sync-qr-box").innerHTML = pairInfo.qr_svg || `<span class="muted sm-text">QR</span>`;
  }
  $("#sync-custom-server").value = localStorage.getItem("daily_server_url") || "";
  $("#sync-custom-token").value = localStorage.getItem("daily_sync_token") || "";
  renderE2EEPanel(e2eeInfo);

  // Notification settings live here in Setup
  $("#set-interval").value = state.settings.checkin_interval_hours || "3";
  $("#set-qstart").value = state.settings.quiet_hours_start || "23";
  $("#set-qend").value = state.settings.quiet_hours_end || "8";
  $("#set-notif").checked = state.settings.notifications_enabled === "1";
  $("#set-followup").checked = state.settings.followup_enabled !== "0";
  syncRoutingModeUI(state.settings.routing_mode || "observed");
  syncNudgeModeUI(state.settings.nudge_mode || "observed");

  // Populate edge selects (prefer a sensible non-self target, e.g. a Mehr goal over a Weniger limit)
  const opts = state.habits.map((h) => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join("");
  ["#rf-source", "#rf-target", "#hyp-source", "#hyp-target"].forEach((sel) => {
    const el = $(sel);
    const prev = el.value;
    el.innerHTML = opts || `<option value="">${esc(t("need_habits_opt"))}</option>`;
    if (prev && state.habits.some((h) => h.id === prev)) el.value = prev;
  });
  if (state.habits.length >= 2) {
    if ($("#rf-source").value === $("#rf-target").value) {
      $("#rf-target").value = pickDefaultRouteTarget($("#rf-source").value);
    }
    if ($("#hyp-source").value === $("#hyp-target").value) {
      $("#hyp-target").value = pickDefaultRouteTarget($("#hyp-source").value);
    }
  }

  // Render rollup edges clustered by target habit (following your Habit order!)
  renderRollupList();
  renderRoutingGraph();

  // Render hypothesis edges
  const hyps = state.edges.filter((e) => e.relation_type === "hypothesis");
  $("#hyp-list").innerHTML = hyps.length
    ? hyps
        .map(
          (e) => `
      <div class="list-row">
        <div>
          <div class="row-inline">
            <strong>${esc(e.source_name)}</strong>
            <span class="chip">${esc(windowLabel(e.context_window))}</span>
            <span class="chip ${e.weight >= 0 ? "pos-chip" : "neg-chip"}">${esc(e.weight >= 0 ? t("hyp_pos") : t("hyp_neg"))}</span>
            <span class="arrow">→</span>
            <strong>${esc(e.target_name)}</strong>
          </div>
          ${e.note ? `<div class="muted sm-text">${esc(e.note)}</div>` : ""}
        </div>
        <div class="row-inline">
          <button class="btn ghost sm" data-edit-hyp="${e.id}" title="${esc(t("edit_edge_title"))}">Edit</button>
          <button class="btn ghost sm" data-del-edge="${e.id}" title="${esc(t("del_title"))}">✕</button>
        </div>
      </div>`
        )
        .join("")
    : `<div class="muted sm-text">${esc(t("no_hyps"))}</div>`;
  resetRollupForm();
  resetHypForm();
  renderHabitColorSwatches();
}

function renderRollupList() {
  const box = $("#rollup-list");
  if (!box) return;
  const rollups = (state.edges || []).filter((e) => e.relation_type === "rollup");
  if (!rollups.length) {
    box.innerHTML = `<div class="muted sm-text">${esc(t("no_rollups"))}</div>`;
    return;
  }
  const habitById = {};
  const orderIdx = {};
  (state.habits || []).forEach((h, i) => {
    habitById[h.id] = h;
    orderIdx[h.id] = i;
  });
  (state.archivedHabits || []).forEach((h, i) => {
    if (!habitById[h.id]) {
      habitById[h.id] = h;
      orderIdx[h.id] = 10000 + i;
    }
  });

  const q = (state.routeFilterQuery || "").trim().toLowerCase();
  const focusId = state.graphFocusHabitId && habitById[state.graphFocusHabitId] ? state.graphFocusHabitId : null;
  const focusHabit = focusId ? habitById[focusId] : null;
  let filteredRollups = focusId
    ? rollups.filter((e) => e.source_id === focusId || e.target_id === focusId)
    : rollups;
  if (q) {
    filteredRollups = filteredRollups.filter(
      (e) =>
        String(e.source_name || "").toLowerCase().includes(q) ||
        String(e.target_name || "").toLowerCase().includes(q)
    );
  }

  const groupsMap = new Map();
  for (const e of filteredRollups) {
    if (!groupsMap.has(e.target_id)) {
      groupsMap.set(e.target_id, {
        target_id: e.target_id,
        target_name: e.target_name || (habitById[e.target_id] && habitById[e.target_id].name) || e.target_id,
        target: habitById[e.target_id] || null,
        edges: [],
      });
    }
    groupsMap.get(e.target_id).edges.push(e);
  }

  const groups = Array.from(groupsMap.values()).sort((a, b) => {
    const oa = orderIdx[a.target_id] ?? 99999;
    const ob = orderIdx[b.target_id] ?? 99999;
    if (oa !== ob) return oa - ob;
    return a.target_name.localeCompare(b.target_name);
  });

  const autoOpen = rollups.length <= 8;
  const showTools = !focusId && (rollups.length > 8 || groups.length > 3 || !!q);
  const allCurrentlyOpen =
    groups.length > 0 &&
    groups.every((g) =>
      q || focusId
        ? true
        : state.routeClustersAllOpen !== null
          ? state.routeClustersAllOpen
          : autoOpen || state.openRouteClusters.has(g.target_id)
    );

  const focusBannerHtml = focusHabit
    ? `<div class="graph-focus-banner">
        <span class="row-inline" style="gap:7px;min-width:0;">
          <span class="ev-dot" style="background:${esc(focusHabit.color || "var(--accent)")}"></span>
          <strong>${esc(t("route_graph_focus", { name: focusHabit.name }))}</strong>
        </span>
        <button type="button" class="btn ghost sm" id="btn-clear-graph-focus" title="${esc(t("btn_close"))}">✕</button>
      </div>`
    : "";

  const toolsHtml = showTools
    ? `<div class="route-tools-bar">
        <input type="text" id="route-filter-input" class="filter-search" style="flex:1;width:auto;min-width:120px;" value="${esc(state.routeFilterQuery)}" placeholder="${esc(t("route_filter_ph"))}" />
        <button type="button" class="btn ghost sm" id="btn-toggle-all-routes">${esc(t(allCurrentlyOpen ? "route_collapse_all" : "route_expand_all"))}</button>
      </div>`
    : "";

  const clustersHtml = groups.length
    ? groups
        .map((g) => {
          g.edges.sort((a, b) => {
            const aPos = Number(a.weight) >= 0 ? 0 : 1;
            const bPos = Number(b.weight) >= 0 ? 0 : 1;
            if (aPos !== bPos) return aPos - bPos;
            const magDiff = Math.abs(Number(b.weight)) - Math.abs(Number(a.weight));
            if (Math.abs(magDiff) > 1e-6) return magDiff;
            const sa = orderIdx[a.source_id] ?? 99999;
            const sb = orderIdx[b.source_id] ?? 99999;
            if (sa !== sb) return sa - sb;
            return String(a.source_name || "").localeCompare(String(b.source_name || ""));
          });
          const tColor = (g.target && g.target.color) || "var(--muted)";
          const tBadge =
            g.target && g.target.kind !== "neutral"
              ? `<span class="badge ${esc(kindBadgeClass(g.target))}">${esc(kindBadgeText(g.target))}</span>`
              : "";
          const posCnt = g.edges.filter((e) => Number(e.weight) >= 0).length;
          const negCnt = g.edges.length - posCnt;
          const countSummary = [
            posCnt ? `<span class="pos">+${posCnt}</span>` : "",
            negCnt ? `<span class="neg">−${negCnt}</span>` : "",
          ]
            .filter(Boolean)
            .join(" · ");
          const isOpen =
            q || focusId
              ? true
              : state.routeClustersAllOpen !== null
                ? state.routeClustersAllOpen
                : autoOpen || state.openRouteClusters.has(g.target_id);
          const rowsHtml = g.edges
            .map((e) => {
              const srcH = habitById[e.source_id];
              const sColor = (srcH && srcH.color) || "var(--muted)";
              return `
          <div class="route-cluster-row">
            <div class="row-inline" style="min-width:0;">
              <span class="ev-dot" style="background:${esc(sColor)}"></span>
              <strong>${esc(e.source_name)}</strong>
              <span class="chip ${e.weight >= 0 ? "pos-chip" : "neg-chip"}">${e.weight >= 0 ? "+" : ""}${fmtNum(e.weight)}</span>
            </div>
            <div class="row-inline">
              <button class="btn ghost sm" data-edit-rollup="${e.id}" title="${esc(t("edit_edge_title"))}">Edit</button>
              <button class="btn ghost sm" data-del-edge="${e.id}" title="${esc(t("del_title"))}">✕</button>
            </div>
          </div>`;
            })
            .join("");
          return `
      <details class="route-cluster" data-route-target="${esc(g.target_id)}"${isOpen ? " open" : ""}>
        <summary class="route-cluster-head">
          <div class="row-inline" style="min-width:0;">
            <span class="route-caret"></span>
            <span class="arrow">→</span>
            <span class="ev-dot" style="background:${esc(tColor)}"></span>
            <strong>${esc(g.target_name)}</strong>
            ${tBadge}
          </div>
          <span class="mono sm-text muted">${countSummary}</span>
        </summary>
        <div class="route-cluster-items">${rowsHtml}</div>
      </details>`;
        })
        .join("")
    : `<div class="muted sm-text">${esc(
        focusHabit ? t("route_no_edges_for", { name: focusHabit.name }) : t("route_no_match")
      )}</div>`;

  // Preserve search focus & caret when filtering live
  const wasFocused = document.activeElement && document.activeElement.id === "route-filter-input";
  const selStart = wasFocused ? document.activeElement.selectionStart : null;
  box.innerHTML = focusBannerHtml + toolsHtml + clustersHtml;
  if (wasFocused) {
    const inp = $("#route-filter-input");
    if (inp) {
      inp.focus();
      if (selStart != null) inp.setSelectionRange(selStart, selStart);
    }
  }
}

const DEFAULT_HABIT_SWATCHES = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0d9488", "#475569"];
const RECENT_COLORS_KEY = "daily_recent_colors";
let qcColorDirty = false;
let routingGraph = null;
let graphShowHyps = false;
let graphOnlyLinked = false;
let graphOpenInitialized = false;

function ensureRoutingGraph() {
  if (routingGraph || !window.DailyForceGraph) return routingGraph;
  const canvas = $("#routing-graph-canvas");
  if (!canvas) return null;
  routingGraph = window.DailyForceGraph.create({
    canvas,
    readoutEl: $("#routing-graph-readout"),
    t,
    onSelectChange: (habitId) => {
      state.graphFocusHabitId = habitId || null;
      renderRollupList();
    },
    onNodeAction: (act, habitId) => {
      if (act === "edit") {
        populateHabitForm(habitId);
        return;
      }
      if (act === "src" || act === "dst") {
        const sel = act === "src" ? $("#rf-source") : $("#rf-target");
        const other = act === "src" ? $("#rf-target") : $("#rf-source");
        if (sel) {
          sel.value = habitId;
          if (other && other.value === habitId) {
            other.value = pickDefaultRouteTarget(habitId);
          }
          syncRollupExistingMatch({ autofill: true });
          const form = $("#rollup-form");
          if (form) form.scrollIntoView({ behavior: "smooth", block: "center" });
          toast(
            `${(state.habits.find((h) => h.id === habitId) || {}).name || ""} → ${
              act === "src" ? t("graph_set_src") : t("graph_set_dst")
            }`
          );
        }
      }
    },
  });
  return routingGraph;
}

function renderRoutingGraph(reheat = 0.5) {
  const panel = $("#routing-graph-panel");
  const metaEl = $("#graph-meta");
  const rollups = (state.edges || []).filter((e) => e.relation_type === "rollup");
  if (metaEl) {
    metaEl.textContent = t("graph_meta", { h: (state.habits || []).length, e: rollups.length });
  }
  if (!panel) return;
  if (!graphOpenInitialized) {
    graphOpenInitialized = true;
    const saved = localStorage.getItem("daily_graph_open");
    if (saved === "1") panel.open = true;
    else if (saved === "0") panel.open = false;
    else panel.open = window.innerWidth >= 920 && rollups.length >= 1;
  }
  if (!panel.open) return;
  const g = ensureRoutingGraph();
  if (!g) return;
  g.update({
    habits: state.habits || [],
    edges: state.edges || [],
    todayHabits: (state.todayData && state.todayData.habits) || [],
    reheat,
  });
  if (!g._didFirstFit) {
    g._didFirstFit = true;
    setTimeout(() => {
      if (routingGraph && panel.open) routingGraph.fit();
    }, 420);
  }
}

function normalizeHexColor(val) {
  const s = String(val || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : "";
}

function getStoredRecentColors() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeHexColor).filter(Boolean);
  } catch {
    return [];
  }
}

function getRecentHabitPalette(limit = 5) {
  const seen = new Set();
  const palette = [];
  const push = (hex) => {
    const c = normalizeHexColor(hex);
    if (!c || seen.has(c)) return;
    seen.add(c);
    palette.push(c);
  };
  for (const c of getStoredRecentColors()) push(c);
  const allHabits = [...(state.habits || []), ...(state.archivedHabits || [])].sort((a, b) =>
    String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || ""))
  );
  for (const h of allHabits) push(h.color);
  for (const c of DEFAULT_HABIT_SWATCHES) push(c);
  return palette.slice(0, limit);
}

function getDefaultHabitColor() {
  return getRecentHabitPalette(1)[0] || "#2563eb";
}

function syncQuickCreateColor(hex) {
  const inp = $("#qc-color");
  const wrap = $("#qc-color-wrap");
  if (!inp && !wrap) return;
  const col = normalizeHexColor(hex) || getDefaultHabitColor();
  if (inp) inp.value = col;
  if (wrap) wrap.style.background = col;
}

function rememberHabitColor(hex) {
  const c = normalizeHexColor(hex);
  if (!c) return;
  const next = [c, ...getStoredRecentColors().filter((x) => x !== c)].slice(0, 12);
  try {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(next));
  } catch {}
  renderHabitColorSwatches();
}

function syncActiveColorSwatch() {
  const inp = $("#hf-color");
  if (!inp) return;
  const cur = normalizeHexColor(inp.value);
  $$("#hf-colors .swatch").forEach((sw) => {
    sw.classList.toggle("active", normalizeHexColor(sw.dataset.color) === cur);
  });
}

function renderHabitColorSwatches() {
  const box = $("#hf-colors");
  const finalSwatches = getRecentHabitPalette(5);
  if (box) {
    box.querySelectorAll(".swatch").forEach((el) => el.remove());
    for (const c of finalSwatches) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "swatch";
      btn.dataset.color = c;
      btn.style.background = c;
      btn.title = c;
      btn.setAttribute("aria-label", c);
      box.appendChild(btn);
    }
    syncActiveColorSwatch();
  }
  if (!qcColorDirty) syncQuickCreateColor(finalSwatches[0]);
}

function syncRollupExistingMatch({ autofill = false } = {}) {
  const hint = $("#rf-existing-hint");
  const saveBtn = $("#btn-save-rollup");
  const editId = $("#rf-edit-id")?.value;
  if (editId) {
    if (hint) hint.classList.add("hidden");
    return;
  }
  const srcId = $("#rf-source")?.value;
  const dstId = $("#rf-target")?.value;
  const existing =
    srcId && dstId && srcId !== dstId
      ? (state.edges || []).find(
          (e) => e.relation_type === "rollup" && e.source_id === srcId && e.target_id === dstId
        )
      : null;
  if (existing) {
    const w = Number(existing.weight || 0);
    if (autofill) {
      if ($("#rf-sign")) $("#rf-sign").value = w >= 0 ? "1" : "-1";
      if ($("#rf-weight")) $("#rf-weight").value = String(Math.max(0.05, Math.round(Math.abs(w) * 100) / 100));
    }
    if (hint) {
      hint.innerHTML = `<span class="chip ${w >= 0 ? "pos-chip" : "neg-chip"}">${w >= 0 ? "+" : ""}${fmtNum(w)}</span><span>${esc(t("rf_existing_edge"))}</span>`;
      hint.classList.remove("hidden");
    }
    if (saveBtn) saveBtn.textContent = t("btn_update");
  } else {
    if (hint) hint.classList.add("hidden");
    if (saveBtn) saveBtn.textContent = t("btn_connect");
  }
}

function resetRollupForm() {
  const idEl = $("#rf-edit-id");
  if (idEl) idEl.value = "";
  const wEl = $("#rf-weight");
  if (wEl) wEl.value = "1";
  const saveBtn = $("#btn-save-rollup");
  if (saveBtn) saveBtn.textContent = t("btn_connect");
  const cancelBtn = $("#btn-cancel-rollup");
  if (cancelBtn) cancelBtn.classList.add("hidden");
  syncRollupExistingMatch({ autofill: true });
}

function populateRollupForm(edge) {
  if (!edge) return;
  $("#rf-edit-id").value = edge.id;
  $("#rf-source").value = edge.source_id;
  $("#rf-sign").value = edge.weight >= 0 ? "1" : "-1";
  $("#rf-weight").value = String(Math.max(0.05, Math.round(Math.abs(Number(edge.weight || 1)) * 100) / 100));
  $("#rf-target").value = edge.target_id;
  $("#btn-save-rollup").textContent = t("btn_save");
  $("#btn-cancel-rollup").classList.remove("hidden");
  const hint = $("#rf-existing-hint");
  if (hint) hint.classList.add("hidden");
  $("#rf-weight").focus();
  $("#rf-weight").select();
}

function resetHypForm() {
  const idEl = $("#hyp-edit-id");
  if (idEl) idEl.value = "";
  const saveBtn = $("#btn-save-hyp");
  if (saveBtn) saveBtn.textContent = t("btn_save_hyp");
  const cancelBtn = $("#btn-cancel-hyp");
  if (cancelBtn) cancelBtn.classList.add("hidden");
}

function populateHypForm(edge) {
  if (!edge) return;
  $("#hyp-edit-id").value = edge.id;
  $("#hyp-source").value = edge.source_id;
  $("#hyp-window").value = edge.context_window || "any";
  $("#hyp-sign").value = edge.weight >= 0 ? "1" : "-1";
  $("#hyp-target").value = edge.target_id;
  $("#hyp-note").value = edge.note || "";
  $("#btn-save-hyp").textContent = t("btn_save");
  $("#btn-cancel-hyp").classList.remove("hidden");
  $("#hyp-note").focus();
}

function clearHabitNameMatches() {
  const box = $("#hf-name-matches");
  if (!box) return;
  box.classList.add("hidden");
  box.innerHTML = "";
}

function renderHabitNameMatches() {
  const box = $("#hf-name-matches");
  const inp = $("#hf-name");
  if (!box || !inp) return;
  if ($("#hf-id").value) {
    clearHabitNameMatches();
    return;
  }
  const q = inp.value.trim().toLowerCase();
  if (!q) {
    clearHabitNameMatches();
    return;
  }
  const pool = [
    ...(state.habits || []).map((h, i) => ({ h, archived: false, order: i })),
    ...(state.archivedHabits || []).map((h, i) => ({ h, archived: true, order: 10000 + i })),
  ].filter((x) => String(x.h.name || "").toLowerCase().includes(q));

  if (!pool.length) {
    clearHabitNameMatches();
    return;
  }

  pool.sort((a, b) => {
    const na = String(a.h.name || "").toLowerCase();
    const nb = String(b.h.name || "").toLowerCase();
    const ea = na === q ? 0 : na.startsWith(q) ? 1 : 2;
    const eb = nb === q ? 0 : nb.startsWith(q) ? 1 : 2;
    if (ea !== eb) return ea - eb;
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return a.order - b.order;
  });

  box.innerHTML = pool
    .slice(0, 6)
    .map(({ h, archived }) => {
      const exact = String(h.name || "").toLowerCase() === q;
      const badge =
        h.kind !== "neutral"
          ? `<span class="badge ${esc(kindBadgeClass(h))}">${esc(kindBadgeText(h))}</span>`
          : "";
      const cta = archived
        ? t("hf_match_restore")
        : exact
          ? t("hf_match_exists")
          : "Edit →";
      return `
      <button type="button" class="name-match-item${exact ? " is-exact" : ""}" data-match-habit="${esc(h.id)}" data-match-archived="${archived ? "1" : "0"}">
        <span class="row-inline" style="min-width:0;">
          <span class="ev-dot" style="background:${esc(h.color || "var(--muted)")};${archived ? "opacity:0.55;" : ""}"></span>
          <strong>${esc(h.name)}</strong>
          ${badge}
        </span>
        <span class="name-match-cta">${esc(cta)}</span>
      </button>`;
    })
    .join("");
  box.classList.remove("hidden");
}

function resetHabitForm() {
  $("#habit-form-title").textContent = t("hf_title_new");
  $("#hf-id").value = "";
  $("#hf-name").value = "";
  clearHabitNameMatches();
  $("#hf-kind").value = "neutral";
  $("#hf-target").value = "";
  $("#hf-period").value = "day";
  $("#hf-unit").value = "x";
  if ($("#hf-step")) $("#hf-step").value = "1";
  const firstSw = $("#hf-colors .swatch");
  $("#hf-color").value = (firstSw && firstSw.dataset.color) || getStoredRecentColors()[0] || "#2563eb";
  syncActiveColorSwatch();
  $("#hf-block-min").value = "";
  if ($("#hf-group")) $("#hf-group").value = "";
  renderHabitGroupChips();
  $("#hf-nudge-enabled").checked = false;
  $("#hf-nudge-lead").value = "20";
  $("#hf-nudge-alts").value = "";
  $("#hf-rem-time").value = "";
  setReminderDaysUI("0,1,2,3,4,5,6");
  $("#btn-cancel-edit").classList.add("hidden");
  $("#btn-delete-habit").classList.add("hidden");
}

function pickDefaultRouteTarget(sourceId) {
  const others = state.habits.filter((x) => x.id !== sourceId);
  if (!others.length) return sourceId || "";
  const preferred =
    others.find((x) => x.kind === "min") ||
    others.find((x) => x.kind === "neutral") ||
    others[0];
  return preferred.id;
}

function syncEdgeSourceToHabit(habitId) {
  if (!habitId || state.habits.length < 2) return;
  const rfSrc = $("#rf-source");
  const rfDst = $("#rf-target");
  if (rfSrc && rfDst) {
    rfSrc.value = habitId;
    if (!rfDst.value || rfDst.value === habitId) rfDst.value = pickDefaultRouteTarget(habitId);
  }
  const hSrc = $("#hyp-source");
  const hDst = $("#hyp-target");
  if (hSrc && hDst) {
    hSrc.value = habitId;
    if (!hDst.value || hDst.value === habitId) hDst.value = pickDefaultRouteTarget(habitId);
  }
}

function populateHabitForm(habitId) {
  const h = state.habits.find((x) => x.id === habitId);
  if (!h) return;
  clearHabitNameMatches();
  $("#habit-form-title").textContent = t("hf_title_edit", { name: h.name });
  $("#hf-id").value = h.id;
  $("#hf-name").value = h.name;
  $("#hf-kind").value = h.kind;
  $("#hf-target").value = h.target != null ? h.target : "";
  $("#hf-period").value = h.target_period || "day";
  $("#hf-unit").value = h.unit || "x";
  if ($("#hf-step")) $("#hf-step").value = String(habitTapStep(h));
  $("#hf-color").value = h.color || "#2563eb";
  syncActiveColorSwatch();
  $("#hf-block-min").value = h.block_minutes != null ? h.block_minutes : "";
  if ($("#hf-group")) $("#hf-group").value = h.group_name || "";
  renderHabitGroupChips();
  $("#hf-nudge-enabled").checked = !!h.nudge_enabled;
  $("#hf-nudge-lead").value = h.nudge_lead_min || 20;
  $("#hf-nudge-alts").value = h.nudge_alternatives || "";
  $("#hf-rem-time").value = h.reminder_time || "";
  setReminderDaysUI(h.reminder_days || "0,1,2,3,4,5,6");
  $("#btn-cancel-edit").classList.remove("hidden");
  $("#btn-delete-habit").classList.remove("hidden");
  syncEdgeSourceToHabit(h.id);
}

// ---- ANALYSIS VIEW (CALM, DIRECT, NO TECH CLUTTER) ----
function syncStateZoomUI() {
  $$("#state-zoom-switch [data-szoom]").forEach((b) => {
    b.classList.toggle("active", b.dataset.szoom === state.stateZoom);
  });
  const tBtn = $("#state-legend [data-sline='tabpfn']");
  const oBtn = $("#state-legend [data-sline='ode']");
  if (tBtn) tBtn.classList.toggle("active", state.showTabpfnLine);
  if (oBtn) oBtn.classList.toggle("active", state.showOdeLine);
}

function buildSmoothCurvePath(pts) {
  if (!pts || pts.length < 2) return "";
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const cx = ((prev.x + curr.x) / 2).toFixed(1);
    d += ` C ${cx} ${prev.y.toFixed(1)}, ${cx} ${curr.y.toFixed(1)}, ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}`;
  }
  return d;
}

const CHART_MIN_SPAN_HR = 6;
const CHART_MAX_SPAN_HR = 64 * 24;
const CHART_MIN_HR = -60 * 24;
const CHART_MAX_HR = 8 * 24;

function getPresetChartView(zoom, nowHr = 12) {
  if (zoom === "h24") return { startHr: -2, endHr: 28 };
  if (zoom === "w8") return { startHr: -54 * 24, endHr: 24 + 96 };
  return { startHr: -13 * 24, endHr: Math.max(24 + 48, nowHr + 48) };
}

function clampChartView(startHr, endHr) {
  let span = Math.max(CHART_MIN_SPAN_HR, Math.min(CHART_MAX_SPAN_HR, endHr - startHr));
  let s = startHr;
  let e = s + span;
  if (s < CHART_MIN_HR) {
    s = CHART_MIN_HR;
    e = Math.min(CHART_MAX_HR, s + span);
  }
  if (e > CHART_MAX_HR) {
    e = CHART_MAX_HR;
    s = Math.max(CHART_MIN_HR, e - span);
  }
  return { startHr: s, endHr: e };
}

function syncChartPresetButtons() {
  const v = state.chartView;
  const span = v ? v.endHr - v.startHr : 14 * 24;
  const activeKey = span <= 42 ? "h24" : span <= 26 * 24 ? "d14" : "w8";
  $$("#state-zoom-switch [data-szoom]").forEach((b) => {
    b.classList.toggle("active", b.dataset.szoom === activeKey);
  });
  const nowBtn = $("#btn-chart-now");
  if (nowBtn && v) {
    const meta = state.lastTimelineMeta || {};
    const nowHr = meta.now_hr != null ? Number(meta.now_hr) : 12;
    const isNowCentered = nowHr >= v.startHr + span * 0.1 && nowHr <= v.endHr - span * 0.04;
    nowBtn.classList.toggle("hidden", isNowCentered);
  }
}

function renderStateCurveSection(curves, timelineMeta) {
  state.lastStateCurves = curves || [];
  if (timelineMeta !== undefined) state.lastTimelineMeta = timelineMeta;
  syncStateZoomUI();
  const meta = state.lastTimelineMeta || {};
  const pillsEl = $("#state-axis-pills");
  const tagPillsEl = $("#state-tag-pills");
  const chartEl = $("#state-curve-chart");
  if (!pillsEl || !chartEl) return;

  const nowDt = new Date();
  const originStr = meta.origin_day || localDateISO(nowDt);
  const [oy, om, od] = originStr.split("-").map(Number);
  const originMs = new Date(oy, om - 1, od, 0, 0, 0).getTime();
  const nowHr = meta.now_hr != null ? Number(meta.now_hr) : nowDt.getHours() + nowDt.getMinutes() / 60;

  if (!state.chartView) {
    const p = getPresetChartView(state.stateZoom, nowHr);
    state.chartView = clampChartView(p.startHr, p.endHr);
  }
  syncChartPresetButtons();

  if (!curves || !curves.length) {
    pillsEl.innerHTML = "";
    if (tagPillsEl) tagPillsEl.classList.add("hidden");
    chartEl.innerHTML = `<div class="muted sm-text">${esc(t("an_no_axes"))}</div>`;
    return;
  }

  // Keep unrated example phase axes (e.g. Krämpfe when never logged) out of Analysis chart pills until used!
  const groupsNow = parseMoodGroups(state.settings);
  const everydayGrp = groupsNow.find((g) => g.id === "alltag");
  const everydaySet = new Set(everydayGrp ? everydayGrp.dim_ids : []);
  const visibleCurves = curves.filter(
    (c) => c.rated_count > 0 || CORE_EVERYDAY_DIMS.has(c.id) || everydaySet.has(c.id)
  );
  const shownCurves = visibleCurves.length ? visibleCurves : curves;

  if (!state.selectedStateCurveId || !shownCurves.some((c) => c.id === state.selectedStateCurveId)) {
    const firstRated = shownCurves.find((c) => c.rated_count > 0);
    state.selectedStateCurveId = (firstRated || shownCurves[0]).id;
  }

  pillsEl.innerHTML = shownCurves
    .map((c) => {
      const col = dimColor(c);
      const isAct = c.id === state.selectedStateCurveId;
      return `<button type="button" class="pill ${isAct ? "active" : ""}" data-scurve="${esc(c.id)}"><span class="pill-dot" style="background:${esc(col)}"></span>${esc(dimName(c))}${c.rated_count ? ` (${c.rated_count})` : ""}</button>`;
    })
    .join("");

  // Optional #tag overlay pills on the timeline (zero noise when unused!)
  const tagDaysMap = meta.tag_days || {};
  const tagNames = Object.keys(tagDaysMap).sort((a, b) => (tagDaysMap[b].length - tagDaysMap[a].length) || a.localeCompare(b));
  if (state.selectedChartTag && !tagDaysMap[state.selectedChartTag]) state.selectedChartTag = null;
  if (tagPillsEl) {
    if (tagNames.length) {
      tagPillsEl.classList.remove("hidden");
      tagPillsEl.innerHTML =
        `<span class="muted sm-text" style="font-size:11px;">${esc(t("an_chart_tags_lbl"))}</span>` +
        tagNames
          .slice(0, 12)
          .map(
            (tg) =>
              `<button type="button" class="tag-suggest-chip ${state.selectedChartTag === tg ? "selected" : ""}" data-chart-tag="${esc(tg)}" title="${esc(t("an_chart_tag_tip", { tag: tg }))}">#${esc(tg)} <span class="tag-days">${tagDaysMap[tg].length}${esc(t("day_short"))}</span></button>`
          )
          .join("");
    } else {
      tagPillsEl.classList.add("hidden");
      tagPillsEl.innerHTML = "";
    }
  }

  const cur = curves.find((c) => c.id === state.selectedStateCurveId) || curves[0];
  const axisColor = dimColor(cur);
  const legDot = $("#state-leg-dot");
  if (legDot) legDot.style.background = axisColor;
  const legOde = $("#state-leg-ode");
  if (legOde) legOde.style.borderTopColor = axisColor;
  chartEl.style.setProperty("--chart-axis-c", axisColor);
  if (!cur.rated_count) {
    chartEl.innerHTML = `<div class="muted sm-text">${t("an_first_snap_html", { name: esc(dimName(cur)) })}</div>`;
    return;
  }

  // Measure real pixel width for razor-sharp 1:1 aspect ratio (zero squished ovals or warped text!)
  const hostW = chartEl.clientWidth || (chartEl.parentElement && chartEl.parentElement.clientWidth) || 760;
  const W = Math.max(300, Math.round(hostW - 30));
  const H = W < 520 ? 196 : 226;
  const padL = 32;
  const padR = 16;
  const padT = 26;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const vStart = state.chartView.startHr;
  const vEnd = state.chartView.endHr;
  const span = Math.max(1, vEnd - vStart);
  const xOf = (hr) => padL + ((hr - vStart) / span) * plotW;
  const yOf = (v) => padT + ((5 - Math.max(1, Math.min(5, v))) / 4) * plotH;

  const fmtRelTime = (hr) => {
    const dt = new Date(originMs + hr * 3600000);
    const p2 = (n) => String(n).padStart(2, "0");
    return `${dt.toLocaleDateString(getLocale(), { weekday: "short", day: "2-digit", month: "2-digit" })} ${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
  };

  // Horizontal 1..5 guide hairlines (clean, spacious, subtle 3-midline)
  const guides = [1, 2, 3, 4, 5]
    .map((lv) => {
      const y = yOf(lv).toFixed(1);
      const isMid = lv === 3;
      return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border)" stroke-width="1" ${isMid ? 'stroke-dasharray="3 4"' : ""} opacity="${isMid ? "0.95" : "0.55"}" />
              <text x="${padL - 10}" y="${(yOf(lv) + 3.5).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="11" font-family="var(--mono)">${lv}</text>`;
    })
    .join("");

  // Subtle vertical midnight day-grid hairlines when zoomed into multi-day view (<= 16 days)
  let dayGridLayer = "";
  if (span > 18 && span <= 16 * 24) {
    const d0 = Math.ceil(vStart / 24) * 24;
    for (let dh = d0; dh <= vEnd; dh += 24) {
      const gx = xOf(dh);
      if (gx > padL + 2 && gx < W - padR - 2) {
        dayGridLayer += `<line x1="${gx.toFixed(1)}" y1="${padT}" x2="${gx.toFixed(1)}" y2="${padT + plotH}" stroke="var(--border)" stroke-width="1" opacity="0.35" />`;
      }
    }
  }

  // Past vs. Future zone (ultra-subtle tinted forecast area + clear unclipped header labels!)
  let bgLayer = dayGridLayer;
  let topBadgesLayer = "";
  const nowX = xOf(nowHr);
  if (nowHr < vEnd) {
    const futX = Math.max(padL, nowX);
    const futW = Math.max(0, W - padR - futX);
    bgLayer += `<rect x="${futX.toFixed(1)}" y="${padT}" width="${futW.toFixed(1)}" height="${plotH}" fill="url(#fut-zone-bg)" />`;
    if (futW >= 78) {
      topBadgesLayer += `<text x="${(W - padR - 4).toFixed(1)}" y="${(padT - 8).toFixed(1)}" text-anchor="end" fill="var(--ai)" font-size="10" font-weight="500" font-family="var(--mono)" opacity="0.82">${esc(t("an_chart_forecast_zone"))}</text>`;
    }
  }
  if (nowHr >= vStart && nowHr <= vEnd) {
    bgLayer += `<line x1="${nowX.toFixed(1)}" y1="${padT}" x2="${nowX.toFixed(1)}" y2="${padT + plotH}" stroke="var(--accent)" stroke-width="1.25" stroke-dasharray="3 3" opacity="0.6" />`;
    const nowLbl = t("btn_chart_now");
    const pillW = Math.max(36, nowLbl.length * 6.5 + 12);
    const clampedX = Math.min(W - padR - pillW / 2, Math.max(padL + pillW / 2, nowX));
    topBadgesLayer += `<g>
      <rect x="${(clampedX - pillW / 2).toFixed(1)}" y="${(padT - 20).toFixed(1)}" width="${pillW.toFixed(1)}" height="16" rx="8" fill="var(--accent-soft)" stroke="color-mix(in srgb, var(--accent) 28%, transparent)" stroke-width="1" />
      <text x="${clampedX.toFixed(1)}" y="${(padT - 8.5).toFixed(1)}" text-anchor="middle" fill="var(--accent)" font-size="10" font-weight="600" font-family="var(--mono)">${esc(nowLbl)}</text>
    </g>`;
  }

  // Optional #tag day highlight stripes (only when user explicitly toggles a #tag pill)
  if (state.selectedChartTag && tagDaysMap[state.selectedChartTag]) {
    for (const dIso of tagDaysMap[state.selectedChartTag]) {
      const [dy, dm, dd] = dIso.split("-").map(Number);
      const dStartHr = (new Date(dy, dm - 1, dd, 0, 0, 0).getTime() - originMs) / 3600000;
      const dEndHr = dStartHr + 24;
      if (dEndHr < vStart || dStartHr > vEnd) continue;
      const x1 = Math.max(padL, xOf(dStartHr));
      const x2 = Math.min(W - padR, xOf(dEndHr));
      const bw = Math.max(6, x2 - x1);
      bgLayer += `<rect x="${x1.toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${plotH}" fill="var(--ai)" opacity="0.11" rx="3"><title>#${esc(state.selectedChartTag)} · ${esc(dIso)}</title></rect>`;
      bgLayer += `<rect x="${x1.toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="3" fill="var(--ai)" opacity="0.65" rx="1.5" />`;
    }
  }

  const tl = cur.timeline || { actual: [], ode: [], tabpfn: [] };
  let defsExtra = `<linearGradient id="ode-past-area" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${esc(axisColor)}" stop-opacity="0.16" />
      <stop offset="100%" stop-color="${esc(axisColor)}" stop-opacity="0.0" />
    </linearGradient>
    <linearGradient id="fut-zone-bg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${esc(axisColor)}" stop-opacity="0.06" />
      <stop offset="100%" stop-color="${esc(axisColor)}" stop-opacity="0.015" />
    </linearGradient>`;
  let bandLayer = "";
  let curveLayer = "";

  const drawContinuousSeries = (rawPts, opts) => {
    if (!rawPts || rawPts.length < 2) return;
    let firstIdx = rawPts.findIndex((p) => p[0] >= vStart);
    if (firstIdx < 0) firstIdx = rawPts.length - 1;
    firstIdx = Math.max(0, firstIdx - 1);
    let lastIdx = rawPts.length - 1;
    for (let i = firstIdx; i < rawPts.length; i++) {
      if (rawPts[i][0] > vEnd) {
        lastIdx = i;
        break;
      }
    }
    const vis = rawPts.slice(firstIdx, lastIdx + 1);
    if (vis.length < 2) return;

    const pastPts = [];
    const futPts = [];
    for (let i = 0; i < vis.length; i++) {
      const p = vis[i];
      if (p[0] <= nowHr) {
        pastPts.push(p);
      } else {
        if (!futPts.length && pastPts.length) {
          const prev = pastPts[pastPts.length - 1];
          const dt = p[0] - prev[0];
          const frac = dt > 1e-6 ? Math.max(0, Math.min(1, (nowHr - prev[0]) / dt)) : 0;
          const vMid = prev[1] + (p[1] - prev[1]) * frac;
          const anchor = [nowHr, vMid, 1.0, 0.0];
          pastPts.push(anchor);
          futPts.push(anchor);
        }
        futPts.push(p);
      }
    }

    if (pastPts.length >= 2) {
      const xy = pastPts.map((p) => ({ x: xOf(p[0]), y: yOf(p[1]) }));
      const dStr = buildSmoothCurvePath(xy);
      if (dStr) {
        if (opts.pastFill) {
          bandLayer += `<path d="${dStr} L ${xy[xy.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${xy[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z" fill="${opts.pastFill}" />`;
        }
        curveLayer += `<path d="${dStr}" fill="none" stroke="${opts.stroke}" stroke-width="${opts.width}" ${opts.dash ? `stroke-dasharray="${opts.dash}"` : ""} stroke-linecap="round" stroke-linejoin="round" opacity="${opts.pastOpacity}" />`;
      }
    }

    if (futPts.length >= 2) {
      const gId = `fut-grad-${opts.id}`;
      const x0 = Math.max(padL, xOf(futPts[0][0]));
      const x1 = Math.min(W - padR, xOf(futPts[futPts.length - 1][0]));
      const cStart = futPts[0][2] ?? 1;
      const cEnd = futPts[futPts.length - 1][2] ?? 0.1;
      defsExtra += `<linearGradient id="${gId}" gradientUnits="userSpaceOnUse" x1="${x0.toFixed(1)}" y1="0" x2="${Math.max(x0 + 1, x1).toFixed(1)}" y2="0">
        <stop offset="0%" stop-color="${opts.stroke}" stop-opacity="${(0.18 * cStart).toFixed(2)}" />
        <stop offset="100%" stop-color="${opts.stroke}" stop-opacity="${Math.max(0.015, 0.14 * cEnd).toFixed(2)}" />
      </linearGradient>`;

      const upper = futPts.map((p) => `${xOf(p[0]).toFixed(1)},${yOf(p[1] + (p[3] || 0)).toFixed(1)}`);
      const lower = [...futPts].reverse().map((p) => `${xOf(p[0]).toFixed(1)},${yOf(p[1] - (p[3] || 0)).toFixed(1)}`);
      bandLayer += `<polygon points="${upper.concat(lower).join(" ")}" fill="url(#${gId})" />`;

      for (let i = 0; i < futPts.length - 1; i++) {
        const a = futPts[i];
        const b = futPts[i + 1];
        const avgConf = ((a[2] ?? 0.5) + (b[2] ?? 0.5)) / 2;
        const segOp = Math.max(0.1, Math.min(0.92, 0.08 + 0.84 * avgConf));
        curveLayer += `<line x1="${xOf(a[0]).toFixed(1)}" y1="${yOf(a[1]).toFixed(1)}" x2="${xOf(b[0]).toFixed(1)}" y2="${yOf(b[1]).toFixed(1)}" stroke="${opts.stroke}" stroke-width="${opts.width}" ${opts.dash ? `stroke-dasharray="${opts.dash}"` : ""} stroke-linecap="round" stroke-opacity="${segOp.toFixed(2)}" />`;
      }
    }
  };

  const tabpfnStroke = "color-mix(in srgb, var(--text) 56%, transparent)";
  if (state.showOdeLine) {
    drawContinuousSeries(tl.ode, {
      id: "ode",
      label: "ODE",
      stroke: axisColor,
      width: 2.4,
      dash: "",
      pastOpacity: 0.96,
      pastFill: "url(#ode-past-area)",
    });
  }
  if (state.showTabpfnLine) {
    drawContinuousSeries(tl.tabpfn, {
      id: "tabpfn",
      label: "TabPFN",
      stroke: tabpfnStroke,
      width: 2.0,
      dash: "5 4",
      pastOpacity: 0.9,
      pastFill: "",
    });
  }

  let ticksLayer = "";
  const allTicks = meta.habit_ticks || [];
  const visTicksAll = allTicks.filter((tk) => tk.t >= vStart && tk.t <= vEnd);

  // Build visible viewport habit-pin legend summary (so colors are immediately readable without hovering + clickable to isolate!)
  const pinSummaryMap = new Map();
  for (const tk of visTicksAll) {
    const curS = pinSummaryMap.get(tk.habit_id) || {
      habit_id: tk.habit_id,
      habit_name: tk.habit_name,
      color: tk.color,
      amount: 0,
      count: 0,
    };
    curS.amount += Number(tk.amount || 0);
    curS.count += 1;
    pinSummaryMap.set(tk.habit_id, curS);
  }
  const pinLegendItems = Array.from(pinSummaryMap.values()).sort((a, b) => b.amount - a.amount || b.count - a.count);
  if (state.selectedChartHabitId && !pinSummaryMap.has(state.selectedChartHabitId) && !allTicks.some((tk) => tk.habit_id === state.selectedChartHabitId)) {
    state.selectedChartHabitId = null;
  }

  const visTicks = state.selectedChartHabitId
    ? visTicksAll.filter((tk) => tk.habit_id === state.selectedChartHabitId)
    : visTicksAll;
  const visibleTicksCount = visTicks.length;

  // Pixel-aware adaptive pin aggregation across ALL zoom levels (24h individual -> 6h blocks -> daily -> weekly!)
  const pxPerDay = (24 / Math.max(0.1, span)) * plotW;
  let bucketHr = 0;
  if (span > 42 && span <= 120) bucketHr = 6;
  else if (span > 120) bucketHr = pxPerDay >= 7 ? 24 : 168;

  const pinBuckets = [];
  if (visTicks.length) {
    if (bucketHr === 0) {
      // Individual pins, merging only simultaneous / colliding pins within 6px
      const sorted = [...visTicks].sort((a, b) => a.t - b.t);
      for (const tk of sorted) {
        const tx = xOf(tk.t);
        const last = pinBuckets[pinBuckets.length - 1];
        if (last && Math.abs(tx - last.cx) <= 6) {
          last.raw.push(tk);
          last.tSum += tk.t;
          last.tCenter = last.tSum / last.raw.length;
          last.cx = xOf(last.tCenter);
        } else {
          pinBuckets.push({ tCenter: tk.t, tSum: tk.t, cx: tx, raw: [tk], bucketHr: 0 });
        }
      }
    } else {
      const bMap = new Map();
      for (const tk of visTicks) {
        let bKey, bCenter;
        if (bucketHr === 168) {
          // Align weekly buckets cleanly to Monday..Sunday relative to local calendar
          const dt = new Date(originMs + tk.t * 3600000);
          const monOff = (dt.getDay() + 6) % 7;
          const mon = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - monOff, 0, 0, 0);
          const monHr = (mon.getTime() - originMs) / 3600000;
          bKey = Math.round(monHr / 24);
          bCenter = monHr + 84; // Wednesday noon
        } else if (bucketHr === 24) {
          const dayIdx = Math.floor(tk.t / 24);
          bKey = dayIdx;
          bCenter = dayIdx * 24 + 12; // Midday of that local day
        } else {
          const blkIdx = Math.floor(tk.t / bucketHr);
          bKey = blkIdx;
          bCenter = blkIdx * bucketHr + bucketHr / 2;
        }
        let b = bMap.get(bKey);
        if (!b) {
          b = { tCenter: bCenter, cx: xOf(bCenter), raw: [], bucketHr };
          bMap.set(bKey, b);
        }
        b.raw.push(tk);
      }
      pinBuckets.push(...Array.from(bMap.values()).sort((a, b) => a.tCenter - b.tCenter));
    }
  }

  const renderedPins = pinBuckets.map((b) => {
    const byHab = new Map();
    let totalAmt = 0;
    for (const tk of b.raw) {
      const amt = Math.max(0.1, Number(tk.amount || 0));
      totalAmt += amt;
      const curH = byHab.get(tk.habit_id) || {
        habit_id: tk.habit_id,
        habit_name: tk.habit_name,
        color: tk.color,
        amount: 0,
        count: 0,
        ts: tk.ts,
      };
      curH.amount += amt;
      curH.count += 1;
      byHab.set(tk.habit_id, curH);
    }
    const items = Array.from(byHab.values()).sort((a, b2) => b2.amount - a.amount || b2.count - a.count);
    return {
      cx: b.cx,
      tCenter: b.tCenter,
      bucketHr: b.bucketHr,
      total: totalAmt,
      rawCount: b.raw.length,
      ts: b.raw[0] ? b.raw[0].ts : "",
      items,
    };
  });

  const maxPinTotal = Math.max(1, ...renderedPins.map((p) => p.total));
  const yBot = padT + plotH;
  const barW =
    bucketHr === 0
      ? 2.8
      : bucketHr === 6
        ? Math.max(4, Math.min(7, (6 / span) * plotW * 0.45))
        : bucketHr === 24
          ? Math.max(4.5, Math.min(10, pxPerDay * 0.44))
          : Math.max(6, Math.min(14, (168 / span) * plotW * 0.34));

  ticksLayer = renderedPins
    .map((p) => {
      const totalH =
        bucketHr === 0
          ? Math.min(22, 10 + 10 * Math.sqrt(p.total / maxPinTotal))
          : Math.min(30, 8 + 22 * Math.sqrt(p.total / maxPinTotal));
      p.barH = totalH;
      p.barW = barW;
      const tipParts = p.items.slice(0, 4).map((it) => `${it.habit_name} +${fmtNum(it.amount)}`);
      if (p.items.length > 4) tipParts.push(`+${p.items.length - 4}`);
      const tipTime =
        bucketHr === 0
          ? `${p.ts.slice(11, 16)} (${p.ts.slice(8, 10)}.${p.ts.slice(5, 7)}.)`
          : bucketHr === 168
            ? `${p.ts.slice(8, 10)}.${p.ts.slice(5, 7)}. (Woche)`
            : `${p.ts.slice(8, 10)}.${p.ts.slice(5, 7)}.`;
      const tip = `${tipTime} · ${tipParts.join(", ")}`;

      if (bucketHr === 0 && p.items.length === 1) {
        const it = p.items[0];
        const tx = p.cx.toFixed(1);
        const yTop = (yBot - totalH).toFixed(1);
        return `<g>
          <line x1="${tx}" y1="${yTop}" x2="${tx}" y2="${yBot.toFixed(1)}" stroke="${esc(it.color)}" stroke-width="2.4" stroke-linecap="round" opacity="0.88" />
          <circle cx="${tx}" cy="${yTop}" r="2.4" fill="${esc(it.color)}"><title>${esc(tip)}</title></circle>
        </g>`;
      }
      // Stacked color micro-bar (used for zoomed-out aggregates & colliding same-time pins)
      let curY = yBot;
      const segs = [];
      const topItems = p.items.slice(0, 5);
      const topSum = topItems.reduce((s, it) => s + it.amount, 0) || 1;
      for (let i = 0; i < topItems.length; i++) {
        const it = topItems[i];
        const segH = Math.max(2.2, (it.amount / topSum) * totalH);
        curY -= segH;
        const isTop = i === topItems.length - 1;
        segs.push(
          `<rect x="${(p.cx - barW / 2).toFixed(1)}" y="${curY.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}" rx="${isTop ? "1.6" : "0.6"}" fill="${esc(it.color)}" opacity="0.86" />`
        );
      }
      return `<g><title>${esc(tip)}</title>${segs.join("")}</g>`;
    })
    .join("");
  const pinHitPx = bucketHr === 0 ? 14 : Math.max(12, Math.min(26, ((bucketHr / Math.max(0.1, span)) * plotW) * 0.55));

  const visActual = (tl.actual || []).filter((pt) => pt.t >= vStart && pt.t <= vEnd);
  const dotsLayer = visActual
    .map((pt) => {
      const cx = xOf(pt.t).toFixed(1);
      const cy = yOf(pt.v).toFixed(1);
      const tip = `${fmtRelTime(pt.t)}: ${fmtNum(pt.v)}/5${pt.note ? ` · ${pt.note}` : ""}`;
      return `<circle cx="${cx}" cy="${cy}" r="4.8" fill="${esc(axisColor)}" stroke="var(--surface)" stroke-width="2.2"><title>${esc(tip)}</title></circle>`;
    })
    .join("");

  // Adaptive non-overlapping X-axis labels computed from actual pixel spacing
  const maxLabels = Math.max(4, Math.floor(plotW / 58));
  const candSteps = [2, 3, 4, 6, 12, 24, 48, 72, 96, 120, 168, 336];
  const stepHr = candSteps.find((s) => span / s <= maxLabels) || 336;
  const firstTick = Math.ceil(vStart / stepHr) * stepHr;
  const xLabelParts = [];
  const p2 = (n) => String(n).padStart(2, "0");
  for (let th = firstTick; th <= vEnd + 0.01; th += stepHr) {
    const x = xOf(th);
    if (x < padL + 16 || x > W - padR - 16) continue;
    const dt = new Date(originMs + th * 3600000);
    const isFut = th > nowHr + 0.5;
    let lbl = "";
    if (stepHr < 24) {
      lbl = dt.getHours() === 0 ? `${p2(dt.getDate())}.${p2(dt.getMonth() + 1)}.` : `${p2(dt.getHours())}:00`;
    } else if (Math.abs(th) < 12) {
      lbl = t("today");
    } else if (isFut) {
      const dAhead = Math.max(1, Math.round(th / 24));
      lbl = `+${dAhead}${t("day_short")}`;
    } else if (stepHr >= 168) {
      const dUtc = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
      const dn = dUtc.getUTCDay() || 7;
      dUtc.setUTCDate(dUtc.getUTCDate() + 4 - dn);
      const yStart = new Date(Date.UTC(dUtc.getUTCFullYear(), 0, 1));
      const wk = Math.ceil(((dUtc - yStart) / 86400000 + 1) / 7);
      const isEn = window.DailyI18n && window.DailyI18n.getLang() === "en";
      lbl = `${isEn ? "W" : "KW"}${wk}`;
    } else {
      lbl = `${p2(dt.getDate())}.${p2(dt.getMonth() + 1)}.`;
    }
    const fill = Math.abs(th) < 12 ? "var(--text)" : isFut ? "var(--ai)" : "var(--muted)";
    const fw = Math.abs(th) < 12 ? "600" : "400";
    xLabelParts.push(
      `<text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="${fill}" font-size="11" font-weight="${fw}" font-family="var(--mono)">${esc(lbl)}</text>`
    );
  }
  const xLabels = xLabelParts.join("");

  const tauLabel = cur.ode_tau_hours ? `ODE τ=${fmtNum(cur.ode_tau_hours)}h` : "";
  const spanDays = span / 24;
  const spanTxt = span < 48 ? `${Math.round(span)}h` : `${Math.round(spanDays)}${t("day_short")}`;
  const summaryParts = [];
  if (state.showOdeLine && tauLabel) summaryParts.push(tauLabel);
  summaryParts.push(spanTxt);
  if (visibleTicksCount) summaryParts.push(`${visibleTicksCount}×`);
  const rightSummary = summaryParts.join(" · ");

  const curLow = dimLow(cur);
  const curHigh = dimHigh(cur);
  const anchorTxt =
    curLow || curHigh ? `1 = ${curLow || t("an_anchor_low")} · 5 = ${curHigh || t("an_anchor_high")}` : "";

  // Store geometry snapshot for zero-latency live hover crosshair + habit pin identification
  state._chartGeom = { W, H, padL, padR, padT, padB, plotW, plotH, vStart, vEnd, span, originMs, nowHr, cur, axisColor, visActual, renderedPins, pinHitPx, anchorTxt, rightSummary };

  const pinLegendHtml = pinLegendItems.length
    ? `<div class="state-pin-legend" id="state-pin-legend">
        ${pinLegendItems
          .slice(0, 8)
          .map((it) => {
            const isSel = state.selectedChartHabitId === it.habit_id;
            const isDim = !!state.selectedChartHabitId && !isSel;
            return `<button type="button" class="pin-leg-chip${isSel ? " active" : ""}${isDim ? " dimmed" : ""}" data-chart-habit="${esc(it.habit_id)}" title="${esc(it.habit_name)} (${fmtNum(it.amount)})"><span class="chip-dot" style="background:${esc(it.color)}"></span>${esc(it.habit_name)} <span class="mono muted">${fmtNum(it.amount)}</span></button>`;
          })
          .join("")}
      </div>`
    : "";

  chartEl.innerHTML = `
    <div class="state-chart-wrap" data-pan-chart="1">
      <div class="state-chart-readout" id="state-chart-readout">
        <span>${esc(anchorTxt)}</span>
        <span class="mono">${esc(rightSummary)}</span>
      </div>
      <svg class="state-chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        <defs>
          <clipPath id="state-plot-clip"><rect x="${padL}" y="${padT - 2}" width="${plotW}" height="${plotH + 4}" /></clipPath>
          ${defsExtra}
        </defs>
        ${guides}
        <g clip-path="url(#state-plot-clip)">
          ${bgLayer}
          ${bandLayer}
          ${curveLayer}
          ${ticksLayer}
          ${dotsLayer}
        </g>
        ${topBadgesLayer}
        <g id="state-chart-hover" style="pointer-events:none;"></g>
        ${xLabels}
      </svg>
      ${pinLegendHtml}
      <div class="state-chart-foot">
        <span>${esc(t("an_chart_pan_hint"))}</span>
        <span class="mono">${esc(t("an_chart_zoom_hint"))}</span>
      </div>
    </div>`;
}

function renderWeekMatrix(dates, weekMatrix, endDay) {
  state.lastMatrixData = { dates, weekMatrix, endDay };
  const wm = $("#week-matrix");
  const titleEl = $("#matrix-title");
  const nextBtn = $("#btn-matrix-next");
  const nowBtn = $("#btn-matrix-now");
  const todayIsoNow = localDateISO(new Date());
  const isLatest = !endDay || endDay >= todayIsoNow;

  if (titleEl) {
    if (isLatest || !dates || !dates.length) {
      titleEl.innerHTML = t("an_last7_html");
    } else {
      const s = dates[0], e = dates[dates.length - 1];
      const rangeStr = `${s.slice(8, 10)}.${s.slice(5, 7)}.–${e.slice(8, 10)}.${e.slice(5, 7)}.`;
      titleEl.innerHTML = t("an_matrix_range_html", { range: esc(rangeStr) });
    }
  }
  if (nextBtn) nextBtn.disabled = isLatest;
  if (nowBtn) nowBtn.classList.toggle("hidden", isLatest);

  if (!weekMatrix || !weekMatrix.length) {
    wm.innerHTML = `<div class="muted sm-text">${esc(t("no_habits_yet"))}</div>`;
    return;
  }

  // Fold inactive (all-zero) rows in this 7-day window cleanly so rare 3-6 month habits never bloat the table!
  const activeRows = weekMatrix.filter((r) => (r.days || []).some((c) => Number(c.effective || 0) !== 0));
  const inactiveRows = weekMatrix.filter((r) => !(r.days || []).some((c) => Number(c.effective || 0) !== 0));
  const shownRows = !activeRows.length || state.showInactiveMatrix ? weekMatrix : activeRows;

  const headerDays = (dates || [])
    .map((d) => `<th class="${d === todayIsoNow ? "col-today" : ""}">${d.slice(8, 10)}.${d.slice(5, 7)}.</th>`)
    .join("");
  const rows = shownRows
    .map(
      (r) => `
    <tr>
      <td><span class="ev-dot" style="background:${esc(r.color)};display:inline-block;margin-right:6px;"></span>${esc(r.name)}</td>
      ${r.days
        .map(
          (c) =>
            `<td class="${c.day === todayIsoNow ? "col-today" : ""}"><span class="cell-val cell-${esc(c.status)}">${c.effective !== 0 ? fmtNum(c.effective) : "·"}</span></td>`
        )
        .join("")}
    </tr>`
    )
    .join("");
  const foldBar =
    activeRows.length && inactiveRows.length
      ? `<div class="matrix-fold-bar"><div class="dormant-toggle-row"><button type="button" class="btn ghost sm" data-toggle-inactive-matrix="1">${esc(
          state.showInactiveMatrix
            ? t("matrix_hide_inactive", { n: inactiveRows.length })
            : t("matrix_show_inactive", { n: inactiveRows.length })
        )}</button></div></div>`
      : "";
  wm.innerHTML = `<table class="matrix"><thead><tr><th>${esc(t("th_habit"))}</th>${headerDays}</tr></thead><tbody>${rows}</tbody></table>${foldBar}`;
}

async function loadWeekMatrix(endDay) {
  const todayIsoNow = localDateISO(new Date());
  const clamped = !endDay || endDay >= todayIsoNow ? null : endDay;
  state.matrixEndDay = clamped;
  try {
    const q = clamped ? `?end=${encodeURIComponent(clamped)}` : "";
    const res = await api(`/api/matrix${q}`);
    renderWeekMatrix(res.dates || [], res.week_matrix || [], clamped);
  } catch (err) {
    toast(t("err_prefix", { msg: err.message }));
  }
}

function renderRhythmsPanel() {
  $$("#rhythm-legend [data-rline]").forEach((b) => {
    const on = b.dataset.rline === "obs" ? state.showRhythmObs : state.showRhythmAi;
    b.classList.toggle("active", on);
  });
  const rl = $("#rhythm-list");
  if (!rl) return;
  const data = state.lastRhythmsData;
  const rhythms = (data && data.rhythms) || [];
  const tomorrowMap = (data && data.tomorrowMap) || {};
  if (!rhythms.length) {
    rl.innerHTML = `<div class="muted sm-text">${esc(t("an_no_entries"))}</div>`;
    return;
  }
  const nowHour = new Date().getHours();
  const activeRhythms = rhythms.filter((r) => (r.hours || []).some((v) => v > 0));
  const emptyRhythms = rhythms.filter((r) => !(r.hours || []).some((v) => v > 0));
  const shownRhythms = !activeRhythms.length || state.showEmptyRhythms ? rhythms : activeRhythms;

  const cardsHtml = shownRhythms
    .map((r) => {
      const mx = Math.max(1, ...r.hours);
      const tm = tomorrowMap[r.habit_id] || {};
      const isMax = r.kind === "max";
      const obsHours = Array.isArray(r.peak_hours) && r.peak_hours.length ? r.peak_hours : r.peak_hour != null ? [r.peak_hour] : [];
      const obsTimes = Array.isArray(r.peak_times) && r.peak_times.length ? r.peak_times : r.peak_time ? [r.peak_time] : [];
      const obsTimeByHr = {};
      obsHours.forEach((hr, i) => { obsTimeByHr[hr] = obsTimes[i] || `${String(hr).padStart(2, "0")}:00`; });

      const aiPeaks =
        Array.isArray(tm.ai_peaks) && tm.ai_peaks.length
          ? tm.ai_peaks
          : tm.ai_peak_hour != null
          ? [{ hour: tm.ai_peak_hour, time: tm.ai_peak_time || `${String(tm.ai_peak_hour).padStart(2, "0")}:00`, prob: (tm.ai_hours && tm.ai_hours[tm.ai_peak_hour]) || 0.5, pct: tm.ai_peak_pct || 50 }]
          : [];
      const aiPeakByHr = {};
      aiPeaks.forEach((pk) => { aiPeakByHr[pk.hour] = pk; });
      const aiMaxP = tm.ai_hours ? Math.max(0.05, ...tm.ai_hours) : 1;

      const scopeForHr = (hr) =>
        Array.isArray(tm.ai_scopes) && tm.ai_scopes[hr] ? tm.ai_scopes[hr] : hr >= nowHour ? "today" : "tomorrow";
      const scopeLabel = (sc) => (sc === "today" ? t("an_later_today") : t("tomorrow"));

      const markers = Array.from({ length: 24 }, (_, hr) => {
        const parts = [];
        if (state.showRhythmObs && obsTimeByHr[hr]) {
          parts.push(`<span class="dot-obs" style="background:${esc(r.color)}" title="${esc(t("leg_obs_peak"))} ~${obsTimeByHr[hr]}"></span>`);
        }
        if (state.showRhythmAi && aiPeakByHr[hr]) {
          const pk = aiPeakByHr[hr];
          const sc = pk.scope || scopeForHr(hr);
          const op = Math.max(0.24, Math.min(1, 0.16 + 0.92 * Number(pk.prob || 0.3))).toFixed(2);
          parts.push(`<span class="dot-ai ${isMax ? "kind-max" : ""}" style="opacity:${op}" title="${esc(scopeLabel(sc))} ~${pk.time} (${pk.pct}%)"></span>`);
        }
        return `<div class="marker-slot">${parts.join("")}</div>`;
      }).join("");

      const bars = r.hours
        .map((cnt, hr) => {
          const pct = cnt > 0 ? Math.max(14, Math.round((cnt / mx) * 100)) : 0;
          const bg = cnt > 0 ? r.color : "var(--surface-2)";
          const aiPk = state.showRhythmAi ? aiPeakByHr[hr] : null;
          const aiCls = aiPk ? `is-ai-peak ${isMax ? "kind-max" : ""}` : "";
          const pTomorrow = tm.ai_hours ? tm.ai_hours[hr] || 0 : 0;
          const haloPct = state.showRhythmAi && tm.ai_hours && pTomorrow > 0.08 ? Math.min(100, Math.round((pTomorrow / aiMaxP) * 92)) : 0;
          const haloOp = Math.max(0.25, Math.min(1, 0.2 + pTomorrow)).toFixed(2);
          const aiTip = tm.ai_hours ? ` · ${scopeLabel(scopeForHr(hr))}: ${Math.round(pTomorrow * 100)}%` : "";
          const nowCls = hr === nowHour ? "is-now-hr" : "";
          return `
            <div class="spark-col ${nowCls}" title="${String(hr).padStart(2, "0")}:00 → ${cnt}×${aiTip}">
              ${haloPct ? `<div class="spark-ai-halo ${isMax ? "kind-max" : ""}" style="height:${haloPct}%;opacity:${haloOp}"></div>` : ""}
              <div class="spark-bar ${aiCls}" style="height:${pct || 6}%;background:${bg};opacity:${cnt ? 0.92 : 0.35}"></div>
            </div>`;
        })
        .join("");

      const metaParts = [];
      if (state.showRhythmObs && obsTimes.length) metaParts.push(`${t("an_obs_short")} ~${obsTimes.join(", ")}`);
      if (state.showRhythmAi && aiPeaks.length) metaParts.push(`24h ~${aiPeaks.map((p) => p.time).join(", ")}`);
      const meta = metaParts.join(" · ") || "—";

      return `
      <div class="rhythm-item">
        <div class="rhythm-head">
          <strong>${esc(r.habit_name)}</strong>
          <span class="mono muted">${esc(meta)}</span>
        </div>
        <div class="spark-markers">${markers}</div>
        <div class="spark24">${bars}</div>
        <div class="spark-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
      </div>`;
    })
    .join("");
  const foldRhythmHtml =
    activeRhythms.length && emptyRhythms.length
      ? `<div class="dormant-toggle-row" style="margin-top:6px;"><button type="button" class="btn ghost sm" data-toggle-empty-rhythms="1">${esc(
          state.showEmptyRhythms
            ? t("rhythm_hide_empty", { n: emptyRhythms.length })
            : t("rhythm_show_empty", { n: emptyRhythms.length })
        )}</button></div>`
      : "";
  rl.innerHTML = cardsHtml + foldRhythmHtml;
}

async function loadAnalysis() {
  const board = await ensureAnalysisBoard(true);
  const ai = board.ai || {};
  renderStateCurveSection(ai.state_curves || [], ai.timeline_meta || null);

  // 1. 7-day matrix (supports instant week-by-week paging into older history!)
  if (state.matrixEndDay) {
    await loadWeekMatrix(state.matrixEndDay);
  } else {
    renderWeekMatrix(board.last7_dates || [], board.week_matrix || [], null);
  }

  // 2. 24h Rhythm + Multi-Peak Tomorrow markers (confidence-scaled opacity + calm terracotta for Less/Weniger)
  state.lastRhythmsData = { rhythms: board.rhythms || [], tomorrowMap: ai.tomorrow || {} };
  renderRhythmsPanel();

  // 3. AI Prediction vs Actual (visible error right from Day 1!)
  const calBox = $("#ai-calibration-list");
  const cal = ai.calibration || [];
  $("#ai-mae-badge").textContent = ai.overall_mae != null ? t("an_mae", { v: fmtNum(ai.overall_mae) }) : "";
  if (!cal.length) {
    calBox.innerHTML = `<div class="muted sm-text">${esc(t("no_habits_yet"))}</div>`;
  } else {
    const calRows = cal
      .map(
        (c) => `
      <tr>
        <td><span class="ev-dot" style="background:${esc(c.color)};display:inline-block;margin-right:6px;"></span>${esc(c.habit_name)}</td>
        <td class="mono">${fmtNum(c.ai_predicted)}</td>
        <td class="mono"><strong>${fmtNum(c.actual)}</strong></td>
        <td class="mono ${c.error <= 0.4 ? "pos" : c.error >= 1.2 ? "neg" : "muted"}">±${fmtNum(c.error)}</td>
      </tr>`
      )
      .join("");
    calBox.innerHTML = `<table class="matrix"><thead><tr><th>${esc(t("th_habit"))}</th><th>${esc(t("th_ai"))}</th><th>${esc(t("th_logged"))}</th><th>${esc(t("th_error"))}</th></tr></thead><tbody>${calRows}</tbody></table>`;
  }

  // 4. User Hypotheses + AI Assumptions (no technical warmup nag!)
  const hl = $("#hyp-eval-list");
  const verdictMeta = {
    collecting: [t("verdict_collecting"), ""],
    neutral: [t("verdict_neutral"), ""],
    confirmed: [t("verdict_confirmed"), "pos-chip"],
    surprising: [t("verdict_surprising"), "neg-chip"],
    positive: [t("verdict_positive"), "pos-chip"],
    negative: [t("verdict_negative"), "neg-chip"],
  };

  const renderHypCard = (h) => {
    const [vLbl, vCls] = verdictMeta[h.verdict] || [h.verdict, ""];
    const expStr =
      h.expected_weight == null ? "" : h.expected_weight > 0 ? " (+)" : " (−)";
    const stats =
      h.avg_with != null && h.avg_without != null
        ? t("hyp_stats", {
            w: fmtNum(h.avg_with),
            wo: fmtNum(h.avg_without),
            d: `${h.delta >= 0 ? "+" : ""}${fmtNum(h.delta)}`,
          })
        : t("hyp_days", { w: h.days_with, wo: h.days_without });
    return `
      <div class="hyp-card">
        <div class="hyp-head">
          <span><strong>${esc(h.source_name)}</strong> <span class="muted">(${esc(windowLabel(h.context_window))})</span> → <strong>${esc(h.target_name)}</strong><span class="muted sm-text">${expStr}</span></span>
          <span class="chip ${vCls}">${esc(vLbl)}</span>
        </div>
        <div class="mono sm-text muted">${esc(stats)}</div>
        ${h.note ? `<div class="sm-text muted" style="margin-top:3px;">„${esc(h.note)}“</div>` : ""}
      </div>`;
  };

  hl.innerHTML = board.hypotheses.length
    ? board.hypotheses.map(renderHypCard).join("")
    : "";

  const ail = $("#ai-assumptions-list");
  const aiItems = ai.assumptions || [];
  ail.innerHTML = aiItems.length
    ? aiItems
        .map((a) => {
          const dirCls = a.direction > 0 ? "pos-chip" : "neg-chip";
          const dirTxt = a.direction > 0 ? `+${fmtNum(a.predicted_delta)}` : `${fmtNum(a.predicted_delta)}`;
          const tgtLabel = a.is_state_target
            ? dimName({ id: String(a.target_id || "").replace(/^state:/, ""), name: a.target_name })
            : a.target_name;
          const localizedSummary = a.is_state_target
            ? t("ai_sum_state", {
                src: a.source_name,
                dst: tgtLabel,
                delta: dirTxt,
                dir: a.predicted_delta >= 0 ? t("higher") : t("lower"),
              })
            : t("ai_sum_habit", {
                src: a.source_name,
                win: windowLabel(a.context_window),
                dst: tgtLabel,
                delta: dirTxt,
                dir: a.predicted_delta >= 0 ? t("higher") : t("lower"),
              });
          const btnHtml = a.is_state_target
            ? `<span class="chip ai-chip">${esc(t("btn_mood"))}</span>`
            : a.already_saved
            ? `<span class="chip ${a.contradicts_saved ? "neg-chip" : "pos-chip"}">${esc(a.contradicts_saved ? t("ai_contradicts") : t("ai_adopted"))}</span>`
            : `<button type="button" class="btn ghost sm" data-adopt-ai="1" data-src="${esc(a.source_id)}" data-dst="${esc(a.target_id)}" data-win="${esc(a.context_window)}" data-dir="${a.direction}" data-delta="${a.predicted_delta}">${esc(t("btn_adopt_ai"))}</button>`;
          return `
          <div class="hyp-card ai-card">
            <div class="hyp-head">
              <span>
                <span class="chip ai-chip" style="margin-right:4px;">${esc(t("ai_assump_badge"))}</span>
                <strong>${esc(a.source_name)}</strong>
                <span class="muted">(${esc(windowLabel(a.context_window))})</span>
                → <strong>${esc(tgtLabel)}</strong>
              </span>
              <span class="chip ${dirCls}">Δ ${dirTxt}</span>
            </div>
            <div class="sm-text muted">${esc(localizedSummary)}</div>
            <div class="row-end" style="margin-top:6px;">
              ${btnHtml}
            </div>
          </div>`;
        })
        .join("")
    : !board.hypotheses.length
    ? `<div class="muted sm-text">${esc(t("an_no_hyps"))}</div>`
    : "";

  if (board.discovered.length) {
    $("#discovered-block").classList.remove("hidden");
    $("#discovered-list").innerHTML = board.discovered.map(renderHypCard).join("");
  } else {
    $("#discovered-block").classList.add("hidden");
  }

  // 5. Collapsible AI Transparency Ledger ("Was die KI gerade sieht" — zero blackbox!)
  const audit = ai.feature_audit || {
    habits_count: (board.week_matrix || []).length,
    state_dims_count: (ai.state_curves || []).length,
    observed_days: board.observed_days || 0,
    events_count: 0,
    snapshots_count: 0,
    active_tags: [],
    pending_tags: [],
  };
  const actTags = audit.active_tags || [];
  const pendTags = audit.pending_tags || [];
  const metaEl = $("#ai-audit-summary-meta");
  if (metaEl) {
    metaEl.textContent = t("an_audit_meta", {
      h: audit.habits_count,
      d: audit.state_dims_count,
      tg: actTags.length,
    });
  }
  const bodyEl = $("#ai-audit-body");
  if (bodyEl) {
    const actTagsHtml = actTags.length
      ? actTags.map((x) => `<span class="tag-pill">#${esc(x.tag)} · ${x.days}${esc(t("day_short"))}</span>`).join("")
      : `<span class="muted">${esc(t("an_audit_no_active_tags"))}</span>`;
    const pendRowHtml = pendTags.length
      ? `<div class="ai-audit-row">
          <span class="ai-audit-lbl">${esc(t("an_audit_pending_lbl"))}</span>
          <span class="ai-audit-val">${pendTags.map((x) => `<span class="chip">#${esc(x.tag)} · ${x.days}${esc(t("day_short"))}</span>`).join("")} <span class="sm-text">${esc(t("an_audit_pending_hint"))}</span></span>
        </div>`
      : "";
    bodyEl.innerHTML = `
      <div class="ai-audit-row">
        <span class="ai-audit-lbl">${esc(t("an_audit_tabpfn_lbl", { engine: ai.engine_label || "TabPFN" }))}</span>
        <span class="ai-audit-val">${esc(t("an_audit_tabpfn_val", { h: audit.habits_count, d: audit.state_dims_count, days: audit.observed_days }))} ${actTagsHtml}</span>
      </div>
      ${pendRowHtml}
      <div class="ai-audit-row">
        <span class="ai-audit-lbl">${esc(t("an_audit_ode_lbl"))}</span>
        <span class="ai-audit-val">${esc(t("an_audit_ode_val", { ev: audit.events_count, sn: audit.snapshots_count }))}</span>
      </div>
      <div class="ai-audit-row">
        <span class="ai-audit-lbl">${esc(t("an_audit_priv_lbl"))}</span>
        <span class="ai-audit-val">${esc(t("an_audit_priv_val"))}</span>
      </div>
    `;
  }
}

// ---- EVENT BINDING ----
function bindEvents() {
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  $("#btn-prev-day").addEventListener("click", () => { state.day = shiftDate(state.day, -1); resetLogRange(false); loadToday(); });
  $("#btn-next-day").addEventListener("click", () => { state.day = shiftDate(state.day, +1); resetLogRange(false); loadToday(); });
  $("#btn-go-today").addEventListener("click", () => { state.day = localDateISO(new Date()); resetLogRange(false); loadToday(); });
  $("#day-picker").addEventListener("change", (e) => { if (e.target.value) { state.day = e.target.value; resetLogRange(false); loadToday(); } });

  // Multi-day log history & custom date-range jump
  $("#btn-log-load-more").addEventListener("click", () => {
    const curStart = state.logRange ? state.logRange.start : state.day;
    const curEnd = state.logRange ? state.logRange.end : state.day;
    loadLogRange(shiftDate(curStart, -3), curEnd);
  });
  $("#btn-log-reset").addEventListener("click", () => resetLogRange(true));
  $("#btn-toggle-log-range").addEventListener("click", () => {
    const bar = $("#log-range-bar");
    const willShow = bar.classList.contains("hidden");
    bar.classList.toggle("hidden", !willShow);
    if (willShow) {
      const endVal = state.logRange ? state.logRange.end : state.day;
      const startVal = state.logRange ? state.logRange.start : shiftDate(endVal, -6);
      $("#log-range-start").value = startVal;
      $("#log-range-end").value = endVal;
    }
  });
  $("#btn-apply-log-range").addEventListener("click", () => {
    const s = $("#log-range-start").value;
    const e = $("#log-range-end").value || state.day;
    if (s && e) loadLogRange(s, e);
  });
  $("#log-range-bar").addEventListener("click", (e) => {
    const pBtn = e.target.closest("[data-log-preset]");
    if (!pBtn) return;
    const days = Number(pBtn.dataset.logPreset) || 7;
    const endVal = $("#log-range-end").value || (state.logRange ? state.logRange.end : state.day);
    const startVal = shiftDate(endVal, -(days - 1));
    loadLogRange(startVal, endVal);
  });

  // Today filters & sort toggle
  $("#today-kind-pills").addEventListener("click", (e) => {
    const pill = e.target.closest("[data-fkind]");
    if (!pill) return;
    state.filterKind = pill.dataset.fkind;
    if (state.filterKind === "focus") localStorage.setItem("daily_today_focus", "1");
    else if (state.filterKind === "all") localStorage.setItem("daily_today_focus", "0");
    state.showDormantToday = false;
    $$("#today-kind-pills [data-fkind]").forEach((p) => p.classList.toggle("active", p === pill));
    if (state.todayData) renderToday(state.todayData);
  });
  $("#today-sort-switch").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sort]");
    if (!btn) return;
    state.sortMode = btn.dataset.sort;
    localStorage.setItem("daily_sort_mode", state.sortMode);
    syncSortUI();
    if (state.todayData) renderToday(state.todayData);
  });
  $("#today-search").addEventListener("input", (e) => {
    state.filterQuery = e.target.value;
    if (state.todayData) renderToday(state.todayData);
  });

  // Quick-create habit on Today bar (show optional target/period only for Mehr/Weniger)
  const syncQuickCreateKindUI = () => {
    const isNeutral = $("#qc-kind").value === "neutral";
    $("#qc-target").classList.toggle("hidden", isNeutral);
    $("#qc-period").classList.toggle("hidden", isNeutral);
    if (isNeutral) $("#qc-target").value = "";
  };
  $("#qc-kind").addEventListener("change", syncQuickCreateKindUI);
  syncQuickCreateKindUI();

  const qcColorInp = $("#qc-color");
  if (qcColorInp) {
    qcColorInp.addEventListener("input", (e) => {
      qcColorDirty = true;
      syncQuickCreateColor(e.target.value);
    });
    qcColorInp.addEventListener("change", (e) => {
      qcColorDirty = true;
      syncQuickCreateColor(e.target.value);
      rememberHabitColor(e.target.value);
    });
    syncQuickCreateColor();
  }

  $("#quick-create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#qc-name").value.trim();
    const kind = $("#qc-kind").value;
    const rawT = $("#qc-target").value.trim();
    const target = kind !== "neutral" && rawT !== "" ? Number(rawT) : null;
    const target_period = kind !== "neutral" ? ($("#qc-period").value || "day") : "day";
    const color = normalizeHexColor($("#qc-color")?.value) || getDefaultHabitColor();
    if (!name) return;
    try {
      await api("/api/habits", {
        method: "POST",
        body: JSON.stringify({ name, kind, target, target_period, color }),
      });
      rememberHabitColor(color);
      qcColorDirty = false;
      syncQuickCreateColor(color);
      $("#qc-name").value = "";
      $("#qc-target").value = "";
      $("#qc-period").value = "day";
      syncQuickCreateKindUI();
      toast(t("habit_created", { name }));
      await loadToday();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });

  // Habit cards click delegation (actions + active-start adjust + multi-toggle focus clusters) & hover glow
  const handleCardAreaClick = async (e) => {
    const activeChip = e.target.closest(".active-chip[data-active-id]");
    if (activeChip) {
      e.stopPropagation();
      const id = activeChip.dataset.activeId;
      const h = state.habits.find((x) => x.id === id);
      if (!h || !h.active_since) return;
      const curHHMM = String(h.active_since).slice(11, 16);
      const ans = prompt(t("session_edit_start_prompt", { name: h.name }), curHHMM);
      if (ans === null) return;
      const trimmed = ans.trim();
      try {
        if (trimmed === "") {
          await api(`/api/habits/${encodeURIComponent(id)}/toggle-active`, { method: "POST", body: JSON.stringify({ cancel: true }) });
          toast(t("session_cancelled", { name: h.name }));
        } else if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
          const [hh, mm] = trimmed.split(":").map((x) => x.padStart(2, "0"));
          const dayPrefix = String(h.active_since).slice(0, 10) || localDateISO(new Date());
          await api(`/api/habits/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({ active_since: `${dayPrefix}T${hh}:${mm}:00` }),
          });
          toast(t("time_updated", { v: `${hh}:${mm}` }));
        }
        await loadToday();
      } catch (err) {
        toast(t("err_prefix", { msg: err.message }));
      }
      return;
    }
    const btn = e.target.closest("button[data-act]");
    if (btn) {
      const id = btn.dataset.id;
      if (btn.dataset.act === "tap") quickTap(id);
      if (btn.dataset.act === "toggle-active") toggleHabitActive(id);
      if (btn.dataset.act === "custom") openCustomLog(id);
      if (btn.dataset.act === "edit") {
        setTab("setup");
        setTimeout(() => loadSetup(id), 30);
      }
      return;
    }
    const card = e.target.closest(".habit-card[data-id]");
    if (card && card.dataset.hasLinks === "1") {
      const id = card.dataset.id;
      const idx = state.toggledFocus.indexOf(id);
      if (idx >= 0) state.toggledFocus.splice(idx, 1);
      else state.toggledFocus.push(id);
      clearRouteHighlight();
      if (state.todayData) renderToday(state.todayData);
    }
  };
  $("#habit-grid").addEventListener("click", handleCardAreaClick);
  $("#focus-clusters").addEventListener("click", handleCardAreaClick);
  const dormantWrap = $("#dormant-habits-wrap");
  if (dormantWrap) {
    dormantWrap.addEventListener("click", (e) => {
      if (e.target.closest("[data-toggle-dormant]")) {
        state.showDormantToday = !state.showDormantToday;
        if (state.todayData) renderToday(state.todayData);
        return;
      }
      handleCardAreaClick(e);
    });
  }
  const wmBox = $("#week-matrix");
  if (wmBox) {
    wmBox.addEventListener("click", (e) => {
      if (!e.target.closest("[data-toggle-inactive-matrix]")) return;
      state.showInactiveMatrix = !state.showInactiveMatrix;
      if (state.lastMatrixData) {
        renderWeekMatrix(state.lastMatrixData.dates, state.lastMatrixData.weekMatrix, state.lastMatrixData.endDay);
      }
    });
  }
  const rlBox = $("#rhythm-list");
  if (rlBox) {
    rlBox.addEventListener("click", (e) => {
      if (!e.target.closest("[data-toggle-empty-rhythms]")) return;
      state.showEmptyRhythms = !state.showEmptyRhythms;
      renderRhythmsPanel();
    });
  }
  $("#btn-clear-focus").addEventListener("click", () => {
    state.toggledFocus = [];
    if (state.todayData) renderToday(state.todayData);
  });

  $("#habit-grid").addEventListener("mouseover", (e) => {
    const card = e.target.closest(".habit-card[data-id]");
    clearRouteHighlight();
    if (card) applyRouteHighlight(card.dataset.id);
  });
  $("#habit-grid").addEventListener("mouseleave", clearRouteHighlight);

  // Day log interactions (full editor modal for events & snapshots + quick delete)
  $("#event-list").addEventListener("click", async (e) => {
    const snapDel = e.target.closest("[data-snap-del]");
    if (snapDel) {
      await api(`/api/snapshots/${snapDel.dataset.snapDel}`, { method: "DELETE" });
      toast(t("deleted_snap"));
      await refreshAfterLogMutation();
      return;
    }
    const snapEdit = e.target.closest("[data-snap-edit]");
    if (snapEdit) {
      const sn = state.logSnapsById[Number(snapEdit.dataset.snapEdit)];
      if (sn) openMoodModal(sn);
      return;
    }
    const delBtn = e.target.closest("[data-ev-del]");
    if (delBtn) {
      await api(`/api/events/${delBtn.dataset.evDel}`, { method: "DELETE" });
      toast(t("deleted_entry"));
      await refreshAfterLogMutation();
      return;
    }
    const editBtn = e.target.closest("[data-ev-edit]");
    if (editBtn) {
      const ev = state.logEventsById[Number(editBtn.dataset.evEdit)];
      if (ev) openEditEventModal(ev);
      return;
    }
    const timeEl = e.target.closest("[data-ev-time]");
    if (timeEl) {
      const ev = state.logEventsById[Number(timeEl.dataset.evTime)];
      if (ev) openEditEventModal(ev, "#ee-time");
      return;
    }
    const amtEl = e.target.closest("[data-ev-amt]");
    if (amtEl) {
      const ev = state.logEventsById[Number(amtEl.dataset.evAmt)];
      if (ev) openEditEventModal(ev, "#ee-amount");
      return;
    }
    const noteEl = e.target.closest("[data-ev-note]");
    if (noteEl) {
      const ev = state.logEventsById[Number(noteEl.dataset.evNote)];
      if (ev) openEditEventModal(ev, "#ee-note");
      return;
    }
    const rowToggle = e.target.closest("[data-ev-toggle]");
    if (rowToggle) {
      const evId = String(rowToggle.dataset.evToggle);
      const entryWrap = rowToggle.closest(".ev-entry");
      const wasOpen = entryWrap?.classList.contains("expanded");
      $("#event-list").querySelectorAll(".ev-entry.expanded").forEach((el) => {
        el.classList.remove("expanded");
        el.querySelector(".ev-detail")?.classList.add("hidden");
        const ch = el.querySelector(".ev-chevron");
        if (ch) ch.textContent = "▸";
      });
      if (!wasOpen && entryWrap) {
        state.expandedLogEventId = evId;
        entryWrap.classList.add("expanded");
        entryWrap.querySelector(".ev-detail")?.classList.remove("hidden");
        const ch = entryWrap.querySelector(".ev-chevron");
        if (ch) ch.textContent = "▾";
        if (!state.analysisBoard) {
          ensureAnalysisBoard(false, true)
            .then(() => {
              const evObj = state.logEventsById[Number(evId)] || state.logEventsById[evId];
              const cfBox = entryWrap.querySelector(`[data-ev-cf-box="${evId}"]`);
              if (evObj && cfBox) {
                const dimsById = {};
                (state.stateDims || []).forEach((d) => { dimsById[d.id] = d; });
                cfBox.innerHTML = renderEventCounterfactualHtml(evObj, dimsById);
              }
            })
            .catch(() => {});
        }
      } else {
        state.expandedLogEventId = null;
      }
    }
  });

  // Day log event editor modal handlers
  $("#btn-close-ee").addEventListener("click", closeEditEventModal);
  $("#btn-cancel-ee").addEventListener("click", closeEditEventModal);
  $("#edit-event-modal").addEventListener("click", (e) => {
    if (e.target.id === "edit-event-modal") closeEditEventModal();
  });
  ["#ee-start", "#ee-time", "#ee-habit"].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener("change", () => updateEditEventDurationHint(true));
  });
  $("#btn-ee-delete").addEventListener("click", async () => {
    const evId = $("#ee-id").value;
    if (!evId) return;
    try {
      await api(`/api/events/${evId}`, { method: "DELETE" });
      closeEditEventModal();
      toast(t("deleted_entry"));
      await refreshAfterLogMutation();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });
  $("#ee-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const evId = $("#ee-id").value;
    const habit_id = $("#ee-habit").value;
    const dayIso = $("#ee-date").value || state.day;
    const endHHMM = $("#ee-time").value || "12:00";
    const startHHMM = $("#ee-start").value;
    const amount = Number(String($("#ee-amount").value).replace(",", "."));
    const note = $("#ee-note").value.trim();
    if (Number.isNaN(amount) || amount === 0) {
      toast(t("prompt_amt_err"));
      return;
    }
    const orig = state.editingEvent || {};
    const patch = {
      habit_id,
      amount,
      occurred_at: `${dayIso}T${endHHMM}:00`,
      note,
    };
    if (startHHMM) {
      patch.window_minutes = computeTimeDiffMin(startHHMM, endHHMM);
    } else if (orig.source !== "retro") {
      patch.window_minutes = 0;
    }
    try {
      await api(`/api/events/${evId}`, { method: "PATCH", body: JSON.stringify(patch) });
      closeEditEventModal();
      toast(t("entry_updated"));
      await refreshAfterLogMutation();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });

  // Quick-pick existing #tag chips in Mood / Custom Log / Edit Entry / Retro note fields
  document.body.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-tag-pick]");
    if (!chip) return;
    const inp = $(chip.dataset.tagInput);
    toggleTagInInput(inp, chip.dataset.tagPick);
    renderTagSuggestChips(chip.dataset.tagBox, chip.dataset.tagInput);
  });
  [
    ["#mood-tag-chips", "#mood-note"],
    ["#cl-tag-chips", "#cl-note"],
    ["#ee-tag-chips", "#ee-note"],
    ["#retro-tag-chips", "#retro-note"],
  ].forEach(([boxSel, inpSel]) => {
    const inp = $(inpSel);
    if (inp) inp.addEventListener("input", () => renderTagSuggestChips(boxSel, inpSel));
  });

  // Custom log modal
  $("#btn-close-cl").addEventListener("click", closeCustomLog);
  $("#btn-cancel-cl").addEventListener("click", closeCustomLog);
  ["#cl-start", "#cl-time"].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener("input", () => updateCustomLogDurationHint(true));
    el.addEventListener("change", () => updateCustomLogDurationHint(true));
  });
  $("#custom-log-modal").addEventListener("click", (e) => {
    if (e.target.id === "custom-log-modal") closeCustomLog();
    const ago = e.target.closest("[data-ago]");
    if (ago) {
      const mins = Number(ago.dataset.ago);
      const nowDt = new Date();
      const dt = new Date(nowDt.getTime() - mins * 60000);
      const h = state.habits.find((x) => x.id === $("#cl-habit-id").value);
      if (h && h.block_minutes && Number(h.block_minutes) > 0 && $("#cl-start")) {
        $("#cl-start").value = localTimeHHMM(dt);
        $("#cl-time").value = localTimeHHMM(nowDt);
        updateCustomLogDurationHint(true);
      } else {
        $("#cl-time").value = localTimeHHMM(dt);
      }
    }
  });
  $("#cl-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const habit_id = $("#cl-habit-id").value;
    const h = state.habits.find((x) => x.id === habit_id);
    const amount = Number(String($("#cl-amount").value).replace(",", "."));
    const hhmm = $("#cl-time").value;
    const startVal = h && h.block_minutes && $("#cl-start") ? $("#cl-start").value : "";
    const window_minutes = startVal ? computeTimeDiffMin(startVal, hhmm) : 0;
    const note = $("#cl-note").value.trim();
    try {
      await api("/api/events", {
        method: "POST",
        body: JSON.stringify({
          habit_id,
          amount,
          occurred_at: `${state.day}T${hhmm}:00`,
          window_minutes,
          source: "manual",
          note,
        }),
      });
      closeCustomLog();
      toast(t("saved"));
      await loadToday();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });

  // Retro modal
  $("#btn-open-retro").addEventListener("click", openRetroModal);
  $("#btn-close-retro").addEventListener("click", closeRetroModal);
  $("#btn-cancel-retro").addEventListener("click", closeRetroModal);
  $("#retro-modal").addEventListener("click", (e) => {
    if (e.target.id === "retro-modal") closeRetroModal();
    const winBtn = e.target.closest("[data-win]");
    if (winBtn) {
      state.retroWindowMin = Number(winBtn.dataset.win);
      $$("#retro-modal [data-win]").forEach((b) => b.classList.toggle("active", b === winBtn));
    }
    const stepBtn = e.target.closest("[data-rstep]");
    if (stepBtn) {
      const id = stepBtn.dataset.rstep;
      const d = Number(stepBtn.dataset.d);
      const h = state.habits.find((x) => x.id === id);
      const step = habitTapStep(h);
      state.retroAmounts[id] = Math.max(0, Math.round(((state.retroAmounts[id] || 0) + d * step) * 1000) / 1000);
      renderRetroRows();
    }
  });
  $("#retro-inline-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#retro-new-habit").value.trim();
    if (!name) return;
    try {
      const created = await api("/api/habits", {
        method: "POST",
        body: JSON.stringify({ name, kind: "neutral" }),
      });
      state.habits.push(created);
      state.retroAmounts[created.id] = 1;
      $("#retro-new-habit").value = "";
      renderRetroRows();
      toast(t("retro_added_one", { name }));
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });
  $("#btn-submit-retro").addEventListener("click", async () => {
    const items = Object.entries(state.retroAmounts)
      .filter(([, amt]) => amt > 0)
      .map(([habit_id, amount]) => ({ habit_id, amount }));
    if (!items.length) {
      toast(t("retro_need_one"));
      return;
    }
    const hhmm = $("#retro-end-time").value || localTimeHHMM(new Date());
    try {
      await api("/api/events/retro", {
        method: "POST",
        body: JSON.stringify({
          items,
          window_minutes: state.retroWindowMin,
          end_at: `${state.day}T${hhmm}:00`,
          note: $("#retro-note").value.trim(),
        }),
      });
      closeRetroModal();
      toast(t("retro_saved", { n: items.length }));
      if (state.tab === "today") await loadToday();
      if (state.tab === "analysis") await loadAnalysis();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });

  // Momentaufnahme (Befinden) modal
  $("#btn-open-mood").addEventListener("click", openMoodModal);
  $("#btn-close-mood").addEventListener("click", closeMoodModal);
  $("#btn-cancel-mood").addEventListener("click", closeMoodModal);
  $("#mood-modal").addEventListener("click", async (e) => {
    if (e.target.id === "mood-modal") {
      closeMoodModal();
      return;
    }
    const mGroupBtn = e.target.closest("[data-mgroup]");
    if (mGroupBtn) {
      const gid = mGroupBtn.dataset.mgroup;
      state.activeMoodGroup = gid;
      renderMoodModal();
      api("/api/settings", { method: "PATCH", body: JSON.stringify({ active_mood_group: gid }) })
        .then((upd) => { state.settings = { ...state.settings, ...upd }; })
        .catch(() => {});
      return;
    }
    if (e.target.closest("[data-mgroup-new]")) {
      const det = $("#mood-manage-details");
      if (det) det.open = true;
      resetMoodGroupForm();
      const inp = $("#mg-name");
      if (inp) setTimeout(() => { inp.scrollIntoView({ behavior: "smooth", block: "nearest" }); inp.focus(); }, 30);
      return;
    }
    const mgDimBtn = e.target.closest("[data-mg-dim]");
    if (mgDimBtn) {
      const did = mgDimBtn.dataset.mgDim;
      if (state.mgDraftDims.has(did)) state.mgDraftDims.delete(did);
      else state.mgDraftDims.add(did);
      renderMoodGroupManager();
      return;
    }
    const mgEditBtn = e.target.closest("[data-mg-edit]");
    if (mgEditBtn) {
      const grp = state.moodGroups.find((g) => g.id === mgEditBtn.dataset.mgEdit);
      if (grp) populateMoodGroupForm(grp);
      return;
    }
    const mgDelBtn = e.target.closest("[data-mg-del]");
    if (mgDelBtn) {
      const gid = mgDelBtn.dataset.mgDel;
      const next = state.moodGroups.filter((g) => g.id !== gid);
      const nextAct = state.activeMoodGroup === gid ? (next[0] ? next[0].id : "all") : state.activeMoodGroup;
      await saveMoodGroups(next, nextAct);
      resetMoodGroupForm();
      toast(t("mg_deleted"));
      return;
    }
    const inlineEditBtn = e.target.closest("[data-dim-inline-edit]");
    if (inlineEditBtn) {
      if (state._justDraggedMoodAxis) return;
      state.editingDimId = inlineEditBtn.dataset.dimInlineEdit;
      const focusTarget = inlineEditBtn.dataset.focus === "low" ? "#dim-edit-low" : "#dim-edit-name";
      renderMoodModal();
      const inp = $(focusTarget);
      if (inp) setTimeout(() => { inp.focus(); inp.select(); }, 15);
      return;
    }
    if (e.target.closest("[data-dim-edit-cancel]")) {
      state.editingDimId = null;
      renderMoodModal();
      return;
    }
    const mBtn = e.target.closest("[data-mdim]");
    if (mBtn) {
      const dimId = mBtn.dataset.mdim;
      const val = Number(mBtn.dataset.mval);
      if (state.moodRatings[dimId] === val) delete state.moodRatings[dimId];
      else state.moodRatings[dimId] = val;
      renderMoodModal();
      return;
    }
    const cBtn = e.target.closest("[data-mcause]");
    if (cBtn) {
      const hid = cBtn.dataset.mcause;
      if (state.moodCauses.has(hid)) state.moodCauses.delete(hid);
      else state.moodCauses.add(hid);
      renderMoodModal();
      return;
    }
    const hideDim = e.target.closest("[data-hide-dim]");
    if (hideDim) {
      await api(`/api/state/dimensions/${encodeURIComponent(hideDim.dataset.hideDim)}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      });
      await openMoodModal();
      return;
    }
    const restoreDim = e.target.closest("[data-restore-dim]");
    if (restoreDim) {
      await api(`/api/state/dimensions/${encodeURIComponent(restoreDim.dataset.restoreDim)}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: false }),
      });
      await openMoodModal();
    }
  });
  // Tap directly on any axis color dot to update color immediately
  const moodAxesList = $("#mood-axes-list");
  // Zero-icon whole-card drag reordering for Befinden axes (Mouse: drag card; Touch: hold ~210ms)
  let moodDragRow = null;
  let moodPendingRow = null;
  let moodDragStartOrder = [];
  let moodDragPointerId = null;
  let moodDragStartX = 0;
  let moodDragStartY = 0;
  let moodHoldTimer = null;

  const clearMoodPendingDrag = () => {
    if (moodHoldTimer) {
      clearTimeout(moodHoldTimer);
      moodHoldTimer = null;
    }
    moodPendingRow = null;
  };

  const activateMoodAxisDrag = (row, pointerId) => {
    clearMoodPendingDrag();
    moodDragRow = row;
    moodDragStartOrder = Array.from(moodAxesList.querySelectorAll(".mood-axis[data-dim-id]")).map((el) => el.dataset.dimId);
    row.classList.add("is-dragging");
    try { row.setPointerCapture(pointerId); } catch {}
    if (navigator.vibrate) {
      try { navigator.vibrate(10); } catch {}
    }
  };

  const finishMoodAxisDrag = async () => {
    clearMoodPendingDrag();
    if (!moodDragRow) return;
    moodDragRow.classList.remove("is-dragging");
    if (moodDragPointerId != null) {
      try { moodDragRow.releasePointerCapture(moodDragPointerId); } catch {}
    }
    moodDragRow = null;
    moodDragPointerId = null;
    state._justDraggedMoodAxis = true;
    setTimeout(() => { state._justDraggedMoodAxis = false; }, 160);

    const newVisOrder = Array.from(moodAxesList.querySelectorAll(".mood-axis[data-dim-id]")).map((el) => el.dataset.dimId);
    const changed = newVisOrder.length === moodDragStartOrder.length && newVisOrder.some((id, i) => id !== moodDragStartOrder[i]);
    if (!changed) return;

    try {
      // Slot the reordered visible axes back into their positions in the global sort_order
      const visSet = new Set(newVisOrder);
      let k = 0;
      const nextGlobalIds = state.stateDims.map((d) => (visSet.has(d.id) ? newVisOrder[k++] : d.id));
      for (const id of newVisOrder) {
        if (!nextGlobalIds.includes(id)) nextGlobalIds.push(id);
      }
      const rankOf = Object.fromEntries(nextGlobalIds.map((id, idx) => [id, idx]));

      // Update local stateDims immediately so re-renders inside saveMoodGroups use the new order
      const dimById = Object.fromEntries(state.stateDims.map((d) => [d.id, d]));
      state.stateDims = nextGlobalIds.map((id, idx) => ({ ...dimById[id], sort_order: idx })).filter((x) => x && x.id);

      // Keep ALL mood groups cleanly aligned with the new axis order (whether dragged in Alle or in a specific group!)
      const activeGrp = state.activeMoodGroup !== "all" ? state.moodGroups.find((g) => g.id === state.activeMoodGroup) : null;
      const nextGroups = state.moodGroups.map((g) => {
        if (activeGrp && g.id === activeGrp.id) {
          const hiddenInGrp = (g.dim_ids || []).filter((id) => !visSet.has(id));
          return { ...g, dim_ids: [...newVisOrder, ...hiddenInGrp] };
        }
        const sortedIds = [...(g.dim_ids || [])].sort((a, b) => (rankOf[a] ?? 9999) - (rankOf[b] ?? 9999));
        return { ...g, dim_ids: sortedIds };
      });

      const tasks = [
        api("/api/state/dimensions/reorder", {
          method: "POST",
          body: JSON.stringify({ dim_ids: nextGlobalIds }),
        }),
      ];
      if (nextGroups.length) {
        tasks.push(saveMoodGroups(nextGroups, state.activeMoodGroup));
      }
      await Promise.all(tasks);

      toast(t("reordered_toast"));
      if (state.tab === "analysis") await loadAnalysis();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
      await openMoodModal();
    }
  };

  moodAxesList.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".mood-axis:not(.is-editing)")) e.preventDefault();
  });
  moodAxesList.addEventListener("touchmove", (e) => {
    if (moodDragRow) e.preventDefault();
  }, { passive: false });
  moodAxesList.addEventListener("pointerdown", (e) => {
    if (state.editingDimId) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (e.target.closest("button, input, label, a, select, form")) return;
    const row = e.target.closest(".mood-axis[data-dim-id]");
    if (!row || row.classList.contains("is-editing")) return;
    moodPendingRow = row;
    moodDragPointerId = e.pointerId;
    moodDragStartX = e.clientX;
    moodDragStartY = e.clientY;
    if (e.pointerType === "touch") {
      moodHoldTimer = setTimeout(() => {
        if (moodPendingRow === row) activateMoodAxisDrag(row, e.pointerId);
      }, 210);
    }
  });
  moodAxesList.addEventListener("pointermove", (e) => {
    if (moodPendingRow && !moodDragRow) {
      const dx = Math.abs(e.clientX - moodDragStartX);
      const dy = Math.abs(e.clientY - moodDragStartY);
      if (e.pointerType === "touch") {
        if (dx > 8 || dy > 8) clearMoodPendingDrag();
        return;
      }
      if (dy >= 5) {
        e.preventDefault();
        activateMoodAxisDrag(moodPendingRow, e.pointerId);
      } else {
        return;
      }
    }
    if (!moodDragRow) return;
    e.preventDefault();
    const rows = Array.from(moodAxesList.querySelectorAll(".mood-axis[data-dim-id]"));
    for (const r of rows) {
      if (r === moodDragRow) continue;
      const rect = r.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid && r.compareDocumentPosition(moodDragRow) & Node.DOCUMENT_POSITION_FOLLOWING) {
        moodAxesList.insertBefore(moodDragRow, r);
        break;
      } else if (e.clientY > mid && moodDragRow.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) {
        moodAxesList.insertBefore(moodDragRow, r.nextSibling);
        break;
      }
    }
  });
  moodAxesList.addEventListener("pointerup", finishMoodAxisDrag);
  moodAxesList.addEventListener("pointercancel", finishMoodAxisDrag);

  moodAxesList.addEventListener("change", async (e) => {
    const inp = e.target.closest("[data-dim-color]");
    if (!inp) return;
    const dimId = inp.dataset.dimColor;
    const color = inp.value;
    try {
      const updated = await api(`/api/state/dimensions/${encodeURIComponent(dimId)}`, {
        method: "PATCH",
        body: JSON.stringify({ color }),
      });
      const local = state.stateDims.find((d) => d.id === dimId);
      if (local) local.color = updated.color || color;
      renderMoodModal();
      toast(t("axis_color_saved", { name: dimName(local || { id: dimId, name: dimId }) }));
      if (state.tab === "today") await refreshAfterLogMutation();
      if (state.tab === "analysis") await loadAnalysis();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });
  // Save inline axis rename / 1-5 anchor labels on Enter or Save click
  $("#mood-axes-list").addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-dim-edit-form]");
    if (!form) return;
    e.preventDefault();
    const dimId = form.dataset.dimEditForm;
    const name = ($("#dim-edit-name").value || "").trim();
    const low_label = ($("#dim-edit-low").value || "").trim();
    const high_label = ($("#dim-edit-high").value || "").trim();
    if (!name) return;
    try {
      const updated = await api(`/api/state/dimensions/${encodeURIComponent(dimId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name, low_label, high_label }),
      });
      const local = state.stateDims.find((d) => d.id === dimId);
      if (local) {
        local.name = updated.name;
        local.low_label = updated.low_label;
        local.high_label = updated.high_label;
      }
      state.editingDimId = null;
      renderMoodModal();
      toast(t("axis_updated", { name: updated.name }));
      if (state.tab === "today") await refreshAfterLogMutation();
      if (state.tab === "analysis") await loadAnalysis();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });
  $("#btn-cancel-mg").addEventListener("click", resetMoodGroupForm);
  $("#mood-group-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#mg-name").value.trim();
    const orderIdx = Object.fromEntries(state.stateDims.map((d, idx) => [d.id, idx]));
    const dimIds = Array.from(state.mgDraftDims).sort((a, b) => (orderIdx[a] ?? 9999) - (orderIdx[b] ?? 9999));
    if (!name || !dimIds.length) {
      toast(t("mg_need_dims"));
      return;
    }
    const editId = $("#mg-edit-id").value;
    let next;
    let targetId;
    if (editId && state.moodGroups.some((g) => g.id === editId)) {
      targetId = editId;
      next = state.moodGroups.map((g) => (g.id === editId ? { ...g, name, dim_ids: dimIds } : g));
    } else {
      const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `grp-${Date.now()}`;
      targetId = baseSlug;
      let idx = 2;
      while (state.moodGroups.some((g) => g.id === targetId)) targetId = `${baseSlug}-${idx++}`;
      next = [...state.moodGroups, { id: targetId, name, dim_ids: dimIds }];
    }
    try {
      await saveMoodGroups(next, targetId);
      resetMoodGroupForm();
      toast(t("mg_saved", { name }));
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });
  $("#mood-add-axis-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#ma-name").value.trim();
    if (!name) return;
    try {
      const created = await api("/api/state/dimensions", {
        method: "POST",
        body: JSON.stringify({
          name,
          low_label: $("#ma-low").value.trim(),
          high_label: $("#ma-high").value.trim(),
          color: ($("#ma-color") && $("#ma-color").value) || "",
        }),
      });
      // Automatically include the newly created axis in the currently active group so it shows up immediately
      if (created && created.id && state.activeMoodGroup && state.activeMoodGroup !== "all") {
        const curGrp = state.moodGroups.find((g) => g.id === state.activeMoodGroup);
        if (curGrp && !curGrp.dim_ids.includes(created.id)) {
          const next = state.moodGroups.map((g) =>
            g.id === curGrp.id ? { ...g, dim_ids: [...g.dim_ids, created.id] } : g
          );
          await saveMoodGroups(next, state.activeMoodGroup).catch(() => {});
        }
      }
      $("#ma-name").value = "";
      $("#ma-low").value = "";
      $("#ma-high").value = "";
      toast(t("axis_added", { name }));
      await openMoodModal();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });
  $("#btn-submit-mood").addEventListener("click", async () => {
    const ratings = { ...state.moodRatings };
    const causes = Array.from(state.moodCauses);
    const note = $("#mood-note").value.trim();
    if (!Object.keys(ratings).length && !causes.length && !note) {
      toast(t("snap_need_one"));
      return;
    }
    const dayIso = ($("#mood-date") && $("#mood-date").value) || state.day;
    const hhmm = $("#mood-time").value || localTimeHHMM(new Date());
    const occurred_at = `${dayIso}T${hhmm}:00`;
    if (state.editingSnapId) {
      try {
        await api(`/api/snapshots/${state.editingSnapId}`, {
          method: "PATCH",
          body: JSON.stringify({ ratings, causes, note, occurred_at }),
        });
        closeMoodModal();
        toast(t("snap_updated"));
        await refreshAfterLogMutation();
      } catch (err) {
        toast(t("err_prefix", { msg: err.message }));
      }
      return;
    }
    const client_uuid = makeUuid();
    const payload = { ratings, causes, note, occurred_at, client_uuid };
    try {
      await api("/api/snapshots", { method: "POST", body: JSON.stringify(payload) });
      closeMoodModal();
      toast(t("snap_saved"));
      await refreshAfterLogMutation();
    } catch {
      const q = loadOfflineSnapshots();
      q.push(payload);
      saveOfflineSnapshots(q);
      closeMoodModal();
      toast(t("offline_snap"));
    }
  });

  // Setup: swatches, weekday pills, form, edit, reorder, delete
  $("#hf-rem-days").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-wd]");
    if (btn) btn.classList.toggle("active");
  });
  $("#hf-colors").addEventListener("click", (e) => {
    const sw = e.target.closest(".swatch");
    if (sw) {
      $("#hf-color").value = sw.dataset.color;
      syncActiveColorSwatch();
    }
  });
  $("#hf-color").addEventListener("input", syncActiveColorSwatch);
  $("#hf-color").addEventListener("change", (e) => rememberHabitColor(e.target.value));
  $("#hf-name").addEventListener("input", renderHabitNameMatches);
  $("#hf-name").addEventListener("focus", renderHabitNameMatches);
  $("#hf-name-matches").addEventListener("click", async (e) => {
    const item = e.target.closest("[data-match-habit]");
    if (!item) return;
    const hid = item.dataset.matchHabit;
    const isArch = item.dataset.matchArchived === "1";
    clearHabitNameMatches();
    if (isArch) {
      try {
        await api(`/api/habits/${encodeURIComponent(hid)}`, {
          method: "PATCH",
          body: JSON.stringify({ archived: false }),
        });
        toast(t("habit_restored"));
        await loadSetup();
        populateHabitForm(hid);
      } catch (err) {
        toast(t("err_prefix", { msg: err.message }));
      }
    } else {
      populateHabitForm(hid);
    }
  });
  $("#hf-group").addEventListener("input", renderHabitGroupChips);
  $("#hf-group-chips").addEventListener("click", (e) => {
    const ch = e.target.closest("[data-hf-group-pick]");
    if (!ch) return;
    const val = ch.dataset.hfGroupPick;
    $("#hf-group").value = $("#hf-group").value.trim().toLowerCase() === val.toLowerCase() ? "" : val;
    renderHabitGroupChips();
  });
  $("#btn-cancel-edit").addEventListener("click", resetHabitForm);
  const setupList = $("#setup-habit-list");
  setupList.addEventListener("click", (e) => {
    if (state._justDraggedHabitGroup && e.target.closest(".habit-group-head")) {
      e.preventDefault();
      return;
    }
    const btn = e.target.closest("[data-setup-edit]");
    if (btn) populateHabitForm(btn.dataset.setupEdit);
  });
  setupList.addEventListener(
    "toggle",
    (e) => {
      const det = e.target;
      if (!det || !det.matches || !det.matches("details.habit-group")) return;
      const gKey = det.dataset.habitGroup ?? "";
      if (det.open) state.closedHabitGroups.delete(gKey);
      else state.closedHabitGroups.add(gKey);
    },
    true
  );

  // Clean zero-icon drag-and-drop for BOTH individual habits (within & across groups!) AND whole group blocks!
  let dragEl = null;
  let dragMode = null; // "row" | "group"
  let pendingEl = null;
  let pendingMode = null;
  let dragStartSnapshot = [];
  let dragPointerId = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let holdTimer = null;

  const clearPendingDrag = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    pendingEl = null;
    pendingMode = null;
  };

  const readSetupOrderSnapshot = () =>
    Array.from(setupList.querySelectorAll(".setup-drag-row")).map((el) => {
      const grpBox = el.closest("[data-group-container]");
      return {
        id: el.dataset.habitId,
        group: grpBox ? grpBox.dataset.groupContainer || "" : el.dataset.origGroup || "",
      };
    });

  const activateHabitDrag = (el, mode, pointerId) => {
    clearPendingDrag();
    dragEl = el;
    dragMode = mode;
    dragStartSnapshot = readSetupOrderSnapshot();
    el.classList.add("is-dragging");
    try { el.setPointerCapture(pointerId); } catch {}
    if (navigator.vibrate) {
      try { navigator.vibrate(10); } catch {}
    }
  };

  const finishHabitDrag = async () => {
    clearPendingDrag();
    if (!dragEl) return;
    const wasGroup = dragMode === "group";
    dragEl.classList.remove("is-dragging");
    if (dragPointerId != null) {
      try { dragEl.releasePointerCapture(dragPointerId); } catch {}
    }
    dragEl = null;
    dragMode = null;
    dragPointerId = null;
    if (wasGroup) {
      state._justDraggedHabitGroup = true;
      setTimeout(() => { state._justDraggedHabitGroup = false; }, 160);
    }

    const nowSnap = readSetupOrderSnapshot();
    const orderChanged =
      nowSnap.length === dragStartSnapshot.length &&
      nowSnap.some((x, i) => x.id !== dragStartSnapshot[i].id || x.group !== dragStartSnapshot[i].group);
    if (!orderChanged) return;

    const newOrder = nowSnap.map((x) => x.id);
    const byIdMap = Object.fromEntries(state.habits.map((h) => [h.id, h]));
    const groupUpdates = {};
    for (const item of nowSnap) {
      const prevG = (byIdMap[item.id] && byIdMap[item.id].group_name) || "";
      if (item.group !== prevG) groupUpdates[item.id] = item.group;
    }

    try {
      await api("/api/habits/reorder", {
        method: "POST",
        body: JSON.stringify({
          habit_ids: newOrder,
          group_updates: Object.keys(groupUpdates).length ? groupUpdates : undefined,
        }),
      });
      state.habits = newOrder
        .map((id, i) => {
          const base = byIdMap[id];
          if (!base) return null;
          const nextG = Object.prototype.hasOwnProperty.call(groupUpdates, id) ? groupUpdates[id] : base.group_name || "";
          return { ...base, sort_order: i, group_name: nextG };
        })
        .filter(Boolean);
      renderSetupHabitList();
      renderHabitGroupChips();
      renderRollupList();
      toast(t("reordered_toast"));
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
      await loadSetup();
    }
  };

  setupList.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".setup-drag-row, .habit-group-head")) e.preventDefault();
  });
  setupList.addEventListener("touchmove", (e) => {
    if (dragEl) e.preventDefault();
  }, { passive: false });
  setupList.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (e.target.closest("button, a, input, select")) return;
    const grpHead = e.target.closest(".habit-group-head");
    const row = !grpHead ? e.target.closest(".setup-drag-row") : null;
    const targetEl = grpHead ? grpHead.closest("details.habit-group") : row;
    const mode = grpHead ? "group" : row ? "row" : null;
    if (!targetEl || !mode) return;
    pendingEl = targetEl;
    pendingMode = mode;
    dragPointerId = e.pointerId;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    if (e.pointerType === "touch") {
      holdTimer = setTimeout(() => {
        if (pendingEl === targetEl) activateHabitDrag(targetEl, mode, e.pointerId);
      }, 210);
    }
  });
  setupList.addEventListener("pointermove", (e) => {
    if (pendingEl && !dragEl) {
      const dx = Math.abs(e.clientX - dragStartX);
      const dy = Math.abs(e.clientY - dragStartY);
      if (e.pointerType === "touch") {
        if (dx > 8 || dy > 8) clearPendingDrag();
        return;
      }
      if (dy >= 5) {
        e.preventDefault();
        activateHabitDrag(pendingEl, pendingMode, e.pointerId);
      } else {
        return;
      }
    }
    if (!dragEl) return;
    e.preventDefault();
    if (dragMode === "group") {
      const grps = Array.from(setupList.querySelectorAll(":scope > details.habit-group"));
      for (const g of grps) {
        if (g === dragEl) continue;
        const rect = g.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (e.clientY < mid && g.compareDocumentPosition(dragEl) & Node.DOCUMENT_POSITION_FOLLOWING) {
          setupList.insertBefore(dragEl, g);
          break;
        } else if (e.clientY > mid && dragEl.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING) {
          setupList.insertBefore(dragEl, g.nextSibling);
          break;
        }
      }
      return;
    }

    // Row drag: supports both flat list AND dragging cleanly across collapsible habit groups!
    const groups = Array.from(setupList.querySelectorAll(":scope > details.habit-group"));
    if (groups.length) {
      let targetContainer = null;
      for (const g of groups) {
        const rect = g.getBoundingClientRect();
        if (e.clientY >= rect.top - 6 && e.clientY <= rect.bottom + 6) {
          if (!g.open) g.open = true;
          targetContainer = g.querySelector(".habit-group-items");
          break;
        }
      }
      if (!targetContainer) {
        const firstRect = groups[0].getBoundingClientRect();
        const chosen = e.clientY < firstRect.top ? groups[0] : groups[groups.length - 1];
        if (!chosen.open) chosen.open = true;
        targetContainer = chosen.querySelector(".habit-group-items");
      }
      if (targetContainer) {
        const sibs = Array.from(targetContainer.querySelectorAll(":scope > .setup-drag-row")).filter((r) => r !== dragEl);
        let placed = false;
        for (const r of sibs) {
          const rect = r.getBoundingClientRect();
          if (e.clientY < rect.top + rect.height / 2) {
            targetContainer.insertBefore(dragEl, r);
            placed = true;
            break;
          }
        }
        if (!placed) targetContainer.appendChild(dragEl);
      }
      return;
    }

    const rows = Array.from(setupList.querySelectorAll(".setup-drag-row"));
    for (const r of rows) {
      if (r === dragEl) continue;
      const rect = r.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid && r.compareDocumentPosition(dragEl) & Node.DOCUMENT_POSITION_FOLLOWING) {
        setupList.insertBefore(dragEl, r);
        break;
      } else if (e.clientY > mid && dragEl.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) {
        setupList.insertBefore(dragEl, r.nextSibling);
        break;
      }
    }
  });
  setupList.addEventListener("pointerup", finishHabitDrag);
  setupList.addEventListener("pointercancel", finishHabitDrag);
  $("#archive-habit-list").addEventListener("click", async (e) => {
    const unarch = e.target.closest("[data-unarchive-id]");
    if (!unarch) return;
    await api(`/api/habits/${encodeURIComponent(unarch.dataset.unarchiveId)}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: false }),
    });
    toast(t("habit_restored"));
    await loadSetup();
  });

  // Device sync, JSON Backup/Restore, CSV standalone & Legal modal
  $("#btn-export-csv").addEventListener("click", (e) => {
    if (!isStandaloneBrowserMode()) return;
    e.preventDefault();
    const csv = window.DailyLocalEngine.exportCsv();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `daily_features_${localDateISO(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#btn-export-json").addEventListener("click", async () => {
    try {
      let rawJson = "";
      if (isStandaloneBrowserMode()) {
        rawJson = window.DailyLocalEngine.exportJson();
      } else {
        const snap = await api("/api/sync", { method: "POST", body: JSON.stringify({ device_id: getDeviceId(), mutations: {} }) });
        rawJson = JSON.stringify(snap, null, 2);
      }
      const blob = new Blob([rawJson], { type: "application/json;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `daily_backup_${localDateISO(new Date())}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(t("backup_saved"));
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });

  $("#inp-import-json").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      if (isStandaloneBrowserMode()) {
        window.DailyLocalEngine.importJson(text);
        toast(t("backup_restored"));
      } else {
        const parsed = JSON.parse(text);
        await api("/api/sync", {
          method: "POST",
          body: JSON.stringify({
            device_id: getDeviceId(),
            mutations: {
              habits: parsed.habits || [],
              edges: parsed.edges || [],
              events: (parsed.events || []).filter((ev) => !ev.deleted_at),
              snapshots: (parsed.snapshots || []).filter((s) => !s.deleted_at),
            },
          }),
        });
        toast(t("backup_merged"));
      }
      await loadSetup();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    } finally {
      e.target.value = "";
    }
  });

  $("#btn-open-legal").addEventListener("click", () => $("#legal-modal").classList.remove("hidden"));
  $("#btn-close-legal").addEventListener("click", () => $("#legal-modal").classList.add("hidden"));
  $("#legal-modal").addEventListener("click", (e) => {
    if (e.target.id === "legal-modal") $("#legal-modal").classList.add("hidden");
  });

  // Avoid self-routing when user manually changes source dropdown
  $("#rf-source").addEventListener("change", () => {
    if ($("#rf-source").value === $("#rf-target").value) {
      $("#rf-target").value = pickDefaultRouteTarget($("#rf-source").value);
    }
  });
  $("#hyp-source").addEventListener("change", () => {
    if ($("#hyp-source").value === $("#hyp-target").value) {
      $("#hyp-target").value = pickDefaultRouteTarget($("#hyp-source").value);
    }
  });

  // AES-256-GCM E2EE Vault Sync controls (works in BOTH standalone PWA & local Python/TabPFN server!)
  $("#e2ee-provider").addEventListener("change", (e) => syncE2EEFieldsUI(e.target.value));

  $("#btn-e2ee-create-gist").addEventListener("click", async () => {
    const tok = $("#e2ee-token").value.trim();
    if (!tok) {
      toast(t("sync_need_token"));
      return;
    }
    if (state.e2eeActive && !confirm(t("sync_confirm_new_gist"))) {
      return;
    }
    try {
      if (isStandaloneBrowserMode()) {
        const res = await window.DailyE2EE.createGistVaultFromBrowser(tok);
        renderE2EEPanel(res);
      } else {
        const res = await api("/api/e2ee/gist/create", {
          method: "POST",
          body: JSON.stringify({ auth_token: tok, key_b64u: null }),
        });
        renderE2EEPanel(res);
      }
      toast(t("sync_started"));
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });

  const saveE2EEConfigAndSync = async () => {
    const provider = $("#e2ee-provider").value;
    const key_b64u =
      $("#e2ee-key").value.trim() || (window.DailyE2EE ? window.DailyE2EE.generateKeyB64u() : "");
    const payload = {
      enabled: true,
      provider,
      gist_id: $("#e2ee-gist-id").value.trim(),
      endpoint_url: $("#e2ee-url").value.trim(),
      auth_token: provider === "gist" ? $("#e2ee-token").value.trim() : $("#e2ee-url-token").value.trim(),
      key_b64u,
    };
    try {
      if (isStandaloneBrowserMode()) {
        const saved = window.DailyE2EE.saveCfg(payload);
        await window.DailyE2EE.syncBrowserVault();
        renderE2EEPanel(window.DailyE2EE.loadCfg());
      } else {
        const saved = await api("/api/e2ee/config", { method: "PATCH", body: JSON.stringify(payload) });
        await api("/api/e2ee/sync", { method: "POST" });
        const fresh = await api("/api/e2ee/config");
        renderE2EEPanel(fresh || saved);
      }
      toast(t("sync_ready"));
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  };
  $("#btn-e2ee-save").addEventListener("click", saveE2EEConfigAndSync);
  $("#btn-e2ee-save-adv").addEventListener("click", saveE2EEConfigAndSync);
  $("#btn-e2ee-join").addEventListener("click", async () => {
    const raw = ($("#e2ee-join-link").value || "").trim();
    const parsed = window.DailyE2EE ? window.DailyE2EE.parsePairingString(raw) : null;
    if (!parsed) {
      toast(t("sync_join_invalid"));
      return;
    }
    try {
      if (window.location && (window.location.hostname.endsWith("aethelburg.network") || window.location.hostname.endsWith("github.io"))) {
        localStorage.removeItem("daily_server_url");
      }
      if (isStandaloneBrowserMode()) {
        window.DailyE2EE.saveCfg(parsed);
        await window.DailyE2EE.syncBrowserVault();
      } else {
        await api("/api/e2ee/config", { method: "PATCH", body: JSON.stringify(parsed) });
        await api("/api/e2ee/sync", { method: "POST" });
      }
      $("#e2ee-join-link").value = "";
      toast(t("paired_ok"));
      await loadSetup();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }), { durationMs: 7000 });
    }
  });

  async function runE2EESyncInteractive() {
    try {
      if (isStandaloneBrowserMode()) {
        const r = await window.DailyE2EE.syncBrowserVault();
        if (r.skipped) {
          toast(t("sync_not_setup"));
          return false;
        }
        if (r.offline) {
          toast(t("sync_offline"));
          return false;
        }
        toast(t("synced_ok"));
        return true;
      }
      const r = await api("/api/e2ee/sync", { method: "POST" });
      const tot = Object.values(r.merged || {}).reduce((a, b) => a + b, 0);
      toast(t("synced_merged", { n: tot }));
      return true;
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
      return false;
    }
  }

  $("#btn-e2ee-sync").addEventListener("click", async () => {
    if (await runE2EESyncInteractive()) {
      if (state.tab === "today") await loadToday();
      if (state.tab === "setup") await loadSetup();
    }
  });
  $("#btn-e2ee-rotate").addEventListener("click", async () => {
    if (!confirm(t("confirm_rotate_key"))) return;
    try {
      if (isStandaloneBrowserMode()) {
        // Pull latest with old key first, then switch key & push fresh ciphertext (skipPull=true)
        try { await window.DailyE2EE.syncBrowserVault(); } catch {}
        const freshKey = window.DailyE2EE.generateKeyB64u();
        window.DailyE2EE.saveCfg({ key_b64u: freshKey });
        await window.DailyE2EE.syncBrowserVault({ skipPull: true });
        renderE2EEPanel(window.DailyE2EE.loadCfg());
      } else {
        const fresh = await api("/api/e2ee/rotate", { method: "POST" });
        renderE2EEPanel(fresh);
      }
      toast(t("key_rotated"));
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });

  $("#btn-copy-e2ee-pair").addEventListener("click", async () => {
    const url = $("#e2ee-pair-url").value;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast(t("link_copied"));
    } catch {
      $("#e2ee-pair-url").select();
      document.execCommand("copy");
      toast(t("link_copied"));
    }
  });

  // Auto-select read-only pairing links on click for quick copy
  ["#e2ee-pair-url", "#sync-pair-url"].forEach((sel) => {
    const inp = $(sel);
    if (inp) inp.addEventListener("focus", () => inp.select());
  });
  $("#btn-copy-pair").addEventListener("click", async () => {
    const url = $("#sync-pair-url").value;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast(t("link_copied"));
    } catch {
      $("#sync-pair-url").select();
      document.execCommand("copy");
      toast(t("link_copied"));
    }
  });
  $("#btn-save-remote").addEventListener("click", async () => {
    const srv = $("#sync-custom-server").value.trim().replace(/\/+$/, "");
    const tok = $("#sync-custom-token").value.trim();
    if (srv) localStorage.setItem("daily_server_url", srv);
    else localStorage.removeItem("daily_server_url");
    if (tok) localStorage.setItem("daily_sync_token", tok);
    else localStorage.removeItem("daily_sync_token");
    toast(t("server_saved"));
    await flushOfflineQueue(false);
    await loadSetup();
  });
  $("#btn-sync-now").addEventListener("click", async () => {
    if (isStandaloneBrowserMode()) {
      await runE2EESyncInteractive();
      if (state.tab === "today") await loadToday();
      if (state.tab === "setup") await loadSetup();
      return;
    }
    const flushed = await flushOfflineQueue(false);
    let synced = !!flushed;
    try {
      const e2 = await api("/api/e2ee/config");
      if (e2.enabled && e2.key_b64u) {
        await runE2EESyncInteractive();
        synced = true;
      }
    } catch {}
    if (!synced) {
      try {
        await api("/api/sync", { method: "POST", body: JSON.stringify({ device_id: getDeviceId(), mutations: {} }) });
        toast(t("synced_ok"));
      } catch (err) {
        toast(t("err_prefix", { msg: err.message }));
      }
    }
    if (state.tab === "today") await loadToday();
    if (state.tab === "setup") await loadSetup();
  });
  $("#sync-pill").addEventListener("click", async () => {
    await flushOfflineQueue(false);
    if (state.tab === "today") await loadToday();
  });
  let lastAutoSyncAt = 0;
  async function autoBackgroundSync(force = false) {
    const nowMs = Date.now();
    if (!force && nowMs - lastAutoSyncAt < 15000) return;
    if (!navigator.onLine) return;
    lastAutoSyncAt = nowMs;
    try {
      if (isStandaloneBrowserMode()) {
        if (window.DailyE2EE && window.DailyE2EE.loadCfg().enabled) {
          const r = await window.DailyE2EE.syncBrowserVault();
          if (r && r.ok) {
            if (state.tab === "today") await loadToday();
            if (state.tab === "analysis") await loadAnalysis();
          }
        }
      } else {
        const n = await flushOfflineQueue(true);
        const cfg = await api("/api/e2ee/config").catch(() => null);
        let merged = 0;
        if (cfg && cfg.enabled && cfg.key_b64u) {
          const r = await api("/api/e2ee/sync", { method: "POST" }).catch(() => null);
          if (r && r.merged) merged = Object.values(r.merged).reduce((a, b) => a + b, 0);
        }
        if ((n || merged) && state.tab === "today") await loadToday();
      }
    } catch {}
  }

  window.addEventListener("online", async () => {
    updateSyncPill();
    await autoBackgroundSync(true);
  });
  window.addEventListener("offline", updateSyncPill);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) autoBackgroundSync(false);
  });
  $("#habit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#hf-id").value;
    const rawT = $("#hf-target").value.trim();
    const rawB = $("#hf-block-min").value.trim();
    const rawS = ($("#hf-step") ? $("#hf-step").value : "1").trim().replace(",", ".");
    const parsedStep = Number(rawS);
    const payload = {
      name: $("#hf-name").value.trim(),
      kind: $("#hf-kind").value,
      target: rawT !== "" ? Number(rawT) : null,
      target_period: $("#hf-period").value || "day",
      clear_target: rawT === "",
      unit: $("#hf-unit").value.trim() || "x",
      tap_step: Number.isFinite(parsedStep) && parsedStep > 0 ? parsedStep : 1,
      color: $("#hf-color").value,
      block_minutes: rawB !== "" ? Number(rawB) : null,
      clear_block_minutes: rawB === "",
      group_name: ($("#hf-group") ? $("#hf-group").value : "").trim(),
      nudge_enabled: $("#hf-nudge-enabled").checked,
      nudge_lead_min: Number($("#hf-nudge-lead").value || 20),
      nudge_alternatives: $("#hf-nudge-alts").value.trim(),
      reminder_time: $("#hf-rem-time").value.trim(),
      reminder_days: getReminderDaysCSV(),
    };
    try {
      if (id) {
        await api(`/api/habits/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast(t("habit_updated", { name: payload.name }));
      } else {
        delete payload.clear_target;
        delete payload.clear_block_minutes;
        await api("/api/habits", { method: "POST", body: JSON.stringify(payload) });
        toast(t("habit_created", { name: payload.name }));
      }
      rememberHabitColor(payload.color);
      resetHabitForm();
      await loadSetup();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });
  $("#btn-delete-habit").addEventListener("click", () => {
    const id = $("#hf-id").value;
    if (id) openDeleteHabitModal(id);
  });
  $("#btn-close-dh").addEventListener("click", closeDeleteHabitModal);
  $("#delete-habit-modal").addEventListener("click", (e) => {
    if (e.target.id === "delete-habit-modal") closeDeleteHabitModal();
  });
  $("#btn-confirm-merge").addEventListener("click", async () => {
    const srcId = $("#dh-habit-id").value;
    const targetId = $("#dh-target-select").value;
    const tagNotes = $("#dh-tag-notes").checked;
    if (!srcId || !targetId) return;
    try {
      const res = await api(`/api/habits/${encodeURIComponent(srcId)}/merge`, {
        method: "POST",
        body: JSON.stringify({ target_id: targetId, tag_notes: tagNotes }),
      });
      closeDeleteHabitModal();
      resetHabitForm();
      toast(t("habit_merged", { src: res.source_name, dst: res.target_name, n: res.moved_events }));
      await loadSetup();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });
  $("#btn-confirm-archive").addEventListener("click", async () => {
    const id = $("#dh-habit-id").value;
    if (!id) return;
    await api(`/api/habits/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });
    closeDeleteHabitModal();
    resetHabitForm();
    toast(t("habit_archived"));
    await loadSetup();
  });
  $("#btn-confirm-hard-delete").addEventListener("click", async () => {
    const id = $("#dh-habit-id").value;
    if (!id || !confirm(t("confirm_hard_delete"))) return;
    await api(`/api/habits/${encodeURIComponent(id)}`, { method: "DELETE" });
    closeDeleteHabitModal();
    resetHabitForm();
    toast(t("habit_deleted"));
    await loadSetup();
  });

  // Routing & Hypotheses forms (create or edit in place!)
  const graphPanel = $("#routing-graph-panel");
  if (graphPanel) {
    graphPanel.addEventListener("toggle", () => {
      localStorage.setItem("daily_graph_open", graphPanel.open ? "1" : "0");
      if (graphPanel.open) {
        renderRoutingGraph(0.65);
        setTimeout(() => {
          if (routingGraph) routingGraph.fit();
        }, 380);
      }
    });
  }
  const btnGraphHyps = $("#btn-graph-hyps");
  if (btnGraphHyps) {
    btnGraphHyps.addEventListener("click", () => {
      graphShowHyps = !graphShowHyps;
      btnGraphHyps.classList.toggle("active", graphShowHyps);
      if (routingGraph) routingGraph.setOptions({ showHyps: graphShowHyps });
    });
  }
  const btnGraphLinked = $("#btn-graph-linked");
  if (btnGraphLinked) {
    btnGraphLinked.addEventListener("click", () => {
      graphOnlyLinked = !graphOnlyLinked;
      btnGraphLinked.classList.toggle("active", graphOnlyLinked);
      if (routingGraph) routingGraph.setOptions({ onlyConnected: graphOnlyLinked });
    });
  }
  const btnGraphFit = $("#btn-graph-fit");
  if (btnGraphFit) btnGraphFit.addEventListener("click", () => routingGraph && routingGraph.fit());
  const btnGraphReheat = $("#btn-graph-reheat");
  if (btnGraphReheat) btnGraphReheat.addEventListener("click", () => routingGraph && routingGraph.reheat());
  const btnGraphZIn = $("#btn-graph-zoom-in");
  if (btnGraphZIn) btnGraphZIn.addEventListener("click", () => routingGraph && routingGraph.zoomBy(1.22));
  const btnGraphZOut = $("#btn-graph-zoom-out");
  if (btnGraphZOut) btnGraphZOut.addEventListener("click", () => routingGraph && routingGraph.zoomBy(1 / 1.22));

  $("#btn-cancel-rollup").addEventListener("click", resetRollupForm);
  $("#rf-source").addEventListener("change", () => syncRollupExistingMatch({ autofill: true }));
  $("#rf-target").addEventListener("change", () => syncRollupExistingMatch({ autofill: true }));
  $("#btn-cancel-hyp").addEventListener("click", () => {
    resetHypForm();
    $("#hyp-note").value = "";
  });
  $("#rollup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const editId = $("#rf-edit-id").value;
    const source_id = $("#rf-source").value;
    const target_id = $("#rf-target").value;
    const sign = Number($("#rf-sign").value);
    const weight = Math.abs(Number($("#rf-weight").value || 1)) * sign;
    const payload = { source_id, target_id, relation_type: "rollup", weight, context_window: "any" };
    try {
      if (editId) {
        await api(`/api/edges/${editId}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast(t("edge_updated"));
      } else {
        await api("/api/edges", { method: "POST", body: JSON.stringify(payload) });
        toast(t("edge_saved"));
      }
      state.openRouteClusters.add(target_id);
      if (state.routeClustersAllOpen === false) state.routeClustersAllOpen = null;
      resetRollupForm();
      await loadSetup();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });

  // Live-Routing cluster accordion state, expand/collapse-all & quick filter
  const rollupListEl = $("#rollup-list");
  if (rollupListEl) {
    rollupListEl.addEventListener(
      "toggle",
      (e) => {
        const det = e.target;
        if (!det || !det.matches || !det.matches("details.route-cluster")) return;
        const tid = det.dataset.routeTarget;
        if (!tid) return;
        if (state.routeClustersAllOpen === true) {
          rollupListEl.querySelectorAll("details.route-cluster").forEach((d) => {
            if (d.dataset.routeTarget) state.openRouteClusters.add(d.dataset.routeTarget);
          });
        }
        state.routeClustersAllOpen = null;
        if (det.open) state.openRouteClusters.add(tid);
        else state.openRouteClusters.delete(tid);
        const btn = $("#btn-toggle-all-routes");
        if (btn) {
          const allOpen = Array.from(rollupListEl.querySelectorAll("details.route-cluster")).every((d) => d.open);
          btn.textContent = t(allOpen ? "route_collapse_all" : "route_expand_all");
        }
      },
      true
    );
    rollupListEl.addEventListener("input", (e) => {
      if (e.target && e.target.id === "route-filter-input") {
        state.routeFilterQuery = e.target.value || "";
        renderRollupList();
      }
    });
    rollupListEl.addEventListener("click", (e) => {
      if (e.target && e.target.id === "btn-clear-graph-focus") {
        state.graphFocusHabitId = null;
        if (routingGraph) routingGraph.clearSelection();
        renderRollupList();
        return;
      }
      if (e.target && e.target.id === "btn-toggle-all-routes") {
        const allOpen = Array.from(rollupListEl.querySelectorAll("details.route-cluster")).every((d) => d.open);
        state.routeClustersAllOpen = !allOpen;
        if (allOpen) state.openRouteClusters.clear();
        renderRollupList();
      }
    });
  }

  $("#hyp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const editId = $("#hyp-edit-id").value;
    const source_id = $("#hyp-source").value;
    const target_id = $("#hyp-target").value;
    const weight = Number($("#hyp-sign").value);
    const context_window = $("#hyp-window").value;
    const note = $("#hyp-note").value.trim();
    const payload = { source_id, target_id, relation_type: "hypothesis", weight, context_window, note };
    try {
      if (editId) {
        await api(`/api/edges/${editId}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast(t("hyp_updated"));
      } else {
        await api("/api/edges", { method: "POST", body: JSON.stringify(payload) });
        toast(t("hyp_saved"));
      }
      $("#hyp-note").value = "";
      resetHypForm();
      await loadSetup();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });

  const handleEdgeClick = async (e) => {
    const del = e.target.closest("[data-del-edge]");
    if (del) {
      await api(`/api/edges/${del.dataset.delEdge}`, { method: "DELETE" });
      toast(t("edge_removed"));
      await loadSetup();
      return;
    }
    const editRollup = e.target.closest("[data-edit-rollup]");
    if (editRollup) {
      const edge = state.edges.find((x) => String(x.id) === String(editRollup.dataset.editRollup));
      if (edge) populateRollupForm(edge);
      return;
    }
    const editHyp = e.target.closest("[data-edit-hyp]");
    if (editHyp) {
      const edge = state.edges.find((x) => String(x.id) === String(editHyp.dataset.editHyp));
      if (edge) populateHypForm(edge);
      return;
    }
  };
  $("#rollup-list").addEventListener("click", handleEdgeClick);
  $("#hyp-list").addEventListener("click", handleEdgeClick);

  // Decoupled mode switches:
  // 1) Notification trigger mode (only affects nudge pings — never alters Today routing!)
  const nudgeSwitch = $("#nudge-mode-switch");
  if (nudgeSwitch) {
    nudgeSwitch.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-nudge-mode]");
      if (!btn) return;
      const mode = btn.dataset.nudgeMode;
      syncNudgeModeUI(mode);
      try {
        state.settings = await api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ nudge_mode: mode }),
        });
        toast(mode === "tabpfn" ? t("mode_ai_toast") : t("mode_manual_toast"));
      } catch (err) {
        toast(t("err_prefix", { msg: err.message }));
      }
    });
  }
  // 2) Live-Routing mode (only affects Today routing weights — keeps notifications stable!)
  const routingSwitch = $("#routing-mode-switch");
  if (routingSwitch) {
    routingSwitch.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-routing-mode]");
      if (!btn) return;
      const mode = btn.dataset.routingMode;
      syncRoutingModeUI(mode);
      try {
        state.settings = await api("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ routing_mode: mode }),
        });
        toast(mode === "tabpfn" ? t("routing_ai_toast") : t("routing_manual_toast"));
        if (state.tab === "today") await loadToday();
      } catch (err) {
        toast(t("err_prefix", { msg: err.message }));
      }
    });
  }

  // Toggleable 24h Rhythm legend (Ist-Peaks / Prognose morgen — same calm grammar as Befinden legend)
  const rhythmLegend = $("#rhythm-legend");
  if (rhythmLegend) {
    rhythmLegend.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-rline]");
      if (!btn) return;
      if (btn.dataset.rline === "obs") {
        state.showRhythmObs = !state.showRhythmObs;
        localStorage.setItem("daily_rhythm_show_obs", state.showRhythmObs ? "1" : "0");
      } else if (btn.dataset.rline === "ai") {
        state.showRhythmAi = !state.showRhythmAi;
        localStorage.setItem("daily_rhythm_show_ai", state.showRhythmAi ? "1" : "0");
      }
      renderRhythmsPanel();
    });
  }

  // 7-day matrix week-by-week paging
  $("#btn-matrix-prev").addEventListener("click", () => {
    const base = state.matrixEndDay || localDateISO(new Date());
    loadWeekMatrix(shiftDate(base, -7));
  });
  $("#btn-matrix-next").addEventListener("click", () => {
    if (!state.matrixEndDay) return;
    loadWeekMatrix(shiftDate(state.matrixEndDay, +7));
  });
  $("#btn-matrix-now").addEventListener("click", () => loadWeekMatrix(null));

  $("#state-axis-pills").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-scurve]");
    if (!btn) return;
    state.selectedStateCurveId = btn.dataset.scurve;
    renderStateCurveSection(state.lastStateCurves);
  });
  $("#state-tag-pills").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-chart-tag]");
    if (!btn) return;
    const tg = btn.dataset.chartTag;
    state.selectedChartTag = state.selectedChartTag === tg ? null : tg;
    renderStateCurveSection(state.lastStateCurves);
  });
  $("#state-zoom-switch").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-szoom]");
    if (!btn) return;
    state.stateZoom = btn.dataset.szoom;
    localStorage.setItem("daily_state_zoom", state.stateZoom);
    const nowHr = state.lastTimelineMeta && state.lastTimelineMeta.now_hr != null ? Number(state.lastTimelineMeta.now_hr) : 12;
    const p = getPresetChartView(state.stateZoom, nowHr);
    state.chartView = clampChartView(p.startHr, p.endHr);
    renderStateCurveSection(state.lastStateCurves);
  });
  $("#btn-chart-now").addEventListener("click", () => {
    const nowHr = state.lastTimelineMeta && state.lastTimelineMeta.now_hr != null ? Number(state.lastTimelineMeta.now_hr) : 12;
    const span = state.chartView ? state.chartView.endHr - state.chartView.startHr : 14 * 24;
    state.chartView = clampChartView(nowHr - span * 0.78, nowHr + span * 0.22);
    renderStateCurveSection(state.lastStateCurves);
  });
  $("#state-legend").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sline]");
    if (!btn) return;
    if (btn.dataset.sline === "tabpfn") {
      state.showTabpfnLine = !state.showTabpfnLine;
      localStorage.setItem("daily_show_tabpfn", state.showTabpfnLine ? "1" : "0");
    } else if (btn.dataset.sline === "ode") {
      state.showOdeLine = !state.showOdeLine;
      localStorage.setItem("daily_show_ode", state.showOdeLine ? "1" : "0");
    }
    renderStateCurveSection(state.lastStateCurves);
  });

  // Smooth continuous wheel zoom (anchored at cursor X) + horizontal trackpad pan
  const chartHost = $("#state-curve-chart");
  chartHost.addEventListener(
    "wheel",
    (e) => {
      if (!state.lastStateCurves.length || !state.chartView) return;
      e.preventDefault();
      const rect = chartHost.getBoundingClientRect();
      const frac = rect.width > 0 ? Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width)) : 0.5;
      const { startHr, endHr } = state.chartView;
      const span = endHr - startHr;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        const shift = (dx / Math.max(200, rect.width)) * span * 0.85;
        state.chartView = clampChartView(startHr + shift, endHr + shift);
      } else {
        const anchorHr = startHr + frac * span;
        const factor = Math.exp(Math.max(-180, Math.min(180, e.deltaY)) * 0.0018);
        const nextSpan = Math.max(CHART_MIN_SPAN_HR, Math.min(CHART_MAX_SPAN_HR, span * factor));
        state.chartView = clampChartView(anchorHr - frac * nextSpan, anchorHr + (1 - frac) * nextSpan);
      }
      renderStateCurveSection(state.lastStateCurves);
    },
    { passive: false }
  );

  // Smooth click-drag / swipe panning across the continuous timeline
  let chartDrag = null;
  chartHost.addEventListener("click", (e) => {
    const habBtn = e.target.closest("[data-chart-habit]");
    if (!habBtn) return;
    const hid = habBtn.dataset.chartHabit;
    state.selectedChartHabitId = state.selectedChartHabitId === hid ? null : hid;
    renderStateCurveSection(state.lastStateCurves);
  });
  chartHost.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !state.chartView || !state.lastStateCurves.length) return;
    if (e.target.closest("#state-pin-legend, button")) return;
    const wrap = e.target.closest("[data-pan-chart]");
    if (!wrap) return;
    chartDrag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      moved: false,
      origStart: state.chartView.startHr,
      origEnd: state.chartView.endHr,
      width: Math.max(180, wrap.getBoundingClientRect().width),
    };
    wrap.classList.add("is-dragging");
    try { chartHost.setPointerCapture(e.pointerId); } catch {}
  });
  chartHost.addEventListener("pointermove", (e) => {
    if (!chartDrag || e.pointerId !== chartDrag.pointerId) return;
    const dx = e.clientX - chartDrag.startX;
    if (Math.abs(dx) >= 4) chartDrag.moved = true;
    if (!chartDrag.moved) return;
    const span = chartDrag.origEnd - chartDrag.origStart;
    const shiftHr = -(dx / chartDrag.width) * span;
    state.chartView = clampChartView(chartDrag.origStart + shiftHr, chartDrag.origEnd + shiftHr);
    renderStateCurveSection(state.lastStateCurves);
  });
  const endChartDrag = (e) => {
    if (!chartDrag || e.pointerId !== chartDrag.pointerId) return;
    const wasTap = !chartDrag.moved;
    chartDrag = null;
    const wrap = chartHost.querySelector("[data-pan-chart]");
    if (wrap) wrap.classList.remove("is-dragging");
    try { chartHost.releasePointerCapture(e.pointerId); } catch {}
    if (wasTap) updateChartHoverAtClientX(e.clientX);
  };
  chartHost.addEventListener("pointerup", endChartDrag);
  chartHost.addEventListener("pointercancel", endChartDrag);

  // 2-finger pinch zoom on touchscreens
  let pinchState = null;
  chartHost.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2 && state.chartView) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const rect = chartHost.getBoundingClientRect();
      pinchState = {
        dist: Math.max(10, Math.hypot(dx, dy)),
        frac: rect.width > 0 ? Math.max(0.05, Math.min(0.95, (midX - rect.left) / rect.width)) : 0.5,
        origStart: state.chartView.startHr,
        origEnd: state.chartView.endHr,
      };
    }
  }, { passive: true });
  chartHost.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2 && pinchState) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const curDist = Math.max(10, Math.hypot(dx, dy));
      const span = pinchState.origEnd - pinchState.origStart;
      const anchor = pinchState.origStart + pinchState.frac * span;
      const nextSpan = Math.max(CHART_MIN_SPAN_HR, Math.min(CHART_MAX_SPAN_HR, span * (pinchState.dist / curDist)));
      state.chartView = clampChartView(anchor - pinchState.frac * nextSpan, anchor + (1 - pinchState.frac) * nextSpan);
      renderStateCurveSection(state.lastStateCurves);
    }
  }, { passive: false });
  chartHost.addEventListener("touchend", () => { pinchState = null; });

  // Double-click zooms in 2x at clicked position
  chartHost.addEventListener("dblclick", (e) => {
    if (!state.chartView || !state.lastStateCurves.length) return;
    if (e.target.closest("#state-pin-legend, button")) return;
    const rect = chartHost.getBoundingClientRect();
    const frac = rect.width > 0 ? Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width)) : 0.5;
    const span = state.chartView.endHr - state.chartView.startHr;
    const anchor = state.chartView.startHr + frac * span;
    const nextSpan = Math.max(CHART_MIN_SPAN_HR, span * 0.5);
    state.chartView = clampChartView(anchor - frac * nextSpan, anchor + (1 - frac) * nextSpan);
    renderStateCurveSection(state.lastStateCurves);
  });

  // Live hover crosshair + crisp top readout bar (zero layout shift!)
  const interpSeriesAt = (pts, hr) => {
    if (!pts || !pts.length) return null;
    if (hr < pts[0][0] || hr > pts[pts.length - 1][0]) return null;
    let lo = 0, hi = pts.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid][0] <= hr) lo = mid;
      else hi = mid;
    }
    const a = pts[lo], b = pts[hi];
    const dt = b[0] - a[0];
    const f = dt > 1e-6 ? Math.max(0, Math.min(1, (hr - a[0]) / dt)) : 0;
    return {
      v: a[1] + (b[1] - a[1]) * f,
      conf: (a[2] ?? 1) + ((b[2] ?? 1) - (a[2] ?? 1)) * f,
    };
  };
  const clearChartHover = () => {
    const g = state._chartGeom;
    const hoverEl = $("#state-chart-hover");
    const roEl = $("#state-chart-readout");
    if (hoverEl) hoverEl.innerHTML = "";
    if (roEl && g) {
      roEl.innerHTML = `<span>${esc(g.anchorTxt)}</span><span class="mono">${esc(g.rightSummary)}</span>`;
    }
  };
  const updateChartHoverAtClientX = (clientX) => {
    const g = state._chartGeom;
    const svg = chartHost.querySelector(".state-chart-svg");
    if (!g || !svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const svgX = ((clientX - rect.left) / rect.width) * g.W;
    if (svgX < g.padL || svgX > g.W - g.padR) {
      clearChartHover();
      return;
    }
    let hr = g.vStart + ((svgX - g.padL) / g.plotW) * g.span;
    const xOf = (tHr) => g.padL + ((tHr - g.vStart) / g.span) * g.plotW;
    const yOf = (v) => g.padT + ((5 - Math.max(1, Math.min(5, v))) / 4) * g.plotH;

    // Snap softly to a nearby observed snapshot dot (within 14px)
    let snappedDot = null;
    let bestPx = 14;
    for (const pt of g.visActual || []) {
      const dist = Math.abs(xOf(pt.t) - svgX);
      if (dist < bestPx) {
        bestPx = dist;
        snappedDot = pt;
      }
    }
    // Find nearest habit pin / aggregated bar for instant name + amount readout!
    let nearPin = null;
    let bestPinPx = g.pinHitPx || 14;
    for (const pin of g.renderedPins || []) {
      const dist = Math.abs(pin.cx - svgX);
      if (dist < bestPinPx) {
        bestPinPx = dist;
        nearPin = pin;
      }
    }
    if (snappedDot) hr = snappedDot.t;
    const cx = xOf(hr);
    const tl = (g.cur && g.cur.timeline) || {};
    const odePt = state.showOdeLine ? interpSeriesAt(tl.ode, hr) : null;
    const tpPt = state.showTabpfnLine ? interpSeriesAt(tl.tabpfn, hr) : null;

    const ac = g.axisColor || "#368470";
    let markers = `<line x1="${cx.toFixed(1)}" y1="${g.padT}" x2="${cx.toFixed(1)}" y2="${g.padT + g.plotH}" stroke="var(--text-2)" stroke-width="1" opacity="0.32" />`;
    if (nearPin) {
      const hw = Math.max(4, (nearPin.barW || 4) + 3);
      const hh = (nearPin.barH || 12) + 3;
      const yTopPin = g.padT + g.plotH - hh;
      markers += `<rect x="${(nearPin.cx - hw / 2).toFixed(1)}" y="${yTopPin.toFixed(1)}" width="${hw.toFixed(1)}" height="${hh.toFixed(1)}" rx="2.5" fill="none" stroke="var(--text)" stroke-width="1.2" opacity="0.55" />`;
    }
    if (odePt) {
      markers += `<circle cx="${cx.toFixed(1)}" cy="${yOf(odePt.v).toFixed(1)}" r="4" fill="${esc(ac)}" stroke="var(--surface)" stroke-width="1.8" />`;
    }
    if (tpPt) {
      markers += `<circle cx="${cx.toFixed(1)}" cy="${yOf(tpPt.v).toFixed(1)}" r="3.8" fill="color-mix(in srgb, var(--text) 62%, transparent)" stroke="var(--surface)" stroke-width="1.8" />`;
    }
    if (snappedDot) {
      markers += `<circle cx="${cx.toFixed(1)}" cy="${yOf(snappedDot.v).toFixed(1)}" r="7.5" fill="none" stroke="${esc(ac)}" stroke-width="1.6" opacity="0.6" />`;
    }
    const hoverEl = $("#state-chart-hover");
    if (hoverEl) hoverEl.innerHTML = markers;

    const dt = new Date(g.originMs + hr * 3600000);
    const p2 = (n) => String(n).padStart(2, "0");
    const tsStr = `${dt.toLocaleDateString(getLocale(), { weekday: "short", day: "2-digit", month: "2-digit" })} ${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
    const isFut = hr > g.nowHr + 0.1;
    const pills = [`<span class="ro-pill"><strong>${esc(tsStr)}</strong></span>`];
    if (snappedDot) {
      pills.push(`<span class="ro-pill"><span class="dot-obs" style="background:${esc(ac)}"></span>${fmtNum(snappedDot.v)}/5${snappedDot.note ? ` <span class="muted">${esc(snappedDot.note.slice(0, 32))}</span>` : ""}</span>`);
    }
    if (odePt) {
      const cTxt = isFut ? ` <span class="muted">(${Math.round(odePt.conf * 100)}%)</span>` : "";
      pills.push(`<span class="ro-pill"><span class="line-ode" style="border-top-color:${esc(ac)}"></span>ODE ${fmtNum(odePt.v)}${cTxt}</span>`);
    }
    if (tpPt) {
      const cTxt = isFut ? ` <span class="muted">(${Math.round(tpPt.conf * 100)}%)</span>` : "";
      pills.push(`<span class="ro-pill"><span class="line-ai"></span>TabPFN ${fmtNum(tpPt.v)}${cTxt}</span>`);
    }
    if (nearPin && nearPin.items && nearPin.items.length) {
      const topPinItems = nearPin.items.slice(0, 3);
      topPinItems.forEach((it) => {
        pills.push(`<span class="ro-pill ro-pin"><span class="chip-dot" style="background:${esc(it.color)}"></span>${esc(it.habit_name)} +${fmtNum(it.amount)}</span>`);
      });
      if (nearPin.items.length > 3) {
        pills.push(`<span class="ro-pill muted">+${nearPin.items.length - 3}</span>`);
      }
    }
    const roEl = $("#state-chart-readout");
    if (roEl) roEl.innerHTML = `<span class="ro-live">${pills.join("")}</span>`;
  };
  chartHost.addEventListener("pointermove", (e) => {
    if (chartDrag && chartDrag.moved) return;
    if (e.target.closest("#state-pin-legend")) return;
    updateChartHoverAtClientX(e.clientX);
  });
  chartHost.addEventListener("pointerleave", clearChartHover);

  // Re-render crisp 1:1 SVG dimensions on window resize
  let chartResizeTimer = null;
  window.addEventListener("resize", () => {
    if (state.tab !== "analysis" || !state.lastStateCurves.length) return;
    clearTimeout(chartResizeTimer);
    chartResizeTimer = setTimeout(() => renderStateCurveSection(state.lastStateCurves), 80);
  });

  $("#ai-assumptions-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-adopt-ai]");
    if (!btn) return;
    try {
      await api("/api/edges", {
        method: "POST",
        body: JSON.stringify({
          source_id: btn.dataset.src,
          target_id: btn.dataset.dst,
          relation_type: "hypothesis",
          weight: Number(btn.dataset.dir),
          context_window: btn.dataset.win,
          note: `${t("ai_assump_badge")} (Δ ${btn.dataset.delta})`,
        }),
      });
      toast(t("ai_adopted_toast"));
      await loadAnalysis();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });

  // Browser / iOS Home-Screen PWA Web Notifications helper (uses Service Worker showNotification on iOS/Android!)
  async function sendBrowserNotification(title, body, opts = {}) {
    if (typeof Notification === "undefined") {
      const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
      return { ok: false, reason: isIOS ? "ios_homescreen" : "unsupported" };
    }
    let perm = Notification.permission;
    if (perm === "default" && opts.requestPermission) {
      try {
        perm = await Notification.requestPermission();
      } catch {
        return { ok: false, reason: "denied" };
      }
    }
    if (perm !== "granted") {
      return { ok: false, reason: "denied" };
    }
    const nOpts = {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: opts.tag || "daily-nudge",
    };
    if ("serviceWorker" in navigator) {
      try {
        const reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((_, rej) => setTimeout(() => rej(new Error("sw-timeout")), 2500)),
        ]);
        if (reg && typeof reg.showNotification === "function") {
          await reg.showNotification(title, nOpts);
          return { ok: true };
        }
      } catch {}
    }
    try {
      new Notification(title, nOpts);
      return { ok: true };
    } catch {
      return { ok: false, reason: "unsupported" };
    }
  }

  function evaluateBrowserNudges() {
    if (!isStandaloneBrowserMode() || !window.DailyLocalEngine) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const db = window.DailyLocalEngine.getRawDB();
      const s = db.settings || {};
      if (s.notifications_enabled !== "1") return;
      const now = new Date();
      const hr = now.getHours();
      const qStart = Number(s.quiet_hours_start ?? 23);
      const qEnd = Number(s.quiet_hours_end ?? 8);
      const inQuiet = qStart === qEnd ? false : qStart > qEnd ? hr >= qStart || hr < qEnd : hr >= qStart && hr < qEnd;
      if (inQuiet) return;

      const todayIso = localDateISO(now);
      const nowMin = hr * 60 + now.getMinutes();
      const todayWd = (now.getDay() + 6) % 7; // Mon=0..Sun=6
      const firedKey = "daily_fired_nudges_v1";
      let fired = {};
      try { fired = JSON.parse(localStorage.getItem(firedKey) || "{}"); } catch { fired = {}; }
      // Prune previous days
      for (const k of Object.keys(fired)) {
        if (!k.includes(todayIso)) delete fired[k];
      }
      const markAndPing = (key, title, body) => {
        if (fired[key]) return;
        fired[key] = Date.now();
        localStorage.setItem(firedKey, JSON.stringify(fired));
        sendBrowserNotification(title, body, { tag: key });
      };

      const todaySummary = window.DailyLocalEngine.request(`/api/today?day=${todayIso}`, { method: "GET" });
      const cardsById = Object.fromEntries((todaySummary.habits || []).map((c) => [c.id, c]));
      const followupOn = s.followup_enabled !== "0";

      // 1. Fixed anchor reminders + quiet +45m follow-up
      for (const h of todaySummary.habits || []) {
        if (h.kind === "min" && h.status === "met") continue;
        const rTimes = String(h.reminder_time || "").split(",").map((x) => x.trim()).filter(Boolean);
        if (!rTimes.length) continue;
        const days = new Set(String(h.reminder_days || "0,1,2,3,4,5,6").split(",").map((x) => x.trim()).filter(Boolean));
        if (days.size && !days.has(String(todayWd))) continue;
        for (const ts of rTimes) {
          const m = ts.match(/^(\d{1,2}):(\d{2})$/);
          if (!m) continue;
          const anchorMin = Number(m[1]) * 60 + Number(m[2]);
          if (Math.abs(nowMin - anchorMin) <= 1) {
            markAndPing(
              `anchor:${todayIso}:${h.id}:${ts}`,
              `Daily · ${h.name} (${ts})`,
              h.nudge_alternatives ? `Optionen: ${h.nudge_alternatives}` : `Kurzer Impuls für ${h.name}`
            );
          }
          const fuMin = anchorMin + 45;
          const card = cardsById[h.id] || {};
          if (followupOn && fuMin < 1440 && Math.abs(nowMin - fuMin) <= 1 && Number(card.direct || 0) <= 0 && Number(card.effective || 0) <= 0) {
            markAndPing(
              `followup:${todayIso}:${h.id}:${ts}`,
              `Daily · Kurzer Check: ${h.name}?`,
              `Hast du um ${ts} „${h.name}“ gemacht? Kurz abhaken.`
            );
          }
        }
      }

      // 2. Idle check-in reminder (after checkin_interval_hours since last event)
      const intervalH = Math.max(1, Number(s.checkin_interval_hours || 3));
      const liveEvs = (db.events || []).filter((ev) => !ev.deleted_at);
      if (liveEvs.length) {
        const lastIso = liveEvs.reduce((acc, ev) => (ev.occurred_at > acc ? ev.occurred_at : acc), "");
        const lastMs = lastIso ? new Date(lastIso).getTime() : 0;
        if (lastMs && now.getTime() - lastMs >= intervalH * 3600 * 1000) {
          const slot = Math.floor(hr / intervalH);
          markAndPing(
            `idle:${todayIso}:${slot}`,
            `Daily Check-in · letzte ${intervalH}h`,
            `Was ging die letzten ${intervalH} Stunden? Kurz in 10 Sek. nachtragen.`
          );
        }
      }
    } catch {}
  }

  // Settings & Test-Ping (Setup)
  $("#btn-save-settings").addEventListener("click", async () => {
    const enabled = $("#set-notif").checked;
    state.settings = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({
        checkin_interval_hours: Number($("#set-interval").value || 3),
        quiet_hours_start: Number($("#set-qstart").value || 23),
        quiet_hours_end: Number($("#set-qend").value || 8),
        notifications_enabled: enabled ? 1 : 0,
        followup_enabled: $("#set-followup").checked ? 1 : 0,
      }),
    });
    if (enabled && isStandaloneBrowserMode() && typeof Notification !== "undefined" && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch {}
    }
    toast(t("settings_saved"));
  });
  $("#btn-test-nudge").addEventListener("click", async () => {
    const mode = state.settings.nudge_mode || "observed";
    const lbl = mode === "tabpfn" ? t("notif_ai") : t("notif_obs");
    if (!isStandaloneBrowserMode()) {
      const res = await api("/api/nudge/test", { method: "POST" });
      if (res.sent) {
        toast(t("ping_sent", { lbl }));
        return;
      }
    }
    const r = await sendBrowserNotification(`Daily · Test-Impuls (${lbl})`, t("ping_body"), {
      requestPermission: true,
      tag: `daily-test-${Date.now()}`,
    });
    if (r.ok) {
      toast(t("ping_sent", { lbl }));
    } else if (r.reason === "ios_homescreen") {
      toast(t("ping_ios_homescreen"), { durationMs: 6500 });
    } else if (r.reason === "denied") {
      toast(t("ping_denied"), { durationMs: 6500 });
    } else {
      toast(t("ping_unavail"), { durationMs: 5000 });
    }
  });

  setInterval(refreshActiveSessionBadges, 30 * 1000);
  if (isStandaloneBrowserMode()) {
    setInterval(evaluateBrowserNudges, 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        refreshActiveSessionBadges();
        evaluateBrowserNudges();
      }
    });
  }

  // Instant DE / EN language toggle (re-renders active view immediately without page reload)
  $("#btn-lang").addEventListener("click", async () => {
    if (!window.DailyI18n) return;
    window.DailyI18n.toggleLang();
    if (state.tab === "today") {
      $("#day-title-label").textContent = formatDayHeadline(state.day);
      if (state.todayData) renderToday(state.todayData);
    } else if (state.tab === "setup") {
      await loadSetup();
    } else if (state.tab === "analysis") {
      await loadAnalysis();
    }
  });

  // Global keyboard shortcuts (1/2/3 tabs, R retro check-in, M Momentaufnahme, ESC close modals)
  window.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select";
    if (e.key === "Escape") {
      if (state.editingDimId) {
        state.editingDimId = null;
        renderMoodModal();
        return;
      }
      closeRetroModal();
      closeCustomLog();
      closeEditEventModal();
      closeMoodModal();
      closeDeleteHabitModal();
      $("#legal-modal").classList.add("hidden");
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "1") setTab("today");
    if (e.key === "2") setTab("setup");
    if (e.key === "3") setTab("analysis");
    if (e.key.toLowerCase() === "r") {
      e.preventDefault();
      openRetroModal();
    }
    if (e.key.toLowerCase() === "m") {
      e.preventDefault();
      openMoodModal();
    }
  });
}

capturePairingParams();
const pairedE2EE = window.DailyE2EE ? window.DailyE2EE.captureHashPairing() : null;
if (window.DailyI18n) window.DailyI18n.applyDom();
initTheme();
bindEvents();
updateSyncPill();
if ("serviceWorker" in navigator && (window.location.protocol === "http:" || window.location.protocol === "https:")) {
  const hadController = !!navigator.serviceWorker.controller;
  let _swReloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || _swReloaded) return;
    _swReloaded = true;
    window.location.reload();
  });
  navigator.serviceWorker
    .register("/sw.js")
    .then((reg) => {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    })
    .catch(() => {});
}
async function applyPairedE2EE(cfg) {
  if (!cfg) return;
  try {
    if (isStandaloneBrowserMode()) {
      await window.DailyE2EE.syncBrowserVault();
    } else {
      await api("/api/e2ee/config", { method: "PATCH", body: JSON.stringify(cfg) });
      await api("/api/e2ee/sync", { method: "POST" });
    }
    toast(t("paired_ok"));
  } catch (err) {
    toast(t("err_prefix", { msg: err.message || String(err) }), { durationMs: 7000 });
    const statusEl = $("#e2ee-status-line");
    if (statusEl) statusEl.innerHTML = `<strong class="neg">${esc(t("err_prefix", { msg: err.message || String(err) }))}</strong>`;
  }
}

window.addEventListener("hashchange", async () => {
  const nextPaired = window.DailyE2EE ? window.DailyE2EE.captureHashPairing() : null;
  if (!nextPaired) return;
  await applyPairedE2EE(nextPaired);
  if (state.tab === "today") await loadToday();
  else if (state.tab === "setup") await loadSetup();
  else if (state.tab === "analysis") await loadAnalysis();
});

(async () => {
  if (pairedE2EE) {
    await applyPairedE2EE(pairedE2EE);
  } else if (isStandaloneBrowserMode() && window.DailyE2EE && window.DailyE2EE.loadCfg().enabled) {
    window.DailyE2EE.syncBrowserVault()
      .then(() => {
        if (state.tab === "today") loadToday();
        else if (state.tab === "setup") loadSetup();
      })
      .catch((err) => {
        if (navigator.onLine) toast(t("err_prefix", { msg: err.message || String(err) }), { durationMs: 6000 });
      });
  }
  loadToday();
})();

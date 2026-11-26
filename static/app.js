/* Daily v0.1 — Sharp, keyboard-first frontend (zero presets, signed +/- graph, TabPFN + Liquid ODE, DE/EN) */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const t = (key, vars) => (window.DailyI18n ? window.DailyI18n.t(key, vars) : key);
const getLocale = () => (window.DailyI18n ? window.DailyI18n.getLocale() : "de-DE");
const dimName = (d) => (window.DailyI18n ? window.DailyI18n.dimName(d) : d ? d.name : "");
const dimLow = (d) => (window.DailyI18n ? window.DailyI18n.dimLow(d) : d ? d.low_label || "" : "");
const dimHigh = (d) => (window.DailyI18n ? window.DailyI18n.dimHigh(d) : d ? d.high_label || "" : "");
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
  filterKind: "all",
  filterQuery: "",
  sortMode: localStorage.getItem("daily_sort_mode") || "manual",
  toggledFocus: [],
  selectedStateCurveId: null,
  lastStateCurves: [],
  stateZoom: localStorage.getItem("daily_state_zoom") || "d14",
  showTabpfnLine: localStorage.getItem("daily_show_tabpfn") !== "0",
  showOdeLine: localStorage.getItem("daily_show_ode") !== "0",
  retroWindowMin: 180,
  retroAmounts: {},
  moodRatings: {},
  moodCauses: new Set(),
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

function shiftDate(iso, deltaDays) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + deltaDays);
  return localDateISO(dt);
}

function fmtNum(v) {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
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
    localStorage.setItem(`daily_today_cache_${state.day}`, JSON.stringify(data));
    syncNudgeModeUI(data.routing_mode || state.settings.nudge_mode || "observed");
    renderToday(data);
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
    if (e.target_id === focusId && !seen.has(e.source_id)) {
      seen.add(e.source_id);
      out.push({ id: e.source_id, weight: Number(e.weight), dir: "in", isAi: !!e.is_ai });
    } else if (e.source_id === focusId && !seen.has(e.target_id)) {
      seen.add(e.target_id);
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
          return `<span class="chip ${cls}">${pfx}${c.delta >= 0 ? "+" : ""}${fmtNum(c.delta)} ${esc(c.from_name)}</span>`;
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
      return `<span class="chip ${cls}" ${tip}>→ ${pfx}${r.weight >= 0 ? "+" : ""}${fmtNum(r.weight)} ${esc(r.target_name)}</span>`;
    })
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
      <div class="row-inline" style="gap:4px;">${activePillHtml}${relTag}<span class="badge ${esc(kindBadgeClass(h))}">${esc(kindBadgeText(h))}</span></div>
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
    ${contribHtml || routesHtml ? `<div class="hc-routes">${contribHtml}${routesHtml}</div>` : ""}
    <div class="hc-actions">
      ${sessionBtnHtml}
      <button class="btn sm btn-tap" data-act="tap" data-id="${esc(h.id)}">+1</button>
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

function renderToday(data) {
  updateBrandMark(data);
  const grid = $("#habit-grid");
  const clustersBox = $("#focus-clusters");
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

  const q = state.filterQuery.trim().toLowerCase();
  const visible = data.habits.filter((h) => {
    if (state.filterKind !== "all" && h.kind !== state.filterKind) return false;
    if (q && !h.name.toLowerCase().includes(q)) return false;
    return true;
  });

  if (state.sortMode === "recent") {
    visible.sort((a, b) => {
      const aCore = a.kind !== "neutral" ? 0 : 1;
      const bCore = b.kind !== "neutral" ? 0 : 1;
      if (aCore !== bCore) return aCore - bCore;
      if (aCore === 0) return (a.sort_order ?? 0) - (b.sort_order ?? 0);
      const aTs = a.last_used_at || "";
      const bTs = b.last_used_at || "";
      if (aTs !== bTs) return bTs.localeCompare(aTs);
      return (a.sort_order ?? 0) - (b.sort_order ?? 0);
    });
  }

  if (!data.habits.length) {
    empty.classList.remove("hidden");
    clustersBox.classList.add("hidden");
    clustersBox.innerHTML = "";
    grid.innerHTML = "";
  } else {
    empty.classList.add("hidden");

    // 1. Render any toggled focus clusters (each anchor on top + its connected cards directly underneath!)
    const shownInClusters = new Set();
    if (state.toggledFocus.length) {
      clustersBox.classList.remove("hidden");
      clustersBox.innerHTML = state.toggledFocus
        .map((anchorId) => {
          const anchor = byId[anchorId];
          if (!anchor) return "";
          shownInClusters.add(anchorId);
          const rels = getConnectedNeighbors(anchorId).filter((r) => !!byId[r.id]);
          rels.forEach((r) => shownInClusters.add(r.id));
          const childrenHtml = rels.length
            ? rels
                .map((r) => {
                  const child = byId[r.id];
                  const cls = r.isAi ? "ai-chip" : r.weight >= 0 ? "pos-chip" : "neg-chip";
                  const arrowTxt =
                    r.dir === "in"
                      ? `${r.weight >= 0 ? "+" : ""}${fmtNum(r.weight)} → ${anchor.name}`
                      : `${anchor.name} → ${r.weight >= 0 ? "+" : ""}${fmtNum(r.weight)}`;
                  const badge = `<span class="chip ${cls}">${r.isAi ? `${t("mode_ai")} ` : ""}${esc(arrowTxt)}</span>`;
                  return renderHabitCardHtml(child, { relBadge: badge });
                })
                .join("")
            : `<div class="muted sm-text">${esc(t("no_connected"))}</div>`;

          return `
          <div class="focus-cluster">
            <div class="focus-anchor-wrap">${renderHabitCardHtml(anchor, { asAnchor: true })}</div>
            <div class="focus-children">
              <div class="focus-children-head">
                <span>${esc(t("connected_with", { name: anchor.name, n: rels.length }))}</span>
              </div>
              <div class="focus-children-grid">${childrenHtml}</div>
            </div>
          </div>`;
        })
        .join("");
    } else {
      clustersBox.classList.add("hidden");
      clustersBox.innerHTML = "";
    }

    // 2. Render remaining habits in regular grid
    const rest = state.toggledFocus.length
      ? visible.filter((h) => !shownInClusters.has(h.id))
      : visible;

    if (!visible.length) {
      grid.innerHTML = `<div class="muted sm-text" style="padding:12px 2px;">${esc(t("no_filter_match"))}</div>`;
    } else {
      grid.innerHTML = rest.map((h) => renderHabitCardHtml(h)).join("");
    }
  }

  // Day log (events + Momentaufnahmen interleaved chronologically!)
  const snaps = data.snapshots || [];
  const dimsById = {};
  (data.state_dimensions || state.stateDims || []).forEach((d) => { dimsById[d.id] = d; });
  const habitsById = {};
  (data.habits || []).forEach((h) => { habitsById[h.id] = h; });

  const timeline = [
    ...data.events.map((ev) => ({ kind: "event", at: ev.occurred_at, item: ev })),
    ...snaps.map((sn) => ({ kind: "snap", at: sn.occurred_at, item: sn })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  $("#log-count").textContent = `(${timeline.length})`;
  const evList = $("#event-list");
  if (!timeline.length) {
    evList.innerHTML = `<div class="muted sm-text">${esc(t("no_events_for_day", { day: data.day }))}</div>`;
  } else {
    evList.innerHTML = timeline
      .map((entry) => {
        if (entry.kind === "snap") {
          const sn = entry.item;
          const hhmm = sn.occurred_at.slice(11, 16);
          const ratingChips = Object.entries(sn.ratings || {})
            .map(([did, val]) => {
              const dname = dimsById[did] ? dimName(dimsById[did]) : dimName({ id: did, name: did });
              return `<span class="chip ai-chip">${esc(dname)} ${fmtNum(val)}/5</span>`;
            })
            .join("");
          const causeTxt = (sn.causes || [])
            .map((cid) => (habitsById[cid] ? habitsById[cid].name : cid))
            .join(", ");
          const causeChip = causeTxt ? `<span class="chip">← ${esc(causeTxt)}</span>` : "";
          return `
          <div class="ev-row snap-row">
            <span class="ev-dot" style="background:#7c3aed"></span>
            <span class="mono muted sm-text">${hhmm}</span>
            <strong>${esc(t("btn_mood"))}</strong>
            <div class="row-inline" style="gap:4px;">${ratingChips}${causeChip}</div>
            <span class="muted sm-text" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${renderNoteWithTags(sn.note || "")}</span>
            <button class="btn ghost sm" data-snap-del="${sn.id}" title="${esc(t("del_title"))}">✕</button>
          </div>`;
        }
        const ev = entry.item;
        const hhmm = ev.occurred_at.slice(11, 16);
        const srcTag = ev.source === "retro" ? `retro ${Math.round((ev.window_minutes / 60) * 10) / 10}h` : ev.source;
        const hasNote = !!(ev.note && ev.note.trim());
        return `
        <div class="ev-row">
          <span class="ev-dot" style="background:${esc(ev.habit_color)}"></span>
          <span class="ev-time" data-ev-time="${ev.id}" data-cur="${esc(ev.occurred_at)}" title="${esc(t("edit_time_title"))}">${hhmm}</span>
          <strong>${esc(ev.habit_name)}</strong>
          <span class="ev-amt ${ev.amount >= 0 ? "pos" : "neg"}" data-ev-amt="${ev.id}" data-cur-amt="${ev.amount}" title="${esc(t("edit_amt_title"))}">${ev.amount >= 0 ? "+" : ""}${fmtNum(ev.amount)}</span>
          <span class="chip">${esc(srcTag)}</span>
          <span class="ev-note ${hasNote ? "" : "empty-note"}" data-ev-note="${ev.id}" data-cur-note="${esc(ev.note || "")}" title="${esc(t("edit_note_title"))}">${hasNote ? renderNoteWithTags(ev.note) : esc(t("add_note_ph"))}</span>
          <button class="btn ghost sm" data-ev-del="${ev.id}" title="${esc(t("del_title"))}">✕</button>
        </div>`;
      })
      .join("");
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
      toast(
        t("session_stopped_logged", {
          amt: fmtNum(res.amount),
          name: h.name,
          dur: formatDurationMin(res.elapsed_minutes),
        }),
        { undoEventId: res.event.id }
      );
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
  try {
    const created = await api("/api/events", {
      method: "POST",
      body: JSON.stringify({ habit_id: habitId, amount: 1, occurred_at, source: "tap", client_uuid }),
    });
    toast(`+1 ${h ? h.name : ""}`, { undoEventId: created.id });
    await loadToday();
  } catch (e) {
    // Offline fallback: queue event idempotently via client_uuid and update cached UI immediately
    const q = loadOfflineQueue();
    q.push({ habit_id: habitId, amount: 1, occurred_at, source: "tap", client_uuid, note: "" });
    saveOfflineQueue(q);
    if (state.todayData && h) {
      h.direct = Math.round((Number(h.direct || 0) + 1) * 100) / 100;
      h.effective = Math.round((Number(h.effective || 0) + 1) * 100) / 100;
      h.period_effective = Math.round((Number(h.period_effective ?? h.effective ?? 0) + 1) * 100) / 100;
      h.event_count = (h.event_count || 0) + 1;
      localStorage.setItem(`daily_today_cache_${state.day}`, JSON.stringify(state.todayData));
      renderToday(state.todayData);
    }
    toast(t("offline_tap", { name: h ? h.name : "" }));
  }
}

// ---- CUSTOM LOG MODAL ----
function openCustomLog(habitId) {
  const h = state.habits.find((x) => x.id === habitId);
  if (!h) return;
  $("#cl-habit-id").value = habitId;
  $("#cl-title").textContent = t("cl_title_habit", { name: h.name });
  $("#cl-amount").value = "1";
  $("#cl-time").value = localTimeHHMM(new Date());
  $("#cl-note").value = "";
  $("#custom-log-modal").classList.remove("hidden");
  $("#cl-amount").focus();
}

function closeCustomLog() {
  $("#custom-log-modal").classList.add("hidden");
}

// ---- RETRO CHECK-IN MODAL ----
async function openRetroModal() {
  if (!state.habits.length) {
    const resp = await api("/api/habits");
    state.habits = resp.habits;
  }
  state.retroAmounts = {};
  $("#retro-end-time").value = localTimeHHMM(new Date());
  $("#retro-note").value = "";
  $("#retro-new-habit").value = "";
  renderRetroRows();
  $("#retro-modal").classList.remove("hidden");
}

function closeRetroModal() {
  $("#retro-modal").classList.add("hidden");
}

// ---- MOMENTAUFNAHME (BEFINDEN) MODAL ----
async function openMoodModal() {
  try {
    const [dimResp, habResp] = await Promise.all([
      api("/api/state/dimensions?include_archived=true"),
      state.habits.length ? Promise.resolve({ habits: state.habits }) : api("/api/habits"),
    ]);
    const allDims = dimResp.dimensions || [];
    state.stateDims = allDims.filter((d) => !d.archived);
    state.archivedDims = allDims.filter((d) => !!d.archived);
    if (!state.habits.length && habResp.habits) state.habits = habResp.habits;
  } catch {
    // Keep cached dimensions if offline
    if (!state.stateDims.length) {
      state.stateDims = [
        { id: "stimmung", name: "Stimmung", low_label: "melancholisch", high_label: "leicht / gut" },
        { id: "mental-fit", name: "Mental fit", low_label: "leer / neblig", high_label: "wach / klar" },
        { id: "stress", name: "Stress", low_label: "entspannt", high_label: "unter Druck" },
        { id: "anspannung", name: "Anspannung", low_label: "locker", high_label: "angespannt" },
        { id: "antrieb", name: "Antrieb / Offenheit", low_label: "blockiert", high_label: "offen / bereit" },
      ];
    }
  }
  state.moodRatings = {};
  state.moodCauses = new Set();
  $("#mood-time").value = localTimeHHMM(new Date());
  $("#mood-note").value = "";
  renderMoodModal();
  $("#mood-modal").classList.remove("hidden");
}

function closeMoodModal() {
  $("#mood-modal").classList.add("hidden");
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

function renderMoodModal() {
  const list = $("#mood-axes-list");
  list.innerHTML = state.stateDims
    .map((d) => {
      const cur = state.moodRatings[d.id];
      const btns = [1, 2, 3, 4, 5]
        .map(
          (v) =>
            `<button type="button" class="mood-btn ${cur === v ? "selected" : ""}" data-mdim="${esc(d.id)}" data-mval="${v}">${v}</button>`
        )
        .join("");
      const lo = dimLow(d);
      const hi = dimHigh(d);
      const anchors =
        lo || hi
          ? `<div class="mood-anchors"><span>${esc(lo)}</span><span>${esc(hi)}</span></div>`
          : "";
      return `
      <div class="mood-axis">
        <div class="mood-axis-head">
          <strong>${esc(dimName(d))}</strong>
          <button type="button" class="btn ghost sm" data-hide-dim="${esc(d.id)}" title="${esc(t("mood_hide_title"))}" style="padding:1px 6px;font-size:11px;">✕</button>
        </div>
        <div class="mood-scale">${btns}</div>
        ${anchors}
      </div>`;
    })
    .join("");

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

  if (cfg.enabled && cfg.key_b64u) {
    const ts = cfg.last_sync_at ? ` · ${t("sync_last", { ts: cfg.last_sync_at.slice(0, 16).replace("T", " ") })}` : "";
    const provLbl = prov === "gist" ? t("sync_prov_gist_short") : t("sync_prov_url_short");
    const gistTag = prov === "gist" && cfg.gist_id ? ` ${cfg.gist_id.slice(0, 6)}…` : "";
    const keyTag = ` · Key ${cfg.key_b64u.slice(0, 6)}…`;
    $("#e2ee-status-line").innerHTML = `<strong class="pos">${esc(t("sync_status_active"))}</strong> · ${esc(provLbl)}<span class="mono">${esc(gistTag)}${esc(keyTag)}</span>${esc(ts)}`;
  }
}

function renderSetup(pairInfo = null, e2eeInfo = null) {
  $("#setup-habit-count").textContent = `(${state.habits.length})`;
  const rollups = state.edges.filter((e) => e.relation_type === "rollup");
  const outMap = {};
  for (const e of rollups) {
    (outMap[e.source_id] ||= []).push(e);
  }

  const list = $("#setup-habit-list");
  if (!state.habits.length) {
    list.innerHTML = `<div class="muted sm-text">${esc(t("no_habits_yet"))}</div>`;
  } else {
    list.innerHTML = state.habits
      .map((h, idx) => {
        const outs = (outMap[h.id] || [])
          .map(
            (r) =>
              `<span class="chip ${r.weight >= 0 ? "pos-chip" : "neg-chip"}">→ ${r.weight >= 0 ? "+" : ""}${fmtNum(r.weight)} ${esc(r.target_name)}</span>`
          )
          .join("");
        return `
        <div class="list-row">
          <div class="row-inline" style="flex:1;min-width:0;">
            <span class="ev-dot" style="background:${esc(h.color)}"></span>
            <strong>${esc(h.name)}</strong>
            <span class="badge ${esc(kindBadgeClass(h))}">${esc(kindBadgeText(h))}</span>
            ${outs}
            ${h.block_minutes ? `<span class="chip">⏱ ${h.block_minutes}m=1</span>` : ""}
            ${h.nudge_enabled ? `<span class="chip">Ping −${h.nudge_lead_min}m</span>` : ""}
            ${formatAnchorBadge(h)}
          </div>
          <div class="row-inline">
            <span class="order-btns">
              <button type="button" class="btn ghost sm" data-move-idx="${idx}" data-move-dir="-1" title="${esc(t("move_up"))}" ${idx === 0 ? "disabled" : ""}>↑</button>
              <button type="button" class="btn ghost sm" data-move-idx="${idx}" data-move-dir="1" title="${esc(t("move_down"))}" ${idx === state.habits.length - 1 ? "disabled" : ""}>↓</button>
            </span>
            <button type="button" class="btn ghost sm" data-archive-id="${esc(h.id)}" title="${esc(t("archive_title"))}">✓</button>
            <button type="button" class="btn ghost sm" data-setup-edit="${esc(h.id)}">${esc(t("btn_edit"))}</button>
          </div>
        </div>`;
      })
      .join("");
  }

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
  if (pairInfo && pairInfo.standalone) {
    $("#sync-qr-box").classList.add("hidden");
    $("#sync-pair-row").classList.add("hidden");
    $("#sync-hint-text").innerHTML = t("lan_standalone_html");
  } else if (pairInfo) {
    $("#sync-qr-box").classList.remove("hidden");
    $("#sync-pair-row").classList.remove("hidden");
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

  // Render rollup edges
  $("#rollup-list").innerHTML = rollups.length
    ? rollups
        .map(
          (e) => `
      <div class="list-row">
        <div class="row-inline">
          <strong>${esc(e.source_name)}</strong>
          <span class="chip ${e.weight >= 0 ? "pos-chip" : "neg-chip"}">${e.weight >= 0 ? "+" : ""}${fmtNum(e.weight)}</span>
          <span class="arrow">→</span>
          <strong>${esc(e.target_name)}</strong>
        </div>
        <div class="row-inline">
          <button class="btn ghost sm" data-flip-edge="${e.id}" data-src="${esc(e.source_id)}" data-dst="${esc(e.target_id)}" data-w="${-e.weight}" data-rt="rollup" data-win="any" title="${esc(t("flip_sign_title"))}">±</button>
          <button class="btn ghost sm" data-del-edge="${e.id}">✕</button>
        </div>
      </div>`
        )
        .join("")
    : `<div class="muted sm-text">${esc(t("no_rollups"))}</div>`;

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
        <button class="btn ghost sm" data-del-edge="${e.id}">✕</button>
      </div>`
        )
        .join("")
    : `<div class="muted sm-text">${esc(t("no_hyps"))}</div>`;
}

function resetHabitForm() {
  $("#habit-form-title").textContent = t("hf_title_new");
  $("#hf-id").value = "";
  $("#hf-name").value = "";
  $("#hf-kind").value = "neutral";
  $("#hf-target").value = "";
  $("#hf-period").value = "day";
  $("#hf-unit").value = "x";
  $("#hf-color").value = "#2563eb";
  $("#hf-block-min").value = "";
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
  $("#habit-form-title").textContent = t("hf_title_edit", { name: h.name });
  $("#hf-id").value = h.id;
  $("#hf-name").value = h.name;
  $("#hf-kind").value = h.kind;
  $("#hf-target").value = h.target != null ? h.target : "";
  $("#hf-period").value = h.target_period || "day";
  $("#hf-unit").value = h.unit || "x";
  $("#hf-color").value = h.color || "#2563eb";
  $("#hf-block-min").value = h.block_minutes != null ? h.block_minutes : "";
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

function renderStateCurveSection(curves) {
  state.lastStateCurves = curves || [];
  syncStateZoomUI();
  const pillsEl = $("#state-axis-pills");
  const chartEl = $("#state-curve-chart");
  if (!pillsEl || !chartEl) return;

  if (!curves || !curves.length) {
    pillsEl.innerHTML = "";
    chartEl.innerHTML = `<div class="muted sm-text">${esc(t("an_no_axes"))}</div>`;
    return;
  }

  if (!state.selectedStateCurveId || !curves.some((c) => c.id === state.selectedStateCurveId)) {
    const firstRated = curves.find((c) => c.rated_count > 0);
    state.selectedStateCurveId = (firstRated || curves[0]).id;
  }

  pillsEl.innerHTML = curves
    .map(
      (c) =>
        `<button type="button" class="pill ${c.id === state.selectedStateCurveId ? "active" : ""}" data-scurve="${esc(c.id)}">${esc(dimName(c))}${c.rated_count ? ` (${c.rated_count})` : ""}</button>`
    )
    .join("");

  const cur = curves.find((c) => c.id === state.selectedStateCurveId) || curves[0];
  if (!cur.rated_count) {
    chartEl.innerHTML = `<div class="muted sm-text">${t("an_first_snap_html", { name: esc(dimName(cur)) })}</div>`;
    return;
  }

  const zoom = ["h24", "d14", "w8"].includes(state.stateZoom) ? state.stateZoom : "d14";
  const W = 680;
  const H = 144;
  const padL = 26;
  const padR = 24;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const yOf = (v) => padT + ((5 - Math.max(1, Math.min(5, v))) / 4) * plotH;

  // Horizontal 1..5 guide hairlines
  const guides = [1, 2, 3, 4, 5]
    .map((lv) => {
      const y = yOf(lv).toFixed(1);
      return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border)" stroke-width="1" stroke-dasharray="${lv === 3 ? "3 3" : "none"}" opacity="${lv === 3 ? "0.9" : "0.5"}" />
              <text x="${padL - 8}" y="${(yOf(lv) + 3.5).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="10" font-family="var(--mono)">${lv}</text>`;
    })
    .join("");

  let bgLayer = "";
  let areaLayer = "";
  let odeLayer = "";
  let tabpfnLayer = "";
  let ticksLayer = "";
  let dotsLayer = "";
  let markersLayer = "";
  let xLabels = "";
  let rightSummary = "";
  const tauLabel = cur.ode_tau_hours ? `ODE τ=${fmtNum(cur.ode_tau_hours)}h` : "";

  if (zoom === "h24") {
    const sc = cur.h24 || { hours: [], actual: [], tabpfn: [], ode: [], habit_ticks: [] };
    const xOfHr = (hr) => padL + (Math.max(0, Math.min(24, hr)) / 24) * plotW;

    // Subtle "Jetzt" vertical line
    const nowDt = new Date();
    const nowHr = nowDt.getHours() + nowDt.getMinutes() / 60;
    const nowX = xOfHr(nowHr).toFixed(1);
    bgLayer = `<line x1="${nowX}" y1="${padT}" x2="${nowX}" y2="${padT + plotH}" stroke="var(--accent)" stroke-width="1" stroke-dasharray="2 3" opacity="0.65" />`;

    if (state.showOdeLine && sc.ode && sc.ode.length >= 2) {
      const odePts = sc.ode
        .map((v, i) => (v != null && sc.hours[i] != null ? { x: xOfHr(sc.hours[i]), y: yOf(v) } : null))
        .filter(Boolean);
      const dStr = buildSmoothCurvePath(odePts);
      if (dStr) {
        areaLayer += `<path d="${dStr} L ${odePts[odePts.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${odePts[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z" fill="rgba(13, 148, 136, 0.09)" />`;
        odeLayer = `<path d="${dStr}" fill="none" stroke="#0d9488" stroke-width="2.2" stroke-linecap="round" />`;
      }
    }

    if (state.showTabpfnLine && sc.tabpfn && sc.tabpfn.length >= 2) {
      const tpPts = sc.tabpfn
        .map((v, i) => (v != null && sc.hours[i] != null ? { x: xOfHr(sc.hours[i]), y: yOf(v) } : null))
        .filter(Boolean);
      const dStr = buildSmoothCurvePath(tpPts);
      if (dStr) {
        tabpfnLayer = `<path d="${dStr}" fill="none" stroke="var(--ai)" stroke-width="1.8" stroke-dasharray="5 4" stroke-linecap="round" opacity="0.9" />`;
      }
    }

    // Tiny colored Habit impulse ticks along bottom X-axis
    const ticks = sc.habit_ticks || [];
    ticksLayer = ticks
      .map((tk) => {
        const tx = xOfHr(tk.hour).toFixed(1);
        const yBot = (padT + plotH).toFixed(1);
        const yTop = (padT + plotH - 9).toFixed(1);
        const tip = `${tk.time} · ${tk.habit_name} (+${fmtNum(tk.amount)})`;
        return `<g>
          <line x1="${tx}" y1="${yTop}" x2="${tx}" y2="${yBot}" stroke="${esc(tk.color)}" stroke-width="2.4" stroke-linecap="round" />
          <circle cx="${tx}" cy="${yTop}" r="2.2" fill="${esc(tk.color)}"><title>${esc(tip)}</title></circle>
        </g>`;
      })
      .join("");

    // Exact today Momentaufnahme dots
    const actPts = sc.actual || [];
    dotsLayer = actPts
      .map((pt) => {
        const cx = xOfHr(pt.hour).toFixed(1);
        const cy = yOf(pt.value).toFixed(1);
        const tip = `${t("today")} ${pt.time}: ${fmtNum(pt.value)}/5${pt.note ? ` · ${pt.note}` : ""}`;
        return `<circle cx="${cx}" cy="${cy}" r="4.5" fill="var(--text)" stroke="var(--surface)" stroke-width="2"><title>${esc(tip)}</title></circle>`;
      })
      .join("");

    xLabels = [0, 4, 8, 12, 16, 20, 24]
      .map((hr) => {
        const lbl = `${String(hr).padStart(2, "0")}:00`;
        return `<text x="${xOfHr(hr).toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="var(--muted)" font-size="10" font-family="var(--mono)">${lbl}</text>`;
      })
      .join("");

    const isEn = window.DailyI18n && window.DailyI18n.getLang() === "en";
    const parts = [];
    if (state.showOdeLine && tauLabel) parts.push(tauLabel);
    parts.push(
      t("an_today_summary", {
        s: actPts.length,
        sp: actPts.length === 1 ? "" : isEn ? "s" : "n",
        t: ticks.length,
        tp: ticks.length === 1 ? "" : isEn ? "s" : "e",
      })
    );
    rightSummary = parts.join(" · ");
  } else if (zoom === "w8") {
    const sc = cur.w8 || { labels: [], actual: [], tabpfn: [], ode: [] };
    const n = sc.labels.length || 1;
    const xOf = (i) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
    const fmtWk = (lbl) =>
      window.DailyI18n && window.DailyI18n.getLang() === "en" ? String(lbl).replace(/^KW\s*/, "W") : lbl;

    // Subtle highlight for current week
    if (n >= 2) {
      const lastX = xOf(n - 1);
      const prevX = xOf(n - 2);
      bgLayer = `<rect x="${((prevX + lastX) / 2).toFixed(1)}" y="${padT}" width="${(W - padR - (prevX + lastX) / 2 + 8).toFixed(1)}" height="${plotH}" fill="var(--accent-soft)" rx="4" />`;
    }

    if (state.showOdeLine && sc.ode && sc.ode.length) {
      const odePts = sc.ode.map((v, i) => (v != null ? { x: xOf(i), y: yOf(v) } : null)).filter(Boolean);
      const dStr = buildSmoothCurvePath(odePts);
      if (dStr) {
        odeLayer = `<path d="${dStr}" fill="none" stroke="#0d9488" stroke-width="2" stroke-linecap="round" />`;
      }
    }

    if (state.showTabpfnLine && sc.tabpfn && sc.tabpfn.length) {
      const tpPts = sc.tabpfn.map((v, i) => (v != null ? { x: xOf(i), y: yOf(v) } : null)).filter(Boolean);
      const dStr = buildSmoothCurvePath(tpPts);
      if (dStr) {
        areaLayer = `<path d="${dStr} L ${tpPts[tpPts.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${tpPts[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z" fill="var(--ai-soft)" opacity="0.38" />`;
        tabpfnLayer = `<path d="${dStr}" fill="none" stroke="var(--ai)" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round" />`;
      }
    }

    dotsLayer = (sc.actual || [])
      .map((v, i) => {
        if (v == null) return "";
        const tpV = sc.tabpfn && sc.tabpfn[i];
        const odV = sc.ode && sc.ode[i];
        const tip = `${fmtWk(sc.labels[i])}: Ø ${fmtNum(v)}/5${tpV != null ? ` · TabPFN ${fmtNum(tpV)}` : ""}${odV != null ? ` · ODE ${fmtNum(odV)}` : ""}`;
        return `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="4.5" fill="var(--text)" stroke="var(--surface)" stroke-width="2"><title>${esc(tip)}</title></circle>`;
      })
      .join("");

    xLabels = sc.labels
      .map((lbl, i) => {
        const isCur = i === n - 1;
        return `<text x="${xOf(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="${isCur ? "var(--text)" : "var(--muted)"}" font-size="10" font-weight="${isCur ? "600" : "400"}" font-family="var(--mono)">${esc(fmtWk(lbl))}</text>`;
      })
      .join("");

    rightSummary = state.showOdeLine && tauLabel ? `${t("an_8w_summary")} · ${tauLabel}` : t("an_8w_summary");
  } else {
    // Default: d14 (14 days + tomorrow)
    const sc = cur.d14 || { dates: cur.dates || [], actual: cur.actual || [], tabpfn: cur.ai_curve || [], ode: [] };
    const n = sc.dates.length || 1;
    const xOf = (i) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);

    const tomX = xOf(n - 1);
    const todayX = xOf(Math.max(0, n - 2));
    bgLayer = `<rect x="${((todayX + tomX) / 2).toFixed(1)}" y="${padT}" width="${(W - padR - (todayX + tomX) / 2 + 8).toFixed(1)}" height="${plotH}" fill="var(--ai-soft)" rx="4" />`;

    if (state.showOdeLine && sc.ode && sc.ode.length) {
      const odePts = sc.ode.map((v, i) => (v != null ? { x: xOf(i), y: yOf(v) } : null)).filter(Boolean);
      const dStr = buildSmoothCurvePath(odePts);
      if (dStr) {
        odeLayer = `<path d="${dStr}" fill="none" stroke="#0d9488" stroke-width="2" stroke-linecap="round" />`;
      }
      const odeTom = sc.ode[n - 1];
      if (odeTom != null) {
        markersLayer += `<circle cx="${tomX.toFixed(1)}" cy="${yOf(odeTom).toFixed(1)}" r="3.5" fill="#0d9488" stroke="var(--surface)" stroke-width="1.5"><title>${esc(t("tomorrow"))} (${sc.dates[n - 1]}): ODE ${fmtNum(odeTom)}/5</title></circle>`;
      }
    }

    if (state.showTabpfnLine && sc.tabpfn && sc.tabpfn.length) {
      const tpPts = sc.tabpfn.map((v, i) => (v != null ? { x: xOf(i), y: yOf(v) } : null)).filter(Boolean);
      const dStr = buildSmoothCurvePath(tpPts);
      if (dStr) {
        areaLayer = `<path d="${dStr} L ${tpPts[tpPts.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${tpPts[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z" fill="var(--ai-soft)" opacity="0.4" />`;
        tabpfnLayer = `<path d="${dStr}" fill="none" stroke="var(--ai)" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round" />`;
      }
      const tomVal = sc.tabpfn[n - 1];
      if (tomVal != null) {
        markersLayer += `<g transform="translate(${tomX.toFixed(1)},${yOf(tomVal).toFixed(1)})">
          <rect x="-4" y="-4" width="8" height="8" transform="rotate(45)" fill="var(--ai)" stroke="var(--surface)" stroke-width="1.5">
            <title>${esc(t("tomorrow"))} (${sc.dates[n - 1]}): TabPFN ${fmtNum(tomVal)}/5</title>
          </rect>
        </g>`;
      }
    }

    dotsLayer = (sc.actual || [])
      .map((v, i) => {
        if (v == null) return "";
        const tpV = sc.tabpfn && sc.tabpfn[i];
        const odV = sc.ode && sc.ode[i];
        const tip = `${sc.dates[i]}: ${t("an_logged_lbl")} ${fmtNum(v)}/5${tpV != null ? ` · TabPFN ${fmtNum(tpV)}` : ""}${odV != null ? ` · ODE ${fmtNum(odV)}` : ""}`;
        return `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="4.5" fill="var(--text)" stroke="var(--surface)" stroke-width="2"><title>${esc(tip)}</title></circle>`;
      })
      .join("");

    xLabels = sc.dates
      .map((dStr, i) => {
        const isLast = i === n - 1;
        const isToday = i === n - 2;
        if (!isLast && !isToday && i % 3 !== 0) return "";
        const txt = isLast ? t("tomorrow") : isToday ? t("today") : `${dStr.slice(8, 10)}.${dStr.slice(5, 7)}.`;
        const fill = isLast ? "var(--ai)" : isToday ? "var(--text)" : "var(--muted)";
        const fw = isLast || isToday ? "600" : "400";
        return `<text x="${xOf(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="${fill}" font-size="10" font-weight="${fw}" font-family="var(--mono)">${esc(txt)}</text>`;
      })
      .join("");

    const parts = [];
    if (state.showOdeLine && tauLabel) parts.push(tauLabel);
    const tomVal = sc.tabpfn && sc.tabpfn[n - 1];
    if (state.showTabpfnLine && tomVal != null) parts.push(t("an_tabpfn_tom", { v: fmtNum(tomVal) }));
    rightSummary = parts.join(" · ");
  }

  const curLow = dimLow(cur);
  const curHigh = dimHigh(cur);
  const anchorTxt =
    curLow || curHigh ? `1 = ${curLow || t("an_anchor_low")} · 5 = ${curHigh || t("an_anchor_high")}` : "";

  chartEl.innerHTML = `
    <div class="state-chart-wrap" title="${esc(t("an_chart_wheel_title"))}">
      <svg class="state-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${bgLayer}
        ${guides}
        ${areaLayer}
        ${odeLayer}
        ${tabpfnLayer}
        ${ticksLayer}
        ${dotsLayer}
        ${markersLayer}
        ${xLabels}
      </svg>
      <div class="state-chart-foot">
        <span>${esc(anchorTxt)}</span>
        <span class="mono">${esc(rightSummary)}</span>
      </div>
    </div>`;
}

async function loadAnalysis() {
  const board = await api("/api/analysis?days=30");
  const ai = board.ai || {};
  renderStateCurveSection(ai.state_curves || []);

  // 1. 7-day matrix (with subtle highlight on today's column)
  const wm = $("#week-matrix");
  const todayIsoNow = localDateISO(new Date());
  if (!board.week_matrix.length) {
    wm.innerHTML = `<div class="muted sm-text">${esc(t("no_habits_yet"))}</div>`;
  } else {
    const headerDays = board.last7_dates
      .map((d) => `<th class="${d === todayIsoNow ? "col-today" : ""}">${d.slice(8, 10)}.${d.slice(5, 7)}.</th>`)
      .join("");
    const rows = board.week_matrix
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
    wm.innerHTML = `<table class="matrix"><thead><tr><th>${esc(t("th_habit"))}</th>${headerDays}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  // 2. 24h Rhythm + Tomorrow markers + subtle AI probability halo behind bars
  const rl = $("#rhythm-list");
  const tomorrowMap = ai.tomorrow || {};
  if (!board.rhythms.length) {
    rl.innerHTML = `<div class="muted sm-text">${esc(t("an_no_entries"))}</div>`;
  } else {
    rl.innerHTML = board.rhythms
      .map((r) => {
        const mx = Math.max(1, ...r.hours);
        const tm = tomorrowMap[r.habit_id] || {};
        const obsHr = r.peak_hour;
        const aiHr = tm.ai_peak_hour != null ? tm.ai_peak_hour : null;
        const aiMaxP = tm.ai_hours ? Math.max(0.05, ...tm.ai_hours) : 1;

        const markers = Array.from({ length: 24 }, (_, hr) => {
          const isObs = obsHr === hr;
          const isAi = aiHr === hr;
          const parts = [];
          if (isObs) parts.push(`<span class="dot-obs" style="background:${esc(r.color)}" title="${esc(t("leg_obs_peak"))} ~${r.peak_time}"></span>`);
          if (isAi) parts.push(`<span class="dot-ai" title="${esc(t("leg_ai_tom"))} ~${tm.ai_peak_time}"></span>`);
          return `<div class="marker-slot">${parts.join("")}</div>`;
        }).join("");

        const bars = r.hours
          .map((cnt, hr) => {
            const pct = cnt > 0 ? Math.max(14, Math.round((cnt / mx) * 100)) : 0;
            const bg = cnt > 0 ? r.color : "var(--surface-2)";
            const aiCls = aiHr === hr ? "is-ai-peak" : "";
            const pTomorrow = tm.ai_hours ? tm.ai_hours[hr] || 0 : 0;
            const haloPct = tm.ai_hours && pTomorrow > 0.08 ? Math.min(100, Math.round((pTomorrow / aiMaxP) * 92)) : 0;
            const aiTip = tm.ai_hours ? ` · ${t("leg_ai_tom")}: ${Math.round(pTomorrow * 100)}%` : "";
            return `
              <div class="spark-col" title="${String(hr).padStart(2, "0")}:00 → ${cnt}×${aiTip}">
                ${haloPct ? `<div class="spark-ai-halo" style="height:${haloPct}%"></div>` : ""}
                <div class="spark-bar ${aiCls}" style="height:${pct || 6}%;background:${bg};opacity:${cnt ? 0.92 : 0.35}"></div>
              </div>`;
          })
          .join("");

        const metaParts = [];
        if (r.peak_time) metaParts.push(`${t("an_obs_short")} ~${r.peak_time}`);
        if (tm.ai_peak_time) metaParts.push(`${t("leg_ai_tom")} ~${tm.ai_peak_time}`);
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
  }

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
}

// ---- EVENT BINDING ----
function bindEvents() {
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  $("#btn-prev-day").addEventListener("click", () => { state.day = shiftDate(state.day, -1); loadToday(); });
  $("#btn-next-day").addEventListener("click", () => { state.day = shiftDate(state.day, +1); loadToday(); });
  $("#btn-go-today").addEventListener("click", () => { state.day = localDateISO(new Date()); loadToday(); });
  $("#day-picker").addEventListener("change", (e) => { if (e.target.value) { state.day = e.target.value; loadToday(); } });

  // Today filters & sort toggle
  $("#today-kind-pills").addEventListener("click", (e) => {
    const pill = e.target.closest("[data-fkind]");
    if (!pill) return;
    state.filterKind = pill.dataset.fkind;
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

  $("#quick-create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#qc-name").value.trim();
    const kind = $("#qc-kind").value;
    const rawT = $("#qc-target").value.trim();
    const target = kind !== "neutral" && rawT !== "" ? Number(rawT) : null;
    const target_period = kind !== "neutral" ? ($("#qc-period").value || "day") : "day";
    if (!name) return;
    try {
      await api("/api/habits", {
        method: "POST",
        body: JSON.stringify({ name, kind, target, target_period }),
      });
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

  // Day log interactions (delete / edit time / edit amount / edit note inline / delete snapshot)
  $("#event-list").addEventListener("click", async (e) => {
    const snapDel = e.target.closest("[data-snap-del]");
    if (snapDel) {
      await api(`/api/snapshots/${snapDel.dataset.snapDel}`, { method: "DELETE" });
      toast(t("deleted_snap"));
      await loadToday();
      return;
    }
    const delBtn = e.target.closest("[data-ev-del]");
    if (delBtn) {
      await api(`/api/events/${delBtn.dataset.evDel}`, { method: "DELETE" });
      toast(t("deleted_entry"));
      await loadToday();
      return;
    }
    const timeEl = e.target.closest("[data-ev-time]");
    if (timeEl) {
      const cur = timeEl.dataset.cur;
      const nextHHMM = prompt(t("prompt_time"), cur.slice(11, 16));
      if (nextHHMM && /^\d{2}:\d{2}$/.test(nextHHMM.trim())) {
        await api(`/api/events/${timeEl.dataset.evTime}`, {
          method: "PATCH",
          body: JSON.stringify({ occurred_at: `${cur.slice(0, 10)}T${nextHHMM.trim()}:00` }),
        });
        toast(t("time_updated", { v: nextHHMM.trim() }));
        await loadToday();
      }
      return;
    }
    const amtEl = e.target.closest("[data-ev-amt]");
    if (amtEl) {
      const raw = prompt(t("prompt_amt"), amtEl.dataset.curAmt);
      if (raw !== null && raw.trim() !== "") {
        const nextVal = Number(raw.trim().replace(",", "."));
        if (!Number.isNaN(nextVal) && nextVal !== 0) {
          await api(`/api/events/${amtEl.dataset.evAmt}`, {
            method: "PATCH",
            body: JSON.stringify({ amount: nextVal }),
          });
          toast(t("amt_updated", { v: fmtNum(nextVal) }));
          await loadToday();
        } else {
          toast(t("prompt_amt_err"));
        }
      }
      return;
    }
    const noteEl = e.target.closest("[data-ev-note]");
    if (noteEl) {
      const curNote = noteEl.dataset.curNote || "";
      const nextNote = prompt(t("prompt_note"), curNote);
      if (nextNote !== null) {
        await api(`/api/events/${noteEl.dataset.evNote}`, {
          method: "PATCH",
          body: JSON.stringify({ note: nextNote.trim() }),
        });
        toast(nextNote.trim() ? t("note_saved") : t("note_removed"));
        await loadToday();
      }
    }
  });

  // Custom log modal
  $("#btn-close-cl").addEventListener("click", closeCustomLog);
  $("#btn-cancel-cl").addEventListener("click", closeCustomLog);
  $("#custom-log-modal").addEventListener("click", (e) => {
    if (e.target.id === "custom-log-modal") closeCustomLog();
    const ago = e.target.closest("[data-ago]");
    if (ago) {
      const dt = new Date(Date.now() - Number(ago.dataset.ago) * 60000);
      $("#cl-time").value = localTimeHHMM(dt);
    }
  });
  $("#cl-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const habit_id = $("#cl-habit-id").value;
    const amount = Number($("#cl-amount").value);
    const hhmm = $("#cl-time").value;
    const note = $("#cl-note").value.trim();
    try {
      await api("/api/events", {
        method: "POST",
        body: JSON.stringify({
          habit_id,
          amount,
          occurred_at: `${state.day}T${hhmm}:00`,
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
      state.retroAmounts[id] = Math.max(0, (state.retroAmounts[id] || 0) + d);
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
  $("#mood-add-axis-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#ma-name").value.trim();
    if (!name) return;
    try {
      await api("/api/state/dimensions", {
        method: "POST",
        body: JSON.stringify({
          name,
          low_label: $("#ma-low").value.trim(),
          high_label: $("#ma-high").value.trim(),
        }),
      });
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
    const hhmm = $("#mood-time").value || localTimeHHMM(new Date());
    const occurred_at = `${state.day}T${hhmm}:00`;
    const client_uuid = makeUuid();
    const payload = { ratings, causes, note, occurred_at, client_uuid };
    try {
      await api("/api/snapshots", { method: "POST", body: JSON.stringify(payload) });
      closeMoodModal();
      toast(t("snap_saved"));
      if (state.tab === "today") await loadToday();
      if (state.tab === "analysis") await loadAnalysis();
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
    if (sw) $("#hf-color").value = sw.dataset.color;
  });
  $("#btn-cancel-edit").addEventListener("click", resetHabitForm);
  $("#setup-habit-list").addEventListener("click", async (e) => {
    const moveBtn = e.target.closest("[data-move-idx]");
    if (moveBtn && !moveBtn.disabled) {
      const idx = Number(moveBtn.dataset.moveIdx);
      const dir = Number(moveBtn.dataset.moveDir);
      const nextIdx = idx + dir;
      if (nextIdx >= 0 && nextIdx < state.habits.length) {
        const ordered = state.habits.map((h) => h.id);
        [ordered[idx], ordered[nextIdx]] = [ordered[nextIdx], ordered[idx]];
        await api("/api/habits/reorder", {
          method: "POST",
          body: JSON.stringify({ habit_ids: ordered }),
        });
        await loadSetup();
      }
      return;
    }
    const archBtn = e.target.closest("[data-archive-id]");
    if (archBtn) {
      await api(`/api/habits/${encodeURIComponent(archBtn.dataset.archiveId)}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      });
      toast(t("habit_archived"));
      await loadSetup();
      return;
    }
    const btn = e.target.closest("[data-setup-edit]");
    if (btn) populateHabitForm(btn.dataset.setupEdit);
  });
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
    const payload = {
      name: $("#hf-name").value.trim(),
      kind: $("#hf-kind").value,
      target: rawT !== "" ? Number(rawT) : null,
      target_period: $("#hf-period").value || "day",
      clear_target: rawT === "",
      unit: $("#hf-unit").value.trim() || "x",
      color: $("#hf-color").value,
      block_minutes: rawB !== "" ? Number(rawB) : null,
      clear_block_minutes: rawB === "",
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

  // Routing & Hypotheses forms
  $("#rollup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const source_id = $("#rf-source").value;
    const target_id = $("#rf-target").value;
    const sign = Number($("#rf-sign").value);
    const weight = Math.abs(Number($("#rf-weight").value || 1)) * sign;
    try {
      await api("/api/edges", {
        method: "POST",
        body: JSON.stringify({ source_id, target_id, relation_type: "rollup", weight, context_window: "any" }),
      });
      toast(t("edge_saved"));
      await loadSetup();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  });

  $("#hyp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const source_id = $("#hyp-source").value;
    const target_id = $("#hyp-target").value;
    const weight = Number($("#hyp-sign").value);
    const context_window = $("#hyp-window").value;
    const note = $("#hyp-note").value.trim();
    try {
      await api("/api/edges", {
        method: "POST",
        body: JSON.stringify({ source_id, target_id, relation_type: "hypothesis", weight, context_window, note }),
      });
      $("#hyp-note").value = "";
      toast(t("hyp_saved"));
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
    const flip = e.target.closest("[data-flip-edge]");
    if (flip) {
      await api("/api/edges", {
        method: "POST",
        body: JSON.stringify({
          source_id: flip.dataset.src,
          target_id: flip.dataset.dst,
          relation_type: flip.dataset.rt,
          weight: Number(flip.dataset.w),
          context_window: flip.dataset.win,
        }),
      });
      toast(t("sign_flipped"));
      await loadSetup();
    }
  };
  $("#rollup-list").addEventListener("click", handleEdgeClick);
  $("#hyp-list").addEventListener("click", handleEdgeClick);

  // Unified mode switch (Topbar + Setup -> affects BOTH Today routing AND Notifications!)
  const handleModeSwitch = async (e) => {
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
      if (state.tab === "today") await loadToday();
      if (state.tab === "analysis") await loadAnalysis();
    } catch (err) {
      toast(t("err_prefix", { msg: err.message }));
    }
  };
  $("#nudge-mode-switch").addEventListener("click", handleModeSwitch);
  $("#global-mode-switch").addEventListener("click", handleModeSwitch);

  $("#state-axis-pills").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-scurve]");
    if (!btn) return;
    state.selectedStateCurveId = btn.dataset.scurve;
    renderStateCurveSection(state.lastStateCurves);
  });
  $("#state-zoom-switch").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-szoom]");
    if (!btn) return;
    state.stateZoom = btn.dataset.szoom;
    localStorage.setItem("daily_state_zoom", state.stateZoom);
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
  let lastWheelZoomAt = 0;
  $("#state-curve-chart").addEventListener(
    "wheel",
    (e) => {
      if (!state.lastStateCurves.length || Math.abs(e.deltaY) < 6) return;
      e.preventDefault();
      const nowMs = Date.now();
      if (nowMs - lastWheelZoomAt < 230) return;
      lastWheelZoomAt = nowMs;
      const order = ["h24", "d14", "w8"];
      const idx = Math.max(0, order.indexOf(state.stateZoom));
      const nextIdx = e.deltaY > 0 ? Math.min(order.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (nextIdx !== idx) {
        state.stateZoom = order[nextIdx];
        localStorage.setItem("daily_state_zoom", state.stateZoom);
        renderStateCurveSection(state.lastStateCurves);
      }
    },
    { passive: false }
  );

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
      closeRetroModal();
      closeCustomLog();
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

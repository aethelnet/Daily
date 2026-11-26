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
  tags: [],
  filterKind: "all",
  filterQuery: "",
  sortMode: localStorage.getItem("daily_sort_mode") || "manual",
  toggledFocus: [],
  selectedStateCurveId: null,
  lastStateCurves: [],
  lastTimelineMeta: null,
  selectedChartTag: null,
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
  logRange: null, // null = single day (state.day); or { start: "YYYY-MM-DD", end: "YYYY-MM-DD" }
  logRangeData: null,
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
    state.tags = meta.tags || [];
    localStorage.setItem(`daily_today_cache_${state.day}`, JSON.stringify(data));
    syncNudgeModeUI(data.routing_mode || state.settings.nudge_mode || "observed");
    renderToday(data);
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

function renderLogEntryHtml(entry, dimsById, habitsById) {
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
      <span class="ev-dot" style="background:var(--ai)"></span>
      <span class="mono muted sm-text">${hhmm}</span>
      <strong>${esc(t("btn_mood"))}</strong>
      <div class="row-inline" style="gap:4px;">${ratingChips}${causeChip}</div>
      <span class="muted sm-text" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${renderNoteWithTags(sn.note || "")}</span>
      <button class="btn ghost sm" data-snap-del="${sn.id}" title="${esc(t("del_title"))}">✕</button>
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
  return `
  <div class="ev-row">
    <span class="ev-dot" style="background:${esc(ev.habit_color)}"></span>
    <span class="ev-time" data-ev-time="${ev.id}" data-cur="${esc(ev.occurred_at)}" data-cur-label="${esc(timeLabel)}" data-win="${winMin}" data-hid="${esc(ev.habit_id || "")}" title="${esc(t("edit_time_title"))}">${esc(timeLabel)}</span>
    <strong>${esc(ev.habit_name)}</strong>
    <span class="ev-amt ${ev.amount >= 0 ? "pos" : "neg"}" data-ev-amt="${ev.id}" data-cur-amt="${ev.amount}" title="${esc(t("edit_amt_title"))}">${ev.amount >= 0 ? "+" : ""}${fmtNum(ev.amount)}</span>
    <span class="chip">${esc(srcTag)}</span>
    <span class="ev-note ${hasNote ? "" : "empty-note"}" data-ev-note="${ev.id}" data-cur-note="${esc(ev.note || "")}" title="${esc(t("edit_note_title"))}">${hasNote ? renderNoteWithTags(ev.note) : esc(t("add_note_ph"))}</span>
    <button class="btn ghost sm" data-ev-del="${ev.id}" title="${esc(t("del_title"))}">✕</button>
  </div>`;
}

function renderLogTimeline({ events, snapshots, state_dimensions, habits, singleDay, rangeStart, rangeEnd }) {
  const dimsById = {};
  (state_dimensions || state.stateDims || []).forEach((d) => { dimsById[d.id] = d; });
  const habitsById = {};
  (habits || state.habits || []).forEach((h) => { habitsById[h.id] = h; });

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
      toast(
        t("session_stopped_logged", {
          amt: fmtNum(res.amount),
          name: h.name,
          dur: formatDurationMin(res.elapsed_minutes),
        }),
        { undoEventId: res.event.id }
      );
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
  renderTagSuggestChips("#cl-tag-chips", "#cl-note");
  $("#custom-log-modal").classList.remove("hidden");
  $("#cl-amount").focus();
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
async function openMoodModal() {
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
  renderTagSuggestChips("#mood-tag-chips", "#mood-note");
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
      <stop offset="0%" stop-color="#368470" stop-opacity="0.15" />
      <stop offset="100%" stop-color="#368470" stop-opacity="0.0" />
    </linearGradient>
    <linearGradient id="fut-zone-bg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="var(--ai)" stop-opacity="0.06" />
      <stop offset="100%" stop-color="var(--ai)" stop-opacity="0.015" />
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

  if (state.showOdeLine) {
    drawContinuousSeries(tl.ode, {
      id: "ode",
      label: "ODE",
      stroke: "#368470",
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
      stroke: "var(--ai)",
      width: 2.0,
      dash: "5 4",
      pastOpacity: 0.9,
      pastFill: "",
    });
  }

  let ticksLayer = "";
  const allTicks = meta.habit_ticks || [];
  let visibleTicksCount = 0;
  if (span <= 120) {
    const visTicks = allTicks.filter((tk) => tk.t >= vStart && tk.t <= vEnd);
    visibleTicksCount = visTicks.length;
    ticksLayer = visTicks
      .map((tk) => {
        const tx = xOf(tk.t).toFixed(1);
        const yBot = (padT + plotH).toFixed(1);
        const yTop = (padT + plotH - 10).toFixed(1);
        const tip = `${tk.ts.slice(11, 16)} (${tk.ts.slice(8, 10)}.${tk.ts.slice(5, 7)}.) · ${tk.habit_name} (+${fmtNum(tk.amount)})`;
        return `<g>
          <line x1="${tx}" y1="${yTop}" x2="${tx}" y2="${yBot}" stroke="${esc(tk.color)}" stroke-width="2.4" stroke-linecap="round" opacity="0.88" />
          <circle cx="${tx}" cy="${yTop}" r="2.3" fill="${esc(tk.color)}"><title>${esc(tip)}</title></circle>
        </g>`;
      })
      .join("");
  }

  const visActual = (tl.actual || []).filter((pt) => pt.t >= vStart && pt.t <= vEnd);
  const dotsLayer = visActual
    .map((pt) => {
      const cx = xOf(pt.t).toFixed(1);
      const cy = yOf(pt.v).toFixed(1);
      const tip = `${fmtRelTime(pt.t)}: ${fmtNum(pt.v)}/5${pt.note ? ` · ${pt.note}` : ""}`;
      return `<circle cx="${cx}" cy="${cy}" r="4.8" fill="var(--text)" stroke="var(--surface)" stroke-width="2.2"><title>${esc(tip)}</title></circle>`;
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

  // Store geometry snapshot for zero-latency live hover crosshair
  state._chartGeom = { W, H, padL, padR, padT, padB, plotW, plotH, vStart, vEnd, span, originMs, nowHr, cur, visActual, anchorTxt, rightSummary };

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
      <div class="state-chart-foot">
        <span>${esc(t("an_chart_pan_hint"))}</span>
        <span class="mono">${esc(t("an_chart_zoom_hint"))}</span>
      </div>
    </div>`;
}

function renderWeekMatrix(dates, weekMatrix, endDay) {
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
  const headerDays = (dates || [])
    .map((d) => `<th class="${d === todayIsoNow ? "col-today" : ""}">${d.slice(8, 10)}.${d.slice(5, 7)}.</th>`)
    .join("");
  const rows = weekMatrix
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
  rl.innerHTML = rhythms
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
}

async function loadAnalysis() {
  const board = await api("/api/analysis?days=30");
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
      const curLabel = timeEl.dataset.curLabel || cur.slice(11, 16);
      const raw = prompt(t("prompt_time"), curLabel);
      if (raw !== null) {
        const trimmed = raw.trim();
        const rangeMatch = trimmed.match(/^(\d{2}):(\d{2})\s*[-–]\s*(\d{2}):(\d{2})$/);
        const singleMatch = trimmed.match(/^(\d{2}):(\d{2})$/);
        if (rangeMatch) {
          const sh = Number(rangeMatch[1]), sm = Number(rangeMatch[2]);
          const eh = Number(rangeMatch[3]), em = Number(rangeMatch[4]);
          if (sh <= 23 && sm <= 59 && eh <= 23 && em <= 59) {
            let diffMin = (eh * 60 + em) - (sh * 60 + sm);
            if (diffMin <= 0) diffMin += 1440;
            const endHHMM = `${rangeMatch[3]}:${rangeMatch[4]}`;
            const startHHMM = `${rangeMatch[1]}:${rangeMatch[2]}`;
            const patch = {
              occurred_at: `${cur.slice(0, 10)}T${endHHMM}:00`,
              window_minutes: diffMin,
            };
            const allH = (state.logRangeData && state.logRangeData.habits) || state.habits;
            const hab = allH.find((x) => x.id === timeEl.dataset.hid) || state.habits.find((x) => x.id === timeEl.dataset.hid);
            if (hab && hab.block_minutes) {
              patch.amount = Math.max(0.1, Math.round((diffMin / Number(hab.block_minutes)) * 10) / 10);
            }
            await api(`/api/events/${timeEl.dataset.evTime}`, {
              method: "PATCH",
              body: JSON.stringify(patch),
            });
            const label = patch.amount != null ? `${startHHMM}–${endHHMM} (+${fmtNum(patch.amount)})` : `${startHHMM}–${endHHMM}`;
            toast(t("time_updated", { v: label }));
            await loadToday();
          }
        } else if (singleMatch) {
          const hh = Number(singleMatch[1]), mm = Number(singleMatch[2]);
          if (hh <= 23 && mm <= 59) {
            await api(`/api/events/${timeEl.dataset.evTime}`, {
              method: "PATCH",
              body: JSON.stringify({ occurred_at: `${cur.slice(0, 10)}T${trimmed}:00` }),
            });
            toast(t("time_updated", { v: trimmed }));
            await loadToday();
          }
        }
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

  // Quick-pick existing #tag chips in Mood / Custom Log / Retro note fields
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
    ["#retro-tag-chips", "#retro-note"],
  ].forEach(([boxSel, inpSel]) => {
    const inp = $(inpSel);
    if (inp) inp.addEventListener("input", () => renderTagSuggestChips(boxSel, inpSel));
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
  const nudgeSwitch = $("#nudge-mode-switch");
  if (nudgeSwitch) nudgeSwitch.addEventListener("click", handleModeSwitch);
  const globalSwitch = $("#global-mode-switch");
  if (globalSwitch) globalSwitch.addEventListener("click", handleModeSwitch);

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
  chartHost.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !state.chartView || !state.lastStateCurves.length) return;
    const wrap = e.target.closest("[data-pan-chart]");
    if (!wrap) return;
    chartDrag = {
      pointerId: e.pointerId,
      startX: e.clientX,
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
    const span = chartDrag.origEnd - chartDrag.origStart;
    const shiftHr = -(dx / chartDrag.width) * span;
    state.chartView = clampChartView(chartDrag.origStart + shiftHr, chartDrag.origEnd + shiftHr);
    renderStateCurveSection(state.lastStateCurves);
  });
  const endChartDrag = (e) => {
    if (!chartDrag || e.pointerId !== chartDrag.pointerId) return;
    chartDrag = null;
    const wrap = chartHost.querySelector("[data-pan-chart]");
    if (wrap) wrap.classList.remove("is-dragging");
    try { chartHost.releasePointerCapture(e.pointerId); } catch {}
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
  chartHost.addEventListener("pointermove", (e) => {
    if (chartDrag) return;
    const g = state._chartGeom;
    const svg = chartHost.querySelector(".state-chart-svg");
    if (!g || !svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * g.W;
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
    if (snappedDot) hr = snappedDot.t;
    const cx = xOf(hr);
    const tl = (g.cur && g.cur.timeline) || {};
    const odePt = state.showOdeLine ? interpSeriesAt(tl.ode, hr) : null;
    const tpPt = state.showTabpfnLine ? interpSeriesAt(tl.tabpfn, hr) : null;

    let markers = `<line x1="${cx.toFixed(1)}" y1="${g.padT}" x2="${cx.toFixed(1)}" y2="${g.padT + g.plotH}" stroke="var(--text-2)" stroke-width="1" opacity="0.32" />`;
    if (odePt) {
      markers += `<circle cx="${cx.toFixed(1)}" cy="${yOf(odePt.v).toFixed(1)}" r="4" fill="#368470" stroke="var(--surface)" stroke-width="1.8" />`;
    }
    if (tpPt) {
      markers += `<circle cx="${cx.toFixed(1)}" cy="${yOf(tpPt.v).toFixed(1)}" r="3.8" fill="var(--ai)" stroke="var(--surface)" stroke-width="1.8" />`;
    }
    if (snappedDot) {
      markers += `<circle cx="${cx.toFixed(1)}" cy="${yOf(snappedDot.v).toFixed(1)}" r="7.5" fill="none" stroke="var(--text)" stroke-width="1.4" opacity="0.45" />`;
    }
    const hoverEl = $("#state-chart-hover");
    if (hoverEl) hoverEl.innerHTML = markers;

    const dt = new Date(g.originMs + hr * 3600000);
    const p2 = (n) => String(n).padStart(2, "0");
    const tsStr = `${dt.toLocaleDateString(getLocale(), { weekday: "short", day: "2-digit", month: "2-digit" })} ${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
    const isFut = hr > g.nowHr + 0.1;
    const pills = [`<span class="ro-pill"><strong>${esc(tsStr)}</strong></span>`];
    if (snappedDot) {
      pills.push(`<span class="ro-pill"><span class="dot-obs" style="background:var(--text)"></span>${fmtNum(snappedDot.v)}/5${snappedDot.note ? ` <span class="muted">${esc(snappedDot.note.slice(0, 32))}</span>` : ""}</span>`);
    }
    if (odePt) {
      const cTxt = isFut ? ` <span class="muted">(${Math.round(odePt.conf * 100)}%)</span>` : "";
      pills.push(`<span class="ro-pill"><span class="line-ode"></span>ODE ${fmtNum(odePt.v)}${cTxt}</span>`);
    }
    if (tpPt) {
      const cTxt = isFut ? ` <span class="muted">(${Math.round(tpPt.conf * 100)}%)</span>` : "";
      pills.push(`<span class="ro-pill"><span class="line-ai"></span>TabPFN ${fmtNum(tpPt.v)}${cTxt}</span>`);
    }
    const roEl = $("#state-chart-readout");
    if (roEl) roEl.innerHTML = `<span class="ro-live">${pills.join("")}</span>`;
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

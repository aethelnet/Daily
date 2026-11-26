/* Daily Standalone Browser Engine — 100% Local-First in Browser (localStorage, Zero Server, Zero Tracking).
 * Activates automatically on static hosts (e.g. daily.aethelburg.network / github.io) when no custom server URL is set.
 * Mirrors the FastAPI backend API surface so the exact same UI runs serverlessly on any phone or desktop.
 */
(function () {
  const DB_KEY = "daily_standalone_db_v1";
  const DEFAULT_DIMS = [
    { id: "stimmung", name: "Stimmung", low_label: "melancholisch", high_label: "leicht / gut", sort_order: 0, archived: 0 },
    { id: "mental-fit", name: "Mental fit", low_label: "leer / neblig", high_label: "wach / klar", sort_order: 1, archived: 0 },
    { id: "stress", name: "Stress", low_label: "entspannt", high_label: "unter Druck", sort_order: 2, archived: 0 },
    { id: "anspannung", name: "Anspannung", low_label: "locker", high_label: "angespannt", sort_order: 3, archived: 0 },
    { id: "antrieb", name: "Antrieb / Offenheit", low_label: "blockiert", high_label: "offen / bereit", sort_order: 4, archived: 0 },
  ];

  function nowIso() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function todayStr() {
    return nowIso().slice(0, 10);
  }

  function shiftDayStr(iso, deltaDays) {
    const [y, m, d] = String(iso || todayStr()).slice(0, 10).split("-").map(Number);
    const dt = new Date(y, m - 1, d + deltaDays);
    const p = (n) => String(n).padStart(2, "0");
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }

  function slugify(name) {
    return (
      String(name || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || `h-${Math.random().toString(36).slice(2, 8)}`
    );
  }

  function classifyWindow(iso) {
    const hr = Number(String(iso || "").slice(11, 13)) || 0;
    if (hr >= 5 && hr < 12) return "morning";
    if (hr >= 12 && hr < 17) return "afternoon";
    if (hr >= 17 && hr < 22) return "evening";
    return "night";
  }

  function extractNoteTags(note) {
    const out = new Set();
    if (!note) return out;
    const re = /(?:^|[^\w])#([a-zA-Z0-9äöüÄÖÜß_-]{2,24})/g;
    let m;
    while ((m = re.exec(String(note))) !== null) {
      out.add(m[1].toLowerCase());
    }
    return out;
  }

  function computeTagStats(db, limit = 24) {
    const byDay = {};
    for (const obj of [...(db.events || []), ...(db.snapshots || [])]) {
      if (obj.deleted_at || !obj.note) continue;
      const tags = extractNoteTags(obj.note);
      if (!tags.size) continue;
      const d = String(obj.occurred_at || "").slice(0, 10);
      if (d.length !== 10) continue;
      byDay[d] ||= new Set();
      tags.forEach((t) => byDay[d].add(t));
    }
    const counts = {};
    for (const set of Object.values(byDay)) {
      for (const t of set) counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([tag, days]) => ({ tag, days, ai_active: days >= 2 }));
  }

  function loadDB() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!parsed.state_dimensions) parsed.state_dimensions = DEFAULT_DIMS.map((d) => ({ ...d, created_at: nowIso() }));
        if (!parsed.snapshots) parsed.snapshots = [];
        if (!parsed.settings) parsed.settings = { checkin_interval_hours: "3", notifications_enabled: "1", quiet_hours_start: "23", quiet_hours_end: "8", nudge_mode: "observed", followup_enabled: "1" };
        if (parsed.settings.followup_enabled === undefined) parsed.settings.followup_enabled = "1";
        if (!parsed.next_id) parsed.next_id = 100;
        // Backfill client_uuid & updated_at on any legacy local records so E2EE CRDT merge NEVER skips them
        let migrated = false;
        for (const ev of parsed.events || []) {
          if (!ev.client_uuid) {
            ev.client_uuid = `loc-bf-${ev.id || 0}-${Math.random().toString(36).slice(2, 9)}`;
            migrated = true;
          }
          if (!ev.updated_at) {
            ev.updated_at = ev.created_at || nowIso();
            migrated = true;
          }
        }
        for (const sn of parsed.snapshots || []) {
          if (!sn.client_uuid) {
            sn.client_uuid = `sn-bf-${sn.id || 0}-${Math.random().toString(36).slice(2, 9)}`;
            migrated = true;
          }
          if (!sn.updated_at) {
            sn.updated_at = sn.created_at || nowIso();
            migrated = true;
          }
        }
        if (migrated) saveDB(parsed);
        return parsed;
      }
    } catch {}
    const fresh = {
      version: 1,
      next_id: 1,
      habits: [],
      edges: [],
      events: [],
      snapshots: [],
      state_dimensions: DEFAULT_DIMS.map((d) => ({ ...d, created_at: nowIso() })),
      settings: {
        checkin_interval_hours: "3",
        notifications_enabled: "1",
        quiet_hours_start: "23",
        quiet_hours_end: "8",
        nudge_mode: "observed",
        followup_enabled: "1",
      },
    };
    saveDB(fresh);
    return fresh;
  }

  function saveDB(db) {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  }

  function evalStatus(h, eff) {
    if (h.target == null || h.kind === "neutral") return "neutral";
    const t = Number(h.target);
    if (h.kind === "min") return eff >= t ? "met" : eff > 0 ? "in_progress" : "pending";
    if (eff > t) return "exceeded";
    if (t > 0 && eff >= t * 0.8) return "warning";
    return "within_limit";
  }

  function computeRollups(direct, habitsById, edges, maxDepth = 8) {
    const adj = {};
    for (const e of edges) {
      if (e.relation_type === "rollup") (adj[e.source_id] ||= []).push(e);
    }
    const routed = {};
    const contribMap = {};
    Object.keys(habitsById).forEach((hid) => {
      routed[hid] = 0;
      contribMap[hid] = {};
    });

    function dfs(originId, curId, val, path, depth) {
      if (depth >= maxDepth || Math.abs(val) < 1e-9) return;
      for (const edge of adj[curId] || []) {
        const nxt = edge.target_id;
        if (path.has(nxt) || !habitsById[nxt]) continue;
        const delta = val * Number(edge.weight);
        routed[nxt] = (routed[nxt] || 0) + delta;
        contribMap[nxt][originId] = (contribMap[nxt][originId] || 0) + delta;
        const nextPath = new Set(path);
        nextPath.add(nxt);
        dfs(originId, nxt, delta, nextPath, depth + 1);
      }
    }

    for (const [srcId, dval] of Object.entries(direct)) {
      if (Math.abs(dval) > 1e-9 && habitsById[srcId]) {
        dfs(srcId, srcId, dval, new Set([srcId]), 0);
      }
    }

    const contributors = {};
    for (const hid of Object.keys(habitsById)) {
      contributors[hid] = Object.entries(contribMap[hid] || {})
        .filter(([, d]) => Math.abs(d) > 1e-6)
        .map(([fromId, delta]) => ({
          from_id: fromId,
          from_name: habitsById[fromId].name,
          delta: Math.round(delta * 100) / 100,
          is_ai: false,
        }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      routed[hid] = Math.round((routed[hid] || 0) * 100) / 100;
    }
    return { routed, contributors };
  }

  function enrichEdges(db) {
    const byId = Object.fromEntries(db.habits.map((h) => [h.id, h]));
    return db.edges
      .filter((e) => byId[e.source_id] && byId[e.target_id])
      .map((e) => ({
        ...e,
        source_name: byId[e.source_id].name,
        target_name: byId[e.target_id].name,
      }));
  }

  function enrichEvent(ev, byId) {
    const h = byId[ev.habit_id] || {};
    return {
      ...ev,
      habit_name: h.name || ev.habit_id,
      habit_unit: h.unit || "x",
      habit_kind: h.kind || "neutral",
      habit_color: h.color || "#2563eb",
    };
  }

  function computeToday(db, targetDay) {
    const day = targetDay || todayStr();
    const allHabits = [...db.habits].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const activeHabits = allHabits.filter((h) => !h.archived);
    const byId = Object.fromEntries(allHabits.map((h) => [h.id, h]));
    const activeIds = new Set(activeHabits.map((h) => h.id));
    const edges = enrichEdges(db);
    const liveEvents = db.events.filter((ev) => !ev.deleted_at);

    const lastUsed = {};
    for (const ev of liveEvents) {
      if (Number(ev.amount) > 0 && (!lastUsed[ev.habit_id] || ev.occurred_at > lastUsed[ev.habit_id])) {
        lastUsed[ev.habit_id] = ev.occurred_at;
      }
    }

    const dayEvents = liveEvents
      .filter((ev) => ev.occurred_at.slice(0, 10) === day)
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.id - a.id)
      .map((ev) => enrichEvent(ev, byId));

    const direct = {};
    const counts = {};
    allHabits.forEach((h) => { direct[h.id] = 0; counts[h.id] = 0; });
    for (const ev of dayEvents) {
      if (direct[ev.habit_id] != null) {
        direct[ev.habit_id] += Number(ev.amount);
        counts[ev.habit_id] += 1;
      }
    }

    const { routed, contributors } = computeRollups(direct, byId, edges);

    // Period rollups (week / month) for habits with target_period !== 'day'
    const periodEffMap = {};
    if (activeHabits.some((h) => (h.target_period || "day") !== "day")) {
      const [yy, mm, dd] = day.split("-").map(Number);
      const dObj = new Date(yy, mm - 1, dd);
      const wd = (dObj.getDay() + 6) % 7; // Mon=0..Sun=6
      const p2 = (n) => String(n).padStart(2, "0");
      const toIso = (dt) => `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
      const wStart = toIso(new Date(yy, mm - 1, dd - wd));
      const wEnd = toIso(new Date(yy, mm - 1, dd + (6 - wd)));
      const mStart = toIso(new Date(yy, mm - 1, 1));
      const mEnd = toIso(new Date(yy, mm, 0));

      const wDir = {};
      const mDir = {};
      allHabits.forEach((h) => { wDir[h.id] = 0; mDir[h.id] = 0; });
      for (const ev of liveEvents) {
        if (wDir[ev.habit_id] == null) continue;
        const ed = ev.occurred_at.slice(0, 10);
        const amt = Number(ev.amount);
        if (ed >= wStart && ed <= wEnd) wDir[ev.habit_id] += amt;
        if (ed >= mStart && ed <= mEnd) mDir[ev.habit_id] += amt;
      }
      const wRouted = computeRollups(wDir, byId, edges).routed;
      const mRouted = computeRollups(mDir, byId, edges).routed;
      for (const h of activeHabits) {
        const per = h.target_period || "day";
        if (per === "week") periodEffMap[h.id] = Math.round((wDir[h.id] + (wRouted[h.id] || 0)) * 100) / 100;
        else if (per === "month") periodEffMap[h.id] = Math.round((mDir[h.id] + (mRouted[h.id] || 0)) * 100) / 100;
      }
    }

    const outMap = {};
    for (const e of edges) {
      if (e.relation_type === "rollup" && activeIds.has(e.target_id)) {
        (outMap[e.source_id] ||= []).push({
          id: e.id,
          target_id: e.target_id,
          target_name: e.target_name,
          weight: e.weight,
          is_ai: false,
        });
      }
    }

    const cards = activeHabits.map((h) => {
      const dVal = Math.round((direct[h.id] || 0) * 100) / 100;
      const rVal = Math.round((routed[h.id] || 0) * 100) / 100;
      const eff = Math.round((dVal + rVal) * 100) / 100;
      const per = h.target_period || "day";
      const pEff = periodEffMap[h.id] != null ? periodEffMap[h.id] : eff;
      return {
        ...h,
        target_period: per,
        direct: dVal,
        routed: rVal,
        effective: eff,
        period_effective: pEff,
        event_count: counts[h.id] || 0,
        last_used_at: lastUsed[h.id] || null,
        status: evalStatus(h, pEff),
        contributors: contributors[h.id] || [],
        routes_to: outMap[h.id] || [],
      };
    });

    const daySnaps = db.snapshots
      .filter((s) => !s.deleted_at && s.occurred_at.slice(0, 10) === day)
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

    return {
      day,
      routing_mode: db.settings.nudge_mode || "observed",
      active_edges: edges.filter((e) => e.relation_type === "rollup" && activeIds.has(e.source_id) && activeIds.has(e.target_id)),
      habits: cards,
      events: dayEvents,
      snapshots: daySnaps,
      state_dimensions: db.state_dimensions.filter((d) => !d.archived),
    };
  }

  function computeAnalysis(db) {
    const allHabits = [...db.habits].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const activeHabits = allHabits.filter((h) => !h.archived);
    const byId = Object.fromEntries(allHabits.map((h) => [h.id, h]));
    const activeById = Object.fromEntries(activeHabits.map((h) => [h.id, h]));
    const edges = enrichEdges(db);
    const liveEvents = db.events.filter((ev) => !ev.deleted_at);

    const byDayDirect = {};
    const byDayWindows = {};
    for (const ev of liveEvents) {
      if (!byId[ev.habit_id]) continue;
      const dStr = ev.occurred_at.slice(0, 10);
      byDayDirect[dStr] ||= {};
      byDayDirect[dStr][ev.habit_id] = (byDayDirect[dStr][ev.habit_id] || 0) + Number(ev.amount);
      if (Number(ev.amount) > 0) {
        byDayWindows[dStr] ||= {};
        (byDayWindows[dStr][ev.habit_id] ||= new Set()).add("any");
        byDayWindows[dStr][ev.habit_id].add(classifyWindow(ev.occurred_at));
      }
    }

    const observedDays = Object.keys(byDayDirect).sort();
    const byDayEff = {};
    for (const dStr of observedDays) {
      const direct = {};
      allHabits.forEach((h) => { direct[h.id] = byDayDirect[dStr][h.id] || 0; });
      const { routed } = computeRollups(direct, byId, edges);
      byDayEff[dStr] = {};
      allHabits.forEach((h) => {
        byDayEff[dStr][h.id] = Math.round((direct[h.id] + (routed[h.id] || 0)) * 100) / 100;
      });
    }

    // Last 7 days matrix
    const now = new Date();
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const p = (n) => String(n).padStart(2, "0");
      last7.push(`${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`);
    }
    const weekMatrix = activeHabits.map((h) => ({
      habit_id: h.id,
      name: h.name,
      kind: h.kind,
      target: h.target,
      unit: h.unit,
      color: h.color,
      days: last7.map((dStr) => {
        const eff = (byDayEff[dStr] && byDayEff[dStr][h.id]) || 0;
        return { day: dStr, effective: eff, status: evalStatus(h, eff) };
      }),
    }));

    // 24h Rhythms + local browser tomorrow forecast
    const rhythms = [];
    const tomorrow = {};
    for (const h of activeHabits) {
      const hist = new Array(24).fill(0);
      const minsByHr = {};
      for (const ev of liveEvents) {
        if (ev.habit_id === h.id && Number(ev.amount) > 0) {
          const hr = Number(ev.occurred_at.slice(11, 13)) || 0;
          const mn = Number(ev.occurred_at.slice(14, 16)) || 0;
          hist[hr] += 1;
          (minsByHr[hr] ||= []).push(mn);
        }
      }
      const total = hist.reduce((a, b) => a + b, 0);
      let peakHr = null;
      let peakMin = 0;
      if (total >= 1) {
        let best = -1;
        for (let hr = 0; hr < 24; hr++) {
          const s = hist[hr] + 0.35 * hist[(hr + 23) % 24] + 0.35 * hist[(hr + 1) % 24];
          if (hist[hr] > 0 && s > best) { best = s; peakHr = hr; }
        }
        if (peakHr != null && minsByHr[peakHr]) {
          peakMin = Math.round(minsByHr[peakHr].reduce((a, b) => a + b, 0) / minsByHr[peakHr].length);
        }
      }
      const pad = (n) => String(n).padStart(2, "0");
      rhythms.push({
        habit_id: h.id,
        habit_name: h.name,
        kind: h.kind,
        color: h.color,
        total_events: total,
        hours: hist,
        peak_hour: peakHr,
        peak_time: peakHr != null ? `${pad(peakHr)}:${pad(peakMin)}` : null,
        nudge_enabled: !!h.nudge_enabled,
      });

      // Smoothed browser forecast curve for tomorrow
      const smooth = hist.map((_, hr) => 0.15 + hist[hr] + 0.45 * hist[(hr + 23) % 24] + 0.45 * hist[(hr + 1) % 24]);
      const smMax = Math.max(1, ...smooth);
      const probs = total > 0 ? smooth.map((v) => Math.round((v / (smMax * 1.15)) * 1000) / 1000) : new Array(24).fill(0.05);
      const aiPeak = total > 0 ? probs.indexOf(Math.max(...probs)) : null;
      tomorrow[h.id] = {
        habit_id: h.id,
        ai_hours: probs,
        ai_peak_hour: aiPeak,
        ai_peak_time: aiPeak != null ? `${pad(aiPeak)}:00` : null,
      };
    }

    // Hypotheses & simple calibration
    function evalPair(srcId, dstId, win, expSign, note = "", edgeId = null) {
      const wVals = [];
      const woVals = [];
      for (const dStr of observedDays) {
        const hasSrc = !!(byDayWindows[dStr] && byDayWindows[dStr][srcId] && byDayWindows[dStr][srcId].has(win));
        const val = (byDayEff[dStr] && byDayEff[dStr][dstId]) || 0;
        (hasSrc ? wVals : woVals).push(val);
      }
      const avgW = wVals.length ? Math.round((wVals.reduce((a, b) => a + b, 0) / wVals.length) * 100) / 100 : null;
      const avgWo = woVals.length ? Math.round((woVals.reduce((a, b) => a + b, 0) / woVals.length) * 100) / 100 : null;
      const delta = avgW != null && avgWo != null ? Math.round((avgW - avgWo) * 100) / 100 : null;
      let verdict = "collecting";
      if (wVals.length >= 2 && woVals.length >= 2 && delta != null) {
        if (Math.abs(delta) < 0.15) verdict = "neutral";
        else if (expSign == null) verdict = delta > 0 ? "positive" : "negative";
        else verdict = delta * expSign > 0 ? "confirmed" : "surprising";
      }
      return {
        edge_id: edgeId,
        source_id: srcId,
        source_name: activeById[srcId].name,
        target_id: dstId,
        target_name: activeById[dstId].name,
        context_window: win,
        expected_weight: expSign,
        note,
        days_with: wVals.length,
        days_without: woVals.length,
        avg_with: avgW,
        avg_without: avgWo,
        delta,
        verdict,
      };
    }

    const hyps = [];
    const rollupPairs = new Set();
    const hypPairs = new Set();
    for (const e of edges) {
      if (!activeById[e.source_id] || !activeById[e.target_id]) continue;
      if (e.relation_type === "rollup") rollupPairs.add(`${e.source_id}::${e.target_id}`);
      if (e.relation_type === "hypothesis") {
        hypPairs.add(`${e.source_id}::${e.target_id}::${e.context_window}`);
        hyps.push(evalPair(e.source_id, e.target_id, e.context_window, Number(e.weight), e.note || "", e.id));
      }
    }

    const discovered = [];
    if (observedDays.length >= 3) {
      for (const s of activeHabits) {
        for (const t of activeHabits) {
          if (s.id === t.id || rollupPairs.has(`${s.id}::${t.id}`) || hypPairs.has(`${s.id}::${t.id}::any`)) continue;
          const r = evalPair(s.id, t.id, "any", null);
          if ((r.verdict === "positive" || r.verdict === "negative") && Math.abs(r.delta || 0) >= 0.35) {
            discovered.push(r);
          }
        }
      }
      discovered.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    }

    const calibration = [];
    const errs = [];
    for (const h of activeHabits) {
      const vals = observedDays.map((d) => (byDayEff[d] && byDayEff[d][h.id]) || 0);
      const actual = vals.length ? vals[vals.length - 1] : 0;
      const pred = vals.length > 1 ? Math.round((vals.slice(0, -1).reduce((a, b) => a + b, 0) / (vals.length - 1)) * 100) / 100 : (h.target ? h.target * 0.5 : 0);
      const err = Math.round(Math.abs(pred - actual) * 100) / 100;
      if (vals.length) errs.push(err);
      calibration.push({
        habit_id: h.id,
        habit_name: h.name,
        color: h.color,
        ai_predicted: pred,
        actual,
        error: err,
      });
    }

    // Multi-Scale Befinden Curves (24h Today + 14 Days + 8 Weeks) with Browser Liquid Relaxation ODE ("Uhrwerk")
    const pad2 = (n) => String(n).padStart(2, "0");
    const fmtIso = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
    const isoWeekNum = (dt) => {
      const tmp = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
      const dayNum = tmp.getUTCDay() || 7;
      tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
      return Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
    };

    const curveDates = [];
    for (let i = 13; i >= -1; i--) {
      curveDates.push(fmtIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
    }
    const todayIsoLocal = fmtIso(now);
    const todayMidnightHr = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime() / 3600000;
    const h24Offsets = Array.from({ length: 49 }, (_, i) => i * 0.5);
    const h24TimesHr = h24Offsets.map((off) => todayMidnightHr + off);

    const habitIdsList = activeHabits.map((h) => h.id);
    const hidToCol = Object.fromEntries(habitIdsList.map((id, idx) => [id, idx]));
    const parsedEvs = [];
    for (const ev of liveEvents) {
      if (hidToCol[ev.habit_id] == null || Number(ev.amount) <= 0) continue;
      const ms = new Date(ev.occurred_at).getTime();
      if (Number.isNaN(ms)) continue;
      const hObj = activeById[ev.habit_id];
      parsedEvs.push({
        tHr: ms / 3600000,
        col: hidToCol[ev.habit_id],
        hid: ev.habit_id,
        amt: Number(ev.amount),
        iso: ev.occurred_at,
        name: hObj.name,
        color: hObj.color,
      });
    }
    parsedEvs.sort((a, b) => a.tHr - b.tHr);

    const todayHabitTicks = parsedEvs
      .filter((e) => e.iso.slice(0, 10) === todayIsoLocal)
      .map((e) => ({
        hour: Math.round((e.tHr - todayMidnightHr) * 100) / 100,
        time: e.iso.slice(11, 16),
        habit_id: e.hid,
        habit_name: e.name,
        color: e.color,
        amount: Math.round(e.amt * 100) / 100,
      }));

    function buildPhiJS(qHours, tauH) {
      const p = 1 + habitIdsList.length;
      const maxDt = tauH * 5.0;
      return qHours.map((tq) => {
        const row = new Array(p).fill(0);
        row[0] = 1.0;
        for (const ev of parsedEvs) {
          const dt = tq - ev.tHr;
          if (dt < 0) break;
          if (dt <= maxDt) row[1 + ev.col] += ev.amt * Math.exp(-dt / tauH);
        }
        return row;
      });
    }

    function solveLinSys(mat, rhs) {
      const n = rhs.length;
      const M = mat.map((r, i) => [...r, rhs[i]]);
      for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) {
          if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        }
        if (Math.abs(M[piv][col]) < 1e-10) return null;
        if (piv !== col) [M[col], M[piv]] = [M[piv], M[col]];
        const div = M[col][col];
        for (let j = col; j <= n; j++) M[col][j] /= div;
        for (let r = 0; r < n; r++) {
          if (r === col) continue;
          const fac = M[r][col];
          for (let j = col; j <= n; j++) M[r][j] -= fac * M[col][j];
        }
      }
      return M.map((r) => r[n]);
    }

    function fitLiquidOdeJS(dimSnaps) {
      const p = 1 + habitIdsList.length;
      const theta0 = new Array(p).fill(0);
      if (!dimSnaps.length) return { tau: 6.0, theta: theta0 };
      const ys = dimSnaps.map((s) => s.val);
      const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
      theta0[0] = meanY;
      if (dimSnaps.length < 2) return { tau: 6.0, theta: theta0 };

      const qTimes = dimSnaps.map((s) => s.tHr);
      let bestTau = 6.0;
      let bestTheta = theta0;
      let bestErr = Infinity;
      const lam = 1.8;

      for (const tauCand of [2.0, 6.0, 18.0, 48.0]) {
        const Phi = buildPhiJS(qTimes, tauCand);
        const A = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => (i === j && i > 0 ? lam : 0)));
        const b = new Array(p).fill(0);
        for (let k = 0; k < Phi.length; k++) {
          const row = Phi[k];
          for (let i = 0; i < p; i++) {
            b[i] += row[i] * ys[k];
            for (let j = 0; j < p; j++) A[i][j] += row[i] * row[j];
          }
        }
        const th = solveLinSys(A, b);
        if (!th) continue;
        let mse = 0;
        for (let k = 0; k < Phi.length; k++) {
          let pred = 0;
          for (let i = 0; i < p; i++) pred += Phi[k][i] * th[i];
          mse += Math.pow(ys[k] - pred, 2);
        }
        mse /= Phi.length;
        if (mse < bestErr) {
          bestErr = mse;
          bestTau = tauCand;
          bestTheta = th;
        }
      }
      return { tau: bestTau, theta: bestTheta };
    }

    function evalOdeJS(qHours, tauH, theta) {
      const Phi = buildPhiJS(qHours, tauH);
      return Phi.map((row) => {
        let v = 0;
        for (let i = 0; i < theta.length; i++) v += row[i] * theta[i];
        return Math.round(Math.max(1, Math.min(5, v)) * 100) / 100;
      });
    }

    const d14EvalHours = curveDates.map((dStr) => {
      const [yy, mm, dd] = dStr.split("-").map(Number);
      return new Date(yy, mm - 1, dd, 18, 0, 0).getTime() / 3600000;
    });
    const curWd = (now.getDay() + 6) % 7;
    const curWeekMon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - curWd);
    const w8Starts = [];
    const w8Labels = [];
    for (let i = 7; i >= 0; i--) {
      const ws = new Date(curWeekMon.getFullYear(), curWeekMon.getMonth(), curWeekMon.getDate() - i * 7);
      w8Starts.push(ws);
      w8Labels.push(`KW ${pad2(isoWeekNum(ws))}`);
    }

    const snapAcc = {};
    const snapsByDim = {};
    for (const s of db.snapshots.filter((x) => !x.deleted_at)) {
      const d = s.occurred_at.slice(0, 10);
      const ms = new Date(s.occurred_at).getTime();
      snapAcc[d] ||= {};
      for (const [k, v] of Object.entries(s.ratings || {})) {
        if (v != null) {
          (snapAcc[d][k] ||= []).push(Number(v));
          if (!Number.isNaN(ms)) {
            (snapsByDim[k] ||= []).push({ tHr: ms / 3600000, val: Number(v), iso: s.occurred_at, note: s.note || "" });
          }
        }
      }
    }

    const stateCurves = db.state_dimensions
      .filter((d) => !d.archived)
      .map((dim) => {
        const dimSnaps = (snapsByDim[dim.id] || []).sort((a, b) => a.tHr - b.tHr);
        const actual14 = curveDates.map((dStr) => {
          const vals = snapAcc[dStr] && snapAcc[dStr][dim.id];
          return vals && vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;
        });
        const ratedPts = actual14.map((v, idx) => (v != null ? [idx, v] : null)).filter(Boolean);
        let tabpfn14 = new Array(curveDates.length).fill(null);
        if (ratedPts.length === 1) {
          tabpfn14 = new Array(curveDates.length).fill(ratedPts[0][1]);
        } else if (ratedPts.length >= 2) {
          const meanV = ratedPts.reduce((a, [, v]) => a + v, 0) / ratedPts.length;
          tabpfn14 = curveDates.map((_, idx) => {
            let num = 0.15 * meanV;
            let den = 0.15;
            for (const [ri, rv] of ratedPts) {
              const w = Math.exp(-Math.pow((idx - ri) / 2.6, 2));
              num += w * rv;
              den += w;
            }
            return Math.round(Math.max(1, Math.min(5, num / den)) * 100) / 100;
          });
        } else if (dimSnaps.length) {
          const meanAll = Math.round((dimSnaps.reduce((a, s) => a + s.val, 0) / dimSnaps.length) * 100) / 100;
          tabpfn14 = new Array(curveDates.length).fill(meanAll);
        }

        const { tau: tauH, theta } = fitLiquidOdeJS(dimSnaps);
        const ode24 = dimSnaps.length ? evalOdeJS(h24TimesHr, tauH, theta) : [];
        const ode14 = dimSnaps.length ? evalOdeJS(d14EvalHours, tauH, theta) : new Array(curveDates.length).fill(null);
        const actual24 = dimSnaps
          .filter((s) => s.iso.slice(0, 10) === todayIsoLocal)
          .map((s) => ({
            hour: Math.round((s.tHr - todayMidnightHr) * 100) / 100,
            time: s.iso.slice(11, 16),
            value: Math.round(s.val * 100) / 100,
            note: s.note,
          }));
        const todayTp = tabpfn14.length >= 2 ? tabpfn14[tabpfn14.length - 2] : null;
        let tabpfn24 = [];
        if (actual24.length >= 2) {
          const mean24 = actual24.reduce((a, p) => a + p.value, 0) / actual24.length;
          tabpfn24 = h24Offsets.map((hr) => {
            let num = 0.12 * mean24;
            let den = 0.12;
            for (const p of actual24) {
              const w = Math.exp(-Math.pow((hr - p.hour) / 2.8, 2));
              num += w * p.value;
              den += w;
            }
            return Math.round(Math.max(1, Math.min(5, num / den)) * 100) / 100;
          });
        } else if (todayTp != null) {
          tabpfn24 = new Array(h24Offsets.length).fill(todayTp);
        }

        const w8Actual = [];
        const w8Tabpfn = [];
        const w8Ode = [];
        for (const ws of w8Starts) {
          const wVals = [];
          const wHrs = [];
          for (let k = 0; k < 7; k++) {
            const dDt = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + k);
            const dIso = fmtIso(dDt);
            const vs = snapAcc[dIso] && snapAcc[dIso][dim.id];
            if (vs && vs.length) wVals.push(vs.reduce((a, b) => a + b, 0) / vs.length);
            wHrs.push(new Date(dDt.getFullYear(), dDt.getMonth(), dDt.getDate(), 18, 0, 0).getTime() / 3600000);
          }
          w8Actual.push(wVals.length ? Math.round((wVals.reduce((a, b) => a + b, 0) / wVals.length) * 100) / 100 : null);
          if (dimSnaps.length) {
            const ov = evalOdeJS(wHrs, tauH, theta);
            w8Ode.push(Math.round((ov.reduce((a, b) => a + b, 0) / ov.length) * 100) / 100);
            w8Tabpfn.push(wVals.length ? w8Actual[w8Actual.length - 1] : todayTp);
          } else {
            w8Ode.push(null);
            w8Tabpfn.push(null);
          }
        }

        return {
          id: dim.id,
          name: dim.name,
          low_label: dim.low_label || "",
          high_label: dim.high_label || "",
          rated_count: dimSnaps.length,
          ode_tau_hours: tauH,
          dates: curveDates,
          actual: actual14,
          ai_curve: tabpfn14,
          h24: {
            hours: h24Offsets,
            actual: actual24,
            tabpfn: tabpfn24,
            ode: ode24,
            habit_ticks: todayHabitTicks,
          },
          d14: {
            dates: curveDates,
            actual: actual14,
            tabpfn: tabpfn14,
            ode: ode14,
          },
          w8: {
            labels: w8Labels,
            actual: w8Actual,
            tabpfn: w8Tabpfn,
            ode: w8Ode,
          },
        };
      });

      const tagStats = computeTagStats(db);
      const liveSnapsCount = db.snapshots.filter((x) => !x.deleted_at).length;
      return {
      observed_days: observedDays.length,
      last7_dates: last7,
      week_matrix: weekMatrix,
      rhythms,
      hypotheses: hyps,
      discovered: discovered.slice(0, 5),
      ai: {
        engine: "browser-local",
        engine_label: "Lokal im Browser",
        status: "ready",
        observed_days: observedDays.length,
        nudge_mode: db.settings.nudge_mode || "observed",
        tomorrow,
        calibration,
        overall_mae: errs.length ? Math.round((errs.reduce((a, b) => a + b, 0) / errs.length) * 100) / 100 : null,
        assumptions: [],
        state_curves: stateCurves,
        live_nudges: {},
        feature_audit: {
          habits_count: allHabits.length,
          state_dims_count: db.state_dimensions.filter((d) => !d.archived).length,
          observed_days: observedDays.length,
          events_count: liveEvents.length,
          snapshots_count: liveSnapsCount,
          active_tags: tagStats.filter((x) => x.ai_active),
          pending_tags: tagStats.filter((x) => !x.ai_active),
        },
      },
    };
  }

  function exportCsv(db) {
    const activeHabits = db.habits.filter((h) => !h.archived);
    const byId = Object.fromEntries(db.habits.map((h) => [h.id, h]));
    const dims = db.state_dimensions.filter((d) => !d.archived);
    const edges = enrichEdges(db);
    const byDayDirect = {};
    const byDayWins = {};
    for (const ev of db.events.filter((e) => !e.deleted_at)) {
      const d = ev.occurred_at.slice(0, 10);
      byDayDirect[d] ||= {};
      byDayDirect[d][ev.habit_id] = (byDayDirect[d][ev.habit_id] || 0) + Number(ev.amount);
      if (Number(ev.amount) > 0) {
        byDayWins[d] ||= {};
        (byDayWins[d][ev.habit_id] ||= new Set()).add(classifyWindow(ev.occurred_at));
      }
    }
    const snapAcc = {};
    for (const s of db.snapshots.filter((x) => !x.deleted_at)) {
      const d = s.occurred_at.slice(0, 10);
      snapAcc[d] ||= {};
      for (const [k, v] of Object.entries(s.ratings || {})) {
        (snapAcc[d][k] ||= []).push(Number(v));
      }
    }
    const days = Array.from(new Set([...Object.keys(byDayDirect), ...Object.keys(snapAcc)])).sort();
    const cols = ["date", "weekday"];
    for (const h of activeHabits) {
      cols.push(`${h.id}__direct`, `${h.id}__effective`, `${h.id}__morning`, `${h.id}__afternoon`, `${h.id}__evening`, `${h.id}__night`);
    }
    for (const d of dims) cols.push(`state__${d.id}`);
    const lines = [cols.join(",")];
    for (const dStr of days) {
      const direct = {};
      db.habits.forEach((h) => { direct[h.id] = (byDayDirect[dStr] && byDayDirect[dStr][h.id]) || 0; });
      const { routed } = computeRollups(direct, byId, edges);
      const wd = (new Date(`${dStr}T12:00:00`).getDay() + 6) % 7;
      const row = [dStr, wd];
      for (const h of activeHabits) {
        const w = (byDayWins[dStr] && byDayWins[dStr][h.id]) || new Set();
        row.push(
          Math.round(direct[h.id] * 1000) / 1000,
          Math.round((direct[h.id] + (routed[h.id] || 0)) * 1000) / 1000,
          w.has("morning") ? 1 : 0,
          w.has("afternoon") ? 1 : 0,
          w.has("evening") ? 1 : 0,
          w.has("night") ? 1 : 0
        );
      }
      for (const d of dims) {
        const vals = snapAcc[dStr] && snapAcc[dStr][d.id];
        row.push(vals && vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : "");
      }
      lines.push(row.join(","));
    }
    return lines.join("\n") + "\n";
  }

  function handleLocalApi(url, opts = {}) {
    const db = loadDB();
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : {};
    const u = new URL(url, "http://daily.local");
    const path = u.pathname;

    if (path === "/api/health") return { status: "ok", mode: "browser-local" };
    if (path === "/api/today") return computeToday(db, u.searchParams.get("day"));
    if (path === "/api/log" && method === "GET") {
      const endParam = (u.searchParams.get("end") || todayStr()).slice(0, 10);
      const startParam = (u.searchParams.get("start") || shiftDayStr(endParam, -6)).slice(0, 10);
      const sIso = startParam <= endParam ? startParam : endParam;
      const eIso = startParam <= endParam ? endParam : startParam;
      const byId = Object.fromEntries(db.habits.map((h) => [h.id, h]));
      const events = db.events
        .filter((ev) => !ev.deleted_at && ev.occurred_at.slice(0, 10) >= sIso && ev.occurred_at.slice(0, 10) <= eIso)
        .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.id - a.id)
        .map((ev) => enrichEvent(ev, byId));
      const snapshots = db.snapshots
        .filter((sn) => !sn.deleted_at && sn.occurred_at.slice(0, 10) >= sIso && sn.occurred_at.slice(0, 10) <= eIso)
        .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.id - a.id);
      return {
        start: sIso,
        end: eIso,
        events,
        snapshots,
        state_dimensions: [...db.state_dimensions],
        habits: [...db.habits],
      };
    }
    if (path === "/api/analysis") return computeAnalysis(db);
    if (path === "/api/settings" && method === "GET") return db.settings;
    if (path === "/api/settings" && method === "PATCH") {
      Object.entries(body).forEach(([k, v]) => { if (v != null) db.settings[k] = String(v); });
      saveDB(db);
      return db.settings;
    }
    if (path === "/api/sync/info") {
      return { standalone: true, primary_url: window.location.origin, qr_svg: "", sync_token: "" };
    }
    if (path === "/api/sync" && method === "POST") {
      return { server_time: nowIso(), applied: { events: 0, snapshots: 0 } };
    }
    if (path === "/api/nudge/test" && method === "POST") {
      return { sent: false, nudge_mode: db.settings.nudge_mode || "observed" };
    }

    // Habits
    if (path === "/api/habits" && method === "GET") {
      const inc = u.searchParams.get("include_archived") === "true";
      const habits = [...db.habits]
        .filter((h) => inc || !h.archived)
        .sort((a, b) => (a.archived - b.archived) || ((a.sort_order ?? 0) - (b.sort_order ?? 0)));
      return { habits, edges: enrichEdges(db), settings: db.settings, tags: computeTagStats(db) };
    }
    if (path === "/api/habits" && method === "POST") {
      const name = (body.name || "").trim();
      if (!name) throw new Error("Name darf nicht leer sein");
      if (db.habits.some((h) => h.name.toLowerCase() === name.toLowerCase())) throw new Error("Habit existiert bereits");
      let hid = slugify(name);
      let sfx = 2;
      while (db.habits.some((h) => h.id === hid)) hid = `${slugify(name)}-${sfx++}`;
      const period = ["day", "week", "month"].includes(body.target_period) ? body.target_period : "day";
      const h = {
        id: hid,
        name,
        kind: body.kind || "neutral",
        target: body.target != null ? Number(body.target) : null,
        target_period: period,
        unit: (body.unit || "x").trim() || "x",
        color: body.color || "#2563eb",
        nudge_enabled: body.nudge_enabled ? 1 : 0,
        nudge_lead_min: Number(body.nudge_lead_min || 20),
        nudge_alternatives: (body.nudge_alternatives || "").trim(),
        reminder_time: (body.reminder_time || "").trim(),
        reminder_days: body.reminder_days || "0,1,2,3,4,5,6",
        block_minutes: body.block_minutes != null && Number(body.block_minutes) > 0 ? Math.max(1, Math.min(720, Math.round(Number(body.block_minutes)))) : null,
        active_since: null,
        sort_order: db.habits.length,
        archived: 0,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.habits.push(h);
      saveDB(db);
      return h;
    }
    if (path === "/api/habits/reorder" && method === "POST") {
      const ts = nowIso();
      (body.habit_ids || []).forEach((hid, idx) => {
        const h = db.habits.find((x) => x.id === hid);
        if (h) {
          h.sort_order = idx;
          h.updated_at = ts;
        }
      });
      saveDB(db);
      return { habits: db.habits.filter((h) => !h.archived).sort((a, b) => a.sort_order - b.sort_order) };
    }
    const mMerge = path.match(/^\/api\/habits\/([^/]+)\/merge$/);
    if (mMerge && method === "POST") {
      const srcId = decodeURIComponent(mMerge[1]);
      const dstId = body.target_id;
      const src = db.habits.find((h) => h.id === srcId);
      const dst = db.habits.find((h) => h.id === dstId);
      if (!src || !dst || srcId === dstId) throw new Error("Ungültige Zusammenführung");
      let moved = 0;
      for (const ev of db.events) {
        if (ev.habit_id === srcId) {
          ev.habit_id = dstId;
          if (body.tag_notes && !String(ev.note || "").trim()) ev.note = `aus: ${src.name}`;
          moved++;
        }
      }
      for (const sn of db.snapshots) {
        if (sn.causes && sn.causes.includes(srcId)) {
          sn.causes = Array.from(new Set(sn.causes.map((c) => (c === srcId ? dstId : c))));
        }
      }
      for (const e of db.edges) {
        const ns = e.source_id === srcId ? dstId : e.source_id;
        const nt = e.target_id === srcId ? dstId : e.target_id;
        if (ns !== nt && !db.edges.some((x) => x.source_id === ns && x.target_id === nt && x.relation_type === e.relation_type && x.context_window === e.context_window)) {
          e.source_id = ns;
          e.target_id = nt;
        }
      }
      db.edges = db.edges.filter((e) => e.source_id !== srcId && e.target_id !== srcId && e.source_id !== e.target_id);
      db.habits = db.habits.filter((h) => h.id !== srcId);
      saveDB(db);
      return { merged: true, source_name: src.name, target_name: dst.name, moved_events: moved };
    }
    const mToggle = path.match(/^\/api\/habits\/([^/]+)\/toggle-active$/);
    if (mToggle && method === "POST") {
      const hid = decodeURIComponent(mToggle[1]);
      const h = db.habits.find((x) => x.id === hid);
      if (!h) throw new Error("Habit nicht gefunden");
      const nowStr = (body.now_at || nowIso()).slice(0, 19);
      if (!h.active_since) {
        h.active_since = nowStr;
        h.updated_at = nowIso();
        saveDB(db);
        return { active: true, active_since: nowStr, habit: h };
      }
      const prevSince = h.active_since;
      h.active_since = null;
      h.updated_at = nowIso();
      if (body.cancel) {
        saveDB(db);
        return { active: false, logged: false, habit: h };
      }
      let elapsedMin = 0;
      if (body.override_minutes != null) {
        elapsedMin = Number(body.override_minutes);
        if (!Number.isFinite(elapsedMin) || elapsedMin < 1) {
          saveDB(db);
          return { active: false, logged: false, too_short: true, elapsed_minutes: 0, habit: h };
        }
      } else {
        const ms = new Date(nowStr).getTime() - new Date(prevSince).getTime();
        if (Number.isFinite(ms)) {
          const rawMin = ms / 60000;
          if (rawMin < 1) {
            saveDB(db);
            return { active: false, logged: false, too_short: true, elapsed_minutes: 0, habit: h };
          }
          elapsedMin = rawMin;
        } else {
          elapsedMin = Number(h.block_minutes || 30);
        }
      }
      const blockM = Math.max(1, Number(h.block_minutes || 30));
      const amount = Math.max(0.1, Math.round((elapsedMin / blockM) * 10) / 10);
      const winMin = Math.max(1, Math.round(elapsedMin));
      const ts = nowIso();
      const ev = {
        id: db.next_id++,
        habit_id: hid,
        amount,
        occurred_at: nowStr,
        window_minutes: winMin,
        source: "tap",
        note: "",
        client_uuid: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
      };
      db.events.push(ev);
      saveDB(db);
      return { active: false, logged: true, elapsed_minutes: winMin, amount, event: ev, habit: h };
    }
    const mHab = path.match(/^\/api\/habits\/([^/]+)$/);
    if (mHab && method === "PATCH") {
      const hid = decodeURIComponent(mHab[1]);
      const h = db.habits.find((x) => x.id === hid);
      if (!h) throw new Error("Habit nicht gefunden");
      if (body.clear_target) h.target = null;
      if (body.clear_block_minutes) h.block_minutes = null;
      ["name", "kind", "target", "target_period", "unit", "color", "nudge_lead_min", "nudge_alternatives", "reminder_time", "reminder_days", "active_since", "sort_order"].forEach((k) => {
        if (body[k] !== undefined) h[k] = body[k];
      });
      if (body.block_minutes !== undefined) {
        h.block_minutes = body.block_minutes != null && Number(body.block_minutes) > 0 ? Math.max(1, Math.min(720, Math.round(Number(body.block_minutes)))) : null;
      }
      if (body.nudge_enabled !== undefined) h.nudge_enabled = body.nudge_enabled ? 1 : 0;
      if (body.archived !== undefined) h.archived = body.archived ? 1 : 0;
      h.updated_at = nowIso();
      saveDB(db);
      return h;
    }
    if (mHab && method === "DELETE") {
      const hid = decodeURIComponent(mHab[1]);
      db.habits = db.habits.filter((x) => x.id !== hid);
      db.edges = db.edges.filter((e) => e.source_id !== hid && e.target_id !== hid);
      db.events = db.events.filter((ev) => ev.habit_id !== hid);
      saveDB(db);
      return { deleted: true, id: hid };
    }

    // Edges
    if (path === "/api/edges" && method === "POST") {
      if (body.source_id === body.target_id) throw new Error("Ein Habit kann nicht auf sich selbst routen");
      const rt = body.relation_type || "rollup";
      const win = body.context_window || "any";
      const existing = db.edges.find((e) => e.source_id === body.source_id && e.target_id === body.target_id && e.relation_type === rt && e.context_window === win);
      if (existing) {
        existing.weight = Number(body.weight);
        existing.note = (body.note || "").trim();
        existing.updated_at = nowIso();
        saveDB(db);
        return existing;
      }
      const edge = {
        id: db.next_id++,
        source_id: body.source_id,
        target_id: body.target_id,
        relation_type: rt,
        weight: Number(body.weight),
        context_window: win,
        note: (body.note || "").trim(),
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.edges.push(edge);
      saveDB(db);
      return edge;
    }
    const mEdge = path.match(/^\/api\/edges\/(\d+)$/);
    if (mEdge && method === "DELETE") {
      const eid = Number(mEdge[1]);
      db.edges = db.edges.filter((e) => e.id !== eid);
      saveDB(db);
      return { deleted: true, id: eid };
    }

    // Events
    if (path === "/api/events" && method === "POST") {
      const ev = {
        id: db.next_id++,
        habit_id: body.habit_id,
        amount: Number(body.amount ?? 1),
        occurred_at: body.occurred_at || nowIso(),
        window_minutes: Number(body.window_minutes || 0),
        source: body.source || "tap",
        note: (body.note || "").trim(),
        client_uuid: body.client_uuid || `loc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        created_at: nowIso(),
        updated_at: nowIso(),
        deleted_at: null,
      };
      db.events.push(ev);
      saveDB(db);
      return ev;
    }
    if (path === "/api/events/retro" && method === "POST") {
      const items = (body.items || []).filter((it) => Number(it.amount) !== 0);
      const endDt = body.end_at ? new Date(body.end_at) : new Date();
      const win = Math.max(15, Math.min(720, Number(body.window_minutes || 180)));
      const startMs = endDt.getTime() - win * 60000;
      const p = (n) => String(n).padStart(2, "0");
      const created = items.map((it, idx) => {
        const dt = new Date(startMs + ((idx + 0.5) / items.length) * win * 60000);
        const iso = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
        const ts = nowIso();
        const ev = {
          id: db.next_id++,
          habit_id: it.habit_id,
          amount: Number(it.amount),
          occurred_at: iso,
          window_minutes: win,
          source: "retro",
          note: (it.note || body.note || "").trim(),
          client_uuid: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `retro-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
          created_at: ts,
          updated_at: ts,
          deleted_at: null,
        };
        db.events.push(ev);
        return ev;
      });
      saveDB(db);
      return { count: created.length, events: created };
    }
    const mEv = path.match(/^\/api\/events\/(\d+)$/);
    if (mEv && method === "PATCH") {
      const id = Number(mEv[1]);
      const ev = db.events.find((x) => x.id === id);
      if (!ev) throw new Error("Eintrag nicht gefunden");
      ["amount", "occurred_at", "window_minutes", "note"].forEach((k) => { if (body[k] !== undefined) ev[k] = body[k]; });
      ev.updated_at = nowIso();
      saveDB(db);
      return ev;
    }
    if (mEv && method === "DELETE") {
      const id = Number(mEv[1]);
      const ev = db.events.find((x) => x.id === id);
      if (ev) {
        ev.deleted_at = nowIso();
        ev.updated_at = nowIso();
      }
      saveDB(db);
      return { deleted: true, id };
    }

    // State Dimensions & Snapshots
    if (path === "/api/state/dimensions" && method === "GET") {
      const inc = u.searchParams.get("include_archived") === "true";
      return { dimensions: db.state_dimensions.filter((d) => inc || !d.archived) };
    }
    if (path === "/api/state/dimensions" && method === "POST") {
      const name = (body.name || "").trim();
      if (!name) throw new Error("Name fehlt");
      const ex = db.state_dimensions.find((d) => d.name.toLowerCase() === name.toLowerCase());
      if (ex) { ex.archived = 0; saveDB(db); return ex; }
      const dim = {
        id: slugify(name),
        name,
        low_label: (body.low_label || "").trim(),
        high_label: (body.high_label || "").trim(),
        sort_order: db.state_dimensions.length,
        archived: 0,
        created_at: nowIso(),
      };
      db.state_dimensions.push(dim);
      saveDB(db);
      return dim;
    }
    const mDim = path.match(/^\/api\/state\/dimensions\/([^/]+)$/);
    if (mDim && method === "PATCH") {
      const did = decodeURIComponent(mDim[1]);
      const d = db.state_dimensions.find((x) => x.id === did);
      if (!d) throw new Error("Achse nicht gefunden");
      if (body.archived !== undefined) d.archived = body.archived ? 1 : 0;
      saveDB(db);
      return d;
    }
    if (path === "/api/snapshots" && method === "POST") {
      const sn = {
        id: db.next_id++,
        client_uuid: body.client_uuid || `sn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        occurred_at: body.occurred_at || nowIso(),
        ratings: body.ratings || {},
        causes: body.causes || [],
        note: (body.note || "").trim(),
        created_at: nowIso(),
        updated_at: nowIso(),
        deleted_at: null,
      };
      db.snapshots.push(sn);
      saveDB(db);
      return sn;
    }
    const mSn = path.match(/^\/api\/snapshots\/(\d+)$/);
    if (mSn && method === "DELETE") {
      const sid = Number(mSn[1]);
      const sn = db.snapshots.find((x) => x.id === sid);
      if (sn) {
        sn.deleted_at = nowIso();
        sn.updated_at = nowIso();
      }
      saveDB(db);
      return { deleted: true, id: sid };
    }

    throw new Error(`Unbekannter lokaler Endpunkt: ${method} ${path}`);
  }

  window.DailyLocalEngine = {
    isStaticHost() {
      const host = window.location.hostname || "";
      const hasCustomServer = !!(localStorage.getItem("daily_server_url") || "").trim();
      return !hasCustomServer && (host.endsWith("aethelburg.network") || host.endsWith("github.io"));
    },
    request: handleLocalApi,
    getRawDB: loadDB,
    setRawDB: saveDB,
    exportJson() {
      return JSON.stringify(loadDB(), null, 2);
    },
    importJson(raw) {
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.habits) || !Array.isArray(parsed.events)) {
        throw new Error("Ungültige Daily-Backup-Datei");
      }
      saveDB(parsed);
      return parsed;
    },
    exportCsv() {
      return exportCsv(loadDB());
    },
  };
})();

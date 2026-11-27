"""Cycle-safe signed-graph rollup engine, modest pattern analytics & TabPFN feature export."""
from __future__ import annotations

import csv
import io
import re
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

_NOTE_TAG_RE = re.compile(r"(?<!\w)#([a-zA-Z0-9äöüÄÖÜß_-]{2,24})")


def extract_note_tags(note: str | None) -> set[str]:
    """Extract normalized lowercase #tags from free-text event/snapshot notes for tabular ML."""
    if not note:
        return set()
    return {m.group(1).lower() for m in _NOTE_TAG_RE.finditer(note)}


def compute_note_tag_stats(
    events: list[dict[str, Any]],
    snapshots: list[dict[str, Any]] | None = None,
    limit: int = 24,
    days_window: int = 60,
) -> list[dict[str, Any]]:
    """Count distinct local days per #tag within a rolling recency window (old abandoned tags fade out naturally)."""
    cutoff = (date.today() - timedelta(days=max(1, days_window) - 1)).isoformat() if days_window > 0 else ""
    by_day: dict[str, set[str]] = defaultdict(set)
    last_seen: dict[str, str] = {}
    for obj in (*events, *(snapshots or [])):
        if obj.get("deleted_at") or not obj.get("note"):
            continue
        tags = extract_note_tags(obj.get("note"))
        if not tags:
            continue
        day_iso = str(obj.get("occurred_at") or "")[:10]
        if len(day_iso) != 10 or (cutoff and day_iso < cutoff):
            continue
        by_day[day_iso].update(tags)
        for tg in tags:
            if day_iso > last_seen.get(tg, ""):
                last_seen[tg] = day_iso
    counts = Counter(t for tags in by_day.values() for t in tags)
    # Prefer frequency first, then most recently used, then alphabetical
    ordered = sorted(
        counts.items(),
        key=lambda kv: (
            -kv[1],
            "" if not last_seen.get(kv[0]) else "".join(chr(255 - ord(c)) for c in last_seen[kv[0]]),
            kv[0],
        ),
    )
    return [{"tag": t, "days": int(c), "ai_active": c >= 2, "last_day": last_seen.get(t, "")} for t, c in ordered[:limit]]

from .db import (
    DEFAULT_DB_PATH,
    get_last_used_map,
    list_edges,
    list_events,
    list_habits,
    list_log_range,
    list_snapshots,
    list_state_dimensions,
    today_str,
)


def classify_time_window(dt: datetime) -> str:
    h = dt.hour
    if 5 <= h < 12:
        return "morning"
    if 12 <= h < 17:
        return "afternoon"
    if 17 <= h < 22:
        return "evening"
    return "night"


def compute_signed_rollups(
    direct_totals: dict[str, float],
    habits_by_id: dict[str, dict[str, Any]],
    edges: list[dict[str, Any]],
    max_depth: int = 8,
) -> tuple[dict[str, float], dict[str, list[dict[str, Any]]]]:
    """Propagate signed (+/-) rollup edges safely across arbitrary graphs (cycle-proof per path)."""
    adj: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e in edges:
        if e["relation_type"] == "rollup":
            adj[e["source_id"]].append(e)

    routed: dict[str, float] = {hid: 0.0 for hid in habits_by_id}
    contrib_map: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    contrib_ai: dict[str, dict[str, bool]] = defaultdict(lambda: defaultdict(bool))
    contrib_via: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))

    def dfs(origin_id: str, cur_id: str, val: float, path: set[str], depth: int, via_ai: bool) -> None:
        if depth >= max_depth or abs(val) < 1e-9:
            return
        for edge in adj.get(cur_id, []):
            nxt = edge["target_id"]
            if nxt in path or nxt not in habits_by_id:
                continue
            w = float(edge["weight"])
            # Prevent double-negative sign reversals (- x - = +):
            # A deficit/penalty on B (val < 0) propagates to positive parents of B (e.g. Sport -> +Upgrade),
            # but must never flip across a negative edge (Sport -> -Laundry) to conjure phantom positive progress.
            if val < 0 and w < 0:
                continue
            delta = val * w
            is_ai_step = via_ai or bool(edge.get("is_ai"))
            routed[nxt] = routed.get(nxt, 0.0) + delta
            contrib_map[nxt][origin_id] += delta
            if cur_id != origin_id:
                contrib_via[nxt][origin_id].add(habits_by_id[cur_id]["name"])
            if is_ai_step:
                contrib_ai[nxt][origin_id] = True
            dfs(origin_id, nxt, delta, path | {nxt}, depth + 1, is_ai_step)

    for src_id, dval in direct_totals.items():
        if abs(dval) > 1e-9 and src_id in habits_by_id:
            dfs(src_id, src_id, dval, {src_id}, 0, False)

    contributors: dict[str, list[dict[str, Any]]] = {}
    for hid in habits_by_id:
        items = []
        for from_id, delta in contrib_map.get(hid, {}).items():
            if abs(delta) > 1e-6:
                items.append(
                    {
                        "from_id": from_id,
                        "from_name": habits_by_id[from_id]["name"],
                        "delta": round(delta, 2),
                        "is_ai": bool(contrib_ai[hid].get(from_id, False)),
                        "via": sorted(contrib_via[hid].get(from_id, set())),
                    }
                )
        items.sort(key=lambda x: abs(x["delta"]), reverse=True)
        contributors[hid] = items

    return {k: round(v, 2) for k, v in routed.items()}, contributors


def evaluate_goal_status(habit: dict[str, Any], effective: float) -> str:
    kind = habit["kind"]
    target = habit.get("target")
    if target is None or kind == "neutral":
        return "neutral"
    t = float(target)
    if kind == "min":
        if effective >= t:
            return "met"
        if effective > 0:
            return "in_progress"
        return "pending"
    # kind == "max"
    if effective > t:
        return "exceeded"
    if t > 0 and effective >= t * 0.8:
        return "warning"
    return "within_limit"


def compute_day_summary(
    day: str | None = None,
    db_path: Path = DEFAULT_DB_PATH,
    override_edges: list[dict[str, Any]] | None = None,
    routing_mode: str = "observed",
) -> dict[str, Any]:
    target_day = day or today_str()
    all_habits = list_habits(include_archived=True, db_path=db_path)
    active_habits = [h for h in all_habits if not h.get("archived")]
    habits_by_id = {h["id"]: h for h in all_habits}
    edges = override_edges if override_edges is not None else list_edges(db_path=db_path)
    day_events = list_events(day=target_day, db_path=db_path)
    last_used = get_last_used_map(db_path=db_path)

    direct: dict[str, float] = {h["id"]: 0.0 for h in all_habits}
    counts: dict[str, int] = {h["id"]: 0 for h in all_habits}
    for ev in day_events:
        hid = ev["habit_id"]
        if hid in direct:
            direct[hid] += float(ev["amount"])
            counts[hid] += 1

    routed, contributors = compute_signed_rollups(direct, habits_by_id, edges)

    # Compute fast cadence & current time-of-day fit signals for Smart ("Jetzt") Today sorting
    active_ids = {h["id"] for h in active_habits}
    all_hist_events = list_events(db_path=db_path)
    target_d_obj = date.fromisoformat(target_day)
    now_hr = datetime.now().hour
    hist_days_by_h: dict[str, set[str]] = defaultdict(set)
    hist_hours_by_h: dict[str, list[int]] = defaultdict(lambda: [0] * 24)
    hist_total_by_h: dict[str, int] = defaultdict(int)
    for ev in all_hist_events:
        if float(ev["amount"]) <= 0:
            continue
        eh = ev["habit_id"]
        if eh not in active_ids:
            continue
        ts_str = str(ev.get("occurred_at") or "")
        if len(ts_str) < 13:
            continue
        hist_days_by_h[eh].add(ts_str[:10])
        try:
            hr_i = int(ts_str[11:13])
            if 0 <= hr_i <= 23:
                hist_hours_by_h[eh][hr_i] += 1
        except ValueError:
            pass
        hist_total_by_h[eh] += 1

    # Period totals (week / month) for habits with target_period != 'day'
    period_eff_map: dict[str, float] = {}
    has_non_daily = any((h.get("target_period") or "day") != "day" for h in active_habits)
    if has_non_daily:
        d_obj = target_d_obj
        week_start = (d_obj - timedelta(days=d_obj.weekday())).isoformat()
        week_end = (d_obj + timedelta(days=6 - d_obj.weekday())).isoformat()
        month_start = d_obj.replace(day=1).isoformat()
        next_m = (d_obj.replace(day=28) + timedelta(days=4)).replace(day=1)
        month_end = (next_m - timedelta(days=1)).isoformat()

        week_direct: dict[str, float] = {h["id"]: 0.0 for h in all_habits}
        month_direct: dict[str, float] = {h["id"]: 0.0 for h in all_habits}
        for ev in all_hist_events:
            eh = ev["habit_id"]
            if eh not in week_direct:
                continue
            ed = ev["occurred_at"][:10]
            amt = float(ev["amount"])
            if week_start <= ed <= week_end:
                week_direct[eh] += amt
            if month_start <= ed <= month_end:
                month_direct[eh] += amt
        week_routed, _ = compute_signed_rollups(week_direct, habits_by_id, edges)
        month_routed, _ = compute_signed_rollups(month_direct, habits_by_id, edges)
        for h in active_habits:
            hid = h["id"]
            per = h.get("target_period") or "day"
            if per == "week":
                period_eff_map[hid] = round(week_direct[hid] + week_routed.get(hid, 0.0), 2)
            elif per == "month":
                period_eff_map[hid] = round(month_direct[hid] + month_routed.get(hid, 0.0), 2)

    outgoing_rollups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e in edges:
        if e["relation_type"] == "rollup" and e["target_id"] in active_ids:
            outgoing_rollups[e["source_id"]].append(
                {
                    "id": e.get("id"),
                    "target_id": e["target_id"],
                    "target_name": e["target_name"],
                    "weight": e["weight"],
                    "is_ai": bool(e.get("is_ai")),
                    "prior_weight": e.get("prior_weight"),
                    "ai_window": e.get("ai_window"),
                }
            )

    cards: list[dict[str, Any]] = []
    for h in active_habits:
        hid = h["id"]
        d_val = round(direct[hid], 2)
        r_val = round(routed.get(hid, 0.0), 2)
        eff = round(d_val + r_val, 2)
        per = h.get("target_period") or "day"
        p_eff = period_eff_map.get(hid, eff)

        # Cadence metrics (median interval between distinct logged days + days since last/created)
        sorted_days = sorted(hist_days_by_h.get(hid, set()))
        days_since_last: int | None = None
        median_interval_days: float | None = None
        if sorted_days:
            past_or_today = [d_s for d_s in sorted_days if d_s <= target_day]
            ref_last = past_or_today[-1] if past_or_today else sorted_days[-1]
            days_since_last = max(0, (target_d_obj - date.fromisoformat(ref_last)).days)
            if len(sorted_days) >= 2:
                gaps = sorted(
                    (date.fromisoformat(sorted_days[i]) - date.fromisoformat(sorted_days[i - 1])).days
                    for i in range(1, len(sorted_days))
                )
                mid = len(gaps) // 2
                median_interval_days = float(gaps[mid]) if len(gaps) % 2 == 1 else round((gaps[mid - 1] + gaps[mid]) / 2.0, 2)

        days_since_created = 0
        c_str = str(h.get("created_at") or "")
        if len(c_str) >= 10:
            try:
                days_since_created = max(0, (target_d_obj - date.fromisoformat(c_str[:10])).days)
            except ValueError:
                days_since_created = 0

        # Smooth circular time-of-day density at now_hr (+/- 2h window)
        h_hist = hist_hours_by_h.get(hid)
        hour_fit = 0.0
        if h_hist and sum(h_hist) > 0:
            smooth24 = [
                h_hist[hr]
                + 0.65 * (h_hist[(hr - 1) % 24] + h_hist[(hr + 1) % 24])
                + 0.30 * (h_hist[(hr - 2) % 24] + h_hist[(hr + 2) % 24])
                for hr in range(24)
            ]
            mx_s = max(smooth24)
            if mx_s > 0:
                hour_fit = round(smooth24[now_hr] / mx_s, 3)

        cards.append(
            {
                **h,
                "target_period": per,
                "direct": d_val,
                "routed": r_val,
                "effective": eff,
                "period_effective": p_eff,
                "event_count": counts[hid],
                "total_events": hist_total_by_h.get(hid, 0),
                "days_since_last": days_since_last,
                "median_interval_days": median_interval_days,
                "days_since_created": days_since_created,
                "hour_fit": hour_fit,
                "last_used_at": last_used.get(hid),
                "status": evaluate_goal_status(h, p_eff),
                "contributors": contributors.get(hid, []),
                "routes_to": outgoing_rollups.get(hid, []),
            }
        )

    return {
        "day": target_day,
        "routing_mode": routing_mode,
        "active_edges": [e for e in edges if e["relation_type"] == "rollup" and e["source_id"] in active_ids and e["target_id"] in active_ids],
        "habits": cards,
        "events": day_events,
        "snapshots": list_snapshots(day=target_day, db_path=db_path),
        "state_dimensions": list_state_dimensions(db_path=db_path),
    }


def _extract_circular_peaks(scores: list[float], raw_vals: list[float] | None = None, min_sep: int = 3, rel_thresh: float = 0.52, min_abs: float = 0.18, max_peaks: int = 3) -> list[int]:
    """Find up to max_peaks circular local maxima on a 24h clock, at least min_sep hours apart."""
    n = len(scores)
    if n != 24:
        return []
    top = max(scores)
    if top < min_abs:
        return []
    cutoff = max(min_abs, top * rel_thresh)
    cands: list[tuple[float, int]] = []
    for hr in range(24):
        if raw_vals is not None and raw_vals[hr] <= 0:
            continue
        v = scores[hr]
        if v < cutoff:
            continue
        prev_v = scores[(hr - 1) % 24]
        next_v = scores[(hr + 1) % 24]
        if v >= prev_v and v >= next_v and (v > prev_v or v > next_v or v == top):
            cands.append((v, hr))
    cands.sort(key=lambda x: (-x[0], x[1]))
    picked: list[int] = []
    for _v, hr in cands:
        if all(min((hr - p) % 24, (p - hr) % 24) >= min_sep for p in picked):
            picked.append(hr)
            if len(picked) >= max_peaks:
                break
    return sorted(picked)


def compute_hourly_peaks(
    habits: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Compute 24-hour distribution & multi-modal trigger peaks (up to 3) per habit."""
    buckets: dict[str, list[int]] = {h["id"]: [0] * 24 for h in habits}
    minute_sums: dict[str, dict[int, list[int]]] = {h["id"]: defaultdict(list) for h in habits}

    for ev in events:
        hid = ev["habit_id"]
        if hid not in buckets or float(ev["amount"]) <= 0:
            continue
        dt = datetime.fromisoformat(ev["occurred_at"])
        buckets[hid][dt.hour] += 1
        minute_sums[hid][dt.hour].append(dt.minute)

    out: dict[str, dict[str, Any]] = {}
    for h in habits:
        hid = h["id"]
        hist = buckets[hid]
        total = sum(hist)
        peak_hour = None
        peak_minute = 0
        peak_count = 0
        peak_hours: list[int] = []
        peak_times: list[str] = []
        nudge_time_str = None
        if total >= 1:
            smooth = [hist[hr] + 0.35 * hist[(hr - 1) % 24] + 0.35 * hist[(hr + 1) % 24] for hr in range(24)]
            peak_hours = _extract_circular_peaks(smooth, raw_vals=[float(x) for x in hist], min_sep=3, rel_thresh=0.52, min_abs=0.5, max_peaks=3)
            if not peak_hours:
                best_hr = max((hr for hr in range(24) if hist[hr] > 0), key=lambda hr: smooth[hr])
                peak_hours = [best_hr]
            # Primary peak (strongest smoothed bucket) kept for backwards compatibility
            peak_hour = max(peak_hours, key=lambda hr: smooth[hr])
            peak_count = hist[peak_hour]
            for hr in peak_hours:
                ms = minute_sums[hid][hr]
                mm = int(round(sum(ms) / len(ms))) if ms else 0
                peak_times.append(f"{hr:02d}:{mm:02d}")
            mins = minute_sums[hid][peak_hour]
            peak_minute = int(round(sum(mins) / len(mins))) if mins else 0
            lead = int(h.get("nudge_lead_min") or 20)
            peak_total_min = (peak_hour * 60 + peak_minute - lead) % (24 * 60)
            nh, nm = divmod(peak_total_min, 60)
            nudge_time_str = f"{nh:02d}:{nm:02d}"

        out[hid] = {
            "habit_id": hid,
            "habit_name": h["name"],
            "kind": h["kind"],
            "color": h["color"],
            "total_events": total,
            "hours": hist,
            "peak_hour": peak_hour,
            "peak_time": f"{peak_hour:02d}:{peak_minute:02d}" if peak_hour is not None else None,
            "peak_hours": peak_hours,
            "peak_times": peak_times,
            "peak_count": peak_count,
            "nudge_time": nudge_time_str,
            "nudge_enabled": bool(h.get("nudge_enabled")),
            "nudge_lead_min": int(h.get("nudge_lead_min") or 20),
            "nudge_alternatives": h.get("nudge_alternatives") or "",
        }
    return out


def compute_week_matrix(
    end_day: str | None = None,
    span_days: int = 7,
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    """Compute a fast 7-day habit matrix (incl. signed +/- rollups) ending on any date."""
    today = date.today()
    end_d = date.fromisoformat(end_day[:10]) if end_day else today
    if end_d > today:
        end_d = today
    span = max(1, min(14, int(span_days)))
    dates = [(end_d - timedelta(days=i)).isoformat() for i in range(span - 1, -1, -1)]
    all_habits = list_habits(include_archived=True, db_path=db_path)
    habits = [h for h in all_habits if not h.get("archived")]
    all_by_id = {h["id"]: h for h in all_habits}
    edges = list_edges(db_path=db_path)
    events = list_log_range(dates[0], dates[-1], db_path=db_path)["events"]

    by_day_direct: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for ev in events:
        hid = ev["habit_id"]
        if hid not in all_by_id:
            continue
        d_str = str(ev["occurred_at"])[:10]
        by_day_direct[d_str][hid] += float(ev["amount"])

    by_day_eff: dict[str, dict[str, float]] = {}
    for d_str in dates:
        direct = {hid: by_day_direct[d_str].get(hid, 0.0) for hid in all_by_id}
        routed, _ = compute_signed_rollups(direct, all_by_id, edges)
        by_day_eff[d_str] = {hid: round(direct[hid] + routed.get(hid, 0.0), 2) for hid in all_by_id}

    week_matrix: list[dict[str, Any]] = []
    for h in habits:
        hid = h["id"]
        cells = []
        for d_str in dates:
            eff = by_day_eff.get(d_str, {}).get(hid, 0.0)
            cells.append({"day": d_str, "effective": eff, "status": evaluate_goal_status(h, eff)})
        week_matrix.append(
            {
                "habit_id": hid,
                "name": h["name"],
                "kind": h["kind"],
                "target": h["target"],
                "unit": h["unit"],
                "color": h["color"],
                "days": cells,
            }
        )

    return {
        "start": dates[0],
        "end": dates[-1],
        "is_latest": end_d >= today,
        "dates": dates,
        "week_matrix": week_matrix,
    }


def compute_analysis_board(days: int = 30, db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    """Modest, zero-overfit analysis board: 7-day grid, hourly rhythm, hypotheses vs reality & ML readiness."""
    all_habits = list_habits(include_archived=True, db_path=db_path)
    habits = [h for h in all_habits if not h.get("archived")]
    all_by_id = {h["id"]: h for h in all_habits}
    habits_by_id = {h["id"]: h for h in habits}
    edges = list_edges(db_path=db_path)
    events = list_events(days_back=days, db_path=db_path)

    # Group events by local date (including archived children so parent goals preserve full history!)
    by_day_direct: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    by_day_windows: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for ev in events:
        hid = ev["habit_id"]
        if hid not in all_by_id:
            continue
        dt = datetime.fromisoformat(ev["occurred_at"])
        d_str = dt.date().isoformat()
        amt = float(ev["amount"])
        by_day_direct[d_str][hid] += amt
        if amt > 0:
            by_day_windows[d_str][hid].add("any")
            by_day_windows[d_str][hid].add(classify_time_window(dt))

    # Effective totals per observed day across full graph (archived children still roll up into active parents!)
    observed_days = sorted(by_day_direct.keys())
    by_day_effective: dict[str, dict[str, float]] = {}
    for d_str in observed_days:
        direct = {hid: by_day_direct[d_str].get(hid, 0.0) for hid in all_by_id}
        routed, _ = compute_signed_rollups(direct, all_by_id, edges)
        by_day_effective[d_str] = {hid: round(direct[hid] + routed.get(hid, 0.0), 2) for hid in all_by_id}

    # 1. Last 7 days compact matrix
    today = date.today()
    last7_dates = [(today - timedelta(days=i)).isoformat() for i in range(6, -1, -1)]
    week_matrix: list[dict[str, Any]] = []
    for h in habits:
        hid = h["id"]
        cells = []
        for d_str in last7_dates:
            eff = by_day_effective.get(d_str, {}).get(hid, 0.0)
            cells.append(
                {
                    "day": d_str,
                    "effective": eff,
                    "status": evaluate_goal_status(h, eff),
                }
            )
        week_matrix.append(
            {
                "habit_id": hid,
                "name": h["name"],
                "kind": h["kind"],
                "target": h["target"],
                "unit": h["unit"],
                "color": h["color"],
                "days": cells,
            }
        )

    # 2. Hourly rhythms (last 14 days for sharp current trigger timing)
    cutoff_14 = (today - timedelta(days=13)).isoformat()
    recent_events = [ev for ev in events if ev["occurred_at"][:10] >= cutoff_14]
    rhythms = compute_hourly_peaks(habits, recent_events)

    # 3. Hypotheses vs Reality (evaluate user's explicit assumptions honestly!)
    def eval_pair(src_id: str, dst_id: str, window: str, expected_sign: float | None, note: str = "", edge_id: int | None = None) -> dict[str, Any]:
        vals_with: list[float] = []
        vals_without: list[float] = []
        for d_str in observed_days:
            has_src = window in by_day_windows[d_str].get(src_id, set())
            dst_val = by_day_effective[d_str].get(dst_id, 0.0)
            if has_src:
                vals_with.append(dst_val)
            else:
                vals_without.append(dst_val)

        n_with = len(vals_with)
        n_without = len(vals_without)
        avg_with = round(sum(vals_with) / n_with, 2) if n_with else None
        avg_without = round(sum(vals_without) / n_without, 2) if n_without else None
        delta = round(avg_with - avg_without, 2) if (avg_with is not None and avg_without is not None) else None

        if n_with < 2 or n_without < 2 or delta is None:
            verdict = "collecting"
        elif abs(delta) < 0.15:
            verdict = "neutral"
        elif expected_sign is None:
            verdict = "positive" if delta > 0 else "negative"
        elif (delta > 0 and expected_sign > 0) or (delta < 0 and expected_sign < 0):
            verdict = "confirmed"
        else:
            verdict = "surprising"

        return {
            "edge_id": edge_id,
            "source_id": src_id,
            "source_name": habits_by_id[src_id]["name"],
            "target_id": dst_id,
            "target_name": habits_by_id[dst_id]["name"],
            "context_window": window,
            "expected_weight": expected_sign,
            "note": note,
            "days_with": n_with,
            "days_without": n_without,
            "avg_with": avg_with,
            "avg_without": avg_without,
            "delta": delta,
            "verdict": verdict,
        }

    hypotheses_eval: list[dict[str, Any]] = []
    rollup_pairs: set[tuple[str, str]] = set()
    hyp_pairs: set[tuple[str, str, str]] = set()
    for e in edges:
        if e["source_id"] not in habits_by_id or e["target_id"] not in habits_by_id:
            continue
        if e["relation_type"] == "rollup":
            rollup_pairs.add((e["source_id"], e["target_id"]))
        elif e["relation_type"] == "hypothesis":
            hyp_pairs.add((e["source_id"], e["target_id"], e["context_window"]))
            hypotheses_eval.append(
                eval_pair(e["source_id"], e["target_id"], e["context_window"], float(e["weight"]), e.get("note", ""), e["id"])
            )

    # 4. Modest Auto-Observed Conditional Patterns (top 5 non-trivial pairs across observed days)
    discovered: list[dict[str, Any]] = []
    if len(observed_days) >= 4:
        for s_id in habits_by_id:
            for t_id in habits_by_id:
                if s_id == t_id or (s_id, t_id) in rollup_pairs or (s_id, t_id, "any") in hyp_pairs:
                    continue
                res = eval_pair(s_id, t_id, "any", None)
                if res["verdict"] in {"positive", "negative"} and abs(res["delta"] or 0.0) >= 0.35:
                    discovered.append(res)
        discovered.sort(key=lambda x: abs(x["delta"] or 0.0), reverse=True)
        discovered = discovered[:5]

    # 5. Per-habit empirical counterfactuals ("With vs. Without" on Mood dimensions + non-rollup habits)
    dims = [d for d in list_state_dimensions(db_path=db_path) if not d.get("archived")]
    snaps = list_snapshots(days_back=days, db_path=db_path)
    snap_acc: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for sn in snaps:
        d_str = datetime.fromisoformat(sn["occurred_at"]).date().isoformat()
        for did, val in (sn.get("ratings") or {}).items():
            if val is not None:
                snap_acc[d_str][str(did)].append(float(val))
    snap_means: dict[str, dict[str, float]] = {
        d_str: {did: sum(vals) / len(vals) for did, vals in dmap.items() if vals}
        for d_str, dmap in snap_acc.items()
    }

    habit_counterfactuals: dict[str, dict[str, Any]] = {}
    for s_id in habits_by_id:
        n_with_any = sum(1 for d_str in observed_days if "any" in by_day_windows[d_str].get(s_id, set()))
        n_without_any = len(observed_days) - n_with_any
        effects: list[dict[str, Any]] = []

        # 5a. Habit -> Mood/State dimensions (comparing rated days with vs. without s_id)
        for dim in dims:
            did = dim["id"]
            w_vals: list[float] = []
            wo_vals: list[float] = []
            for d_str in observed_days:
                sv = snap_means.get(d_str, {}).get(did)
                if sv is None:
                    continue
                if "any" in by_day_windows[d_str].get(s_id, set()):
                    w_vals.append(sv)
                else:
                    wo_vals.append(sv)
            if len(w_vals) >= 2 and len(wo_vals) >= 2:
                avg_w = round(sum(w_vals) / len(w_vals), 2)
                avg_wo = round(sum(wo_vals) / len(wo_vals), 2)
                delta = round(avg_w - avg_wo, 2)
                if abs(delta) >= 0.25:
                    effects.append(
                        {
                            "source_id": s_id,
                            "source_name": habits_by_id[s_id]["name"],
                            "target_id": f"state:{did}",
                            "target_name": dim["name"],
                            "is_state_target": True,
                            "context_window": "any",
                            "avg_with": avg_w,
                            "avg_without": avg_wo,
                            "delta": delta,
                            "days_with": len(w_vals),
                            "days_without": len(wo_vals),
                            "source_kind": "empirical",
                        }
                    )

        # 5b. Habit -> Non-rollup Habits (best window or "any" per target)
        if len(observed_days) >= 4:
            for t_id in habits_by_id:
                if t_id == s_id or (s_id, t_id) in rollup_pairs:
                    continue
                best_eff: dict[str, Any] | None = None
                for win in ("morning", "afternoon", "evening", "night", "any"):
                    res = eval_pair(s_id, t_id, win, None)
                    if res["verdict"] not in {"positive", "negative"}:
                        continue
                    d_val = abs(res["delta"] or 0.0)
                    if d_val < 0.30:
                        continue
                    score = d_val * (1.1 if win != "any" else 1.0)
                    if best_eff is None or score > best_eff["_score"]:
                        best_eff = {
                            "source_id": s_id,
                            "source_name": res["source_name"],
                            "target_id": t_id,
                            "target_name": res["target_name"],
                            "is_state_target": False,
                            "context_window": win,
                            "avg_with": res["avg_with"],
                            "avg_without": res["avg_without"],
                            "delta": res["delta"],
                            "days_with": res["days_with"],
                            "days_without": res["days_without"],
                            "source_kind": "empirical",
                            "_score": score,
                        }
                if best_eff is not None:
                    best_eff.pop("_score", None)
                    effects.append(best_eff)

        effects.sort(key=lambda e: abs(e["delta"]) * (1.3 if e["is_state_target"] else 1.0), reverse=True)
        habit_counterfactuals[s_id] = {
            "days_with": n_with_any,
            "days_without": n_without_any,
            "effects": effects[:4],
        }

    return {
        "observed_days": len(observed_days),
        "ml_target_days": 14,
        "ml_ready": len(observed_days) >= 14,
        "last7_dates": last7_dates,
        "week_matrix": week_matrix,
        "rhythms": list(rhythms.values()),
        "hypotheses": hypotheses_eval,
        "discovered": discovered,
        "habit_counterfactuals": habit_counterfactuals,
    }


def export_tabpfn_features_csv(db_path: Path = DEFAULT_DB_PATH) -> str:
    """Export clean tabular daily features (direct + effective + time-window flags + sparse state NaNs)."""
    habits = list_habits(include_archived=False, db_path=db_path)
    habits_by_id = {h["id"]: h for h in habits}
    edges = list_edges(db_path=db_path)
    events = list_events(db_path=db_path)
    dims = list_state_dimensions(db_path=db_path)
    snaps = list_snapshots(db_path=db_path)

    by_day_direct: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    by_day_windows: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    by_day_tags: dict[str, set[str]] = defaultdict(set)
    for ev in events:
        hid = ev["habit_id"]
        if hid not in habits_by_id:
            continue
        dt = datetime.fromisoformat(ev["occurred_at"])
        d_str = dt.date().isoformat()
        amt = float(ev["amount"])
        by_day_direct[d_str][hid] += amt
        if amt > 0:
            by_day_windows[d_str][hid].add(classify_time_window(dt))
        by_day_tags[d_str].update(extract_note_tags(ev.get("note")))

    snap_acc: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for s in snaps:
        d_str = datetime.fromisoformat(s["occurred_at"]).date().isoformat()
        by_day_tags[d_str].update(extract_note_tags(s.get("note")))
        for did, val in (s.get("ratings") or {}).items():
            if val is not None:
                snap_acc[d_str][str(did)].append(float(val))

    tag_day_counts = Counter(t for tags in by_day_tags.values() for t in tags)
    active_tags = [t for t, c in tag_day_counts.most_common(20) if c >= 2]

    days = sorted(set(by_day_direct.keys()) | set(snap_acc.keys()))
    buf = io.StringIO()
    cols = ["date", "weekday"]
    for h in habits:
        hid = h["id"]
        cols.extend(
            [
                f"{hid}__direct",
                f"{hid}__effective",
                f"{hid}__morning",
                f"{hid}__afternoon",
                f"{hid}__evening",
                f"{hid}__night",
            ]
        )
    for d in dims:
        cols.append(f"state__{d['id']}")
    for tag in active_tags:
        cols.append(f"tag__{tag}")
    writer = csv.writer(buf)
    writer.writerow(cols)
    for d_str in days:
        direct = {hid: by_day_direct[d_str].get(hid, 0.0) for hid in habits_by_id}
        routed, _ = compute_signed_rollups(direct, habits_by_id, edges)
        row: list[Any] = [d_str, date.fromisoformat(d_str).weekday()]
        for h in habits:
            hid = h["id"]
            wins = by_day_windows[d_str].get(hid, set())
            row.extend(
                [
                    round(direct[hid], 3),
                    round(direct[hid] + routed.get(hid, 0.0), 3),
                    1 if "morning" in wins else 0,
                    1 if "afternoon" in wins else 0,
                    1 if "evening" in wins else 0,
                    1 if "night" in wins else 0,
                ]
            )
        for d in dims:
            vals = snap_acc.get(d_str, {}).get(d["id"])
            row.append(round(sum(vals) / len(vals), 2) if vals else "")
        d_tags = by_day_tags.get(d_str, set())
        for tag in active_tags:
            row.append(1 if tag in d_tags else 0)
        writer.writerow(row)
    return buf.getvalue()

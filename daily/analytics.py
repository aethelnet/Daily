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

    def dfs(origin_id: str, cur_id: str, val: float, path: set[str], depth: int, via_ai: bool) -> None:
        if depth >= max_depth or abs(val) < 1e-9:
            return
        for edge in adj.get(cur_id, []):
            nxt = edge["target_id"]
            if nxt in path or nxt not in habits_by_id:
                continue
            delta = val * float(edge["weight"])
            is_ai_step = via_ai or bool(edge.get("is_ai"))
            routed[nxt] = routed.get(nxt, 0.0) + delta
            contrib_map[nxt][origin_id] += delta
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

    # Period totals (week / month) for habits with target_period != 'day'
    period_eff_map: dict[str, float] = {}
    has_non_daily = any((h.get("target_period") or "day") != "day" for h in active_habits)
    if has_non_daily:
        d_obj = date.fromisoformat(target_day)
        week_start = (d_obj - timedelta(days=d_obj.weekday())).isoformat()
        week_end = (d_obj + timedelta(days=6 - d_obj.weekday())).isoformat()
        month_start = d_obj.replace(day=1).isoformat()
        next_m = (d_obj.replace(day=28) + timedelta(days=4)).replace(day=1)
        month_end = (next_m - timedelta(days=1)).isoformat()

        span_events = list_events(db_path=db_path)
        week_direct: dict[str, float] = {h["id"]: 0.0 for h in all_habits}
        month_direct: dict[str, float] = {h["id"]: 0.0 for h in all_habits}
        for ev in span_events:
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

    active_ids = {h["id"] for h in active_habits}
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
        cards.append(
            {
                **h,
                "target_period": per,
                "direct": d_val,
                "routed": r_val,
                "effective": eff,
                "period_effective": p_eff,
                "event_count": counts[hid],
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


def compute_hourly_peaks(
    habits: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Compute 24-hour distribution & strongest trigger peak per habit."""
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
        nudge_time_str = None
        if total >= 1:
            # Smooth 2-hour sliding preference to pick peak hour (active from the very first entry!)
            best_score = -1.0
            for hr in range(24):
                score = hist[hr] + 0.35 * hist[(hr - 1) % 24] + 0.35 * hist[(hr + 1) % 24]
                if hist[hr] > 0 and score > best_score:
                    best_score = score
                    peak_hour = hr
                    peak_count = hist[hr]
            if peak_hour is not None:
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
            "peak_count": peak_count,
            "nudge_time": nudge_time_str,
            "nudge_enabled": bool(h.get("nudge_enabled")),
            "nudge_lead_min": int(h.get("nudge_lead_min") or 20),
            "nudge_alternatives": h.get("nudge_alternatives") or "",
        }
    return out


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

    return {
        "observed_days": len(observed_days),
        "ml_target_days": 14,
        "ml_ready": len(observed_days) >= 14,
        "last7_dates": last7_dates,
        "week_matrix": week_matrix,
        "rhythms": list(rhythms.values()),
        "hypotheses": hypotheses_eval,
        "discovered": discovered,
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

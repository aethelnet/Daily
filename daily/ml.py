"""Local Tabular AI engine for Daily (TabPFN v2 on CPU + automatic XGBoost fallback).

Design principles:
- 100% local, zero cloud, zero login (cached open Apache-2.0 TabPFN v2 weights).
- Predicts right from Day 1 — no artificial warmup lockouts! If the model is wrong
  early on, the user sees the prediction vs. actual error directly and watches
  accuracy improve naturally as real days accumulate.
- Produces:
  1) Tomorrow 24h probability curve + peak hour per habit (TabPFN vs. observed peak)
  2) Prediction vs. Actual error comparison (Leave-One-Day-Out from Day 2+, baseline Day 1)
  3) Pairwise behavioral assumptions marked explicitly as KI-Annahme
  4) Live contextual 2h probabilities for AI-driven notifications
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import warnings
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

try:
    import numpy as np
except ImportError:
    np = None  # type: ignore[assignment]

from .analytics import _extract_circular_peaks, classify_time_window, compute_signed_rollups, extract_note_tags

DEFAULT_TABPFN_THRESHOLD = 0.55

CACHE_DIR = Path(os.environ.get("TABPFN_MODEL_CACHE_DIR", str(Path.home() / ".cache" / "tabpfn")))
CLF_CKPT = CACHE_DIR / "tabpfn-v2-classifier.ckpt"
REG_CKPT = CACHE_DIR / "tabpfn-v2-regressor.ckpt"

_ANALYSIS_CACHE: dict[tuple[Any, ...], dict[str, Any]] = {}
_NUDGE_CACHE: dict[tuple[Any, ...], dict[str, Any]] = {}

WINDOW_DE = {
    "any": "ganztags",
    "morning": "morgens",
    "afternoon": "nachmittags",
    "evening": "abends",
    "night": "nachts",
}


def get_ml_engine_info() -> dict[str, Any]:
    """Detect available local tabular ML engine (prefers TabPFN v2, falls back cleanly to XGBoost)."""
    if np is None:
        return {
            "engine": "none",
            "label": "Aus",
            "tabpfn_ready": False,
        }
    tabpfn_ok = False
    try:
        import tabpfn  # noqa: F401

        if (
            CLF_CKPT.is_file()
            and CLF_CKPT.stat().st_size > 1_000_000
            and REG_CKPT.is_file()
            and REG_CKPT.stat().st_size > 1_000_000
        ):
            tabpfn_ok = True
    except Exception:
        tabpfn_ok = False

    if tabpfn_ok:
        return {
            "engine": "tabpfn-v2",
            "label": "TabPFN",
            "tabpfn_ready": True,
        }

    try:
        import xgboost  # noqa: F401

        return {
            "engine": "xgboost",
            "label": "XGBoost",
            "tabpfn_ready": False,
        }
    except Exception:
        return {
            "engine": "none",
            "label": "Aus",
            "tabpfn_ready": False,
        }


class _CoreXGBRegressor:
    """Zero-sklearn XGBoost regressor wrapper (keeps standalone binaries lean)."""

    def __init__(self) -> None:
        self._bst = None

    def fit(self, X, y):
        import xgboost as xgb

        dtrain = xgb.DMatrix(np.asarray(X, dtype=np.float32), label=np.asarray(y, dtype=np.float32))
        self._bst = xgb.train(
            {
                "objective": "reg:squarederror",
                "max_depth": 2,
                "eta": 0.12,
                "subsample": 0.85,
                "lambda": 2.0,
                "seed": 42,
                "nthread": 1,
                "verbosity": 0,
            },
            dtrain,
            num_boost_round=24,
        )
        return self

    def predict(self, X):
        import xgboost as xgb

        return self._bst.predict(xgb.DMatrix(np.asarray(X, dtype=np.float32)))


class _CoreXGBClassifier:
    """Zero-sklearn XGBoost binary classifier wrapper."""

    def __init__(self) -> None:
        self._bst = None

    def fit(self, X, y):
        import xgboost as xgb

        dtrain = xgb.DMatrix(np.asarray(X, dtype=np.float32), label=np.asarray(y, dtype=np.float32))
        self._bst = xgb.train(
            {
                "objective": "binary:logistic",
                "max_depth": 2,
                "eta": 0.12,
                "min_child_weight": 0.1,
                "subsample": 0.85,
                "lambda": 2.0,
                "seed": 42,
                "nthread": 1,
                "verbosity": 0,
            },
            dtrain,
            num_boost_round=24,
        )
        return self

    def predict_proba(self, X):
        import xgboost as xgb

        p1 = np.clip(self._bst.predict(xgb.DMatrix(np.asarray(X, dtype=np.float32))), 0.0, 1.0)
        return np.column_stack([1.0 - p1, p1])


def _make_regressor(engine: str):
    if engine == "tabpfn-v2":
        from tabpfn import TabPFNRegressor

        return TabPFNRegressor(
            device="cpu",
            model_path=str(REG_CKPT),
            n_estimators=2,
            ignore_pretraining_limits=True,
        )
    if engine == "xgboost":
        return _CoreXGBRegressor()
    raise RuntimeError("No tabular ML engine available")


def _make_classifier(engine: str):
    if engine == "tabpfn-v2":
        from tabpfn import TabPFNClassifier

        return TabPFNClassifier(
            device="cpu",
            model_path=str(CLF_CKPT),
            n_estimators=2,
            ignore_pretraining_limits=True,
        )
    if engine == "xgboost":
        return _CoreXGBClassifier()
    raise RuntimeError("No tabular ML engine available")


def _build_daily_tables(
    habits: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> tuple[list[str], dict[str, dict[str, float]], dict[str, dict[str, float]], dict[str, dict[str, set[str]]]]:
    habits_by_id = {h["id"]: h for h in habits}
    by_day_direct: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    by_day_windows: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))

    for ev in events:
        hid = ev["habit_id"]
        if hid not in habits_by_id:
            continue
        dt = datetime.fromisoformat(ev["occurred_at"])
        d_str = dt.date().isoformat()
        amt = float(ev["amount"])
        by_day_direct[d_str][hid] += amt
        if amt > 0:
            by_day_windows[d_str][hid].add("any")
            by_day_windows[d_str][hid].add(classify_time_window(dt))

    observed_days = sorted(by_day_direct.keys())
    by_day_effective: dict[str, dict[str, float]] = {}
    for d_str in observed_days:
        direct = {hid: by_day_direct[d_str].get(hid, 0.0) for hid in habits_by_id}
        routed, _ = compute_signed_rollups(direct, habits_by_id, edges)
        by_day_effective[d_str] = {hid: round(direct[hid] + routed.get(hid, 0.0), 3) for hid in habits_by_id}

    return observed_days, by_day_direct, by_day_effective, by_day_windows


def invalidate_ml_caches() -> None:
    """Clear in-memory TabPFN / Liquid ODE / nudge caches immediately."""
    _ANALYSIS_CACHE.clear()
    _NUDGE_CACHE.clear()


def _data_signature(
    habits: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    events: list[dict[str, Any]],
    snapshots: list[dict[str, Any]] | None = None,
    state_dims: list[dict[str, Any]] | None = None,
) -> str:
    """Exact content digest over all live inputs so ANY retroactive edit, time shift,
    note/#tag change, habit/edge edit, or deletion immediately invalidates TabPFN & Liquid ODE caches."""
    live_events = [ev for ev in events if not ev.get("deleted_at")]
    live_snaps = [s for s in (snapshots or []) if not s.get("deleted_at")]
    payload = {
        "h": [
            (
                h.get("id"),
                h.get("name"),
                h.get("kind"),
                bool(h.get("archived")),
                bool(h.get("nudge_enabled")),
                h.get("nudge_lead_min"),
                h.get("sort_order", 0),
            )
            for h in habits
        ],
        "e": [
            (
                e.get("id"),
                e.get("source_id"),
                e.get("target_id"),
                e.get("relation_type"),
                round(float(e.get("weight", 0.0)), 4),
                e.get("context_window"),
            )
            for e in edges
        ],
        "ev": [
            (
                ev.get("id"),
                ev.get("habit_id"),
                round(float(ev.get("amount", 0.0)), 4),
                ev.get("occurred_at"),
                int(ev.get("window_minutes") or 0),
                ev.get("note") or "",
                ev.get("updated_at") or "",
            )
            for ev in live_events
        ],
        "sn": [
            (
                s.get("id"),
                s.get("occurred_at"),
                sorted((str(k), round(float(v), 2)) for k, v in (s.get("ratings") or {}).items() if v is not None),
                list(s.get("causes") or []),
                s.get("note") or "",
                s.get("updated_at") or "",
            )
            for s in live_snaps
        ],
        "sd": [
            (d.get("id"), d.get("name"), d.get("low_label") or "", d.get("high_label") or "", d.get("color") or "", bool(d.get("archived")))
            for d in (state_dims or [])
        ],
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.blake2b(raw, digest_size=16).hexdigest()


def _nonconst_mask(X: np.ndarray) -> np.ndarray:
    """Boolean mask of columns with >= 2 non-NaN observations and non-zero variance (NaN-safe for TabPFN)."""
    if X.size == 0 or X.shape[0] < 2:
        return np.zeros(X.shape[1] if X.ndim == 2 else 0, dtype=bool)
    non_nan_counts = np.sum(~np.isnan(X), axis=0)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        stds = np.nanstd(X, axis=0)
    stds = np.where(np.isnan(stds), 0.0, stds)
    return (non_nan_counts >= 2) & (stds > 1e-6)


def _snapshot_daily_means(
    snapshots: list[dict[str, Any]] | None,
) -> dict[str, dict[str, float]]:
    """Aggregate sparse Momentaufnahme ratings by local day (absent days remain missing -> true NaN)."""
    acc: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for s in snapshots or []:
        try:
            d_str = datetime.fromisoformat(s["occurred_at"]).date().isoformat()
        except Exception:
            continue
        for dim_id, val in (s.get("ratings") or {}).items():
            if val is not None:
                acc[d_str][str(dim_id)].append(float(val))
    return {
        d_str: {dim_id: round(sum(vals) / len(vals), 2) for dim_id, vals in dims.items() if vals}
        for d_str, dims in acc.items()
    }


def _predict_tomorrow_hourly(
    engine: str,
    habits: list[dict[str, Any]],
    events: list[dict[str, Any]],
    today_date: date,
    now_hour: int | None = None,
    snapshots: list[dict[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    """Predict rolling next-24h likelihood curve & multi-modal peaks per habit via TabPFN from Day 1:
    - Hours >= now_hour predict LATER TODAY conditioned on actual today habits & mood so far!
    - Hours < now_hour predict TOMORROW MORNING with today's running total as previous day."""
    habits_by_id = {h["id"]: h for h in habits}
    by_day_events: dict[str, list[tuple[int, str, float]]] = defaultdict(list)
    by_day_hours: dict[str, dict[str, set[int]]] = defaultdict(lambda: defaultdict(set))
    by_day_totals: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    first_obs_dt: datetime | None = None

    for ev in events:
        hid = ev["habit_id"]
        if hid not in habits_by_id or float(ev["amount"]) <= 0:
            continue
        dt = datetime.fromisoformat(ev["occurred_at"])
        if first_obs_dt is None or dt < first_obs_dt:
            first_obs_dt = dt
        d_str = dt.date().isoformat()
        amt = float(ev["amount"])
        by_day_events[d_str].append((dt.hour, hid, amt))
        by_day_hours[d_str][hid].add(dt.hour)
        by_day_totals[d_str][hid] += amt

    by_day_moods: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for sn in snapshots or []:
        if sn.get("deleted_at"):
            continue
        vals = [float(v) for v in (sn.get("ratings") or {}).values() if v is not None]
        if not vals:
            continue
        try:
            dt = datetime.fromisoformat(sn["occurred_at"])
        except Exception:
            continue
        if first_obs_dt is None or dt < first_obs_dt:
            first_obs_dt = dt
        by_day_moods[dt.date().isoformat()].append((dt.hour, sum(vals) / len(vals)))

    observed_days = sorted(by_day_hours.keys())
    obs_set = set(observed_days)
    cur_hr = datetime.now().hour if now_hour is None else max(0, min(23, int(now_hour)))
    today_iso = today_date.isoformat()
    yesterday_iso = (today_date - timedelta(days=1)).isoformat()
    tomorrow = today_date + timedelta(days=1)
    today_wd = float(today_date.weekday())
    tomorrow_wd = float(tomorrow.weekday())

    def latest_mood_before(d_str: str, hr_cutoff: int) -> float:
        ms = [m for h_s, m in by_day_moods.get(d_str, []) if h_s <= hr_cutoff]
        return float(ms[-1]) if ms else float("nan")

    out: dict[str, dict[str, Any]] = {}
    if engine == "none" or not observed_days:
        return out

    first_day_iso = first_obs_dt.date().isoformat() if first_obs_dt else observed_days[0]
    first_day_hr = first_obs_dt.hour if first_obs_dt else 0
    # Progressive feature unlocking prevents day-ID memorization on Day 1-2:
    # - Always: circular time-of-day + today's same-habit progress so far
    # - >= 3 observed days: previous-day total, cross-habit count, and latest Mood
    # - >= 7 observed days: weekday seasonality (only repeats after a week)
    use_ctx = len(observed_days) >= 3
    use_wd = len(observed_days) >= 7

    def hour_row(
        wd: float,
        hr: int,
        prev_total: float,
        so_far_same: float,
        so_far_other: float,
        mood_val: float,
    ) -> list[float]:
        rad = 2.0 * math.pi * (hr / 24.0)
        row: list[float] = [float(hr), math.sin(rad), math.cos(rad), so_far_same]
        if use_ctx:
            row.extend([prev_total, so_far_other, mood_val])
        if use_wd:
            row.append(wd)
        return row

    # Precompute today's live state up to right now (powers "Later today" predictions!)
    today_evs = by_day_events.get(today_iso, [])
    today_latest_mood = latest_mood_before(today_iso, cur_hr)
    scopes_24 = ["today" if hr >= cur_hr else "tomorrow" for hr in range(24)]

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for h in habits:
            hid = h["id"]

            def collect_rows(apply_left_censor: bool, apply_right_censor: bool) -> tuple[list[list[float]], list[int]]:
                xr: list[list[float]] = []
                yr: list[int] = []
                for d_str in observed_days[-45:]:
                    dt_d = date.fromisoformat(d_str)
                    wd = float(dt_d.weekday())
                    prev_d = (dt_d - timedelta(days=1)).isoformat()
                    prev_tot = float(by_day_totals.get(prev_d, {}).get(hid, 0.0)) if prev_d in obs_set else float("nan")
                    hrs = by_day_hours[d_str].get(hid, set())
                    d_evs = by_day_events.get(d_str, [])
                    for hr in range(24):
                        # 2-hour smooth occurrence target so adjacent hours share signal naturally
                        hit = 1 if (hr in hrs or (hr + 1) % 24 in hrs) else 0
                        # Left-censoring: hours before the user's very first tracked timestamp were not observed
                        if apply_left_censor and d_str == first_day_iso and hr < max(0, first_day_hr - 1) and hit == 0:
                            continue
                        # Right-censoring: future/unfinished hours of today have NOT happened yet — never label y=0!
                        if apply_right_censor and d_str == today_iso and hr >= max(0, cur_hr - 1) and hit == 0:
                            continue
                        so_far_same = sum(a for eh, ehid, a in d_evs if eh < hr and ehid == hid)
                        so_far_other = float(sum(1 for eh, ehid, _a in d_evs if eh < hr and ehid != hid))
                        mood_v = latest_mood_before(d_str, hr)
                        xr.append(hour_row(wd, hr, prev_tot, so_far_same, so_far_other, mood_v))
                        yr.append(hit)
                return xr, yr

            X_rows, y_rows = collect_rows(True, True)
            if sum(1 for v in y_rows if v == 0) < 3:
                X_rows, y_rows = collect_rows(False, True)
            if sum(1 for v in y_rows if v == 0) < 3:
                X_rows, y_rows = collect_rows(False, False)

            X_train = np.array(X_rows, dtype=np.float32)
            y_train = np.array(y_rows, dtype=np.int32)

            # Build rolling next-24h query rows: hr >= cur_hr => TODAY (live context!), hr < cur_hr => TOMORROW
            today_same_now = sum(a for eh, ehid, a in today_evs if eh <= cur_hr and ehid == hid)
            today_other_now = float(sum(1 for eh, ehid, _a in today_evs if eh <= cur_hr and ehid != hid))
            yest_tot_h = float(by_day_totals.get(yesterday_iso, {}).get(hid, 0.0)) if yesterday_iso in obs_set else float("nan")
            today_tot_h = float(by_day_totals.get(today_iso, {}).get(hid, 0.0))
            X_next24 = np.array(
                [
                    hour_row(today_wd, hr, yest_tot_h, today_same_now, today_other_now, today_latest_mood)
                    if hr >= cur_hr
                    else hour_row(tomorrow_wd, hr, today_tot_h, 0.0, 0.0, float("nan"))
                    for hr in range(24)
                ],
                dtype=np.float32,
            )

            n_pos = int(np.sum(y_train == 1))
            n_neg = int(np.sum(y_train == 0))
            if n_pos == 0:
                probs = np.full(24, 0.05, dtype=np.float32)
                peak_hr = None
                peak_prob = 0.05
            elif n_neg == 0:
                probs = np.full(24, 0.95, dtype=np.float32)
                peak_hr = 12
                peak_prob = 0.95
            else:
                if n_pos == 1:
                    pos_idx = int(np.argmax(y_train == 1))
                    X_train = np.vstack([X_train, X_train[pos_idx : pos_idx + 1]])
                    y_train = np.append(y_train, 1)
                try:
                    clf = _make_classifier(engine)
                    clf.fit(X_train, y_train)
                    probs = clf.predict_proba(X_next24)[:, 1]
                except Exception:
                    probs = np.full(24, n_pos / max(1, len(y_train)), dtype=np.float32)
                # Honest low-N calibration: keep Day 1-2 confidence modest (~50-75%) without inflating quiet hours,
                # converging smoothly toward raw TabPFN probabilities as observed 24h cycles grow.
                eff_days = max(0.5, len(y_train) / 24.0)
                conf_scale = 0.62 + 0.38 * (eff_days / (eff_days + 2.0))
                probs = np.clip(probs * conf_scale, 0.01, 0.96)
                peak_hr = int(np.argmax(probs))
                peak_prob = float(probs[peak_hr])

            prob_list = [round(float(p), 3) for p in probs]
            ai_peak_hrs = (
                _extract_circular_peaks(prob_list, min_sep=3, rel_thresh=0.58, min_abs=0.14, max_peaks=3)
                if peak_hr is not None
                else []
            )
            if peak_hr is not None and not ai_peak_hrs:
                ai_peak_hrs = [peak_hr]
            ai_peaks = [
                {
                    "hour": hr,
                    "time": f"{hr:02d}:00",
                    "prob": prob_list[hr],
                    "pct": int(round(prob_list[hr] * 100)),
                    "scope": scopes_24[hr],
                }
                for hr in ai_peak_hrs
            ]

            out[hid] = {
                "habit_id": hid,
                "tomorrow_day": tomorrow.isoformat(),
                "now_hour": cur_hr,
                "ai_hours": prob_list,
                "ai_scopes": scopes_24,
                "ai_peak_hour": peak_hr,
                "ai_peak_time": f"{peak_hr:02d}:00" if peak_hr is not None else None,
                "ai_peak_pct": int(round(peak_prob * 100)) if peak_hr is not None else None,
                "ai_peaks": ai_peaks,
            }

    return out


def compute_ai_insights(
    habits: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    events: list[dict[str, Any]],
    max_suggestions: int = 6,
    snapshots: list[dict[str, Any]] | None = None,
    state_dims: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Run TabPFN v2 immediately from Day 1: tomorrow 24h forecast, prediction vs. actual error, & AI assumptions.
    Sparse Momentaufnahme ratings are injected as true NaNs (TabPFN handles missing values natively)."""
    events = [ev for ev in events if not ev.get("deleted_at")]
    snapshots = [s for s in (snapshots or []) if not s.get("deleted_at")]
    info = get_ml_engine_info()
    engine = info["engine"]
    observed_days, by_day_direct, by_day_effective, by_day_windows = _build_daily_tables(habits, edges, events)
    snap_by_day = _snapshot_daily_means(snapshots)
    # Include days that had snapshots even if no habit event was logged
    if snap_by_day:
        all_days_set = set(observed_days) | set(snap_by_day.keys())
        observed_days = sorted(all_days_set)
        habits_by_id_tmp = {h["id"]: h for h in habits}
        for d_str in observed_days:
            if d_str not in by_day_effective:
                by_day_effective[d_str] = {hid: 0.0 for hid in habits_by_id_tmp}
    n_days = len(observed_days)
    active_dims = [d for d in (state_dims or []) if not d.get("archived")]
    dim_ids = [d["id"] for d in active_dims]
    dims_by_id = {d["id"]: d for d in active_dims}

    base_meta = {
        "engine": engine,
        "engine_label": info["label"],
        "observed_days": n_days,
    }

    if engine == "none" or not habits:
        return {
            **base_meta,
            "status": "unavailable" if engine == "none" else "empty",
            "tomorrow": {},
            "calibration": [],
            "overall_mae": None,
            "assumptions": [],
            "feature_audit": {
                "habits_count": len(habits),
                "state_dims_count": len(dim_ids),
                "observed_days": n_days,
                "events_count": len(events),
                "snapshots_count": len(snapshots),
                "active_tags": [],
                "pending_tags": [],
            },
        }

    now_dt = datetime.now()
    today_d = now_dt.date()
    cache_key = ("insights", engine, today_d.isoformat(), now_dt.hour, _data_signature(habits, edges, events, snapshots, state_dims))
    if cache_key in _ANALYSIS_CACHE:
        return _ANALYSIS_CACHE[cache_key]

    # 1. Rolling next-24h hourly forecast per habit (today remaining hours conditioned on live state + tomorrow morning!)
    tomorrow_map = _predict_tomorrow_hourly(engine, habits, events, today_d, now_hour=now_dt.hour, snapshots=snapshots)

    habits_by_id = {h["id"]: h for h in habits}
    habit_ids = [h["id"] for h in habits]

    rollup_into: dict[str, set[str]] = defaultdict(set)
    saved_hyps: dict[tuple[str, str, str], float] = {}
    for e in edges:
        if e["relation_type"] == "rollup":
            rollup_into[e["target_id"]].add(e["source_id"])
        elif e["relation_type"] == "hypothesis":
            saved_hyps[(e["source_id"], e["target_id"], e["context_window"])] = float(e["weight"])

    # Extract structured #tags from event & snapshot notes (only tags seen on >= 2 days to prevent noise)
    by_day_tags: dict[str, set[str]] = defaultdict(set)
    for ev in events:
        if ev.get("note"):
            try:
                by_day_tags[datetime.fromisoformat(ev["occurred_at"]).date().isoformat()].update(extract_note_tags(ev.get("note")))
            except Exception:
                pass
    for sn in snapshots or []:
        if sn.get("note"):
            try:
                by_day_tags[datetime.fromisoformat(sn["occurred_at"]).date().isoformat()].update(extract_note_tags(sn.get("note")))
            except Exception:
                pass
    tag_counts = Counter(t for tags in by_day_tags.values() for t in tags)
    active_tags = [t for t, c in tag_counts.most_common(16) if c >= 2]
    all_tag_stats = [
        {"tag": t, "days": int(c), "ai_active": t in active_tags}
        for t, c in sorted(tag_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:24]
    ]
    feature_audit = {
        "habits_count": len(habit_ids),
        "state_dims_count": len(dim_ids),
        "observed_days": n_days,
        "events_count": len(events),
        "snapshots_count": len(snapshots),
        "active_tags": [x for x in all_tag_stats if x["ai_active"]],
        "pending_tags": [x for x in all_tag_stats if not x["ai_active"]],
    }

    windows_list = ("morning", "afternoon", "evening", "night")
    day_feats: list[dict[str, float]] = []
    for d_str in observed_days:
        dt_d = date.fromisoformat(d_str)
        prev_day = (dt_d - timedelta(days=1)).isoformat()
        row: dict[str, float] = {"weekday": float(dt_d.weekday())}
        for hid in habit_ids:
            row[f"{hid}__direct"] = float(by_day_direct[d_str].get(hid, 0.0))
            wins = by_day_windows[d_str].get(hid, set())
            for w in windows_list:
                row[f"{hid}__{w}"] = 1.0 if w in wins else 0.0
            row[f"{hid}__prev"] = float(by_day_direct.get(prev_day, {}).get(hid, 0.0))
        # Sparse Momentaufnahme features -> true NaN when not logged that day!
        for did in dim_ids:
            val_today = snap_by_day.get(d_str, {}).get(did)
            val_prev = snap_by_day.get(prev_day, {}).get(did)
            row[f"state__{did}"] = float(val_today) if val_today is not None else float("nan")
            row[f"state__{did}__prev"] = float(val_prev) if val_prev is not None else float("nan")
        # Structured #tags from free-text notes (binary 0/1 flags for TabPFN)
        d_tags = by_day_tags.get(d_str, set())
        p_tags = by_day_tags.get(prev_day, set())
        for tag in active_tags:
            row[f"tag__{tag}"] = 1.0 if tag in d_tags else 0.0
            row[f"tag__{tag}__prev"] = 1.0 if tag in p_tags else 0.0
        day_feats.append(row)

    # 2. Honest Prediction vs. Actual tracking (per habit + latest day + MAE)
    #    AND 3. Counterfactual AI assumptions (works as soon as >= 2 days exist!)
    calibration: list[dict[str, Any]] = []
    all_errors: list[float] = []
    candidates: list[dict[str, Any]] = []

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for target_id in habit_ids:
            h_obj = habits_by_id[target_id]
            y = np.array([by_day_effective[d].get(target_id, 0.0) for d in observed_days], dtype=np.float32)
            latest_actual = float(y[-1]) if n_days >= 1 else 0.0
            latest_day = observed_days[-1] if n_days >= 1 else today_d.isoformat()

            excluded_same_day = {target_id} | rollup_into.get(target_id, set())
            raw_feat_names: list[str] = ["weekday"]
            for hid in habit_ids:
                raw_feat_names.append(f"{hid}__prev")
                if hid not in excluded_same_day:
                    raw_feat_names.append(f"{hid}__direct")
                    for w in windows_list:
                        raw_feat_names.append(f"{hid}__{w}")
            for did in dim_ids:
                raw_feat_names.append(f"state__{did}")
                raw_feat_names.append(f"state__{did}__prev")
            for tag in active_tags:
                raw_feat_names.append(f"tag__{tag}")
                raw_feat_names.append(f"tag__{tag}__prev")

            # Build out-of-sample / held-out prediction for the latest day (and rolling MAE on up to last 7 days)
            if n_days == 0:
                pred_latest = 0.0
                mae_h = None
            elif n_days == 1:
                # Day 1 honest prior guess (neutral target or 0.5) so user literally sees Day-1 error vs. actual!
                pred_latest = float(h_obj["target"]) * 0.5 if h_obj.get("target") else 0.0
                mae_h = abs(pred_latest - latest_actual)
            else:
                X_full = np.array([[row[name] for name in raw_feat_names] for row in day_feats], dtype=np.float32)
                # Predict each of the last min(n_days-1, 7) days strictly out-of-sample (trained on all OTHER days)
                eval_indices = list(range(max(1, n_days - 7), n_days))
                errs_h: list[float] = []
                pred_latest = float(np.mean(y[:-1]))
                for idx_eval in eval_indices:
                    train_mask = np.ones(n_days, dtype=bool)
                    train_mask[idx_eval] = False
                    X_tr = X_full[train_mask]
                    y_tr = y[train_mask]
                    X_te = X_full[idx_eval : idx_eval + 1]

                    if float(np.std(y_tr)) < 1e-6 or X_tr.shape[0] < 2:
                        p_val = float(np.mean(y_tr))
                    else:
                        keep = _nonconst_mask(X_tr)
                        if not np.any(keep):
                            p_val = float(np.mean(y_tr))
                        else:
                            try:
                                reg_cv = _make_regressor(engine)
                                reg_cv.fit(X_tr[:, keep], y_tr)
                                p_val = float(reg_cv.predict(X_te[:, keep])[0])
                            except Exception:
                                p_val = float(np.mean(y_tr))
                    if idx_eval == n_days - 1:
                        pred_latest = p_val
                    errs_h.append(abs(p_val - float(y[idx_eval])))
                mae_h = float(np.mean(errs_h)) if errs_h else abs(pred_latest - latest_actual)

            if mae_h is not None:
                all_errors.append(mae_h)

            calibration.append(
                {
                    "habit_id": target_id,
                    "habit_name": h_obj["name"],
                    "color": h_obj["color"],
                    "unit": h_obj["unit"],
                    "day": latest_day,
                    "ai_predicted": round(pred_latest, 2),
                    "actual": round(latest_actual, 2),
                    "error": round(abs(pred_latest - latest_actual), 2),
                    "mae": round(mae_h, 2) if mae_h is not None else None,
                    "tomorrow_peak_time": tomorrow_map.get(target_id, {}).get("ai_peak_time"),
                    "tomorrow_peak_pct": tomorrow_map.get(target_id, {}).get("ai_peak_pct"),
                }
            )

            # 3. Counterfactual AI assumptions (no 7-day lock! Runs whenever >= 3 days with variance exist)
            if n_days < 3 or len(habits) < 2:
                continue
            y_std = float(np.std(y))
            if y_std < 0.05:
                continue

            X_full = np.array([[row[name] for name in raw_feat_names] for row in day_feats], dtype=np.float32)
            keep_mask = _nonconst_mask(X_full)
            feat_names = [name for name, keep in zip(raw_feat_names, keep_mask) if keep]
            if not feat_names:
                continue

            col_idx = {name: i for i, name in enumerate(feat_names)}
            X = X_full[:, keep_mask]

            try:
                reg = _make_regressor(engine)
                reg.fit(X, y)
            except Exception:
                continue

            min_group = 1 if n_days < 6 else 2

            for src_id in habit_ids:
                if src_id in excluded_same_day:
                    continue

                src_direct_col = col_idx.get(f"{src_id}__direct")
                has_any_window_col = any(f"{src_id}__{w2}" in col_idx for w2 in windows_list)
                if src_direct_col is None and not has_any_window_col:
                    continue
                if src_direct_col is not None:
                    pos_vals = X[:, src_direct_col][X[:, src_direct_col] > 0]
                    typical_pos = float(np.median(pos_vals)) if len(pos_vals) else 1.0
                else:
                    typical_pos = 1.0

                best_for_pair: dict[str, Any] | None = None
                best_score = 0.0

                for win in ("morning", "afternoon", "evening", "night", "any"):
                    if win == "any":
                        if src_direct_col is None:
                            continue
                        has_mask = np.array(["any" in by_day_windows[d].get(src_id, set()) for d in observed_days])
                    else:
                        if f"{src_id}__{win}" not in col_idx:
                            continue
                        has_mask = np.array([win in by_day_windows[d].get(src_id, set()) for d in observed_days])

                    n_with = int(np.sum(has_mask))
                    n_without = int(n_days - n_with)
                    if n_with < min_group or n_without < min_group:
                        continue

                    X_on = X.copy()
                    X_off = X.copy()
                    if win == "any":
                        X_on[:, src_direct_col] = np.maximum(X_on[:, src_direct_col], typical_pos)
                        X_off[:, src_direct_col] = 0.0
                        for w2 in windows_list:
                            w_idx = col_idx.get(f"{src_id}__{w2}")
                            if w_idx is not None:
                                X_off[:, w_idx] = 0.0
                    else:
                        w_idx = col_idx[f"{src_id}__{win}"]
                        X_on[:, w_idx] = 1.0
                        if src_direct_col is not None:
                            X_on[:, src_direct_col] = np.maximum(X_on[:, src_direct_col], 1.0)
                        X_off[:, w_idx] = 0.0
                        if src_direct_col is not None:
                            only_this = has_mask.copy()
                            for w2 in windows_list:
                                if w2 != win:
                                    w2_idx = col_idx.get(f"{src_id}__{w2}")
                                    if w2_idx is not None:
                                        only_this = only_this & (X[:, w2_idx] < 0.5)
                            X_off[only_this, src_direct_col] = 0.0

                    try:
                        preds = reg.predict(np.vstack([X_on, X_off]))
                    except Exception:
                        continue

                    diffs = preds[:n_days] - preds[n_days:]
                    cf_delta = float(np.mean(diffs))
                    cf_std = float(np.std(diffs))
                    emp_with = float(np.mean(y[has_mask]))
                    emp_without = float(np.mean(y[~has_mask]))
                    emp_delta = emp_with - emp_without

                    if abs(cf_delta) < 0.20:
                        continue
                    if emp_delta != 0 and (cf_delta * emp_delta < 0):
                        continue

                    effect_z = abs(cf_delta) / max(0.25, y_std)
                    consistency = abs(cf_delta) / (cf_std + 0.2)
                    sample_factor = min(1.0, (min(n_with, n_without) / 5.0)) * min(1.0, n_days / 18.0)
                    raw_conf = (1.0 - math.exp(-0.75 * effect_z)) * min(1.0, consistency / 1.5) * (0.35 + 0.65 * sample_factor)
                    confidence = round(max(0.10, min(0.95, raw_conf)), 2)

                    specificity_boost = 1.15 if win != "any" else 1.0
                    rank_score = abs(cf_delta) * confidence * specificity_boost

                    if rank_score > best_score:
                        best_score = rank_score
                        direction = 1.0 if cf_delta > 0 else -1.0
                        saved_w = saved_hyps.get((src_id, target_id, win))
                        src_name = habits_by_id[src_id]["name"]
                        dst_name = habits_by_id[target_id]["name"]
                        win_label = WINDOW_DE.get(win, win)
                        verb = "höher" if cf_delta > 0 else "niedriger"
                        best_for_pair = {
                            "is_ai_assumption": True,
                            "engine": engine,
                            "engine_label": info["label"],
                            "source_id": src_id,
                            "source_name": src_name,
                            "target_id": target_id,
                            "target_name": dst_name,
                            "context_window": win,
                            "direction": direction,
                            "predicted_delta": round(cf_delta, 2),
                            "empirical_delta": round(emp_delta, 2),
                            "days_with": n_with,
                            "days_without": n_without,
                            "confidence": confidence,
                            "confidence_pct": int(round(confidence * 100)),
                            "already_saved": saved_w is not None,
                            "contradicts_saved": (saved_w is not None and saved_w * direction < 0),
                            "summary": (
                                f"Wenn {src_name} ({win_label}), liegt {dst_name} laut KI "
                                f"im Schnitt {cf_delta:+.2f} {verb}."
                            ),
                            "_score": rank_score,
                        }

                if best_for_pair is not None:
                    candidates.append(best_for_pair)

        # 3b. Also evaluate which habits move Momentaufnahme state dimensions (on sparse rated days!)
        if dim_ids and n_days >= 3:
            state_feat_names = ["weekday"]
            for hid in habit_ids:
                state_feat_names.extend([f"{hid}__direct", f"{hid}__prev"] + [f"{hid}__{w}" for w in windows_list])
            X_all_h = np.array([[row[name] for name in state_feat_names] for row in day_feats], dtype=np.float32)

            for did in dim_ids:
                y_raw = np.array([row[f"state__{did}"] for row in day_feats], dtype=np.float32)
                valid_idx = ~np.isnan(y_raw)
                n_rated = int(np.sum(valid_idx))
                if n_rated < 3:
                    continue
                y_s = y_raw[valid_idx]
                y_s_std = float(np.std(y_s))
                if y_s_std < 0.05:
                    continue
                X_s_full = X_all_h[valid_idx]
                keep_s = _nonconst_mask(X_s_full)
                f_names_s = [name for name, k in zip(state_feat_names, keep_s) if k]
                if not f_names_s:
                    continue
                col_s = {name: i for i, name in enumerate(f_names_s)}
                X_s = X_s_full[:, keep_s]
                try:
                    reg_s = _make_regressor(engine)
                    reg_s.fit(X_s, y_s)
                except Exception:
                    continue

                rated_days = [d for d, ok in zip(observed_days, valid_idx) if ok]
                min_g = 1 if n_rated < 6 else 2
                for src_id in habit_ids:
                    d_col = col_s.get(f"{src_id}__direct")
                    if d_col is None:
                        continue
                    has_m = np.array(["any" in by_day_windows[d].get(src_id, set()) for d in rated_days])
                    nw = int(np.sum(has_m))
                    nwo = int(n_rated - nw)
                    if nw < min_g or nwo < min_g:
                        continue
                    X_on = X_s.copy()
                    X_off = X_s.copy()
                    X_on[:, d_col] = np.maximum(X_on[:, d_col], 1.0)
                    X_off[:, d_col] = 0.0
                    for w2 in windows_list:
                        wi = col_s.get(f"{src_id}__{w2}")
                        if wi is not None:
                            X_off[:, wi] = 0.0
                    try:
                        p_s = reg_s.predict(np.vstack([X_on, X_off]))
                    except Exception:
                        continue
                    cf_d = float(np.mean(p_s[:n_rated] - p_s[n_rated:]))
                    emp_d = float(np.mean(y_s[has_m]) - np.mean(y_s[~has_m]))
                    if abs(cf_d) < 0.25 or (emp_d != 0 and cf_d * emp_d < 0):
                        continue
                    src_name = habits_by_id[src_id]["name"]
                    dim_name = dims_by_id[did]["name"]
                    verb = "höher" if cf_d > 0 else "niedriger"
                    candidates.append(
                        {
                            "is_ai_assumption": True,
                            "is_state_target": True,
                            "engine": engine,
                            "engine_label": info["label"],
                            "source_id": src_id,
                            "source_name": src_name,
                            "target_id": f"state:{did}",
                            "target_name": dim_name,
                            "context_window": "any",
                            "direction": 1.0 if cf_d > 0 else -1.0,
                            "predicted_delta": round(cf_d, 2),
                            "empirical_delta": round(emp_d, 2),
                            "days_with": nw,
                            "days_without": nwo,
                            "confidence": round(min(0.9, abs(cf_d) / max(0.5, y_s_std) * 0.5), 2),
                            "confidence_pct": int(round(min(90, abs(cf_d) / max(0.5, y_s_std) * 50))),
                            "already_saved": False,
                            "contradicts_saved": False,
                            "summary": f"An Tagen mit {src_name} liegt „{dim_name}“ laut KI im Schnitt {cf_d:+.2f} {verb}.",
                            "_score": abs(cf_d) * 0.75,
                        }
                    )

    candidates.sort(key=lambda c: c["_score"], reverse=True)
    final_assumptions = [{k: v for k, v in c.items() if not k.startswith("_")} for c in candidates[:max_suggestions]]
    overall_mae = round(float(np.mean(all_errors)), 2) if all_errors else None

    # 4. Multi-Scale Befinden Curves (24h Today + 14 Days + 8 Weeks)
    #    Dual-engine comparison: TabPFN (tabular prior) vs. Continuous-Time Liquid Relaxation ODE ("Uhrwerk")!
    #    ODE: ds/dt = -(s - s0)/tau + sum_i w_i * u_i(t)  => exact analytical solution with Ridge regularization.
    curve_dates = [(today_d - timedelta(days=i)).isoformat() for i in range(13, -1, -1)]
    tomorrow_iso = (today_d + timedelta(days=1)).isoformat()
    curve_dates.append(tomorrow_iso)

    # Parse exact event timestamps (in hours since epoch) for the continuous-time Liquid ODE
    parsed_pos_events: list[tuple[float, str, float, str, str, str]] = []
    for ev in events:
        hid = ev["habit_id"]
        amt = float(ev["amount"])
        if hid not in habits_by_id or amt <= 0:
            continue
        try:
            dt = datetime.fromisoformat(ev["occurred_at"])
        except Exception:
            continue
        t_hr = dt.timestamp() / 3600.0
        parsed_pos_events.append((t_hr, hid, amt, ev["occurred_at"], habits_by_id[hid]["name"], habits_by_id[hid]["color"]))
    parsed_pos_events.sort(key=lambda x: x[0])

    today_iso_str = today_d.isoformat()
    today_midnight_hr = datetime.combine(today_d, datetime.min.time()).timestamp() / 3600.0
    now_local = datetime.now()
    now_rel_hr = round(max(0.0, min(24.0, (now_local.timestamp() / 3600.0) - today_midnight_hr)), 2)
    h24_offsets = [i * 0.5 for i in range(49)]  # 00:00, 00:30, ..., 24:00
    h24_times_hr = [today_midnight_hr + off for off in h24_offsets]

    # Continuous multi-scale timeline grid relative to today 00:00 (hours):
    # -56d..-3d every 6h, -3d..+3d every 1h, +3d..+7d every 6h (smooth zoom from 6h to 9w!)
    tl_rel_hrs: list[float] = []
    h_cur = -56.0 * 24.0
    while h_cur < -3.0 * 24.0:
        tl_rel_hrs.append(h_cur)
        h_cur += 6.0
    h_cur = -3.0 * 24.0
    while h_cur <= 3.0 * 24.0:
        tl_rel_hrs.append(h_cur)
        h_cur += 1.0
    h_cur = 3.0 * 24.0 + 6.0
    while h_cur <= 7.0 * 24.0:
        tl_rel_hrs.append(h_cur)
        h_cur += 6.0
    tl_abs_hrs = [today_midnight_hr + off for off in tl_rel_hrs]

    # Daily dates spanning -56d .. +7d for continuous TabPFN curve + fading future
    tl_day_offsets = list(range(-56, 8))
    tl_dates = [(today_d + timedelta(days=d_off)).isoformat() for d_off in tl_day_offsets]

    all_habit_ticks = [
        {
            "t": round(t_hr - today_midnight_hr, 2),
            "ts": iso[:16],
            "habit_id": hid,
            "habit_name": hname,
            "color": hcol,
            "amount": round(amt, 2),
        }
        for t_hr, hid, amt, iso, hname, hcol in parsed_pos_events
        if -60.0 * 24.0 <= (t_hr - today_midnight_hr) <= 24.0
    ]

    tag_days_map: dict[str, list[str]] = defaultdict(list)
    for d_iso, tags_set in sorted(by_day_tags.items()):
        for tg in tags_set:
            tag_days_map[tg].append(d_iso)

    timeline_meta = {
        "origin_day": today_iso_str,
        "now_hr": now_rel_hr,
        "habit_ticks": all_habit_ticks,
        "tag_days": dict(tag_days_map),
    }

    today_habit_ticks = [
        {
            "hour": round(t_hr - today_midnight_hr, 2),
            "time": iso[11:16],
            "habit_id": hid,
            "habit_name": hname,
            "color": hcol,
            "amount": round(amt, 2),
        }
        for t_hr, hid, amt, iso, hname, hcol in parsed_pos_events
        if iso[:10] == today_iso_str
    ]

    # 8 ISO week buckets ending this week
    cur_week_mon = today_d - timedelta(days=today_d.weekday())
    w8_starts = [cur_week_mon - timedelta(weeks=i) for i in range(7, -1, -1)]
    w8_labels = [f"KW {ws.isocalendar().week:02d}" for ws in w8_starts]

    # Group raw timestamped snapshots per dimension for exact continuous ODE & 24h view
    snaps_by_dim: dict[str, list[tuple[float, float, str, str]]] = defaultdict(list)
    for sn in snapshots or []:
        try:
            dt = datetime.fromisoformat(sn["occurred_at"])
        except Exception:
            continue
        t_hr = dt.timestamp() / 3600.0
        for did, val in (sn.get("ratings") or {}).items():
            if val is not None:
                snaps_by_dim[str(did)].append((t_hr, float(val), sn["occurred_at"], sn.get("note", "")))

    hid_to_col = {hid: idx for idx, hid in enumerate(habit_ids)}

    def build_ode_phi(query_hours: list[float], tau_h: float) -> np.ndarray:
        """Exact analytical Liquid-ODE impulse-response matrix Phi(t, tau): col 0 = baseline s0, cols 1..H = decayed habits."""
        n_q = len(query_hours)
        n_h = len(habit_ids)
        phi = np.zeros((n_q, 1 + n_h), dtype=np.float64)
        phi[:, 0] = 1.0
        max_dt = tau_h * 5.0  # e^-5 < 0.007 negligible
        for qi, t_q in enumerate(query_hours):
            for t_ev, hid, amt, _iso, _hn, _hc in parsed_pos_events:
                dt_h = t_q - t_ev
                if dt_h < 0:
                    break
                if dt_h <= max_dt:
                    phi[qi, 1 + hid_to_col[hid]] += amt * math.exp(-dt_h / tau_h)
        return phi

    def fit_liquid_ode(dim_snaps: list[tuple[float, float, str, str]]) -> tuple[float, np.ndarray]:
        """Fit exact Liquid Relaxation ODE via Ridge + analytical LOO tau selection (runs in ~1-2ms, zero overfit)."""
        n_m = len(dim_snaps)
        n_h = len(habit_ids)
        if n_m == 0:
            return 6.0, np.zeros(1 + n_h, dtype=np.float64)
        y_vec = np.array([s[1] for s in dim_snaps], dtype=np.float64)
        if n_m == 1 or float(np.std(y_vec)) < 1e-6:
            theta = np.zeros(1 + n_h, dtype=np.float64)
            theta[0] = float(np.mean(y_vec))
            return 6.0, theta

        q_times = [s[0] for s in dim_snaps]
        lam = 1.8
        reg_diag = np.eye(1 + n_h, dtype=np.float64) * lam
        reg_diag[0, 0] = 0.0  # never shrink baseline s0 toward 0!

        best_tau = 6.0
        best_theta = np.zeros(1 + n_h, dtype=np.float64)
        best_theta[0] = float(np.mean(y_vec))
        best_loo = float("inf")

        for tau_cand in (2.0, 6.0, 18.0, 48.0):
            Phi = build_ode_phi(q_times, tau_cand)
            A = Phi.T @ Phi + reg_diag
            try:
                A_inv = np.linalg.inv(A)
                theta = A_inv @ (Phi.T @ y_vec)
                preds = Phi @ theta
                if n_m >= 3:
                    H_diag = np.einsum("ij,jk,ik->i", Phi, A_inv, Phi)
                    denom = np.maximum(0.08, 1.0 - H_diag)
                    loo_err = float(np.mean(((y_vec - preds) / denom) ** 2))
                else:
                    loo_err = float(np.mean((y_vec - preds) ** 2))
                if loo_err < best_loo:
                    best_loo = loo_err
                    best_tau = tau_cand
                    best_theta = theta
            except Exception:
                continue
        return best_tau, best_theta

    def eval_ode(query_hours: list[float], tau_h: float, theta: np.ndarray) -> list[float]:
        Phi = build_ode_phi(query_hours, tau_h)
        raw = Phi @ theta
        return [round(float(max(1.0, min(5.0, v))), 2) for v in raw]

    state_curves: list[dict[str, Any]] = []
    if active_dims:
        def habit_vec_for_day(d_str: str) -> list[float]:
            dt_d = date.fromisoformat(d_str)
            prev_d = (dt_d - timedelta(days=1)).isoformat()
            vec = [float(dt_d.weekday())]
            for hid in habit_ids:
                vec.append(float(by_day_direct.get(d_str, {}).get(hid, 0.0)))
                vec.append(float(by_day_direct.get(prev_d, {}).get(hid, 0.0)))
                wins = by_day_windows.get(d_str, {}).get(hid, set())
                for w in windows_list:
                    vec.append(1.0 if w in wins else 0.0)
            d_tags = by_day_tags.get(d_str, set())
            for tag in active_tags:
                vec.append(1.0 if tag in d_tags else 0.0)
            return vec

        X_curve_all = np.array([habit_vec_for_day(d) for d in curve_dates], dtype=np.float32)
        X_tl_days = np.array([habit_vec_for_day(d) for d in tl_dates], dtype=np.float32)
        d14_eval_hours = [
            (datetime.combine(date.fromisoformat(d), datetime.min.time()) + timedelta(hours=18)).timestamp() / 3600.0
            for d in curve_dates
        ]

        def intraday_vec_for_time(t_hr: float) -> list[float]:
            """Continuous intraday feature row for TabPFN: circadian sin/cos + weekday + recent 4h & 24h habit exposure."""
            dt_t = datetime.fromtimestamp(t_hr * 3600.0)
            hr_f = dt_t.hour + dt_t.minute / 60.0
            ang = 2.0 * math.pi * hr_f / 24.0
            vec = [math.sin(ang), math.cos(ang), float(dt_t.weekday())]
            n_h = len(habit_ids)
            rec4 = [0.0] * n_h
            rec24 = [0.0] * n_h
            for t_ev, hid, amt, _iso, _hn, _hc in parsed_pos_events:
                dt_h = t_hr - t_ev
                if dt_h < 0:
                    break
                if dt_h <= 24.0:
                    c_i = hid_to_col[hid]
                    if dt_h <= 4.0:
                        rec4[c_i] += amt
                    rec24[c_i] += amt * math.exp(-dt_h / 6.0)
            vec.extend(rec4)
            vec.extend(rec24)
            return vec

        X_h24_grid = np.array([intraday_vec_for_time(t_q) for t_q in h24_times_hr], dtype=np.float32)

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            for dim in active_dims:
                did = dim["id"]
                dim_snaps = sorted(snaps_by_dim.get(did, []), key=lambda x: x[0])
                rated_days_d = [d for d in observed_days if snap_by_day.get(d, {}).get(did) is not None]
                actual_14 = [snap_by_day.get(d, {}).get(did) for d in curve_dates]

                # A) TabPFN 14-day + tomorrow curve
                if not rated_days_d:
                    tabpfn_14: list[float | None] = [None] * len(curve_dates)
                    reg_c_fitted = None
                    keep_c = None
                elif len(rated_days_d) == 1:
                    val0 = round(float(snap_by_day[rated_days_d[0]][did]), 2)
                    tabpfn_14 = [val0] * len(curve_dates)
                    reg_c_fitted = None
                    keep_c = None
                else:
                    X_r_full = np.array([habit_vec_for_day(d) for d in rated_days_d], dtype=np.float32)
                    y_r = np.array([float(snap_by_day[d][did]) for d in rated_days_d], dtype=np.float32)
                    keep_c = _nonconst_mask(X_r_full)
                    reg_c_fitted = None
                    if float(np.std(y_r)) < 1e-6 or not np.any(keep_c):
                        mean_v = round(float(np.mean(y_r)), 2)
                        tabpfn_14 = [mean_v] * len(curve_dates)
                    else:
                        try:
                            reg_c = _make_regressor(engine)
                            reg_c.fit(X_r_full[:, keep_c], y_r)
                            preds_c = reg_c.predict(X_curve_all[:, keep_c])
                            tabpfn_14 = [round(float(max(1.0, min(5.0, p))), 2) for p in preds_c]
                            reg_c_fitted = reg_c
                        except Exception:
                            mean_v = round(float(np.mean(y_r)), 2)
                            tabpfn_14 = [mean_v] * len(curve_dates)

                # B) Continuous-Time Liquid ODE ("Uhrwerk") across 24h, 14d & 8w
                if dim_snaps:
                    tau_h, theta = fit_liquid_ode(dim_snaps)
                    ode_24 = eval_ode(h24_times_hr, tau_h, theta)
                    ode_14 = eval_ode(d14_eval_hours, tau_h, theta)
                else:
                    tau_h = 6.0
                    theta = np.zeros(1 + len(habit_ids), dtype=np.float64)
                    ode_24 = []
                    ode_14 = [None] * len(curve_dates)

                # Today's exact Momentaufnahme points for 24h view
                actual_24 = [
                    {
                        "hour": round(t_hr - today_midnight_hr, 2),
                        "time": iso[11:16],
                        "value": round(val, 2),
                        "note": note,
                    }
                    for t_hr, val, iso, note in dim_snaps
                    if iso[:10] == today_iso_str
                ]
                today_tabpfn_val = tabpfn_14[-2] if len(tabpfn_14) >= 2 else None
                if not dim_snaps:
                    tabpfn_24: list[float] = []
                elif len(dim_snaps) == 1:
                    tabpfn_24 = [round(float(dim_snaps[0][1]), 2)] * len(h24_offsets)
                else:
                    X_intra_tr = np.array([intraday_vec_for_time(s[0]) for s in dim_snaps], dtype=np.float32)
                    y_intra_tr = np.array([float(s[1]) for s in dim_snaps], dtype=np.float32)
                    keep_i = _nonconst_mask(X_intra_tr)
                    if float(np.std(y_intra_tr)) < 1e-6 or not np.any(keep_i):
                        m_i = round(float(np.mean(y_intra_tr)), 2)
                        tabpfn_24 = [m_i] * len(h24_offsets)
                    else:
                        try:
                            reg_i = _make_regressor(engine)
                            reg_i.fit(X_intra_tr[:, keep_i], y_intra_tr)
                            p_24 = reg_i.predict(X_h24_grid[:, keep_i])
                            tabpfn_24 = [round(float(max(1.0, min(5.0, v))), 2) for v in p_24]
                        except Exception:
                            fallback_v = today_tabpfn_val if today_tabpfn_val is not None else round(float(np.mean(y_intra_tr)), 2)
                            tabpfn_24 = [fallback_v] * len(h24_offsets)

                # 8-week aggregates
                w8_actual: list[float | None] = []
                w8_tabpfn: list[float | None] = []
                w8_ode: list[float | None] = []
                for ws in w8_starts:
                    w_days = [(ws + timedelta(days=k)).isoformat() for k in range(7)]
                    vals_a = [snap_by_day[d][did] for d in w_days if snap_by_day.get(d, {}).get(did) is not None]
                    w8_actual.append(round(sum(vals_a) / len(vals_a), 2) if vals_a else None)
                    if dim_snaps:
                        w_eval_hrs = [
                            (datetime.combine(ws + timedelta(days=k), datetime.min.time()) + timedelta(hours=18)).timestamp() / 3600.0
                            for k in range(7)
                        ]
                        w8_ode.append(round(float(np.mean(eval_ode(w_eval_hrs, tau_h, theta))), 2))
                        if reg_c_fitted is not None and keep_c is not None:
                            Xw = np.array([habit_vec_for_day(d) for d in w_days], dtype=np.float32)
                            pw = reg_c_fitted.predict(Xw[:, keep_c])
                            w8_tabpfn.append(round(float(max(1.0, min(5.0, np.mean(pw)))), 2))
                        else:
                            w8_tabpfn.append(today_tabpfn_val)
                    else:
                        w8_ode.append(None)
                        w8_tabpfn.append(None)

                # Continuous pan/zoom timeline series (56d past .. +7d fading future)
                tl_actual = [
                    {
                        "t": round(t_hr - today_midnight_hr, 2),
                        "v": round(val, 2),
                        "ts": iso[:16],
                        "note": note,
                    }
                    for t_hr, val, iso, note in dim_snaps
                    if -60.0 * 24.0 <= (t_hr - today_midnight_hr) <= 24.0
                ]

                # Empirical residual std for honest future confidence ribbon width
                if dim_snaps:
                    ode_fit_vals = eval_ode([s[0] for s in dim_snaps], tau_h, theta)
                    ode_resids = [abs(s[1] - pv) for s, pv in zip(dim_snaps, ode_fit_vals)]
                    ode_err = max(0.22, min(1.2, float(np.mean(ode_resids)) * 1.25)) if ode_resids else 0.45
                    ode_tl_vals = eval_ode(tl_abs_hrs, tau_h, theta)
                    ode_decay_h = max(18.0, float(tau_h) * 2.2)
                    ode_timeline = []
                    for rel_h, ov in zip(tl_rel_hrs, ode_tl_vals):
                        if rel_h <= now_rel_hr:
                            ode_timeline.append([round(rel_h, 2), ov, 1.0, 0.0])
                        else:
                            dh = rel_h - now_rel_hr
                            conf = round(max(0.08, math.exp(-dh / ode_decay_h)), 3)
                            spread = round(min(1.5, (ode_err + 0.35) * (1.0 - conf)), 2)
                            ode_timeline.append([round(rel_h, 2), ov, conf, spread])
                else:
                    ode_timeline = []

                # Continuous TabPFN timeline (daily -56d..+7d, plus today intraday detail, with fading future confidence)
                tabpfn_timeline: list[list[float]] = []
                if dim_snaps:
                    data_strength = min(1.0, len(rated_days_d) / 14.0)
                    if reg_c_fitted is not None and keep_c is not None:
                        try:
                            tl_tp_preds = [round(float(max(1.0, min(5.0, p))), 2) for p in reg_c_fitted.predict(X_tl_days[:, keep_c])]
                            tr_preds = reg_c_fitted.predict(X_r_full[:, keep_c])
                            tp_err = max(0.25, min(1.25, float(np.mean(np.abs(y_r - tr_preds))) * 1.35 + 0.15))
                        except Exception:
                            fallback_m = round(float(np.mean([s[1] for s in dim_snaps])), 2)
                            tl_tp_preds = [fallback_m] * len(tl_dates)
                            tp_err = 0.55
                    else:
                        fallback_m = today_tabpfn_val if today_tabpfn_val is not None else round(float(np.mean([s[1] for s in dim_snaps])), 2)
                        tl_tp_preds = [fallback_m] * len(tl_dates)
                        tp_err = 0.6

                    for d_off, pv in zip(tl_day_offsets, tl_tp_preds):
                        if d_off == 0 and tabpfn_24:
                            # Inject today's hourly TabPFN resolution cleanly
                            for idx_h in range(0, len(h24_offsets), 2):
                                rel_h = float(h24_offsets[idx_h])
                                v_h = float(tabpfn_24[idx_h])
                                if rel_h <= now_rel_hr:
                                    tabpfn_timeline.append([round(rel_h, 2), v_h, 1.0, 0.0])
                                else:
                                    dh = rel_h - now_rel_hr
                                    conf = round(max(0.1, (0.45 + 0.55 * data_strength) * math.exp(-dh / 72.0)), 3)
                                    spread = round(min(1.5, (tp_err + 0.3) * (1.0 - conf)), 2)
                                    tabpfn_timeline.append([round(rel_h, 2), v_h, conf, spread])
                            continue
                        rel_h = float(d_off * 24 + 18)
                        if rel_h <= now_rel_hr:
                            tabpfn_timeline.append([round(rel_h, 2), pv, 1.0, 0.0])
                        else:
                            dh = rel_h - now_rel_hr
                            conf = round(max(0.08, (0.4 + 0.6 * data_strength) * math.exp(-dh / 76.0)), 3)
                            spread = round(min(1.6, (tp_err + 0.4) * (1.0 - conf)), 2)
                            tabpfn_timeline.append([round(rel_h, 2), pv, conf, spread])

                state_curves.append(
                    {
                        "id": did,
                        "name": dim["name"],
                        "low_label": dim.get("low_label", ""),
                        "high_label": dim.get("high_label", ""),
                        "color": dim.get("color") or "#3d6b7d",
                        "rated_count": len(dim_snaps),
                        "ode_tau_hours": tau_h,
                        # Legacy fields kept for clean backwards compatibility
                        "dates": curve_dates,
                        "actual": actual_14,
                        "ai_curve": tabpfn_14,
                        # Continuous pan/zoom timeline
                        "timeline": {
                            "actual": tl_actual,
                            "ode": ode_timeline,
                            "tabpfn": tabpfn_timeline,
                        },
                        # Multi-scale payloads
                        "h24": {
                            "hours": h24_offsets,
                            "actual": actual_24,
                            "tabpfn": tabpfn_24,
                            "ode": ode_24,
                            "habit_ticks": today_habit_ticks,
                        },
                        "d14": {
                            "dates": curve_dates,
                            "actual": actual_14,
                            "tabpfn": tabpfn_14,
                            "ode": ode_14,
                        },
                        "w8": {
                            "labels": w8_labels,
                            "actual": w8_actual,
                            "tabpfn": w8_tabpfn,
                            "ode": w8_ode,
                        },
                    }
                )

    result = {
        **base_meta,
        "status": "ready",
        "tomorrow": tomorrow_map,
        "calibration": calibration,
        "overall_mae": overall_mae,
        "assumptions": final_assumptions,
        "state_curves": state_curves,
        "timeline_meta": timeline_meta,
        "feature_audit": feature_audit,
    }
    if len(_ANALYSIS_CACHE) > 24:
        _ANALYSIS_CACHE.clear()
    _ANALYSIS_CACHE[cache_key] = result
    return result


def compute_ai_routing_edges(
    habits: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    all_events: list[dict[str, Any]],
    day_events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Compute effective routing edges in KI mode: starts from user's manual routing as priming prior,
    then adapts weights & adds learned TabPFN impacts based on real logged days and today's time windows."""
    all_events = [ev for ev in all_events if not ev.get("deleted_at")]
    day_events = [ev for ev in day_events if not ev.get("deleted_at")]
    manual_rollups = [dict(e, is_ai=False, prior_weight=float(e["weight"])) for e in edges if e["relation_type"] == "rollup"]
    info = get_ml_engine_info()
    engine = info["engine"]
    if engine == "none" or len(habits) < 2:
        return manual_rollups

    observed_days, by_day_direct, by_day_effective, by_day_windows = _build_daily_tables(habits, edges, all_events)
    n_days = len(observed_days)
    if n_days < 3:
        # Too few days for cross-day counterfactuals -> keep user's priming prior intact
        return manual_rollups

    # Which time windows were actually triggered today for each source habit?
    today_windows: dict[str, set[str]] = defaultdict(set)
    for ev in day_events:
        if float(ev["amount"]) > 0:
            dt = datetime.fromisoformat(ev["occurred_at"])
            today_windows[ev["habit_id"]].add(classify_time_window(dt))

    win_sig = tuple(sorted((k, tuple(sorted(v))) for k, v in today_windows.items()))
    cache_key = ("ai_routing", engine, _data_signature(habits, edges, all_events), win_sig)
    if cache_key in _ANALYSIS_CACHE:
        return _ANALYSIS_CACHE[cache_key]["edges"]

    habits_by_id = {h["id"]: h for h in habits}
    habit_ids = [h["id"] for h in habits]
    windows_list = ("morning", "afternoon", "evening", "night")

    day_feats: list[dict[str, float]] = []
    for d_str in observed_days:
        dt_d = date.fromisoformat(d_str)
        prev_day = (dt_d - timedelta(days=1)).isoformat()
        row: dict[str, float] = {"weekday": float(dt_d.weekday())}
        for hid in habit_ids:
            row[f"{hid}__direct"] = float(by_day_direct[d_str].get(hid, 0.0))
            wins = by_day_windows[d_str].get(hid, set())
            for w in windows_list:
                row[f"{hid}__{w}"] = 1.0 if w in wins else 0.0
            row[f"{hid}__prev"] = float(by_day_direct.get(prev_day, {}).get(hid, 0.0))
        day_feats.append(row)

    manual_by_pair: dict[tuple[str, str], dict[str, Any]] = {
        (e["source_id"], e["target_id"]): e for e in manual_rollups
    }
    # Smoothly shift weight from user's prime prior toward TabPFN as days accumulate
    blend_alpha = min(0.85, max(0.25, n_days / 14.0))
    min_group = 1 if n_days < 6 else 2

    learned_effects: dict[tuple[str, str], tuple[float, str]] = {}  # (src, dst) -> (unit_delta, matched_window)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for target_id in habit_ids:
            # Measure real direct observations of target_id (never regress on synthetic manual rollups!)
            y_direct = np.array([by_day_direct[d].get(target_id, 0.0) for d in observed_days], dtype=np.float32)
            if float(np.std(y_direct)) < 0.05:
                # Pure aggregate target (e.g. 'Gesundheit' never logged directly) -> preserve user's primed rollups
                continue

            raw_feat_names: list[str] = ["weekday"]
            for hid in habit_ids:
                raw_feat_names.append(f"{hid}__prev")
                if hid != target_id:
                    raw_feat_names.append(f"{hid}__direct")
                    for w in windows_list:
                        raw_feat_names.append(f"{hid}__{w}")

            X_full = np.array([[row[name] for name in raw_feat_names] for row in day_feats], dtype=np.float32)
            keep_mask = _nonconst_mask(X_full)
            feat_names = [name for name, keep in zip(raw_feat_names, keep_mask) if keep]
            if not feat_names:
                continue

            col_idx = {name: i for i, name in enumerate(feat_names)}
            X = X_full[:, keep_mask]

            try:
                reg = _make_regressor(engine)
                reg.fit(X, y_direct)
            except Exception:
                continue

            for src_id in habit_ids:
                if src_id == target_id:
                    continue
                src_direct_col = col_idx.get(f"{src_id}__direct")
                if src_direct_col is None and not any(f"{src_id}__{w}" in col_idx for w in windows_list):
                    continue

                # Prefer today's active time window for src_id if present, otherwise evaluate 'any'
                active_wins = sorted(today_windows.get(src_id, set()))
                eval_windows = active_wins + ["any"] if active_wins else ["any"]

                chosen_delta = None
                chosen_win = "any"
                for win in eval_windows:
                    if win == "any":
                        if src_direct_col is None:
                            continue
                        has_mask = np.array(["any" in by_day_windows[d].get(src_id, set()) for d in observed_days])
                    else:
                        if f"{src_id}__{win}" not in col_idx:
                            continue
                        has_mask = np.array([win in by_day_windows[d].get(src_id, set()) for d in observed_days])

                    n_with = int(np.sum(has_mask))
                    n_without = int(n_days - n_with)
                    if n_with < min_group or n_without < min_group:
                        continue

                    X_on = X.copy()
                    X_off = X.copy()
                    if win == "any":
                        X_on[:, src_direct_col] = np.maximum(X_on[:, src_direct_col], 1.0)
                        X_off[:, src_direct_col] = 0.0
                        for w2 in windows_list:
                            w_idx = col_idx.get(f"{src_id}__{w2}")
                            if w_idx is not None:
                                X_off[:, w_idx] = 0.0
                    else:
                        w_idx = col_idx[f"{src_id}__{win}"]
                        X_on[:, w_idx] = 1.0
                        if src_direct_col is not None:
                            X_on[:, src_direct_col] = np.maximum(X_on[:, src_direct_col], 1.0)
                        X_off[:, w_idx] = 0.0
                        if src_direct_col is not None:
                            only_this = has_mask.copy()
                            for w2 in windows_list:
                                if w2 != win:
                                    w2_idx = col_idx.get(f"{src_id}__{w2}")
                                    if w2_idx is not None:
                                        only_this = only_this & (X[:, w2_idx] < 0.5)
                            X_off[only_this, src_direct_col] = 0.0

                    try:
                        preds = reg.predict(np.vstack([X_on, X_off]))
                    except Exception:
                        continue

                    cf_delta = float(np.mean(preds[:n_days] - preds[n_days:]))
                    emp_delta = float(np.mean(y_direct[has_mask]) - np.mean(y_direct[~has_mask]))
                    if emp_delta != 0 and (cf_delta * emp_delta < 0):
                        continue

                    chosen_delta = cf_delta
                    chosen_win = win
                    break

                if chosen_delta is not None:
                    learned_effects[(src_id, target_id)] = (round(chosen_delta, 2), chosen_win)

    result_edges: list[dict[str, Any]] = []
    used_pairs: set[tuple[str, str]] = set()

    # 1. Start from user's manual routing edges (priming prior) and refine with TabPFN when real evidence exists
    for pair, edge in manual_by_pair.items():
        used_pairs.add(pair)
        prior_w = float(edge["weight"])
        if pair in learned_effects:
            ai_w, matched_win = learned_effects[pair]
            blended_w = round((1.0 - blend_alpha) * prior_w + blend_alpha * ai_w, 2)
            shifted = abs(blended_w - prior_w) >= 0.1
            result_edges.append(
                {
                    **edge,
                    "weight": blended_w,
                    "is_ai": shifted,
                    "prior_weight": prior_w,
                    "ai_window": matched_win,
                }
            )
        else:
            result_edges.append(edge)

    # 2. Add strong newly discovered TabPFN impacts (not already primed manually)
    # Cap at top 6 strongest discovered links so Heute cards stay clean and legible
    new_pairs = [
        (pair, vals)
        for pair, vals in learned_effects.items()
        if pair not in used_pairs and abs(vals[0]) >= 0.35
    ]
    new_pairs.sort(key=lambda kv: abs(kv[1][0]), reverse=True)
    for (src_id, dst_id), (ai_w, matched_win) in new_pairs[:6]:
        # Avoid trivial symmetric echo if stronger reverse already added
        if (dst_id, src_id) in used_pairs:
            continue
        used_pairs.add((src_id, dst_id))
        result_edges.append(
            {
                "id": None,
                "source_id": src_id,
                "target_id": dst_id,
                "source_name": habits_by_id[src_id]["name"],
                "target_name": habits_by_id[dst_id]["name"],
                "relation_type": "rollup",
                "weight": round(ai_w, 2),
                "context_window": matched_win,
                "is_ai": True,
                "prior_weight": None,
                "ai_window": matched_win,
            }
        )

    if len(_ANALYSIS_CACHE) > 24:
        _ANALYSIS_CACHE.clear()
    _ANALYSIS_CACHE[cache_key] = {"edges": result_edges}
    return result_edges


def predict_contextual_nudges(
    habits: list[dict[str, Any]],
    events: list[dict[str, Any]],
    now: datetime | None = None,
    threshold: float = DEFAULT_TABPFN_THRESHOLD,
    snapshots: list[dict[str, Any]] | None = None,
    state_dims: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Predict contextual 2-hour probabilities right now via TabPFN from Day 1 (supports sparse Momentaufnahme NaNs)."""
    events = [ev for ev in events if not ev.get("deleted_at")]
    snapshots = [s for s in (snapshots or []) if not s.get("deleted_at")]
    now = now or datetime.now()
    info = get_ml_engine_info()
    engine = info["engine"]
    habits_by_id = {h["id"]: h for h in habits}
    habit_ids = [h["id"] for h in habits]
    dim_ids = [d["id"] for d in (state_dims or []) if not d.get("archived")]

    by_day_events: dict[str, list[tuple[int, int, str, float]]] = defaultdict(list)
    by_day_totals: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for ev in events:
        hid = ev["habit_id"]
        if hid not in habits_by_id:
            continue
        amt = float(ev["amount"])
        if amt <= 0:
            continue
        dt = datetime.fromisoformat(ev["occurred_at"])
        d_str = dt.date().isoformat()
        by_day_events[d_str].append((dt.hour, dt.minute, hid, amt))
        by_day_totals[d_str][hid] += amt

    by_day_snaps: dict[str, list[tuple[int, int, dict[str, float]]]] = defaultdict(list)
    for s in snapshots or []:
        try:
            dt = datetime.fromisoformat(s["occurred_at"])
        except Exception:
            continue
        by_day_snaps[dt.date().isoformat()].append((dt.hour, dt.minute, s.get("ratings") or {}))

    today_iso = now.date().isoformat()
    past_days = sorted(d for d in by_day_events.keys() if d < today_iso)
    all_days = sorted(by_day_events.keys())

    cache_key = (
        "nudges",
        engine,
        today_iso,
        now.hour,
        round(threshold, 2),
        _data_signature(habits, [], events, snapshots, state_dims),
    )
    if cache_key in _NUDGE_CACHE:
        return _NUDGE_CACHE[cache_key]

    nudge_habits = [h for h in habits if h.get("nudge_enabled")]
    base = {
        "engine": engine,
        "engine_label": info["label"],
        "observed_days": len(all_days),
        "threshold": round(threshold, 2),
        "evaluated_at": now.replace(microsecond=0).isoformat(),
    }

    if engine == "none" or not all_days or not nudge_habits:
        return {**base, "status": "idle", "predictions": {}}

    train_days = past_days if len(past_days) >= 3 else all_days

    def build_slot_vector(d_str: str, hour: int, minute_cutoff: int = 0) -> np.ndarray:
        dt_d = date.fromisoformat(d_str)
        prev_day = (dt_d - timedelta(days=1)).isoformat()
        rad = 2.0 * math.pi * (hour / 24.0)
        vec: list[float] = [float(dt_d.weekday()), float(hour), math.sin(rad), math.cos(rad)]
        so_far: dict[str, float] = defaultdict(float)
        for ev_h, ev_m, hid, amt in by_day_events.get(d_str, []):
            if ev_h < hour or (ev_h == hour and ev_m < minute_cutoff):
                so_far[hid] += amt
        for hid in habit_ids:
            v = so_far.get(hid, 0.0)
            vec.append(v)
            vec.append(1.0 if v > 0 else 0.0)
            vec.append(float(by_day_totals.get(prev_day, {}).get(hid, 0.0)))
        if dim_ids:
            latest_state: dict[str, float] = {}
            for sh, sm, rmap in sorted(by_day_snaps.get(d_str, [])):
                if sh < hour or (sh == hour and sm <= minute_cutoff):
                    for k, val in rmap.items():
                        if val is not None:
                            latest_state[str(k)] = float(val)
            for did in dim_ids:
                vec.append(latest_state.get(did, float("nan")))
        return np.array(vec, dtype=np.float32)

    grid_hours = list(range(6, 24))
    X_rows: list[np.ndarray] = []
    slot_meta: list[tuple[str, int]] = []
    for d_str in train_days[-45:]:
        for hr in grid_hours:
            X_rows.append(build_slot_vector(d_str, hr, 0))
            slot_meta.append((d_str, hr))

    X_train_base = np.vstack(X_rows)
    rem_hours = list(range(max(6, now.hour), 24))
    x_now = build_slot_vector(today_iso, now.hour, now.minute)
    X_future = np.vstack([x_now] + [build_slot_vector(today_iso, hr, 0) for hr in rem_hours])

    predictions: dict[str, dict[str, Any]] = {}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for h in nudge_habits:
            hid = h["id"]
            y_list = [
                1
                if any(
                    ev_hid == hid and hr <= ev_h < hr + 2
                    for ev_h, _ev_m, ev_hid, _amt in by_day_events.get(d_str, [])
                )
                else 0
                for d_str, hr in slot_meta
            ]
            y_train = np.array(y_list, dtype=np.int32)
            X_train = X_train_base
            n_pos = int(np.sum(y_train == 1))
            n_neg = int(np.sum(y_train == 0))

            if n_pos == 0 or n_neg == 0:
                continue
            if n_pos == 1:
                pos_idx = int(np.argmax(y_train == 1))
                X_train = np.vstack([X_train, X_train[pos_idx : pos_idx + 1]])
                y_train = np.append(y_train, 1)

            try:
                clf = _make_classifier(engine)
                clf.fit(X_train, y_train)
                probs = clf.predict_proba(X_future)[:, 1]
            except Exception:
                continue

            prob_now = float(probs[0])
            rem_probs = probs[1:]
            best_idx = int(np.argmax(rem_probs)) if len(rem_probs) else 0
            next_peak_hour = rem_hours[best_idx] if len(rem_probs) else now.hour
            next_peak_prob = float(rem_probs[best_idx]) if len(rem_probs) else prob_now

            reason_parts: list[str] = [f"Zeitfenster {now.hour:02d}–{(now.hour + 2) % 24:02d}h"]
            active_today = [(i, other_id) for i, other_id in enumerate(habit_ids) if x_now[4 + i * 3] > 0]
            if active_today:
                cf_rows = []
                for idx_h, _other_id in active_today:
                    row_cf = x_now.copy()
                    row_cf[4 + idx_h * 3] = 0.0
                    row_cf[4 + idx_h * 3 + 1] = 0.0
                    cf_rows.append(row_cf)
                try:
                    cf_probs = clf.predict_proba(np.vstack(cf_rows))[:, 1]
                    impacts = [
                        (prob_now - float(p_cf), habits_by_id[other_id]["name"])
                        for (_i, other_id), p_cf in zip(active_today, cf_probs)
                    ]
                    impacts.sort(key=lambda t: abs(t[0]), reverse=True)
                    top_delta, top_name = impacts[0]
                    if abs(top_delta) >= 0.05:
                        sign_txt = "erhöht" if top_delta > 0 else "senkt"
                        reason_parts.append(f"heute {top_name} {sign_txt} ({top_delta * 100:+.0f}%)")
                except Exception:
                    pass

            predictions[hid] = {
                "habit_id": hid,
                "habit_name": h["name"],
                "status": "ready",
                "prob_now": round(prob_now, 3),
                "prob_now_pct": int(round(prob_now * 100)),
                "should_nudge": prob_now >= threshold,
                "next_peak_hour": f"{next_peak_hour:02d}:00",
                "next_peak_prob": round(next_peak_prob, 3),
                "next_peak_pct": int(round(next_peak_prob * 100)),
                "reason": " · ".join(reason_parts),
                "nudge_alternatives": h.get("nudge_alternatives") or "",
            }

    result = {
        **base,
        "status": "ready" if predictions else "idle",
        "predictions": predictions,
    }
    if len(_NUDGE_CACHE) > 24:
        _NUDGE_CACHE.clear()
    _NUDGE_CACHE[cache_key] = result
    return result

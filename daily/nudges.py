"""Local Linux desktop nudge daemon (graph-powered options menu, observed peaks OR TabPFN + idle check-in)."""
from __future__ import annotations

import asyncio
import shutil
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .analytics import compute_day_summary, compute_hourly_peaks
from .db import (
    DEFAULT_DB_PATH,
    get_settings,
    last_event_time,
    list_edges,
    list_events,
    list_habits,
    list_snapshots,
    list_state_dimensions,
    list_tasks,
)
from .ml import DEFAULT_TABPFN_THRESHOLD, predict_contextual_nudges


def send_desktop_notification(title: str, body: str, urgency: str = "normal") -> bool:
    """Send a local desktop notification via Linux notify-send (best-effort, zero cloud)."""
    if not shutil.which("notify-send"):
        return False
    try:
        subprocess.run(
            ["notify-send", "-a", "Daily", "-u", urgency, title, body],
            check=False,
            timeout=3,
        )
        return True
    except Exception:
        return False


def is_quiet_hour(now: datetime, start_h: int, end_h: int) -> bool:
    h = now.hour
    if start_h == end_h:
        return False
    if start_h > end_h:
        return h >= start_h or h < end_h
    return start_h <= h < end_h


def resolve_notification_options(
    habit: dict[str, Any],
    active_habits: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    today_direct: dict[str, float],
    max_options: int = 4,
    tasks: list[dict[str, Any]] | None = None,
    task_nudges_enabled: bool = True,
) -> list[str]:
    """Build concrete option suggestions straight from unblocked habit tasks + the signed (+) routing graph!

    - Actionable (unblocked) open tasks attached to this habit surface first so when TabPFN or an observed peak
      says "Good moment for Office", the notification directly suggests concrete next steps (never blocked ones!).
    - For min/neutral goals (e.g. 'Kreativität'): surfaces active cards routing with + into this goal
      (e.g. 'Buch: Dune', 'Bild gemalt', 'Musik'), prioritizing cards not yet touched today.
    - For max limits (e.g. 'Late Coffee'): uses explicit nudge_alternatives PLUS active cards that positively
      feed the same target(s) that this limit counts against (e.g. 'Walk +1 -> Health').
    """
    active_by_id = {h["id"]: h for h in active_habits if not h.get("archived")}
    hid = habit["id"]
    options: list[str] = []
    seen: set[str] = set()

    def add_opt(label: str) -> None:
        clean = label.strip()
        if clean and clean.lower() not in seen:
            seen.add(clean.lower())
            options.append(clean)

    # 0. Actionable (unblocked) open one-off tasks attached to this habit (up to 2 concrete next actions!)
    if task_nudges_enabled and tasks:
        habit_tasks = [
            t
            for t in tasks
            if t.get("habit_id") == hid and not t.get("done_at") and not t.get("deleted_at") and not t.get("is_blocked")
        ]
        for tk in habit_tasks[:2]:
            add_opt(str(tk.get("title") or ""))

    # 1. Explicit alternatives typed by the user come next
    raw_alts = (habit.get("nudge_alternatives") or "").strip()
    if raw_alts:
        for part in raw_alts.replace(";", ",").split(","):
            add_opt(part)

    # 2. Direct positive feeders into this habit (e.g. 'Buch: Dune' +1 -> 'Kreativität')
    feeders = [
        active_by_id[e["source_id"]]
        for e in edges
        if e["relation_type"] == "rollup"
        and e["target_id"] == hid
        and float(e["weight"]) > 0
        and e["source_id"] in active_by_id
    ]
    # Prefer untouched-today options first (surfaces queued books/projects naturally!)
    feeders.sort(key=lambda h: (1 if today_direct.get(h["id"], 0.0) > 0 else 0, h.get("sort_order", 0)))
    for f in feeders:
        add_opt(f["name"])

    # 3. For max limits: find positive counter-habits feeding the same targets this limit subtracts from
    if habit.get("kind") == "max":
        neg_targets = {
            e["target_id"]
            for e in edges
            if e["relation_type"] == "rollup" and e["source_id"] == hid and float(e["weight"]) < 0
        }
        if neg_targets:
            counters = [
                active_by_id[e["source_id"]]
                for e in edges
                if e["relation_type"] == "rollup"
                and e["target_id"] in neg_targets
                and float(e["weight"]) > 0
                and e["source_id"] != hid
                and e["source_id"] in active_by_id
            ]
            counters.sort(key=lambda h: (1 if today_direct.get(h["id"], 0.0) > 0 else 0, h.get("sort_order", 0)))
            for c in counters:
                add_opt(c["name"])

    return options[:max_options]


class NudgeScheduler:
    """Runs gently inside the local Daily daemon: checks once per minute."""

    def __init__(self, db_path: Path = DEFAULT_DB_PATH, port: int = 8090) -> None:
        self.db_path = db_path
        self.port = port
        self._fired_keys: set[str] = set()
        self._last_idle_ping: datetime | None = None
        self._last_e2ee_sync: datetime | None = None

    def evaluate_once(self, now: datetime | None = None) -> list[dict[str, str]]:
        now = now or datetime.now()
        settings = get_settings(self.db_path)
        if settings.get("notifications_enabled", "1") != "1":
            return []

        q_start = int(settings.get("quiet_hours_start", "23"))
        q_end = int(settings.get("quiet_hours_end", "8"))
        if is_quiet_hour(now, q_start, q_end):
            return []

        fired: list[dict[str, str]] = []
        today = now.date().isoformat()
        now_hhmm = f"{now.hour:02d}:{now.minute:02d}"
        nudge_mode = settings.get("nudge_mode", "observed")
        try:
            ai_threshold = float(settings.get("tabpfn_threshold", str(DEFAULT_TABPFN_THRESHOLD)))
        except ValueError:
            ai_threshold = DEFAULT_TABPFN_THRESHOLD

        habits = list_habits(include_archived=False, db_path=self.db_path)
        habits_by_id = {h["id"]: h for h in habits}
        edges = list_edges(db_path=self.db_path)
        events_14 = list_events(days_back=14, db_path=self.db_path)
        peaks = compute_hourly_peaks(habits, events_14)
        open_tasks = list_tasks(include_done=False, db_path=self.db_path)
        task_nudges_on = settings.get("task_nudges_enabled", "1") == "1"

        day_summary = compute_day_summary(day=today, db_path=self.db_path)
        today_cards = {h["id"]: h for h in day_summary["habits"]}
        today_direct = {hid: float(card["direct"]) for hid, card in today_cards.items()}

        def format_prompt(habit_obj: dict[str, Any], header_label: str, reason: str = "") -> tuple[str, str]:
            opts = resolve_notification_options(
                habit_obj,
                habits,
                edges,
                today_direct,
                tasks=open_tasks,
                task_nudges_enabled=task_nudges_on,
            )
            if habit_obj.get("kind") == "min":
                title = f"Daily · Guter Moment für {habit_obj['name']}"
                opt_line = f"Optionen: {' · '.join(opts)}" if opts else f"Kurzer Impuls für {habit_obj['name']}"
            else:
                title = header_label
                opt_line = f"Optionen: {' · '.join(opts)}" if opts else "Guter Moment für: Spaziergang, 15 Min. Lesen oder kurz was kochen"
            lines = [p for p in [reason, opt_line, f"http://127.0.0.1:{self.port}"] if p]
            return title, "\n".join(lines)

        # 1a. TabPFN contextual AI nudges (when user toggled 'KI' mode)
        ai_handled_ids: set[str] = set()
        if nudge_mode == "tabpfn" and any(h.get("nudge_enabled") for h in habits):
            events_60 = list_events(days_back=60, db_path=self.db_path)
            snaps_60 = list_snapshots(days_back=60, db_path=self.db_path)
            dims = list_state_dimensions(db_path=self.db_path)
            all_habits = list_habits(include_archived=True, db_path=self.db_path)
            ai_res = predict_contextual_nudges(
                all_habits,
                events_60,
                now=now,
                threshold=ai_threshold,
                snapshots=snaps_60,
                state_dims=dims,
            )
            for hid, pred in ai_res.get("predictions", {}).items():
                h_obj = habits_by_id.get(hid)
                if not h_obj or pred.get("status") != "ready":
                    continue
                ai_handled_ids.add(hid)
                card = today_cards.get(hid, {})
                # Don't nag for a min-goal that is already met today!
                if h_obj.get("kind") == "min" and card.get("status") == "met":
                    continue
                eff_thresh = min(ai_threshold, 0.45) if h_obj.get("kind") == "min" else ai_threshold
                if float(pred.get("prob_now") or 0.0) < eff_thresh:
                    continue
                block_key = f"ai:{today}:{hid}:{now.hour // 4}"
                if block_key in self._fired_keys:
                    continue
                self._fired_keys.add(block_key)
                pct = pred.get("prob_now_pct", int(round((pred.get("prob_now") or 0) * 100)))
                title, body = format_prompt(
                    h_obj,
                    f"Daily KI · {h_obj['name']} ({pct}%)",
                    reason=pred.get("reason", ""),
                )
                send_desktop_notification(title, body)
                fired.append(
                    {
                        "type": "tabpfn_nudge",
                        "habit_id": hid,
                        "prob": str(pred.get("prob_now")),
                        "title": title,
                        "body": body,
                    }
                )

        # 1b. Observed peak nudges
        for hid, info in peaks.items():
            h_obj = habits_by_id.get(hid)
            if not h_obj or not info["nudge_enabled"] or not info["nudge_time"] or hid in ai_handled_ids:
                continue
            card = today_cards.get(hid, {})
            if h_obj.get("kind") == "min" and card.get("status") == "met":
                continue
            key = f"peak:{today}:{hid}:{info['nudge_time']}"
            if key in self._fired_keys:
                continue
            nh, nm = map(int, info["nudge_time"].split(":"))
            diff = abs((now.hour * 60 + now.minute) - (nh * 60 + nm))
            if diff <= 1:
                self._fired_keys.add(key)
                title, body = format_prompt(
                    h_obj,
                    f"Daily Impuls · vor {info['habit_name']}-Peak ({info['peak_time']})",
                )
                send_desktop_notification(title, body)
                fired.append({"type": "pre_trigger", "habit_id": hid, "title": title, "body": body})

        # 1c. Fixed habit anchor reminders + gentle +45m "Hast du?" follow-up if not yet logged today!
        today_wd = now.weekday()
        followup_on = settings.get("followup_enabled", "1") == "1"
        now_min = now.hour * 60 + now.minute
        for h_obj in habits:
            r_times_raw = (h_obj.get("reminder_time") or "").strip()
            if not r_times_raw:
                continue
            card = today_cards.get(h_obj["id"], {})
            if h_obj.get("kind") == "min" and card.get("status") == "met":
                continue
            allowed_days = {
                int(p.strip())
                for p in str(h_obj.get("reminder_days") or "0,1,2,3,4,5,6").split(",")
                if p.strip().isdigit()
            }
            if allowed_days and today_wd not in allowed_days:
                continue
            for t_str in [p.strip() for p in r_times_raw.split(",") if p.strip()]:
                try:
                    rh, rm = map(int, t_str.split(":"))
                except ValueError:
                    continue
                anchor_min = rh * 60 + rm
                # Exact anchor reminder
                if abs(now_min - anchor_min) <= 1:
                    akey = f"anchor:{today}:{h_obj['id']}:{rh:02d}:{rm:02d}"
                    if akey not in self._fired_keys:
                        self._fired_keys.add(akey)
                        title, body = format_prompt(
                            h_obj,
                            f"Daily · Erinnerung: {h_obj['name']} ({rh:02d}:{rm:02d})",
                        )
                        send_desktop_notification(title, body)
                        fired.append(
                            {
                                "type": "fixed_anchor",
                                "habit_id": h_obj["id"],
                                "at": f"{rh:02d}:{rm:02d}",
                                "title": title,
                                "body": body,
                            }
                        )
                # Silent +45m "Hast du?" follow-up ONLY if nothing logged yet for this habit today
                followup_min = anchor_min + 45
                if (
                    followup_on
                    and followup_min < 24 * 60
                    and abs(now_min - followup_min) <= 1
                    and float(card.get("direct", 0.0)) <= 0
                    and float(card.get("effective", 0.0)) <= 0
                ):
                    fkey = f"followup:{today}:{h_obj['id']}:{rh:02d}:{rm:02d}"
                    if fkey not in self._fired_keys:
                        self._fired_keys.add(fkey)
                        title = f"Daily · Kurzer Check: {h_obj['name']}?"
                        body = f"Hast du um {rh:02d}:{rm:02d} „{h_obj['name']}“ gemacht? Kurz abhaken:\nhttp://127.0.0.1:{self.port}"
                        send_desktop_notification(title, body)
                        fired.append(
                            {
                                "type": "anchor_followup",
                                "habit_id": h_obj["id"],
                                "at": f"{followup_min // 60:02d}:{followup_min % 60:02d}",
                                "title": title,
                                "body": body,
                            }
                        )

        # 1d. Calm real-deadline reminder (ONLY for unblocked open tasks with an explicit due_date within <= 3 days, max 1/day)
        if task_nudges_on and open_tasks:
            today_date = now.date()
            for tk in open_tasks:
                if tk.get("is_blocked") or not tk.get("due_date"):
                    continue
                try:
                    due_d = datetime.fromisoformat(tk["due_date"]).date()
                except ValueError:
                    continue
                days_left = (due_d - today_date).days
                if days_left > 3:
                    continue
                dkey = f"task_due:{today}:{tk['id']}"
                if dkey in self._fired_keys:
                    continue
                self._fired_keys.add(dkey)
                if days_left < 0:
                    when_lbl = f"Frist vor {abs(days_left)} T."
                elif days_left == 0:
                    when_lbl = "Frist heute"
                elif days_left == 1:
                    when_lbl = "Frist morgen"
                else:
                    when_lbl = f"Frist in {days_left} Tagen"
                h_ctx = f" ({tk['habit_name']})" if tk.get("habit_name") else ""
                title = f"Daily · {when_lbl}{h_ctx}"
                body = f"{tk['title']}\nhttp://127.0.0.1:{self.port}"
                send_desktop_notification(title, body)
                fired.append({"type": "task_due", "task_id": tk["id"], "title": title, "body": body})

        # 2. Idle retro check-in prompt
        interval_h = max(1, int(settings.get("checkin_interval_hours", "3")))
        last_ts = last_event_time(self.db_path)
        if habits and last_ts is not None:
            idle_since = now - last_ts
            can_ping = self._last_idle_ping is None or (now - self._last_idle_ping) >= timedelta(hours=interval_h)
            if idle_since >= timedelta(hours=interval_h) and can_ping:
                self._last_idle_ping = now
                title = f"Daily Check-in · letzte {interval_h}h"
                body = f"Was ging die letzten {interval_h} Stunden? Kurz in 10 Sek. nachtragen (Taste R):\nhttp://127.0.0.1:{self.port}"
                send_desktop_notification(title, body)
                fired.append({"type": "idle_checkin", "at": now_hhmm, "title": title, "body": body})

        self._fired_keys = {k for k in self._fired_keys if today in k}
        return fired

    async def run_forever(self) -> None:
        while True:
            try:
                self.evaluate_once()
            except Exception:
                pass
            # Gentle 5-minute background E2EE vault pull/push when enabled (keeps PC TabPFN synced with phone/tablet!)
            try:
                now = datetime.now()
                if self._last_e2ee_sync is None or (now - self._last_e2ee_sync) >= timedelta(minutes=5):
                    settings = get_settings(self.db_path)
                    if settings.get("e2ee_enabled") == "1" and settings.get("e2ee_key"):
                        from .e2ee import sync_e2ee_vault

                        await asyncio.to_thread(sync_e2ee_vault, self.db_path)
                    self._last_e2ee_sync = now
            except Exception:
                pass
            await asyncio.sleep(60)

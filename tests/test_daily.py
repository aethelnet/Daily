"""Unit & API tests for Daily v0.1 (zero presets, signed +/- routing, cycle guard, retro & hypothesis math)."""
from __future__ import annotations

import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from daily.analytics import compute_analysis_board, compute_day_summary, export_tabpfn_features_csv
from daily.app import create_app
from daily.db import (
    create_habit,
    init_db,
    list_habits,
    log_event,
    log_retro_batch,
    upsert_edge,
)
from daily.nudges import NudgeScheduler


class TestDailyCore(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "test_daily.db"
        init_db(self.db)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_zero_presets_on_fresh_db(self) -> None:
        self.assertEqual(list_habits(db_path=self.db), [])

    def test_signed_rollup_positive_negative_and_cycle_safe(self) -> None:
        kreativ = create_habit("Kreativ", kind="min", target=2, db_path=self.db)
        malen = create_habit("Bild gemalt", kind="neutral", db_path=self.db)
        musik = create_habit("Musik gemacht", kind="neutral", db_path=self.db)
        fokus = create_habit("Fokus", kind="min", target=3, db_path=self.db)
        espresso = create_habit("Espresso", kind="max", target=1, db_path=self.db)

        upsert_edge(malen["id"], kreativ["id"], "rollup", +1.0, db_path=self.db)
        upsert_edge(musik["id"], kreativ["id"], "rollup", +1.0, db_path=self.db)
        upsert_edge(espresso["id"], fokus["id"], "rollup", -1.0, db_path=self.db)
        # Deliberate cycle: Kreativ -> Malen must NOT infinite-loop!
        upsert_edge(kreativ["id"], malen["id"], "rollup", +1.0, db_path=self.db)

        day = "2026-11-25"
        log_event(malen["id"], 1.0, f"{day}T14:00:00", db_path=self.db)
        log_event(musik["id"], 1.0, f"{day}T15:00:00", db_path=self.db)
        log_event(fokus["id"], 3.0, f"{day}T11:00:00", db_path=self.db)
        log_event(espresso["id"], 1.0, f"{day}T16:00:00", db_path=self.db)

        summary = compute_day_summary(day=day, db_path=self.db)
        by_id = {h["id"]: h for h in summary["habits"]}

        self.assertEqual(by_id[kreativ["id"]]["direct"], 0.0)
        self.assertEqual(by_id[kreativ["id"]]["routed"], 2.0)
        self.assertEqual(by_id[kreativ["id"]]["effective"], 2.0)
        self.assertEqual(by_id[kreativ["id"]]["status"], "met")

        self.assertEqual(by_id[fokus["id"]]["direct"], 3.0)
        self.assertEqual(by_id[fokus["id"]]["routed"], -1.0)
        self.assertEqual(by_id[fokus["id"]]["effective"], 2.0)
        self.assertEqual(by_id[fokus["id"]]["status"], "in_progress")

        self.assertEqual(by_id[espresso["id"]]["status"], "warning")  # 1/1 = 100% of max limit

    def test_retro_batch_spreads_timestamps_across_window(self) -> None:
        code = create_habit("Programmieren", kind="neutral", db_path=self.db)
        lesen = create_habit("Buch lesen", kind="neutral", db_path=self.db)

        created = log_retro_batch(
            items=[{"habit_id": code["id"], "amount": 2}, {"habit_id": lesen["id"], "amount": 1}],
            window_minutes=180,
            end_at="2026-11-25T16:00:00",
            note="Nachmittagsblock",
            db_path=self.db,
        )
        self.assertEqual(len(created), 2)
        t0 = datetime.fromisoformat(created[0]["occurred_at"])
        t1 = datetime.fromisoformat(created[1]["occurred_at"])
        self.assertGreater(t0, datetime.fromisoformat("2026-11-25T13:00:00"))
        self.assertLess(t1, datetime.fromisoformat("2026-11-25T16:00:00"))
        self.assertLess(t0, t1)

    def test_hypothesis_vs_reality_surprising_reversal_and_csv(self) -> None:
        espresso = create_habit("Espresso", kind="max", target=1, nudge_enabled=True, nudge_lead_min=20, db_path=self.db)
        malen = create_habit("Malen", kind="min", target=1, db_path=self.db)
        # User hypothesizes afternoon espresso hurts painting (-1), but data shows it actually INCREASES painting!
        upsert_edge(espresso["id"], malen["id"], "hypothesis", -1.0, context_window="afternoon", note="bremst?", db_path=self.db)

        base = date.today() - timedelta(days=5)
        for i in range(6):
            d = (base + timedelta(days=i)).isoformat()
            if i < 3:
                log_event(espresso["id"], 1.0, f"{d}T15:00:00", db_path=self.db)
                log_event(malen["id"], 2.0, f"{d}T16:00:00", db_path=self.db)
            else:
                log_event(malen["id"], 0.0, f"{d}T16:00:00", db_path=self.db)

        board = compute_analysis_board(days=30, db_path=self.db)
        self.assertEqual(board["observed_days"], 6)
        self.assertEqual(len(board["hypotheses"]), 1)
        h_eval = board["hypotheses"][0]
        self.assertEqual(h_eval["verdict"], "surprising")
        self.assertAlmostEqual(h_eval["avg_with"], 2.0)
        self.assertAlmostEqual(h_eval["avg_without"], 0.0)

        # Peak rhythm should be ~15:00 with pre-trigger nudge at 14:40
        e_rhythm = next(r for r in board["rhythms"] if r["habit_id"] == espresso["id"])
        self.assertEqual(e_rhythm["peak_time"], "15:00")
        self.assertEqual(e_rhythm["nudge_time"], "14:40")

        # CSV export for TabPFN/XGBoost
        csv_text = export_tabpfn_features_csv(db_path=self.db)
        self.assertIn("espresso__afternoon", csv_text)
        self.assertIn("malen__effective", csv_text)
        self.assertEqual(len(csv_text.strip().splitlines()), 7)  # header + 6 days

    def test_api_end_to_end_and_nudge_scheduler(self) -> None:
        app = create_app(db_path=self.db, enable_nudge_loop=False)
        client = TestClient(app)

        self.assertEqual(client.get("/api/health").status_code, 200)
        r = client.post("/api/habits", json={"name": "Kochen", "kind": "min", "target": 2})
        self.assertEqual(r.status_code, 200)
        hid = r.json()["id"]

        r2 = client.post("/api/events", json={"habit_id": hid, "amount": 1})
        self.assertEqual(r2.status_code, 200)
        today = client.get("/api/today").json()
        self.assertEqual(today["habits"][0]["effective"], 1.0)
        self.assertEqual(client.get("/api/export/features.csv").status_code, 200)

        # Quiet hours check on NudgeScheduler (no crash)
        sched = NudgeScheduler(self.db)
        fired_quiet = sched.evaluate_once(now=datetime(2026, 11, 25, 2, 0, 0))
        self.assertEqual(fired_quiet, [])

    def test_tabpfn_discovers_ai_assumptions_and_contextual_nudges(self) -> None:
        from unittest.mock import patch

        kaffee = create_habit("Kaffee", kind="max", target=1, nudge_enabled=True, nudge_alternatives="Spaziergang", db_path=self.db)
        malen = create_habit("Malen", kind="min", target=1, db_path=self.db)
        kochen = create_habit("Kochen", kind="min", target=1, db_path=self.db)

        # Create 14 realistic days with independent factors (not 100% collinear):
        # - Whenever Kaffee happens in afternoon (15:00), Malen jumps to 3.0; evening Kaffee (19:00) -> Malen 0.0
        # - Kochen happens independently on a varied schedule and predicts evening Kaffee @19:00
        pattern = [
            # (kaffee_hour, kochen_done, malen_val)
            (15, True, 3.0),
            (19, True, 0.0),
            (15, False, 3.0),
            (None, False, 0.0),
            (19, True, 0.0),
            (15, True, 3.0),
            (19, True, 0.0),
            (None, False, 0.0),
            (15, False, 3.0),
            (19, True, 0.0),
            (15, False, 3.0),
            (19, True, 0.0),
            (None, False, 0.0),
            (15, True, 3.0),
        ]
        base = date.today() - timedelta(days=len(pattern))
        for i, (kh, cooked, m_val) in enumerate(pattern):
            d = (base + timedelta(days=i)).isoformat()
            if cooked:
                log_event(kochen["id"], 1.0, f"{d}T13:00:00", db_path=self.db)
            if kh is not None:
                log_event(kaffee["id"], 1.0, f"{d}T{kh:02d}:00:00", db_path=self.db)
            log_event(malen["id"], m_val, f"{d}T16:30:00", db_path=self.db)

        app = create_app(db_path=self.db, enable_nudge_loop=False)
        client = TestClient(app)

        analysis = client.get("/api/analysis?days=30").json()
        ai = analysis["ai"]
        self.assertEqual(ai["engine"], "tabpfn-v2")
        self.assertEqual(ai["status"], "ready")
        self.assertGreaterEqual(len(ai["assumptions"]), 1)

        # Must surface Kaffee -> Malen marked explicitly as an AI assumption
        match = next(
            (a for a in ai["assumptions"] if a["source_id"] == kaffee["id"] and a["target_id"] == malen["id"]),
            None,
        )
        self.assertIsNotNone(match)
        self.assertTrue(match["is_ai_assumption"])
        self.assertGreater(match["predicted_delta"], 0.5)
        self.assertEqual(match["context_window"], "afternoon")
        self.assertFalse(match["already_saved"])

        # Adopt AI suggestion as a user hypothesis -> must now show already_saved=True
        adopt = client.post(
            "/api/edges",
            json={
                "source_id": match["source_id"],
                "target_id": match["target_id"],
                "relation_type": "hypothesis",
                "weight": match["direction"],
                "context_window": match["context_window"],
                "note": "KI-Annahme",
            },
        )
        self.assertEqual(adopt.status_code, 200)
        analysis2 = client.get("/api/analysis?days=30").json()
        match2 = next(
            a for a in analysis2["ai"]["assumptions"] if a["source_id"] == kaffee["id"] and a["target_id"] == malen["id"]
        )
        self.assertTrue(match2["already_saved"])

        # Switch notification mode to 'tabpfn' via API and test contextual scheduler
        s_resp = client.patch("/api/settings", json={"nudge_mode": "tabpfn", "tabpfn_threshold": 0.45})
        self.assertEqual(s_resp.status_code, 200)
        self.assertEqual(s_resp.json()["nudge_mode"], "tabpfn")

        # Today: we cooked at 13:00 -> TabPFN learned Kochen@13 -> Kaffee@19, NOT @10
        today_iso = date.today().isoformat()
        log_event(kochen["id"], 1.0, f"{today_iso}T13:00:00", db_path=self.db)

        sched = NudgeScheduler(self.db)
        with patch("daily.nudges.send_desktop_notification", return_value=True):
            morning_fired = sched.evaluate_once(now=datetime.fromisoformat(f"{today_iso}T10:00:00"))
            evening_fired = sched.evaluate_once(now=datetime.fromisoformat(f"{today_iso}T18:00:00"))

        self.assertFalse(any(f["type"] == "tabpfn_nudge" for f in morning_fired))
        self.assertTrue(any(f["type"] == "tabpfn_nudge" and f["habit_id"] == kaffee["id"] for f in evening_fired))

        # Tomorrow 24h forecast & calibration table must be populated
        self.assertIn(kaffee["id"], ai["tomorrow"])
        self.assertEqual(len(ai["tomorrow"][kaffee["id"]]["ai_hours"]), 24)
        self.assertGreaterEqual(len(ai["calibration"]), 3)
        self.assertIsNotNone(ai["overall_mae"])

        # Switch to KI mode on /api/today: log afternoon Kaffee today -> TabPFN should dynamically route + to Malen!
        log_event(kaffee["id"], 1.0, f"{today_iso}T15:00:00", db_path=self.db)
        manual_today = client.get(f"/api/today?day={today_iso}&mode=observed").json()
        ai_today = client.get(f"/api/today?day={today_iso}&mode=tabpfn").json()
        self.assertEqual(manual_today["routing_mode"], "observed")
        self.assertEqual(ai_today["routing_mode"], "tabpfn")

        malen_manual = next(h for h in manual_today["habits"] if h["id"] == malen["id"])
        malen_ai = next(h for h in ai_today["habits"] if h["id"] == malen["id"])
        self.assertEqual(malen_manual["routed"], 0.0)
        self.assertGreater(malen_ai["routed"], 0.5)
        self.assertTrue(any(c["from_id"] == kaffee["id"] and c["is_ai"] for c in malen_ai["contributors"]))

    def test_day1_forecast_and_habit_reorder(self) -> None:
        app = create_app(db_path=self.db, enable_nudge_loop=False)
        client = TestClient(app)

        h1 = client.post("/api/habits", json={"name": "Gesundheit", "kind": "min", "target": 2}).json()
        h2 = client.post("/api/habits", json={"name": "Kaffee", "kind": "max", "target": 1}).json()
        today_iso = date.today().isoformat()
        client.post("/api/events", json={"habit_id": h2["id"], "amount": 1, "occurred_at": f"{today_iso}T17:00:00"})

        # Reorder habits -> Kaffee first, Gesundheit second
        ro = client.post("/api/habits/reorder", json={"habit_ids": [h2["id"], h1["id"]]})
        self.assertEqual(ro.status_code, 200)
        ids = [h["id"] for h in ro.json()["habits"]]
        self.assertEqual(ids, [h2["id"], h1["id"]])

        # Day-1 analysis immediately predicts tomorrow's 24h curve & calibration error without warmup lockout
        an = client.get("/api/analysis").json()
        self.assertEqual(an["ai"]["status"], "ready")
        self.assertIsNotNone(an["ai"]["tomorrow"][h2["id"]]["ai_peak_hour"])
        self.assertEqual(len(an["ai"]["calibration"]), 2)
        self.assertIsNotNone(an["ai"]["overall_mae"])

    def test_graph_notification_options_archive_history_and_idempotent_sync(self) -> None:
        from daily.nudges import resolve_notification_options

        app = create_app(db_path=self.db, enable_nudge_loop=False)
        client = TestClient(app)

        kreativ = client.post("/api/habits", json={"name": "Kreativität", "kind": "min", "target": 1}).json()
        buch = client.post("/api/habits", json={"name": "Buch: Dune", "kind": "neutral"}).json()
        malen = client.post("/api/habits", json={"name": "Malen", "kind": "neutral"}).json()
        client.post("/api/edges", json={"source_id": buch["id"], "target_id": kreativ["id"], "relation_type": "rollup", "weight": 1})
        client.post("/api/edges", json={"source_id": malen["id"], "target_id": kreativ["id"], "relation_type": "rollup", "weight": 1})

        # Options for Kreativität must include both linked cards (untouched today first!)
        today_iso = date.today().isoformat()
        client.post("/api/events", json={"habit_id": malen["id"], "amount": 1, "occurred_at": f"{today_iso}T14:00:00"})
        meta = client.get("/api/habits").json()
        opts = resolve_notification_options(kreativ, meta["habits"], meta["edges"], {malen["id"]: 1.0})
        self.assertEqual(opts[0], "Buch: Dune")  # untouched today surfaces first!
        self.assertIn("Malen", opts)

        # Log Buch: Dune, then archive ("Fertig") -> disappears from Today & options, but Kreativität keeps its +1 rollup!
        client.post("/api/events", json={"habit_id": buch["id"], "amount": 1, "occurred_at": f"{today_iso}T15:00:00"})
        client.patch(f"/api/habits/{buch['id']}", json={"archived": True})
        today = client.get(f"/api/today?day={today_iso}").json()
        active_ids = [h["id"] for h in today["habits"]]
        self.assertNotIn(buch["id"], active_ids)
        k_card = next(h for h in today["habits"] if h["id"] == kreativ["id"])
        self.assertEqual(k_card["effective"], 2.0)  # Malen + archived Buch: Dune still preserved!

        meta_after = client.get("/api/habits").json()
        opts_after = resolve_notification_options(kreativ, meta_after["habits"], meta_after["edges"], {})
        self.assertNotIn("Buch: Dune", opts_after)

        # Offline-first idempotent delta sync via client_uuid (retrying twice must NEVER duplicate!)
        sync_payload = {
            "device_id": "pixel-9",
            "mutations": {
                "events": [
                    {
                        "habit_id": malen["id"],
                        "amount": 1.0,
                        "occurred_at": f"{today_iso}T16:00:00",
                        "source": "tap",
                        "client_uuid": "offline-uuid-abc-123",
                    }
                ]
            },
        }
        s1 = client.post("/api/sync", json=sync_payload)
        s2 = client.post("/api/sync", json=sync_payload)
        self.assertEqual(s1.status_code, 200)
        self.assertEqual(s2.status_code, 200)
        m_card = next(h for h in client.get(f"/api/today?day={today_iso}").json()["habits"] if h["id"] == malen["id"])
        self.assertEqual(m_card["direct"], 2.0)  # 1 original + 1 synced (NOT 3!)

        # Sync pairing info + QR SVG + PWA endpoints
        info = client.get("/api/sync/info").json()
        self.assertTrue(len(info["sync_token"]) >= 12)
        self.assertIn("<svg", info["qr_svg"])
        self.assertEqual(client.get("/manifest.webmanifest").status_code, 200)
        self.assertEqual(client.get("/sw.js").status_code, 200)
        self.assertEqual(client.get("/icon.svg").status_code, 200)

    def test_momentaufnahme_sparse_nans_tabpfn_and_fixed_anchor_reminders(self) -> None:
        from unittest.mock import patch

        app = create_app(db_path=self.db, enable_nudge_loop=False)
        client = TestClient(app)

        # 5 scientific EMA axes seeded automatically + custom axis creation + hiding
        dims = client.get("/api/state/dimensions").json()["dimensions"]
        dim_ids = [d["id"] for d in dims]
        for expected in ("stimmung", "mental-fit", "stress", "anspannung", "antrieb"):
            self.assertIn(expected, dim_ids)

        custom = client.post("/api/state/dimensions", json={"name": "Schlafqualität", "low_label": "0", "high_label": "stark"})
        self.assertEqual(custom.status_code, 200)

        # Create habits with fixed anchor reminders: Kochen daily at 13:00, Wäsche only Tue (1) at 18:00
        kochen = client.post(
            "/api/habits",
            json={"name": "Kochen", "kind": "min", "target": 1, "reminder_time": "13:00", "reminder_days": "0,1,2,3,4,5,6"},
        ).json()
        waesche = client.post(
            "/api/habits",
            json={"name": "Wäsche", "kind": "neutral", "reminder_time": "18:00", "reminder_days": "1"},
        ).json()
        self.assertEqual(kochen["reminder_time"], "13:00")
        self.assertEqual(waesche["reminder_days"], "1")

        # Log 10 days of Kochen vs non-Kochen, with SPARSE snapshots (only 6 of 10 days filled, half empty -> true NaNs!)
        base = date.today() - timedelta(days=10)
        for i in range(10):
            d = (base + timedelta(days=i)).isoformat()
            cooked = i % 2 == 0
            if cooked:
                client.post("/api/events", json={"habit_id": kochen["id"], "amount": 1, "occurred_at": f"{d}T13:10:00"})
            else:
                client.post("/api/events", json={"habit_id": waesche["id"], "amount": 1, "occurred_at": f"{d}T18:10:00"})
            if i < 6:
                # Sparse: only rate mental-fit on these 6 days (other axes omitted -> NaN!)
                client.post(
                    "/api/snapshots",
                    json={
                        "ratings": {"mental-fit": 5 if cooked else 2},
                        "causes": [kochen["id"]] if cooked else [],
                        "occurred_at": f"{d}T17:00:00",
                    },
                )

        # Analysis must run cleanly with true NaNs AND surface Kochen -> Mental fit (+) + 15-day state_curves!
        an = client.get("/api/analysis?days=30").json()
        self.assertEqual(an["ai"]["status"], "ready")
        state_hit = next(
            (a for a in an["ai"]["assumptions"] if a.get("is_state_target") and a["target_id"] == "state:mental-fit"),
            None,
        )
        self.assertIsNotNone(state_hit)
        self.assertGreater(state_hit["predicted_delta"], 0.5)

        mf_curve = next(c for c in an["ai"]["state_curves"] if c["id"] == "mental-fit")
        self.assertEqual(len(mf_curve["dates"]), 15)  # 14 days + tomorrow
        self.assertEqual(mf_curve["rated_count"], 6)
        self.assertTrue(all(v is not None and 1.0 <= v <= 5.0 for v in mf_curve["ai_curve"]))
        self.assertTrue(any(v is None for v in mf_curve["actual"]))  # sporadic gaps stay true None!

        # CSV export includes state__mental-fit with empty cells on unrated days
        csv_text = client.get("/api/export/features.csv").text
        self.assertIn("state__mental-fit", csv_text)

        # Fixed anchor reminder test: future unlogged Tuesday 2030-01-08 (weekday=1) at 13:00 fires Kochen;
        # 18:00 fires Wäsche; Wednesday 2030-01-09 (weekday=2) at 18:00 does NOT fire Wäsche!
        sched = NudgeScheduler(self.db)
        with patch("daily.nudges.send_desktop_notification", return_value=True):
            tue_13 = sched.evaluate_once(now=datetime(2030, 1, 8, 13, 0, 0))
            tue_18 = sched.evaluate_once(now=datetime(2030, 1, 8, 18, 0, 0))
            wed_18 = sched.evaluate_once(now=datetime(2030, 1, 9, 18, 0, 0))

        self.assertTrue(any(f["type"] == "fixed_anchor" and f["habit_id"] == kochen["id"] for f in tue_13))
        self.assertTrue(any(f["type"] == "fixed_anchor" and f["habit_id"] == waesche["id"] for f in tue_18))
        self.assertFalse(any(f["type"] == "fixed_anchor" and f["habit_id"] == waesche["id"] for f in wed_18))

        # Offline snapshot sync is idempotent via client_uuid
        snap_sync = {
            "device_id": "iphone",
            "mutations": {
                "snapshots": [
                    {
                        "ratings": {"stress": 4},
                        "note": "Bahn verspätet",
                        "occurred_at": f"{date.today().isoformat()}T16:30:00",
                        "client_uuid": "snap-uuid-999",
                    }
                ]
            },
        }
        client.post("/api/sync", json=snap_sync)
        client.post("/api/sync", json=snap_sync)
        today_snaps = client.get(f"/api/today?day={date.today().isoformat()}").json()["snapshots"]
        self.assertEqual(len([s for s in today_snaps if s.get("client_uuid") == "snap-uuid-999"]), 1)

    def test_merge_habit_transfers_events_snapshots_and_edges_cleanly(self) -> None:
        app = create_app(db_path=self.db, enable_nudge_loop=False)
        client = TestClient(app)

        prog = client.post("/api/habits", json={"name": "Programmieren", "kind": "min", "target": 2}).json()
        coding = client.post("/api/habits", json={"name": "Coding", "kind": "neutral"}).json()
        fokus = client.post("/api/habits", json={"name": "Fokus", "kind": "min", "target": 3}).json()

        # Coding routes +1 to Fokus and has events + snapshot cause
        client.post("/api/edges", json={"source_id": coding["id"], "target_id": fokus["id"], "relation_type": "rollup", "weight": 1})
        today_iso = date.today().isoformat()
        client.post("/api/events", json={"habit_id": prog["id"], "amount": 1, "occurred_at": f"{today_iso}T10:00:00"})
        client.post("/api/events", json={"habit_id": coding["id"], "amount": 2, "occurred_at": f"{today_iso}T14:00:00", "note": ""})
        client.post("/api/snapshots", json={"ratings": {"mental-fit": 4}, "causes": [coding["id"]], "occurred_at": f"{today_iso}T15:00:00"})

        # Merge Coding -> Programmieren
        m = client.post(f"/api/habits/{coding['id']}/merge", json={"target_id": prog["id"], "tag_notes": True})
        self.assertEqual(m.status_code, 200)
        mj = m.json()
        self.assertEqual(mj["moved_events"], 1)
        self.assertEqual(mj["updated_snapshots"], 1)
        self.assertEqual(mj["moved_edges"], 1)

        # Coding is gone; Programmieren now has direct=3.0 (1+2), Fokus gets +3.0 routed from Programmieren,
        # transferred event has note "aus: Coding", and snapshot cause is remapped to Programmieren!
        today = client.get(f"/api/today?day={today_iso}").json()
        ids = [h["id"] for h in today["habits"]]
        self.assertNotIn(coding["id"], ids)
        p_card = next(h for h in today["habits"] if h["id"] == prog["id"])
        f_card = next(h for h in today["habits"] if h["id"] == fokus["id"])
        self.assertEqual(p_card["direct"], 3.0)
        self.assertEqual(f_card["routed"], 3.0)
        self.assertTrue(any(ev["note"] == "aus: Coding" and ev["habit_id"] == prog["id"] for ev in today["events"]))
        self.assertEqual(today["snapshots"][0]["causes"], [prog["id"]])

    def test_e2ee_aes256gcm_cross_compat_python_webcrypto_and_crdt_merge(self) -> None:
        import json
        import subprocess
        from daily.e2ee import (
            build_e2ee_pairing_bundle,
            decrypt_vault_payload,
            encrypt_vault_payload,
            export_local_state_for_vault,
            generate_e2ee_key,
            merge_remote_state_into_db,
        )

        # Device A (PC): create habit + event
        kochen = create_habit("Kochen", kind="min", target=2, db_path=self.db)
        today_iso = date.today().isoformat()
        log_event(kochen["id"], 1.0, f"{today_iso}T13:00:00", note="PC-Log", client_uuid="pc-ev-1", db_path=self.db)

        key = generate_e2ee_key()
        payload_a = export_local_state_for_vault(self.db)
        env_py = encrypt_vault_payload(payload_a, key)
        self.assertEqual(env_py["alg"], "AES-256-GCM")
        # Plaintext habit name must NEVER appear in ciphertext envelope!
        self.assertNotIn("Kochen", json.dumps(env_py))

        # Cross-runtime verification: Node WebCrypto decrypts Python AES-256-GCM, merges an offline phone tap,
        # re-encrypts with WebCrypto AES-256-GCM, and Python decrypts + merges back into SQLite!
        node_script = """
        const e2ee = require('./static/e2ee-sync.js');
        (async () => {
          const inp = JSON.parse(process.argv[1]);
          const dec = await e2ee.decryptPayload(inp.env, inp.key);
          const phoneDb = { habits: [], edges: [], events: [], snapshots: [], state_dimensions: [], settings: {}, next_id: 1 };
          const merged = e2ee.mergeDatabases(phoneDb, dec);
          merged.events.push({
            id: 999,
            habit_id: 'kochen',
            amount: 1,
            occurred_at: inp.today + 'T18:00:00',
            window_minutes: 0,
            source: 'tap',
            note: 'Handy-Mobilfunk',
            client_uuid: 'phone-ev-2',
            created_at: inp.today + 'T18:00:00',
            updated_at: inp.today + 'T18:00:00',
            deleted_at: null,
          });
          const outEnv = await e2ee.encryptPayload(merged, inp.key);
          process.stdout.write(JSON.stringify(outEnv));
        })().catch(e => { console.error(e); process.exit(1); });
        """
        proc = subprocess.run(
            ["node", "-e", node_script, json.dumps({"env": env_py, "key": key, "today": today_iso})],
            cwd=str(Path(__file__).resolve().parent.parent),
            capture_output=True,
            text=True,
            check=True,
        )
        env_js = json.loads(proc.stdout)
        self.assertNotIn("Handy-Mobilfunk", proc.stdout)

        # Python decrypts JS WebCrypto envelope & merges conflict-free into PC DB!
        decrypted_from_phone = decrypt_vault_payload(env_js, key)
        stats = merge_remote_state_into_db(decrypted_from_phone, db_path=self.db)
        self.assertEqual(stats["events"], 1)

        # PC now has BOTH events (direct=2.0), zero duplicates even if merged again!
        merge_remote_state_into_db(decrypted_from_phone, db_path=self.db)
        summary = compute_day_summary(day=today_iso, db_path=self.db)
        k_card = next(h for h in summary["habits"] if h["id"] == kochen["id"])
        self.assertEqual(k_card["direct"], 2.0)

        # Pairing bundle uses URL fragment (#e2ee=...) — never query string!
        bundle = build_e2ee_pairing_bundle({"provider": "gist", "gist_id": "abc123", "auth_token": "tok", "key_b64u": key})
        self.assertIn("/#e2ee=", bundle["pair_url"])
        self.assertIn("<svg", bundle["qr_svg"])

    def test_period_targets_liquid_ode_multiscale_and_followup(self) -> None:
        from unittest.mock import patch

        app = create_app(db_path=self.db, enable_nudge_loop=False)
        client = TestClient(app)

        # 1. Weekly & Monthly period targets (no ugly 0.3/day fractions!)
        sport = client.post(
            "/api/habits",
            json={"name": "Sport", "kind": "min", "target": 3, "target_period": "week"},
        ).json()
        waesche = client.post(
            "/api/habits",
            json={"name": "Wäsche", "kind": "min", "target": 4, "target_period": "month"},
        ).json()
        kochen = client.post(
            "/api/habits",
            json={
                "name": "Kochen",
                "kind": "min",
                "target": 1,
                "reminder_time": "13:00",
                "reminder_days": "0,1,2,3,4,5,6",
            },
        ).json()
        self.assertEqual(sport["target_period"], "week")
        self.assertEqual(waesche["target_period"], "month")

        # Mon 2026-11-23 + Wed 2026-11-25 in same ISO week
        mon_iso = "2026-11-23"
        wed_iso = "2026-11-25"
        client.post("/api/events", json={"habit_id": sport["id"], "amount": 1, "occurred_at": f"{mon_iso}T10:00:00"})
        client.post("/api/events", json={"habit_id": sport["id"], "amount": 1, "occurred_at": f"{wed_iso}T14:00:00"})
        client.post("/api/events", json={"habit_id": waesche["id"], "amount": 2, "occurred_at": "2026-11-05T12:00:00"})
        client.post("/api/events", json={"habit_id": waesche["id"], "amount": 2, "occurred_at": f"{wed_iso}T15:00:00"})

        wed_summary = client.get(f"/api/today?day={wed_iso}").json()
        s_card = next(h for h in wed_summary["habits"] if h["id"] == sport["id"])
        w_card = next(h for h in wed_summary["habits"] if h["id"] == waesche["id"])
        self.assertEqual(s_card["effective"], 1.0)
        self.assertEqual(s_card["period_effective"], 2.0)
        self.assertEqual(s_card["status"], "in_progress")
        self.assertEqual(w_card["period_effective"], 4.0)
        self.assertEqual(w_card["status"], "met")

        # Log 3rd Sport on Wednesday -> weekly target met!
        client.post("/api/events", json={"habit_id": sport["id"], "amount": 1, "occurred_at": f"{wed_iso}T18:00:00"})
        s_card2 = next(h for h in client.get(f"/api/today?day={wed_iso}").json()["habits"] if h["id"] == sport["id"])
        self.assertEqual(s_card2["period_effective"], 3.0)
        self.assertEqual(s_card2["status"], "met")

        # 2. Continuous-Time Liquid Relaxation ODE ("Uhrwerk") + Multi-Scale (24h | 14T | 8W) Befinden curves
        today_iso = date.today().isoformat()
        for d_off in (4, 3, 2, 1):
            d_str = (date.today() - timedelta(days=d_off)).isoformat()
            did_sport = d_off % 2 == 0
            if did_sport:
                client.post("/api/events", json={"habit_id": sport["id"], "amount": 1, "occurred_at": f"{d_str}T14:00:00"})
            client.post(
                "/api/snapshots",
                json={"ratings": {"stimmung": 5 if did_sport else 2}, "occurred_at": f"{d_str}T17:00:00"},
            )
        # Today: 2 exact snapshots + 1 habit impulse
        client.post("/api/snapshots", json={"ratings": {"stimmung": 2}, "occurred_at": f"{today_iso}T09:30:00"})
        client.post("/api/events", json={"habit_id": sport["id"], "amount": 1, "occurred_at": f"{today_iso}T14:00:00"})
        client.post("/api/snapshots", json={"ratings": {"stimmung": 5}, "occurred_at": f"{today_iso}T16:00:00"})

        an = client.get("/api/analysis?days=30").json()
        st_curve = next(c for c in an["ai"]["state_curves"] if c["id"] == "stimmung")
        self.assertIn(st_curve["ode_tau_hours"], (2.0, 6.0, 18.0, 48.0))
        self.assertEqual(len(st_curve["h24"]["hours"]), 49)
        self.assertEqual(len(st_curve["h24"]["ode"]), 49)
        self.assertEqual(len(st_curve["h24"]["tabpfn"]), 49)
        self.assertGreater(max(st_curve["h24"]["tabpfn"]) - min(st_curve["h24"]["tabpfn"]), 0.05)
        self.assertEqual(len(st_curve["h24"]["actual"]), 2)
        self.assertGreaterEqual(len(st_curve["h24"]["habit_ticks"]), 1)
        self.assertTrue(all(1.0 <= v <= 5.0 for v in st_curve["h24"]["ode"]))
        self.assertEqual(len(st_curve["d14"]["dates"]), 15)
        self.assertEqual(len(st_curve["d14"]["ode"]), 15)
        self.assertEqual(len(st_curve["d14"]["tabpfn"]), 15)
        self.assertEqual(len(st_curve["w8"]["labels"]), 8)
        self.assertEqual(len(st_curve["w8"]["ode"]), 8)
        self.assertEqual(len(st_curve["w8"]["tabpfn"]), 8)
        # Continuous pan/zoom timeline + fading future confidence (conf strictly decays into the future!)
        tl = st_curve["timeline"]
        self.assertGreater(len(tl["ode"]), 100)
        self.assertGreater(len(tl["tabpfn"]), 30)
        fut_ode = [p for p in tl["ode"] if p[0] > 24.0]
        self.assertGreater(len(fut_ode), 10)
        self.assertGreater(fut_ode[0][2], fut_ode[-1][2])  # confidence decays with horizon
        self.assertLess(fut_ode[0][3], fut_ode[-1][3])     # confidence ribbon widens with horizon

        # 3. Quiet +45m anchor follow-up: fires when unlogged, silent once logged or disabled!
        sched = NudgeScheduler(self.db)
        with patch("daily.nudges.send_desktop_notification", return_value=True):
            # Future unlogged day 2030-01-10 13:45 -> Kochen anchor 13:00 unlogged -> follow-up fires!
            f_unlogged = sched.evaluate_once(now=datetime(2030, 1, 10, 13, 45, 0))
            self.assertTrue(any(f["type"] == "anchor_followup" and f["habit_id"] == kochen["id"] for f in f_unlogged))

            # 2030-01-11 -> Kochen logged at 13:10 -> 13:45 stays completely silent!
            client.post("/api/events", json={"habit_id": kochen["id"], "amount": 1, "occurred_at": "2030-01-11T13:10:00"})
            f_logged = sched.evaluate_once(now=datetime(2030, 1, 11, 13, 45, 0))
            self.assertFalse(any(f["type"] == "anchor_followup" and f["habit_id"] == kochen["id"] for f in f_logged))

            # Turn off followup_enabled -> silent even when unlogged!
            client.patch("/api/settings", json={"followup_enabled": 0})
            f_disabled = sched.evaluate_once(now=datetime(2030, 1, 12, 13, 45, 0))
            self.assertFalse(any(f["type"] == "anchor_followup" for f in f_disabled))

    def test_note_hashtags_extracted_for_tabpfn_and_csv(self) -> None:
        from daily.analytics import extract_note_tags
        from daily.db import create_snapshot, list_edges, list_events, list_snapshots, list_state_dimensions
        from daily.ml import compute_ai_insights

        self.assertEqual(extract_note_tags("Deep session #Flow #FrischeLuft #x"), {"flow", "frischeluft"})
        h_focus = create_habit("Focus", kind="min", target=2, db_path=self.db)
        h_walk = create_habit("Walk", kind="neutral", db_path=self.db)

        for d_off in range(5, -1, -1):
            d_str = (date.today() - timedelta(days=d_off)).isoformat()
            is_flow = d_off % 2 == 0
            note = "Great focus #flow" if is_flow else ("One-off #rareonce" if d_off == 1 else "Normal day")
            log_event(h_focus["id"], 2.0 if is_flow else 1.0, occurred_at=f"{d_str}T11:00:00", note=note, db_path=self.db)
            if is_flow:
                log_event(h_walk["id"], 1.0, occurred_at=f"{d_str}T08:30:00", db_path=self.db)
            create_snapshot(
                ratings={"stimmung": 5 if is_flow else 2},
                note="#flow mood" if is_flow else "",
                occurred_at=f"{d_str}T18:00:00",
                db_path=self.db,
            )

        csv_text = export_tabpfn_features_csv(db_path=self.db)
        header = csv_text.splitlines()[0].split(",")
        self.assertIn("tag__flow", header)
        self.assertNotIn("tag__rareonce", header)

        ai = compute_ai_insights(
            list_habits(db_path=self.db),
            list_edges(db_path=self.db),
            list_events(db_path=self.db),
            snapshots=list_snapshots(db_path=self.db),
            state_dims=list_state_dimensions(db_path=self.db),
        )
        self.assertEqual(ai["status"], "ready")
        self.assertTrue(any(c["id"] == "stimmung" and c["rated_count"] == 6 for c in ai["state_curves"]))
        audit = ai["feature_audit"]
        self.assertEqual([t["tag"] for t in audit["active_tags"]], ["flow"])
        self.assertEqual([t["tag"] for t in audit["pending_tags"]], ["rareonce"])
        app = create_app(db_path=self.db, enable_nudge_loop=False)
        client = TestClient(app)
        hab_resp = client.get("/api/habits").json()
        self.assertTrue(any(t["tag"] == "flow" and t["ai_active"] for t in hab_resp["tags"]))
        self.assertTrue(any(t["tag"] == "rareonce" and not t["ai_active"] for t in hab_resp["tags"]))

    def test_active_session_toggle_half_block_rounding_and_e2ee_sync(self) -> None:
        from daily.e2ee import export_local_state_for_vault, merge_remote_state_into_db

        app = create_app(db_path=self.db, enable_nudge_loop=False)
        client = TestClient(app)

        coding = client.post(
            "/api/habits",
            json={"name": "Coding", "kind": "min", "target": 4, "unit": "blocks", "block_minutes": 30},
        ).json()
        self.assertEqual(coding["block_minutes"], 30)
        self.assertIsNone(coding["active_since"])

        # Accidental quick start->stop (< 1 min) must discard without logging any event!
        client.post(f"/api/habits/{coding['id']}/toggle-active", json={"now_at": "2026-11-26T08:55:00"})
        r_short = client.post(
            f"/api/habits/{coding['id']}/toggle-active",
            json={"now_at": "2026-11-26T08:55:25"},
        ).json()
        self.assertFalse(r_short["active"])
        self.assertFalse(r_short["logged"])
        self.assertTrue(r_short["too_short"])

        # Start session at 09:00 -> active_since set
        r_start = client.post(
            f"/api/habits/{coding['id']}/toggle-active",
            json={"now_at": "2026-11-26T09:00:00"},
        ).json()
        self.assertTrue(r_start["active"])
        self.assertEqual(r_start["active_since"], "2026-11-26T09:00:00")

        # Verify E2EE export & merge into second DB preserves block_minutes & active_since!
        vault_state = export_local_state_for_vault(self.db)
        other_db = Path(self.tmp.name) / "phone_mirror.db"
        init_db(other_db)
        merge_remote_state_into_db(vault_state, db_path=other_db)
        mirrored = next(h for h in list_habits(db_path=other_db) if h["id"] == coding["id"])
        self.assertEqual(mirrored["block_minutes"], 30)
        self.assertEqual(mirrored["active_since"], "2026-11-26T09:00:00")

        # Stop after 45 min -> 45/30 = 1.5 blocks logged with window_minutes=45
        r_stop = client.post(
            f"/api/habits/{coding['id']}/toggle-active",
            json={"now_at": "2026-11-26T09:45:00"},
        ).json()
        self.assertFalse(r_stop["active"])
        self.assertTrue(r_stop["logged"])
        self.assertEqual(r_stop["amount"], 1.5)
        self.assertEqual(r_stop["elapsed_minutes"], 45)
        self.assertEqual(r_stop["event"]["window_minutes"], 45)

        # Retroactive time-range adjustment via PATCH /api/events/{id} updates window_minutes + amount
        r_patch = client.patch(
            f"/api/events/{r_stop['event']['id']}",
            json={"occurred_at": "2026-11-26T09:30:00", "window_minutes": 30, "amount": 1.0},
        ).json()
        self.assertEqual(r_patch["window_minutes"], 30)
        self.assertEqual(r_patch["amount"], 1.0)

        # Start again & stop with override_minutes=70 -> 70/30 = 2.333 -> rounds to 2.3 (0.1 precision!)
        client.post(f"/api/habits/{coding['id']}/toggle-active", json={"now_at": "2026-11-26T10:00:00"})
        r_ov = client.post(
            f"/api/habits/{coding['id']}/toggle-active",
            json={"now_at": "2026-11-26T23:55:00", "override_minutes": 70},
        ).json()
        self.assertEqual(r_ov["amount"], 2.3)

        # Start again & cancel -> stops cleanly with zero event logged!
        client.post(f"/api/habits/{coding['id']}/toggle-active", json={"now_at": "2026-11-26T12:00:00"})
        r_can = client.post(f"/api/habits/{coding['id']}/toggle-active", json={"cancel": True}).json()
        self.assertFalse(r_can["active"])
        self.assertFalse(r_can["logged"])

        # Multi-day log range query (/api/log) returns events & snapshots across dates, handles swapped bounds!
        client.post("/api/events", json={"habit_id": coding["id"], "amount": 1, "occurred_at": "2026-11-22T14:00:00", "note": "before"})
        client.post("/api/events", json={"habit_id": coding["id"], "amount": 1, "occurred_at": "2026-11-24T16:00:00", "note": "inside"})
        client.post("/api/snapshots", json={"ratings": {"stimmung": 2}, "occurred_at": "2026-11-25T19:00:00", "note": "rough day"})
        r_log = client.get("/api/log?start=2026-11-26&end=2026-11-24").json()
        self.assertEqual(r_log["start"], "2026-11-24")
        self.assertEqual(r_log["end"], "2026-11-26")
        ev_notes = [e["note"] for e in r_log["events"]]
        self.assertIn("inside", ev_notes)
        self.assertNotIn("before", ev_notes)
        self.assertEqual(len(r_log["snapshots"]), 1)
        self.assertEqual(r_log["snapshots"][0]["note"], "rough day")

        # Fast 7-day matrix paging (/api/matrix?end=...) cleanly computes older weeks
        r_mat = client.get("/api/matrix?end=2026-11-24").json()
        self.assertEqual(r_mat["end"], "2026-11-24")
        self.assertEqual(len(r_mat["dates"]), 7)
        c_row = next(r for r in r_mat["week_matrix"] if r["habit_id"] == coding["id"])
        d24 = next(c for c in c_row["days"] if c["day"] == "2026-11-24")
        self.assertEqual(d24["effective"], 1.0)

        # Multi-modal 24h peak detection: morning (09:00) + evening (20:00) habit yields 2 distinct peaks!
        for d_off in range(4):
            d_s = (date.today() - timedelta(days=d_off)).isoformat()
            client.post("/api/events", json={"habit_id": coding["id"], "amount": 1, "occurred_at": f"{d_s}T09:15:00"})
            client.post("/api/events", json={"habit_id": coding["id"], "amount": 1, "occurred_at": f"{d_s}T20:10:00"})
        an_mp = client.get("/api/analysis").json()
        r_cod = next(r for r in an_mp["rhythms"] if r["habit_id"] == coding["id"])
        self.assertIn(9, r_cod["peak_hours"])
        self.assertIn(20, r_cod["peak_hours"])
        tm_cod = an_mp["ai"]["tomorrow"][coding["id"]]
        self.assertGreaterEqual(len(tm_cod["ai_peaks"]), 2)

    def test_retroactive_edits_and_deletions_clean_tabpfn_liquid_ode_and_e2ee(self) -> None:
        from daily.db import get_conn, list_events
        from daily.e2ee import export_local_state_for_vault, merge_remote_state_into_db
        from daily.ml import invalidate_ml_caches

        invalidate_ml_caches()
        app = create_app(db_path=self.db, enable_nudge_loop=False)
        client = TestClient(app)

        sport = client.post(
            "/api/habits",
            json={"name": "Sport", "kind": "min", "target": 1, "block_minutes": 30},
        ).json()
        today_iso = date.today().isoformat()
        ev = client.post(
            "/api/events",
            json={"habit_id": sport["id"], "amount": 1.0, "occurred_at": f"{today_iso}T09:00:00", "window_minutes": 30},
        ).json()
        sn = client.post(
            "/api/snapshots",
            json={"ratings": {"stimmung": 4}, "occurred_at": f"{today_iso}T11:00:00"},
        ).json()

        # Baseline analysis + Liquid ODE habit tick at 09:00
        a1 = client.get("/api/analysis").json()
        st1 = next(c for c in a1["ai"]["state_curves"] if c["id"] == "stimmung")
        self.assertEqual([tk["time"] for tk in st1["h24"]["habit_ticks"]], ["09:00"])

        # 1. Retroactively shift timestamp ONLY (amount unchanged!) -> cache MUST invalidate & ODE tick MUST move to 14:30!
        client.patch(
            f"/api/events/{ev['id']}",
            json={"occurred_at": f"{today_iso}T14:30:00", "window_minutes": 45},
        )
        a2 = client.get("/api/analysis").json()
        st2 = next(c for c in a2["ai"]["state_curves"] if c["id"] == "stimmung")
        self.assertEqual([tk["time"] for tk in st2["h24"]["habit_ticks"]], ["14:30"])

        # Verify E2EE merge propagates updated window_minutes & occurred_at cleanly to a second device
        other_db = Path(self.tmp.name) / "e2ee_edit_target.db"
        init_db(other_db)
        # First sync old state, then edit on primary (after 1s tick) & sync updated state
        merge_remote_state_into_db(export_local_state_for_vault(self.db), db_path=other_db)
        with get_conn(other_db) as conn:
            conn.execute("UPDATE events SET updated_at = '2020-01-01T00:00:00' WHERE client_uuid = ?", (ev["client_uuid"],))
        client.patch(f"/api/events/{ev['id']}", json={"window_minutes": 20, "occurred_at": f"{today_iso}T15:00:00"})
        merge_remote_state_into_db(export_local_state_for_vault(self.db), db_path=other_db)
        ev_other = next(e for e in list_events(day=today_iso, db_path=other_db) if e["client_uuid"] == ev["client_uuid"])
        self.assertEqual(ev_other["window_minutes"], 20)
        self.assertEqual(ev_other["occurred_at"], f"{today_iso}T15:00:00")

        # 2. Delete event AND snapshot -> both disappear completely from Liquid ODE, TabPFN, and synced mirror!
        client.delete(f"/api/events/{ev['id']}")
        client.delete(f"/api/snapshots/{sn['id']}")
        a3 = client.get("/api/analysis").json()
        st3 = next(c for c in a3["ai"]["state_curves"] if c["id"] == "stimmung")
        self.assertEqual(st3["h24"]["habit_ticks"], [])
        self.assertEqual(st3["h24"]["actual"], [])
        self.assertEqual(st3["rated_count"], 0)

        merge_remote_state_into_db(export_local_state_for_vault(self.db), db_path=other_db)
        self.assertEqual(list_events(day=today_iso, db_path=other_db), [])


if __name__ == "__main__":
    unittest.main()

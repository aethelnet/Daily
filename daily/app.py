"""FastAPI application for Daily v0.1 — local-first, zero cloud, zero presets."""
from __future__ import annotations

import asyncio
import hmac
import os
import secrets
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .analytics import (
    compute_analysis_board,
    compute_day_summary,
    compute_note_tag_stats,
    compute_week_matrix,
    export_tabpfn_features_csv,
)
from .db import (
    DEFAULT_DB_PATH,
    create_habit,
    create_snapshot,
    create_state_dimension,
    delete_edge,
    delete_event,
    delete_habit,
    delete_snapshot,
    get_settings,
    init_db,
    list_edges,
    list_events,
    list_habits,
    list_log_range,
    list_snapshots,
    list_state_dimensions,
    log_event,
    log_retro_batch,
    merge_habit,
    reorder_habits,
    reorder_state_dimensions,
    update_edge,
    update_event,
    update_habit,
    update_settings,
    update_snapshot,
    update_state_dimension,
    upsert_edge,
)
from .e2ee import (
    build_e2ee_pairing_bundle,
    create_github_gist_vault,
    generate_e2ee_key,
    get_e2ee_config,
    save_e2ee_config,
    sync_e2ee_vault,
)
from .ml import DEFAULT_TABPFN_THRESHOLD, compute_ai_insights, compute_ai_routing_edges, predict_contextual_nudges
from .nudges import NudgeScheduler, send_desktop_notification
from .sync import apply_sync_batch, get_pairing_info, get_sync_token

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


class HabitCreate(BaseModel):
    name: str
    kind: str = "neutral"
    target: float | None = None
    target_period: str = "day"
    unit: str = "x"
    color: str = "#2563eb"
    nudge_enabled: bool = False
    nudge_lead_min: int = 20
    nudge_alternatives: str = ""
    reminder_time: str = ""
    reminder_days: str = "0,1,2,3,4,5,6"
    block_minutes: int | None = None
    tap_step: float = 1.0
    group_name: str = ""


class HabitUpdate(BaseModel):
    name: str | None = None
    kind: str | None = None
    target: float | None = None
    target_period: str | None = None
    clear_target: bool = False
    unit: str | None = None
    color: str | None = None
    nudge_enabled: bool | None = None
    nudge_lead_min: int | None = None
    nudge_alternatives: str | None = None
    reminder_time: str | None = None
    reminder_days: str | None = None
    block_minutes: int | None = None
    clear_block_minutes: bool = False
    tap_step: float | None = None
    group_name: str | None = None
    active_since: str | None = None
    sort_order: int | None = None
    archived: bool | None = None


class HabitToggleActive(BaseModel):
    override_minutes: float | None = None
    cancel: bool = False
    now_at: str | None = None


class StateDimensionCreate(BaseModel):
    name: str
    low_label: str = ""
    high_label: str = ""
    color: str = ""


class StateDimensionUpdate(BaseModel):
    name: str | None = None
    low_label: str | None = None
    high_label: str | None = None
    color: str | None = None
    archived: bool | None = None


class SnapshotCreate(BaseModel):
    ratings: dict[str, float | int] = Field(default_factory=dict)
    causes: list[str] = Field(default_factory=list)
    note: str = ""
    occurred_at: str | None = None
    client_uuid: str | None = None


class EdgeCreate(BaseModel):
    source_id: str
    target_id: str
    relation_type: str = "rollup"  # 'rollup' or 'hypothesis'
    weight: float = 1.0            # +1, -1, +0.5, ...
    context_window: str = "any"    # 'any', 'morning', 'afternoon', 'evening', 'night'
    note: str = ""


class EventCreate(BaseModel):
    habit_id: str
    amount: float = 1.0
    occurred_at: str | None = None
    window_minutes: int = 0
    source: str = "tap"
    note: str = ""
    client_uuid: str | None = None


class SyncRequest(BaseModel):
    device_id: str = "unknown"
    since: str | None = None
    mutations: dict[str, Any] = Field(default_factory=dict)


class E2EEConfigUpdate(BaseModel):
    enabled: bool | None = None
    provider: str | None = None
    gist_id: str | None = None
    endpoint_url: str | None = None
    auth_token: str | None = None
    key_b64u: str | None = None


class E2EECreateGistRequest(BaseModel):
    auth_token: str
    key_b64u: str | None = None


class EventUpdate(BaseModel):
    habit_id: str | None = None
    amount: float | None = None
    occurred_at: str | None = None
    window_minutes: int | None = None
    note: str | None = None


class SnapshotUpdate(BaseModel):
    ratings: dict[str, float | int] | None = None
    causes: list[str] | None = None
    note: str | None = None
    occurred_at: str | None = None


class RetroItem(BaseModel):
    habit_id: str
    amount: float
    note: str = ""

    @field_validator("amount")
    @classmethod
    def amount_nonzero(cls, v: float) -> float:
        if v == 0:
            raise ValueError("amount must be non-zero")
        return v


class RetroBatchCreate(BaseModel):
    items: list[RetroItem]
    window_minutes: int = 180
    end_at: str | None = None
    note: str = ""


class SettingsUpdate(BaseModel):
    checkin_interval_hours: int | None = None
    notifications_enabled: int | None = None
    quiet_hours_start: int | None = None
    quiet_hours_end: int | None = None
    nudge_mode: str | None = None
    routing_mode: str | None = None
    tabpfn_threshold: float | None = None
    followup_enabled: int | None = None
    mood_groups: str | None = None
    mood_groups_updated_at: str | None = None
    active_mood_group: str | None = None


class HabitReorder(BaseModel):
    habit_ids: list[str]
    group_updates: dict[str, str] | None = None


class StateDimensionReorder(BaseModel):
    dim_ids: list[str]


class HabitMerge(BaseModel):
    target_id: str
    tag_notes: bool = True


def create_app(db_path: Path | None = None, enable_nudge_loop: bool = True) -> FastAPI:
    resolved_db = db_path or DEFAULT_DB_PATH
    port = int(os.environ.get("DAILY_PORT", "8090"))
    init_db(resolved_db)
    scheduler = NudgeScheduler(resolved_db, port=port)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        task = None
        if enable_nudge_loop:
            task = asyncio.create_task(scheduler.run_forever())
        try:
            yield
        finally:
            if task:
                task.cancel()

    app = FastAPI(title="Daily v0.1", version="0.1.0", lifespan=lifespan)

    # Hardened CORS: allow localhost, Capacitor WebViews, daily.aethelburg.network, and private LAN/VPN origins only
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(https?://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|100\.\d+\.\d+\.\d+)(:\d+)?|capacitor://localhost|ionic://localhost|https://daily\.aethelburg\.network)$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-Daily-Token"],
    )

    auth_fail_log: dict[str, list[float]] = defaultdict(list)

    @app.middleware("http")
    async def remote_sync_token_guard(request: Request, call_next):
        path = request.url.path
        if request.method == "OPTIONS" or not path.startswith("/api/") or path == "/api/health":
            return await call_next(request)
        client_host = request.client.host if request.client else "127.0.0.1"
        if client_host in {"127.0.0.1", "::1", "localhost", "testclient"}:
            return await call_next(request)

        now_ts = time.monotonic()
        recent_fails = [t for t in auth_fail_log[client_host] if now_ts - t < 300.0]
        auth_fail_log[client_host] = recent_fails
        if len(recent_fails) >= 10:
            return JSONResponse(status_code=429, content={"detail": "Zu viele Fehlversuche — bitte 5 Minuten warten."})

        expected = get_sync_token(resolved_db)
        provided = request.headers.get("X-Daily-Token") or request.query_params.get("token") or ""
        if expected and not hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
            auth_fail_log[client_host].append(now_ts)
            return JSONResponse(
                status_code=401,
                content={"detail": "Sync-Token erforderlich — bitte per Koppel-Link oder QR-Code verbinden."},
            )
        return await call_next(request)

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "db_path": str(resolved_db)}

    @app.get("/api/today")
    def api_today(
        day: str | None = Query(default=None),
        mode: str | None = Query(default=None),
    ) -> dict[str, Any]:
        settings = get_settings(db_path=resolved_db)
        active_mode = mode if mode in {"observed", "tabpfn"} else settings.get("routing_mode", "observed")
        if active_mode == "tabpfn":
            target_day = day or datetime.now().date().isoformat()
            habits = list_habits(include_archived=False, db_path=resolved_db)
            edges = list_edges(db_path=resolved_db)
            all_events = list_events(days_back=60, db_path=resolved_db)
            day_events = list_events(day=target_day, db_path=resolved_db)
            ai_edges = compute_ai_routing_edges(habits, edges, all_events, day_events)
            return compute_day_summary(
                day=target_day,
                db_path=resolved_db,
                override_edges=ai_edges,
                routing_mode="tabpfn",
            )
        return compute_day_summary(day=day, db_path=resolved_db, routing_mode="observed")

    @app.get("/api/log")
    def api_log_range(
        start: str | None = Query(default=None),
        end: str | None = Query(default=None),
    ) -> dict[str, Any]:
        from datetime import date, timedelta

        try:
            end_d = date.fromisoformat(end[:10]) if end else date.today()
            start_d = date.fromisoformat(start[:10]) if start else (end_d - timedelta(days=6))
            return list_log_range(start_d.isoformat(), end_d.isoformat(), db_path=resolved_db)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.get("/api/habits")
    def api_list_habits(include_archived: bool = False) -> dict[str, Any]:
        return {
            "habits": list_habits(include_archived=include_archived, db_path=resolved_db),
            "edges": list_edges(db_path=resolved_db),
            "settings": get_settings(db_path=resolved_db),
            "tags": compute_note_tag_stats(
                list_events(db_path=resolved_db),
                list_snapshots(db_path=resolved_db),
            ),
        }

    @app.post("/api/habits")
    def api_create_habit(payload: HabitCreate) -> dict[str, Any]:
        try:
            return create_habit(
                name=payload.name,
                kind=payload.kind,
                target=payload.target,
                target_period=payload.target_period,
                unit=payload.unit,
                color=payload.color,
                nudge_enabled=payload.nudge_enabled,
                nudge_lead_min=payload.nudge_lead_min,
                nudge_alternatives=payload.nudge_alternatives,
                reminder_time=payload.reminder_time,
                reminder_days=payload.reminder_days,
                block_minutes=payload.block_minutes,
                tap_step=payload.tap_step,
                group_name=payload.group_name,
                db_path=resolved_db,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.patch("/api/habits/{habit_id}")
    def api_update_habit(habit_id: str, payload: HabitUpdate) -> dict[str, Any]:
        raw = payload.model_dump(exclude_none=True)
        clear_target = raw.pop("clear_target", False)
        if clear_target:
            raw["target"] = None
        clear_block = raw.pop("clear_block_minutes", False)
        if clear_block:
            raw["block_minutes"] = None
        try:
            return update_habit(habit_id, raw, db_path=resolved_db)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/habits/{habit_id}/toggle-active")
    def api_toggle_habit_active(habit_id: str, payload: HabitToggleActive | None = None) -> dict[str, Any]:
        from datetime import datetime, timedelta
        from .db import now_iso

        p = payload or HabitToggleActive()
        habits = {h["id"]: h for h in list_habits(include_archived=True, db_path=resolved_db)}
        h = habits.get(habit_id)
        if not h:
            raise HTTPException(status_code=404, detail="Habit not found")

        now_str = (p.now_at or now_iso())[:19]
        cur_since = (h.get("active_since") or "").strip()
        if not cur_since:
            updated = update_habit(habit_id, {"active_since": now_str}, db_path=resolved_db)
            return {"active": True, "active_since": now_str, "habit": updated}

        # Stopping active session
        updated = update_habit(habit_id, {"active_since": None}, db_path=resolved_db)
        if p.cancel:
            return {"active": False, "logged": False, "habit": updated}

        block_m = max(1, int(h.get("block_minutes") or 30))
        if p.override_minutes is not None:
            elapsed_min = float(p.override_minutes)
            if elapsed_min < 1.0:
                return {"active": False, "logged": False, "too_short": True, "elapsed_minutes": 0, "habit": updated}
            amount = max(0.1, round((elapsed_min / block_m) * 10.0) / 10.0)
            win_min = max(1, int(round(elapsed_min)))
            ev = log_event(
                habit_id=habit_id,
                amount=amount,
                occurred_at=now_str,
                window_minutes=win_min,
                source="tap",
                note="",
                db_path=resolved_db,
            )
            return {
                "active": False,
                "logged": True,
                "elapsed_minutes": win_min,
                "trimmed_minutes": 0,
                "amount": amount,
                "event": ev,
                "habit": updated,
            }

        try:
            dt_start = datetime.fromisoformat(cur_since)
            dt_end = datetime.fromisoformat(now_str)
            raw_min = (dt_end - dt_start).total_seconds() / 60.0
            if raw_min < 1.0:
                return {"active": False, "logged": False, "too_short": True, "elapsed_minutes": 0, "habit": updated}
        except Exception:
            elapsed_min = float(h.get("block_minutes") or 30)
            amount = max(0.1, round((elapsed_min / block_m) * 10.0) / 10.0)
            win_min = max(1, int(round(elapsed_min)))
            ev = log_event(
                habit_id=habit_id,
                amount=amount,
                occurred_at=now_str,
                window_minutes=win_min,
                source="tap",
                note="",
                db_path=resolved_db,
            )
            return {
                "active": False,
                "logged": True,
                "elapsed_minutes": win_min,
                "trimmed_minutes": 0,
                "amount": amount,
                "event": ev,
                "habit": updated,
            }

        # Subtract any overlapping timed intervals of the SAME habit (e.g. a future Von-Bis estimate)
        day_lo = (dt_start.date() - timedelta(days=1)).isoformat()
        day_hi = (dt_end.date() + timedelta(days=1)).isoformat()
        existing = list_log_range(start_day=day_lo, end_day=day_hi, db_path=resolved_db)["events"]
        segs: list[tuple[datetime, datetime]] = [(dt_start, dt_end)]
        for ex in existing:
            if ex.get("habit_id") != habit_id or ex.get("deleted_at") or ex.get("source") == "retro":
                continue
            ew = int(ex.get("window_minutes") or 0)
            if ew <= 0:
                continue
            try:
                ex_end = datetime.fromisoformat(str(ex["occurred_at"])[:19])
                ex_start = ex_end - timedelta(minutes=ew)
            except Exception:
                continue
            if ex_end <= dt_start or ex_start >= dt_end:
                continue
            nxt: list[tuple[datetime, datetime]] = []
            for s, e in segs:
                if ex_end <= s or ex_start >= e:
                    nxt.append((s, e))
                else:
                    if ex_start > s:
                        nxt.append((s, ex_start))
                    if ex_end < e:
                        nxt.append((ex_end, e))
            segs = nxt
            if not segs:
                break

        uncovered = [(s, e) for s, e in segs if (e - s).total_seconds() >= 60.0]
        if not uncovered:
            return {
                "active": False,
                "logged": False,
                "already_covered": True,
                "elapsed_minutes": 0,
                "trimmed_minutes": max(1, int(round(raw_min))),
                "habit": updated,
            }

        uncovered_min = sum((e - s).total_seconds() / 60.0 for s, e in uncovered)
        trimmed_min = max(0, int(round(raw_min - uncovered_min)))
        created_events: list[dict[str, Any]] = []
        total_amt = 0.0
        total_win = 0
        for s, e in uncovered:
            seg_min = (e - s).total_seconds() / 60.0
            seg_amt = max(0.1, round((seg_min / block_m) * 10.0) / 10.0)
            seg_win = max(1, int(round(seg_min)))
            ev = log_event(
                habit_id=habit_id,
                amount=seg_amt,
                occurred_at=e.isoformat(timespec="seconds"),
                window_minutes=seg_win,
                source="tap",
                note="",
                db_path=resolved_db,
            )
            created_events.append(ev)
            total_amt = round(total_amt + seg_amt, 2)
            total_win += seg_win

        return {
            "active": False,
            "logged": True,
            "elapsed_minutes": total_win,
            "trimmed_minutes": trimmed_min,
            "amount": total_amt,
            "event": created_events[-1],
            "events": created_events,
            "habit": updated,
        }

    @app.post("/api/habits/reorder")
    def api_reorder_habits(payload: HabitReorder) -> dict[str, Any]:
        return {
            "habits": reorder_habits(
                payload.habit_ids,
                group_updates=payload.group_updates,
                db_path=resolved_db,
            )
        }

    @app.post("/api/habits/{habit_id}/merge")
    def api_merge_habit(habit_id: str, payload: HabitMerge) -> dict[str, Any]:
        try:
            return merge_habit(habit_id, payload.target_id, tag_notes=payload.tag_notes, db_path=resolved_db)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.delete("/api/habits/{habit_id}")
    def api_delete_habit(habit_id: str) -> dict[str, Any]:
        ok = delete_habit(habit_id, db_path=resolved_db)
        if not ok:
            raise HTTPException(status_code=404, detail="Habit not found")
        return {"deleted": True, "id": habit_id}

    @app.get("/api/edges")
    def api_list_edges() -> list[dict[str, Any]]:
        return list_edges(db_path=resolved_db)

    @app.post("/api/edges")
    def api_upsert_edge(payload: EdgeCreate) -> dict[str, Any]:
        try:
            return upsert_edge(
                source_id=payload.source_id,
                target_id=payload.target_id,
                relation_type=payload.relation_type,
                weight=payload.weight,
                context_window=payload.context_window,
                note=payload.note,
                db_path=resolved_db,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.patch("/api/edges/{edge_id}")
    def api_update_edge(edge_id: int, payload: EdgeCreate) -> dict[str, Any]:
        try:
            return update_edge(
                edge_id=edge_id,
                source_id=payload.source_id,
                target_id=payload.target_id,
                relation_type=payload.relation_type,
                weight=payload.weight,
                context_window=payload.context_window,
                note=payload.note,
                db_path=resolved_db,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.delete("/api/edges/{edge_id}")
    def api_delete_edge(edge_id: int) -> dict[str, Any]:
        if not delete_edge(edge_id, db_path=resolved_db):
            raise HTTPException(status_code=404, detail="Edge not found")
        return {"deleted": True, "id": edge_id}

    @app.post("/api/events")
    def api_log_event(payload: EventCreate) -> dict[str, Any]:
        try:
            return log_event(
                habit_id=payload.habit_id,
                amount=payload.amount,
                occurred_at=payload.occurred_at,
                window_minutes=payload.window_minutes,
                source=payload.source,
                note=payload.note,
                client_uuid=payload.client_uuid,
                db_path=resolved_db,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/sync")
    def api_sync(payload: SyncRequest) -> dict[str, Any]:
        return apply_sync_batch(payload.mutations, since=payload.since, db_path=resolved_db)

    @app.get("/api/sync/info")
    def api_sync_info() -> dict[str, Any]:
        return get_pairing_info(port=port, db_path=resolved_db)

    @app.post("/api/sync/token/rotate")
    def api_rotate_sync_token() -> dict[str, Any]:
        new_tok = secrets.token_urlsafe(18)
        update_settings({"sync_token": new_tok}, db_path=resolved_db)
        return get_pairing_info(port=port, db_path=resolved_db)

    @app.get("/api/e2ee/config")
    def api_get_e2ee_config() -> dict[str, Any]:
        cfg = get_e2ee_config(resolved_db)
        return {**cfg, "pairing": build_e2ee_pairing_bundle(cfg)}

    @app.patch("/api/e2ee/config")
    def api_patch_e2ee_config(payload: E2EEConfigUpdate) -> dict[str, Any]:
        try:
            raw = payload.model_dump(exclude_none=True)
            if raw.get("enabled") and not raw.get("key_b64u") and not get_e2ee_config(resolved_db).get("key_b64u"):
                raw["key_b64u"] = generate_e2ee_key()
            cfg = save_e2ee_config(raw, db_path=resolved_db)
            return {**cfg, "pairing": build_e2ee_pairing_bundle(cfg)}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/e2ee/gist/create")
    def api_create_e2ee_gist(payload: E2EECreateGistRequest) -> dict[str, Any]:
        try:
            return create_github_gist_vault(payload.auth_token, payload.key_b64u, db_path=resolved_db)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/e2ee/sync")
    def api_run_e2ee_sync() -> dict[str, Any]:
        try:
            return sync_e2ee_vault(db_path=resolved_db)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/e2ee/rotate")
    def api_rotate_e2ee_key() -> dict[str, Any]:
        try:
            # Best-effort pull with old key first so nothing is lost, then rotate & re-encrypt vault!
            try:
                sync_e2ee_vault(db_path=resolved_db)
            except Exception:
                pass
            cfg = save_e2ee_config({"key_b64u": generate_e2ee_key(), "enabled": True}, db_path=resolved_db)
            sync_e2ee_vault(db_path=resolved_db, skip_pull=True)
            cfg = get_e2ee_config(resolved_db)
            return {**cfg, "pairing": build_e2ee_pairing_bundle(cfg)}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.get("/api/state/dimensions")
    def api_list_state_dims(include_archived: bool = False) -> dict[str, Any]:
        return {"dimensions": list_state_dimensions(include_archived=include_archived, db_path=resolved_db)}

    @app.post("/api/state/dimensions")
    def api_create_state_dim(payload: StateDimensionCreate) -> dict[str, Any]:
        try:
            return create_state_dimension(
                name=payload.name,
                low_label=payload.low_label,
                high_label=payload.high_label,
                color=payload.color,
                db_path=resolved_db,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/state/dimensions/reorder")
    def api_reorder_state_dims(payload: StateDimensionReorder) -> dict[str, Any]:
        return {"dimensions": reorder_state_dimensions(payload.dim_ids, db_path=resolved_db)}

    @app.patch("/api/state/dimensions/{dim_id}")
    def api_update_state_dim(dim_id: str, payload: StateDimensionUpdate) -> dict[str, Any]:
        try:
            return update_state_dimension(dim_id, payload.model_dump(exclude_none=True), db_path=resolved_db)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/snapshots")
    def api_create_snapshot(payload: SnapshotCreate) -> dict[str, Any]:
        try:
            return create_snapshot(
                ratings=payload.ratings,
                causes=payload.causes,
                note=payload.note,
                occurred_at=payload.occurred_at,
                client_uuid=payload.client_uuid,
                db_path=resolved_db,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.patch("/api/snapshots/{snapshot_id}")
    def api_update_snapshot(snapshot_id: int, payload: SnapshotUpdate) -> dict[str, Any]:
        try:
            return update_snapshot(snapshot_id, payload.model_dump(exclude_none=True), db_path=resolved_db)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.delete("/api/snapshots/{snapshot_id}")
    def api_delete_snapshot(snapshot_id: int) -> dict[str, Any]:
        if not delete_snapshot(snapshot_id, db_path=resolved_db):
            raise HTTPException(status_code=404, detail="Snapshot not found")
        return {"deleted": True, "id": snapshot_id}

    @app.post("/api/events/retro")
    def api_log_retro(payload: RetroBatchCreate) -> dict[str, Any]:
        try:
            created = log_retro_batch(
                items=[it.model_dump() for it in payload.items],
                window_minutes=payload.window_minutes,
                end_at=payload.end_at,
                note=payload.note,
                db_path=resolved_db,
            )
            return {"count": len(created), "events": created}
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.patch("/api/events/{event_id}")
    def api_update_event(event_id: int, payload: EventUpdate) -> dict[str, Any]:
        try:
            return update_event(event_id, payload.model_dump(exclude_none=True), db_path=resolved_db)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.delete("/api/events/{event_id}")
    def api_delete_event(event_id: int) -> dict[str, Any]:
        if not delete_event(event_id, db_path=resolved_db):
            raise HTTPException(status_code=404, detail="Event not found")
        return {"deleted": True, "id": event_id}

    @app.get("/api/matrix")
    def api_matrix(end: str | None = Query(default=None), days: int = Query(default=7, ge=1, le=14)) -> dict[str, Any]:
        try:
            return compute_week_matrix(end_day=end, span_days=days, db_path=resolved_db)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.get("/api/analysis")
    def api_analysis(days: int = Query(default=30, ge=7, le=365)) -> dict[str, Any]:
        board = compute_analysis_board(days=days, db_path=resolved_db)
        settings = get_settings(db_path=resolved_db)
        all_habits = list_habits(include_archived=True, db_path=resolved_db)
        active_ids = {h["id"] for h in all_habits if not h.get("archived")}
        edges = list_edges(db_path=resolved_db)
        events_ai = list_events(days_back=max(days, 60), db_path=resolved_db)
        snaps_ai = list_snapshots(days_back=max(days, 60), db_path=resolved_db)
        dims = list_state_dimensions(db_path=resolved_db)
        nudge_mode = settings.get("nudge_mode", "observed")
        try:
            threshold = float(settings.get("tabpfn_threshold", str(DEFAULT_TABPFN_THRESHOLD)))
        except ValueError:
            threshold = DEFAULT_TABPFN_THRESHOLD

        # Include archived children & sparse Momentaufnahme snapshots (true NaNs!)
        insights = compute_ai_insights(all_habits, edges, events_ai, snapshots=snaps_ai, state_dims=dims)
        ai_nudges = predict_contextual_nudges(all_habits, events_ai, threshold=threshold, snapshots=snaps_ai, state_dims=dims)
        board["ai"] = {
            "engine": insights["engine"],
            "engine_label": insights["engine_label"],
            "status": insights["status"],
            "observed_days": insights["observed_days"],
            "nudge_mode": nudge_mode,
            "tomorrow": {k: v for k, v in insights["tomorrow"].items() if k in active_ids},
            "calibration": [c for c in insights["calibration"] if c["habit_id"] in active_ids],
            "overall_mae": insights["overall_mae"],
            "assumptions": [
                a
                for a in insights["assumptions"]
                if a["source_id"] in active_ids and (a["target_id"] in active_ids or a.get("is_state_target"))
            ],
            "state_curves": insights.get("state_curves", []),
            "timeline_meta": insights.get("timeline_meta"),
            "live_nudges": {k: v for k, v in ai_nudges["predictions"].items() if k in active_ids},
            "feature_audit": insights.get("feature_audit"),
        }
        return board

    @app.get("/api/export/features.csv", response_class=PlainTextResponse)
    def api_export_csv() -> PlainTextResponse:
        csv_text = export_tabpfn_features_csv(db_path=resolved_db)
        return PlainTextResponse(
            content=csv_text,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="daily_features.csv"'},
        )

    @app.get("/api/settings")
    def api_get_settings() -> dict[str, str]:
        return get_settings(db_path=resolved_db)

    @app.patch("/api/settings")
    def api_patch_settings(payload: SettingsUpdate) -> dict[str, str]:
        try:
            return update_settings(payload.model_dump(exclude_none=True), db_path=resolved_db)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.post("/api/nudge/test")
    def api_nudge_test() -> dict[str, Any]:
        settings = get_settings(db_path=resolved_db)
        mode = settings.get("nudge_mode", "observed")
        mode_lbl = "Tabellen-KI (TabPFN)" if mode == "tabpfn" else "Ist-Zustand (letzte Tage)"
        ok = send_desktop_notification(
            f"Daily · Test-Impuls ({mode_lbl})",
            "Desktop-Benachrichtigungen laufen! Drück R in Daily für den Retro-Check-in.",
        )
        return {"sent": ok, "nudge_mode": mode}

    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/manifest.webmanifest")
    def manifest() -> FileResponse:
        return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")

    @app.get("/sw.js")
    def service_worker() -> FileResponse:
        return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript")

    @app.get("/icon.svg")
    def icon() -> FileResponse:
        return FileResponse(STATIC_DIR / "icon.svg", media_type="image/svg+xml")

    @app.get("/apple-touch-icon.png")
    def apple_touch_icon() -> FileResponse:
        return FileResponse(STATIC_DIR / "apple-touch-icon.png", media_type="image/png")

    @app.get("/icon-192.png")
    def icon_192() -> FileResponse:
        return FileResponse(STATIC_DIR / "icon-192.png", media_type="image/png")

    @app.get("/icon-512.png")
    def icon_512() -> FileResponse:
        return FileResponse(STATIC_DIR / "icon-512.png", media_type="image/png")

    return app


app = create_app()

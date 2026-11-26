"""Offline-first bidirectional delta sync & local LAN/Tailscale QR pairing for Daily."""
from __future__ import annotations

import io
import os
import socket
import subprocess
from pathlib import Path
from typing import Any

from .db import (
    DEFAULT_DB_PATH,
    create_habit,
    create_snapshot,
    get_conn,
    get_settings,
    list_edges,
    list_events,
    list_habits,
    list_snapshots,
    list_state_dimensions,
    log_event,
    now_iso,
    update_habit,
    upsert_edge,
)


def get_sync_token(db_path: Path = DEFAULT_DB_PATH) -> str:
    env_tok = os.environ.get("DAILY_SYNC_TOKEN", "").strip()
    if env_tok:
        return env_tok
    settings = get_settings(db_path)
    return settings.get("sync_token", "")


def detect_lan_ip() -> str | None:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("192.0.2.1", 80))
        ip = sock.getsockname()[0]
        sock.close()
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass
    return None


def detect_tailscale_host() -> str | None:
    try:
        res = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=1.5, check=False)
        ip = (res.stdout or "").strip().splitlines()
        if ip and ip[0].startswith("100."):
            return ip[0]
    except Exception:
        pass
    return None


def make_qr_svg(url: str) -> str:
    """Generate a crisp, responsive, zero-CDN inline SVG QR code via pure-Python segno."""
    try:
        import segno

        qr = segno.make(url, error="l")
        buf = io.BytesIO()
        qr.save(
            buf,
            kind="svg",
            scale=4,
            border=2,
            xmldecl=False,
            omitsize=True,
            svgclass="qr-svg",
            dark="#111827",
            light="#ffffff",
        )
        return buf.getvalue().decode("utf-8")
    except Exception:
        return ""


def get_pairing_info(port: int = 8090, db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    token = get_sync_token(db_path)
    lan_ip = detect_lan_ip()
    ts_ip = detect_tailscale_host()
    lan_url = f"http://{lan_ip}:{port}/?token={token}" if lan_ip else None
    ts_url = f"http://{ts_ip}:{port}/?token={token}" if ts_ip else None
    primary_url = ts_url or lan_url or f"http://127.0.0.1:{port}/?token={token}"
    return {
        "sync_token": token,
        "bind_host": os.environ.get("DAILY_HOST", "127.0.0.1"),
        "port": port,
        "lan_ip": lan_ip,
        "lan_url": lan_url,
        "tailscale_ip": ts_ip,
        "tailscale_url": ts_url,
        "primary_url": primary_url,
        "qr_svg": make_qr_svg(primary_url),
    }


def apply_sync_batch(
    mutations: dict[str, Any],
    since: str | None = None,
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    """Idempotently merge client offline mutations (habits, edges, events, snapshots) and return server snapshot/delta."""
    applied = {"habits": 0, "edges": 0, "events": 0, "deleted_events": 0, "snapshots": 0}
    ts_now = now_iso()

    # 1. Habits (create or update by id/name)
    for h in mutations.get("habits") or []:
        hid = h.get("id")
        existing = {x["id"]: x for x in list_habits(include_archived=True, db_path=db_path)}
        if hid and hid in existing:
            fields = {
                k: h[k]
                for k in (
                    "name",
                    "kind",
                    "target",
                    "target_period",
                    "unit",
                    "color",
                    "nudge_enabled",
                    "nudge_lead_min",
                    "nudge_alternatives",
                    "reminder_time",
                    "reminder_days",
                    "block_minutes",
                    "active_since",
                    "sort_order",
                    "archived",
                )
                if k in h
            }
            if fields:
                update_habit(hid, fields, db_path=db_path)
                applied["habits"] += 1
        elif h.get("name"):
            try:
                create_habit(
                    name=h["name"],
                    kind=h.get("kind", "neutral"),
                    target=h.get("target"),
                    target_period=h.get("target_period", "day"),
                    unit=h.get("unit", "x"),
                    color=h.get("color", "#2563eb"),
                    nudge_enabled=bool(h.get("nudge_enabled", False)),
                    nudge_lead_min=int(h.get("nudge_lead_min", 20)),
                    nudge_alternatives=h.get("nudge_alternatives", ""),
                    reminder_time=h.get("reminder_time", ""),
                    reminder_days=h.get("reminder_days", "0,1,2,3,4,5,6"),
                    block_minutes=h.get("block_minutes"),
                    db_path=db_path,
                )
                applied["habits"] += 1
            except Exception:
                pass

    # 2. Edges (upsert)
    for e in mutations.get("edges") or []:
        if e.get("source_id") and e.get("target_id"):
            try:
                upsert_edge(
                    source_id=e["source_id"],
                    target_id=e["target_id"],
                    relation_type=e.get("relation_type", "rollup"),
                    weight=float(e.get("weight", 1.0)),
                    context_window=e.get("context_window", "any"),
                    note=e.get("note", ""),
                    db_path=db_path,
                )
                applied["edges"] += 1
            except Exception:
                pass

    # 3. Events (idempotent by client_uuid; supports offline create, edit, and soft-delete tombstones)
    for ev in mutations.get("events") or []:
        c_uuid = (ev.get("client_uuid") or "").strip()
        if ev.get("deleted") and c_uuid:
            with get_conn(db_path) as conn:
                cur = conn.execute(
                    "UPDATE events SET deleted_at = ?, updated_at = ? WHERE client_uuid = ? AND deleted_at IS NULL",
                    (ts_now, ts_now, c_uuid),
                )
                if cur.rowcount:
                    applied["deleted_events"] += 1
            continue

        if ev.get("habit_id"):
            try:
                log_event(
                    habit_id=ev["habit_id"],
                    amount=float(ev.get("amount", 1.0)),
                    occurred_at=ev.get("occurred_at"),
                    window_minutes=int(ev.get("window_minutes", 0)),
                    source=ev.get("source", "tap"),
                    note=ev.get("note", ""),
                    client_uuid=c_uuid or None,
                    db_path=db_path,
                )
                applied["events"] += 1
            except Exception:
                pass

    # 4. Snapshots (Momentaufnahmen — idempotent by client_uuid)
    for sn in mutations.get("snapshots") or []:
        c_uuid = (sn.get("client_uuid") or "").strip()
        if sn.get("deleted") and c_uuid:
            with get_conn(db_path) as conn:
                conn.execute(
                    "UPDATE snapshots SET deleted_at = ?, updated_at = ? WHERE client_uuid = ? AND deleted_at IS NULL",
                    (ts_now, ts_now, c_uuid),
                )
            continue
        try:
            create_snapshot(
                ratings=sn.get("ratings") or {},
                causes=sn.get("causes") or [],
                note=sn.get("note", ""),
                occurred_at=sn.get("occurred_at"),
                client_uuid=c_uuid or None,
                db_path=db_path,
            )
            applied["snapshots"] += 1
        except Exception:
            pass

    # Return clean delta/snapshot
    all_habits = list_habits(include_archived=True, db_path=db_path)
    all_edges = list_edges(db_path=db_path)
    if since:
        with get_conn(db_path) as conn:
            rows = conn.execute(
                """
                SELECT ev.*, h.name AS habit_name, h.unit AS habit_unit, h.kind AS habit_kind, h.color AS habit_color
                FROM events ev JOIN habits h ON h.id = ev.habit_id
                WHERE ev.updated_at >= ?
                ORDER BY ev.occurred_at ASC, ev.id ASC
                """,
                (since,),
            ).fetchall()
        ev_out = [dict(r) for r in rows]
    else:
        ev_out = list_events(days_back=60, include_deleted=False, db_path=db_path)

    return {
        "server_time": ts_now,
        "applied": applied,
        "habits": all_habits,
        "edges": all_edges,
        "events": ev_out,
        "state_dimensions": list_state_dimensions(include_archived=True, db_path=db_path),
        "snapshots": list_snapshots(days_back=60, db_path=db_path),
    }

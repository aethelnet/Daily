"""End-to-End Encrypted (AES-256-GCM) Decentralized Vault Sync for Daily.

Security guarantees:
- All habit data, notes, and Momentaufnahmen are encrypted client-side with AES-256-GCM
  (256-bit key, fresh random 96-bit IV per push, AAD='daily-e2ee-v1') BEFORE leaving any device.
- Byte-for-byte compatible with Browser WebCrypto AES-GCM (static/e2ee-sync.js).
- Supports blind mailboxes that never see plaintext:
    1. Private GitHub Gist (zero server cost, HTTPS + CORS native, fine-grained Gist-only token)
    2. Custom Blind HTTP / WebDAV URL (Nextcloud, own Cloudflare Worker, etc.)
- Conflict-free merge via client_uuid + updated_at + deleted_at tombstones so Phone, Tablet & PC
  can all log offline on mobile data without ever losing or duplicating entries.
"""
from __future__ import annotations

import base64
import json
import os
import random
import secrets
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    AESGCM = None  # type: ignore[assignment]

from .db import (
    DEFAULT_DB_PATH,
    get_conn,
    get_settings,
    list_edges,
    list_events,
    list_habits,
    list_snapshots,
    list_state_dimensions,
    now_iso,
    update_settings,
)
from .sync import make_qr_svg

AAD_STR = "daily-e2ee-v1"
AAD_BYTES = AAD_STR.encode("utf-8")
VAULT_FILENAME = "daily-e2ee-vault.json"


def _b64u_enc(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64u_dec(text: str) -> bytes:
    pad = "=" * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode((text + pad).encode("ascii"))


def generate_e2ee_key() -> str:
    """Generate a fresh cryptographically random 256-bit AES key (base64url)."""
    return _b64u_enc(secrets.token_bytes(32))


def encrypt_vault_payload(payload: dict[str, Any], key_b64u: str) -> dict[str, Any]:
    """Encrypt canonical JSON payload using AES-256-GCM with fresh 96-bit IV."""
    key = _b64u_dec(key_b64u.strip())
    if len(key) != 32:
        raise ValueError("E2EE-Schlüssel muss exakt 256 Bit (32 Bytes) lang sein")
    iv = os.urandom(12)
    plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if AESGCM is None:
        raise RuntimeError("Das Paket 'cryptography' wird für E2EE-Sync benötigt (pip install cryptography)")
    ct = AESGCM(key).encrypt(iv, plaintext, AAD_BYTES)
    return {
        "v": 1,
        "alg": "AES-256-GCM",
        "aad": AAD_STR,
        "iv": _b64u_enc(iv),
        "ct": _b64u_enc(ct),
        "ts": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }


def decrypt_vault_payload(envelope: dict[str, Any], key_b64u: str) -> dict[str, Any]:
    """Verify GCM auth tag and decrypt AES-256-GCM vault envelope."""
    if not isinstance(envelope, dict) or envelope.get("alg") != "AES-256-GCM":
        raise ValueError("Ungültiges E2EE-Tresor-Format")
    key = _b64u_dec(key_b64u.strip())
    if len(key) != 32:
        raise ValueError("Ungültige E2EE-Schlüssellänge")
    iv = _b64u_dec(str(envelope["iv"]))
    ct = _b64u_dec(str(envelope["ct"]))
    aad = str(envelope.get("aad") or AAD_STR).encode("utf-8")
    if AESGCM is None:
        raise RuntimeError("Das Paket 'cryptography' wird für E2EE-Sync benötigt (pip install cryptography)")
    plaintext = AESGCM(key).decrypt(iv, ct, aad)
    return json.loads(plaintext.decode("utf-8"))


def get_e2ee_config(db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    s = get_settings(db_path)
    return {
        "enabled": s.get("e2ee_enabled", "0") == "1",
        "provider": s.get("e2ee_provider", "gist"),  # 'gist' or 'url'
        "gist_id": s.get("e2ee_gist_id", ""),
        "endpoint_url": s.get("e2ee_endpoint_url", ""),
        "auth_token": s.get("e2ee_auth_token", ""),
        "key_b64u": s.get("e2ee_key", ""),
        "last_sync_at": s.get("e2ee_last_sync_at", ""),
    }


def save_e2ee_config(cfg: dict[str, Any], db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    if "enabled" in cfg:
        updates["e2ee_enabled"] = "1" if cfg["enabled"] else "0"
    if "provider" in cfg:
        prov = str(cfg["provider"]).strip()
        if prov not in {"gist", "url"}:
            raise ValueError("Provider muss 'gist' oder 'url' sein")
        updates["e2ee_provider"] = prov
    if "gist_id" in cfg:
        updates["e2ee_gist_id"] = str(cfg["gist_id"] or "").strip()
    if "endpoint_url" in cfg:
        updates["e2ee_endpoint_url"] = str(cfg["endpoint_url"] or "").strip()
    if "auth_token" in cfg:
        updates["e2ee_auth_token"] = str(cfg["auth_token"] or "").strip()
    if "key_b64u" in cfg:
        k = str(cfg["key_b64u"] or "").strip()
        if k:
            if len(_b64u_dec(k)) != 32:
                raise ValueError("E2EE-Schlüssel ungültig (erwartet 256-Bit base64url)")
        updates["e2ee_key"] = k
    update_settings(updates, db_path=db_path)
    return get_e2ee_config(db_path)


def build_e2ee_pairing_bundle(
    cfg: dict[str, Any],
    base_url: str = "https://daily.aethelburg.network/",
) -> dict[str, Any]:
    """Create a URL-fragment pairing link (#e2ee=...) & QR SVG.
    Because it uses a hash fragment, the key is NEVER transmitted in HTTP requests or server logs."""
    if not cfg.get("key_b64u"):
        return {"ready": False, "pair_url": "", "qr_svg": ""}
    compact = {
        "k": cfg["key_b64u"],
        "v": 1,
        "p": cfg.get("provider", "gist"),
        "t": cfg.get("auth_token", ""),
    }
    if compact["p"] == "gist":
        compact["g"] = cfg.get("gist_id", "")
    else:
        compact["u"] = cfg.get("endpoint_url", "")
    encoded = _b64u_enc(json.dumps(compact, separators=(",", ":")).encode("utf-8"))
    url = f"{base_url.rstrip('/')}/#e2ee={encoded}"
    return {
        "ready": True,
        "pair_url": url,
        "qr_svg": make_qr_svg(url),
    }


def export_local_state_for_vault(db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    """Snapshot complete local DB state (including soft-deleted tombstones) for conflict-free merge."""
    with get_conn(db_path) as conn:
        habits = [dict(r) for r in conn.execute("SELECT * FROM habits ORDER BY sort_order ASC, created_at ASC").fetchall()]
        edges = [dict(r) for r in conn.execute("SELECT * FROM habit_edges ORDER BY id ASC").fetchall()]
        events = [dict(r) for r in conn.execute("SELECT * FROM events ORDER BY id ASC").fetchall()]
        dims = [dict(r) for r in conn.execute("SELECT * FROM state_dimensions ORDER BY sort_order ASC").fetchall()]
        snaps_raw = conn.execute("SELECT * FROM snapshots ORDER BY id ASC").fetchall()
        tasks = [dict(r) for r in conn.execute("SELECT * FROM tasks ORDER BY created_at ASC").fetchall()]
    snaps = []
    for r in snaps_raw:
        d = dict(r)
        try:
            d["ratings"] = json.loads(d.pop("ratings_json", "{}") or "{}")
        except Exception:
            d["ratings"] = {}
        try:
            raw_sc = json.loads(d.pop("scales_json", "{}") or "{}")
            d["scales"] = raw_sc if isinstance(raw_sc, dict) else {}
        except Exception:
            d["scales"] = {}
        try:
            d["causes"] = json.loads(d.pop("causes_json", "[]") or "[]")
        except Exception:
            d["causes"] = []
        snaps.append(d)

    settings = get_settings(db_path)
    sync_settings = {
        k: settings[k]
        for k in (
            "checkin_interval_hours",
            "notifications_enabled",
            "quiet_hours_start",
            "quiet_hours_end",
            "nudge_mode",
            "routing_mode",
            "followup_enabled",
            "task_nudges_enabled",
            "mood_groups",
            "mood_groups_updated_at",
            "active_mood_group",
        )
        if k in settings
    }
    return {
        "schema": 1,
        "updated_at": now_iso(),
        "habits": habits,
        "edges": edges,
        "events": events,
        "state_dimensions": dims,
        "snapshots": snaps,
        "tasks": tasks,
        "settings": sync_settings,
    }


def merge_remote_state_into_db(remote: dict[str, Any], db_path: Path = DEFAULT_DB_PATH) -> dict[str, int]:
    """Conflict-free CRDT/LWW merge of a decrypted remote vault into local SQLite WAL."""
    stats = {"habits": 0, "edges": 0, "events": 0, "snapshots": 0, "dimensions": 0, "tasks": 0}
    ts_now = now_iso()

    with get_conn(db_path) as conn:
        # 1. Habits (LWW on updated_at by id)
        local_habits = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM habits").fetchall()}
        for rh in remote.get("habits") or []:
            hid = rh.get("id")
            if not hid or not rh.get("name"):
                continue
            r_upd = rh.get("updated_at") or rh.get("created_at") or ""
            lh = local_habits.get(hid)
            if lh is None:
                # Avoid unique name conflict if renamed elsewhere
                if conn.execute("SELECT 1 FROM habits WHERE lower(name) = lower(?)", (rh["name"],)).fetchone():
                    continue
                conn.execute(
                    """
                    INSERT INTO habits(id, name, kind, target, target_period, unit, color, nudge_enabled, nudge_lead_min, nudge_alternatives, reminder_time, reminder_days, block_minutes, tap_step, group_name, active_since, sort_order, archived, created_at, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        hid,
                        rh["name"],
                        rh.get("kind", "neutral"),
                        rh.get("target"),
                        rh.get("target_period", "day"),
                        rh.get("unit", "x"),
                        rh.get("color", "#2563eb"),
                        1 if rh.get("nudge_enabled") else 0,
                        int(rh.get("nudge_lead_min") or 20),
                        rh.get("nudge_alternatives", ""),
                        rh.get("reminder_time", ""),
                        rh.get("reminder_days", "0,1,2,3,4,5,6"),
                        int(rh["block_minutes"]) if rh.get("block_minutes") else None,
                        round(max(0.01, min(1000.0, float(rh.get("tap_step") or 1.0))), 3),
                        str(rh.get("group_name") or "").strip()[:48],
                        rh.get("active_since") or None,
                        int(rh.get("sort_order") or 0),
                        1 if rh.get("archived") else 0,
                        rh.get("created_at") or ts_now,
                        r_upd or ts_now,
                    ),
                )
                local_habits[hid] = rh
                stats["habits"] += 1
            else:
                l_upd = lh.get("updated_at") or lh.get("created_at") or ""
                if r_upd > l_upd:
                    conn.execute(
                        """
                        UPDATE habits SET name=?, kind=?, target=?, target_period=?, unit=?, color=?, nudge_enabled=?,
                            nudge_lead_min=?, nudge_alternatives=?, reminder_time=?, reminder_days=?,
                            block_minutes=?, tap_step=?, group_name=?, active_since=?, sort_order=?, archived=?, updated_at=?
                        WHERE id = ?
                        """,
                        (
                            rh["name"],
                            rh.get("kind", lh["kind"]),
                            rh.get("target"),
                            rh.get("target_period", lh.get("target_period", "day")),
                            rh.get("unit", lh["unit"]),
                            rh.get("color", lh["color"]),
                            1 if rh.get("nudge_enabled") else 0,
                            int(rh.get("nudge_lead_min") or 20),
                            rh.get("nudge_alternatives", ""),
                            rh.get("reminder_time", ""),
                            rh.get("reminder_days", "0,1,2,3,4,5,6"),
                            int(rh["block_minutes"]) if rh.get("block_minutes") else None,
                            round(max(0.01, min(1000.0, float(rh.get("tap_step") or lh.get("tap_step") or 1.0))), 3),
                            str(rh.get("group_name", lh.get("group_name", "")) or "").strip()[:48],
                            rh.get("active_since") or None,
                            int(rh.get("sort_order") or 0),
                            1 if rh.get("archived") else 0,
                            r_upd,
                            hid,
                        ),
                    )
                    stats["habits"] += 1

        # 2. State dimensions (LWW on updated_at so custom colors & archive state sync across devices!)
        local_dims = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM state_dimensions").fetchall()}
        for rd in remote.get("state_dimensions") or []:
            did = rd.get("id")
            if not did or not rd.get("name"):
                continue
            r_upd = rd.get("updated_at") or rd.get("created_at") or ts_now
            if did not in local_dims:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO state_dimensions(id, name, low_label, high_label, color, scale_max, sort_order, archived, created_at, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        did,
                        rd["name"],
                        rd.get("low_label", ""),
                        rd.get("high_label", ""),
                        rd.get("color", ""),
                        max(2, min(10, int(rd.get("scale_max") or 5))),
                        int(rd.get("sort_order") or 0),
                        1 if rd.get("archived") else 0,
                        rd.get("created_at") or ts_now,
                        r_upd,
                    ),
                )
            else:
                ld = local_dims[did]
                l_upd = ld.get("updated_at") or ld.get("created_at") or ""
                r_has_scale = rd.get("scale_max") is not None
                r_scale = max(2, min(10, int(rd.get("scale_max") or 5))) if r_has_scale else None
                l_scale = max(2, min(10, int(ld.get("scale_max") or 5)))
                if r_upd > l_upd or (r_upd == l_upd and r_scale is not None and r_scale != 5 and l_scale == 5):
                    next_scale = r_scale if r_scale is not None else l_scale
                    conn.execute(
                        """
                        UPDATE state_dimensions
                        SET name=?, low_label=?, high_label=?, color=COALESCE(NULLIF(?, ''), color), scale_max=?, sort_order=?, archived=?, updated_at=?
                        WHERE id=?
                        """,
                        (
                            rd["name"],
                            rd.get("low_label", ld.get("low_label", "")),
                            rd.get("high_label", ld.get("high_label", "")),
                            rd.get("color", ""),
                            next_scale,
                            int(rd.get("sort_order", ld.get("sort_order", 0))),
                            1 if rd.get("archived") else 0,
                            r_upd,
                            did,
                        ),
                    )
                stats["dimensions"] += 1

        # 3. Edges (by semantic key, LWW on updated_at)
        for re_edge in remote.get("edges") or []:
            src, dst = re_edge.get("source_id"), re_edge.get("target_id")
            if not src or not dst or src == dst or src not in local_habits or dst not in local_habits:
                continue
            rt = re_edge.get("relation_type", "rollup")
            win = re_edge.get("context_window", "any")
            r_upd = re_edge.get("updated_at") or re_edge.get("created_at") or ts_now
            existing = conn.execute(
                "SELECT * FROM habit_edges WHERE source_id=? AND target_id=? AND relation_type=? AND context_window=?",
                (src, dst, rt, win),
            ).fetchone()
            if not existing:
                conn.execute(
                    """
                    INSERT INTO habit_edges(source_id, target_id, relation_type, weight, context_window, note, created_at, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (src, dst, rt, float(re_edge.get("weight", 1.0)), win, re_edge.get("note", ""), re_edge.get("created_at") or ts_now, r_upd),
                )
                stats["edges"] += 1
            else:
                l_upd = existing["updated_at"] or existing["created_at"] or ""
                if r_upd > l_upd:
                    conn.execute(
                        "UPDATE habit_edges SET weight=?, note=?, updated_at=? WHERE id=?",
                        (float(re_edge.get("weight", 1.0)), re_edge.get("note", ""), r_upd, existing["id"]),
                    )
                    stats["edges"] += 1

        # 4. Events (idempotent by client_uuid, LWW on updated_at + tombstones!)
        for rev in remote.get("events") or []:
            c_uuid = (rev.get("client_uuid") or "").strip()
            hid = rev.get("habit_id")
            if not c_uuid or not hid or hid not in local_habits:
                continue
            r_upd = rev.get("updated_at") or rev.get("created_at") or ts_now
            existing = conn.execute("SELECT * FROM events WHERE client_uuid = ?", (c_uuid,)).fetchone()
            if not existing:
                conn.execute(
                    """
                    INSERT INTO events(habit_id, amount, occurred_at, window_minutes, source, note, created_at, client_uuid, updated_at, deleted_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        hid,
                        float(rev.get("amount", 1.0)),
                        rev.get("occurred_at") or ts_now,
                        int(rev.get("window_minutes") or 0),
                        rev.get("source", "tap"),
                        rev.get("note", ""),
                        rev.get("created_at") or ts_now,
                        c_uuid,
                        r_upd,
                        rev.get("deleted_at"),
                    ),
                )
                stats["events"] += 1
            else:
                l_upd = existing["updated_at"] or existing["created_at"] or ""
                if r_upd > l_upd or (r_upd == l_upd and rev.get("deleted_at") and not existing["deleted_at"]):
                    conn.execute(
                        "UPDATE events SET habit_id=?, amount=?, occurred_at=?, window_minutes=?, note=?, updated_at=?, deleted_at=? WHERE id=?",
                        (
                            hid,
                            float(rev.get("amount", existing["amount"])),
                            rev.get("occurred_at") or existing["occurred_at"],
                            int(rev["window_minutes"]) if rev.get("window_minutes") is not None else int(existing["window_minutes"] or 0),
                            rev.get("note", existing["note"]),
                            r_upd,
                            rev.get("deleted_at"),
                            existing["id"],
                        ),
                    )
                    stats["events"] += 1

        # 5. Snapshots (Momentaufnahmen — idempotent by client_uuid + tombstones!)
        for rsn in remote.get("snapshots") or []:
            c_uuid = (rsn.get("client_uuid") or "").strip()
            if not c_uuid:
                continue
            r_upd = rsn.get("updated_at") or rsn.get("created_at") or ts_now
            r_json = json.dumps(rsn.get("ratings") or {}, ensure_ascii=False)
            s_json = json.dumps(rsn.get("scales") or {}, ensure_ascii=False)
            c_json = json.dumps(rsn.get("causes") or [], ensure_ascii=False)
            existing = conn.execute("SELECT * FROM snapshots WHERE client_uuid = ?", (c_uuid,)).fetchone()
            if not existing:
                conn.execute(
                    """
                    INSERT INTO snapshots(client_uuid, occurred_at, ratings_json, scales_json, causes_json, note, created_at, updated_at, deleted_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        c_uuid,
                        rsn.get("occurred_at") or ts_now,
                        r_json,
                        s_json,
                        c_json,
                        rsn.get("note", ""),
                        rsn.get("created_at") or ts_now,
                        r_upd,
                        rsn.get("deleted_at"),
                    ),
                )
                stats["snapshots"] += 1
            else:
                l_upd = existing["updated_at"] or existing["created_at"] or ""
                if r_upd > l_upd or (r_upd == l_upd and rsn.get("deleted_at") and not existing["deleted_at"]):
                    conn.execute(
                        "UPDATE snapshots SET occurred_at=?, ratings_json=?, scales_json=?, causes_json=?, note=?, updated_at=?, deleted_at=? WHERE id=?",
                        (
                            rsn.get("occurred_at") or existing["occurred_at"],
                            r_json,
                            s_json if (rsn.get("scales") or {}) else (existing["scales_json"] if "scales_json" in existing.keys() else "{}"),
                            c_json,
                            rsn.get("note", existing["note"]),
                            r_upd,
                            rsn.get("deleted_at"),
                            existing["id"],
                        ),
                    )
                    stats["snapshots"] += 1

        # 5b. Tasks ("Offene Zettel" — two-pass LWW by id so blocked_by_task_id FKs never fail on ordering!)
        rem_tasks = [rt for rt in (remote.get("tasks") or []) if isinstance(rt, dict) and rt.get("id") and rt.get("title")]
        local_tasks = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM tasks").fetchall()}
        pending_blockers: list[tuple[str, str | None]] = []
        for rt in rem_tasks:
            tid = str(rt["id"])
            r_upd = rt.get("updated_at") or rt.get("created_at") or ts_now
            r_hid = rt.get("habit_id") if rt.get("habit_id") in local_habits else None
            lt = local_tasks.get(tid)
            if lt is None:
                conn.execute(
                    """
                    INSERT INTO tasks(id, title, habit_id, priority, due_date, blocked_by_task_id, done_at, done_event_uuid, created_at, updated_at, deleted_at)
                    VALUES(?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
                    """,
                    (
                        tid,
                        str(rt["title"])[:180],
                        r_hid,
                        1 if int(rt.get("priority") or 0) > 0 else 0,
                        str(rt.get("due_date") or ""),
                        rt.get("done_at"),
                        rt.get("done_event_uuid"),
                        rt.get("created_at") or ts_now,
                        r_upd,
                        rt.get("deleted_at"),
                    ),
                )
                local_tasks[tid] = dict(rt)
                pending_blockers.append((tid, rt.get("blocked_by_task_id") or None))
                stats["tasks"] += 1
            else:
                l_upd = lt.get("updated_at") or lt.get("created_at") or ""
                if r_upd > l_upd or (r_upd == l_upd and rt.get("deleted_at") and not lt.get("deleted_at")):
                    conn.execute(
                        """
                        UPDATE tasks
                        SET title=?, habit_id=?, priority=?, due_date=?, done_at=?, done_event_uuid=?, updated_at=?, deleted_at=?
                        WHERE id=?
                        """,
                        (
                            str(rt["title"])[:180],
                            r_hid,
                            1 if int(rt.get("priority") or 0) > 0 else 0,
                            str(rt.get("due_date") or ""),
                            rt.get("done_at"),
                            rt.get("done_event_uuid"),
                            r_upd,
                            rt.get("deleted_at"),
                            tid,
                        ),
                    )
                    pending_blockers.append((tid, rt.get("blocked_by_task_id") or None))
                    stats["tasks"] += 1
        all_task_ids = {r[0] for r in conn.execute("SELECT id FROM tasks").fetchall()}
        for tid, bid in pending_blockers:
            safe_bid = bid if (bid and bid != tid and bid in all_task_ids) else None
            conn.execute("UPDATE tasks SET blocked_by_task_id=? WHERE id=?", (safe_bid, tid))

        # 6. Synced settings (mood_groups via timezone-safe LWW on mood_groups_updated_at)
        rem_settings = remote.get("settings") or {}
        if "mood_groups" in rem_settings:
            def _ts_epoch(ts_val: str) -> float:
                s = str(ts_val or "").strip()
                if not s:
                    return 0.0
                try:
                    if s.endswith("Z"):
                        return datetime.fromisoformat(s[:-1] + "+00:00").timestamp()
                    return datetime.fromisoformat(s).timestamp()
                except Exception:
                    return 0.0

            r_mg_upd = str(rem_settings.get("mood_groups_updated_at") or "")
            l_row = conn.execute("SELECT value FROM settings WHERE key = 'mood_groups_updated_at'").fetchone()
            l_mg_upd = str(l_row["value"]) if l_row else ""
            if _ts_epoch(r_mg_upd) > _ts_epoch(l_mg_upd) or (not l_mg_upd and rem_settings.get("mood_groups")):
                conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('mood_groups', ?)", (str(rem_settings["mood_groups"]),))
                conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('mood_groups_updated_at', ?)", (r_mg_upd or ts_now,))
                if "active_mood_group" in rem_settings:
                    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('active_mood_group', ?)", (str(rem_settings["active_mood_group"]),))
        if "task_nudges_enabled" in rem_settings:
            conn.execute(
                "INSERT OR REPLACE INTO settings(key, value) VALUES('task_nudges_enabled', ?)",
                ("1" if str(rem_settings["task_nudges_enabled"]) != "0" else "0",),
            )

    return stats


def _http_json(url: str, method: str = "GET", headers: dict[str, str] | None = None, body: dict[str, Any] | None = None) -> tuple[int, Any]:
    req_headers = {"User-Agent": "Daily-E2EE-Sync/0.1", "Accept": "application/json", **(headers or {})}
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"HTTP {exc.code}: {err_body[:180]}")


def create_github_gist_vault(auth_token: str, key_b64u: str | None = None, db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    """Create a brand-new private GitHub Gist holding ONLY the AES-256-GCM encrypted vault."""
    tok = auth_token.strip()
    if not tok:
        raise ValueError("GitHub Gist-Token fehlt")
    key = (key_b64u or "").strip() or generate_e2ee_key()
    state_payload = export_local_state_for_vault(db_path)
    envelope = encrypt_vault_payload(state_payload, key)

    _code, res = _http_json(
        "https://api.github.com/gists",
        method="POST",
        headers={"Authorization": f"Bearer {tok}", "X-GitHub-Api-Version": "2022-11-28"},
        body={
            "description": "Daily Encrypted Sync Vault (AES-256-GCM)",
            "public": False,
            "files": {VAULT_FILENAME: {"content": json.dumps(envelope)}},
        },
    )
    gist_id = res.get("id")
    if not gist_id:
        raise RuntimeError("Gist konnte nicht erstellt werden")
    cfg = save_e2ee_config(
        {"enabled": True, "provider": "gist", "gist_id": gist_id, "auth_token": tok, "key_b64u": key},
        db_path=db_path,
    )
    update_settings({"e2ee_last_sync_at": now_iso()}, db_path=db_path)
    return {**cfg, "pairing": build_e2ee_pairing_bundle(cfg)}


def sync_e2ee_vault(db_path: Path = DEFAULT_DB_PATH, skip_pull: bool = False) -> dict[str, Any]:
    """Full decentralized E2EE cycle: PULL -> DECRYPT -> CRDT MERGE -> RE-ENCRYPT (fresh IV) -> PUSH.
    Automatically retries on HTTP 409 Conflict (concurrent GitHub Gist edits across devices) with re-pull & merge."""
    cfg = get_e2ee_config(db_path)
    if not cfg.get("key_b64u"):
        raise ValueError("Kein E2EE-Schlüssel konfiguriert")

    prov = cfg["provider"]
    max_attempts = 4 if prov == "gist" else 1
    merged_stats = {"habits": 0, "edges": 0, "events": 0, "snapshots": 0, "dimensions": 0, "tasks": 0}

    for attempt in range(max_attempts):
        remote_envelope = None
        do_pull = (not skip_pull) or attempt > 0
        if do_pull:
            if prov == "gist":
                if not cfg["gist_id"] or not cfg["auth_token"]:
                    raise ValueError("Gist-ID oder Gist-Token fehlt")
                headers = {"Authorization": f"Bearer {cfg['auth_token']}", "X-GitHub-Api-Version": "2022-11-28"}
                _code, gist = _http_json(f"https://api.github.com/gists/{cfg['gist_id']}?_={int(time.time() * 1000)}", method="GET", headers=headers)
                f_obj = (gist.get("files") or {}).get(VAULT_FILENAME)
                if f_obj and f_obj.get("content"):
                    remote_envelope = json.loads(f_obj["content"])
            elif prov == "url":
                if not cfg["endpoint_url"]:
                    raise ValueError("Blind-Relay / WebDAV URL fehlt")
                raw_tok = str(cfg.get("auth_token") or "").strip()
                auth_val = raw_tok if raw_tok.lower().startswith(("bearer ", "basic ")) else (f"Bearer {raw_tok}" if raw_tok else "")
                headers = {"Authorization": auth_val} if auth_val else {}
                try:
                    _code, body = _http_json(cfg["endpoint_url"], method="GET", headers=headers)
                    if isinstance(body, dict) and body.get("alg") == "AES-256-GCM":
                        remote_envelope = body
                except RuntimeError as exc:
                    if "HTTP 404" not in str(exc):
                        raise
            else:
                raise ValueError(f"Unbekannter Provider: {prov}")

        if remote_envelope is not None:
            remote_state = decrypt_vault_payload(remote_envelope, cfg["key_b64u"])
            merged_stats = merge_remote_state_into_db(remote_state, db_path=db_path)

        # Re-export merged state, encrypt with fresh IV, and push back
        fresh_payload = export_local_state_for_vault(db_path)
        fresh_envelope = encrypt_vault_payload(fresh_payload, cfg["key_b64u"])

        if prov == "gist":
            headers = {"Authorization": f"Bearer {cfg['auth_token']}", "X-GitHub-Api-Version": "2022-11-28"}
            try:
                _http_json(
                    f"https://api.github.com/gists/{cfg['gist_id']}",
                    method="PATCH",
                    headers=headers,
                    body={"files": {VAULT_FILENAME: {"content": json.dumps(fresh_envelope)}}},
                )
                break
            except RuntimeError as exc:
                if any(code in str(exc) for code in ("HTTP 409", "HTTP 422", "HTTP 502", "HTTP 503")) and attempt + 1 < max_attempts:
                    time.sleep(0.45 * (attempt + 1) + random.uniform(0.05, 0.35))
                    continue
                raise
        elif prov == "url":
            raw_tok = str(cfg.get("auth_token") or "").strip()
            auth_val = raw_tok if raw_tok.lower().startswith(("bearer ", "basic ")) else (f"Bearer {raw_tok}" if raw_tok else "")
            headers = {"Authorization": auth_val} if auth_val else {}
            _http_json(cfg["endpoint_url"], method="PUT", headers=headers, body=fresh_envelope)
            break

    ts = now_iso()
    update_settings({"e2ee_last_sync_at": ts}, db_path=db_path)
    return {"ok": True, "synced_at": ts, "merged": merged_stats}

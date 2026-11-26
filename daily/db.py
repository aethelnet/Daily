"""SQLite WAL storage for Daily v0.1 (zero presets, arbitrary signed +/- graph routing)."""
from __future__ import annotations

import json
import os
import re
import secrets
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Any, Iterator

DEFAULT_DB_PATH = Path(
    os.environ.get("DAILY_DB_PATH", str(Path.home() / ".local" / "share" / "daily" / "daily.db"))
)

VALID_KINDS = {"min", "max", "neutral"}
VALID_PERIODS = {"day", "week", "month"}
VALID_RELATIONS = {"rollup", "hypothesis"}
VALID_WINDOWS = {"any", "morning", "afternoon", "evening", "night"}
VALID_SOURCES = {"tap", "retro", "manual"}


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return s[:40] or f"h-{uuid.uuid4().hex[:8]}"


DEFAULT_DIM_COLORS: dict[str, str] = {
    "stimmung": "#368470",
    "mental-fit": "#3d6b7d",
    "stress": "#c85a44",
    "anspannung": "#b4783c",
    "antrieb": "#6e68a8",
    "kraempfe": "#a85d73",
}


def _clean_hex_color(raw: str | None, fallback: str = "#3d6b7d") -> str:
    s = (raw or "").strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", s):
        return s.lower()
    return fallback


def now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def today_str() -> str:
    return date.today().isoformat()


def init_db(db_path: Path = DEFAULT_DB_PATH) -> Path:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS habits (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL DEFAULT 'neutral' CHECK(kind IN ('min', 'max', 'neutral')),
                target REAL,
                unit TEXT NOT NULL DEFAULT 'x',
                color TEXT NOT NULL DEFAULT '#2563eb',
                nudge_enabled INTEGER NOT NULL DEFAULT 0,
                nudge_lead_min INTEGER NOT NULL DEFAULT 20,
                nudge_alternatives TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS habit_edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
                target_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
                relation_type TEXT NOT NULL DEFAULT 'rollup' CHECK(relation_type IN ('rollup', 'hypothesis')),
                weight REAL NOT NULL DEFAULT 1.0,
                context_window TEXT NOT NULL DEFAULT 'any' CHECK(context_window IN ('any', 'morning', 'afternoon', 'evening', 'night')),
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                CHECK(source_id != target_id)
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
                ON habit_edges(source_id, target_id, relation_type, context_window);

            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
                amount REAL NOT NULL DEFAULT 1.0,
                occurred_at TEXT NOT NULL,
                window_minutes INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'tap' CHECK(source IN ('tap', 'retro', 'manual')),
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at);
            CREATE INDEX IF NOT EXISTS idx_events_habit ON events(habit_id, occurred_at);

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            INSERT OR IGNORE INTO settings(key, value) VALUES
                ('checkin_interval_hours', '3'),
                ('notifications_enabled', '1'),
                ('quiet_hours_start', '23'),
                ('quiet_hours_end', '8'),
                ('nudge_mode', 'observed'),
                ('tabpfn_threshold', '0.55'),
                ('followup_enabled', '1');
            """
        )

        # Non-destructive sync schema migrations (preserves all existing user data)
        ev_cols = {r[1] for r in conn.execute("PRAGMA table_info(events)").fetchall()}
        if "client_uuid" not in ev_cols:
            conn.execute("ALTER TABLE events ADD COLUMN client_uuid TEXT")
        if "updated_at" not in ev_cols:
            conn.execute("ALTER TABLE events ADD COLUMN updated_at TEXT")
        if "deleted_at" not in ev_cols:
            conn.execute("ALTER TABLE events ADD COLUMN deleted_at TEXT")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_client_uuid ON events(client_uuid) WHERE client_uuid IS NOT NULL"
        )
        conn.execute(
            "UPDATE events SET client_uuid = lower(hex(randomblob(16))) WHERE client_uuid IS NULL"
        )
        conn.execute("UPDATE events SET updated_at = created_at WHERE updated_at IS NULL")

        hab_cols = {r[1] for r in conn.execute("PRAGMA table_info(habits)").fetchall()}
        if "updated_at" not in hab_cols:
            conn.execute("ALTER TABLE habits ADD COLUMN updated_at TEXT")
        if "reminder_time" not in hab_cols:
            conn.execute("ALTER TABLE habits ADD COLUMN reminder_time TEXT NOT NULL DEFAULT ''")
        if "reminder_days" not in hab_cols:
            conn.execute("ALTER TABLE habits ADD COLUMN reminder_days TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6'")
        if "target_period" not in hab_cols:
            conn.execute("ALTER TABLE habits ADD COLUMN target_period TEXT NOT NULL DEFAULT 'day'")
        if "block_minutes" not in hab_cols:
            conn.execute("ALTER TABLE habits ADD COLUMN block_minutes INTEGER")
        if "active_since" not in hab_cols:
            conn.execute("ALTER TABLE habits ADD COLUMN active_since TEXT")
        conn.execute("UPDATE habits SET updated_at = created_at WHERE updated_at IS NULL")

        edge_cols = {r[1] for r in conn.execute("PRAGMA table_info(habit_edges)").fetchall()}
        if "updated_at" not in edge_cols:
            conn.execute("ALTER TABLE habit_edges ADD COLUMN updated_at TEXT")
        conn.execute("UPDATE habit_edges SET updated_at = created_at WHERE updated_at IS NULL")

        # Momentaufnahme (EMA state dimensions + sparse snapshots with true NaNs for TabPFN)
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS state_dimensions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                low_label TEXT NOT NULL DEFAULT '',
                high_label TEXT NOT NULL DEFAULT '',
                color TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_uuid TEXT UNIQUE,
                occurred_at TEXT NOT NULL,
                ratings_json TEXT NOT NULL DEFAULT '{}',
                causes_json TEXT NOT NULL DEFAULT '[]',
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_snapshots_occurred ON snapshots(occurred_at);
            """
        )

        # Seed the 5 orthogonal scientific EMA axes once (user can add custom axes or hide any default)
        if not conn.execute("SELECT 1 FROM settings WHERE key = 'state_dims_seeded'").fetchone():
            ts_seed = now_iso()
            default_dims = [
                ("stimmung", "Stimmung", "melancholisch", "leicht / gut", 0),
                ("mental-fit", "Mental fit", "leer / neblig", "wach / klar", 1),
                ("stress", "Stress", "entspannt", "unter Druck", 2),
                ("anspannung", "Anspannung", "locker", "angespannt", 3),
                ("antrieb", "Antrieb / Offenheit", "blockiert", "offen / bereit", 4),
            ]
            for dim_id, dname, low_l, high_l, order_idx in default_dims:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO state_dimensions(id, name, low_label, high_label, color, sort_order, archived, created_at, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?, 0, ?, ?)
                    """,
                    (dim_id, dname, low_l, high_l, DEFAULT_DIM_COLORS.get(dim_id, "#3d6b7d"), order_idx, ts_seed, ts_seed),
                )
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('state_dims_seeded', '1')")

        # Migrate legacy state_dimensions tables: add color & updated_at and backfill calm defaults
        dim_cols = {r[1] for r in conn.execute("PRAGMA table_info(state_dimensions)").fetchall()}
        if "color" not in dim_cols:
            conn.execute("ALTER TABLE state_dimensions ADD COLUMN color TEXT NOT NULL DEFAULT ''")
        if "updated_at" not in dim_cols:
            conn.execute("ALTER TABLE state_dimensions ADD COLUMN updated_at TEXT")
        conn.execute("UPDATE state_dimensions SET updated_at = created_at WHERE updated_at IS NULL")
        for dim_id, cur_color in conn.execute("SELECT id, color FROM state_dimensions").fetchall():
            if not (cur_color or "").strip():
                conn.execute(
                    "UPDATE state_dimensions SET color = ? WHERE id = ?",
                    (DEFAULT_DIM_COLORS.get(dim_id, "#3d6b7d"), dim_id),
                )

        # Seed quiet default Befinden groups (Alltag + Zyklus example) once — fully editable/deletable!
        if not conn.execute("SELECT 1 FROM settings WHERE key = 'mood_groups_seeded'").fetchone():
            ts_mg = now_iso()
            # Ensure the gentle example cycle axis exists once (hidden from Everyday & unrated Analysis!)
            conn.execute(
                """
                INSERT OR IGNORE INTO state_dimensions(id, name, low_label, high_label, color, sort_order, archived, created_at, updated_at)
                VALUES('kraempfe', 'Krämpfe', 'keine', 'stark', ?, 5, 0, ?, ?)
                """,
                (DEFAULT_DIM_COLORS["kraempfe"], ts_mg, ts_mg),
            )
            everyday_ids = [
                r[0]
                for r in conn.execute(
                    "SELECT id FROM state_dimensions WHERE archived = 0 AND id != 'kraempfe' ORDER BY sort_order ASC, created_at ASC"
                ).fetchall()
            ]
            if not everyday_ids:
                everyday_ids = ["stimmung", "mental-fit", "stress", "anspannung", "antrieb"]
            default_groups = [
                {"id": "alltag", "name": "Alltag", "dim_ids": everyday_ids},
                {"id": "zyklus", "name": "Zyklus", "dim_ids": ["stimmung", "stress", "antrieb", "kraempfe"]},
            ]
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES('mood_groups', ?)",
                (json.dumps(default_groups, ensure_ascii=False),),
            )
            conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('active_mood_group', 'alltag')")
            conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('mood_groups_updated_at', ?)", (ts_mg,))
            conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('mood_groups_seeded', '1')")

        conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES('routing_mode', 'observed')")
        # Auto-generate a persistent local device sync token (only used for non-localhost devices)
        if not conn.execute("SELECT 1 FROM settings WHERE key = 'sync_token'").fetchone():
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('sync_token', ?)",
                (secrets.token_urlsafe(18),),
            )
        conn.commit()
    finally:
        conn.close()
    return db_path


@contextmanager
def get_conn(db_path: Path = DEFAULT_DB_PATH) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(db_path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# ---- Settings ----

def get_settings(db_path: Path = DEFAULT_DB_PATH) -> dict[str, str]:
    with get_conn(db_path) as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {r["key"]: r["value"] for r in rows}


def update_settings(updates: dict[str, Any], db_path: Path = DEFAULT_DB_PATH) -> dict[str, str]:
    allowed = {
        "checkin_interval_hours",
        "notifications_enabled",
        "quiet_hours_start",
        "quiet_hours_end",
        "nudge_mode",
        "routing_mode",
        "tabpfn_threshold",
        "followup_enabled",
        "mood_groups",
        "mood_groups_updated_at",
        "active_mood_group",
        "sync_token",
        "e2ee_enabled",
        "e2ee_provider",
        "e2ee_gist_id",
        "e2ee_endpoint_url",
        "e2ee_auth_token",
        "e2ee_key",
        "e2ee_last_sync_at",
    }
    with get_conn(db_path) as conn:
        eff_updates = dict(updates)
        if "mood_groups" in eff_updates:
            mg_ts = str(eff_updates.get("mood_groups_updated_at") or "").strip()
            if not mg_ts:
                eff_updates["mood_groups_updated_at"] = now_iso()
            elif mg_ts.endswith("Z"):
                try:
                    eff_updates["mood_groups_updated_at"] = (
                        datetime.fromisoformat(mg_ts[:-1] + "+00:00").astimezone().replace(tzinfo=None, microsecond=0).isoformat()
                    )
                except Exception:
                    eff_updates["mood_groups_updated_at"] = now_iso()
        for k, v in eff_updates.items():
            if k not in allowed:
                continue
            if k in {"nudge_mode", "routing_mode"} and str(v) not in {"observed", "tabpfn"}:
                raise ValueError(f"Invalid {k}: {v}")
            if k == "tabpfn_threshold":
                v = round(max(0.25, min(0.95, float(v))), 2)
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (k, str(v)),
            )
    return get_settings(db_path)


# ---- Habits ----

def list_habits(include_archived: bool = False, db_path: Path = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    with get_conn(db_path) as conn:
        if include_archived:
            rows = conn.execute("SELECT * FROM habits ORDER BY archived ASC, sort_order ASC, created_at ASC").fetchall()
        else:
            rows = conn.execute("SELECT * FROM habits WHERE archived = 0 ORDER BY sort_order ASC, created_at ASC").fetchall()
    return [dict(r) for r in rows]


def _normalize_reminder_times(raw: str) -> str:
    parts = [p.strip() for p in str(raw or "").replace(";", ",").split(",") if p.strip()]
    clean: list[str] = []
    for p in parts:
        m = re.fullmatch(r"(\d{1,2}):(\d{2})", p)
        if not m:
            raise ValueError(f"Ungültige Uhrzeit: {p} (Format HH:MM)")
        hh, mm = int(m.group(1)), int(m.group(2))
        if not (0 <= hh <= 23 and 0 <= mm <= 59):
            raise ValueError(f"Ungültige Uhrzeit: {p}")
        formatted = f"{hh:02d}:{mm:02d}"
        if formatted not in clean:
            clean.append(formatted)
    return ",".join(clean)


def _normalize_reminder_days(raw: str) -> str:
    parts = [p.strip() for p in str(raw or "").split(",") if p.strip()]
    days: list[int] = []
    for p in parts:
        d = int(p)
        if 0 <= d <= 6 and d not in days:
            days.append(d)
    days.sort()
    return ",".join(str(d) for d in days) if days else "0,1,2,3,4,5,6"


def create_habit(
    name: str,
    kind: str = "neutral",
    target: float | None = None,
    target_period: str = "day",
    unit: str = "x",
    color: str = "#2563eb",
    nudge_enabled: bool = False,
    nudge_lead_min: int = 20,
    nudge_alternatives: str = "",
    reminder_time: str = "",
    reminder_days: str = "0,1,2,3,4,5,6",
    block_minutes: int | None = None,
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("Habit name cannot be empty")
    if kind not in VALID_KINDS:
        raise ValueError(f"Invalid kind: {kind}")
    clean_period = (target_period or "day").strip()
    if clean_period not in VALID_PERIODS:
        raise ValueError(f"Invalid target_period: {clean_period}")
    clean_rtime = _normalize_reminder_times(reminder_time)
    clean_rdays = _normalize_reminder_days(reminder_days)
    clean_block = max(1, min(720, int(block_minutes))) if block_minutes is not None and int(block_minutes) > 0 else None
    base_id = slugify(clean_name)
    with get_conn(db_path) as conn:
        hid = base_id
        suffix = 2
        while conn.execute("SELECT 1 FROM habits WHERE id = ?", (hid,)).fetchone():
            hid = f"{base_id}-{suffix}"
            suffix += 1
        max_order = conn.execute("SELECT COALESCE(MAX(sort_order), -1) FROM habits").fetchone()[0]
        ts_now = now_iso()
        conn.execute(
            """
            INSERT INTO habits(id, name, kind, target, target_period, unit, color, nudge_enabled, nudge_lead_min, nudge_alternatives, reminder_time, reminder_days, block_minutes, active_since, sort_order, archived, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)
            """,
            (
                hid,
                clean_name,
                kind,
                target,
                clean_period,
                (unit.strip() or "x"),
                color.strip() or "#2563eb",
                1 if nudge_enabled else 0,
                max(5, min(180, int(nudge_lead_min))),
                nudge_alternatives.strip(),
                clean_rtime,
                clean_rdays,
                clean_block,
                int(max_order) + 1,
                ts_now,
                ts_now,
            ),
        )
        row = conn.execute("SELECT * FROM habits WHERE id = ?", (hid,)).fetchone()
    return dict(row)


def update_habit(habit_id: str, fields: dict[str, Any], db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    allowed = {
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
    }
    sets: list[str] = []
    vals: list[Any] = []
    for k, v in fields.items():
        if k not in allowed:
            continue
        if k == "kind" and v not in VALID_KINDS:
            raise ValueError(f"Invalid kind: {v}")
        if k == "target_period":
            v = str(v or "day").strip()
            if v not in VALID_PERIODS:
                raise ValueError(f"Invalid target_period: {v}")
        if k == "name":
            v = str(v).strip()
            if not v:
                raise ValueError("Habit name cannot be empty")
        if k in {"nudge_enabled", "archived"}:
            v = 1 if bool(v) else 0
        if k == "nudge_lead_min":
            v = max(5, min(180, int(v)))
        if k == "block_minutes":
            v = max(1, min(720, int(v))) if v is not None and int(v) > 0 else None
        if k == "active_since":
            v = str(v).strip() or None if v is not None else None
        if k == "reminder_time":
            v = _normalize_reminder_times(str(v or ""))
        if k == "reminder_days":
            v = _normalize_reminder_days(str(v or ""))
        sets.append(f"{k} = ?")
        vals.append(v)
    if not sets:
        with get_conn(db_path) as conn:
            row = conn.execute("SELECT * FROM habits WHERE id = ?", (habit_id,)).fetchone()
            if not row:
                raise KeyError(f"Habit not found: {habit_id}")
            return dict(row)
    sets.append("updated_at = ?")
    vals.append(now_iso())
    vals.append(habit_id)
    with get_conn(db_path) as conn:
        cur = conn.execute(f"UPDATE habits SET {', '.join(sets)} WHERE id = ?", vals)
        if cur.rowcount == 0:
            raise KeyError(f"Habit not found: {habit_id}")
        row = conn.execute("SELECT * FROM habits WHERE id = ?", (habit_id,)).fetchone()
    return dict(row)


def delete_habit(habit_id: str, db_path: Path = DEFAULT_DB_PATH) -> bool:
    with get_conn(db_path) as conn:
        cur = conn.execute("DELETE FROM habits WHERE id = ?", (habit_id,))
    return cur.rowcount > 0


def merge_habit(
    source_id: str,
    target_id: str,
    tag_notes: bool = True,
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    """Atomically transfer all events, snapshot causes & non-conflicting edges from source_id to target_id, then delete source_id."""
    if source_id == target_id:
        raise ValueError("Quelle und Ziel müssen unterschiedlich sein")
    ts_now = now_iso()
    with get_conn(db_path) as conn:
        src = conn.execute("SELECT * FROM habits WHERE id = ?", (source_id,)).fetchone()
        dst = conn.execute("SELECT * FROM habits WHERE id = ?", (target_id,)).fetchone()
        if not src:
            raise KeyError(f"Quell-Habit nicht gefunden: {source_id}")
        if not dst:
            raise KeyError(f"Ziel-Habit nicht gefunden: {target_id}")

        src_name = src["name"]
        # 1. Transfer events (optionally preserving source name in empty notes so context is never lost)
        if tag_notes:
            cur_ev = conn.execute(
                """
                UPDATE events
                SET habit_id = ?,
                    note = CASE WHEN trim(note) = '' THEN ? ELSE note END,
                    updated_at = ?
                WHERE habit_id = ?
                """,
                (target_id, f"aus: {src_name}", ts_now, source_id),
            )
        else:
            cur_ev = conn.execute(
                "UPDATE events SET habit_id = ?, updated_at = ? WHERE habit_id = ?",
                (target_id, ts_now, source_id),
            )
        moved_events = cur_ev.rowcount

        # 2. Remap snapshot causes referencing source_id -> target_id (deduplicated)
        snaps = conn.execute("SELECT id, causes_json FROM snapshots WHERE deleted_at IS NULL").fetchall()
        updated_snaps = 0
        for sn in snaps:
            try:
                causes = json.loads(sn["causes_json"] or "[]")
            except Exception:
                continue
            if source_id in causes:
                new_causes: list[str] = []
                for c in causes:
                    mapped = target_id if c == source_id else c
                    if mapped not in new_causes:
                        new_causes.append(mapped)
                conn.execute(
                    "UPDATE snapshots SET causes_json = ?, updated_at = ? WHERE id = ?",
                    (json.dumps(new_causes, ensure_ascii=False), ts_now, sn["id"]),
                )
                updated_snaps += 1

        # 3. Re-point non-conflicting edges (skip self-loops & already-existing edges on target)
        edges_rows = conn.execute(
            "SELECT * FROM habit_edges WHERE source_id = ? OR target_id = ?",
            (source_id, source_id),
        ).fetchall()
        moved_edges = 0
        for e in edges_rows:
            ns = target_id if e["source_id"] == source_id else e["source_id"]
            nt = target_id if e["target_id"] == source_id else e["target_id"]
            if ns == nt:
                continue
            exists = conn.execute(
                """
                SELECT 1 FROM habit_edges
                WHERE source_id = ? AND target_id = ? AND relation_type = ? AND context_window = ?
                """,
                (ns, nt, e["relation_type"], e["context_window"]),
            ).fetchone()
            if not exists:
                conn.execute(
                    """
                    INSERT INTO habit_edges(source_id, target_id, relation_type, weight, context_window, note, created_at, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (ns, nt, e["relation_type"], e["weight"], e["context_window"], e["note"], e["created_at"], ts_now),
                )
                moved_edges += 1

        # 4. Delete source habit (cascades any remaining old edges pointing to source)
        conn.execute("DELETE FROM habits WHERE id = ?", (source_id,))

    return {
        "merged": True,
        "source_id": source_id,
        "source_name": src_name,
        "target_id": target_id,
        "target_name": dst["name"],
        "moved_events": moved_events,
        "updated_snapshots": updated_snaps,
        "moved_edges": moved_edges,
    }


def reorder_habits(habit_ids: list[str], db_path: Path = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    """Persist explicit display order for habits."""
    ts = now_iso()
    with get_conn(db_path) as conn:
        for idx, hid in enumerate(habit_ids):
            conn.execute("UPDATE habits SET sort_order = ?, updated_at = ? WHERE id = ?", (idx, ts, hid))
    return list_habits(include_archived=False, db_path=db_path)


# ---- Signed Edges (Rollup +/- & Hypotheses) ----

def list_edges(db_path: Path = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    with get_conn(db_path) as conn:
        rows = conn.execute(
            """
            SELECT e.*, s.name AS source_name, t.name AS target_name
            FROM habit_edges e
            JOIN habits s ON s.id = e.source_id
            JOIN habits t ON t.id = e.target_id
            ORDER BY e.relation_type ASC, e.id ASC
            """
        ).fetchall()
    return [dict(r) for r in rows]


def upsert_edge(
    source_id: str,
    target_id: str,
    relation_type: str = "rollup",
    weight: float = 1.0,
    context_window: str = "any",
    note: str = "",
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    if source_id == target_id:
        raise ValueError("A habit cannot route to itself")
    if relation_type not in VALID_RELATIONS:
        raise ValueError(f"Invalid relation_type: {relation_type}")
    if context_window not in VALID_WINDOWS:
        raise ValueError(f"Invalid context_window: {context_window}")
    if abs(weight) < 1e-6:
        raise ValueError("Edge weight cannot be 0")
    with get_conn(db_path) as conn:
        conn.execute(
            """
            INSERT INTO habit_edges(source_id, target_id, relation_type, weight, context_window, note, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id, target_id, relation_type, context_window)
            DO UPDATE SET weight=excluded.weight, note=excluded.note
            """,
            (source_id, target_id, relation_type, float(weight), context_window, note.strip(), now_iso()),
        )
        row = conn.execute(
            """
            SELECT e.*, s.name AS source_name, t.name AS target_name
            FROM habit_edges e
            JOIN habits s ON s.id = e.source_id
            JOIN habits t ON t.id = e.target_id
            WHERE e.source_id = ? AND e.target_id = ? AND e.relation_type = ? AND e.context_window = ?
            """,
            (source_id, target_id, relation_type, context_window),
        ).fetchone()
    return dict(row)


def update_edge(
    edge_id: int,
    source_id: str,
    target_id: str,
    relation_type: str = "rollup",
    weight: float = 1.0,
    context_window: str = "any",
    note: str = "",
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    if source_id == target_id:
        raise ValueError("A habit cannot route to itself")
    if relation_type not in VALID_RELATIONS:
        raise ValueError(f"Invalid relation_type: {relation_type}")
    if context_window not in VALID_WINDOWS:
        raise ValueError(f"Invalid context_window: {context_window}")
    if abs(weight) < 1e-6:
        raise ValueError("Edge weight cannot be 0")
    with get_conn(db_path) as conn:
        cur_row = conn.execute("SELECT * FROM habit_edges WHERE id = ?", (edge_id,)).fetchone()
        if not cur_row:
            raise KeyError(f"Edge not found: {edge_id}")
        conflict = conn.execute(
            """
            SELECT id FROM habit_edges
            WHERE source_id = ? AND target_id = ? AND relation_type = ? AND context_window = ? AND id != ?
            """,
            (source_id, target_id, relation_type, context_window, edge_id),
        ).fetchone()
        if conflict:
            conn.execute("DELETE FROM habit_edges WHERE id = ?", (edge_id,))
            target_edge_id = int(conflict["id"])
            conn.execute(
                "UPDATE habit_edges SET weight = ?, note = ? WHERE id = ?",
                (float(weight), (note or "").strip(), target_edge_id),
            )
        else:
            target_edge_id = edge_id
            conn.execute(
                """
                UPDATE habit_edges
                SET source_id = ?, target_id = ?, relation_type = ?, weight = ?, context_window = ?, note = ?
                WHERE id = ?
                """,
                (source_id, target_id, relation_type, float(weight), context_window, (note or "").strip(), edge_id),
            )
        row = conn.execute(
            """
            SELECT e.*, s.name AS source_name, t.name AS target_name
            FROM habit_edges e
            JOIN habits s ON s.id = e.source_id
            JOIN habits t ON t.id = e.target_id
            WHERE e.id = ?
            """,
            (target_edge_id,),
        ).fetchone()
    return dict(row)


def delete_edge(edge_id: int, db_path: Path = DEFAULT_DB_PATH) -> bool:
    with get_conn(db_path) as conn:
        cur = conn.execute("DELETE FROM habit_edges WHERE id = ?", (edge_id,))
    return cur.rowcount > 0


# ---- Events (Quick-Tap & Retro Check-in) ----

def log_event(
    habit_id: str,
    amount: float = 1.0,
    occurred_at: str | None = None,
    window_minutes: int = 0,
    source: str = "tap",
    note: str = "",
    client_uuid: str | None = None,
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    if source not in VALID_SOURCES:
        raise ValueError(f"Invalid source: {source}")
    ts = occurred_at or now_iso()
    datetime.fromisoformat(ts)
    c_uuid = (client_uuid or "").strip() or uuid.uuid4().hex
    ts_now = now_iso()
    with get_conn(db_path) as conn:
        if not conn.execute("SELECT 1 FROM habits WHERE id = ?", (habit_id,)).fetchone():
            raise KeyError(f"Habit not found: {habit_id}")
        # Idempotent retry guard for offline mobile sync
        existing = conn.execute(
            """
            SELECT ev.*, h.name AS habit_name, h.unit AS habit_unit, h.kind AS habit_kind, h.color AS habit_color
            FROM events ev JOIN habits h ON h.id = ev.habit_id
            WHERE ev.client_uuid = ?
            """,
            (c_uuid,),
        ).fetchone()
        if existing:
            return dict(existing)
        cur = conn.execute(
            """
            INSERT INTO events(habit_id, amount, occurred_at, window_minutes, source, note, created_at, client_uuid, updated_at, deleted_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (habit_id, float(amount), ts, max(0, int(window_minutes)), source, note.strip(), ts_now, c_uuid, ts_now),
        )
        row = conn.execute(
            """
            SELECT ev.*, h.name AS habit_name, h.unit AS habit_unit, h.kind AS habit_kind, h.color AS habit_color
            FROM events ev JOIN habits h ON h.id = ev.habit_id
            WHERE ev.id = ?
            """,
            (cur.lastrowid,),
        ).fetchone()
    return dict(row)


def log_retro_batch(
    items: list[dict[str, Any]],
    window_minutes: int = 180,
    end_at: str | None = None,
    note: str = "",
    db_path: Path = DEFAULT_DB_PATH,
) -> list[dict[str, Any]]:
    """Log multiple retroactive activities spread cleanly across [end_at - window_minutes, end_at]."""
    valid = [it for it in items if float(it.get("amount", 0)) != 0.0]
    if not valid:
        return []
    end_dt = datetime.fromisoformat(end_at) if end_at else datetime.now().replace(microsecond=0)
    win = max(15, min(720, int(window_minutes)))
    start_dt = end_dt - timedelta(minutes=win)
    n = len(valid)
    created: list[dict[str, Any]] = []
    for idx, it in enumerate(valid):
        # Spread evenly inside the retro block so time-of-day rhythm remains meaningful
        frac = (idx + 0.5) / n
        ts_dt = start_dt + timedelta(seconds=int(win * 60 * frac))
        item_note = (it.get("note") or note or "").strip()
        created.append(
            log_event(
                habit_id=it["habit_id"],
                amount=float(it["amount"]),
                occurred_at=ts_dt.replace(microsecond=0).isoformat(),
                window_minutes=win,
                source="retro",
                note=item_note,
                db_path=db_path,
            )
        )
    return created


def update_event(event_id: int, fields: dict[str, Any], db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    allowed = {"habit_id", "amount", "occurred_at", "note", "window_minutes"}
    sets: list[str] = []
    vals: list[Any] = []
    for k, v in fields.items():
        if k not in allowed:
            continue
        if k == "occurred_at":
            datetime.fromisoformat(str(v))
        elif k == "amount":
            v = float(v)
            if v == 0:
                raise ValueError("amount must be non-zero")
        elif k == "window_minutes":
            v = max(0, int(v))
        elif k == "note":
            v = str(v).strip()
        sets.append(f"{k} = ?")
        vals.append(v)
    if not sets:
        raise ValueError("No valid fields to update")
    sets.append("updated_at = ?")
    vals.append(now_iso())
    vals.append(event_id)
    with get_conn(db_path) as conn:
        if "habit_id" in fields and fields["habit_id"] is not None:
            h_exists = conn.execute("SELECT 1 FROM habits WHERE id = ?", (fields["habit_id"],)).fetchone()
            if not h_exists:
                raise ValueError(f"Unknown habit_id: {fields['habit_id']}")
        cur = conn.execute(f"UPDATE events SET {', '.join(sets)} WHERE id = ? AND deleted_at IS NULL", vals)
        if cur.rowcount == 0:
            raise KeyError(f"Event not found: {event_id}")
        row = conn.execute(
            """
            SELECT ev.*, h.name AS habit_name, h.unit AS habit_unit, h.kind AS habit_kind, h.color AS habit_color
            FROM events ev JOIN habits h ON h.id = ev.habit_id
            WHERE ev.id = ?
            """,
            (event_id,),
        ).fetchone()
    return dict(row)


def delete_event(event_id: int, db_path: Path = DEFAULT_DB_PATH) -> bool:
    ts = now_iso()
    with get_conn(db_path) as conn:
        cur = conn.execute(
            "UPDATE events SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
            (ts, ts, event_id),
        )
    return cur.rowcount > 0


def list_events(
    day: str | None = None,
    days_back: int | None = None,
    include_deleted: bool = False,
    db_path: Path = DEFAULT_DB_PATH,
) -> list[dict[str, Any]]:
    del_clause = "" if include_deleted else "AND ev.deleted_at IS NULL"
    with get_conn(db_path) as conn:
        if day:
            rows = conn.execute(
                f"""
                SELECT ev.*, h.name AS habit_name, h.unit AS habit_unit, h.kind AS habit_kind, h.color AS habit_color
                FROM events ev JOIN habits h ON h.id = ev.habit_id
                WHERE substr(ev.occurred_at, 1, 10) = ? {del_clause}
                ORDER BY ev.occurred_at DESC, ev.id DESC
                """,
                (day,),
            ).fetchall()
        elif days_back is not None:
            cutoff = (date.today() - timedelta(days=max(1, days_back) - 1)).isoformat()
            rows = conn.execute(
                f"""
                SELECT ev.*, h.name AS habit_name, h.unit AS habit_unit, h.kind AS habit_kind, h.color AS habit_color
                FROM events ev JOIN habits h ON h.id = ev.habit_id
                WHERE substr(ev.occurred_at, 1, 10) >= ? {del_clause}
                ORDER BY ev.occurred_at ASC, ev.id ASC
                """,
                (cutoff,),
            ).fetchall()
        else:
            where = "" if include_deleted else "WHERE ev.deleted_at IS NULL"
            rows = conn.execute(
                f"""
                SELECT ev.*, h.name AS habit_name, h.unit AS habit_unit, h.kind AS habit_kind, h.color AS habit_color
                FROM events ev JOIN habits h ON h.id = ev.habit_id
                {where}
                ORDER BY ev.occurred_at ASC, ev.id ASC
                """
            ).fetchall()
    return [dict(r) for r in rows]


def get_last_used_map(db_path: Path = DEFAULT_DB_PATH) -> dict[str, str]:
    """Return latest positive occurrence timestamp per habit (powers 'Zuletzt aktiv' sorting)."""
    with get_conn(db_path) as conn:
        rows = conn.execute(
            """
            SELECT habit_id, MAX(occurred_at) AS last_at
            FROM events
            WHERE deleted_at IS NULL AND amount > 0
            GROUP BY habit_id
            """
        ).fetchall()
    return {r["habit_id"]: r["last_at"] for r in rows if r["last_at"]}


def last_event_time(db_path: Path = DEFAULT_DB_PATH) -> datetime | None:
    with get_conn(db_path) as conn:
        row = conn.execute("SELECT MAX(created_at) AS ts FROM events WHERE deleted_at IS NULL").fetchone()
    if not row or not row["ts"]:
        return None
    return datetime.fromisoformat(row["ts"])


# ---- Momentaufnahme (EMA State Dimensions & Sparse Snapshots) ----

def list_state_dimensions(include_archived: bool = False, db_path: Path = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    with get_conn(db_path) as conn:
        if include_archived:
            rows = conn.execute(
                "SELECT * FROM state_dimensions ORDER BY archived ASC, sort_order ASC, created_at ASC"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM state_dimensions WHERE archived = 0 ORDER BY sort_order ASC, created_at ASC"
            ).fetchall()
    return [dict(r) for r in rows]


def create_state_dimension(
    name: str,
    low_label: str = "",
    high_label: str = "",
    color: str = "",
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("Name der Achse darf nicht leer sein")
    base_id = slugify(clean_name)
    clean_color = _clean_hex_color(color, DEFAULT_DIM_COLORS.get(base_id, "#3d6b7d"))
    ts_now = now_iso()
    with get_conn(db_path) as conn:
        # If an archived dimension with the same name exists, simply unarchive it!
        existing = conn.execute(
            "SELECT * FROM state_dimensions WHERE lower(name) = lower(?)",
            (clean_name,),
        ).fetchone()
        if existing:
            next_color = _clean_hex_color(color, existing["color"] or DEFAULT_DIM_COLORS.get(existing["id"], "#3d6b7d"))
            conn.execute(
                """
                UPDATE state_dimensions
                SET archived = 0,
                    low_label = COALESCE(NULLIF(?, ''), low_label),
                    high_label = COALESCE(NULLIF(?, ''), high_label),
                    color = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (low_label.strip(), high_label.strip(), next_color, ts_now, existing["id"]),
            )
            row = conn.execute("SELECT * FROM state_dimensions WHERE id = ?", (existing["id"],)).fetchone()
            return dict(row)

        did = base_id
        suffix = 2
        while conn.execute("SELECT 1 FROM state_dimensions WHERE id = ?", (did,)).fetchone():
            did = f"{base_id}-{suffix}"
            suffix += 1
        max_order = conn.execute("SELECT COALESCE(MAX(sort_order), -1) FROM state_dimensions").fetchone()[0]
        conn.execute(
            """
            INSERT INTO state_dimensions(id, name, low_label, high_label, color, sort_order, archived, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (did, clean_name, low_label.strip(), high_label.strip(), clean_color, int(max_order) + 1, ts_now, ts_now),
        )
        row = conn.execute("SELECT * FROM state_dimensions WHERE id = ?", (did,)).fetchone()
    return dict(row)


def update_state_dimension(dim_id: str, fields: dict[str, Any], db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    allowed = {"name", "low_label", "high_label", "color", "archived", "sort_order"}
    sets: list[str] = []
    vals: list[Any] = []
    for k, v in fields.items():
        if k not in allowed:
            continue
        if k == "archived":
            v = 1 if bool(v) else 0
        elif k == "color":
            v = _clean_hex_color(str(v), DEFAULT_DIM_COLORS.get(dim_id, "#3d6b7d"))
        elif k in {"name", "low_label", "high_label"}:
            v = str(v).strip()
        sets.append(f"{k} = ?")
        vals.append(v)
    if not sets:
        raise ValueError("No valid fields to update")
    sets.append("updated_at = ?")
    vals.append(now_iso())
    vals.append(dim_id)
    with get_conn(db_path) as conn:
        cur = conn.execute(f"UPDATE state_dimensions SET {', '.join(sets)} WHERE id = ?", vals)
        if cur.rowcount == 0:
            raise KeyError(f"State dimension not found: {dim_id}")
        row = conn.execute("SELECT * FROM state_dimensions WHERE id = ?", (dim_id,)).fetchone()
    return dict(row)


def reorder_state_dimensions(dim_ids: list[str], db_path: Path = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    """Persist explicit display order for state dimensions."""
    ts = now_iso()
    with get_conn(db_path) as conn:
        for idx, did in enumerate(dim_ids):
            conn.execute("UPDATE state_dimensions SET sort_order = ?, updated_at = ? WHERE id = ?", (idx, ts, did))
    return list_state_dimensions(include_archived=False, db_path=db_path)


def _decode_snapshot(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    try:
        d["ratings"] = json.loads(d.pop("ratings_json", "{}") or "{}")
    except Exception:
        d["ratings"] = {}
    try:
        d["causes"] = json.loads(d.pop("causes_json", "[]") or "[]")
    except Exception:
        d["causes"] = []
    return d


def create_snapshot(
    ratings: dict[str, float | int],
    causes: list[str] | None = None,
    note: str = "",
    occurred_at: str | None = None,
    client_uuid: str | None = None,
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    clean_ratings: dict[str, float] = {}
    for k, v in (ratings or {}).items():
        if v is None or v == "":
            continue
        val = float(v)
        if 1.0 <= val <= 5.0:
            clean_ratings[str(k)] = round(val, 1)
    clean_causes = [str(c).strip() for c in (causes or []) if str(c).strip()]
    clean_note = (note or "").strip()
    if not clean_ratings and not clean_note and not clean_causes:
        raise ValueError("Bitte mindestens einen Wert, eine Ursache oder eine Notiz eintragen")

    ts = occurred_at or now_iso()
    datetime.fromisoformat(ts)
    c_uuid = (client_uuid or "").strip() or uuid.uuid4().hex
    ts_now = now_iso()
    with get_conn(db_path) as conn:
        existing = conn.execute("SELECT * FROM snapshots WHERE client_uuid = ?", (c_uuid,)).fetchone()
        if existing:
            return _decode_snapshot(existing)
        cur = conn.execute(
            """
            INSERT INTO snapshots(client_uuid, occurred_at, ratings_json, causes_json, note, created_at, updated_at, deleted_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (c_uuid, ts, json.dumps(clean_ratings, ensure_ascii=False), json.dumps(clean_causes, ensure_ascii=False), clean_note, ts_now, ts_now),
        )
        row = conn.execute("SELECT * FROM snapshots WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _decode_snapshot(row)


def update_snapshot(snapshot_id: int, fields: dict[str, Any], db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    with get_conn(db_path) as conn:
        cur_row = conn.execute("SELECT * FROM snapshots WHERE id = ? AND deleted_at IS NULL", (snapshot_id,)).fetchone()
        if not cur_row:
            raise KeyError(f"Snapshot not found: {snapshot_id}")
        cur_dec = _decode_snapshot(cur_row)

        ratings = cur_dec["ratings"]
        if "ratings" in fields and fields["ratings"] is not None:
            clean_ratings: dict[str, float] = {}
            for k, v in (fields["ratings"] or {}).items():
                if v is None or v == "":
                    continue
                val = float(v)
                if 1.0 <= val <= 5.0:
                    clean_ratings[str(k)] = round(val, 1)
            ratings = clean_ratings

        causes = cur_dec["causes"]
        if "causes" in fields and fields["causes"] is not None:
            causes = [str(c).strip() for c in (fields["causes"] or []) if str(c).strip()]

        note = cur_dec["note"]
        if "note" in fields and fields["note"] is not None:
            note = str(fields["note"]).strip()

        occurred_at = cur_dec["occurred_at"]
        if "occurred_at" in fields and fields["occurred_at"] is not None:
            occurred_at = str(fields["occurred_at"])
            datetime.fromisoformat(occurred_at)

        if not ratings and not note and not causes:
            raise ValueError("Bitte mindestens einen Wert, eine Ursache oder eine Notiz eintragen")

        conn.execute(
            """
            UPDATE snapshots
            SET occurred_at = ?, ratings_json = ?, causes_json = ?, note = ?, updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
            """,
            (
                occurred_at,
                json.dumps(ratings, ensure_ascii=False),
                json.dumps(causes, ensure_ascii=False),
                note,
                now_iso(),
                snapshot_id,
            ),
        )
        row = conn.execute("SELECT * FROM snapshots WHERE id = ?", (snapshot_id,)).fetchone()
    return _decode_snapshot(row)


def delete_snapshot(snapshot_id: int, db_path: Path = DEFAULT_DB_PATH) -> bool:
    ts = now_iso()
    with get_conn(db_path) as conn:
        cur = conn.execute(
            "UPDATE snapshots SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
            (ts, ts, snapshot_id),
        )
    return cur.rowcount > 0


def list_snapshots(
    day: str | None = None,
    days_back: int | None = None,
    db_path: Path = DEFAULT_DB_PATH,
) -> list[dict[str, Any]]:
    with get_conn(db_path) as conn:
        if day:
            rows = conn.execute(
                """
                SELECT * FROM snapshots
                WHERE substr(occurred_at, 1, 10) = ? AND deleted_at IS NULL
                ORDER BY occurred_at DESC, id DESC
                """,
                (day,),
            ).fetchall()
        elif days_back is not None:
            cutoff = (date.today() - timedelta(days=max(1, days_back) - 1)).isoformat()
            rows = conn.execute(
                """
                SELECT * FROM snapshots
                WHERE substr(occurred_at, 1, 10) >= ? AND deleted_at IS NULL
                ORDER BY occurred_at ASC, id ASC
                """,
                (cutoff,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM snapshots WHERE deleted_at IS NULL ORDER BY occurred_at ASC, id ASC"
            ).fetchall()
    return [_decode_snapshot(r) for r in rows]


def list_log_range(
    start_day: str,
    end_day: str,
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    """Return all non-deleted events and snapshots within [start_day, end_day] inclusive."""
    d_start = date.fromisoformat(start_day[:10])
    d_end = date.fromisoformat(end_day[:10])
    if d_start > d_end:
        d_start, d_end = d_end, d_start
    if (d_end - d_start).days > 365:
        d_start = d_end - timedelta(days=365)
    s_iso, e_iso = d_start.isoformat(), d_end.isoformat()
    with get_conn(db_path) as conn:
        ev_rows = conn.execute(
            """
            SELECT ev.*, h.name AS habit_name, h.unit AS habit_unit, h.kind AS habit_kind, h.color AS habit_color
            FROM events ev JOIN habits h ON h.id = ev.habit_id
            WHERE substr(ev.occurred_at, 1, 10) BETWEEN ? AND ? AND ev.deleted_at IS NULL
            ORDER BY ev.occurred_at DESC, ev.id DESC
            """,
            (s_iso, e_iso),
        ).fetchall()
        sn_rows = conn.execute(
            """
            SELECT * FROM snapshots
            WHERE substr(occurred_at, 1, 10) BETWEEN ? AND ? AND deleted_at IS NULL
            ORDER BY occurred_at DESC, id DESC
            """,
            (s_iso, e_iso),
        ).fetchall()
    return {
        "start": s_iso,
        "end": e_iso,
        "events": [dict(r) for r in ev_rows],
        "snapshots": [_decode_snapshot(r) for r in sn_rows],
        "state_dimensions": list_state_dimensions(include_archived=True, db_path=db_path),
        "habits": list_habits(include_archived=True, db_path=db_path),
    }

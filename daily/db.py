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

def _default_db_path() -> Path:
    env_path = os.environ.get("DAILY_DB_PATH", "").strip()
    if env_path:
        return Path(env_path).expanduser()
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "Daily" / "daily.db"
    xdg_data = os.environ.get("XDG_DATA_HOME", "").strip()
    if xdg_data:
        return Path(xdg_data).expanduser() / "daily" / "daily.db"
    return Path.home() / ".local" / "share" / "daily" / "daily.db"


DEFAULT_DB_PATH = _default_db_path()

VALID_KINDS = {"min", "max", "neutral", "measure"}
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


def _clean_scale_max(raw: Any, fallback: int = 5) -> int:
    try:
        v = int(round(float(raw)))
        return max(2, min(10, v))
    except Exception:
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
                kind TEXT NOT NULL DEFAULT 'neutral' CHECK(kind IN ('min', 'max', 'neutral', 'measure')),
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
                ('followup_enabled', '1'),
                ('task_nudges_enabled', '1');
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
        if "tap_step" not in hab_cols:
            conn.execute("ALTER TABLE habits ADD COLUMN tap_step REAL NOT NULL DEFAULT 1.0")
        if "group_name" not in hab_cols:
            conn.execute("ALTER TABLE habits ADD COLUMN group_name TEXT NOT NULL DEFAULT ''")
        conn.execute("UPDATE habits SET updated_at = created_at WHERE updated_at IS NULL")

        # Idempotent table rebuild for legacy SQLite DBs whose CHECK constraint predates kind='measure'
        h_sql_row = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'habits'").fetchone()
        if h_sql_row and "'measure'" not in str(h_sql_row[0] or ""):
            conn.commit()
            conn.execute("PRAGMA foreign_keys=OFF;")
            try:
                conn.execute("BEGIN")
                conn.execute(
                    """
                    CREATE TABLE habits__new (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL UNIQUE,
                        kind TEXT NOT NULL DEFAULT 'neutral' CHECK(kind IN ('min', 'max', 'neutral', 'measure')),
                        target REAL,
                        unit TEXT NOT NULL DEFAULT 'x',
                        color TEXT NOT NULL DEFAULT '#2563eb',
                        nudge_enabled INTEGER NOT NULL DEFAULT 0,
                        nudge_lead_min INTEGER NOT NULL DEFAULT 20,
                        nudge_alternatives TEXT NOT NULL DEFAULT '',
                        sort_order INTEGER NOT NULL DEFAULT 0,
                        archived INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL,
                        updated_at TEXT,
                        reminder_time TEXT NOT NULL DEFAULT '',
                        reminder_days TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
                        target_period TEXT NOT NULL DEFAULT 'day',
                        block_minutes INTEGER,
                        active_since TEXT,
                        tap_step REAL NOT NULL DEFAULT 1.0,
                        group_name TEXT NOT NULL DEFAULT ''
                    )
                    """
                )
                conn.execute(
                    """
                    INSERT INTO habits__new(
                        id, name, kind, target, unit, color, nudge_enabled, nudge_lead_min,
                        nudge_alternatives, sort_order, archived, created_at, updated_at,
                        reminder_time, reminder_days, target_period, block_minutes, active_since,
                        tap_step, group_name
                    )
                    SELECT
                        id, name, kind, target, unit, color, nudge_enabled, nudge_lead_min,
                        nudge_alternatives, sort_order, archived, created_at, updated_at,
                        reminder_time, reminder_days, target_period, block_minutes, active_since,
                        tap_step, group_name
                    FROM habits
                    """
                )
                conn.execute("DROP TABLE habits")
                conn.execute("ALTER TABLE habits__new RENAME TO habits")
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.execute("PRAGMA foreign_keys=ON;")

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
                scale_max INTEGER NOT NULL DEFAULT 5,
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
                scales_json TEXT NOT NULL DEFAULT '{}',
                causes_json TEXT NOT NULL DEFAULT '[]',
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_snapshots_occurred ON snapshots(occurred_at);

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                habit_id TEXT REFERENCES habits(id) ON DELETE SET NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                due_date TEXT NOT NULL DEFAULT '',
                blocked_by_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
                done_at TEXT,
                done_event_uuid TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_habit ON tasks(habit_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_blocker ON tasks(blocked_by_task_id);
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

        # Migrate legacy state_dimensions tables: add color, scale_max & updated_at and backfill calm defaults
        dim_cols = {r[1] for r in conn.execute("PRAGMA table_info(state_dimensions)").fetchall()}
        if "color" not in dim_cols:
            conn.execute("ALTER TABLE state_dimensions ADD COLUMN color TEXT NOT NULL DEFAULT ''")
        if "scale_max" not in dim_cols:
            conn.execute("ALTER TABLE state_dimensions ADD COLUMN scale_max INTEGER NOT NULL DEFAULT 5")
        if "updated_at" not in dim_cols:
            conn.execute("ALTER TABLE state_dimensions ADD COLUMN updated_at TEXT")
        conn.execute("UPDATE state_dimensions SET updated_at = created_at WHERE updated_at IS NULL")
        sn_cols = {r[1] for r in conn.execute("PRAGMA table_info(snapshots)").fetchall()}
        if "scales_json" not in sn_cols:
            conn.execute("ALTER TABLE snapshots ADD COLUMN scales_json TEXT NOT NULL DEFAULT '{}'")
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
        "task_nudges_enabled",
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
    unit: str | None = None,
    color: str = "#2563eb",
    nudge_enabled: bool = False,
    nudge_lead_min: int = 20,
    nudge_alternatives: str = "",
    reminder_time: str = "",
    reminder_days: str = "0,1,2,3,4,5,6",
    block_minutes: int | None = None,
    tap_step: float = 1.0,
    group_name: str = "",
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
    clean_step = round(max(0.01, min(1000.0, float(tap_step or 1.0))), 3)
    clean_group = str(group_name or "").strip()[:48]
    raw_unit = "" if unit is None else str(unit).strip()
    clean_unit = raw_unit if kind == "measure" else (raw_unit or "x")
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
            INSERT INTO habits(id, name, kind, target, target_period, unit, color, nudge_enabled, nudge_lead_min, nudge_alternatives, reminder_time, reminder_days, block_minutes, tap_step, group_name, active_since, sort_order, archived, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)
            """,
            (
                hid,
                clean_name,
                kind,
                target,
                clean_period,
                clean_unit,
                color.strip() or "#2563eb",
                1 if nudge_enabled else 0,
                max(5, min(180, int(nudge_lead_min))),
                nudge_alternatives.strip(),
                clean_rtime,
                clean_rdays,
                clean_block,
                clean_step,
                clean_group,
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
        "tap_step",
        "group_name",
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
        if k == "unit":
            v = str(v or "").strip()
        if k in {"nudge_enabled", "archived"}:
            v = 1 if bool(v) else 0
        if k == "nudge_lead_min":
            v = max(5, min(180, int(v)))
        if k == "block_minutes":
            v = max(1, min(720, int(v))) if v is not None and int(v) > 0 else None
        if k == "tap_step":
            v = round(max(0.01, min(1000.0, float(v or 1.0))), 3)
        if k == "group_name":
            v = str(v or "").strip()[:48]
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


def reorder_habits(
    habit_ids: list[str],
    group_updates: dict[str, str] | None = None,
    db_path: Path = DEFAULT_DB_PATH,
) -> list[dict[str, Any]]:
    """Persist explicit display order (and optional group reassignments) for habits."""
    ts = now_iso()
    g_map = group_updates or {}
    with get_conn(db_path) as conn:
        for idx, hid in enumerate(habit_ids):
            if hid in g_map:
                clean_g = str(g_map[hid] or "").strip()[:48]
                conn.execute(
                    "UPDATE habits SET sort_order = ?, group_name = ?, updated_at = ? WHERE id = ?",
                    (idx, clean_g, ts, hid),
                )
            else:
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
    scale_max: int = 5,
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    clean_name = name.strip()
    if not clean_name:
        raise ValueError("Name der Achse darf nicht leer sein")
    base_id = slugify(clean_name)
    clean_color = _clean_hex_color(color, DEFAULT_DIM_COLORS.get(base_id, "#3d6b7d"))
    clean_scale = _clean_scale_max(scale_max, 5)
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
            INSERT INTO state_dimensions(id, name, low_label, high_label, color, scale_max, sort_order, archived, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            """,
            (did, clean_name, low_label.strip(), high_label.strip(), clean_color, clean_scale, int(max_order) + 1, ts_now, ts_now),
        )
        row = conn.execute("SELECT * FROM state_dimensions WHERE id = ?", (did,)).fetchone()
    return dict(row)


def update_state_dimension(dim_id: str, fields: dict[str, Any], db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    allowed = {"name", "low_label", "high_label", "color", "scale_max", "archived", "sort_order"}
    sets: list[str] = []
    vals: list[Any] = []
    next_scale: int | None = None
    for k, v in fields.items():
        if k not in allowed:
            continue
        if k == "archived":
            v = 1 if bool(v) else 0
        elif k == "color":
            v = _clean_hex_color(str(v), DEFAULT_DIM_COLORS.get(dim_id, "#3d6b7d"))
        elif k == "scale_max":
            v = _clean_scale_max(v, 5)
            next_scale = v
        elif k in {"name", "low_label", "high_label"}:
            v = str(v).strip()
        sets.append(f"{k} = ?")
        vals.append(v)
    if not sets:
        raise ValueError("No valid fields to update")
    ts_now = now_iso()
    sets.append("updated_at = ?")
    vals.append(ts_now)
    vals.append(dim_id)
    rescaled_count = 0
    with get_conn(db_path) as conn:
        prev_row = conn.execute("SELECT * FROM state_dimensions WHERE id = ?", (dim_id,)).fetchone()
        if not prev_row:
            raise KeyError(f"State dimension not found: {dim_id}")
        old_scale = _clean_scale_max(prev_row["scale_max"] if "scale_max" in prev_row.keys() else 5, 5)
        conn.execute(f"UPDATE state_dimensions SET {', '.join(sets)} WHERE id = ?", vals)

        # Proportionally rescale all existing ratings for this axis when scale_max changes (idempotent via per-snapshot scales_json!)
        if next_scale is not None and next_scale != old_scale:
            sn_rows = conn.execute(
                "SELECT id, ratings_json, scales_json FROM snapshots WHERE deleted_at IS NULL AND ratings_json LIKE ?",
                (f'%"{dim_id}"%',),
            ).fetchall()
            for sr in sn_rows:
                try:
                    rmap = json.loads(sr["ratings_json"] or "{}")
                except Exception:
                    continue
                if dim_id not in rmap or rmap[dim_id] is None:
                    continue
                try:
                    smap = json.loads(sr["scales_json"] or "{}")
                    if not isinstance(smap, dict):
                        smap = {}
                except Exception:
                    smap = {}
                old_v = float(rmap[dim_id])
                has_recorded_scale = dim_id in smap and smap[dim_id] is not None
                src_scale = _clean_scale_max(smap[dim_id], old_scale) if has_recorded_scale else old_scale
                if src_scale == next_scale:
                    # Already stored on next_scale -> NEVER double-convert!
                    if not has_recorded_scale or smap.get(dim_id) != next_scale:
                        smap[dim_id] = next_scale
                        conn.execute(
                            "UPDATE snapshots SET scales_json = ? WHERE id = ?",
                            (json.dumps(smap, ensure_ascii=False), sr["id"]),
                        )
                    continue
                if not has_recorded_scale and old_v > float(old_scale):
                    # Legacy snapshot value already exceeds old_scale -> already on a larger scale; stamp without corrupting!
                    smap[dim_id] = max(next_scale, int(round(old_v)))
                    conn.execute(
                        "UPDATE snapshots SET scales_json = ?, updated_at = ? WHERE id = ?",
                        (json.dumps(smap, ensure_ascii=False), ts_now, sr["id"]),
                    )
                    continue
                norm = max(0.0, min(1.0, (old_v - 1.0) / float(max(1, src_scale - 1))))
                new_v = round(1.0 + norm * float(next_scale - 1), 2)
                rmap[dim_id] = max(1.0, min(float(next_scale), new_v))
                smap[dim_id] = next_scale
                conn.execute(
                    "UPDATE snapshots SET ratings_json = ?, scales_json = ?, updated_at = ? WHERE id = ?",
                    (json.dumps(rmap, ensure_ascii=False), json.dumps(smap, ensure_ascii=False), ts_now, sr["id"]),
                )
                rescaled_count += 1

        row = conn.execute("SELECT * FROM state_dimensions WHERE id = ?", (dim_id,)).fetchone()
    out = dict(row)
    if rescaled_count:
        out["rescaled_snapshots"] = rescaled_count
    return out


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
        raw_scales = json.loads(d.pop("scales_json", "{}") or "{}")
        d["scales"] = raw_scales if isinstance(raw_scales, dict) else {}
    except Exception:
        d["scales"] = {}
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
    clean_causes = [str(c).strip() for c in (causes or []) if str(c).strip()]
    clean_note = (note or "").strip()

    ts = occurred_at or now_iso()
    datetime.fromisoformat(ts)
    c_uuid = (client_uuid or "").strip() or uuid.uuid4().hex
    ts_now = now_iso()
    with get_conn(db_path) as conn:
        dim_scales = {
            r["id"]: _clean_scale_max(r["scale_max"], 5)
            for r in conn.execute("SELECT id, scale_max FROM state_dimensions").fetchall()
        }
        clean_ratings: dict[str, float] = {}
        clean_scales: dict[str, int] = {}
        for k, v in (ratings or {}).items():
            if v is None or v == "":
                continue
            val = float(v)
            s_max = int(dim_scales.get(str(k), 5))
            if 1.0 <= val <= float(s_max):
                clean_ratings[str(k)] = round(val, 2)
                clean_scales[str(k)] = s_max
        if not clean_ratings and not clean_note and not clean_causes:
            raise ValueError("Bitte mindestens einen Wert, eine Ursache oder eine Notiz eintragen")

        existing = conn.execute("SELECT * FROM snapshots WHERE client_uuid = ?", (c_uuid,)).fetchone()
        if existing:
            return _decode_snapshot(existing)
        cur = conn.execute(
            """
            INSERT INTO snapshots(client_uuid, occurred_at, ratings_json, scales_json, causes_json, note, created_at, updated_at, deleted_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                c_uuid,
                ts,
                json.dumps(clean_ratings, ensure_ascii=False),
                json.dumps(clean_scales, ensure_ascii=False),
                json.dumps(clean_causes, ensure_ascii=False),
                clean_note,
                ts_now,
                ts_now,
            ),
        )
        row = conn.execute("SELECT * FROM snapshots WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _decode_snapshot(row)


def update_snapshot(snapshot_id: int, fields: dict[str, Any], db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    with get_conn(db_path) as conn:
        cur_row = conn.execute("SELECT * FROM snapshots WHERE id = ? AND deleted_at IS NULL", (snapshot_id,)).fetchone()
        if not cur_row:
            raise KeyError(f"Snapshot not found: {snapshot_id}")
        cur_dec = _decode_snapshot(cur_row)
        dim_scales = {
            r["id"]: _clean_scale_max(r["scale_max"], 5)
            for r in conn.execute("SELECT id, scale_max FROM state_dimensions").fetchall()
        }

        ratings = cur_dec["ratings"]
        scales = dict(cur_dec.get("scales") or {})
        if "ratings" in fields and fields["ratings"] is not None:
            clean_ratings: dict[str, float] = {}
            clean_scales: dict[str, int] = {}
            for k, v in (fields["ratings"] or {}).items():
                if v is None or v == "":
                    continue
                val = float(v)
                s_max = int(dim_scales.get(str(k), 5))
                if 1.0 <= val <= float(s_max):
                    clean_ratings[str(k)] = round(val, 2)
                    clean_scales[str(k)] = s_max
            ratings = clean_ratings
            scales = clean_scales

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
            SET occurred_at = ?, ratings_json = ?, scales_json = ?, causes_json = ?, note = ?, updated_at = ?
            WHERE id = ? AND deleted_at IS NULL
            """,
            (
                occurred_at,
                json.dumps(ratings, ensure_ascii=False),
                json.dumps(scales, ensure_ascii=False),
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


# ---- Habit-Coupled One-Off Tasks ("Offene Zettel") with Optional Single-Step Blocker ----

def _clean_due_date(raw: Any) -> str:
    s = str(raw or "").strip()
    if not s:
        return ""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        raise ValueError(f"Ungültige Frist: {s} (Format YYYY-MM-DD)")
    date.fromisoformat(s)
    return s


def _check_task_cycle(conn: sqlite3.Connection, task_id: str | None, blocker_id: str | None) -> None:
    if not blocker_id:
        return
    if task_id and blocker_id == task_id:
        raise ValueError("Ein Zettel kann nicht auf sich selbst warten.")
    row = conn.execute("SELECT id, blocked_by_task_id, deleted_at FROM tasks WHERE id = ?", (blocker_id,)).fetchone()
    if not row or row["deleted_at"]:
        raise ValueError("Vorher-Zettel wurde nicht gefunden.")
    if not task_id:
        return
    seen: set[str] = {task_id}
    cur: str | None = blocker_id
    for _ in range(64):
        if not cur:
            break
        if cur in seen:
            raise ValueError("Zyklus erkannt: Dieser Zettel kann nicht indirekt auf sich selbst warten.")
        seen.add(cur)
        r = conn.execute("SELECT blocked_by_task_id, deleted_at FROM tasks WHERE id = ?", (cur,)).fetchone()
        if not r or r["deleted_at"]:
            break
        cur = r["blocked_by_task_id"]


def _enrich_tasks(rows: list[sqlite3.Row], conn: sqlite3.Connection) -> list[dict[str, Any]]:
    raw_list = [dict(r) for r in rows]
    by_id = {t["id"]: t for t in raw_list}
    habits_map = {
        r["id"]: dict(r)
        for r in conn.execute("SELECT id, name, color, unit, tap_step, archived FROM habits").fetchall()
    }
    blocks_counts: dict[str, int] = {}
    for t in raw_list:
        if t.get("deleted_at") or t.get("done_at"):
            continue
        bid = t.get("blocked_by_task_id")
        if bid and bid in by_id and not by_id[bid].get("deleted_at") and not by_id[bid].get("done_at"):
            blocks_counts[bid] = blocks_counts.get(bid, 0) + 1

    out: list[dict[str, Any]] = []
    for t in raw_list:
        bid = t.get("blocked_by_task_id")
        blocker = by_id.get(bid) if bid else None
        is_blocked = bool(
            not t.get("done_at")
            and blocker
            and not blocker.get("deleted_at")
            and not blocker.get("done_at")
        )
        h = habits_map.get(t.get("habit_id") or "")
        t["is_blocked"] = is_blocked
        t["blocker_title"] = blocker["title"] if (blocker and not blocker.get("deleted_at")) else ""
        t["blocks_count"] = blocks_counts.get(t["id"], 0)
        t["habit_name"] = h["name"] if h else ""
        t["habit_color"] = h["color"] if h else ""
        t["habit_unit"] = h["unit"] if h else "x"
        out.append(t)
    return out


def list_tasks(
    include_done: bool = True,
    include_deleted: bool = False,
    db_path: Path = DEFAULT_DB_PATH,
) -> list[dict[str, Any]]:
    with get_conn(db_path) as conn:
        if include_deleted:
            rows = conn.execute("SELECT * FROM tasks ORDER BY created_at ASC").fetchall()
        else:
            rows = conn.execute("SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at ASC").fetchall()
        enriched = _enrich_tasks(rows, conn)
    if not include_done:
        enriched = [t for t in enriched if not t.get("done_at")]
    # Sort actionable first: due_date soonest -> priority ("Bald") desc -> created_at asc
    enriched.sort(
        key=lambda t: (
            1 if t.get("done_at") else 0,
            1 if t.get("is_blocked") else 0,
            0 if t.get("due_date") else 1,
            t.get("due_date") or "9999-99-99",
            -int(t.get("priority") or 0),
            t.get("created_at") or "",
        )
    )
    return enriched


def create_task(
    title: str,
    habit_id: str | None = None,
    priority: int = 0,
    due_date: str = "",
    blocked_by_task_id: str | None = None,
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    clean_title = str(title or "").strip()[:180]
    if not clean_title:
        raise ValueError("Titel darf nicht leer sein")
    clean_due = _clean_due_date(due_date)
    clean_prio = 1 if int(priority or 0) > 0 else 0
    clean_hid = str(habit_id or "").strip() or None
    clean_bid = str(blocked_by_task_id or "").strip() or None
    tid = f"t-{uuid.uuid4().hex[:12]}"
    ts = now_iso()
    with get_conn(db_path) as conn:
        if clean_hid:
            if not conn.execute("SELECT 1 FROM habits WHERE id = ?", (clean_hid,)).fetchone():
                raise ValueError(f"Unbekanntes Habit: {clean_hid}")
        _check_task_cycle(conn, tid, clean_bid)
        conn.execute(
            """
            INSERT INTO tasks(id, title, habit_id, priority, due_date, blocked_by_task_id, done_at, done_event_uuid, created_at, updated_at, deleted_at)
            VALUES(?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)
            """,
            (tid, clean_title, clean_hid, clean_prio, clean_due, clean_bid, ts, ts),
        )
        rows = conn.execute("SELECT * FROM tasks WHERE deleted_at IS NULL").fetchall()
        enriched = _enrich_tasks(rows, conn)
    return next(t for t in enriched if t["id"] == tid)


def update_task(task_id: str, fields: dict[str, Any], db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    ts = now_iso()
    with get_conn(db_path) as conn:
        cur_row = conn.execute("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL", (task_id,)).fetchone()
        if not cur_row:
            raise KeyError(f"Task not found: {task_id}")
        sets: list[str] = []
        vals: list[Any] = []
        if "title" in fields and fields["title"] is not None:
            clean_title = str(fields["title"]).strip()[:180]
            if not clean_title:
                raise ValueError("Titel darf nicht leer sein")
            sets.append("title = ?")
            vals.append(clean_title)
        if "habit_id" in fields:
            clean_hid = str(fields["habit_id"] or "").strip() or None
            if clean_hid and not conn.execute("SELECT 1 FROM habits WHERE id = ?", (clean_hid,)).fetchone():
                raise ValueError(f"Unbekanntes Habit: {clean_hid}")
            sets.append("habit_id = ?")
            vals.append(clean_hid)
        if "priority" in fields and fields["priority"] is not None:
            sets.append("priority = ?")
            vals.append(1 if int(fields["priority"]) > 0 else 0)
        if "due_date" in fields and fields["due_date"] is not None:
            sets.append("due_date = ?")
            vals.append(_clean_due_date(fields["due_date"]))
        if "blocked_by_task_id" in fields:
            clean_bid = str(fields["blocked_by_task_id"] or "").strip() or None
            _check_task_cycle(conn, task_id, clean_bid)
            sets.append("blocked_by_task_id = ?")
            vals.append(clean_bid)
        if not sets:
            raise ValueError("Keine gültigen Felder zum Aktualisieren")
        sets.append("updated_at = ?")
        vals.append(ts)
        vals.append(task_id)
        conn.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", vals)
        rows = conn.execute("SELECT * FROM tasks WHERE deleted_at IS NULL").fetchall()
        enriched = _enrich_tasks(rows, conn)
    return next(t for t in enriched if t["id"] == task_id)


def complete_task(
    task_id: str,
    log_habit: bool = True,
    occurred_at: str | None = None,
    db_path: Path = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    ts = now_iso()
    with get_conn(db_path) as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL", (task_id,)).fetchone()
        if not row:
            raise KeyError(f"Task not found: {task_id}")
        t_dict = dict(row)
        already_done = bool(t_dict.get("done_at"))
        h_row = (
            conn.execute("SELECT * FROM habits WHERE id = ? AND archived = 0", (t_dict["habit_id"],)).fetchone()
            if t_dict.get("habit_id")
            else None
        )

    logged_event: dict[str, Any] | None = None
    ev_uuid = t_dict.get("done_event_uuid")
    if not already_done and log_habit and h_row is not None:
        step = float(h_row["tap_step"] or 1.0)
        logged_event = log_event(
            habit_id=h_row["id"],
            amount=step,
            occurred_at=occurred_at or ts,
            source="tap",
            note=t_dict["title"],
            db_path=db_path,
        )
        ev_uuid = logged_event.get("client_uuid")

    with get_conn(db_path) as conn:
        if not already_done:
            conn.execute(
                "UPDATE tasks SET done_at = ?, done_event_uuid = ?, updated_at = ? WHERE id = ?",
                (ts, ev_uuid, ts, task_id),
            )
        rows = conn.execute("SELECT * FROM tasks WHERE deleted_at IS NULL").fetchall()
        enriched = _enrich_tasks(rows, conn)

    done_task = next(t for t in enriched if t["id"] == task_id)
    unlocked = [
        t
        for t in enriched
        if t.get("blocked_by_task_id") == task_id and not t.get("done_at") and not t.get("is_blocked")
    ]
    return {"task": done_task, "event": logged_event, "unlocked": unlocked}


def reopen_task(task_id: str, db_path: Path = DEFAULT_DB_PATH) -> dict[str, Any]:
    ts = now_iso()
    with get_conn(db_path) as conn:
        cur = conn.execute(
            "UPDATE tasks SET done_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
            (ts, task_id),
        )
        if cur.rowcount == 0:
            raise KeyError(f"Task not found: {task_id}")
        rows = conn.execute("SELECT * FROM tasks WHERE deleted_at IS NULL").fetchall()
        enriched = _enrich_tasks(rows, conn)
    return next(t for t in enriched if t["id"] == task_id)


def delete_task(task_id: str, db_path: Path = DEFAULT_DB_PATH) -> None:
    ts = now_iso()
    with get_conn(db_path) as conn:
        cur = conn.execute(
            "UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
            (ts, ts, task_id),
        )
        if cur.rowcount == 0:
            raise KeyError(f"Task not found: {task_id}")
        # Unblock any children pointing to this deleted task cleanly
        conn.execute(
            "UPDATE tasks SET blocked_by_task_id = NULL, updated_at = ? WHERE blocked_by_task_id = ? AND deleted_at IS NULL",
            (ts, task_id),
        )

"""Standalone desktop launcher for Daily (used by compiled binaries, .deb/.rpm, and `python -m daily.launcher`)."""
from __future__ import annotations

import argparse
import os
import sys
import threading
import time
import urllib.request
import webbrowser

from daily import __version__
from daily.app import app
from daily.db import DEFAULT_DB_PATH


def _health_ok(url: str, timeout: float = 0.6) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/api/health", timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _open_browser_when_ready(url: str) -> None:
    for _ in range(40):
        if _health_ok(url, timeout=0.4):
            try:
                webbrowser.open(url)
            except Exception:
                pass
            return
        time.sleep(0.25)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="daily",
        description="Daily — Local-First Signed-Graph Habit Tracker & Liquid ODE",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("DAILY_HOST", "127.0.0.1"),
        help="Bind host (default: 127.0.0.1, or 0.0.0.0 for LAN)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("DAILY_PORT", "8090")),
        help="Bind port (default: 8090)",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        default=os.environ.get("DAILY_NO_BROWSER", "").strip().lower() in {"1", "true", "yes"},
        help="Do not automatically open the web browser",
    )
    parser.add_argument("--version", action="version", version=f"Daily {__version__}")
    args = parser.parse_args(argv)

    open_host = "127.0.0.1" if args.host in {"0.0.0.0", "::", ""} else args.host
    url = f"http://{open_host}:{args.port}"

    # If Daily is already running on this port (e.g. desktop icon clicked again), just open the UI
    if _health_ok(url):
        if not args.no_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        return 0

    if not args.no_browser:
        threading.Thread(target=_open_browser_when_ready, args=(url,), daemon=True).start()

    if sys.stdout is not None:
        print(f"Daily v{__version__} -> {url}  (DB: {DEFAULT_DB_PATH})", flush=True)

    import uvicorn

    # Avoid uvicorn TTY logging crashes in windowed/headless frozen binaries
    log_cfg = None if (sys.stdout is None or sys.stderr is None) else uvicorn.config.LOGGING_CONFIG
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level=os.environ.get("DAILY_LOG_LEVEL", "warning"),
        log_config=log_cfg,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

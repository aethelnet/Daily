#!/usr/bin/env python3
"""Build a self-contained single-file Daily desktop executable via PyInstaller.

Bundles Python runtime, FastAPI, Uvicorn, NumPy, Cryptography, Segno,
CPU XGBoost fallback, and static/ web UI so end users need zero pre-installed packages.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    sep = ";" if os.name == "nt" else ":"
    static_arg = f"{ROOT / 'static'}{sep}static"

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--onefile",
        "--clean",
        "--noconfirm",
        "--name",
        "daily",
        "--paths",
        str(ROOT),
        "--add-data",
        static_arg,
        "--collect-submodules",
        "xgboost",
        "--collect-binaries",
        "xgboost",
        "--collect-data",
        "xgboost",
        "--hidden-import",
        "scipy.sparse",
        "--hidden-import",
        "uvicorn.logging",
        "--hidden-import",
        "uvicorn.loops",
        "--hidden-import",
        "uvicorn.loops.auto",
        "--hidden-import",
        "uvicorn.loops.asyncio",
        "--hidden-import",
        "uvicorn.protocols",
        "--hidden-import",
        "uvicorn.protocols.http",
        "--hidden-import",
        "uvicorn.protocols.http.auto",
        "--hidden-import",
        "uvicorn.protocols.http.h11_impl",
        "--hidden-import",
        "uvicorn.protocols.websockets",
        "--hidden-import",
        "uvicorn.protocols.websockets.auto",
        "--hidden-import",
        "uvicorn.lifespan",
        "--hidden-import",
        "uvicorn.lifespan.on",
        "--hidden-import",
        "uvicorn.lifespan.off",
        "--hidden-import",
        "segno",
        "--exclude-module",
        "torch",
        "--exclude-module",
        "tabpfn",
        "--exclude-module",
        "sklearn",
        "--exclude-module",
        "matplotlib",
        "--exclude-module",
        "PIL",
        "--exclude-module",
        "tkinter",
        "--exclude-module",
        "nvidia",
        "--exclude-module",
        "cupy",
        "--exclude-module",
        "pytest",
        str(ROOT / "daily" / "launcher.py"),
    ]

    print("Running:", " ".join(cmd), flush=True)
    res = subprocess.run(cmd, cwd=str(ROOT))
    return res.returncode


if __name__ == "__main__":
    raise SystemExit(main())

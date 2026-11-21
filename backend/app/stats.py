"""Live system telemetry via psutil (+ nvidia-smi for NVIDIA GPUs)."""
from __future__ import annotations

import os
import subprocess
import time
from typing import Any

import psutil

# The first CPU reading is always 0; calling it once here makes later readings meaningful.
psutil.cpu_percent(interval=None)  # prime the counter

# nvidia-smi is slow, so its answer is reused for 2 seconds.
_gpu_cache: dict[str, Any] = {"t": 0.0, "v": None}
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


# NVIDIA GPU load, memory and temperature via nvidia-smi. Returns None when there is no NVIDIA GPU.
def _gpu() -> dict[str, Any] | None:
    now = time.time()
    if now - _gpu_cache["t"] < 2.0:
        return _gpu_cache["v"]
    value = None
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=3,
            creationflags=_NO_WINDOW,
        )
        if out.returncode == 0 and out.stdout.strip():
            name, util, used, total, temp = [p.strip() for p in out.stdout.strip().splitlines()[0].split(",")]
            value = {
                "name": name,
                "percent": float(util),
                "mem_used_mb": float(used),
                "mem_total_mb": float(total),
                "temp_c": float(temp) if temp.replace(".", "").isdigit() else None,
            }
    except Exception:
        value = None
    _gpu_cache.update(t=now, v=value)
    return value


# One snapshot of CPU, RAM, disk and GPU for the Health Scan panel.
def collect() -> dict[str, Any]:
    vm = psutil.virtual_memory()
    anchor = os.environ.get("SystemDrive", "C:") + "\\"
    try:
        du = psutil.disk_usage(anchor)
    except Exception:
        du = psutil.disk_usage(os.path.abspath(os.sep))
    return {
        "cpu": {"percent": psutil.cpu_percent(interval=None), "cores": psutil.cpu_count(logical=True)},
        "ram": {
            "percent": vm.percent,
            "used_gb": round(vm.used / 1024**3, 1),
            "total_gb": round(vm.total / 1024**3, 1),
        },
        "disk": {
            "percent": du.percent,
            "used_gb": round(du.used / 1024**3, 1),
            "total_gb": round(du.total / 1024**3, 1),
            "drive": anchor,
        },
        "gpu": _gpu(),
        "time": time.time(),
    }

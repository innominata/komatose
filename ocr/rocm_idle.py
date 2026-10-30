"""Stop a resident ROCm process from pinning a CPU core while the GPU is idle.

ROCm's AsyncEventsLoop busy-waits for the lifetime of a HIP context on this
runtime (ROCm 10 / PyTorch 2.13). hipDeviceScheduleBlockingSync makes that wait
sleep, but only if it is set before the context exists — before ``import torch``.
"""
import sys
from pathlib import Path

# hipDeviceScheduleBlockingSync
_BLOCKING_SYNC = 4
_LIB = "libamdhip64.so.7"


def arm_rocm_blocking_sync():
    import ctypes
    root = Path(sys.prefix)
    for path in root.glob(f"lib/python*/site-packages/_rocm_sdk_core/lib/{_LIB}"):
        try:
            lib = ctypes.CDLL(str(path))
        except OSError:
            continue
        if lib.hipSetDeviceFlags(_BLOCKING_SYNC) == 0:
            return

"""Bootstrap Hub downloads without installing packages into system Python."""
import importlib
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
HUB_REQUIREMENT = 'huggingface-hub==0.36.2'


def require_hub():
    try:
        return importlib.import_module('huggingface_hub')
    except ModuleNotFoundError as exc:
        if exc.name != 'huggingface_hub':
            raise
    python = Path(sys.executable)
    uv = shutil.which('uv')
    if sys.prefix == sys.base_prefix:
        # Download-only commands can also run before any inference environment exists.
        environment = ROOT / 'data/python-envs/model-downloads'
        python = environment / 'bin/python'
        if not python.is_file():
            command = ([uv, 'venv', '--python', sys.executable, str(environment)] if uv else
                       [sys.executable, '-m', 'venv', str(environment)])
            subprocess.run(command, check=True)
    print(f'Installing {HUB_REQUIREMENT} for model downloads', flush=True)
    if uv:
        command = [uv, 'pip', 'install', '--python', str(python), HUB_REQUIREMENT]
    else:
        subprocess.run([str(python), '-m', 'ensurepip', '--upgrade'], check=True)
        command = [str(python), '-m', 'pip', 'install', '--disable-pip-version-check', HUB_REQUIREMENT]
    subprocess.run(command, check=True, cwd=ROOT)
    if sys.prefix == sys.base_prefix:
        os.execv(str(python), [str(python), *sys.orig_argv[1:]])
    importlib.invalidate_caches()
    return importlib.import_module('huggingface_hub')

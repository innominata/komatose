"""Dependency bootstrap regression tests; no network or model downloads."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('model_download_deps', ROOT / 'scripts/model_download_deps.py')
deps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deps)


class DownloadDependencyTests(unittest.TestCase):
    def test_existing_hub_is_untouched(self):
        with patch.object(deps.importlib, 'import_module', return_value=object()) as load, patch.object(deps.subprocess, 'run') as run:
            self.assertIs(deps.require_hub(), load.return_value)
            run.assert_not_called()

    def test_uv_installs_into_selected_venv_without_pip(self):
        missing = ModuleNotFoundError(name='huggingface_hub')
        hub = object()
        with patch.object(deps.importlib, 'import_module', side_effect=[missing, hub]), patch.object(deps.sys, 'prefix', '/test/venv'), patch.object(deps.sys, 'base_prefix', '/system'), patch.object(deps.shutil, 'which', return_value='/bin/uv'), patch.object(deps.subprocess, 'run') as run:
            self.assertIs(deps.require_hub(), hub)
            self.assertEqual(run.call_args.args[0], ['/bin/uv', 'pip', 'install', '--python', sys.executable, deps.HUB_REQUIREMENT])

    def test_system_python_uses_isolated_environment_and_reexecutes(self):
        missing = ModuleNotFoundError(name='huggingface_hub')
        with patch.object(deps.importlib, 'import_module', side_effect=[missing, object()]), patch.object(deps.sys, 'prefix', '/system'), patch.object(deps.sys, 'base_prefix', '/system'), patch.object(deps.shutil, 'which', return_value=None), patch.object(deps.Path, 'is_file', return_value=False), patch.object(deps.subprocess, 'run') as run, patch.object(deps.os, 'execv') as execute:
            deps.require_hub()
            python = str(deps.ROOT / 'data/python-envs/model-downloads/bin/python')
            self.assertEqual(run.call_args.args[0][0], python)
            execute.assert_called_once_with(python, [python, *sys.orig_argv[1:]])

    def test_broken_transitive_dependency_is_not_hidden(self):
        with patch.object(deps.importlib, 'import_module', side_effect=ModuleNotFoundError(name='httpx')), patch.object(deps.subprocess, 'run') as run:
            with self.assertRaises(ModuleNotFoundError):
                deps.require_hub()
            run.assert_not_called()

    def test_cli_help_needs_no_hub(self):
        for name in ('clean-models', 'detect-models', 'review-models', 'image-edit-model', 'gemma4-model', 'native-package'):
            result = subprocess.run([sys.executable, '-S', str(ROOT / f'scripts/install-{name}.py'), '--help'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()

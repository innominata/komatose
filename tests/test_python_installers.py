"""Installer upgrade regressions without downloading wheels or modifying live environments."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('setup_env', ROOT / 'scripts/setup-python-env.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class EnvironmentUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.path = self.root / '.venv-workflow'
        (self.path / 'bin').mkdir(parents=True)
        (self.path / 'bin/python').touch()
        self.requirements = self.root / 'requirements.txt'
        self.requirements.write_text('onnxruntime==1.29.0\n')
        self.receipt = 'workflow\n' + hashlib.sha256(self.requirements.read_bytes()).hexdigest() + '\n'
        (self.path / setup.MARKER).write_text(self.receipt)
        spec = dict(setup.ENVS['workflow'], dir=self.path, requirements='requirements.txt')
        for mock in (patch.object(setup, 'ROOT', self.root),
                     patch.dict(setup.ENVS, workflow=spec)):
            mock.start()
            self.addCleanup(mock.stop)

    def run_setup(self, gpu_onnx=False, variant='auto', torch='rocm', uv='/usr/bin/uv'):
        with patch('sys.argv', ['setup', '--env', 'workflow', '--torch', variant]), \
             patch.object(setup, 'gpu_onnx_installed', return_value=gpu_onnx), \
             patch.object(setup, 'installed_torch_variant', return_value=torch), \
             patch.object(setup.shutil, 'which', return_value=uv), \
             patch.object(setup, 'run') as run, patch.object(setup, 'install') as install:
            setup.main()
            return run, install

    def test_current_environment_is_unchanged(self):
        run, install = self.run_setup()
        run.assert_not_called()
        install.assert_not_called()

    def test_gpu_onnx_is_removed_and_cpu_files_repaired_despite_current_receipt(self):
        run, install = self.run_setup(gpu_onnx=True)
        commands = [call.args[0] for call in run.call_args_list]
        self.assertIn('uninstall', commands[0])
        self.assertIn('onnxruntime-migraphx', commands[0])
        self.assertIn('--reinstall-package', commands[1])
        self.assertIn('onnxruntime', commands[1])
        self.assertEqual(install.call_count, 1)

    def test_pip_cleanup_also_repairs_cpu_files(self):
        run, _ = self.run_setup(gpu_onnx=True, uv=None)
        repair = run.call_args_list[-1].args[0]
        self.assertIn('--force-reinstall', repair)
        self.assertIn('onnxruntime==1.29.0', repair)

    def test_explicit_rocm_replaces_cpu_torch(self):
        _, install = self.run_setup(variant='rocm', torch='cpu')
        wheel = install.call_args_list[0]
        self.assertEqual(wheel.args[1], ['torch', 'torchvision'])
        self.assertTrue(wheel.kwargs['reinstall'])
        self.assertEqual(wheel.kwargs['index_url'], setup.TORCH_INDEXES['rocm'])

    def test_changed_requirements_upgrade_without_replacing_torch(self):
        self.requirements.write_text('onnxruntime==1.29.0\ntransformers==4.57.6\n')
        _, install = self.run_setup()
        self.assertEqual(install.call_count, 1)
        self.assertEqual(install.call_args.args[1], ['-r', str(self.requirements)])
        self.assertNotEqual((self.path / setup.MARKER).read_text(), self.receipt)

    def test_missing_torch_is_repaired_despite_current_receipt(self):
        with patch.object(setup, 'detect_torch_variant', return_value='rocm'):
            _, install = self.run_setup(torch='missing')
        self.assertEqual(install.call_args_list[0].args[1], ['torch', 'torchvision'])


if __name__ == '__main__':
    unittest.main()

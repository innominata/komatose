"""Hardware selection and transactional upgrade regressions, without downloads."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('setup_env', ROOT / 'scripts/setup-python-env.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
import torch_profiles as profiles


def hardware(amd=(), nvidia=()):
    return {'system': 'Linux', 'machine': 'x86_64', 'amd': list(amd), 'nvidia': list(nvidia)}


def amd(arch, integrated=False, accessible=True):
    return {'arch': arch, 'integrated': integrated, 'accessible': accessible}


class ProfileTests(unittest.TestCase):
    def test_cpu_without_usable_driver(self):
        self.assertEqual(profiles.plan(hardware=hardware(), environ={})['profile'], 'cpu')
        with patch.object(profiles.subprocess, 'run', side_effect=subprocess.TimeoutExpired('probe', 8)):
            self.assertEqual(profiles.output(['nvidia-smi']), '')

    def test_two_cards_one_pack_and_apu_excluded(self):
        p = profiles.plan(hardware=hardware([amd('gfx1100'), amd('gfx1100'), amd('gfx1036', True)]), environ={})
        self.assertEqual(p['architectures'], ['gfx1100'])
        self.assertIn('device-gfx1100', p['packages'][0])
        self.assertNotIn('device-all', ' '.join(p['packages']))
        self.assertNotIn('devel', ' '.join(p['packages']))

    def test_multiple_physical_arches_and_explicit_integrated(self):
        p = profiles.plan('rocm', 'gfx1201,gfx1100,gfx1201', hardware=hardware(), environ={})
        self.assertEqual(p['architectures'], ['gfx1100', 'gfx1201'])
        self.assertIn('device-gfx1100,device-gfx1201', p['packages'][0])
        p = profiles.plan('rocm', 'gfx1036', hardware=hardware([amd('gfx1036', True)]), environ={})
        self.assertEqual(p['architectures'], ['gfx1036'])

    def test_unqualified_or_inaccessible_amd_falls_back_without_all_arch_download(self):
        for cards in [[amd('gfx1100', accessible=False)], [amd('gfx1201')], [amd('gfx1036', True)]]:
            self.assertEqual(profiles.plan(hardware=hardware(cards), environ={})['variant'], 'cpu')

    def test_nvidia_driver_and_compute_capability(self):
        def nv(cap, driver): return {'capability': cap, 'driver': driver}
        for cards, expected in [([nv(8.9, '580.65.06')], 'cu130'), ([nv(6.1, '580.65.06')], 'cu126'),
                                ([nv(8.9, '560.35.05')], 'cu126'), ([nv(8.9, '550.1')], 'cpu'),
                                ([nv(3.5, '580.65.06')], 'cpu'), ([nv(12.0, '570.1')], 'cpu'),
                                ([nv(12.0, '580.65.06')], 'cu130'), ([nv(8.9, 'unknown')], 'cpu')]:
            self.assertEqual(profiles.plan(hardware=hardware(nvidia=cards), environ={})['profile'], expected)
        with self.assertRaises(ValueError):
            profiles.plan('cuda', hardware=hardware(), environ={})

    def test_custom_index_and_cpu_override_are_preserved(self):
        p = profiles.plan('rocm', hardware=hardware(), environ={'SCAN_TORCH_INDEX': 'https://example.invalid/wheels'})
        self.assertEqual(p['profile'], 'custom-rocm')
        self.assertEqual(p['index'], 'https://example.invalid/wheels')
        self.assertEqual(profiles.plan('cpu', hardware=hardware([amd('gfx1100')]), environ={})['variant'], 'cpu')
        with self.assertRaises(ValueError):
            profiles.plan('rocm', 'gfx1100;anything', hardware=hardware(), environ={})

    def test_sysfs_discovery_uses_physical_target_not_hsa_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            node = root / 'class/kfd/kfd/topology/nodes/1'
            node.mkdir(parents=True)
            (node / 'properties').write_text('vendor_id 4098\ngfx_target_version 110000\ndrm_render_minor 129\n')
            gpu = root / 'class/drm/renderD129/device'
            gpu.mkdir(parents=True)
            (gpu / 'mem_info_vram_total').write_text(str(24 * 1024**3))
            with patch.object(profiles, 'output', return_value=''), patch.object(profiles.os, 'access', return_value=True):
                self.assertEqual(profiles.discover(root)['amd'][0]['arch'], 'gfx1100')


class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.external = self.root / 'external'
        (self.external / 'bin').mkdir(parents=True)
        (self.external / 'bin/python').touch()
        self.path = self.root / '.venv-workflow'
        self.path.symlink_to(self.external)
        self.requirements = self.root / 'requirements.txt'
        self.requirements.write_text('onnxruntime==1.29.0\n')
        self.receipt = 'workflow\n' + hashlib.sha256(self.requirements.read_bytes()).hexdigest() + '\n'
        (self.path / setup.MARKER).write_text(self.receipt)
        env = dict(setup.ENVS['workflow'], dir=self.path, requirements='requirements.txt')
        for mock in (patch.object(setup, 'ROOT', self.root), patch.dict(setup.ENVS, workflow=env),
                     patch.dict(os.environ, {}, clear=True),
                     patch.object(setup, 'torch_plan', return_value=profiles.plan('cpu', hardware=hardware(), environ={}))):
            mock.start(); self.addCleanup(mock.stop)

    def main(self, *args, gpu_onnx=False):
        with patch('sys.argv', ['setup', '--env', 'workflow', *args]), \
             patch.object(setup, 'gpu_onnx_installed', return_value=gpu_onnx), \
             patch.object(setup, 'installed_torch_variant', return_value='rocm'), \
             patch.object(setup, 'install_generation') as install, \
             patch.object(setup.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout='["2.12.0+rocm7.1","0.27.0+rocm7.1"]')):
            setup.main()
            return install

    def test_legacy_is_idempotent_until_explicit_upgrade(self):
        self.main().assert_not_called()
        self.main('--upgrade-runtime').assert_called_once()

    def test_plan_is_read_only_and_preserves_external_target(self):
        with patch.object(setup, 'installed_torch_variant', side_effect=AssertionError('plan imported torch')):
            result = setup.environment_plan('workflow')
        self.assertTrue(result['legacyReceipt'])
        self.assertTrue(result['externalTarget'])
        self.assertTrue(result['upgradeAvailable'])
        self.assertEqual(self.path.resolve(), self.external)

    def test_configured_interpreter_cannot_be_changed(self):
        os.environ['SCAN_WORKFLOW_PYTHON'] = str(self.external / 'bin/python')
        self.assertFalse(setup.environment_plan('workflow')['upgradeAvailable'])
        with self.assertRaises(SystemExit):
            self.main('--upgrade-runtime')

    def test_dotenv_interpreter_and_architecture_overrides_are_respected(self):
        (self.root / '.env').write_text('SCAN_WORKFLOW_PYTHON="/outside/bin/python"\nSCAN_TORCH_ARCHES="gfx1100,gfx1201"\n')
        setup.load_configuration()
        self.assertEqual(os.environ['SCAN_WORKFLOW_PYTHON'], '/outside/bin/python')
        self.assertEqual(os.environ['SCAN_TORCH_ARCHES'], 'gfx1100,gfx1201')
        with self.assertRaises(SystemExit):
            self.main('--upgrade-runtime')

    def test_gpu_onnx_repair_is_a_clean_generation(self):
        installer = self.main(gpu_onnx=True)
        installer.assert_called_once()
        self.assertEqual(installer.call_args.args[1]['profile'], 'legacy-rocm')
        self.assertEqual((self.external / setup.MARKER).read_text(), self.receipt)

    def create(self, path):
        (path / 'bin').mkdir()
        (path / 'bin/python').touch()

    def build(self, failure=None, drained=False, stage=False):
        selected = profiles.plan('cpu', hardware=hardware(), environ={})
        fake = subprocess.CompletedProcess([], 0, stdout='torch==2.12.1+cpu\ntorchvision==0.27.1+cpu\n')
        frozen = subprocess.CompletedProcess([], 0, stdout='{"torch":"2.12.1+cpu"}')
        with patch.object(setup, 'create_venv', side_effect=self.create), patch.object(setup, 'install'), \
             patch.object(setup.subprocess, 'run', side_effect=[fake, frozen]), \
             patch.object(setup, 'validate', side_effect=failure, return_value={'passed': True}), \
             patch.object(setup, 'validate_models', return_value={'passed': True, 'models': []}):
            return setup.install_generation('workflow', selected, drained, stage)

    def test_failed_validation_preserves_old_link_and_removes_candidate(self):
        with self.assertRaises(RuntimeError):
            self.build(RuntimeError('FFT failed'))
        self.assertEqual(self.path.resolve(), self.external)
        self.assertEqual(list(setup.generation_root().glob('workflow-*')), [])

    def test_success_keeps_external_target_and_permanent_shebang_location(self):
        self.build(drained=True)
        candidate = self.path.resolve()
        self.assertTrue(setup.owned_generation(candidate, 'workflow'))
        self.assertTrue(self.external.exists())
        self.assertEqual((candidate / setup.MARKER).read_text(), self.receipt)
        receipt = json.loads((candidate / setup.RECEIPT).read_text())
        self.assertTrue(receipt['validation']['passed'])
        self.assertNotIn('torchaudio', receipt['versions'])
        self.build(drained=True)
        self.assertFalse(candidate.exists())

    def test_real_legacy_directory_is_atomically_replaced_and_preserved(self):
        self.path.unlink()
        self.path.mkdir()
        (self.path / 'bin').mkdir()
        (self.path / 'bin/python').touch()
        (self.path / 'original-file').write_text('keep me')
        self.build(drained=True)
        self.assertTrue(self.path.is_symlink())
        backups = list(self.root.glob('.venv-workflow.legacy-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / 'original-file').read_text(), 'keep me')

    def test_cleanup_failure_cannot_delete_activated_generation(self):
        self.build()
        old = self.path.resolve()
        real_rmtree = setup.shutil.rmtree
        def cleanup(path, *args, **kwargs):
            if path == old:
                raise PermissionError('old files are busy')
            return real_rmtree(path, *args, **kwargs)
        with patch.object(setup.shutil, 'rmtree', side_effect=cleanup):
            self.build(drained=True)
        self.assertNotEqual(self.path.resolve(), old)
        self.assertTrue((self.path / setup.RECEIPT).is_file())
        self.assertTrue(old.exists())

    def test_configured_translation_interpreter_in_old_generation_is_preserved(self):
        self.build()
        old = self.path.resolve()
        os.environ['SCAN_TRANSLATION_PYTHON'] = str(old / 'bin/python')
        self.build(drained=True)
        self.assertTrue(old.exists())
        self.assertNotEqual(self.path.resolve(), old)

    def test_without_drain_or_with_stage_only_old_environment_is_kept(self):
        self.build()
        original = self.path.resolve()
        self.build(stage=True)
        self.assertEqual(self.path.resolve(), original)
        self.assertTrue(original.exists())
        self.build()
        self.assertTrue(original.exists())

    def test_cancellation_and_activation_failure_roll_back(self):
        with self.assertRaises(KeyboardInterrupt):
            self.build(KeyboardInterrupt())
        with patch.object(setup.os, 'replace', side_effect=OSError('activation failed')):
            with self.assertRaises(OSError):
                self.build()
        self.assertEqual(self.path.resolve(), self.external)
        self.assertEqual(list(setup.generation_root().glob('workflow-*')), [])

    def test_ownership_rejects_symlink_outside_managed_root(self):
        (self.external / setup.OWNER).write_text(f'{self.root.resolve()}\nworkflow\n')
        self.assertFalse(setup.owned_generation(self.external, 'workflow'))
        self.assertFalse(setup.owned_generation(self.path, 'workflow'))

    def test_pip_installs_use_same_pins_and_constraints(self):
        with patch.object(setup.shutil, 'which', return_value=None), patch.object(setup, 'run') as run:
            setup.install(Path('/tmp/env/bin/python'), ['torch==2.12.1+cpu'], index_url=profiles.TORCH_INDEXES['cpu'], constraints=Path('/tmp/pins'))
        self.assertIn('--index-url', run.call_args.args[0])
        self.assertEqual(run.call_args.args[0][-2:], ['-c', '/tmp/pins'])


if __name__ == '__main__':
    unittest.main()

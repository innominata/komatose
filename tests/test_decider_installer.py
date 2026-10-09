"""Pinned artifact verification and interrupted-download recovery without network/GPU."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('decider_installer', Path(__file__).parents[1] / 'scripts/install-decider.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

class Response(io.BytesIO):
    status = 200
    headers = {}

class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.payload = b'quantized fixture'
        self.sha = hashlib.sha256(self.payload).hexdigest()
        self.models = patch.object(installer, 'MODELS', self.path)
        self.models.start()
        self.addCleanup(self.models.stop)

    def download(self):
        installer.download('test.gguf', len(self.payload), self.sha)

    def test_verified_install_is_idempotent(self):
        with patch.object(installer.urllib.request, 'urlopen', return_value=Response(self.payload)) as get:
            self.download()
            self.download()
            self.assertEqual(get.call_count, 1)
        self.assertEqual((self.path / 'test.gguf').read_bytes(), self.payload)

    def test_resumes_exact_range(self):
        (self.path / 'test.gguf.part').write_bytes(self.payload[:5])
        response = Response(self.payload[5:])
        response.status = 206
        response.headers = {'Content-Range': f'bytes 5-{len(self.payload)-1}/{len(self.payload)}'}
        with patch.object(installer.urllib.request, 'urlopen', return_value=response) as get:
            self.download()
            self.assertEqual(get.call_args.args[0].get_header('Range'), 'bytes=5-')
        self.assertEqual((self.path / 'test.gguf').read_bytes(), self.payload)

    def test_ignored_range_restarts_without_appending(self):
        (self.path / 'test.gguf.part').write_bytes(b'wrong')
        with patch.object(installer.urllib.request, 'urlopen', return_value=Response(self.payload)):
            self.download()
        self.assertEqual((self.path / 'test.gguf').read_bytes(), self.payload)

    def test_checksum_failure_never_installs_or_marks_complete(self):
        with patch.object(installer.time, 'sleep'), patch.object(installer.urllib.request, 'urlopen', side_effect=lambda *a, **k: Response(b'x' * len(self.payload))):
            with self.assertRaisesRegex(RuntimeError, 'SHA256'):
                self.download()
        self.assertFalse((self.path / 'test.gguf').exists())
        self.assertFalse((self.path / 'installed.json').exists())

    def test_completed_partial_is_promoted_without_network(self):
        (self.path / 'test.gguf.part').write_bytes(self.payload)
        with patch.object(installer.urllib.request, 'urlopen') as get:
            self.download()
            get.assert_not_called()
        self.assertEqual((self.path / 'test.gguf').read_bytes(), self.payload)

    def test_cancellation_propagates_and_leaves_no_receipt(self):
        with patch.object(installer.urllib.request, 'urlopen', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.download()
        self.assertFalse((self.path / 'installed.json').exists())

if __name__ == '__main__':
    unittest.main()

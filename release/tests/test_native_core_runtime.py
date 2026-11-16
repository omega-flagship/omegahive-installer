"""Native Hive adapters: symbolic persistence and authorization through PeTTa."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PETTA = os.environ.get('HIVE_TEST_PETTA')
CHROMA = os.environ.get('HIVE_TEST_CHROMADB_LIB')


@unittest.skipUnless(PETTA and CHROMA, 'set HIVE_TEST_PETTA and HIVE_TEST_CHROMADB_LIB')
class NativeCoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'repos').mkdir()
        (self.root / 'repos/OmegaClaw-Core').symlink_to(ROOT)
        (self.root / 'repos/petta_lib_chromadb').symlink_to(Path(CHROMA).resolve())
        from hive.runtime.native_core import prepare
        prepare(ROOT)

    def run_metta(self, body, channel='native-test'):
        program = self.root / 'run.metta'
        program.write_text('''!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (library OmegaClaw-Core lib_omegaclaw))
!(hive-initLoop)
!(hive-initMemory)
!(configure commchannel native-test)
''' + body)
        env = dict(os.environ, embeddingprovider='OpenAI', commchannel=channel,
                   OMEGACLAW_MEMORY_DIR=str(self.root / 'memory'))
        result = subprocess.run(['sh', str(Path(PETTA) / 'run.sh'), str(program), '--silent'],
                                cwd=self.root, env=env, text=True, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('ERROR:', result.stderr, result.stderr)
        return result.stdout

    def test_symbolic_space_survives_a_process_restart(self):
        self.run_metta('''!(hive-run-response "belief-claim smoke-domain sky blue 0.8 0.9")
!(hive-cycle-end)
''')
        saved = (self.root / 'memory/beliefs.metta').read_text()
        self.assertIn('smoke-domain', saved)
        output = self.run_metta('!(println! (beliefs-for "smoke-domain"))\n')
        self.assertIn('sky', output)
        self.assertIn('0.8', output)
        self.assertIn('0.9', output)
        self.assertIn('blue', output)

    def test_authorization_precedes_symbolic_mutation(self):
        (self.root / 'deny.py').write_text("import hive_commons\nhive_commons.authorize = lambda command: 'DENIED-SMOKE'\n")
        output = self.run_metta('''!(import! &self ./deny.py)
!(hive-run-response "belief-claim smoke-denied sky blue 0.8 0.9")
!(hive-cycle-end)
''', channel='hive')
        self.assertIn('DENIED-SMOKE', output)
        self.assertNotIn('smoke-denied', (self.root / 'memory/beliefs.metta').read_text())

    def test_upstream_file_io_and_shell_keep_hive_safety(self):
        destination = self.root / 'native-file.txt'
        output = self.run_metta(f'!(println! (write-file "{destination}" "native core"))\n'
                                '!(println! (shell "echo native-shell"))\n'
                                '!(println! (shell "rm should-not-run"))\n')
        self.assertEqual(destination.read_text(), 'native core')
        self.assertIn('WRITE-VERIFIED', output)
        self.assertIn('native-shell', output)
        self.assertIn('SHELL-RISK', output)

    def test_upstream_vector_memory_survives_restart(self):
        (self.root / 'embedding_stub.py').write_text('import rag\nrag.cloud_embed = lambda text: [1.0, 0.0, 0.0]\n')
        self.run_metta('!(import! &self ./embedding_stub.py)\n!(remember "native-vector-proof")\n')
        output = self.run_metta('!(import! &self ./embedding_stub.py)\n!(println! (query "native-vector-proof"))\n')
        self.assertIn('native-vector-proof', output)

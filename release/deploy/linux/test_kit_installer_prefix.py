"""Joined kit/installer contract tests; require the pinned R7 installer successor.

The admitted test stage must place the reviewed install.py beside this file.
There is no older-installer fallback, skipped case or runtime package import.
"""
import copy
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location('joined_' + name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


kit = load('build_kit')
installer = load('install')
PREFIX = 'source-root'
MODULES = {'deploy/linux/install.py': b'# synthetic installer\n',
           'deploy/linux/control.py': b'# synthetic control\n',
           'deploy/linux/serve.py': b'# synthetic serve\n',
           'deploy/linux/omegahive.service.in': b'[Service]\n'}


def row(name, body=b''):
    return {'path': name, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'mode': '100644'}


def module_tree():
    return kit.git_tree([(name, '100644', hashlib.sha1(b'blob ' + str(len(body)).encode() + b'\0' + body).hexdigest())
                         for name, body in MODULES.items()])


def payload(variant=None):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w:gz') as archive:
        for index, (name, body) in enumerate(MODULES.items()):
            if variant == 'missing' and index == 0:
                continue
            prefix = 'other-root' if variant == 'wrong-prefix' else PREFIX
            member = tarfile.TarInfo(prefix + '/' + name); member.mode = 0o644
            if variant == 'link' and index == 0:
                member.type = tarfile.SYMTYPE; member.linkname = 'outside'
                archive.addfile(member)
            else:
                member.size = len(body); archive.addfile(member, io.BytesIO(body))
        if variant == 'extra-directory':
            member = tarfile.TarInfo(PREFIX + '/unlisted'); member.type = tarfile.DIRTYPE
            archive.addfile(member)
    return out.getvalue()


def release_catalogue(rows):
    modules = [row(name, body) for name, body in MODULES.items()]
    artifact = {'url': 'https://github.com/publisher/releases/download/fixture/runtime.tar.gz',
                'bytes': 1, 'sha256': 'a' * 64}
    platform = {name: dict(artifact) for name in ('uv', 'python', 'swipl_source', 'petta_source')}
    platform.update(core_lock={'path': 'core.lock', 'bytes': 1, 'sha256': 'b' * 64},
                    build_lock={'path': 'build.lock', 'bytes': 1, 'sha256': 'b' * 64},
                    source_payload={'path': 'source.tar.gz', 'prefix': PREFIX, 'files': rows,
                                    'bytes': 1, 'sha256': 'b' * 64})
    return {'schema': 'studio-linux-user-release/2', 'ready': True, 'release_id': 'synthetic-release',
            'source_revision': '1' * 40, 'source_tree': '2' * 40, 'petta_commit': '3' * 40,
            'min_free_bytes': 5 * 1024**3,
            'core_roots': ['fastapi', 'uvicorn', 'httpx', 'websockets', 'pytest', 'pillow'],
            'python_version': '3.12.1', 'uv_version': '1.0.0', 'swipl_version': '9.0.0',
            'ui_prebuilt': {'archive': {'path': 'ui.tar.gz', 'bytes': 1, 'sha256': 'f' * 64},
                            'manifest': {'path': 'ui.manifest.json', 'bytes': 1, 'sha256': 'e' * 64},
                            'source_revision': '4' * 40, 'source_tree': '5' * 40},
            'platforms': {'x86_64': copy.deepcopy(platform), 'aarch64': copy.deepcopy(platform)},
            'apps': [{'id': name, 'path': name + '.zip', 'prefix': name + '/1', 'bytes': 1,
                      'sha256': 'c' * 64, 'digest': 'sha256:' + 'd' * 64, 'files': [row('plugin.json', b'{}')]}
                     for name in ('omegaassist', 'omegadesign')],
            'bootstrap': {name: {'path': name + '.json', 'bytes': 1, 'sha256': 'e' * 64} for name in ('helper', 'seed')},
            'module_files': modules, 'default_model': 'openrouter/example/model',
            'embedding_model': 'mock/hash', 'ssh_target': None}


class SharedPrefixTests(unittest.TestCase):
    def test_same_prefixed_bytes_match_tree_and_materialize_root_relative_modules(self):
        rows = [row(name, body) for name, body in MODULES.items()]
        raw = payload(); original_sha = hashlib.sha256(raw).hexdigest()
        prefix = kit.source_prefix({'prefix': PREFIX}, PREFIX)
        kit.inspect_source(raw, prefix, rows, module_tree(), [])
        with tempfile.TemporaryDirectory() as name:
            base = Path(name); archive = base / 'source.tar.gz'; archive.write_bytes(raw)
            installer.extract_source(archive, base / 'app', rows, prefix)
            for path, body in MODULES.items():
                self.assertEqual((base / 'app' / path).read_bytes(), body)
            self.assertFalse((base / 'app' / PREFIX).exists())
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), original_sha)

    def test_wrong_prefix_extra_directory_link_and_missing_file_fail_on_both_sides(self):
        rows = [row(name, body) for name, body in MODULES.items()]
        for variant in ('wrong-prefix', 'extra-directory', 'link', 'missing'):
            raw = payload(variant)
            with self.subTest(variant=variant), self.assertRaises(kit.Refused):
                kit.inspect_source(raw, PREFIX, rows, module_tree(), [])
            with self.subTest(installer_variant=variant), tempfile.TemporaryDirectory() as name:
                base = Path(name); archive = base / 'source.tar.gz'; archive.write_bytes(raw)
                with self.assertRaises(installer.Refused):
                    installer.extract_source(archive, base / 'app', rows, PREFIX)

    def test_common_source_count_accepts_5000_and_refuses_5001(self):
        rows = [row(name, body) for name, body in MODULES.items()]
        rows += [row('synthetic/file-' + str(i)) for i in range(5000 - len(rows))]
        self.assertEqual(len(kit.source_rows(rows)), 5000)
        installer.validate_catalogue(release_catalogue(rows))
        rows.append(row('synthetic/one-extra'))
        with self.assertRaises(kit.Refused):
            kit.source_rows(rows)
        with self.assertRaises(installer.Refused):
            installer.validate_catalogue(release_catalogue(rows))


if __name__ == '__main__':
    unittest.main()

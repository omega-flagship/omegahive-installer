"""Purpose: the one signature rule of Mac release updates, shared by update.py (on each hive) and publish-update.py (on
the release machine): Ed25519 (RFC 8032) over the UTF-8 bytes of the canonical JSON (RFC 8785) of
{"mac_release": statement} for a release statement and {"mac_rotation": rotation} for a key rotation, signatures as 128
lowercase hex and public keys as 64, through OpenSSL's libcrypto, as omegahive-core signs its events
(docs/architecture.md 3.11, clients/python/omegahive_client.py).

The wrapping object's name keeps each kind of signature from passing for the other, or for any other signed object of
ours: a key that signs a rotation has not thereby signed a release, nor the other way round.
"""
import ctypes
import ctypes.util
import hashlib
import json
import os
import pathlib
import sys

SHAPE = "mac_release"
ROTATION = "mac_rotation"
# An Ed25519 private key as PKCS #8 DER is this prefix and the 32-byte seed (RFC 8410 section 7); omegahive-core key
# files hold it base64-encoded as pkcs8_b64, beside name and pubkey.
PKCS8_ED25519 = bytes.fromhex("302e020100300506032b657004220420")
NID_ED25519 = 1087      # EVP_PKEY_ED25519 in OpenSSL's obj_mac.h


def canonical(value):
    """RFC 8785 for the values a statement holds: objects with keys sorted by UTF-16 code units, arrays, strings,
    integers within 2**53 - 1, true, false and null, no whitespace. A float refuses, since a statement holds none."""
    if value is None or isinstance(value, bool):
        return json.dumps(value)
    if isinstance(value, int):
        if abs(value) > 2 ** 53 - 1:
            raise ValueError(f"{value} is beyond the integers JSON carries exactly")
        return str(value)
    if isinstance(value, str):
        value.encode("utf-8")                      # a lone surrogate raises here
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical(value[k]) for k in keys) + "}"
    raise ValueError(f"{type(value).__name__} has no place in a release statement")


def message(value, shape=SHAPE):
    """The exact bytes a signature covers: a release statement's by default, a key rotation's with shape=ROTATION."""
    return canonical({shape: value}).encode("utf-8")


# Finder writes .DS_Store into a folder its owner opens, and macOS's own zips carry __MACOSX; neither is the release's.
TREE_SKIP = (".DS_Store",)


def _tree_hash(items):
    """sha256 over one line per file or symbolic link, in byte order of its path below the release's top folder:
    "f <x> <sha256> <path>" for a file, x 1 when any execute bit is set, and "l <target> <path>" for a link.
    Folders are left out, so the top folder's own name ("Omega Hive", "Omega Hive 2") never counts."""
    lines = [f"f {int(x)} {value} {rel}" if kind == "f" else f"l {value} {rel}"
             for rel, kind, value, x in sorted(items, key=lambda item: item[0].encode())]
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def tree_digest_of_zip(path):
    """The tree digest of a release zip, read from its entries without unpacking. Time: one sha256 pass over the
    unpacked bytes (about 250 MB for a release)."""
    import stat
    import zipfile
    items = []
    with zipfile.ZipFile(path) as zf:
        tops = {name.split("/", 1)[0] for name in zf.namelist()}
        if len(tops) != 1:
            raise ValueError(f"{path} has {len(tops)} top-level entries, not one release folder")
        for info in zf.infolist():
            rel = info.filename.split("/", 1)[1] if "/" in info.filename else ""
            if info.is_dir() or not rel or rel.startswith("__MACOSX/") or rel.rsplit("/", 1)[-1] in TREE_SKIP:
                continue
            mode, data = info.external_attr >> 16, zf.read(info)
            if stat.S_ISLNK(mode):
                items.append((rel, "l", data.decode(), False))
            else:
                items.append((rel, "f", hashlib.sha256(data).hexdigest(), bool(mode & 0o111)))
    return _tree_hash(items)


def tree_digest_of_dir(root):
    """The tree digest of an unpacked release folder (Safari unzips a download itself and keeps only the folder).
    Time: one sha256 pass over its files."""
    import stat
    items = []
    for folder, dirs, files in os.walk(root):
        for name in dirs + files:
            path = os.path.join(folder, name)
            info = os.lstat(path)
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            if name in TREE_SKIP or rel.startswith("__MACOSX/"):
                continue
            if stat.S_ISLNK(info.st_mode):
                items.append((rel, "l", os.readlink(path), False))
            elif stat.S_ISREG(info.st_mode):
                digest = hashlib.sha256()
                with open(path, "rb") as f:
                    for chunk in iter(lambda: f.read(1 << 20), b""):
                        digest.update(chunk)
                items.append((rel, "f", digest.hexdigest(), bool(info.st_mode & 0o111)))
    return _tree_hash(items)


def _libcrypto():
    """OpenSSL 3's libcrypto: in the base Python installation first (the hive's toolchain, including when called from
    its venv), then wherever the loader finds it (the release machine)."""
    for name in ("libcrypto.3.dylib", "libcrypto.so.3"):
        here = pathlib.Path(sys.base_prefix) / "lib" / name
        if here.exists():
            return ctypes.CDLL(str(here))
    found = ctypes.util.find_library("crypto")
    if not found:
        raise RuntimeError("no OpenSSL libcrypto to check Ed25519 signatures with")
    return ctypes.CDLL(found)


_LIB = None


def _lib():
    global _LIB
    if _LIB is None:
        lib = _libcrypto()
        for fn in ("EVP_PKEY_new_raw_private_key", "EVP_PKEY_new_raw_public_key", "EVP_MD_CTX_new"):
            getattr(lib, fn).restype = ctypes.c_void_p
        lib.EVP_PKEY_new_raw_private_key.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]
        lib.EVP_PKEY_new_raw_public_key.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]
        lib.EVP_PKEY_get_raw_public_key.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_size_t)]
        lib.EVP_PKEY_free.argtypes = [ctypes.c_void_p]
        lib.EVP_MD_CTX_free.argtypes = [ctypes.c_void_p]
        lib.EVP_DigestSignInit.argtypes = [ctypes.c_void_p] * 5
        lib.EVP_DigestVerifyInit.argtypes = [ctypes.c_void_p] * 5
        lib.EVP_DigestSign.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_char_p,
                                       ctypes.c_size_t]
        lib.EVP_DigestVerify.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p, ctypes.c_size_t]
        _LIB = lib
    return _LIB


def verify(pubkey_hex, sig_hex, data):
    """True only for a valid Ed25519 signature by pubkey_hex over data; any malformed input is False."""
    try:
        key, sig = bytes.fromhex(pubkey_hex), bytes.fromhex(sig_hex)
    except (TypeError, ValueError):
        return False
    if len(key) != 32 or len(sig) != 64:
        return False
    lib = _lib()
    pkey = lib.EVP_PKEY_new_raw_public_key(NID_ED25519, None, key, 32)
    if not pkey:
        return False
    ctx = lib.EVP_MD_CTX_new()
    try:
        return (lib.EVP_DigestVerifyInit(ctx, None, None, None, pkey) == 1
                and lib.EVP_DigestVerify(ctx, sig, 64, data, len(data)) == 1)
    finally:
        lib.EVP_MD_CTX_free(ctx)
        lib.EVP_PKEY_free(pkey)


class Signer:
    """An Ed25519 private key from its 32-byte seed."""

    def __init__(self, seed):
        lib = _lib()
        self._pkey = lib.EVP_PKEY_new_raw_private_key(NID_ED25519, None, seed, len(seed))
        if not self._pkey:
            raise RuntimeError("libcrypto refused the Ed25519 key")
        size, out = ctypes.c_size_t(32), ctypes.create_string_buffer(32)
        if lib.EVP_PKEY_get_raw_public_key(self._pkey, out, ctypes.byref(size)) != 1:
            raise RuntimeError("libcrypto could not derive the Ed25519 public key")
        self.pubkey_hex = out.raw[:size.value].hex()

    def sign(self, data):
        lib, ctx = _lib(), _lib().EVP_MD_CTX_new()
        try:
            size, out = ctypes.c_size_t(64), ctypes.create_string_buffer(64)
            if (lib.EVP_DigestSignInit(ctx, None, None, None, self._pkey) != 1
                    or lib.EVP_DigestSign(ctx, out, ctypes.byref(size), data, len(data)) != 1):
                raise RuntimeError("libcrypto refused to sign")
            return out.raw[:size.value].hex()
        finally:
            lib.EVP_MD_CTX_free(ctx)

    def __del__(self):
        if getattr(self, "_pkey", None):
            _lib().EVP_PKEY_free(self._pkey)


def load_key_file(path):
    """An omegahive-core key file, {"name", "pubkey", "pkcs8_b64"}, as a Signer whose public key must match."""
    import base64
    data = json.loads(pathlib.Path(path).read_text())
    der = base64.b64decode(data["pkcs8_b64"])
    if len(der) != 48 or not der.startswith(PKCS8_ED25519):
        raise ValueError(f"{path} does not hold an Ed25519 PKCS #8 key")
    signer = Signer(der[16:])
    if signer.pubkey_hex != data["pubkey"]:
        raise ValueError(f"{path}: pubkey does not match its private key")
    return signer


def new_key_file(path, name):
    """Write a fresh key file readable by its owner alone and return its public key."""
    import base64
    seed = os.urandom(32)
    signer = Signer(seed)
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump({"name": name, "pubkey": signer.pubkey_hex,
                   "pkcs8_b64": base64.b64encode(PKCS8_ED25519 + seed).decode()}, out)
        out.write("\n")
    return signer.pubkey_hex

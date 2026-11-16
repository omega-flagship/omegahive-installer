"""Local host/evaluator MAC receipts; authenticated bytes do not prove custody.

Keys are host-provisioned, shared with the evaluator, never supplied in exports.
This is not a public-key signature or third-party non-repudiation protocol.
"""
import hashlib
import hmac
import json
import sqlite3
import threading
from .protocol import digest, pin, seal, validate_export

SCHEMA = 'omegabench-receipt/1'
PINS = ('baseline_pin', 'candidate_pin', 'evaluator_pin', 'dataset_pin', 'environment_pin')
FIELDS = {'schema', 'issuer', 'key_id', 'run_id', 'swarm_id', 'benchmark_id',
          'registration_pin', 'export_digest', 'custody_manifest_pin', *PINS}


def _bytes(payload):
    return json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def _key(key):
    if not isinstance(key, bytes) or len(key) < 32:
        raise ValueError('host-provisioned key of at least 32 bytes required')
    return key


def issue(registration, export, *, issuer, key_id, key, run_id, swarm_id,
          benchmark_id, custody_manifest_pin):
    registration_pin = seal(registration)
    validate_export(registration, registration_pin, export)
    payload = dict(schema=SCHEMA, issuer=issuer, key_id=key_id, run_id=run_id,
                   swarm_id=swarm_id, benchmark_id=benchmark_id,
                   registration_pin=registration_pin, export_digest=digest(export),
                   custody_manifest_pin=custody_manifest_pin,
                   **{field: registration[field] for field in PINS})
    _shape(payload)
    return {'payload': payload, 'mac': hmac.new(_key(key), _bytes(payload), hashlib.sha256).hexdigest()}


def _shape(payload):
    if not isinstance(payload, dict) or set(payload) != FIELDS or payload['schema'] != SCHEMA:
        raise ValueError('unsupported receipt payload')
    for field in ('issuer', 'key_id', 'run_id', 'swarm_id', 'benchmark_id'):
        if not isinstance(payload[field], str) or not payload[field].strip() or len(payload[field]) > 200:
            raise ValueError('bounded receipt identity required')
    for field in (*PINS, 'registration_pin', 'export_digest', 'custody_manifest_pin'):
        if not pin(payload[field]):
            raise ValueError('receipt SHA256 binding required')


class ReceiptVerifier:
    """Host-only trusted-key configuration and durable idempotent receipt ledger.

    A run can be admitted once. Identical retry returns its existing receipt;
    differing bytes for the same issuer/run are refused across swarms/restarts.
    Revocation is durable and checked even for an already admitted receipt.
    """
    def __init__(self, path, trusted_keys):
        self._keys = {identity: _key(key) for identity, key in trusted_keys.items()}
        if any(not isinstance(identity, tuple) or len(identity) != 2 for identity in self._keys):
            raise ValueError('issuer/key-id trust mapping required')
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute('CREATE TABLE IF NOT EXISTS receipts (issuer TEXT, run TEXT, digest TEXT, PRIMARY KEY(issuer,run))')
        self._db.execute('CREATE TABLE IF NOT EXISTS revoked (issuer TEXT, key_id TEXT, PRIMARY KEY(issuer,key_id))')
        self._db.commit()

    def close(self):
        self._db.close()

    def revoke(self, issuer, key_id):
        with self._lock, self._db:
            self._db.execute('INSERT OR IGNORE INTO revoked VALUES (?,?)', (issuer, key_id))

    def admit(self, packet, registration, export, *, swarm_id, benchmark_id):
        if not isinstance(packet, dict) or set(packet) != {'payload', 'mac'}:
            raise ValueError('receipt envelope required')
        payload, mac = packet['payload'], packet['mac']
        _shape(payload)
        if not pin(mac):
            raise ValueError('receipt MAC required')
        key = self._keys.get((payload['issuer'], payload['key_id']))
        if key is None or not hmac.compare_digest(mac, hmac.new(key, _bytes(payload), hashlib.sha256).hexdigest()):
            raise PermissionError('untrusted receipt issuer or MAC')
        registration_pin = seal(registration)
        validate_export(registration, registration_pin, export)
        expected = dict(registration_pin=registration_pin, export_digest=digest(export),
                        swarm_id=swarm_id, benchmark_id=benchmark_id,
                        **{field: registration[field] for field in PINS})
        if any(payload[field] != value for field, value in expected.items()):
            raise ValueError('receipt context or evidence binding mismatch')
        receipt_digest = digest(packet)
        with self._lock, self._db:
            self._db.execute('BEGIN IMMEDIATE')
            if self._db.execute('SELECT 1 FROM revoked WHERE issuer=? AND key_id=?',
                                (payload['issuer'], payload['key_id'])).fetchone():
                raise PermissionError('receipt key revoked')
            # SQLite serializes admission across separate verifier processes too.
            self._db.execute('INSERT OR IGNORE INTO receipts VALUES (?,?,?)',
                             (payload['issuer'], payload['run_id'], receipt_digest))
            previous = self._db.execute('SELECT digest FROM receipts WHERE issuer=? AND run=?',
                                        (payload['issuer'], payload['run_id'])).fetchone()[0]
            if previous != receipt_digest:
                raise ValueError('run identifier reused with different receipt')
        return {'receipt_digest': receipt_digest, 'issuer': payload['issuer'],
                'key_id': payload['key_id'], 'run_id': payload['run_id'],
                'custody_manifest_pin': payload['custody_manifest_pin'],
                'transport': 'authenticated-local-mac', 'custody': 'unverified',
                'independent_review': 'pending', 'candidate_evaluated': False,
                'adoption_authorized': False}

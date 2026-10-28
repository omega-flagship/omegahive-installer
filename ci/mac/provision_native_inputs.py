"""Disabled data-only producer for the closed native worker input binding.

This producer reads fixed role files as data, hashes held bytes before JSON
parsing, and writes one exclusive input JSON. It does not execute or admit the
native worker; owner, derivative, job, preparation and resource gates remain
unbound until separately approved.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import stat
import sys


ROOT = Path("/private/tmp/omegahive-ci-r12")
JOB = ROOT / "runtime-job"
HERE = ROOT / "native-source"
OUTPUT = HERE / "NATIVE_BUILD_INPUTS_R1.json"
FAILURE_OUTPUT = HERE / "NATIVE_INPUT_PRODUCER_FAILURE_R1.json"
OWNER_ADMISSION_PATH = HERE / "NATIVE_INPUT_OWNER_ADMISSION_R1.json"

SCHEMA = "studio-Mac-CI-native-phase-inputs/1"
INPUTS_MAX = 256 * 1024
ROLE_MAX = 32 * 1024**2
JSON_MAX = 8 * 1024**2

# Disabled native worker prototype from the reviewed R2 source manifest. This
# is not an executable worker identity and is never reused as an approved
# bound-worker derivative pin.
DISABLED_WORKER_PROTOTYPE = {
    "bytes": 29155,
    "sha256": "9184ce506a6be23537743f6197683f937dae37ac6697956946bd2aea35327264",
}
BOOTSTRAP_PYTHON_PIN = {
    "bytes": 18652104,
    "sha256": "aed8ed802d0387d6831dead5885840e4e2ff3a7984dd7297e9a5f4466e9cda1d",
}
RECIPE_PIN = {
    "bytes": 7104,
    "sha256": "450e6486a468fbdfbcf8b335152cdcb1806b804ead9b87f849b0257fa4c0c709",
}
CONTRACT_PIN = {
    "bytes": 63647,
    "sha256": "68cba00c3851717fd82b59992939fba361b1bba2eab73b1d85a35a9193ae7842",
}

# All admission fields are deliberately unresolved in this candidate. A future
# owner-reviewed edit must bind them to the exact current job, worker
# derivative, fresh R6 preparation receipt/inventory, Source review, resource
# decision and current task set. A digest alone does not grant that approval.
PRODUCER_ENABLED = False
EXPECTED_UID = None
SOURCE_OWNER = None
ORIGIN_MACHINE = None
APPROVED_BOUND_WORKER_PIN = None
FRESH_PREPARATION_RECEIPT_PIN = None
PREPARED_INVENTORY_PIN = None


class Refused(RuntimeError):
    pass


def need(condition, reason):
    if not condition:
        raise Refused(reason)


def file_key(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def directory_identity(path, *, owner_uid, private=False):
    path = Path(path)
    need(path.is_absolute() and path == path.resolve(), "canonical_directory_required")
    for ancestor in reversed((path, *path.parents)):
        info = ancestor.lstat()
        need(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode),
             "plain_directory_ancestry_required")
    info = path.lstat()
    need(info.st_uid == owner_uid, "directory_owner_required")
    if private:
        need(stat.S_IMODE(info.st_mode) == 0o700, "private_directory_required")
    return [info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode)]


def read_regular(path, *, maximum, owner_uid, expected=None):
    path = Path(path)
    directory_identity(path.parent, owner_uid=owner_uid)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
             and before.st_uid == owner_uid and 0 < before.st_size <= maximum,
             "bounded_owned_regular_input_required")
        if expected is not None:
            need(before.st_size == expected["bytes"], "input_size_pin_mismatch")
        chunks, digest, size = [], hashlib.sha256(), 0
        while True:
            block = os.read(fd, 65536)
            if not block:
                break
            size += len(block)
            need(size <= maximum, "input_growth_bound")
            chunks.append(block)
            digest.update(block)
        after = os.fstat(fd)
        need(size == before.st_size and file_key(before) == file_key(after)
             and file_key(after) == file_key(path.lstat()), "input_changed_during_read")
        raw = b"".join(chunks)
        pin = {"path": str(path), "bytes": size, "sha256": digest.hexdigest()}
        if expected is not None:
            need(pin["sha256"] == expected["sha256"], "input_digest_pin_mismatch")
        return raw, pin
    finally:
        os.close(fd)


def write_new(path, raw, *, owner_uid, mode=0o400):
    path = Path(path)
    directory_identity(path.parent, owner_uid=owner_uid, private=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            need(count > 0, "short_output_write")
            view = view[count:]
        os.fsync(fd)
        os.fchmod(fd, mode)
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == owner_uid and info.st_nlink == 1
             and info.st_size == len(raw) and file_key(info) == file_key(path.lstat()),
             "exclusive_output_identity_mismatch")
    finally:
        os.close(fd)
    return {"path": str(path), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def json_bytes(value, maximum=INPUTS_MAX):
    raw = (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")
    need(len(raw) <= maximum, "JSON_output_bound")
    return raw


def validate_static_gates(args):
    need(PRODUCER_ENABLED is True, "DISABLED_native_input_producer")
    need(type(EXPECTED_UID) is int and EXPECTED_UID > 0
         and os.getuid() == os.geteuid() == EXPECTED_UID,
         "positive_exact_owner_UID_required")
    need(type(SOURCE_OWNER) is str and 1 <= len(SOURCE_OWNER) <= 128
         and type(ORIGIN_MACHINE) is str and 1 <= len(ORIGIN_MACHINE) <= 128,
         "owner_and_origin_attribution_required")
    need(type(APPROVED_BOUND_WORKER_PIN) is dict
         and set(APPROVED_BOUND_WORKER_PIN) == {"bytes", "sha256"}
         and type(APPROVED_BOUND_WORKER_PIN["bytes"]) is int
         and 0 < APPROVED_BOUND_WORKER_PIN["bytes"] <= ROLE_MAX
         and re.fullmatch(r"[a-f0-9]{64}", APPROVED_BOUND_WORKER_PIN["sha256"])
         and APPROVED_BOUND_WORKER_PIN["sha256"] != DISABLED_WORKER_PROTOTYPE["sha256"],
         "separately_reviewed_bound_worker_derivative_required")
    for name, pin, maximum in (("fresh_preparation", FRESH_PREPARATION_RECEIPT_PIN, 2 * 1024**2),
                               ("prepared_inventory", PREPARED_INVENTORY_PIN, JSON_MAX)):
        need(type(pin) is dict and set(pin) == {"bytes", "sha256"}
             and type(pin["bytes"]) is int and 0 < pin["bytes"] <= maximum
             and re.fullmatch(r"[a-f0-9]{64}", pin["sha256"]),
             name + "_identity_pin_required")
    need(re.fullmatch(r"[a-f0-9]{64}", args.source_sha256 or ""),
         "producer_source_pin_required")
    need(type(args.owner_admission_bytes) is int and 0 < args.owner_admission_bytes <= 64 * 1024
         and re.fullmatch(r"[a-f0-9]{64}", args.owner_admission_sha256 or ""),
         "external_owner_admission_pin_required")


def validate_owner_admission(admission, job_identity, producer_source_sha256):
    fields = {"schema", "approval", "source_owner", "origin_machine", "expected_uid", "job_path",
              "job_identity", "bound_worker_sha256", "preparation_receipt_sha256",
              "producer_source_sha256", "prepared_inventory_sha256", "source_review_sha256",
              "source_review_verdict", "source_review_blocking_findings", "resource_context_sha256",
              "current_tasks_sha256", "resource_decision"}
    need(type(admission) is dict and set(admission) == fields
         and admission.get("schema") == "studio-Mac-CI-native-input-owner-admission/1"
         and admission.get("approval") == "OWNER_ADMITTED_INPUT_BINDING_ONLY"
         and admission.get("source_owner") == SOURCE_OWNER
         and admission.get("origin_machine") == ORIGIN_MACHINE
         and admission.get("expected_uid") == EXPECTED_UID
         and admission.get("job_path") == str(JOB)
         and type(job_identity) is list and admission.get("job_identity") == job_identity
         and admission.get("bound_worker_sha256") == APPROVED_BOUND_WORKER_PIN["sha256"]
         and admission.get("producer_source_sha256") == producer_source_sha256
         and admission.get("source_review_verdict") in {"PASS_SOURCE_ONLY", "SHIP_SOURCE_ONLY"}
         and admission.get("source_review_blocking_findings") == []
         and admission.get("preparation_receipt_sha256") == FRESH_PREPARATION_RECEIPT_PIN["sha256"]
         and admission.get("prepared_inventory_sha256") == PREPARED_INVENTORY_PIN["sha256"]
         and admission.get("resource_decision") == "run",
         "owner_approval_for_derivative_job_and_resource_context_required")
    for name in ("source_review_sha256", "resource_context_sha256", "current_tasks_sha256"):
        need(re.fullmatch(r"[a-f0-9]{64}", admission.get(name, "")),
             "owner_approval_pin_missing_" + name)


def expected_role_rows():
    return {
        "worker": (HERE / "ci_native_worker.py", APPROVED_BOUND_WORKER_PIN, EXPECTED_UID),
        "python": (JOB / "bootstrap/python/bin/python3.12", BOOTSTRAP_PYTHON_PIN, EXPECTED_UID),
        "ps": (Path("/bin/ps"), None, 0),
        "bash": (Path("/bin/bash"), None, 0),
        "recipe": (JOB / "native-runtime-phases.sh", RECIPE_PIN, EXPECTED_UID),
        "preparation": (JOB / "CI_PREPARATION_RECEIPT_R1.json",
                        FRESH_PREPARATION_RECEIPT_PIN, EXPECTED_UID),
        "contract": (ROOT / "runtime-source/PUBLIC_RUNTIME_INPUTS_R4.json",
                     CONTRACT_PIN, EXPECTED_UID),
        "prepared_inventory": (JOB / "PREPARED_SOURCE_INVENTORIES_R1.json",
                               PREPARED_INVENTORY_PIN, EXPECTED_UID),
    }


def produce_binding(owner_admission, producer_source_sha256):
    root_identity = directory_identity(ROOT, owner_uid=EXPECTED_UID, private=True)
    job_identity = directory_identity(JOB, owner_uid=EXPECTED_UID, private=True)
    here_identity = directory_identity(HERE, owner_uid=EXPECTED_UID, private=True)
    validate_owner_admission(owner_admission, job_identity, producer_source_sha256)
    need(not os.path.lexists(OUTPUT), "fresh_exclusive_native_inputs_output_required")

    preparation_raw, preparation_pin = read_regular(
        JOB / "CI_PREPARATION_RECEIPT_R1.json", maximum=2 * 1024**2,
        owner_uid=EXPECTED_UID, expected=FRESH_PREPARATION_RECEIPT_PIN)
    preparation = json.loads(preparation_raw)
    need(type(preparation) is dict
         and preparation.get("schema") == "studio-Mac-CI-public-runtime-preparation/2"
         and preparation.get("status") == "DATA_PREPARATION_ONLY_NO_NATIVE_ACTION"
         and preparation.get("contract_sha256") == CONTRACT_PIN["sha256"],
         "fresh_R6_preparation_receipt_required")

    inventory_raw, inventory_pin = read_regular(
        JOB / "PREPARED_SOURCE_INVENTORIES_R1.json", maximum=8 * 1024**2,
        owner_uid=EXPECTED_UID, expected=PREPARED_INVENTORY_PIN)
    inventory = json.loads(inventory_raw)
    need(type(inventory) is dict
         and set(inventory) == {"python", "swipl", "petta", "chroma", "pcre2"},
         "closed_prepared_source_inventory_required")

    roles = {}
    for name, (path, expected, owner_uid) in expected_role_rows().items():
        if name in ("preparation", "prepared_inventory"):
            # Reuse the exact held JSON bytes already pinned and parsed above;
            # do not reopen either JSON role between verification and binding.
            raw, pin = ((preparation_raw, preparation_pin) if name == "preparation"
                        else (inventory_raw, inventory_pin))
        else:
            raw, pin = read_regular(path, maximum=ROLE_MAX, owner_uid=owner_uid,
                                    expected=expected)
        roles[name] = pin

    need(directory_identity(ROOT, owner_uid=EXPECTED_UID, private=True) == root_identity
         and directory_identity(JOB, owner_uid=EXPECTED_UID, private=True) == job_identity
         and directory_identity(HERE, owner_uid=EXPECTED_UID, private=True) == here_identity,
         "native_input_source_directory_identity_changed")
    binding = {"schema": SCHEMA, "source_owner": SOURCE_OWNER,
               "origin_machine": ORIGIN_MACHINE, "job_path": str(JOB),
               "roles": roles,
               "scope": "Exact owner-bound native worker inputs only; no execution authority or native qualification."}
    output_raw = json_bytes(binding)
    output_pin = write_new(OUTPUT, output_raw, owner_uid=EXPECTED_UID, mode=0o400)
    return output_pin


def write_failure(error, owner_admission, producer_source_sha256):
    if (PRODUCER_ENABLED is not True or EXPECTED_UID is None
            or type(owner_admission) is not dict):
        return None
    try:
        job_identity = directory_identity(JOB, owner_uid=EXPECTED_UID, private=True)
        validate_owner_admission(owner_admission, job_identity, producer_source_sha256)
    except BaseException:
        return None
    failure = {"schema": "studio-Mac-CI-native-input-producer-failure/1",
               "status": "FAILED_RETAINED_NO_RETRY", "native_action": False,
               "reason": str(error) if isinstance(error, Refused) else type(error).__name__,
               "qualification": "NONE"}
    try:
        return write_new(FAILURE_OUTPUT, json_bytes(failure, maximum=16 * 1024),
                         owner_uid=EXPECTED_UID, mode=0o400)
    except BaseException:
        return None


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--owner-admission-bytes", required=True, type=int)
    parser.add_argument("--owner-admission-sha256", required=True)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    owner_admission = None
    try:
        need(args.run, "explicit_run_switch_required")
        # Static disabled/identity/pin gates precede all target role reads.
        validate_static_gates(args)
        raw, _pin = read_regular(__file__, maximum=128 * 1024,
                                 owner_uid=EXPECTED_UID)
        need(hashlib.sha256(raw).hexdigest() == args.source_sha256, "producer_source_pin_mismatch")
        admission_raw, _admission_pin = read_regular(
            OWNER_ADMISSION_PATH, maximum=64 * 1024, owner_uid=EXPECTED_UID,
            expected={"bytes": args.owner_admission_bytes, "sha256": args.owner_admission_sha256})
        owner_admission = json.loads(admission_raw)
        result = produce_binding(owner_admission, args.source_sha256)
        print(json.dumps({"status": "NATIVE_INPUT_BINDING_WRITTEN", "output": result["path"]}), flush=True)
        return 0
    except BaseException as error:
        write_failure(error, owner_admission, args.source_sha256)
        raise


if __name__ == "__main__":
    raise SystemExit(main())

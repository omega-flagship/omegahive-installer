"""Start one SCRATCH OmegaCode service from a release tree, for the live-service contract tests only.

Usage: python omegacode_scratch_service.py CONFIG.json

The config names the release folder (the one that contains the omegacode package), a scratch data root, the free
loopback port, the scratch hive URL, an invented operator token and a one-time enrolment token from that scratch hive.
This is the same composition as the release's own __main__ (ServiceLock owner, Service, enrolment, purpose app), but it
binds the given scratch port: the release entry point pins 127.0.0.1:8724, which belongs to the live service and is
never used by tests. Nothing in the release tree is modified.
"""
import json
import pathlib
import sys


def main(config_path):
    config = json.loads(pathlib.Path(config_path).read_text())
    sys.path.insert(0, config["release"])
    import uvicorn
    from omegacode.purpose_startup import create_purpose_app
    from omegacode.registration import enrol
    from omegacode.service import Service
    from omegacode.service_lock import ServiceLock

    root = pathlib.Path(config["data_root"])
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    owner = ServiceLock(root)
    service = Service(root.resolve(), config["operator_token"], config["repositories"], config["hive_url"], owner=owner)
    if config.get("copy_effect_policy_scratch"):
        # SCRATCH ONLY. The release has no copy-effect policy adapter in production, so Code refuses every automatic
        # application (503 copy_effect_policy_unavailable). For the contract test of the person's Apply, this scratch
        # service gets a minimal owner-policy stand-in: an application whose every edit keeps file content is
        # non-deleting; anything else stays unresolved. Never installed by any real launcher.
        def non_deleting_only(binding, edits):
            if edits and all(isinstance(e, dict) and e.get("content") is not None for e in edits):
                return {"binding": binding, "classification": "non_deleting"}
            return {"binding": binding, "classification": "unresolved"}
        service.copy_effect_policy = non_deleting_only
    if service.authority.registration is None:
        enrol(service.authority, service.store.root, config["enrol_token"], config["port"])
    app = create_purpose_app(service, config["port"], sandbox_enabled=bool(config.get("sandbox_project_tests_enabled")))
    uvicorn.run(app, host="127.0.0.1", port=config["port"], access_log=False, log_level="warning")


if __name__ == "__main__":
    main(sys.argv[1])

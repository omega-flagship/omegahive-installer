"""Start one SCRATCH OmegaCode service from a release tree, for the live-service contract tests only.

Usage: python omegacode_scratch_service.py CONFIG.json

The config names the release folder (the one that contains the omegacode package), a scratch data root, the free
loopback port, the scratch hive URL, an invented operator token and a one-time enrolment token from that scratch hive.
This is the same composition as the release's own __main__ (ServiceLock owner, Service, copy-effect policy from the
config, enrolment, purpose app), but it binds the given scratch port: the release entry point pins 127.0.0.1:8724,
which belongs to the live service and is never used by tests. Nothing in the release tree is modified.
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
    # The release's own copy-effect (deletion) policy switch, exactly as its __main__ reads it: the config key
    # "copy_effect_policy" names the production adapter (omegacode.copy_effect_owner_policy) or is absent (no adapter:
    # every automatic application is refused 503 copy_effect_policy_unavailable). No test stand-in exists any more.
    from omegacode import copy_effect_owner_policy
    copy_effect_policy = copy_effect_owner_policy.configured(config)
    service = Service(root.resolve(), config["operator_token"], config["repositories"], config["hive_url"], owner=owner)
    if copy_effect_policy:
        copy_effect_owner_policy.install(service)
    if service.authority.registration is None:
        enrol(service.authority, service.store.root, config["enrol_token"], config["port"])
    # The sandbox purpose plane is b6283f46's create_purpose_app(..., sandbox_enabled=True). Off is every release's
    # default, so an off switch passes nothing and the published 309df6d5 (whose create_purpose_app has no such
    # keyword) starts here as well.
    if config.get("sandbox_project_tests_enabled"):
        app = create_purpose_app(service, config["port"], sandbox_enabled=True)
    else:
        app = create_purpose_app(service, config["port"])
    uvicorn.run(app, host="127.0.0.1", port=config["port"], access_log=False, log_level="warning")


if __name__ == "__main__":
    main(sys.argv[1])

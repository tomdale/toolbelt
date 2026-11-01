#!/usr/bin/env python3
"""Configure only a fresh isolated control through its authenticated owner API."""
import argparse
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("worker", Path(__file__).parents[1] / "worker/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--server", required=True)
parser.add_argument("--cookie-file", required=True)
args = parser.parse_args()
owner = worker.Owner(args.server, args.cookie_file)
if owner.request("GET", "/api/v1/hosts") or owner.request("GET", "/api/v1/threads"):
    raise worker.Refused("Control configuration requires a fresh instance with no hosts or threads")
config = owner.request("GET", "/api/v1/system/config")
general = config["generalSettings"]
general.update({"defaultMachineAccess": "direct", "machineServerUrl": owner.server,
                "machineGitCredentialsEnabled": False})
owner.request("PUT", "/api/v1/settings/general", general)
observed = owner.request("GET", "/api/v1/system/config")["generalSettings"]
assert observed["defaultMachineAccess"] == "direct"
assert observed["machineServerUrl"] == owner.server
assert observed["machineGitCredentialsEnabled"] is False
print("Isolated control direct machine access configured; GitHub credential forwarding disabled")

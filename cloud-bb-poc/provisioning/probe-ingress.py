#!/usr/bin/env python3
"""Probe temporary ingress without reading credentials into output."""
import argparse
import importlib.util
import json
from pathlib import Path
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location("worker", Path(__file__).parents[1] / "worker/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--server", required=True)
parser.add_argument("--cookie-file", required=True)
parser.add_argument("--out", required=True)
args = parser.parse_args()
owner = worker.Owner(args.server, args.cookie_file)
results = []


def probe(name, method, path, expected, headers=None, body=None):
    request = urllib.request.Request(owner.server + path, data=body, method=method, headers=headers or {})
    try:
        with owner.opener.open(request, timeout=30) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    results.append({"name": name, "status": "passed" if status == expected else "failed", "message": f"HTTP {status}; expected {expected}"})


probe("Raw unauthenticated owner API denied", "GET", "/api/v1/hosts", 401)
probe("Edge metadata does not grant owner authority", "GET", "/api/v1/hosts", 401,
      {"x-vercel-owner-id": "synthetic-untrusted", "x-bb-host-id": "synthetic-untrusted"})
probe("Native bearer cannot grant owner authority", "GET", "/api/v1/hosts", 403,
      {"Authorization": "Bearer synthetic-invalid-native-credential"})
probe("Invalid native credential rejected by real core", "POST", "/internal/session/open", 401,
      {"Authorization": "Bearer synthetic-invalid-native-credential", "Content-Type": "application/json"}, b"{}")
probe("Skill manifest requires native authentication", "GET", "/internal/skills/tree/" + "0" * 64, 401)
probe("Skill content requires native authentication", "POST", "/internal/skills/tree/" + "0" * 64 + "/content", 401,
      {"Content-Type": "application/json"}, b"{}")
probe("Owner enrollment authority not publicly exposed", "POST", "/internal/hosts/enroll-key", 401,
      {"Content-Type": "application/json"}, b"{}")
html = owner.request("GET", "/", raw=True)
results.append({"name": "Authenticated released UI served", "status": "passed" if "<!doctype html>" in html.lower() else "failed"})
version = owner.request("GET", "/api/v1/system/version")
results.append({"name": "Actual BB release is 0.48.1", "status": "passed" if version.get("currentVersion") == "0.48.1" else "failed"})
hosts = owner.request("GET", "/api/v1/hosts")
only_worker = len(hosts) == 1 and hosts[0].get("machineProviderId") == "manual" and hosts[0].get("status") == "connected"
results.append({"name": "Only connected manual worker is an execution host", "status": "passed" if only_worker else "failed"})
Path(args.out).write_text(json.dumps(results, indent=2) + "\n")
print(json.dumps({"passed": sum(r["status"] == "passed" for r in results), "failed": sum(r["status"] == "failed" for r in results)}))
raise SystemExit(any(r["status"] == "failed" for r in results))

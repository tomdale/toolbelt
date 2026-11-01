#!/usr/bin/env python3
"""Read one approved proof artifact through worker-bound native BB file access."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re

spec = importlib.util.spec_from_file_location("worker", Path(__file__).parents[1] / "worker/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
parser = argparse.ArgumentParser(description=__doc__)
for name in ("server", "cookie-file", "host-id", "root", "path", "nonce", "revision", "out"):
    parser.add_argument("--" + name, required=True)
args = parser.parse_args()
if not re.fullmatch(r"host_[A-Za-z0-9_-]+", args.host_id) or not re.fullmatch(r"[0-9a-f]{40}", args.revision):
    raise worker.Refused("Explicit worker identity and full checkout revision required")
root, path = Path(args.root), Path(args.path)
if not root.is_absolute() or not path.is_absolute() or ".." in path.parts or path == root or root not in path.parents:
    raise worker.Refused("Proof path must be confined to an explicit absolute checkout root")
owner = worker.Owner(args.server, args.cookie_file)
host = owner.request("GET", "/api/v1/hosts/" + args.host_id)
if host.get("machineProviderId") != "manual" or host.get("status") != "connected":
    raise worker.Refused("Proof read requires the connected manual worker")
result = owner.request("POST", "/api/v1/files/read", {"hostId": args.host_id, "path": str(path), "rootPath": str(root)})
if result.get("contentEncoding") == "base64":
    content = base64.b64decode(result["content"], validate=True)
elif result.get("contentEncoding", "utf8") == "utf8":
    content = result["content"].encode()
else:
    raise worker.Refused("Unexpected native file encoding")
if len(content) > 16384:
    raise worker.Refused("Proof file exceeds the bounded artifact size")
text = content.decode()
checks = {"nonceMatches": args.nonce in text, "revisionMatches": args.revision in text,
          "checkoutMatches": str(root) in text, "humanAnswerMatches": "Cloud proof confirmed" in text,
          "distributedSkillRecorded": "global-skills/" in text and "skills/bb-cli/SKILL.md" in text}
summary = {"hostId": args.host_id, "path": str(path), "readThrough": "/api/v1/files/read",
           "sha256": hashlib.sha256(content).hexdigest(), "byteLength": len(content), **checks}
fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    json.dump({"summary": summary, "nativeResponse": result}, stream, indent=2)
    stream.write("\n")
print(json.dumps(summary))
raise SystemExit(not all(checks.values()))

#!/usr/bin/env python3
"""Isolated BB 0.48.1 manual-machine enrollment and Pi execution harness."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BB_VERSION = "0.48.1"
PI_VERSION = "1.4.0"


class Refused(Exception):
    pass


class BBRequestFailed(Refused):
    def __init__(self, status):
        self.status = status
        super().__init__(f"BB request failed: HTTP {status} (response body suppressed)")


def private_read(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise Refused("Private input must be an owned regular file, mode 0600 or stricter")
    return path.read_text()


def private_write(path, text):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(text)


def checked_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise Refused("Server URL must be a credential-free origin")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
        raise Refused("Server needs HTTPS, except explicit loopback test origins")
    if not parsed.netloc:
        raise Refused("Missing server origin")
    return url.rstrip("/")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Refused("Refusing redirect of a credential-bearing request")


class Owner:
    def __init__(self, server, cookie_file):
        self.server = checked_url(server)
        self.cookie = private_read(cookie_file).strip()
        if not self.cookie or "\n" in self.cookie or "\r" in self.cookie:
            raise Refused("Expected one raw Cookie header value in private cookie file")
        self.opener = urllib.request.build_opener(NoRedirect)

    def request(self, method, path, payload=None, headers=None, raw=False, enrollment=False):
        if not path.startswith("/") or path.startswith("//"):
            raise Refused("Expected an origin-relative API path")
        data = None if payload is None else json.dumps(payload).encode()
        authority = {} if enrollment else {"Cookie": self.cookie, "Origin": self.server}
        request = urllib.request.Request(self.server + path, data=data, method=method,
            headers={**authority, "Content-Type": "application/json", **(headers or {})})
        try:
            with self.opener.open(request, timeout=60) as response:
                body = response.read()
        except urllib.error.HTTPError as error:
            raise BBRequestFailed(error.code) from None
        return body.decode() if raw else json.loads(body)


def extract_manual_header(command, server):
    tokens = shlex.split(command)
    expected = ["curl", "-sSL", "--fail-with-body", "-H"]
    if tokens[:4] != expected or len(tokens) != 8 or tokens[6:] != ["|", "sh"]:
        raise Refused("Unrecognized released manual enrollment command; never executing it")
    header = tokens[4]
    if not header.startswith("X-BB-Enrollment: ") or tokens[5] != server + "/install.sh":
        raise Refused("Enrollment command origin/header mismatch")
    value = header[len("X-BB-Enrollment: "):]
    if not value or "\r" in value or "\n" in value:
        raise Refused("Malformed enrollment header")
    return value


def extract_bundle(script, server, host_id):
    first, second, remainder = script.split("\n", 2)
    tokens = shlex.split(first)
    if len(tokens) != 2 or tokens[0] != "export" or not tokens[1].startswith("BB_ENROLLMENT="):
        raise Refused("Installer did not contain a core-produced enrollment bundle")
    if second != "set -- --bootstrap-env BB_ENROLLMENT":
        raise Refused("Unknown installer bootstrap contract")
    bundle = json.loads(tokens[1][len("BB_ENROLLMENT="):])
    if bundle.get("hostId") != host_id or checked_url(bundle.get("serverUrl", "")) != server:
        raise Refused("Core bundle host/server identity mismatch")
    if not isinstance(bundle.get("credential"), str) or not bundle["credential"]:
        raise Refused("Core bundle missing credential")
    if not isinstance(bundle.get("expiresAt"), (int, float)) or bundle["expiresAt"] <= time.time() * 1000:
        raise Refused("Core bundle expired")
    if bundle.get("reconnect") or bundle.get("dataDir"):
        raise Refused("Only fresh manual machine enrollment is supported")
    return bundle, remainder


def prepare(args):
    owner = Owner(args.server, args.cookie_file)
    # BB_APP_URL controls browser access, not the released machine enrollment URL.
    access = owner.request("GET", "/api/v1/system/config").get("serverAccess", {})
    if access.get("defaultProviderId") != "direct" or access.get("effectiveUrl") != owner.server:
        raise Refused(
            "Manual worker preparation requires direct machine access at the requested origin. "
            "On the isolated control only, preserve generalSettings from GET /api/v1/system/config, "
            "set defaultMachineAccess=direct and machineServerUrl to --server, then PUT the full "
            "settings to /api/v1/settings/general. BB_APP_URL alone is insufficient. No host created.")
    directory = Path(args.out).absolute()
    if directory.exists():
        raise Refused("Prepare output must be a new private directory")
    directory.mkdir(mode=0o700, parents=True)
    host = owner.request("POST", "/api/v1/hosts", {
        "machineProviderId": "manual", "inputs": None, "key": args.key})
    host_id = host["id"]
    # Persist identity before polling so a failed preparation can still be revoked.
    private_write(directory / "machine.json", json.dumps({"hostId": host_id, "serverUrl": owner.server}) + "\n")
    pending = None
    for _ in range(60):
        try:
            pending = owner.request("GET", f"/api/v1/hosts/{host_id}/enrollment-command")
        except BBRequestFailed as error:
            if error.status == 404:
                raise Refused(
                    "Manual host is missing or was removed during asynchronous creation; "
                    "the BB 0.48.1 enrollment-command route is valid. Check isolated control "
                    "machine access configuration and host lifecycle. machine.json retains "
                    "the submitted host identity; no replacement was created.") from None
            raise
        if pending:
            break
        time.sleep(1)
    if not pending:
        raise Refused("Manual bootstrap not ready; machine.json identifies the pending host for removal")
    credential = extract_manual_header(pending["command"], owner.server)
    script = owner.request("GET", "/install.sh", headers={"X-BB-Enrollment": credential}, raw=True, enrollment=True)
    bundle, installer = extract_bundle(script, owner.server, host_id)
    private_write(directory / "bootstrap.json", json.dumps(bundle) + "\n")
    private_write(directory / "install-machine.sh", installer)
    print(json.dumps({"hostId": host_id, "bundleFile": str(directory / "bootstrap.json")}))


def require_worker():
    if os.environ.get("CLOUD_BB_WORKER") != "1":
        raise Refused("Worker operations require CLOUD_BB_WORKER=1 on a disposable execution machine")


def init_root(root):
    require_worker()
    root = Path(root).absolute()
    if root.exists() or root.is_symlink():
        raise Refused("Worker root must be new; reuse could attach an existing machine authority")
    root.mkdir(mode=0o700, parents=True)
    (root / "home").mkdir(mode=0o700)
    private_write(root / "worker-marker", "cloud-bb-poc-worker-v1\n")
    return root


def require_root(root):
    require_worker()
    root = Path(root).absolute()
    if root.is_symlink() or private_read(root / "worker-marker") != "cloud-bb-poc-worker-v1\n":
        raise Refused("Not an isolated worker root")
    return root


def clean_env(root):
    home = root / "home"
    return {"HOME": str(home), "PATH": str(home / ".local/bin") + os.pathsep + os.defpath,
            "LANG": "C.UTF-8", "NPM_CONFIG_USERCONFIG": os.devnull,
            "NPM_CONFIG_REGISTRY": "https://registry.npmjs.org/",
            "BB_INSTALL_SKIP_SERVICE": "1", "BB_CLI_ERROR_LOG": "0"}


def run_quiet(argv, env, cwd=None):
    result = subprocess.run(argv, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if result.returncode:
        raise Refused(f"Worker subprocess failed (exit {result.returncode}; output suppressed to protect credentials)")


def install(args):
    root = init_root(args.root)
    env = clean_env(root)
    # Resolve only tool executable paths, never inherit local auth/configuration.
    node, npm = shutil.which("node"), shutil.which("npm")
    if not node or not npm:
        raise Refused("Install Node.js >=22.19 and npm in the disposable worker image")
    env["PATH"] = str(root / "home/.local/bin") + os.pathsep + str(Path(node).parent) + os.pathsep + str(Path(npm).parent) + os.pathsep + os.defpath
    run_quiet([node, "-e", "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)"], env)
    run_quiet([npm, "install", "--global", "--ignore-scripts", "--prefix", str(root / "home/.local"),
               f"@earendil-works/pi-coding-agent@{PI_VERSION}"], env)
    run_quiet([npm, "install", "--global", "--prefix", str(root / "home/.local"), f"bb-app@{BB_VERSION}"], env)
    private_write(root / "path", env["PATH"] + "\n")
    print(json.dumps({"root": str(root), "bbVersion": BB_VERSION, "piVersion": PI_VERSION}))


def worker_env(root, bundle):
    env = clean_env(root)
    env["PATH"] = private_read(root / "path").strip()
    slug = re.sub(r"[^a-zA-Z0-9.-]", "-", urllib.parse.urlsplit(bundle["serverUrl"]).netloc)
    env["BB_DATA_DIR"] = str(root / "home/.bb-machines" / slug)
    return env


def bootstrap(args):
    root = require_root(args.root)
    bundle_text = private_read(args.bootstrap_file)
    bundle = json.loads(bundle_text)
    server = checked_url(bundle["serverUrl"])
    if not re.fullmatch(r"host_[A-Za-z0-9_-]+", bundle["hostId"]):
        raise Refused("Malformed host ID")
    if bundle.get("reconnect") or bundle.get("dataDir"):
        raise Refused("Not a fresh manual bundle")
    if args.port in (38886, 38887) or not 1024 <= args.port <= 65535:
        raise Refused("Use a non-default worker-local daemon port")
    key = private_read(args.gateway_key_file).strip()
    if not key or "\n" in key or "\r" in key:
        raise Refused("Expected a single API key in the private provider file")
    env = worker_env(root, bundle)
    env["AI_GATEWAY_API_KEY"] = key
    bb = str(root / "home/.local/bin/bb")
    if (root / "daemon.pid").exists():
        raise Refused("A daemon was already launched from this root")
    if args.installer_file:
        installer = Path(args.installer_file).absolute()
        private_read(installer)
        env["BB_ENROLLMENT"] = bundle_text
        run_quiet(["/bin/sh", str(installer), "--bootstrap-env", "BB_ENROLLMENT",
                   "--host-daemon-port", str(args.port)], env)
    else:
        run_quiet([bb, "machine", "enroll", "--bootstrap-file", str(Path(args.bootstrap_file).absolute())], env)
        process = subprocess.Popen([str(root / "home/.local/bin/bb-app"), "host-daemon",
            "--host-daemon-port", str(args.port), "--server-url", server], env=env,
            cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
        private_write(root / "daemon.pid", str(process.pid) + "\n")
    private_write(root / "machine.json", json.dumps({"hostId": bundle["hostId"], "serverUrl": server,
        "dataDir": env["BB_DATA_DIR"], "port": args.port}) + "\n")
    print(json.dumps({"hostId": bundle["hostId"], "launched": True,
                      "note": "Launch is not connection or provider-auth proof; poll native host and model APIs"}))


def checkout(args):
    root = require_root(args.root)
    if not re.fullmatch(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?", args.repo):
        raise Refused("Only explicitly approved public GitHub HTTPS repository URLs are supported")
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        raise Refused("Pin the approved repository to a full lowercase commit SHA")
    target = root / "checkout"
    if target.exists():
        raise Refused("Checkout target already exists")
    env = clean_env(root)
    env.update({"GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": os.devnull})
    run_quiet(["git", "clone", "--no-checkout", "--", args.repo, str(target)], env)
    run_quiet(["git", "-C", str(target), "-c", "core.hooksPath=/dev/null", "checkout", "--detach", args.revision], env)
    print(json.dumps({"checkout": str(target), "revision": args.revision}))


def sync_skills(args):
    root = require_root(args.root)
    source = Path(args.source).resolve(strict=True)
    destination = root / "home/.agents/skills"
    destination.mkdir(parents=True, mode=0o700, exist_ok=True)
    manifest = {}
    for name in args.name:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", name):
            raise Refused("Invalid explicit skill name")
        skill = source / name
        if skill.is_symlink() or not (skill / "SKILL.md").is_file():
            raise Refused("Approved skill must be a real directory containing SKILL.md")
        for path in skill.rglob("*"):
            if path.is_symlink() or not (path.is_file() or path.is_dir()):
                raise Refused("Skill trees cannot contain symlinks or special files")
        target = destination / name
        if target.exists():
            raise Refused("Skill destination already exists; no implicit overwrite")
        shutil.copytree(skill, target)
        for path in sorted(target.rglob("*")):
            if path.is_file():
                manifest[str(path.relative_to(destination))] = hashlib.sha256(path.read_bytes()).hexdigest()
    private_write(root / "skills-manifest.json", json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"copiedFiles": len(manifest), "manifest": str(root / "skills-manifest.json")}))


def spawn(args):
    owner = Owner(args.server, args.cookie_file)
    if not re.fullmatch(r"host_[A-Za-z0-9_-]+", args.host_id) or not args.checkout_path.startswith("/"):
        raise Refused("Explicit native worker host ID and absolute remote checkout path are required")
    host = owner.request("GET", "/api/v1/hosts/" + args.host_id)
    if host.get("machineProviderId") != "manual" or host.get("status") != "connected" or host.get("lifecycle", {}).get("phase") != "active":
        raise Refused("Thread execution requires the connected active MANUAL worker, never the control runtime")
    project = owner.request("POST", "/api/v1/projects", {"name": args.name,
        "source": {"hostId": args.host_id, "type": "local_path", "path": args.checkout_path}})
    project_id = project["id"]
    prompt = Path(args.prompt_file).read_text()
    result = owner.request("POST", "/api/v1/threads", {
        "projectId": project_id, "providerId": "pi", "origin": "cli", "title": args.name,
        "input": [{"type": "text", "text": prompt}], "model": args.model,
        "permissionMode": "full", "environment": {"type": "host", "hostId": args.host_id,
            "workspace": {"type": "unmanaged", "path": args.checkout_path}}})
    print(json.dumps(result, indent=2))


def owner_request(args):
    if not args.path.startswith("/api/v1/"):
        raise Refused("Generic owner request is limited to native /api/v1/ routes")
    body = json.loads(Path(args.body_file).read_text()) if args.body_file else None
    print(json.dumps(Owner(args.server, args.cookie_file).request(args.method, args.path, body), indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    p = subs.add_parser("prepare", help="Control-side: create manual host and save private native bundle/installer")
    p.add_argument("--server", required=True); p.add_argument("--cookie-file", required=True)
    p.add_argument("--out", required=True); p.add_argument("--key", required=True)
    p.set_defaults(func=prepare)
    p = subs.add_parser("install", help="Worker-side only: install public pinned BB and Pi in a fresh root")
    p.add_argument("--root", required=True); p.set_defaults(func=install)
    p = subs.add_parser("bootstrap", help="Worker-side only: enroll and launch a native daemon")
    p.add_argument("--root", required=True); p.add_argument("--bootstrap-file", required=True)
    p.add_argument("--gateway-key-file", required=True); p.add_argument("--port", type=int, default=39887)
    p.add_argument("--installer-file", help="Optional vendor installer; needs secured artifact endpoints")
    p.set_defaults(func=bootstrap)
    p = subs.add_parser("checkout", help="Worker-side only: clone one approved public repo without setup hooks")
    p.add_argument("--root", required=True); p.add_argument("--repo", required=True)
    p.add_argument("--revision", required=True); p.set_defaults(func=checkout)
    p = subs.add_parser("sync-skills", help="Worker-side only: copy an explicit approved skill allowlist")
    p.add_argument("--root", required=True); p.add_argument("--source", required=True)
    p.add_argument("--name", action="append", required=True); p.set_defaults(func=sync_skills)
    p = subs.add_parser("spawn", help="Control-side: create native project/thread bound explicitly to a MANUAL worker")
    p.add_argument("--server", required=True); p.add_argument("--cookie-file", required=True)
    p.add_argument("--host-id", required=True); p.add_argument("--checkout-path", required=True)
    p.add_argument("--prompt-file", required=True); p.add_argument("--name", default="Cloud BB proof")
    p.add_argument("--model", default="vercel-ai-gateway/openai/gpt-6.1-sol"); p.set_defaults(func=spawn)
    p = subs.add_parser("request", help="Owner-authenticated native API, never a worker execution substitute")
    p.add_argument("--server", required=True); p.add_argument("--cookie-file", required=True)
    p.add_argument("--method", choices=["GET", "POST", "DELETE"], default="GET")
    p.add_argument("--path", required=True); p.add_argument("--body-file"); p.set_defaults(func=owner_request)
    args = parser.parse_args()
    try:
        args.func(args)
    except Refused as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, urllib.error.URLError):
        # Never render arbitrary exceptions: HTTP URLs, bundles, and provider errors can carry credentials.
        print("Worker operation failed; check private inputs and native BB status. No credential output retained.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

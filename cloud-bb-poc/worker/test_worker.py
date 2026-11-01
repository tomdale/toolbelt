import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import shlex
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import worker


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.environment = patch.dict(os.environ, {"CLOUD_BB_WORKER": "1"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def secret(self, name, content):
        path = self.base / name
        worker.private_write(path, content)
        return path

    def bundle(self, server="https://worker-test.example"):
        return {"hostId": "host_test", "serverUrl": server, "credential": "TEST-ENROLLMENT-SENTINEL",
                "expiresAt": int(time.time() * 1000) + 60000}

    def root(self):
        root = worker.init_root(self.base / "worker")
        worker.private_write(root / "path", "/usr/local/bin:/usr/bin:/bin\n")
        return root

    def test_private_files_and_no_overwrite(self):
        path = self.secret("private", "TEST-SECRET")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            worker.private_write(path, "replacement")
        path.chmod(0o644)
        with self.assertRaises(worker.Refused):
            worker.private_read(path)

    def test_private_reader_refuses_symlinks(self):
        path = self.secret("private", "TEST-SECRET")
        alias = self.base / "alias"
        alias.symlink_to(path)
        with self.assertRaises(worker.Refused):
            worker.private_read(alias)

    def test_url_rejects_credential_and_redirect_targets(self):
        for url in ["https://user:pass@example.test", "http://remote.test", "https://example.test/sub", "https://example.test?key=x"]:
            with self.subTest(url=url), self.assertRaises(worker.Refused):
                worker.checked_url(url)
        self.assertEqual(worker.checked_url("http://127.0.0.1:1234"), "http://127.0.0.1:1234")

    def test_generated_command_is_parsed_never_executed(self):
        server = "https://worker-test.example"
        command = "curl -sSL --fail-with-body -H 'X-BB-Enrollment: TEST-ENROLLMENT' " + server + "/install.sh | sh"
        self.assertEqual(worker.extract_manual_header(command, server), "TEST-ENROLLMENT")
        for broken in [command + "; id", command.replace(server, "https://evil.example"), command.replace("curl", "eval")]:
            with self.assertRaises(worker.Refused):
                worker.extract_manual_header(broken, server)

    def test_bundle_extraction_identity_expiry_and_reconnect(self):
        bundle = self.bundle()
        def script(value):
            return "export BB_ENROLLMENT=" + shlex.quote(json.dumps(value)) + "\nset -- --bootstrap-env BB_ENROLLMENT\n#!/bin/sh\nexit 0\n"
        parsed, installer = worker.extract_bundle(script(bundle), bundle["serverUrl"], bundle["hostId"])
        self.assertEqual(parsed, bundle)
        self.assertNotIn("TEST-ENROLLMENT", installer)
        for changed in [{**bundle, "hostId": "host_other"}, {**bundle, "expiresAt": 1}, {**bundle, "reconnect": True}]:
            with self.assertRaises(worker.Refused):
                worker.extract_bundle(script(changed), bundle["serverUrl"], bundle["hostId"])

    def test_owner_prepare_over_real_http_stub(self):
        seen = []
        bundle = self.bundle()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                if self.path != "/api/v1/hosts":
                    self.send_error(404); return
                seen.append((self.path, self.headers.get("Cookie"), json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(201); self.end_headers(); self.wfile.write(b'{"id":"host_test"}')
            def do_GET(self):
                seen.append((self.path, self.headers.get("X-BB-Enrollment"), self.headers.get("Cookie"), self.headers.get("Origin")))
                if self.path == "/api/v1/system/config":
                    body = json.dumps({"serverAccess": {"defaultProviderId": "direct", "effectiveUrl": bundle["serverUrl"]},
                                       "primaryHostId": None})
                elif self.path == "/api/v1/hosts/host_test/enrollment-command":
                    body = json.dumps({"command": "curl -sSL --fail-with-body -H 'X-BB-Enrollment: TEST-ENROLLMENT-SENTINEL' " + bundle["serverUrl"] + "/install.sh | sh",
                                       "windowsCommand": "TEST-WINDOWS-COMMAND", "expiresAt": bundle["expiresAt"]})
                elif self.path == "/install.sh":
                    body = "export BB_ENROLLMENT=" + shlex.quote(json.dumps(bundle)) + "\nset -- --bootstrap-env BB_ENROLLMENT\n#!/bin/sh\nexit 0\n"
                else:
                    self.send_error(404); return
                self.send_response(200); self.end_headers()
                self.wfile.write(body.encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        bundle["serverUrl"] = f"http://127.0.0.1:{server.server_port}"
        cookie = self.secret("cookie", "owner=TEST-COOKIE")
        out = self.base / "prepared"
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            worker.prepare(argparse.Namespace(server=bundle["serverUrl"], cookie_file=cookie, out=out, key="test-idempotency"))
        self.assertEqual(json.loads(worker.private_read(out / "bootstrap.json")), bundle)
        self.assertEqual(seen[0], ("/api/v1/system/config", None, "owner=TEST-COOKIE", bundle["serverUrl"]))
        self.assertEqual(seen[1][2], {"machineProviderId": "manual", "inputs": None, "key": "test-idempotency"})
        self.assertEqual(seen[2][0], "/api/v1/hosts/host_test/enrollment-command")
        self.assertEqual(seen[-1], ("/install.sh", "TEST-ENROLLMENT-SENTINEL", None, None))
        self.assertNotIn("SENTINEL", stream.getvalue())
        self.assertNotIn("TEST-COOKIE", stream.getvalue())

    def prepare_args(self):
        return argparse.Namespace(server="https://worker-test.example", cookie_file="unused",
                                  out=self.base / "prepared", key="test-idempotency")

    def test_prepare_refuses_unconfigured_machine_access_before_creating_host(self):
        args = self.prepare_args()
        for access in [{}, {"defaultProviderId": "connect", "effectiveUrl": args.server},
                       {"defaultProviderId": "direct", "effectiveUrl": None},
                       {"defaultProviderId": "direct", "effectiveUrl": "https://other.example"}]:
            with self.subTest(access=access), patch.object(worker, "Owner") as owner:
                owner.return_value.server = args.server
                owner.return_value.request.return_value = {"serverAccess": access}
                with self.assertRaisesRegex(worker.Refused, "BB_APP_URL alone is insufficient"):
                    worker.prepare(args)
                owner.return_value.request.assert_called_once_with("GET", "/api/v1/system/config")
                self.assertFalse(args.out.exists())

    def test_prepare_polls_null_command_and_preserves_identity_on_host_removal(self):
        args = self.prepare_args()
        with patch.object(worker, "Owner") as owner, patch.object(worker.time, "sleep") as sleep:
            owner.return_value.server = args.server
            owner.return_value.request.side_effect = [
                {"serverAccess": {"defaultProviderId": "direct", "effectiveUrl": args.server}},
                {"id": "host_test"}, None, worker.BBRequestFailed(404)]
            with self.assertRaisesRegex(worker.Refused, "removed during asynchronous creation"):
                worker.prepare(args)
            sleep.assert_called_once_with(1)
            calls = owner.return_value.request.call_args_list
            self.assertEqual([c.args[0] for c in calls], ["GET", "POST", "GET", "GET"])
            self.assertEqual(calls[-1].args, ("GET", "/api/v1/hosts/host_test/enrollment-command"))
            self.assertEqual(json.loads(worker.private_read(args.out / "machine.json")),
                             {"hostId": "host_test", "serverUrl": args.server})
            self.assertFalse((args.out / "bootstrap.json").exists())

    def test_worker_mode_and_existing_root_refusal(self):
        with patch.dict(os.environ, {"CLOUD_BB_WORKER": "0"}), self.assertRaises(worker.Refused):
            worker.init_root(self.base / "denied")
        root = self.root()
        with self.assertRaises(worker.Refused):
            worker.init_root(root)

    def test_environment_excludes_daily_authority(self):
        with patch.dict(os.environ, {"BB_SERVER_URL": "https://daily.test", "GH_TOKEN": "TEST-TOKEN", "OPENAI_API_KEY": "TEST-OTHER"}):
            env = worker.clean_env(self.root())
        for name in ("BB_SERVER_URL", "GH_TOKEN", "OPENAI_API_KEY", "BB_THREAD_ID", "BB_CLI"):
            self.assertNotIn(name, env)

    def test_preinstalled_bootstrap_only_paths_in_argv(self):
        root = self.root()
        bundle = self.bundle()
        args = argparse.Namespace(root=root, bootstrap_file=self.secret("bootstrap", json.dumps(bundle)),
            gateway_key_file=self.secret("provider", "TEST-PROVIDER-SENTINEL"), port=39887, installer_file=None)
        with patch.object(worker, "run_quiet") as run, patch.object(worker.subprocess, "Popen") as launch, contextlib.redirect_stdout(io.StringIO()) as output:
            launch.return_value.pid = 12345
            worker.bootstrap(args)
        self.assertEqual(run.call_args.args[0][-2:], ["--bootstrap-file", str(args.bootstrap_file)])
        self.assertIn("host-daemon", launch.call_args.args[0])
        self.assertEqual(launch.call_args.kwargs["env"]["AI_GATEWAY_API_KEY"], "TEST-PROVIDER-SENTINEL")
        self.assertTrue(launch.call_args.kwargs["env"]["HOME"].startswith(str(root)))
        self.assertNotIn("SENTINEL", str(run.call_args.args[0]) + str(launch.call_args.args[0]) + output.getvalue())

    def test_installer_mode_passes_bundle_in_environment(self):
        root = self.root()
        args = argparse.Namespace(root=root, bootstrap_file=self.secret("bootstrap", json.dumps(self.bundle())),
            gateway_key_file=self.secret("provider", "TEST-PROVIDER-SENTINEL"), port=39887,
            installer_file=self.secret("installer.sh", "#!/bin/sh\nexit 0\n"))
        with patch.object(worker, "run_quiet") as run, contextlib.redirect_stdout(io.StringIO()):
            worker.bootstrap(args)
        argv, env = run.call_args.args
        self.assertEqual(argv[2:4], ["--bootstrap-env", "BB_ENROLLMENT"])
        self.assertIn("TEST-ENROLLMENT-SENTINEL", env["BB_ENROLLMENT"])
        self.assertNotIn("SENTINEL", str(argv))

    def test_native_spawn_targets_only_the_manual_worker(self):
        prompt = self.base / "task.txt"
        prompt.write_text("Nonsecret task")
        args = argparse.Namespace(server="https://worker-test.example", cookie_file="unused",
            host_id="host_test", checkout_path="/tmp/cloud-bb-worker/checkout", name="Proof",
            prompt_file=prompt, model="vercel-ai-gateway/openai/gpt-6.1-sol")
        host = {"machineProviderId": "manual", "status": "connected", "lifecycle": {"phase": "active"}}
        with patch.object(worker, "Owner") as owner, contextlib.redirect_stdout(io.StringIO()):
            owner.return_value.request.side_effect = [host, {"id": "proj_test"}, {"thread": {"id": "thr_test"}}]
            worker.spawn(args)
        create = owner.return_value.request.call_args_list[-1]
        self.assertEqual(create.args[:2], ("POST", "/api/v1/threads"))
        self.assertEqual(create.args[2]["environment"]["hostId"], "host_test")
        self.assertEqual(create.args[2]["providerId"], "pi")
        self.assertEqual(create.args[2]["model"], "vercel-ai-gateway/openai/gpt-6.1-sol")
        for rejected in [{**host, "machineProviderId": None}, {**host, "status": "disconnected"}]:
            with patch.object(worker, "Owner") as owner, self.assertRaises(worker.Refused):
                owner.return_value.request.return_value = rejected
                worker.spawn(args)
            self.assertEqual(owner.return_value.request.call_count, 1)

    def test_install_pins_public_packages_without_provider_secret(self):
        args = argparse.Namespace(root=self.base / "worker")
        with patch.object(worker, "run_quiet") as run, patch.object(worker.shutil, "which", side_effect=["/usr/local/bin/node", "/usr/local/bin/npm"]), contextlib.redirect_stdout(io.StringIO()):
            worker.install(args)
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(commands[1][-1], "@earendil-works/pi-coding-agent@1.4.0")
        self.assertEqual(commands[2][-1], "bb-app@0.48.1")
        self.assertIn("--ignore-scripts", commands[1])
        for call in run.call_args_list:
            self.assertNotIn("AI_GATEWAY_API_KEY", call.args[1])
            self.assertEqual(call.args[1]["NPM_CONFIG_REGISTRY"], "https://registry.npmjs.org/")

    def test_checkout_rejects_unpinned_or_credential_url(self):
        root = self.root()
        for repo, revision in [("https://token@github.com/a/b", "a" * 40), ("https://github.com/a/b", "main")]:
            with self.assertRaises(worker.Refused):
                worker.checkout(argparse.Namespace(root=root, repo=repo, revision=revision))

    def test_skills_sync_allowlist_hashes_and_symlink_refusal(self):
        root = self.root()
        source = self.base / "approved-skills"
        source.mkdir()
        for name in ("chosen", "excluded"):
            skill = source / name
            skill.mkdir()
            (skill / "SKILL.md").write_text("Fixture bytes only\n")
        with contextlib.redirect_stdout(io.StringIO()):
            worker.sync_skills(argparse.Namespace(root=root, source=source, name=["chosen"]))
        self.assertFalse((root / "home/.agents/skills/excluded").exists())
        self.assertEqual(len(json.loads(worker.private_read(root / "skills-manifest.json")) ["chosen/SKILL.md"]), 64)
        (source / "excluded/link").symlink_to(source / "chosen/SKILL.md")
        with self.assertRaises(worker.Refused):
            worker.sync_skills(argparse.Namespace(root=root, source=source, name=["excluded"]))


if __name__ == "__main__":
    unittest.main()

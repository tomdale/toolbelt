# Native manual BB worker

This harness uses public `bb-app@0.48.1` and Pi `@earendil-works/pi-coding-agent@1.4.0`. It does not emulate an agent, expose a parallel execution API, or run agent work on the control server. Python 3 runs the provisioning wrapper; Node.js >=22.19, npm, Git, and Linux/macOS run the actual worker. Use a disposable Linux worker for the cloud proof.

## Authority and approvals

The parent owns cloud provisioning, public ingress, repo/key approval, live verification, and teardown. Never run `install`, `checkout`, `sync-skills`, or `bootstrap` on the control runtime or daily laptop. `CLOUD_BB_WORKER=1` is a deliberate worker-only interlock, not a security sandbox. All installs use a new private root with its own HOME; the harness never reads or changes daily BB, Pi, Git, or npm auth/configuration. Never transfer the daily `~/.bb`, Pi `auth.json`, SSH keys, account pools, or GitHub login.

**Credential selected:** user-supplied Vercel AI Gateway API key, delivered through the secure secret facility as an owned regular 0600 file. `bootstrap --gateway-key-file` reads it without printing it and adds `AI_GATEWAY_API_KEY` to the worker daemon environment. The daemon passes it to actual Pi. No key value appears in argv, generated command output, wrapper logs, machine provider inputs, or control-side machine environment settings. A fresh key restricted by provider budgets/models is preferable; the user controls which key is authorized. Do not read an existing local credential to obtain it.

The default model is `vercel-ai-gateway/openai/gpt-6.1-sol`. Pi 1.4.0's public bundled catalog includes this exact ID and maps Vercel AI Gateway to `AI_GATEWAY_API_KEY`. Catalog inclusion is not proof that the supplied key can invoke it; verify with the actual thread. Do not substitute another model silently.

Full-access Pi can access its process environment and worker files. A 0600 key protects transfer/storage, not against an agent running as the same UID. Do not ask the agent to enumerate environment variables, credentials, or arbitrary home files. Use only the approved repository and approved skill trees. Core can forward server GitHub credentials to machines; the isolated fresh control HOME must not contain a daily GitHub login. Do not log in to GitHub or configure unrelated machine environment values for this public checkout.

## 1. Prepare a MANUAL enrollment on the isolated control server

The isolated server's machine access must use `direct` and advertise the reachable gateway origin, not loopback. BB 0.48.1 resolves this from `generalSettings.machineServerUrl`, falling back to `BB_EXTERNAL_URL`; `BB_APP_URL` alone does not configure machine enrollment. A null `defaultMachineAccess` selects the first registered access provider (which can be unavailable Connect), not necessarily direct access. Direct enrollment does not require a primary host or local daemon.

The parent configures **only the isolated control**: read `GET /api/v1/system/config`, preserve its `generalSettings`, set `defaultMachineAccess` to `"direct"` and `machineServerUrl` to the gateway origin, then send that full settings object to `PUT /api/v1/settings/general`. This route requires full settings, not a two-field patch. Keep `machineGitCredentialsEnabled` false on the proof control to avoid GitHub credential forwarding. Do not print the full config response. `prepare` checks `serverAccess.defaultProviderId` and `effectiveUrl` before creating a host; it does not change settings.

Keep core listening only on `127.0.0.1:38886`; the owner gateway serves the public origin. The owner session Cookie header value goes in a private file. Never put the cookie or enrollment command in shell argv. Do not use shell tracing.

```sh
umask 077
python3 cloud-bb-poc/worker/worker.py prepare \
  --server https://YOUR-GATEWAY-ORIGIN \
  --cookie-file /private/owner-cookie \
  --key cloud-bb-worker-proof-1 \
  --out /private/manual-enrollment
```

This calls real BB endpoints:

1. `GET /api/v1/system/config` verifies direct machine access at the requested origin before any host creation. Then `POST /api/v1/hosts` with owner Cookie + matching Origin and body `{"machineProviderId":"manual","inputs":null,"key":"cloud-bb-worker-proof-1"}`. Returns a Host with `id`; creation continues asynchronously.
2. `GET /api/v1/hosts/{id}/enrollment-command` until non-null. This is the published 0.48.1 route; a 404 can mean asynchronous creation failed and the host was removed, not that the route is wrong. The wrapper stops without replacing the host. The response contains `command`, `windowsCommand`, and `expiresAt`. The command is a credential and is **parsed, never executed or printed**.
3. `GET /install.sh` with `X-BB-Enrollment` from that command, **without Cookie, Origin or Authorization**. Released core validates its pending enrollment credential and returns the real installer prefixed with its own enrollment bundle. Redirects are refused to avoid credential forwarding.

The wrapper verifies host, origin, expiry and fresh-enrollment shape, then writes private `bootstrap.json`, unwrapped `install-machine.sh`, and `machine.json`. Only the host ID and bundle file path are printed. A partial preparation leaves `machine.json` so the host can still be revoked. Do not repeat with a different key after a failure without checking/removing the existing host. A pending manual command is short-lived and does not survive server restart; remove/recreate the host if necessary. Native enrollment itself is idempotent for an already persisted matching identity.

Transfer **only** `bootstrap.json`, this public worker harness, the fresh provider-key file, and any explicitly approved skill trees to the worker over the parent's secure channel. Preserve 0600 file permissions. Never transfer the owner cookie or the raw enrollment command to the worker.

## 2. Install, check out, sync, and launch on the WORKER only

These commands are intended to run through the parent's worker provisioning transport, not through the control server's execution environment. Pin the approved repository to a full commit SHA resolved by the parent. Only credential-free public GitHub HTTPS URLs are supported. The clone is detached and no repo setup hook or dependency install is run by the wrapper.

```sh
export CLOUD_BB_WORKER=1
WORKER_ROOT=/tmp/cloud-bb-worker
HARNESS=/opt/cloud-bb-poc/worker/worker.py

python3 "$HARNESS" install --root "$WORKER_ROOT"
python3 "$HARNESS" checkout --root "$WORKER_ROOT" \
  --repo https://github.com/tomdale/toolbelt.git \
  --revision APPROVED_FULL_40_CHARACTER_COMMIT_SHA

# Optional: source must be an approved collection, not the laptop's personal skills
python3 "$HARNESS" sync-skills --root "$WORKER_ROOT" \
  --source /private/approved-skills --name APPROVED-SKILL-NAME

python3 "$HARNESS" bootstrap --root "$WORKER_ROOT" \
  --bootstrap-file /private/bootstrap.json \
  --gateway-key-file /private/ai-gateway-key \
  --port 39887
```

`install` requires a new root, checks Node's minimum version, and installs Pi and BB into `<root>/home/.local`. BB native dependency lifecycle scripts are allowed because BB needs native addons; Pi uses `--ignore-scripts`. Public npm registry is explicit. The release versions are pinned, but npm transitive dependencies are not locked by this wrapper.

`sync-skills` copies only explicit names to the worker's `~/.agents/skills`, a real Pi native skill root indexed by BB. It rejects symlinks/special files and refuses overwrites; `skills-manifest.json` records SHA-256 for every copied file. This is a bounded transfer, not a replacement for BB's native skill-distribution protocol. For BB-owned selected skills, core distributes its skill tree when it starts the provider session; the gateway must retain the native skill routes. Verify selected skills in the actual thread rather than treating a copy count as model-use proof.

The recommended bootstrap invokes the installed real CLI:

```text
bb machine enroll --bootstrap-file /private/bootstrap.json
bb-app host-daemon --host-daemon-port 39887 --server-url https://YOUR-GATEWAY-ORIGIN
```

Both receive an isolated HOME and `BB_DATA_DIR=<root>/home/.bb-machines/<server-host>`. The daemon is detached without a service or auto-update, and stdout/stderr are discarded rather than risking credential values in provisioning logs. BB's own application logs remain in its private data directory; treat them as private. The wrapper writes `daemon.pid` and `machine.json`. A launched process is **not** proof of connection/authentication. Poll native machine status next. Remove the transferred bundle and key file after successful launch; the daemon retains the supplied environment until stopped. Revoking the provider key remains necessary at teardown if it was ephemeral.

### Optional real installer path

`bootstrap --installer-file /private/install-machine.sh` invokes the actual downloaded vendor installer with `--bootstrap-env BB_ENROLLMENT`, not a secret-valued argument. It passes `BB_INSTALL_SKIP_SERVICE=1`, selects the isolated data directory and nondefault port, and suppresses subprocess output.

Keep `/install/bb-app.tgz` and `/install/version` owner-only. The released shell installer downloads the tarball without native host authentication, but explicitly falls back to an existing `bb-app` on PATH when that download is denied. Before using installer mode, verify PATH selects the preinstalled pinned `bb-app@0.48.1` and its sibling `bb`; the vendor fallback does not check their versions itself. Do not use the installer's unpinned registry fallback, which applies to `404` responses. Do not weaken gateway authentication or put an owner cookie in the bundle. Direct native enrollment and installer-backed enrollment are separate tested capabilities; successful direct enrollment alone does not prove the vendor installer ran.

## 3. Create and inspect work through native BB

From the control-side operator, query the native host API using the owner session:

```sh
python3 cloud-bb-poc/worker/worker.py request \
  --server https://YOUR-GATEWAY-ORIGIN --cookie-file /private/owner-cookie \
  --path /api/v1/hosts/WORKER_HOST_ID
```

Require `machineProviderId=manual`, `status=connected`, and `lifecycle.phase=active`. A daemon session alone is not an authenticated Pi model. When a CLI targeting **only the isolated server** is available, the native catalog check is:

```sh
bb machine provider-cli status WORKER_HOST_ID --json
bb provider list --machine WORKER_HOST_ID --json
bb provider models pi --machine WORKER_HOST_ID --json
```

Do not omit `--machine`; omission selects the control machine. These commands are contracts, not instructions to run the daily local CLI against its default server.

Prepare a non-secret prompt file that asks the actual agent to inspect the approved checkout, read one approved skill, ask a question with two choices, wait for the human answer, and only then write a nonce-bearing proof file in the checkout and report the nonce, working directory, and commit SHA. Never ask for environment output or credentials. Verify the tool list of the actual session before requesting a structured **AskUserQuestion** card: Pi does not supply that tool natively, and the public release need not enable a plugin that adds it. If the tool is absent, an ordinary agent question and user message provide a conversational interaction. Report it as conversation, not a structured-card test. The interaction API below applies only when a real plugin interaction exists.

```sh
python3 cloud-bb-poc/worker/worker.py spawn \
  --server https://YOUR-GATEWAY-ORIGIN --cookie-file /private/owner-cookie \
  --host-id WORKER_HOST_ID \
  --checkout-path /tmp/cloud-bb-worker/checkout \
  --prompt-file /private/proof-task.txt \
  --model vercel-ai-gateway/openai/gpt-6.1-sol
```

`spawn` refuses disconnected, non-manual, or non-active hosts before any project/thread mutation. It creates `POST /api/v1/projects`:

```json
{"name":"Cloud BB proof","source":{"hostId":"WORKER_HOST_ID","type":"local_path","path":"/tmp/cloud-bb-worker/checkout"}}
```

Then `POST /api/v1/threads` with the returned project ID:

```json
{
  "projectId":"PROJECT_ID", "providerId":"pi", "origin":"cli",
  "title":"Cloud BB proof", "input":[{"type":"text","text":"USER_APPROVED_TASK"}],
  "model":"vercel-ai-gateway/openai/gpt-6.1-sol", "permissionMode":"full",
  "environment":{"type":"host","hostId":"WORKER_HOST_ID",
    "workspace":{"type":"unmanaged","path":"/tmp/cloud-bb-worker/checkout"}}
}
```

There is no implicit local fallback and no control-side execution target. Inspect returned `environment.hostId` before claiming execution locality.

Read the thread, question, and proof with native routes (all owner Cookie authenticated):

- `GET /api/v1/threads/{threadId}` — native thread/environment association and runtime status.
- `GET /api/v1/threads/{threadId}/interactions` — pending/historical native interaction payloads and IDs.
- `GET /api/v1/threads/{threadId}/interactions/{interactionId}` — exact plugin question IDs/option values.
- `POST /api/v1/threads/{threadId}/interactions/{interactionId}/respond` with `{"value":{"answers":{"ACTUAL_QUESTION_ID":{"selected":["ACTUAL_OPTION_VALUE"]}}}}` — submit the user's actual answer; never guess IDs or auto-approve on the user's behalf.
- `GET /api/v1/threads/{threadId}/events` — recorded tool calls/results, question lifecycle, and assistant proof. Continue with `?afterSeq=LAST_SEQUENCE` until the next page is empty; do not assume one page contains the full history.
- `GET /api/v1/threads/{threadId}/timeline` — native UI timeline representation.

Use `worker.py request --body-file PRIVATE_JSON_FILE --method POST --path ...` for requests with a JSON body. The generic helper prints native responses; use it only for the intended proof thread, never credential/settings discovery.

Equivalent native CLI contracts: `bb thread spawn --project PROJECT_ID --machine WORKER_HOST_ID --environment /tmp/cloud-bb-worker/checkout --provider pi --model vercel-ai-gateway/openai/gpt-6.1-sol --permission-mode full --prompt-file TASK --json`; `bb thread interactions list THREAD_ID --json`; `bb thread interactions show INTERACTION_ID THREAD_ID --json`; `bb thread interactions respond INTERACTION_ID THREAD_ID --value ANSWER_JSON --json`; `bb thread log THREAD_ID --json --all`; `bb thread output THREAD_ID --json`. Scope every CLI invocation to the isolated server, never the daily runtime. Human review through the native app is preferable for the question answer.

## Verification and cleanup

```sh
cd cloud-bb-poc/worker
python3 -m unittest -v
python3 -m py_compile worker.py test_worker.py
```

Tests use a strict local HTTP stub and mocked subprocess launches. They verify machine-access preflight without a primary host, refusal before host creation for missing/mismatched direct access, null-command polling, retained identity and no replacement after a removed-host 404, private-file rules, exact released command/bundle parsing, owner/enrollment credential-lane separation, argv/environment boundaries, isolated authority, installer invocation, explicit repo/skill allowlists, and native target binding. They do **not** prove npm installation, a real daemon connection, key validity, a model turn, or cloud cleanup. The released tarball contract was inspected separately; the BB reference checkout was read-only, and no proprietary BB source is included here.

Parent teardown order: stop/archival decisions for the proof thread; native `DELETE /api/v1/hosts/{workerHostId}` (or scoped `bb machine remove ... --yes`) to revoke the worker's BB authority; terminate/delete the worker compute; delete private enrollment/provider/cookie transfer artifacts and revoke an ephemeral provider key; then delete control compute and its public link. Manual machines do **not** auto-retire. Removing a manual machine revokes access but does not uninstall or stop the remote process. The preinstalled mode creates no service, so sandbox destruction is authoritative cleanup; the optional installer owns its own uninstall path. Do not delete or operate on unrelated daily machines. No cloud resource is allocated or removed by this subtree.

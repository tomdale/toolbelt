# Disposable cloud BB proof

A bounded two-machine proof harness: one Vercel Sandbox runs a released BB server, its bundled UI, and an authenticated HTTPS-ingress gateway; another runs a native manually enrolled BB daemon and Pi agent. The control is never an execution host. The operator's laptop provisions and observes the proof but is not the authoritative server, agent host, relay, or runtime credential service.

This is not a hosted product or persistence layer. Data lives on disposable filesystems. There is no restart/recovery promise, automatic Sandbox picker, custom domain, hosted Connect account, database service, autosleep, backup, or durable workflow. The harness intentionally refuses existing control state and replacement allocations.

## Components

- [Runtime](runtime/README.md): public `bb-app@0.48.1`, locked npm dependencies, synthetic HOME/data, fixed loopback `127.0.0.1:38886`, no host daemon.
- [Gateway](gateway/README.md): port `8080` behind Vercel edge TLS; temporary owner login, secure cookie, exact Origin/Host checks, HTTP/WebSocket forwarding, and separate narrowly admitted native routes verified by actual BB authentication.
- [Worker](worker/README.md): public BB and Pi releases, native manual enrollment, an explicitly approved public checkout, and worker-only `AI_GATEWAY_API_KEY`.
- `provisioning/`: coordinator-only allocation journal, private owner-login helper, fresh-control configuration, and live ingress probes.

No BB source is vendored. Runtime provenance and local Linux smoke evidence are in `runtime/provenance.json` and `runtime/evidence.json`. Worker transitive npm dependencies are not locked; control dependencies and the coordinator Sandbox SDK are locked.

## Prerequisites and consent

Use Node 24 with npm 11, Python 3.9+, Git, and Vercel CLI 58.3.0 or newer. The CLI must already be logged in to the explicitly approved account. The coordinator uses CLI-owned authentication to obtain a short-lived project OIDC token in memory; it never reads Vercel credential files or transfers that token to either Sandbox.

Before any allocation, obtain fresh approval for exactly one control and one worker, each **1 vCPU / 2 GiB and 60 minutes maximum**, plus associated network/storage charges. No extension, replacement, or second create is automatic. The journal's configured limits are not evidence of user consent. Authenticate and select the Vercel account/team/project through the user's normal CLI flow separately; these scripts never log in, relink, or change the daily BB server or plugin configuration.

Collect `AI_GATEWAY_API_KEY` and a unique temporary `BB_GATEWAY_OWNER_PASSWORD` through a secure credential facility. Keep the owner password at least 12 characters. Save credential files outside the checkout, owned by the operator and mode `0600`. Never put credentials in a URL, command argument, transcript, project input, or Git commit. The owner password belongs only on control; the agent key belongs only on worker. Both are readable by trusted code running as their respective Unix users; this is not hostile multi-tenant isolation.

The current `vercel/sandbox/universal:latest` image is mutable. Inspect the actual accepted image and tool versions. BB's SQLite addon may need `make`, a C++ compiler, and Python; install these on the existing disposable machine before runtime/worker installation if absent. Build-tool installation is not permission to allocate replacement compute.

## Verify locally

From this directory:

```sh
npm ci --ignore-scripts
npm test
```

The unit tests exercise authentication boundaries, worker enrollment contracts, scoped transport, atomic allocation journaling, and stop-proof handling without paid compute or credentials. They do not prove a real agent or physical client. Follow `runtime/README.md` for a real isolated Linux install and server/UI/skills/WebSocket smoke test. Docker is an optional local test dependency, not part of the cloud runtime.

## Allocation and integration

Prepare a secret-free private scope JSON containing only `accountId`, `teamId`, and `projectId`, verified against the user's approved CLI connection. Place it and the resource journal outside the repository. Commands below use placeholder paths; identities and URLs come from the actual accepted resources.

```sh
node provisioning/cloud.mjs init /private/cloud-state.json /private/scope.json
node provisioning/cloud.mjs create /private/cloud-state.json control
node provisioning/cloud.mjs create /private/cloud-state.json worker
node provisioning/cloud.mjs inspect /private/cloud-state.json control
node provisioning/cloud.mjs inspect /private/cloud-state.json worker
```

Only one coordinator owns this journal. Each command acquires an exclusive journal lock before reading it; concurrent commands fail rather than race. A process interruption can leave a lock: inspect the recorded process and original resources before manually removing it. Saves use file sync and atomic rename. Each role's random name is persisted before submission, and its original session identity is saved before subsequent operations. A failed create remains uncertain and cannot be retried; inspect the original named resource with `resume:false`. A `404` is not proof that compute stopped.

`upload` takes a local file and absolute remote destination, writes mode `0600`, and does not display content. `exec` runs a non-secret command on the original live session with a five-minute vendor timeout and prints its output. Only use commands whose output is safe. Never pass a secret in command arguments. Detached service commands must redirect their output privately and close inherited standard input.

Upload only this harness and the approved private inputs. Do not transfer a local BB data directory, user history, GitHub login, Pi auth file, SSH keys, or Vercel credentials. Install the runtime on control using `runtime/install.mjs`, then run `runtime/launch.mjs` with the public gateway origin. Start the gateway with that same `BB_GATEWAY_ORIGIN`, `BB_CORE_PORT=38886`, and `BB_GATEWAY_PORT=8080`; inject its owner-password file privately. Only port `8080` is exposed. BB core stays on loopback.

Obtain an owner session without displaying its cookie:

```sh
node provisioning/owner-login.mjs https://YOUR-CONTROL-ORIGIN \
  /private/cloud-owner.env /private/owner-cookie.private
python3 provisioning/configure-control.py \
  --server https://YOUR-CONTROL-ORIGIN \
  --cookie-file /private/owner-cookie.private
```

`configure-control.py` refuses a nonempty host or thread list. It preserves the full general-settings object while selecting direct machine access, advertising the public machine URL, and disabling GitHub credential forwarding. `BB_APP_URL` configures browser links/origins; it does **not** configure native machine access. Do not run this helper against the daily server.

Follow `worker/README.md` to prepare a native manual enrollment bundle, install and check out on the worker, and launch its actual daemon. Released installer artifact downloads do not carry the newer native authentication contract. Preinstall the public pinned package and use either direct native `machine enroll` or the vendor installer's documented-on-disk fallback to `bb-app` already on PATH when its tarball download is denied. Verify the fallback executable's exact version. Do not make owner-only installer artifacts public or give a worker the owner cookie.

After launch, delete the worker's transferred bundle and key files. The daemon retains its agent key in its own environment. Preserve original resource identities and native host/thread/artifact identities in private evidence outside Git.

## End-to-end acceptance

Use a physical phone to log in at `/_gateway/login`, create a thread on the enrolled worker, and run a small approved task. Ask the agent to read an actually distributed skill, inspect the approved checkout, ask a real question, wait for the user's reply, and only then write a nonce-bearing proof file. Do not treat a health check or packaged skill file as agent execution.

The selected provider may not expose a structured `AskUserQuestion` card. An actual ordinary message/reply is a conversational interaction, not proof of the structured-card API. Record that distinction rather than fabricating an interaction or assuming parity with another BB installation.

For the laptop-independence test, the user disconnects laptop networking, answers from the phone on cellular data, waits for the cloud agent output, and restores networking. The agent must run entirely on control/worker during that interval. The user then opens the same HTTPS origin using native desktop's custom Add Server URL and checks the same history. Headless Chrome is useful additional evidence, not a physical phone, Electron custom-server test, or observed offline-laptop test.

Independently read the agent-created file using native BB's file API bound to the worker, not only the assistant's final text or a provisioning shell. `provisioning/read-proof.py` requires explicit worker identity, checkout confinement, expected nonce/revision, and a new private output path. It saves the native file response privately and reports its hash and acceptance checks without printing the content. Preserve the sanitized contents, commit/nonce, source artifact versions, original resource identities, native thread/host identities, and the user's physical-client observations privately.

Live ingress checks:

```sh
python3 provisioning/probe-ingress.py \
  --server https://YOUR-CONTROL-ORIGIN \
  --cookie-file /private/owner-cookie.private \
  --out /private/live-ingress-tests.json
```

These check real unauthenticated/invalid-native denials, authenticated UI/version, and the absence of a control execution host. They do not replace the agent or client acceptance tests.

## Preserve and stop

Preserve source with the repository's worktree/verification/commit/integration workflow. Scan the complete staged diff for secrets, account metadata, transcripts, and private artifacts before every public push. Keep runtime resource journals, cookies, enrollment bundles, API keys, and full transcripts outside Git.

After proof artifacts are preserved, remove the native manual host through the isolated BB API to revoke its access. This does not stop manual-machine compute. Stop the original worker, then the original control, and only delete named metadata after fresh direct-session observations established `stopped`:

```sh
node provisioning/cloud.mjs stop /private/cloud-state.json worker
node provisioning/cloud.mjs delete /private/cloud-state.json worker
node provisioning/cloud.mjs stop /private/cloud-state.json control
node provisioning/cloud.mjs delete /private/cloud-state.json control
```

Stop intent, stop acknowledgement, fresh stopped observation, and metadata deletion remain distinct journal fields. Acknowledgement, deadline passage, or metadata disappearance alone does not prove termination. If termination remains ambiguous, retain the record and original account/team/project and inspect that original session; do not clear the journal or allocate a replacement. Clean private transfer files and browser sessions, and revoke an ephemeral agent key through its provider when appropriate.

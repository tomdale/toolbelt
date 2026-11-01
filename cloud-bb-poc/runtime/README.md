# Released BB control runtime

This directory downloads the public **`bb-app@0.48.1` npm release**, not a source checkout or a desktop app extraction. Its approximately 28 MB compressed tarball includes the actual server, bundled browser UI, first-party plugins, and four built-in skill trees. The Linux desktop AppImage is approximately 188 MB and is unnecessary for headless use. No BB implementation is vendored here.

## Install and launch

Use Linux glibc or macOS with Node 24 and its bundled npm 11. BB also supports Node 22.19+ and 26; this wrapper accepts those Node versions but intentionally requires npm 11 during installation. Native dependencies may need Python 3, make, and a C++ compiler. Install and launch on the same OS, architecture, and Node ABI.

From this directory:

```sh
node install.mjs /absolute/new/bb-install
node launch.mjs /absolute/new/bb-install /absolute/new/bb-state https://bb.example.com
```

Both paths are explicitly supplied. Installation refuses an existing destination. Launch refuses a nonempty state directory: this PoC starts with synthetic data, not existing application state. Do not supply a daily BB directory. Each launch needs a new state directory; persistence/restart of existing state is not implemented.

The launcher's supported underlying entry point is:

```sh
node INSTALL/app/node_modules/bb-app/dist/bb-server.js \
  --data-dir STATE/data --server-bind-host 127.0.0.1 --server-port 38886
```

`launch.mjs` supplies a whitelist environment with synthetic `HOME`, XDG directories, temporary directory, `BB_DATA_DIR`, `BB_SKIP_ONBOARDING=1`, and `BB_TELEMETRY=0`. It does not inherit provider credentials, SSH agents, `NODE_OPTIONS`, BB thread context, server URLs, or user configuration. It does not invoke `bb-app`, install a system service, open a browser, or start a host daemon. SIGINT/SIGTERM are forwarded to the server's process group. The server creates its own fresh internal state, including an authentication secret, inside the synthetic data directory; scripts do not read that secret.

`install.mjs` also uses a synthetic home/cache and empty npm user/global configuration. `npm ci` downloads the exact lockfile artifacts and checks their integrity. The three native addon install scripts are explicitly approved by the project `allowScripts` policy. An unsuccessful installation is incomplete: discard that installation directory rather than trying to launch it.

## Gateway interface

- **Core upstream:** fixed `http://127.0.0.1:38886`. No override that could target another BB instance. Launch preflights the listener before starting.
- **Reserved daemon port:** `BB_HOST_DAEMON_PORT=38887` satisfies the server configuration contract; no daemon is started and no listener is required there.
- **Public origin:** the optional third launch argument sets `BB_APP_URL` to an exact HTTP(S) origin without trailing slash. For browser access through a gateway, supply the real gateway origin so Host/Origin checks allow it. This value is not authentication.
- **Proxy behavior:** forward HTTP and WebSocket upgrades, including `/ws`, to the fixed loopback core. Preserve compatible Host/Origin behavior. Configure the public origin rather than disabling the core's browser guards.
- **Ingress ownership:** core APIs are unauthenticated on native loopback ingress. Authentication, authorization, session cookies, CSRF boundaries, and the complete external routing policy belong to the gateway. Do not expose the core listener or forward untrusted BB Connect identity headers. The isolated runtime does not create a public tunnel.
- **No control agent host:** `/api/v1/hosts` is empty after startup. The runtime machine is never enrolled as an agent target. Remote machine enrollment, cloud allocation, and agent execution are outside this directory's smoke test.

## Verification

Unit tests need no BB installation:

```sh
npm test
```

The integration smoke test starts and stops a real server. **Run it in a disposable local container**, not the daily BB network namespace. It intentionally uses fixed core port 38886 and refuses an occupied port. For example, from this directory with Docker available:

```sh
scratch=$(mktemp -d /tmp/cloud-bb-runtime.XXXXXX)
docker run --rm --platform linux/amd64 \
  -v "$PWD:/runtime:ro" -v "$scratch:/proof" \
  node:24-bookworm sh -c '
    node /runtime/install.mjs /proof/install &&
    cd /runtime && npm test &&
    node smoke.mjs /proof/install /proof/state
  '
```

No container ports are published, no host home is mounted, and no host credentials are forwarded. The image is a toolchain example, not an immutable deployment image. Pin the image digest separately for a deployment.

Local verification completed on Linux x64 under Docker, Node 24.18.0/npm 11.16.0. The final fresh install ran the approved native addon scripts. All four unit tests passed. The real server passed health/version, bundled HTML and referenced JavaScript, four packaged skill files, empty agent-host list, configured public Host/Origin, rejected untrusted hostname, `/ws` upgrade, loopback-only kernel listener, and graceful shutdown checks. `evidence.json` records these results. Skills were verified as packaged files, not exercised through an agent. Full browser interaction, Linux arm64, macOS boot, gateway authentication, remote agents, and deployment remain untested here.

## Artifact provenance

`provenance.json` records the registry tarball, SHA-512 integrity, upstream attestation endpoint, reported source commit and build invocation. npm's attestation payload was inspected; its signatures were not independently verified. The lockfile pins `bb-app@0.48.1` and all resolved dependencies; no moving dist-tag is used for installation.

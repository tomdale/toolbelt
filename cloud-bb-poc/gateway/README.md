# Fixed BB ingress gateway

Dependency-free Node 22+ HTTP ingress behind Vercel's HTTPS edge. Run `node gateway.mjs` from this directory. Run local checks with `node --test gateway.test.mjs` (or `npm test`). No install step or root package changes are needed.

## Runtime interface

| Variable | Required value |
| --- | --- |
| `BB_GATEWAY_ORIGIN` | Exact public HTTPS origin, without trailing slash |
| `BB_GATEWAY_OWNER_PASSWORD` | Unique temporary password, at least 12 characters; supply through private environment injection, never a URL or command argument |
| `BB_CORE_PORT` | Private BB core port, expected `38886`; destination is always `http://127.0.0.1:<port>` |
| `BB_GATEWAY_PORT` | Gateway listen port, default `8080`, bound to `0.0.0.0` for sandbox ingress |

The isolated core must bind **only** `127.0.0.1:38886`, serve its actual bundled UI, and set `BB_APP_URL` to the same public HTTPS origin. Expose only the gateway port. Vercel must terminate TLS and preserve the public `Host` header. The gateway does not derive trust, TLS state, identity, destination, or origin from `x-vercel-*`, `Forwarded`, or `X-Forwarded-*` headers. It does not provide TLS itself: do not deploy its port directly on a public plaintext network. Native clients use HTTPS/WSS with normal certificate verification.

## Owner admission

Open `https://<gateway-host>/_gateway/login` and submit the temporary password through the form. The POST requires the exact configured `Origin`. A successful login issues a random, one-hour `__Host-bb-owner` cookie with `Secure; HttpOnly; SameSite=Strict; Path=/`, then redirects to `/`. Sessions live only in memory; restart revokes them. Login allows ten attempts per minute globally and at most 32 concurrent sessions. `POST /_gateway/logout` with the cookie and exact origin revokes that session, including its open sockets.

Owner UI/assets/API requests require the cookie. Mutations and every browser WebSocket require the exact origin; cross-site fetch metadata and foreign origins are rejected even for GET. Browser WebSocket routes are `/ws`, `/ws/terminals/:terminalId`, and `/api/v1/plugins/:pluginId/http[/...]`. Plugin RPC may pass its header token only after owner admission; credential-bearing query parameters are rejected.

The only owner loopback-management dispatch under `/internal/` is **POST `/internal/hosts/enroll-key`**. Manual machine creation and enrollment-command retrieval use the normal authenticated owner API (`POST /api/v1/hosts`, `GET /api/v1/hosts/:hostId/enrollment-command`). There is no unauthenticated owner API and no machine-credential fallback to owner access.

## Native admission

These are the complete native route/method pairs. They do not accept browser cookies or `Origin`. A syntactically valid `Authorization: Bearer <BB credential>` is required; the unchanged credential goes to the actual core, which verifies enrollment keys or daemon host keys and checks host/session ownership. The gateway has no separate native key database and does not treat Bearer syntax as successful authentication.

- POST `/internal/hosts/enroll`
- POST `/internal/session/open`
- POST `/internal/session/events`
- POST `/internal/session/tool-call`
- POST `/internal/session/interactive-request`
- POST `/internal/session/interactive-request/interrupt`
- GET `/internal/session/project-attachment-content`
- GET `/internal/skills/tree/:hash`
- POST `/internal/skills/tree/:hash/content`
- GET `/internal/plugins/:pluginId/host/:digest`
- GET WebSocket upgrade `/internal/ws?sessionId=...`, with `Sec-WebSocket-Protocol: bb-host-daemon.v1`

Hashes/digests must be 64 lowercase hex characters. Plugin IDs are restricted to letters, digits, `.`, `_`, and `-`. Other native methods, suffixes, enrollment-key minting, and server-move routes are denied. Session identifiers are not a substitute for the Bearer credential.

A separate bootstrap lane permits only **GET `/install.sh` with `X-BB-Enrollment`**, no cookie, origin, or Authorization. The actual core validates the pending enrollment credential before producing the bootstrap. Missing/invalid credentials do not grant bootstrap access. `/install/version` and `/install/bb-app.tgz` remain owner-cookie-only; a native preinstalled worker must install the pinned public npm package separately rather than use the unmodified shell installer's artifact downloads.

## Proxy boundary and verification

All dispatch is to the fixed numeric loopback destination; request targets cannot select a remote origin. `Host` becomes the loopback core host, and validated browser `Origin` is preserved for core's `BB_APP_URL` check. Only explicit request headers pass through. Cookies and incoming forwarding, Vercel, and BB gate-identity headers are not sent to core. Native Authorization and enrollment headers are forwarded only in their respective route lanes. WebSocket negotiation headers, initial upgrade bytes, and subsequent duplex bytes are retained. Core responses lose `Set-Cookie` and CORS grants and are marked `no-store`; absolute loopback redirect locations are rewritten to the public origin.

Local tests use an instrumented loopback stub with credential rejection, not the proprietary BB core. They cover authentication lanes, both skill operations, owner mutation origin checks, header isolation, route/method denials, bootstrap admission, WebSocket upgrades and upgrade-head byte forwarding, and logout. They do **not** prove a deployed Vercel edge or end-to-end BB enrollment/UI behavior; parent integration owns those checks. No existing credentials, local daily configuration, cloud allocation, or core source are included.

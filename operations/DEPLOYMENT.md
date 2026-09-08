# Local HTTPS deployment boundary

This module is a small, dependency-free TLS reverse proxy for an already-running **private loopback core**. It is local deployment preparation, not an Internet-qualified ingress, WAF, certificate manager, supervisor, or authentication service. It does not discover credentials, DNS, models, wallets, or upstreams and must not be exposed publicly without a separate deployment/security review.

## API

```js
import { readFile } from "node:fs/promises";
import { createHttpsProxy } from "./src/index.mjs";

const proxy = createHttpsProxy({
  upstream: "http://127.0.0.1:4310", // fixed loopback origin; no path/credentials
  cert: await readFile("/explicit/path/server-cert.pem"),
  key: await readFile("/explicit/path/server-key.pem"),
  allowedOrigins: ["https://app.example"],
  allowedHosts: ["localhost"],       // hostnames only, case-insensitive
  allowedPaths: ["/v1/", "/healthz"],
  maxBodyBytes: 1_048_576,
  requestTimeoutMs: 30_000,
  upstreamTimeoutMs: 5_000,
  maxConnections: 128,
  maxRequestsPerSocket: 100,
});
const { url } = await proxy.listen({ host: "127.0.0.1", port: 4443 });
// SIGTERM/SIGINT handler owned by the process supervisor:
await proxy.close({ graceMs: 1_000 });
```

`createHttpsProxy(options)` performs no I/O and requires explicit `cert`, `key`, fixed loopback `upstream`, nonempty `allowedOrigins`, and nonempty `allowedHosts`. `listen()` accepts only loopback hosts and returns `{url}`. `close()` stops admission, closes idle connections, permits a bounded drain, then destroys remaining upstream requests/sockets. Repeated `close()` is safe.

Requests must have an allowed Host. If an Origin header is present it must be allowed; non-browser clients may omit Origin. Absolute-form and scheme-relative request targets are rejected. Only exact paths or prefixes ending in `/` from `allowedPaths` are exposed. The request path/query is joined only to the configured origin; request data cannot choose a destination. Spoofable forwarding and hop-by-hop headers are removed, duplicate security-sensitive headers are rejected, and the upstream Host is rewritten to the fixed upstream. Authorization is passed to core but never logged by this module. Responses add HSTS, CSP, frame, MIME, referrer, and no-store headers; upstream cookies are not relayed.

`GET /healthz` is an allowed upstream health route when configured. `GET /readyz` is always reserved by the proxy and makes a credential-free `GET /healthz` to the fixed upstream: 200 only for upstream 2xx, otherwise 503. Streaming responses, including SSE and `Last-Event-ID`, are piped without buffering. Client disconnects abort the corresponding upstream request; reconnect is a fresh normal request and core remains responsible for SSE cursor semantics and explicit job cancellation.

## Locally tested runnable example

Generate a disposable certificate without adding it to global trust, run the core separately, then use the API above:

```sh
tmp="$(mktemp -d)"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=localhost -addext subjectAltName=DNS:localhost \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem"
# Start your explicit wrapper script which reads those two paths and calls listen().
curl --cacert "$tmp/cert.pem" https://localhost:4443/readyz
rm -rf "$tmp"
```

Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`, `curl -k`, global certificate trust, or copied production keys for this check. The package test creates an ephemeral self-signed certificate, explicitly trusts only that certificate in its client, exercises a real HTTPS child process and local HTTP upstream, and cleans both up:

```sh
npm --prefix operations test
npm --prefix operations run check
```

## Operator checklist

### Install / start
- Use the repository-pinned Node runtime; this module has no third-party dependencies.
- Keep core bound to loopback. Set a literal fixed core origin; never derive it from Host, URL, query, headers, or user input.
- Provision certificate and key out-of-band with owner-only key permissions. Inject their bytes explicitly.
- Pin the exact public Host, browser Origin, and minimum route prefixes. Put authentication in core, not in this proxy.
- Start under a supervisor as an unprivileged dedicated account. Keep stdout/stderr out of request/header/body data.

### Readiness / stop
- Gate traffic on `/readyz`; distinguish its upstream reachability result from model, payment, chain, or Internet qualification.
- On stop, remove the instance from traffic, call `close({graceMs})`, and verify the process and listening socket are gone.
- Clients reconnect SSE with their original authorization and `Last-Event-ID`; cancellation remains the explicit core cancel route.

### Key trust / rotation
- Distribute only the CA/certificate through an authenticated channel; clients pin/trust it explicitly.
- Keep private keys outside the repository and backups, mode 0600, owned by the service account. Do not configure global trust or DNS here.
- Rotate by starting a replacement process with explicitly injected new bytes, verify with the new trust anchor, switch locally, then stop the old process. This module has no hot reload.

### Backup ownership
- Core state/signing-key backups and TLS-key backups have separate owners, access policy, retention, restore drill, and deletion record.
- Never include bearer headers, request bodies, payment proofs, or TLS private keys in ordinary logs or application-state archives.
- Verify restore offline and permission-restricted before service start; a backup existing is not proof it is restorable.

## Limits

The proxy supplies a narrow local TLS boundary only. It has no ACME, OCSP automation, rate limiting, multi-process coordination, external load-balancer trust, HTTP/2, public abuse protection, audit-log pipeline, or zero-downtime key reload. Node's streaming applies backpressure, but core owns application-level output bounds, authentication, SSE retention/replay, and cancellation. Local passing tests do not qualify public deployment, real payments, inference, mainnet, DNS, or certificate operations.
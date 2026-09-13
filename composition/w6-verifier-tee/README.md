# W6 verifier Confidential Space image

This image wraps the accepted `mycelium-verifier` JSONL worker in a dependency-free Node 22 HTTPS service. It is intentionally `linux/amd64`; GCP Confidential Space `n2d` machines are x86_64. The private component payload is supplied as a named BuildKit context and never copied into this repository.

## Runtime contract

Required environment:

- `W6_VERIFIER_BEARER`: bearer accepted by `POST /v1/stdio` (1–8192 characters).
- `VERIFIER_CONFIG`: verifier config path. The image default is `/opt/mycelium-verifier/config.release-local.json` from the accepted private component.
- `W6_VERIFIER_TLS_KEY` and `W6_VERIFIER_TLS_CERT`: PEM paths. The image contains a 30-day self-signed origin certificate suitable for Cloudflare SSL mode **Full**; replace these paths with mounted certificates for Full (strict).

Optional environment:

- `W6_ATTESTATION_URL`: launcher token endpoint proxied by `GET /attestation`. Until T3 confirms and wires the current Confidential Space launcher API, the endpoint deliberately returns `501 {"ok":false,"reason":"attestation-not-configured"}`.
- `W6_VERIFIER_TIMEOUT_MS`, `W6_VERIFIER_REQUEST_TIMEOUT_MS` (defaults: 10000), `W6_VERIFIER_HOST`, `W6_VERIFIER_PORT` (defaults: `0.0.0.0:8443`), and `VERIFIER_PYTHON`.

The server starts the installed component as `python3 -I -B -m mycelium_verifier stdio --config "$VERIFIER_CONFIG"`. Release 0.1.0's `mycelium_verifier.workers.stdio` module exports `serve()` but has no module CLI; the package CLI is the documented executable dispatcher.

## Owner build and push (T1/T2 handoff)

Do not run these from an agent session. Run from the workbench root with owner approval. The commands leave the source archive unchanged, stage its contents in a private temporary directory, force the x86_64 target, and tag the requested Artifact Registry location.

```sh
set -eu
export CLOUDSDK_ACTIVE_CONFIG_NAME=mycelium
ARCHIVE="${MYCELIUM_VERIFIER_ARCHIVE:?set MYCELIUM_VERIFIER_ARCHIVE to the accepted private tar.gz}"
TAG=europe-west4-docker.pkg.dev/mycelium-demo/mycelium/verifier:tee-r1
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/component"
tar -xzf "$ARCHIVE" -C "$STAGE/component"
install -m 0644 composition/w6-verifier-serve.mjs "$STAGE/w6-verifier-serve.mjs"

docker buildx build \
  --platform linux/amd64 \
  --build-context verifier-payload="$STAGE" \
  --file composition/w6-verifier-tee/Dockerfile \
  --tag "$TAG" \
  --load \
  composition/w6-verifier-tee

# Homebrew environments may export CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.14.
# If this gcloud install rejects that forced interpreter, unset only for gcloud:
env -u CLOUDSDK_PYTHON gcloud auth configure-docker europe-west4-docker.pkg.dev
docker push "$TAG"
DIGEST="$(docker buildx imagetools inspect "$TAG" --format '{{json .Manifest.Digest}}' | tr -d '"')"
printf 'TEE_IMAGE=%s@%s\n' "$TAG" "$DIGEST"
```

Before building, the owner must verify that the accepted `config.release-local.json` uses paths valid under `/opt/mycelium-verifier` and that every private bank/asset it pins is present in the staged component. Do not print bank contents or include the staging directory in Git.

## Owner Confidential Space VM creation (T2)

This creates the production (non-debug) Confidential Space VM and binds it to a reserved regional address. It does **not** perform T3 DNS/firewall/attestation verification. Preserve the printed bearer outside Git and pass the same value only to the app-side `W6_VERIFIER_TEE_BEARER` secret.

```sh
set -eu
export CLOUDSDK_ACTIVE_CONFIG_NAME=mycelium
PROJECT=mycelium-demo
REGION=europe-west4
ZONE=europe-west4-a
VM=mycelium-verifier-tee-r1
ADDRESS=mycelium-verifier-tee-ip
TAG=europe-west4-docker.pkg.dev/mycelium-demo/mycelium/verifier:tee-r1
DIGEST="$(docker buildx imagetools inspect "$TAG" --format '{{json .Manifest.Digest}}' | tr -d '"')"
IMAGE_REF="$TAG@$DIGEST"
BEARER="$(openssl rand -hex 32)"

env -u CLOUDSDK_PYTHON gcloud compute addresses create "$ADDRESS" \
  --project="$PROJECT" --region="$REGION" --network-tier=PREMIUM
STATIC_IP="$(env -u CLOUDSDK_PYTHON gcloud compute addresses describe "$ADDRESS" \
  --project="$PROJECT" --region="$REGION" --format='value(address)')"

env -u CLOUDSDK_PYTHON gcloud compute instances create "$VM" \
  --project="$PROJECT" \
  --zone="$ZONE" \
  --machine-type=n2d-standard-4 \
  --network-interface="address=$STATIC_IP,network-tier=PREMIUM" \
  --maintenance-policy=TERMINATE \
  --confidential-compute-type=SEV \
  --shielded-secure-boot \
  --image-project=confidential-space-images \
  --image-family=confidential-space \
  --service-account=verifier-workload@mycelium-demo.iam.gserviceaccount.com \
  --scopes=cloud-platform \
  --metadata="tee-image-reference=$IMAGE_REF,tee-container-log-redirect=true,tee-env-W6_VERIFIER_BEARER=$BEARER"

printf 'STATIC_IP=%s\nIMAGE_REF=%s\nW6_VERIFIER_TEE_BEARER=%s\n' \
  "$STATIC_IP" "$IMAGE_REF" "$BEARER"
unset BEARER
```

T3 must then restrict ingress to Cloudflare, map the public HTTPS origin to container port 8443 (or explicitly override the runtime port as part of the approved ingress design), set proxied DNS for `verifier.mycelium.now`, confirm the current launcher token API, set `W6_ATTESTATION_URL`, and verify nonce-bound claims plus the exact image digest. A passing `/healthz` or self-signed TLS handshake is not attestation evidence.

## Local tests

These use only a generated self-signed certificate and a synthetic fake Python worker; they never open the private archive or reference banks.

```sh
node --test --test-concurrency=1 composition/test/w6-verifier-serve.test.mjs
node --check composition/w6-verifier-serve.mjs
```

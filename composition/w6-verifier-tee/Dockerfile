# syntax=docker/dockerfile:1.7
FROM --platform=linux/amd64 node:22-bookworm-slim

ARG TARGETPLATFORM
RUN test "$TARGETPLATFORM" = "linux/amd64" \
    && apt-get update \
    && apt-get install --yes --no-install-recommends python3 python3-pip python3-venv openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node package.json /app/package.json
COPY --from=verifier-payload --chown=node:node /w6-verifier-serve.mjs /app/w6-verifier-serve.mjs
COPY --from=verifier-payload --chown=node:node /component/ /opt/mycelium-verifier/

RUN python3 -m pip install \
      --break-system-packages \
      --no-cache-dir \
      --no-deps \
      /opt/mycelium-verifier/artifacts/package-r2/wheel/mycelium_verifier-0.1.0-py3-none-any.whl \
    && install -d -o node -g node -m 0700 /app/tls \
    && openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
      -subj "/CN=verifier.mycelium.now" \
      -addext "subjectAltName=DNS:verifier.mycelium.now" \
      -keyout /app/tls/tls.key \
      -out /app/tls/tls.crt \
    && chown node:node /app/tls/tls.key /app/tls/tls.crt \
    && chmod 0600 /app/tls/tls.key \
    && chmod 0644 /app/tls/tls.crt

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    VERIFIER_CONFIG=/opt/mycelium-verifier/config.release-local.json \
    VERIFIER_PYTHON=python3 \
    W6_VERIFIER_HOST=0.0.0.0 \
    W6_VERIFIER_PORT=8443 \
    W6_VERIFIER_TLS_KEY=/app/tls/tls.key \
    W6_VERIFIER_TLS_CERT=/app/tls/tls.crt \
    W6_VERIFIER_TIMEOUT_MS=10000 \
    W6_VERIFIER_REQUEST_TIMEOUT_MS=10000

USER node
EXPOSE 8443
ENTRYPOINT ["node", "/app/w6-verifier-serve.mjs"]

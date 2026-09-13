# tee-shim wrapper for the Mycelium T2 verifier image.
#
# This image is ADDITIVE — it does NOT rebuild the upstream verifier.
# It takes the published mycelium/verifier image as a base, layers in a
# small tee-launcher-style HTTP server (tee_launcher.py) that exposes
# /attestation and /generate-key on port 8766, and re-runs the original
# Flask verifier on port 8765 alongside it.
#
# Build (local cache only):
#   docker buildx build --platform linux/amd64 \
#     -t mycelium-verifier:tee-shim-v1 --load -f Dockerfile .
#
# Run:
#   docker run --rm -d -p 8765:8765 -p 8766:8766 mycelium-verifier:tee-shim-v1

FROM europe-west4-docker.pkg.dev/mycelium-demo/mycelium/verifier@sha256:35fec927146b82ac804cd4f840a956d169d6098b5853953f034fa2d7aa4609d8

LABEL org.opencontainers.image.title="mycelium-verifier-tee-shim" \
      org.opencontainers.image.description="Mycelium T2 verifier + tee-launcher-style /attestation and /generate-key endpoints" \
      org.opencontainers.image.vendor="mycelium-demo" \
      org.opencontainers.image.licenses="UNLICENSED"

# Layer in the tee-launcher shim. We deliberately COPY into /opt/tee-launcher
# rather than /opt/mycelium/ to keep the upstream payload directory read-only.
COPY tee_launcher.py  /opt/tee-launcher/tee_launcher.py
COPY entrypoint.sh    /opt/tee-launcher/entrypoint.sh
RUN chmod 0755 /opt/tee-launcher/tee_launcher.py /opt/tee-launcher/entrypoint.sh

# A writable home for tee-launcher state (pubkey, jwt secret, log).
# The upstream /opt/mycelium/out is already writable from the base image.
RUN mkdir -p /opt/mycelium/tee-state && chmod 0777 /opt/mycelium/tee-state

ENV MYCELIUM_TEE_STATE=/opt/mycelium/tee-state \
    MYCELIUM_TEE_LOG=/opt/mycelium/tee-state/tee-launcher.log \
    MYCELIUM_TEE_HWMODEL=AMD_MILAN \
    MYCELIUM_TEE_IMAGE_DIGEST="sha256:35fec927146b82ac804cd4f840a956d169d6098b5853953f034fa2d7aa4609d8"

EXPOSE 8765 8766

# Health-check covers the tee-launcher (cheaper to call).  The upstream
# Flask healthcheck still works on 8765 independently.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD python -c "import urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:8766/healthz',timeout=3); sys.exit(0 if r.status==200 else 1)" || exit 1

ENTRYPOINT ["/opt/tee-launcher/entrypoint.sh"]